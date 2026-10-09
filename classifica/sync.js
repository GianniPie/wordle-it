// Loaded by the game page: saves the finished game to the leaderboard when the player is logged in,
// lists "Le mie statistiche" and the player's groups under "Classifiche" in the menu, shows the avatar
// (or ACCEDI) in the header, and fills in today's game if it was already played on another device.
// The Supabase client is only downloaded for players who have logged in.
const SESSION_KEY = "sb-nxybifpygctncflcwbfa-auth-token";
const GROUPS_KEY = "parle-groups"; // [{ id, name }], written by the leaderboard page too
const NAME_KEY = "parle-name"; // the player's name, written by the leaderboard page too
const AVATAR_KEY = "parle-avatar"; // the player's picture address (none: first letter of the name)
// Shown in the avatar until the name is known.
const PERSON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="#fff" d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function renderGroups() {
  const box = document.querySelector("game-app")?.shadowRoot?.getElementById("menu-groups");
  if (!box) return;
  const stats = `<a class="item sub" href="classifica/?statistiche">Le mie statistiche</a>`;
  if (!read(SESSION_KEY)) {
    box.innerHTML = stats;
    return;
  }
  let groups = [];
  try {
    groups = JSON.parse(read(GROUPS_KEY) || "[]");
  } catch {}
  box.innerHTML =
    stats +
    groups.map((g) => `<a class="item sub" href="classifica/?gruppo=${encodeURIComponent(g.id)}">${esc(g.name)}</a>`).join("") +
    `<a class="item sub" href="classifica/?nuovo">+ Nuovo gruppo</a>`;
}

function renderAccount() {
  const slot = document.querySelector("game-app")?.shadowRoot?.getElementById("account-slot");
  if (!slot) return;
  if (!read(SESSION_KEY)) {
    slot.innerHTML = `<a class="login" href="classifica/?account" title="Non hai fatto l'accesso">ACCEDI</a>`;
    return;
  }
  const name = read(NAME_KEY) || "";
  const picture = read(AVATAR_KEY);
  const inside = picture ? `<img src="${esc(picture)}" alt="" />` : name ? esc([...name][0]) : PERSON;
  slot.innerHTML = `<a class="avatar" href="classifica/?account" aria-label="Account${name ? ` di ${esc(name)}` : ""}">${inside}</a>`;
}

async function refreshName(db) {
  const { data: { session } } = await db.sb.auth.getSession();
  if (!session) return;
  const { data, error } = await db.sb.from("profiles").select("display_name, avatar_url").eq("id", session.user.id).maybeSingle();
  if (error) return;
  try {
    data ? localStorage.setItem(NAME_KEY, data.display_name) : localStorage.removeItem(NAME_KEY);
    data?.avatar_url ? localStorage.setItem(AVATAR_KEY, data.avatar_url) : localStorage.removeItem(AVATAR_KEY);
  } catch {}
  renderAccount();
}

async function refreshGroups(db) {
  const { data, error } = await db.sb.from("groups").select("id, name").order("created_at");
  if (error) return;
  try {
    localStorage.setItem(GROUPS_KEY, JSON.stringify(data));
  } catch {}
  renderGroups();
}

// The game's colors for a guess, like the game computes them (repeated letters count once each).
function evaluate(guess, solution) {
  const result = Array(5).fill("absent");
  const left = [...solution];
  for (let i = 0; i < 5; i++) if (guess[i] === solution[i]) (result[i] = "correct"), (left[i] = null);
  for (let i = 0; i < 5; i++) {
    if (result[i] === "correct") continue;
    const j = left.indexOf(guess[i]);
    if (j >= 0) (result[i] = "present"), (left[j] = null);
  }
  return result;
}

// Today's word already finished on another device: put that game on this device too, then reload the game.
async function restoreToday(db) {
  const { data: { session } } = await db.sb.auth.getSession();
  if (!session) return;
  const today = db.dayNumber(new Date());
  let state;
  try {
    state = JSON.parse(read("gameState") || "null");
  } catch {}
  // The game has already saved today's word when it started the day.
  if (!state?.solution) return;
  const playedHere = state.lastPlayedTs && db.dayNumber(new Date(state.lastPlayedTs)) === today;
  if (playedHere && ["WIN", "FAIL"].includes(state.gameStatus)) return;
  const { data: r, error } = await db.sb.from("results").select("guesses, won, play_ms").eq("user_id", session.user.id).eq("day", today).maybeSingle();
  if (error || !r) return;
  if (r.won && r.guesses[r.guesses.length - 1] !== state.solution) return; // not today's word: leave this device alone
  const mark = `parle-restored-${today}`;
  try {
    if (sessionStorage.getItem(mark)) return; // never reload more than once
    sessionStorage.setItem(mark, "1");
    const board = [...r.guesses, "", "", "", "", "", ""].slice(0, 6);
    const now = Date.now();
    localStorage.setItem(
      "gameState",
      JSON.stringify({
        ...state,
        boardState: board,
        evaluations: board.map((g) => (g ? evaluate(g, state.solution) : null)),
        rowIndex: r.guesses.length,
        gameStatus: r.won ? "WIN" : "FAIL",
        lastPlayedTs: now,
        lastCompletedTs: now,
        startedAt: null,
        playMs: r.play_ms,
      })
    );
    localStorage.setItem("parle-synced", `${session.user.id}:${today}`);
  } catch {
    return;
  }
  location.reload();
}

// Play time of each finished game on this device, for "Le mie statistiche" without an account: { day: { ms, won } }.
function rememberTime() {
  let state;
  try {
    state = JSON.parse(read("gameState") || "null");
  } catch {}
  if (!state || !["WIN", "FAIL"].includes(state.gameStatus) || !(state.playMs > 0) || !state.lastPlayedTs) return;
  const d = new Date(state.lastPlayedTs);
  const day = Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(2022, 0, 3)) / 864e5);
  try {
    const times = JSON.parse(read("parle-times") || "{}");
    if (times[day]) return;
    times[day] = { ms: Math.round(state.playMs), won: state.gameStatus === "WIN" };
    localStorage.setItem("parle-times", JSON.stringify(times));
  } catch {}
}

// The definition of the day's word at the end of the game: prepared on the server from the Italian Wiktionary,
// readable without an account. The link opens the word on Treccani.
const SUPABASE_URL = "https://nxybifpygctncflcwbfa.supabase.co";
const SUPABASE_KEY = "sb_publishable_-LLCVKGqP3hRaxXyrNoq5w_YUWu_QZs";

async function showDefinition(el, day, word) {
  if (!el) return;
  let d = null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/definitions?day=eq.${day}&select=word,lemma,form_of,senses,status,source_url`, {
      headers: { apikey: SUPABASE_KEY },
    });
    if (res.ok) [d] = await res.json();
  } catch {}
  const lemma = d?.lemma || word;
  const treccani = `<a class="treccani" href="https://www.treccani.it/vocabolario/${encodeURIComponent(lemma)}/" target="_blank" rel="noopener">Apri su Treccani</a>`;
  const title = `<p class="word">${esc(word)}</p>`;
  if (!d || d.status !== "ok" || !d.senses?.length) {
    el.innerHTML = `${title}<p class="none">Definizione non disponibile.</p>${treccani}`;
    return;
  }
  el.innerHTML = `
    ${title}
    ${d.form_of ? `<p class="form">${esc(d.form_of)}</p>` : ""}
    <ol>${d.senses.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>
    ${treccani}
    <p class="source">Definizione dal <a href="${esc(d.source_url)}" target="_blank" rel="noopener">Wikizionario</a> (CC BY-SA)</p>`;
}
window.parleShowDefinition = showDefinition;
if (window.parlePendingDefinition) showDefinition(...window.parlePendingDefinition);

function sync() {
  rememberTime();
  if (!read(SESSION_KEY)) return;
  import("./db.js").then((db) => db.syncToday());
}

renderGroups();
renderAccount();
if (read(SESSION_KEY))
  import("./db.js").then((db) => {
    restoreToday(db);
    refreshGroups(db);
    refreshName(db);
  });
sync();
// The game fires this when the last tile of a row has flipped; by then the finished game is saved.
window.addEventListener("game-last-tile-revealed-in-row", () => setTimeout(sync, 100));
// Also when the app is closed or put in the background before the tiles finish turning.
window.addEventListener("pagehide", rememberTime);
document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && rememberTime());
