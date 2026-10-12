import { createClient } from "./vendor/supabase.js";

export const SUPABASE_URL = "https://nxybifpygctncflcwbfa.supabase.co";
// Publishable key: safe in the browser, access is controlled by row level security.
const SUPABASE_KEY = "sb_publishable_-LLCVKGqP3hRaxXyrNoq5w_YUWu_QZs";

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const FIRST_PUZZLE = Date.UTC(2022, 0, 3);

// Puzzle number of a date, counted on the local calendar day like the game does.
export function dayNumber(date) {
  return Math.floor((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - FIRST_PUZZLE) / 864e5);
}

// Puzzle number of the day in progress in Italy: the group's days close at Italian midnight, the same
// moment for every player whatever their time zone.
export function italianDayNumber(date = new Date()) {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome" }).format(date).split("-").map(Number);
  return Math.floor((Date.UTC(y, m - 1, d) - FIRST_PUZZLE) / 864e5);
}

// Calendar date (UTC midnight) of a puzzle number.
export function dayDate(day) {
  return new Date(FIRST_PUZZLE + day * 864e5);
}

// Lowest total wins: a word guessed in N tries is worth N points, X/6 is worth 7,
// and so is a day not played (from the next day on; today can still be played).
export const MISSED_DAY_POINTS = 7;

export function points(result) {
  return result.won ? result.num_guesses : 7;
}

// Which account played each game on this device ({ day: user id, or null when played without an account}),
// so that switching account on the same device never sends someone else's game for the new account.
export function gameOwner(day) {
  try {
    return JSON.parse(localStorage.getItem("parle-owners") || "{}")[day];
  } catch {
    return undefined;
  }
}

export function setGameOwner(day, uid) {
  try {
    const owners = JSON.parse(localStorage.getItem("parle-owners") || "{}");
    owners[day] = uid;
    for (const d of Object.keys(owners)) if (+d < day - 10) delete owners[d];
    localStorage.setItem("parle-owners", JSON.stringify(owners));
  } catch {}
}

// A game can be sent for this account unless another account played it here.
function mine(day, uid) {
  const owner = gameOwner(day);
  return !owner || owner === uid;
}

// Sends the games queued by the game when they ended ("parle-pending"), oldest first. A game leaves the queue
// only when the server has it, or when it can never be accepted (too old, not a valid game); otherwise it is
// tried again at the next opening or when the network comes back.
let flushing = null;
export function flushPending() {
  if (flushing) return flushing;
  flushing = (async () => {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return 0;
    let queue, sent = 0;
    try {
      queue = JSON.parse(localStorage.getItem("parle-pending") || "[]");
    } catch {
      return 0;
    }
    for (const item of [...queue].sort((a, b) => a.day - b.day)) {
      if (!mine(item.day, session.user.id)) continue; // another account's game: it stays for that account
      const playMs = item.playMs > 0 ? Math.round(item.playMs) : null;
      const { error } = await sb.rpc("submit_result", { p_day: item.day, p_guesses: item.guesses, p_play_ms: playMs });
      const final = !error || /not a recent puzzle|invalid guesses|incomplete game/.test(error.message);
      if (!final) continue; // network or server trouble: keep it for later
      try {
        const left = JSON.parse(localStorage.getItem("parle-pending") || "[]").filter((q) => q.day !== item.day);
        localStorage.setItem("parle-pending", JSON.stringify(left));
        if (!error) {
          localStorage.setItem("parle-synced", `${session.user.id}:${item.day}`);
          setGameOwner(item.day, session.user.id);
        }
      } catch {}
      if (!error) sent += 1;
    }
    return sent;
  })().finally(() => (flushing = null));
  return flushing;
}

// Uploads today's finished game from the game's own saved state, once per user and day.
export async function syncToday() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return null;
  let state;
  try {
    state = JSON.parse(localStorage.getItem("gameState") || "null");
  } catch {
    return null;
  }
  if (!state || !["WIN", "FAIL"].includes(state.gameStatus) || !state.lastPlayedTs) return null;
  const day = dayNumber(new Date(state.lastPlayedTs));
  if (day !== dayNumber(new Date())) return null;
  const mark = `${session.user.id}:${day}`;
  if (localStorage.getItem("parle-synced") === mark) return null;
  if (!mine(day, session.user.id)) return null; // played here with another account
  const guesses = (state.boardState || []).filter(Boolean);
  const playMs = state.playMs > 0 ? Math.round(state.playMs) : null;
  const { data, error } = await sb.rpc("submit_result", { p_day: day, p_guesses: guesses, p_play_ms: playMs });
  if (error) {
    console.warn("Classifica: risultato non salvato", error.message);
    return null;
  }
  localStorage.setItem("parle-synced", mark);
  setGameOwner(day, session.user.id);
  return data;
}
