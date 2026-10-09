// Loaded by the game page: saves the finished game to the leaderboard when the player is logged in,
// lists the player's groups under "Classifiche" in the menu, and shows the avatar (or ACCEDI) in the header.
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

function sync() {
  if (!read(SESSION_KEY)) return;
  import("./db.js").then((db) => db.syncToday());
}

renderGroups();
renderAccount();
if (read(SESSION_KEY))
  import("./db.js").then((db) => {
    refreshGroups(db);
    refreshName(db);
  });
sync();
// The game fires this when the last tile of a row has flipped; by then the finished game is saved.
window.addEventListener("game-last-tile-revealed-in-row", () => setTimeout(sync, 100));
