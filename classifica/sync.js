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
  const { data: r, error } = await db.sb.from("results").select("guesses, won").eq("user_id", session.user.id).eq("day", today).maybeSingle();
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
      })
    );
    localStorage.setItem("parle-synced", `${session.user.id}:${today}`);
  } catch {
    return;
  }
  location.reload();
}

function sync() {
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
