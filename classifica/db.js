import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

export const SUPABASE_URL = "https://nxybifpygctncflcwbfa.supabase.co";
// Publishable key: safe in the browser, access is controlled by row level security.
const SUPABASE_KEY = "sb_publishable_-LLCVKGqP3hRaxXyrNoq5w_YUWu_QZs";

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const FIRST_PUZZLE = Date.UTC(2022, 0, 3);

// Puzzle number of a date, counted on the local calendar day like the game does.
export function dayNumber(date) {
  return Math.floor((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - FIRST_PUZZLE) / 864e5);
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
  const guesses = (state.boardState || []).filter(Boolean);
  const playMs = state.playMs > 0 ? Math.round(state.playMs) : null;
  const { data, error } = await sb.rpc("submit_result", { p_day: day, p_guesses: guesses, p_play_ms: playMs });
  if (error) {
    console.warn("Classifica: risultato non salvato", error.message);
    return null;
  }
  localStorage.setItem("parle-synced", mark);
  return data;
}
