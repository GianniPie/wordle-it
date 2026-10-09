// Loaded by the game page: saves the finished game to the leaderboard when the player is logged in,
// and lists the player's groups under "Classifiche" in the menu.
// The Supabase client is only downloaded for players who have logged in.
const SESSION_KEY = "sb-nxybifpygctncflcwbfa-auth-token";
const GROUPS_KEY = "parle-groups"; // [{ id, name }], written by the leaderboard page too

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
  if (!read(SESSION_KEY)) {
    box.innerHTML = "";
    return;
  }
  let groups = [];
  try {
    groups = JSON.parse(read(GROUPS_KEY) || "[]");
  } catch {}
  box.innerHTML =
    groups.map((g) => `<a class="item sub" href="classifica/?gruppo=${encodeURIComponent(g.id)}">${esc(g.name)}</a>`).join("") +
    `<a class="item sub" href="classifica/?nuovo">+ Nuovo gruppo</a>`;
}

async function refreshGroups(db) {
  const { data, error } = await db.sb.from("groups").select("id, name").order("created_at");
  if (error) return;
  try {
    localStorage.setItem(GROUPS_KEY, JSON.stringify(data));
  } catch {}
  renderGroups();
}

function sync() {
  if (!read(SESSION_KEY)) return;
  import("./db.js").then((db) => db.syncToday());
}

renderGroups();
if (read(SESSION_KEY)) import("./db.js").then(refreshGroups);
sync();
// The game fires this when the last tile of a row has flipped; by then the finished game is saved.
window.addEventListener("game-last-tile-revealed-in-row", () => setTimeout(sync, 100));
