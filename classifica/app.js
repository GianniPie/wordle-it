import { sb, dayNumber, dayDate, points, MISSED_DAY_POINTS, syncToday } from "./db.js";

const $app = document.getElementById("app");
const $menu = document.getElementById("menu");
const $menuButton = document.getElementById("menu-button");

const MONTH_FMT = new Intl.DateTimeFormat("it", { month: "long", year: "numeric", timeZone: "UTC" });
const MONTH_NAME = new Intl.DateTimeFormat("it", { month: "long", timeZone: "UTC" });
const LINE_COLORS = ["#6aaa64", "#c9b458", "#3b82f6", "#e4572e", "#9b59b6", "#17a2b8", "#e83e8c", "#795548", "#20c997", "#6c757d"];

const state = {
  session: null,
  profile: null,
  groups: [],
  groupId: null,
  period: null, // months since year 0 (year * 12 + month), or "all" for the whole history
  resultsFlipped: read("parle-results-flipped") === "1", // Risultati: players as rows
  chartMode: "total", // Grafico: "total" or "gap" (distance from the leader)
  distOpen: null, // Distribuzione: ids of the players shown open (null: only me)
  resultsCols: readJSON("parle-results-cols", { day: true, word: true, wholeMonth: true }), // Risultati options
  folded: new Set(readJSON("parle-folded", [])), // modules shown closed
  data: {}, // per group: { members, results }
  pendingJoin: null,
  pendingFrom: null, // id of the member who shared the invite link
  chart: null,
  editingName: false, // Account page: name being changed in place
};

// ---------- helpers ----------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function toast(text, ms = 2000) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// The page's own dialog (the browser's confirm/prompt boxes can be blocked, e.g. in installed apps).
// Resolves to true (or the typed text when there is an input), or null when cancelled.
function modal({ title, html = "", ok = "Conferma", cancel = "Annulla", danger = false, input = null, requireText = null }) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.innerHTML = `<div class="modal${danger ? " danger" : ""}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        ${danger ? `<div class="modal-icon" aria-hidden="true">!</div>` : ""}
        <h3 id="modal-title">${esc(title)}</h3>
        <div class="modal-body">${html}</div>
        ${input ? `<input type="text" class="modal-input" maxlength="${input.maxlength || 200}" value="${esc(input.value || "")}" placeholder="${esc(input.placeholder || "")}" autocomplete="off" ${input.readonly ? "readonly" : ""} />` : ""}
        <div class="modal-actions">
          ${cancel ? `<button class="secondary" data-m="cancel">${esc(cancel)}</button>` : ""}
          <button class="${danger ? "danger-fill" : "primary"}" data-m="ok">${esc(ok)}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const field = wrap.querySelector(".modal-input");
    const okButton = wrap.querySelector('[data-m="ok"]');
    const check = () => {
      if (requireText) okButton.disabled = field.value.trim().toUpperCase() !== requireText;
    };
    const close = (value) => {
      document.removeEventListener("keydown", onKey);
      wrap.remove();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === "Escape") close(null);
      else if (e.key === "Enter" && !okButton.disabled) okButton.click();
    };
    document.addEventListener("keydown", onKey);
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap || e.target.dataset.m === "cancel") close(null);
      else if (e.target.dataset.m === "ok" && !okButton.disabled) close(field && !input.readonly && !requireText ? field.value : true);
    });
    if (field) {
      field.addEventListener("input", check);
      check();
      setTimeout(() => (input.readonly ? field.select() : field.focus()), 0);
    } else {
      setTimeout(() => okButton.focus(), 0);
    }
  });
}

function store(key, value) {
  try {
    value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value);
  } catch {}
}

function readJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function monthOfDay(day) {
  const d = dayDate(day);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

function monthOfDate(date) {
  return date.getFullYear() * 12 + date.getMonth();
}

function monthRange(month) {
  const y = Math.floor(month / 12), m = month % 12;
  return { first: dayNumber(new Date(y, m, 1)), last: dayNumber(new Date(y, m + 1, 0)) };
}

function monthLabel(month, withYear = true) {
  const d = new Date(Date.UTC(Math.floor(month / 12), month % 12, 1));
  return (withYear ? MONTH_FMT : MONTH_NAME).format(d);
}

function inviteUrl(code) {
  return `${location.origin}${location.pathname}?join=${encodeURIComponent(code)}&da=${state.session.user.id}`;
}

function invitePreview() {
  return sb.rpc("group_preview", { p_code: state.pendingJoin, p_from: state.pendingFrom });
}

function clearJoin() {
  store("parle-join", null);
  store("parle-join-from", null);
  state.pendingJoin = null;
  state.pendingFrom = null;
}

function redirectUrl() {
  const join = state.pendingJoin ? `?join=${encodeURIComponent(state.pendingJoin)}` : "";
  return `${location.origin}${location.pathname}${join}`;
}

// Which screen to show, from the address: ?account, ?nuovo, ?gruppo=<id>, or the leaderboards.
function currentView() {
  const params = new URLSearchParams(location.search);
  if (params.has("come-giocare")) return { name: "help" };
  if (params.has("impostazioni")) return { name: "settings" };
  if (params.has("account")) return { name: "account" };
  if (params.has("nuovo")) return { name: "new-group" };
  return { name: "groups", groupId: params.get("gruppo") };
}

function navigate(url, replace = false) {
  state.editingName = false;
  history[replace ? "replaceState" : "pushState"](null, "", url);
  closeMenu();
  window.scrollTo(0, 0);
  route();
}

function currentGroup() {
  return state.groups.find((g) => g.id === state.groupId);
}

function errorText(error) {
  const msg = error?.message || String(error);
  if (/rate limit/i.test(msg)) return "Troppe email inviate, riprova tra un po'.";
  if (/security purposes/i.test(msg)) return "Aspetta un minuto prima di chiedere un nuovo codice.";
  if (/expired|invalid.*(token|otp)|(token|otp).*invalid/i.test(msg)) return "Codice sbagliato o scaduto.";
  if (/invalid invite code/i.test(msg)) return "Link di invito non valido o scaduto.";
  return msg;
}

// ---------- startup ----------

async function init() {
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
  const params = new URLSearchParams(location.search);
  const join = params.get("join");
  if (join) {
    store("parle-join", join.toUpperCase());
    const from = params.get("da");
    store("parle-join-from", /^[0-9a-f-]{36}$/i.test(from || "") ? from : null);
  }
  state.pendingJoin = read("parle-join");
  state.pendingFrom = read("parle-join-from");

  const { data, error } = await sb.auth.getSession();
  if (error) console.warn(error);
  state.session = data.session;
  sb.auth.onAuthStateChange((event, session) => {
    const wasIn = !!state.session;
    state.session = session;
    if (event === "SIGNED_OUT" || (!wasIn && session)) route();
  });
  // Remove the invite code from the address bar.
  if (join) history.replaceState(null, "", location.pathname);
  window.addEventListener("popstate", route);
  route();
}

async function route() {
  let view = currentView();
  if (view.name === "help" || view.name === "settings") {
    // Usable without an account; the menu uses the groups the game page remembered.
    if (state.session && !state.groups.length) {
      try {
        state.groups = JSON.parse(read("parle-groups") || "[]");
      } catch {}
    }
    renderMenu();
    return view.name === "help" ? renderHelp() : renderSettings();
  }
  if (!state.session) {
    state.groups = [];
    store("parle-groups", null);
    store("parle-name", null);
    renderMenu();
    if (view.name === "account" || state.pendingJoin) return renderLogin(read("parle-login-email"));
    return renderNeedLogin();
  }

  if (!state.profile || state.profile.id !== state.session.user.id) {
    const { data: profile, error } = await sb.from("profiles").select("*").eq("id", state.session.user.id).maybeSingle();
    if (error) return renderError(error);
    state.profile = profile;
    store("parle-name", profile?.display_name ?? null);
    if (profile) {
      syncToday().then((saved) => {
        if (saved) {
          state.data = {};
          if (currentView().name === "groups" && state.groups.length) loadGroup();
        }
      });
    }
  }
  if (!state.profile) return renderName();


  await loadGroups();
  if (state.pendingJoin) return renderJoin();
  if (view.name === "account") return renderAccount();
  if (view.name === "new-group") return renderCreate();
  if (view.groupId && state.groups.some((g) => g.id === view.groupId)) state.groupId = view.groupId;
  if (!state.groupId) return renderNoGroups();
  state.period = monthOfDate(new Date());
  loadGroup();
}

// ---------- menu ----------

function renderMenu() {
  renderAccountSlot();
  const view = currentView();
  const current = (on) => (on ? ` aria-current="page"` : "");
  const icon = (d) => `<svg viewBox="0 0 24 24" width="24" height="24"><path fill="var(--color-tone-3)" d="${d}"/></svg>`;
  const groups = state.session
    ? state.groups
        .map((g) => `<a class="item sub" data-nav href="?gruppo=${encodeURIComponent(g.id)}"${current(view.name === "groups" && g.id === state.groupId)}>${esc(g.name)}</a>`)
        .join("") + `<a class="item sub" data-nav href="?nuovo"${current(view.name === "new-group")}>+ Nuovo gruppo</a>`
    : "";
  $menu.innerHTML = `
    <a class="item" href="../">${icon("M8 5v14l11-7z")}Gioca</a>
    <a class="item" data-nav href="./"${current(view.name === "groups" && !(state.session && state.groupId))}>${icon("M7.5 21H2V9h5.5v12zm7.25-18h-5.5v18h5.5V3zM22 11h-5.5v10H22V11z")}Classifiche</a>
    ${groups}
    <a class="item" data-nav href="?account"${current(view.name === "account")}>${icon("M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z")}Account</a>
    <a class="item" data-nav href="?come-giocare"${current(view.name === "help")}>${icon("M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5 0-2.21-1.79-4-4-4z")}Come giocare</a>
    <a class="item" data-nav href="?impostazioni"${current(view.name === "settings")}>${icon("M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z")}Impostazioni</a>`;
}

// Shown in the header avatar until the name is known.
const PERSON_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="#fff" d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';

function renderAccountSlot() {
  const slot = document.getElementById("account-slot");
  const current = currentView().name === "account" ? ` aria-current="page"` : "";
  if (!state.session) {
    slot.innerHTML = `<a class="header-login" data-nav href="?account" title="Non hai fatto l'accesso"${current}>ACCEDI</a>`;
    return;
  }
  const name = state.profile?.display_name || read("parle-name") || "";
  slot.innerHTML = `<a class="header-avatar" data-nav href="?account" aria-label="Account${name ? ` di ${esc(name)}` : ""}"${current}>${name ? esc([...name][0]) : PERSON_ICON}</a>`;
}

function closeMenu() {
  $menu.hidden = true;
  $menuButton.setAttribute("aria-expanded", "false");
}

$menuButton.addEventListener("click", (e) => {
  e.stopPropagation();
  $menu.hidden = !$menu.hidden;
  $menuButton.setAttribute("aria-expanded", String(!$menu.hidden));
});
document.addEventListener("click", (e) => {
  const link = e.target.closest("a[data-nav]");
  if (link) {
    e.preventDefault();
    navigate(link.getAttribute("href"));
  } else if (!$menu.hidden && !e.target.closest("#menu")) {
    closeMenu();
  }
});
window.addEventListener("keydown", (e) => e.key === "Escape" && closeMenu());

function renderHelp() {
  const tile = (letter, evaluation = "") => `<span class="tile ${evaluation}">${letter}</span>`;
  const row = (word, at, evaluation) => `<div class="tile-row">${[...word].map((l, i) => tile(l, i === at ? evaluation : "")).join("")}</div>`;
  renderShell(`<h2>Come giocare</h2>
    <p>Indovina delle <strong>PARoLE</strong> di 5 lettere in 6 tentativi.</p>
    <p>PAR🇮🇹LE è una versione italiana (non ufficiale) di <a href="https://www.nytimes.com/games/wordle/index.html">WORDLE</a>.</p>
    <p>Dopo ogni tentativo, i colori delle tessere cambieranno per mostrarti quanto vicino sei andato ad indovinare la parola.</p>
    <div class="examples">
      <div class="example">${row("buffa", 0, "correct")}<p>La lettera <strong>B</strong> è nella parola ed è nel posto giusto.</p></div>
      <div class="example">${row("porto", 2, "present")}<p>La lettera <strong>R</strong> è nella parola ma nel posto sbagliato.</p></div>
      <div class="example">${row("vaghi", 3, "absent")}<p>La lettera <strong>H</strong> non è nella parola.</p></div>
    </div>
    <p><strong>Un nuovo gioco di PAR🇮🇹LE ogni giorno!</strong></p>`);
}

// ---------- settings (stored where the game reads them) ----------

function readGameState() {
  try {
    return JSON.parse(read("gameState") || "{}") || {};
  } catch {
    return {};
  }
}

function readFlag(key) {
  try {
    return !!JSON.parse(read(key));
  } catch {
    return false;
  }
}

// Like the game: hard mode can only be switched on before the first guess of the day.
function hardModeLocked(gs) {
  return !gs.hardMode && gs.gameStatus === "IN_PROGRESS" && gs.rowIndex > 0;
}

// "light", "dark" or "system" (nothing chosen: follow the phone), stored where the game reads it.
function themeMode() {
  const v = read("darkTheme");
  return v === "true" ? "dark" : v === "false" ? "light" : "system";
}

function applyTheme() {
  const mode = themeMode();
  const dark = mode === "dark" || (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("nightmode", dark);
}

function renderSettings() {
  const gs = readGameState();
  const mode = themeMode();
  // Every setting is a row of buttons in one rounded group, the chosen one in green.
  const choice = (setting, value, label, on) =>
    `<button role="radio" aria-checked="${on}" data-action="setting" data-setting="${setting}" data-value="${value}">${label}</button>`;
  const row = (title, description, buttons) => `<div class="setting stacked">
      <span class="text"><span class="title">${title}</span>${description ? `<span class="description">${description}</span>` : ""}</span>
      <div class="segmented" role="radiogroup" aria-label="${title}">${buttons}</div>
    </div>`;
  const onOff = (setting, on) => choice(setting, "off", "Disattivo", !on) + choice(setting, "on", "Attivo", on);
  renderShell(`<h2>Impostazioni</h2>
    <div class="settings">
      ${row("Il gioco si fa duro", "Ogni lettera nota deve essere usata nei tentativi successivi", onOff("hard-mode", !!gs.hardMode))}
      ${row("Tema", '"Sistema" segue le impostazioni del telefono',
        choice("theme", "light", "Chiaro", mode === "light") + choice("theme", "dark", "Scuro", mode === "dark") + choice("theme", "system", "Sistema", mode === "system"))}
      ${readFlag("colorBlindTheme") ? row("Colori ad alto contrasto", "", onOff("color-blind-theme", true)) : ""}
    </div>`);
}

function changeSetting(setting, value) {
  const on = value === "on";
  switch (setting) {
    case "theme":
      store("darkTheme", value === "system" ? null : JSON.stringify(value === "dark"));
      applyTheme();
      break;
    case "color-blind-theme":
      store("colorBlindTheme", JSON.stringify(on));
      document.documentElement.classList.toggle("colorblind", on);
      break;
    case "hard-mode": {
      const gs = readGameState();
      if (on && hardModeLocked(gs)) return toast("Si può attivare 'il gioco si fa duro' solo all'inizio di una partita", 3000);
      store("gameState", JSON.stringify({ ...gs, hardMode: on }));
      break;
    }
  }
  renderSettings();
}

function renderNeedLogin() {
  $app.innerHTML = `<h2>Classifiche</h2>
    <p>Per vedere le classifiche dei tuoi gruppi e sfidare gli amici, accedi al tuo account.</p>
    <p><a class="button primary" data-nav href="?account">Accedi</a></p>`;
}

function renderAccount() {
  const name = state.profile.display_name;
  const who = state.editingName
    ? `<form class="who rename" data-form="rename-me">
        <input type="text" name="name" maxlength="24" value="${esc(name)}" autocomplete="nickname" required aria-label="Il tuo nome" />
        <p class="error small" data-error hidden></p>
        <span class="rename-actions">
          <button class="secondary" type="button" data-action="cancel-name">Annulla</button>
          <button class="primary" type="submit">Salva</button>
        </span>
      </form>`
    : `<span class="who"><strong>${esc(name)}</strong><span class="muted small">${esc(state.session.user.email || "")}</span></span>
      <button class="link" data-action="edit-name">Cambia nome</button>`;
  renderShell(`<h2>Account</h2>
    <div class="card profile${state.editingName ? " editing" : ""}">
      <span class="avatar" aria-hidden="true">${esc([...name][0] || "?")}</span>
      ${who}
    </div>
    <p class="muted small">Su questo dispositivo l'accesso resta attivo finché non esci.</p>
    <button class="secondary" data-action="logout">Esci</button>
    <div class="danger-zone">
      <h2>Eliminare l'account</h2>
      <p class="small">Cancella per sempre la tua email, il tuo nome, i tuoi risultati e la tua presenza nei gruppi.</p>
      <button class="danger-outline" data-action="delete-account">Elimina il mio account</button>
    </div>`);
}

function renderError(error) {
  $app.innerHTML = `<p class="error center">Qualcosa è andato storto: ${esc(errorText(error))}</p>
    <p class="center"><button class="secondary" data-action="reload">Riprova</button></p>`;
}

// ---------- login ----------

async function renderLogin(sentTo) {
  let invite = "";
  if (state.pendingJoin) {
    const { data } = await invitePreview();
    if (data?.[0]) invite = `<div class="banner"><strong>${esc(data[0].inviter)}</strong> ti invita nel gruppo <strong>${esc(data[0].name)}</strong></div>`;
  }
  if (sentTo) {
    $app.innerHTML = `${invite}
      <div class="card center" style="margin-top:16px">
        <p><strong>Controlla la posta</strong></p>
        <p>Abbiamo inviato un codice a <strong>${esc(sentTo)}</strong>. Scrivilo qui:</p>
        <form class="inline" data-form="code">
          <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="Codice" required style="text-align:center;letter-spacing:4px;font-size:20px" />
          <button class="primary" type="submit">Accedi</button>
        </form>
        <p class="error small" data-error hidden></p>
        <p class="muted small">L'email arriva da <strong>Parle</strong> (gruppi.parle@gmail.com). Se non la trovi, guarda nello spam e segnala "Non è spam": le prossime arriveranno nella posta in arrivo.</p>
        <div class="actions" style="justify-content:center">
          <button class="link" data-action="resend-code">Manda un nuovo codice</button>
          <button class="link" data-action="login-again">Usa un'altra email</button>
        </div>
      </div>`;
    $app.querySelector("input").focus();
    return;
  }
  $app.innerHTML = `${invite}
    <h2>Account</h2>
    <p>Con un account i tuoi risultati di Par🇮🇹le entrano nella classifica dei gruppi di amici. Se ce l'hai già, usa la stessa email per ritrovare tutto su questo dispositivo.</p>
    <div class="card">
      <p style="margin-top:0"><strong>La tua email</strong><br><span class="muted small">Ti mandiamo un codice da scrivere qui, niente password.</span></p>
      <form class="inline" data-form="login">
        <input type="email" name="email" placeholder="nome@email.it" autocomplete="email" required />
        <button class="primary" type="submit">Invia</button>
      </form>
      <p class="error small" data-error hidden></p>
    </div>`;
}

async function submitLogin(form) {
  const email = form.email.value.trim();
  const button = form.querySelector("button");
  button.disabled = true;
  const { error } = await sb.auth.signInWithOtp({ email });
  button.disabled = false;
  if (error) return showFormError(form, error);
  // Remembered so the code screen comes back if the app reloads while the player reads the email.
  store("parle-login-email", email);
  renderLogin(email);
}

async function submitCode(form) {
  const email = read("parle-login-email");
  const token = form.code.value.replace(/\D/g, "");
  if (!email || !token) return;
  const button = form.querySelector("button");
  button.disabled = true;
  const { error } = await sb.auth.verifyOtp({ email, token, type: "email" });
  button.disabled = false;
  if (error) return showFormError(form, error);
  store("parle-login-email", null);
}

async function resendCode() {
  const email = read("parle-login-email");
  if (!email) return renderLogin();
  const { error } = await sb.auth.signInWithOtp({ email });
  toast(error ? errorText(error) : "Nuovo codice inviato", 3000);
}

function showFormError(form, error) {
  const el = form.parentElement.querySelector("[data-error]");
  if (!el) return toast(errorText(error), 3000);
  el.textContent = errorText(error);
  el.hidden = false;
}

// ---------- profile ----------

function renderName() {
  $app.innerHTML = `<h2>Come ti chiami?</h2>
    <p>Questo nome lo vedranno gli altri nei tuoi gruppi.</p>
    <div class="card">
      <form class="inline" data-form="name">
        <input type="text" name="name" maxlength="24" placeholder="Il tuo nome" autocomplete="nickname" required />
        <button class="primary" type="submit">Salva</button>
      </form>
      <p class="error small" data-error hidden></p>
    </div>`;
  $app.querySelector("input").focus();
}

async function submitNewName(form) {
  const name = form.name.value.trim();
  if (!name) return;
  if (name !== state.profile.display_name) {
    const { error } = await sb.from("profiles").update({ display_name: name }).eq("id", state.session.user.id);
    if (error) return showFormError(form, error);
    state.profile = { ...state.profile, display_name: name };
    store("parle-name", name);
    renderMenu();
    state.data = {}; // group pages show the new name
    toast("Nome aggiornato");
  }
  state.editingName = false;
  renderAccount();
}

async function submitName(form) {
  const name = form.name.value.trim();
  if (!name) return;
  const row = { id: state.session.user.id, display_name: name };
  const { error } = state.profile
    ? await sb.from("profiles").update({ display_name: name }).eq("id", row.id)
    : await sb.from("profiles").insert(row);
  if (error) return showFormError(form, error);
  state.profile = { ...state.profile, id: row.id, display_name: name };
  store("parle-name", name);
  state.data = {};
  route();
}

// ---------- invitations ----------

async function renderJoin() {
  const { data, error } = await invitePreview();
  const group = data?.[0];
  if (error || !group) {
    clearJoin();
    toast("Link di invito non valido o scaduto.", 3000);
    return navigate("./", true);
  }
  const already = state.groups.some((g) => g.id === group.id);
  $app.innerHTML = `<div class="card center" style="margin-top:16px">
      <p><strong>${esc(group.inviter)}</strong> ti invita nel gruppo</p>
      <p style="font-size:24px;font-weight:700;margin:8px 0">${esc(group.name)}</p>
      <p class="muted small">${group.members} ${group.members == 1 ? "giocatore" : "giocatori"}</p>
      <p><button class="primary" data-action="join">${already ? "Apri il gruppo" : "Entra nel gruppo"}</button></p>
      <button class="link" data-action="skip-join">No grazie</button>
    </div>`;
}

async function joinPending() {
  const { data: gid, error } = await sb.rpc("join_group", { p_code: state.pendingJoin });
  clearJoin();
  if (error) {
    toast(errorText(error), 3000);
    return navigate("./", true);
  }
  delete state.data[gid];
  navigate(`?gruppo=${gid}`, true);
}

// ---------- groups ----------

async function loadGroups() {
  const { data, error } = await sb.from("groups").select("*").order("created_at");
  if (error) return renderError(error);
  state.groups = data;
  // The game page lists these in its menu.
  store("parle-groups", JSON.stringify(data.map((g) => ({ id: g.id, name: g.name }))));
  if (!state.groups.some((g) => g.id === state.groupId)) {
    const saved = read("parle-group");
    state.groupId = state.groups.some((g) => g.id === saved) ? saved : state.groups[0]?.id ?? null;
  }
  renderMenu();
}

async function loadGroup() {
  const group = currentGroup();
  if (!group) return renderNoGroups();
  store("parle-group", group.id);
  renderMenu();
  if (!state.data[group.id]) {
    renderShell(`<p class="muted center">Caricamento...</p>`);
    try {
      state.data[group.id] = await fetchGroupData(group);
    } catch (error) {
      return renderError(error);
    }
  }
  renderGroup();
}

async function fetchGroupData(group) {
  const { data: members, error } = await sb
    .from("group_members")
    .select("user_id, joined_at, profiles(display_name)")
    .eq("group_id", group.id)
    .order("joined_at");
  if (error) throw error;
  const ids = members.map((m) => m.user_id);
  const fromDay = monthRange(monthOfDate(new Date(group.created_at))).first;
  const results = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("results")
      .select("user_id, day, won, num_guesses")
      .in("user_id", ids)
      .gte("day", fromDay)
      .order("day")
      .order("user_id")
      .range(from, from + 999);
    if (error) throw error;
    results.push(...data);
    if (data.length < 1000) break;
  }
  return {
    members: members.map((m) => ({ id: m.user_id, name: m.profiles?.display_name || "?", joinedAt: m.joined_at })),
    results,
  };
}

function createForm() {
  return `<div class="card">
      <p style="margin-top:0"><strong>Nuovo gruppo</strong><br><span class="muted small">Poi condividi il link di invito con gli amici.</span></p>
      <form class="inline" data-form="create">
        <input type="text" name="name" maxlength="40" placeholder="Nome del gruppo" required />
        <button class="primary" type="submit">Crea</button>
      </form>
      <p class="error small" data-error hidden></p>
      <button class="link" data-action="cancel-create">Annulla</button>
    </div>`;
}

function renderShell(body) {
  if (state.chart) {
    state.chart.destroy();
    state.chart = null;
  }
  $app.innerHTML = body;
}

function renderNoGroups() {
  renderShell(`<h2>Classifiche</h2>
    <p>Ciao ${esc(state.profile.display_name)}, non sei ancora in nessun gruppo.</p>
    <div class="card">
      <p style="margin-top:0"><strong>Entrare nel gruppo di un amico</strong><br><span class="muted small">Apri il link di invito che ti ha mandato.</span></p>
      <p style="margin-bottom:0"><strong>Creare un gruppo tuo</strong><br><span class="muted small">Poi invita gli amici con un link.</span></p>
      <p style="margin-bottom:0"><a class="button secondary" data-nav href="?nuovo">Crea un gruppo</a></p>
    </div>`);
}

function renderCreate() {
  renderShell(`<h2>Nuovo gruppo</h2>${createForm()}`);
  $app.querySelector("input").focus();
}

async function submitCreate(form) {
  const name = form.name.value.trim();
  if (!name) return;
  const { data, error } = await sb.rpc("create_group", { p_name: name });
  if (error) return showFormError(form, error);
  navigate(`?gruppo=${data.id}`, true);
  toast("Gruppo creato! Ora invita gli amici.", 2500);
}

// ---------- statistics ----------

// Days shown for the chosen period: a month, or everything since the group's first month ("all").
function periodRange(group, period) {
  const today = dayNumber(new Date());
  if (period === "all") return { first: monthRange(monthOfDate(new Date(group.created_at))).first, last: today };
  return monthRange(period);
}

// Each player's day by day points for the period: played days, X/6 and skipped days (7),
// and today only once played (it can still be played until midnight).
function periodStats(data, first, last) {
  const today = dayNumber(new Date());
  const closedUntil = Math.min(last, today - 1);
  const results = new Map(data.members.map((m) => [m.id, new Map()]));
  for (const r of data.results) if (r.day >= first && r.day <= last) results.get(r.user_id)?.set(r.day, r);

  const rows = data.members.map((m) => {
    const mine = results.get(m.id);
    const values = [];
    const counts = [0, 0, 0, 0, 0, 0, 0, 0]; // index = points, 1..7
    const dist = [0, 0, 0, 0, 0, 0, 0]; // 1..6 tries, then X/6
    let played = 0, wins = 0, guesses = 0, missed = 0;
    for (let d = first; d <= Math.min(last, today); d++) {
      const r = mine.get(d);
      let v;
      if (r) {
        v = points(r);
        played += 1;
        if (r.won) {
          wins += 1;
          guesses += r.num_guesses;
          dist[r.num_guesses - 1] += 1;
        } else {
          dist[6] += 1;
        }
      } else if (d <= closedUntil) {
        v = MISSED_DAY_POINTS;
        missed += 1;
      } else {
        continue;
      }
      values.push(v);
      counts[v] += 1;
    }
    const total = values.reduce((a, b) => a + b, 0);
    const mean = values.length ? total / values.length : 0;
    const sd = values.length ? Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length) : 0;
    return {
      ...m, results: mine, points: total, mean, sd, played, wins, guesses, missed, dist, counts,
      best: values.length ? Math.min(...values) : null,
      worst: values.length ? Math.max(...values) : null,
    };
  });

  // Ranked on points + standard deviation of the daily points (lower is better): on equal points
  // the steadier player goes first, so there are no ties.
  rows.forEach((r) => (r.score = r.points + r.sd));
  const standings = rows.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  standings.forEach((s, i) => {
    const prev = standings[i - 1];
    s.rank = prev && prev.score === s.score ? prev.rank : i + 1;
    s.gap = prev ? s.points - prev.points : null;
  });
  return { first, last, today, closedUntil, standings, anyPlayed: rows.some((r) => r.played) };
}

const decimals = new Intl.NumberFormat("it", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------- group page ----------

// Order of the movable modules, remembered on this device. "Gruppo" is always last.
const MODULES = {
  standings: "Classifica",
  results: "Risultati",
  chart: "Grafico",
  today: "Oggi",
  distribution: "Distribuzione dei tentativi",
};

function moduleOrder() {
  let saved = [];
  try {
    saved = JSON.parse(read("parle-modules") || "[]");
  } catch {}
  const known = Object.keys(MODULES);
  return [...saved.filter((id) => known.includes(id)), ...known.filter((id) => !saved.includes(id))];
}

function renderGroup() {
  const group = currentGroup();
  const data = state.data[group.id];
  const firstMonth = monthOfDate(new Date(group.created_at));
  const thisMonth = monthOfDate(new Date());
  if (state.period !== "all" && (state.period < firstMonth || state.period > thisMonth)) state.period = thisMonth;
  const { first, last } = periodRange(group, state.period);
  const stats = periodStats(data, first, last);
  const showToday = state.period === "all" || state.period === thisMonth;

  const options = [`<option value="all"${state.period === "all" ? " selected" : ""}>Classifica globale</option>`];
  for (let m = thisMonth; m >= firstMonth; m--) options.push(`<option value="${m}"${state.period === m ? " selected" : ""}>${monthLabel(m)}</option>`);

  const handle = `<button class="handle" aria-label="Sposta il modulo" title="Trascina per spostare">
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M9 5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0 7a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm-1.5 8.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM18 5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm-1.5 8.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM18 19a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"/></svg>
    </button>`;
  const builders = {
    standings: () => standingsModule(stats),
    results: () => resultsModule(stats),
    chart: () => chartModule(stats),
    today: () => (showToday ? todayModule(data, stats) : null),
    distribution: () => distributionModule(stats),
  };
  const modules = moduleOrder()
    .map((id) => {
      const built = builders[id]();
      if (!built) return "";
      return moduleFrame(id, MODULES[id], built, handle);
    })
    .join("");

  renderShell(`<h1 class="group-title">${esc(group.name)}</h1>
    <div class="period-picker">
      <select class="period" aria-label="Periodo">${options.join("")}</select>
    </div>
    <div id="modules">${modules}</div>
    ${moduleFrame("group", "Gruppo", { body: manageSection(group, data) }, "", "fixed")}`);

  enableModuleDrag();
  if (stats.anyPlayed) drawChart(stats);
}

// A module card: handle (if movable), title that folds the whole module, its own controls.
function moduleFrame(id, title, built, handle, extraClass = "") {
  const folded = state.folded.has(id);
  return `<section class="module ${extraClass}${folded ? " folded" : ""}" data-module="${id}">
      <div class="module-head">
        ${handle}
        <button class="module-title" data-action="fold" data-id="${id}" aria-expanded="${!folded}">
          <h2>${title}</h2>
          <svg class="chevron" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
        </button>
        ${folded ? "" : built.controls || ""}
      </div>
      ${folded ? "" : `<div class="module-body">${built.body}</div>`}
    </section>`;
}

function enableModuleDrag() {
  if (!window.Sortable) return setTimeout(enableModuleDrag, 100);
  const box = document.getElementById("modules");
  if (!box) return;
  window.Sortable.create(box, {
    handle: ".handle",
    animation: 150,
    ghostClass: "module-ghost",
    // Follow the finger or mouse directly instead of the browser's own drag and drop (unreliable on phones).
    forceFallback: true,
    fallbackTolerance: 3,
    onEnd: () => {
      const order = [...box.querySelectorAll(".module")].map((el) => el.dataset.module);
      store("parle-modules", JSON.stringify(moduleOrder().filter((id) => !order.includes(id)).concat(order)));
    },
  });
}

function standingsModule(stats) {
  const me = state.session.user.id;
  const medal = (s) => (!stats.anyPlayed ? "" : s.rank === 1 ? "🥇" : s.rank === 2 ? "🥈" : s.rank === 3 ? "🥉" : s.rank);
  const dash = (v) => (v == null ? "-" : v);
  const body = `<div class="scroll-x"><table class="standings">
      <thead><tr>
        <th></th><th>Giocatore</th><th>Punti</th><th>Distanza</th><th>Media</th><th>Punti +<br>dev. std</th><th>Vinte</th>
        <th>Giocate</th><th>Miglior<br>risultato</th><th>Peggiore<br>risultato</th>
        ${[1, 2, 3, 4, 5, 6, 7].map((k) => `<th>Ricorrenze<br>${k}</th>`).join("")}
      </tr></thead>
      <tbody>${stats.standings
        .map(
          (s) => `<tr class="${s.id === me ? "me" : ""}">
            <td class="pos">${medal(s)}</td>
            <td class="name">${esc(s.name)}</td>
            <td class="pts">${s.points}</td>
            <td>${s.gap == null ? "-" : `+${s.gap}`}</td>
            <td>${s.played || s.missed ? decimals.format(s.mean) : "-"}</td>
            <td>${s.played || s.missed ? decimals.format(s.score) : "-"}</td>
            <td>${s.wins}</td>
            <td>${s.played}</td>
            <td>${dash(s.best)}</td>
            <td>${dash(s.worst)}</td>
            ${[1, 2, 3, 4, 5, 6, 7].map((k) => `<td>${s.counts[k]}</td>`).join("")}
          </tr>`
        )
        .join("")}</tbody>
    </table></div>
    <p class="muted small">X/6 e giorno saltato valgono 7 punti. Vince chi ha meno punti; la classifica è calcolata sul valore <strong>punti + deviazione standard</strong> (più basso è meglio), così a parità di punti passa avanti chi è stato più costante e non ci sono pari merito.</p>`;
  return { body };
}

const DAY_FMT = new Intl.DateTimeFormat("it", { weekday: "short", day: "numeric", timeZone: "UTC" });

function resultsModule(stats) {
  const me = state.session.user.id;
  const opts = state.resultsCols;
  const players = [...stats.standings].sort((a, b) => (a.id === me ? -1 : b.id === me ? 1 : 0));
  const iPlayedToday = players.find((p) => p.id === me)?.results.has(stats.today);
  const days = [];
  const lastShown = opts.wholeMonth ? stats.last : Math.min(stats.last, stats.today);
  for (let d = stats.first; d <= lastShown; d++) days.push(d);

  // What a cell shows: tries, X, - (skipped), ✓ (today, hidden until I play), or nothing (not yet).
  const cell = (p, d) => {
    const r = p.results.get(d);
    if (r) {
      if (d === stats.today && !iPlayedToday && p.id !== me) return { text: "✓" };
      return { text: r.won ? String(r.num_guesses) : "X", value: points(r) };
    }
    if (d <= stats.closedUntil) return { text: "-", value: MISSED_DAY_POINTS };
    return { text: "" };
  };
  const grid = days.map((d) => {
    const cells = players.map((p) => cell(p, d));
    const values = cells.filter((c) => c.value != null).map((c) => c.value);
    const best = Math.min(...values), worst = Math.max(...values);
    cells.forEach((c) => {
      if (c.value == null || best === worst) return;
      if (c.value === best) c.mark = "best";
      else if (c.value === worst) c.mark = "worst";
    });
    return cells;
  });
  const td = (c) => `<td class="${c.mark || ""}">${c.text}</td>`;
  const today = (d) => (d === stats.today ? "is-today" : "");
  // Day and word labels, as chosen with the buttons.
  const labels = [
    opts.day && { title: "Giorno", text: (d) => DAY_FMT.format(dayDate(d)) },
    opts.word && { title: "Parola", text: (d) => `#${d}` },
  ].filter(Boolean);
  const name = (p) => `<span class="player">${esc(p.name)}</span>`;

  let table;
  if (state.resultsFlipped) {
    table = `<thead>${labels
      .map((l, i) => `<tr><th class="corner"></th>${days.map((d) => `<th class="${today(d)}">${l.text(d)}</th>`).join("")}</tr>`)
      .join("")}</thead>
      <tbody>${players.map((p, i) => `<tr><th scope="row" class="names">${name(p)}</th>${grid.map((cells) => td(cells[i])).join("")}</tr>`).join("")}</tbody>`;
  } else {
    table = `<thead><tr>${labels.map((l) => `<th class="label">${l.title}</th>`).join("")}${players.map((p) => `<th class="names">${name(p)}</th>`).join("")}</tr></thead>
      <tbody>${days
        .map((d, j) => `<tr>${labels.map((l, i) => `<th scope="row" class="label ${i === 0 ? "first" : ""} ${today(d)}">${l.text(d)}</th>`).join("")}${grid[j].map(td).join("")}</tr>`)
        .join("")}</tbody>`;
  }
  // Same look as the other button groups: each button switches its option on (green) or off.
  const option = (key, label) => `<button data-action="results-col" data-key="${key}" aria-pressed="${!!opts[key]}">${label}</button>`;
  return {
    body: `<div class="toggles" role="group" aria-label="Opzioni della tabella">
        ${option("day", "Giorno")}${option("word", "N° parola")}${option("wholeMonth", "Mese intero")}
        <button data-action="flip-results" aria-pressed="${!!state.resultsFlipped}" title="Scambia righe e colonne">⇄ Ruota</button>
      </div>
      <div class="scroll-x"><table class="results${state.resultsFlipped ? " flipped" : ""}">${table}</table></div>`,
  };
}

function chartModule(stats) {
  if (!stats.anyPlayed) return { body: `<p class="muted">Ancora nessuna partita in questo periodo.</p>` };
  const mode = state.chartMode || "total";
  const choice = (value, label) => `<button role="radio" aria-checked="${mode === value}" data-action="chart-mode" data-value="${value}">${label}</button>`;
  return {
    body: `<div class="segmented small" role="radiogroup" aria-label="Tipo di grafico">${choice("total", "Andamento dei punti")}${choice("gap", "Distanza dal primo")}</div>
      <div class="chart-box"><canvas id="chart"></canvas></div>`,
  };
}

function todayModule(data, stats) {
  const me = state.session.user.id;
  const todays = new Map(data.results.filter((r) => r.day === stats.today).map((r) => [r.user_id, r]));
  const iPlayed = todays.has(me);
  const items = data.members
    .map((m) => {
      const r = todays.get(m.id);
      let text;
      if (!r) text = `<span class="muted">non ancora</span>`;
      else if (!iPlayed && m.id !== me) text = "✓ fatto";
      else text = r.won ? `${r.num_guesses}/6 · ${points(r)} punti` : `X/6 · ${points(r)} punti`;
      return `<li><span>${esc(m.name)}</span><span>${text}</span></li>`;
    })
    .join("");
  return {
    body: `<ul class="today">${items}</ul>`,
  };
}

function distributionModule(stats) {
  const me = state.session.user.id;
  const players = stats.standings.filter((s) => s.played || s.missed);
  if (!players.length) return { body: `<p class="muted">Ancora nessuna partita in questo periodo.</p>` };
  const body = players
    .map((s) => {
      // 1-6 tries, X/6, and days skipped ("-").
      const counts = [...s.dist, s.missed];
      const max = Math.max(...counts, 1);
      // Green for the most frequent winning try (never for X or skipped days).
      const wins = s.dist.slice(0, 6);
      const best = wins.indexOf(Math.max(...wins));
      const rows = counts
        .map(
          (n, i) => `<div class="row"><span>${i < 6 ? i + 1 : i === 6 ? "X" : "-"}</span>
            <div class="bar ${i === best && n ? "best" : ""}" style="width:${Math.max(8, (100 * n) / max)}%">${n}</div></div>`
        )
        .join("");
      const open = state.distOpen?.has(s.id) ?? s.id === me;
      return `<details class="dist" data-player="${s.id}"${open ? " open" : ""}><summary class="who">${esc(s.name)}</summary>${rows}</details>`;
    })
    .join("");
  return { body };
}

function drawChart(stats) {
  if (!window.Chart) return setTimeout(() => drawChart(stats), 100);
  const canvas = document.getElementById("chart");
  if (!canvas) return;
  const end = Math.min(stats.last, stats.today);
  const days = [];
  for (let d = stats.first; d <= end; d++) days.push(d);
  const data = state.data[state.groupId];
  const css = getComputedStyle(document.documentElement);
  const textColor = css.getPropertyValue("--color-tone-2").trim();
  const gridColor = css.getPropertyValue("--color-tone-4").trim();
  const players = stats.standings.filter((s) => s.played || s.missed);
  // Running total per player and day (skipped days count from the day after).
  const totals = players.map((s) => {
    let total = 0;
    return days.map((d) => {
      const r = s.results.get(d);
      total += r ? points(r) : d <= stats.closedUntil ? MISSED_DAY_POINTS : 0;
      return total;
    });
  });
  const gap = (state.chartMode || "total") === "gap";
  const leader = days.map((_, i) => Math.min(...totals.map((t) => t[i])));
  const datasets = players.map((s, p) => {
    const color = LINE_COLORS[data.members.findIndex((m) => m.id === s.id) % LINE_COLORS.length];
    return {
      label: s.name,
      data: gap ? totals[p].map((v, i) => v - leader[i]) : totals[p],
      borderColor: color,
      backgroundColor: color,
      borderWidth: 2.5,
      pointRadius: 0,
      pointHoverRadius: 4,
      tension: gap ? 0 : 0.25,
    };
  });
  if (state.chart) state.chart.destroy();
  state.chart = new window.Chart(canvas, {
    type: "line",
    data: { labels: days.map((d) => (state.period === "all" ? `#${d}` : dayDate(d).getUTCDate())), datasets },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "bottom", labels: { color: textColor, boxWidth: 12, boxHeight: 12 } },
        tooltip: {
          itemSort: (a, b) => a.parsed.y - b.parsed.y,
          callbacks: {
            title: (items) => (state.period === "all" ? `Parola ${items[0].label}` : `Giorno ${items[0].label}`),
            label: (item) => ` ${item.dataset.label}: ${gap ? (item.parsed.y ? `+${item.parsed.y}` : "in testa") : `${item.parsed.y} punti`}`,
          },
        },
      },
      scales: {
        x: { ticks: { color: textColor, maxTicksLimit: 10 }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: textColor, precision: 0 }, grid: { color: gridColor } },
      },
    },
  });
}

function manageSection(group, data) {
  const me = state.session.user.id;
  const isOwner = group.owner_id === me;
  const members = data.members
    .map(
      (m) => `<li><span>${esc(m.name)}${m.id === group.owner_id ? ` <span class="muted small">(admin)</span>` : ""}</span>
        ${isOwner && m.id !== me ? `<button class="link danger small" data-action="remove" data-id="${m.id}" data-name="${esc(m.name)}">Rimuovi</button>` : ""}</li>`
    )
    .join("");
  return `<div>
      <p style="margin-top:0"><strong>Invita gli amici</strong><br><span class="muted small">Chi apre questo link può entrare nel gruppo.</span></p>
      <div class="invite">
        <code>${esc(inviteUrl(group.invite_code))}</code>
        <button class="secondary" data-action="share">${navigator.share ? "Condividi" : "Copia"}</button>
      </div>
      <ul class="members">${members}</ul>
      <div class="actions">
        ${
          isOwner
            ? `<button class="link" data-action="rename">Rinomina</button>
               <button class="link" data-action="new-code">Nuovo link di invito</button>
               <button class="link danger" data-action="delete-group">Elimina gruppo</button>`
            : `<button class="link danger" data-action="leave">Esci dal gruppo</button>`
        }
      </div>
    </div>`;
}

// ---------- actions ----------

async function shareInvite() {
  const group = currentGroup();
  const url = inviteUrl(group.invite_code);
  if (navigator.share) {
    try {
      await navigator.share({ title: "Par🇮🇹le", text: `Sfidami su Par🇮🇹le nel gruppo "${group.name}"!`, url });
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copiato");
  } catch {
    modal({ title: "Link di invito", html: "<p>Copia il link e mandalo agli amici.</p>", input: { value: url, readonly: true }, ok: "Fatto", cancel: null });
  }
}

async function refreshGroup() {
  delete state.data[state.groupId];
  await route();
}

const actions = {
  reload: () => location.reload(),
  "login-again": () => {
    store("parle-login-email", null);
    renderLogin();
  },
  "resend-code": resendCode,
  join: joinPending,
  "skip-join": () => {
    clearJoin();
    navigate("./", true);
  },
  "cancel-create": () => navigate("./"),
  setting: (el) => changeSetting(el.dataset.setting, el.dataset.value),
  logout: async () => {
    await sb.auth.signOut();
    state.data = {};
    state.groups = [];
    state.groupId = null;
    state.profile = null;
    store("parle-groups", null);
    store("parle-group", null);
    store("parle-name", null);
  },
  "flip-results": () => {
    state.resultsFlipped = !state.resultsFlipped;
    store("parle-results-flipped", state.resultsFlipped ? "1" : null);
    renderGroup();
  },
  "results-col": (el) => {
    const key = el.dataset.key;
    const cols = { ...state.resultsCols, [key]: !state.resultsCols[key] };
    // Keep at least one of the two label columns.
    if (!cols.day && !cols.word) cols[key === "day" ? "word" : "day"] = true;
    state.resultsCols = cols;
    store("parle-results-cols", JSON.stringify(cols));
    renderGroup();
  },
  fold: (el) => {
    const id = el.dataset.id;
    state.folded.has(id) ? state.folded.delete(id) : state.folded.add(id);
    store("parle-folded", JSON.stringify([...state.folded]));
    renderGroup();
  },
  "chart-mode": (el) => {
    state.chartMode = el.dataset.value;
    renderGroup();
  },
  share: shareInvite,
  rename: async () => {
    const group = currentGroup();
    const name = (await modal({ title: "Rinomina il gruppo", input: { value: group.name, maxlength: 40 }, ok: "Salva" }))?.trim();
    if (!name || name === group.name) return;
    const { error } = await sb.from("groups").update({ name: name.slice(0, 40) }).eq("id", group.id);
    if (error) return toast(errorText(error), 3000);
    route();
  },
  "new-code": async () => {
    if (!(await modal({ title: "Nuovo link di invito", html: "<p>Il vecchio link smetterà di funzionare: chi non è ancora entrato dovrà ricevere quello nuovo.</p>", ok: "Crea nuovo link" }))) return;
    const { error } = await sb.rpc("new_invite_code", { p_group: state.groupId });
    if (error) return toast(errorText(error), 3000);
    await route();
    toast("Nuovo link creato");
  },
  remove: async (el) => {
    if (!(await modal({ title: "Rimuovere dal gruppo?", html: `<p><strong>${esc(el.dataset.name)}</strong> non vedrà più la classifica del gruppo. Potrà rientrare solo con un nuovo invito.</p>`, ok: "Rimuovi", danger: true }))) return;
    const { error } = await sb.from("group_members").delete().eq("group_id", state.groupId).eq("user_id", el.dataset.id);
    if (error) return toast(errorText(error), 3000);
    refreshGroup();
  },
  leave: async () => {
    if (!(await modal({ title: "Uscire dal gruppo?", html: `<p>Non vedrai più la classifica di <strong>${esc(currentGroup().name)}</strong>. Potrai rientrare solo con un nuovo invito.</p>`, ok: "Esci dal gruppo", danger: true }))) return;
    const { error } = await sb.from("group_members").delete().eq("group_id", state.groupId).eq("user_id", state.session.user.id);
    if (error) return toast(errorText(error), 3000);
    state.groupId = null;
    navigate("./", true);
  },
  "delete-group": async () => {
    const group = currentGroup();
    if (!(await modal({ title: "Eliminare il gruppo?", html: `<p>Il gruppo <strong>${esc(group.name)}</strong> sparirà per tutti i suoi membri. I risultati dei giocatori restano nei loro account.</p><p><strong>Non si può annullare.</strong></p>`, ok: "Elimina gruppo", danger: true }))) return;
    const { error } = await sb.from("groups").delete().eq("id", group.id);
    if (error) return toast(errorText(error), 3000);
    state.groupId = null;
    navigate("./", true);
  },
  "edit-name": () => {
    state.editingName = true;
    renderAccount();
    const input = $app.querySelector('form[data-form="rename-me"] input');
    input.focus();
    input.select();
  },
  "cancel-name": () => {
    state.editingName = false;
    renderAccount();
  },
  "delete-account": async () => {
    const ok = await modal({
      title: "Eliminare il tuo account?",
      danger: true,
      html: `<p class="warning">Questa operazione è <strong>definitiva</strong>: non si può annullare e i dati non si possono recuperare.</p>
        <p>Verranno cancellati per sempre:</p>
        <ul>
          <li>la tua email e il tuo nome</li>
          <li>tutti i tuoi risultati e le statistiche</li>
          <li>la tua presenza in tutti i gruppi</li>
        </ul>
        <p class="muted small">I gruppi che hai creato passano a chi è entrato per primo dopo di te; quelli in cui sei da solo vengono eliminati.</p>
        <p>Per confermare scrivi <strong>ELIMINA</strong>:</p>`,
      input: { placeholder: "ELIMINA", maxlength: 10 },
      requireText: "ELIMINA",
      ok: "Elimina per sempre",
    });
    if (!ok) return;
    const { error } = await sb.rpc("delete_my_account");
    if (error) return toast(errorText(error), 3000);
    ["parle-synced", "parle-group", "parle-groups", "parle-login-email", "parle-name"].forEach((k) => store(k, null));
    state.data = {};
    state.groups = [];
    state.groupId = null;
    state.profile = null;
    await sb.auth.signOut({ scope: "local" });
    toast("Account eliminato", 2500);
  },
};

const forms = { login: submitLogin, code: submitCode, name: submitName, "rename-me": submitNewName, create: submitCreate };

$app.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (el && !el.disabled) actions[el.dataset.action]?.(el);
});

$app.addEventListener("change", (e) => {
  if (e.target.matches("select.period")) {
    state.period = e.target.value === "all" ? "all" : Number(e.target.value);
    renderGroup();
  }
});

// Remember which players are open in "Distribuzione dei tentativi" ("toggle" does not bubble).
$app.addEventListener(
  "toggle",
  (e) => {
    const el = e.target;
    if (!el.matches?.("details.dist")) return;
    if (!state.distOpen) state.distOpen = new Set([...$app.querySelectorAll("details.dist[open]")].map((d) => d.dataset.player));
    el.open ? state.distOpen.add(el.dataset.player) : state.distOpen.delete(el.dataset.player);
  },
  true
);

$app.addEventListener("submit", (e) => {
  e.preventDefault();
  forms[e.target.dataset.form]?.(e.target);
});

init();
