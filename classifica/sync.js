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
    const root = box.getRootNode();
    if (root.getElementById("menu-chat")) root.getElementById("menu-chat").hidden = true;
    if (root.getElementById("menu-chats")) root.getElementById("menu-chats").innerHTML = "";
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
  // Chat: one entry per group, like Classifiche.
  const root = box.getRootNode();
  const chat = root.getElementById("menu-chat");
  const chats = root.getElementById("menu-chats");
  if (chat && chats) {
    chat.hidden = !groups.length;
    chats.innerHTML = groups.map((g) => `<a class="item sub" href="classifica/?chat=${encodeURIComponent(g.id)}">${esc(g.name)}</a>`).join("");
  }
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
// Same encoding as the game uses for the word in its saved state.
function decodeWord(text) {
  const b = atob(text);
  let out = "";
  for (let i = 0; i < b.length; i++) out += String.fromCharCode(b.charCodeAt(i) ^ "parle".charCodeAt(i % 5));
  return out;
}

async function restoreToday(db) {
  const { data: { session } } = await db.sb.auth.getSession();
  if (!session) return;
  const today = db.dayNumber(new Date());
  let state;
  try {
    state = JSON.parse(read("gameState") || "null");
  } catch {}
  // The game has already saved today's word when it started the day (encoded, see wordle-it.js).
  const solution = state?.solutionEnc ? decodeWord(state.solutionEnc) : state?.solution;
  if (!solution) return;
  const playedHere = state.lastPlayedTs && db.dayNumber(new Date(state.lastPlayedTs)) === today;
  if (playedHere && ["WIN", "FAIL"].includes(state.gameStatus)) return;
  // The words are stored encrypted: my_result gives back only one's own, in clear.
  const { data, error } = await db.sb.rpc("my_result", { p_day: today });
  const r = data?.[0];
  if (error || !r?.guesses?.length) return;
  if (r.won && r.guesses[r.guesses.length - 1] !== solution) return; // not today's word: leave this device alone
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
        evaluations: board.map((g) => (g ? evaluate(g, solution) : null)),
        rowIndex: r.guesses.length,
        gameStatus: r.won ? "WIN" : "FAIL",
        lastPlayedTs: now,
        lastCompletedTs: now,
        startedAt: null,
        playMs: r.play_ms,
      })
    );
    localStorage.setItem("parle-synced", `${session.user.id}:${today}`);
    db.setGameOwner(today, session.user.id);
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

// Fetched once per day and kept on the device, so the end-of-game dialog shows it at once.
const DEFINITION_VERSION = 4;
// The definitions kept on the device (today and the next days, for days spent offline), encoded so the
// words are not readable at a glance in the browser's storage: { v, days: { day: definition } }.
const keepEncoded = (value) => btoa(unescape(encodeURIComponent(JSON.stringify(value))));
const readEncoded = (text) => JSON.parse(decodeURIComponent(escape(atob(text))));
const localDay = () => {
  const d = new Date();
  return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(2022, 0, 3)) / 864e5);
};

function keptDefinitions() {
  try {
    const kept = readEncoded(read("parle-definitions") || "bnVsbA=="); // "null"
    // A copy kept by an older version of the app (v changes with what the server sends) is asked again.
    if (kept?.v === DEFINITION_VERSION && kept.days) return kept.days;
  } catch {}
  return {};
}

// Today's definition and the next 3 days', in one request (they stay hidden until each game is over),
// kept on the device together with the ones already there; days before yesterday are dropped.
let ahead = null;
function fetchAhead() {
  if (ahead) return ahead;
  const from = localDay();
  ahead = fetch(`${SUPABASE_URL}/rest/v1/rpc/definitions_ahead`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ p_from: from }),
  })
    .then((res) => (res.ok ? res.json() : {}))
    .then((fresh) => {
      const days = { ...keptDefinitions(), ...fresh };
      for (const d of Object.keys(days)) if (+d < from - 1) delete days[d];
      try {
        localStorage.setItem("parle-definitions", keepEncoded({ v: DEFINITION_VERSION, days }));
        localStorage.removeItem("parle-definition"); // the single copy kept by the previous version
      } catch {}
      return days;
    })
    .catch(() => {
      ahead = null; // no network: try again next time
      return keptDefinitions();
    });
  return ahead;
}

async function loadDefinition(day) {
  const kept = keptDefinitions()[day];
  if (kept) return kept;
  const days = await fetchAhead();
  if (!days[day]) ahead = null; // not ready yet on the server: ask again next time
  return days[day] || null;
}

// Asked as soon as the game opens, so the definitions are there at the end even without network.
function prefetchDefinition() {
  fetchAhead();
}

async function showDefinition(el, day, word) {
  if (!el) return;
  const d = await loadDefinition(day);
  const lemma = d?.lemma || word;
  // The server finds the right entry ("parola1/" for words with several entries); the plain address otherwise.
  const treccaniUrl = d?.treccani_url || `https://www.treccani.it/vocabolario/${encodeURIComponent(lemma)}/`;
  const all = treccaniUrl.includes("/ricerca/"); // several entries: Treccani's page listing them all
  const treccani = `<a class="treccani" href="${esc(treccaniUrl)}${all ? "" : "#vocabolario"}" target="_blank" rel="noopener">${
    all ? "Tutti i significati su Treccani" : "Apri su Treccani"
  }</a>`;
  const title = `<p class="word">${esc(word)}</p>`;
  if (!d || d.status !== "ok" || !d.senses?.length) {
    el.innerHTML = `${title}<p class="none">Definizione non disponibile.</p>${treccani}`;
    return;
  }
  el.innerHTML = `
    ${title}
    ${d.form_of ? `<p class="form">${esc(d.form_of)}</p>` : ""}
    <ol>${d.senses.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>
    <p class="source">Definizione dal <a href="${esc(d.source_url)}" target="_blank" rel="noopener">Wikizionario</a></p>
    ${treccani}`;
}
window.parleShowDefinition = showDefinition;
if (window.parlePendingDefinition) showDefinition(...window.parlePendingDefinition);
prefetchDefinition();

let pushClaimed = false;
function sync() {
  rememberTime();
  if (!read(SESSION_KEY)) return;
  import("./db.js").then(async (db) => {
    await db.flushPending();
    await db.syncToday();
    // The device's notifications belong to the account logged in now (also after switching account).
    if (!pushClaimed && "serviceWorker" in navigator && "PushManager" in window && Notification.permission === "granted") {
      pushClaimed = true;
      try {
        const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
        if (sub) await db.sb.rpc("save_push_subscription", { p_subscription: sub.toJSON(), p_site: location.origin + location.pathname.replace(/[^/]*$/, "") });
      } catch {}
    }
  });
}

// Send the queue as soon as a game ends or the network comes back.
// A game just ended: it belongs to the account logged in now (or to nobody yet, without an account).
window.addEventListener("parle-result-queued", () => {
  let uid = null;
  try {
    uid = JSON.parse(read(SESSION_KEY) || "null")?.user?.id || null;
  } catch {}
  const now = new Date();
  const day = Math.floor((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(2022, 0, 3)) / 864e5);
  import("./db.js").then((db) => db.setGameOwner(day, uid));
});
window.addEventListener("parle-result-queued", sync);
window.addEventListener("online", sync);

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
// An app left open (or in the background) across midnight still shows yesterday's word: when it comes back
// on a new day the page is reloaded, so the player gets today's word and not yesterday's again.
function reloadOnNewDay() {
  const game = document.querySelector("game-app");
  const now = new Date();
  const today = Math.floor((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(2022, 0, 3)) / 864e5); // like the game
  if (document.visibilityState === "visible" && game?.dayOffset != null && today !== game.dayOffset) location.reload();
}
document.addEventListener("visibilitychange", reloadOnNewDay);
window.addEventListener("focus", reloadOnNewDay);
window.addEventListener("pageshow", reloadOnNewDay);

window.addEventListener("pagehide", rememberTime);
document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && rememberTime());
