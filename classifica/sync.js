// Loaded by the game page: saves the finished game to the leaderboard when the player is logged in.
// The Supabase client is only downloaded for players who have logged in on the leaderboard page.
const SESSION_KEY = "sb-nxybifpygctncflcwbfa-auth-token";

function sync() {
  if (!localStorage.getItem(SESSION_KEY)) return;
  import("./db.js").then((db) => db.syncToday());
}

sync();
// The game fires this when the last tile of a row has flipped; by then the finished game is saved.
window.addEventListener("game-last-tile-revealed-in-row", () => setTimeout(sync, 100));
