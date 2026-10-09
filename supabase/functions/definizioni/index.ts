// Prepares the definitions of today's and the next 3 days' words from the Italian Wiktionary (CC BY-SA),
// and saves them in public.definitions. Called every hour by pg_cron: a word that failed is retried the next hour,
// so each word gets many tries before it becomes the word of the day.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const API = "https://it.wiktionary.org/w/api.php";
const UA = "Parle/1.0 (https://giannipie.github.io/wordle-it/)";
const MAX_SENSES = 3;

type Definition = {
  status: "ok" | "missing";
  lemma: string | null;
  form_of: string | null;
  senses: string[] | null;
  source_url: string | null;
  treccani_url: string | null;
};

const TRECCANI = "https://www.treccani.it/vocabolario/";

// Text of a Treccani vocabulary entry, or null when there is no entry with that address
// (Treccani then sends the visitor to its home page).
async function treccaniEntry(slug: string): Promise<string | null> {
  const res = await fetch(`${TRECCANI}${encodeURIComponent(slug)}/`, { headers: { "User-Agent": UA } });
  if (!res.ok || !res.url.includes("/vocabolario/")) return null;
  const html = await res.text();
  const at = html.indexOf("Dal vocabolario");
  if (at < 0) return null;
  return html
    .slice(at, at + 20000)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .toLowerCase();
}

// Address of the Treccani entry for the lemma. Words with several unrelated meanings have no "parola/"
// page but "parola1/", "parola2/"... with no links between them: then Treccani's search page, which lists
// them all (the app labels it "Tutti i significati su Treccani").
async function treccaniUrl(lemma: string): Promise<string> {
  if (await treccaniEntry(lemma)) return `${TRECCANI}${encodeURIComponent(lemma)}/`;
  const first = await treccaniEntry(`${lemma}1`);
  const second = first !== null && (await treccaniEntry(`${lemma}2`));
  if (first !== null && !second) return `${TRECCANI}${encodeURIComponent(`${lemma}1`)}/`;
  return `${TRECCANI}ricerca/${encodeURIComponent(lemma)}/`;
}

// The page's wikitext, or null when Wiktionary has no page with that title.
async function wikitext(title: string): Promise<string | null> {
  const url = `${API}?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&format=json&formatversion=2&redirects=1`;
  const res = await fetch(url, { headers: { "User-Agent": UA, "Api-User-Agent": UA } });
  if (!res.ok) throw new Error(`Wiktionary answered ${res.status}`);
  const data = await res.json();
  if (data.error?.code === "missingtitle") return null;
  if (data.error) throw new Error(data.error.info);
  return data.parse.wikitext as string;
}

// Only the Italian part of the page ("== {{-it-}} ==" up to the next language).
function italian(text: string): string | null {
  const start = text.indexOf("{{-it-}}");
  if (start < 0) return null;
  const rest = text.slice(start + "{{-it-}}".length);
  const next = rest.search(/\n==\s*\{\{-[a-z-]+-\}\}\s*==/);
  return next < 0 ? rest : rest.slice(0, next);
}

// Wikitext of one meaning to plain text.
function plain(line: string): string {
  let s = line.replace(/^#+\s*/, "").replace(/<ref[^>]*\/>|<ref[^>]*>[\s\S]*?<\/ref>/g, "");
  for (let i = 0; i < 3; i++) s = s.replace(/\{\{[^{}]*\}\}/g, "");
  return s
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/'{2,}/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:.]+/, "")
    .replace(/[\s,;:]+$/, "")
    .trim();
}

// Meaning lines: "# ..." (not examples "#:" / quotes "#*").
function meaningLines(section: string): string[] {
  return section.split("\n").filter((l) => /^#(?![:*#])/.test(l));
}

// "terza persona ... di [[correre]]", "plurale di [[dubbio]]": the base word of an inflected form.
function baseWord(line: string): string | null {
  const m = line.match(/(persona|plurale|femminile|maschile|participio|gerundio|imperativo|infinito|forma)[^\n]*?\b(?:di|del|della|dello|dei|degli|delle)\s+\[\[([^\]|#]+)/i);
  return m ? m[2].trim() : null;
}

// Wiktionary meanings and the Treccani address (also when Wiktionary has nothing).
async function prepare(word: string): Promise<Definition> {
  const def = await lookup(word);
  return def.treccani_url ? def : { ...def, treccani_url: await treccaniUrl(word) };
}

async function lookup(word: string): Promise<Definition> {
  const missing: Definition = { status: "missing", lemma: null, form_of: null, senses: null, source_url: null, treccani_url: null };
  const text = await wikitext(word);
  const section = text && italian(text);
  if (!section) return missing;
  const lines = meaningLines(section);
  if (!lines.length) return missing;

  const base = baseWord(lines[0]);
  if (base && base !== word) {
    // Inflected form: meanings of the base word.
    const baseText = await wikitext(base);
    const baseSection = baseText && italian(baseText);
    const baseSenses = baseSection ? meaningLines(baseSection).map(plain).filter(Boolean).slice(0, MAX_SENSES) : [];
    return {
      status: "ok",
      lemma: base,
      form_of: plain(lines[0]),
      senses: baseSenses.length ? baseSenses : null,
      source_url: `https://it.wiktionary.org/wiki/${encodeURIComponent(base)}`,
      treccani_url: await treccaniUrl(base),
    };
  }
  const senses = lines.map(plain).filter(Boolean).slice(0, MAX_SENSES);
  if (!senses.length) return missing;
  return {
    status: "ok",
    lemma: word,
    form_of: null,
    senses,
    source_url: `https://it.wiktionary.org/wiki/${encodeURIComponent(word)}`,
    treccani_url: await treccaniUrl(word),
  };
}

Deno.serve(async (req) => {
  // Read-only check of one word: ?parola=corra (nothing is saved).
  const test = new URL(req.url).searchParams.get("parola");
  if (test) return Response.json(await prepare(test.toLowerCase()));

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const { data: todo, error } = await sb.rpc("definitions_to_prepare");
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const saved: unknown[] = [];
  const failed: unknown[] = [];
  for (const { day, word } of todo as { day: number; word: string }[]) {
    try {
      const def = await prepare(word);
      const { error: e } = await sb.from("definitions").upsert({ day, word, ...def, fetched_at: new Date().toISOString() });
      if (e) throw new Error(e.message);
      saved.push({ day, word, status: def.status });
    } catch (e) {
      failed.push({ day, word, error: String(e) }); // tried again at the next run
    }
    await new Promise((r) => setTimeout(r, 1000)); // gentle with Wiktionary
  }
  return Response.json({ saved, failed });
});
