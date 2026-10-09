import { sb, dayNumber, dayDate, points, syncToday } from "./db.js";

const $app = document.getElementById("app");
const $logout = document.getElementById("logout");

const MONTH_FMT = new Intl.DateTimeFormat("it", { month: "long", year: "numeric", timeZone: "UTC" });
const MONTH_NAME = new Intl.DateTimeFormat("it", { month: "long", timeZone: "UTC" });
const LINE_COLORS = ["#6aaa64", "#c9b458", "#3b82f6", "#e4572e", "#9b59b6", "#17a2b8", "#e83e8c", "#795548", "#20c997", "#6c757d"];

const state = {
  session: null,
  profile: null,
  groups: [],
  groupId: null,
  month: null, // months since year 0: year * 12 + month
  data: {}, // per group: { members, results }
  pendingJoin: null,
  pendingFrom: null, // id of the member who shared the invite link
  creating: false,
  chart: null,
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

function store(key, value) {
  try {
    value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value);
  } catch {}
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
  // Remove the login tokens and invite code from the address bar.
  if (location.hash.includes("access_token") || join) history.replaceState(null, "", location.pathname);
  route();
}

async function route() {
  $logout.hidden = !state.session;
  if (!state.session) return renderLogin(read("parle-login-email"));

  const { data: profile, error } = await sb.from("profiles").select("*").eq("id", state.session.user.id).maybeSingle();
  if (error) return renderError(error);
  state.profile = profile;
  if (!profile) return renderName();

  syncToday().then((saved) => {
    if (saved) {
      delete state.data[state.groupId];
      if (!state.pendingJoin && state.groups.length) loadGroup();
    }
  });

  if (state.pendingJoin) return renderJoin();
  await loadGroups();
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
    <h2>Accedi al tuo account</h2>
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

async function submitName(form) {
  const name = form.name.value.trim();
  if (!name) return;
  const row = { id: state.session.user.id, display_name: name };
  const { error } = state.profile
    ? await sb.from("profiles").update({ display_name: name }).eq("id", row.id)
    : await sb.from("profiles").insert(row);
  if (error) return showFormError(form, error);
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
    return loadGroups();
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
    return loadGroups();
  }
  state.groupId = gid;
  store("parle-group", gid);
  delete state.data[gid];
  loadGroups();
}

// ---------- groups ----------

async function loadGroups() {
  const { data, error } = await sb.from("groups").select("*").order("created_at");
  if (error) return renderError(error);
  state.groups = data;
  if (!state.groups.some((g) => g.id === state.groupId)) {
    const saved = read("parle-group");
    state.groupId = state.groups.some((g) => g.id === saved) ? saved : state.groups[0]?.id ?? null;
  }
  state.month = monthOfDate(new Date());
  if (!state.groupId) return renderNoGroups();
  loadGroup();
}

async function loadGroup() {
  const group = currentGroup();
  if (!group) return renderNoGroups();
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

function groupTabs() {
  const tabs = state.groups
    .map((g) => `<button data-action="group" data-id="${g.id}" aria-pressed="${!state.creating && g.id === state.groupId}">${esc(g.name)}</button>`)
    .join("");
  return `<div class="tabs">${tabs}<button data-action="new-group" aria-pressed="${state.creating}">+ Nuovo gruppo</button></div>`;
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
  $app.innerHTML = groupTabs() + body;
}

function renderNoGroups() {
  state.creating = false;
  if (state.chart) state.chart.destroy(), (state.chart = null);
  $app.innerHTML = `<h2>Ciao ${esc(state.profile.display_name)}!</h2>
    <p>Non sei ancora in nessun gruppo.</p>
    <div class="card">
      <p style="margin-top:0"><strong>Entrare nel gruppo di un amico</strong><br><span class="muted small">Apri il link di invito che ti ha mandato.</span></p>
      <p style="margin-bottom:0"><strong>Creare un gruppo tuo</strong><br><span class="muted small">Poi invita gli amici con un link.</span></p>
      <p style="margin-bottom:0"><button class="secondary" data-action="new-group">Crea un gruppo</button></p>
    </div>
    ${profileCard()}`;
}

async function submitCreate(form) {
  const name = form.name.value.trim();
  if (!name) return;
  const { data, error } = await sb.rpc("create_group", { p_name: name });
  if (error) return showFormError(form, error);
  state.creating = false;
  state.groupId = data.id;
  store("parle-group", data.id);
  await loadGroups();
  toast("Gruppo creato! Ora invita gli amici.", 2500);
}

// ---------- statistics ----------

function monthStats(data, month) {
  const { first, last } = monthRange(month);
  const today = dayNumber(new Date());
  const rows = new Map(
    data.members.map((m) => [m.id, { ...m, points: 0, played: 0, wins: 0, guesses: 0, dist: [0, 0, 0, 0, 0, 0, 0] }])
  );
  for (const r of data.results) {
    if (r.day < first || r.day > last) continue;
    const row = rows.get(r.user_id);
    if (!row) continue;
    row.points += points(r);
    row.played += 1;
    if (r.won) {
      row.wins += 1;
      row.guesses += r.num_guesses;
      row.dist[r.num_guesses - 1] += 1;
    } else {
      row.dist[6] += 1;
    }
  }
  const standings = [...rows.values()].sort(
    (a, b) =>
      b.points - a.points ||
      b.wins - a.wins ||
      (a.wins ? a.guesses / a.wins : 9) - (b.wins ? b.guesses / b.wins : 9) ||
      a.name.localeCompare(b.name)
  );
  // Same rank for players with the same points and wins.
  standings.forEach((s, i) => {
    const prev = standings[i - 1];
    s.rank = prev && prev.points === s.points && prev.wins === s.wins ? prev.rank : i + 1;
  });
  return { first, last, today, standings, finished: today > last };
}

function winnersOf(standings) {
  const top = standings[0];
  if (!top || top.points === 0) return [];
  return standings.filter((s) => s.rank === 1);
}

// ---------- group page ----------

function renderGroup() {
  const group = currentGroup();
  const data = state.data[group.id];
  const me = state.session.user.id;
  const firstMonth = monthOfDate(new Date(group.created_at));
  const thisMonth = monthOfDate(new Date());
  const stats = monthStats(data, state.month);
  const winners = winnersOf(stats.standings);

  let banner;
  if (stats.finished) {
    banner = winners.length
      ? `<div class="banner winner">🏆 ${winners.length > 1 ? "Vincitori" : "Vince"} ${esc(winners.map((w) => w.name).join(" e "))} con ${winners[0].points} punti</div>`
      : `<div class="banner">Nessun vincitore questo mese</div>`;
  } else {
    const left = stats.last - stats.today + 1;
    banner = winners.length
      ? `<div class="banner">In testa: <strong>${esc(winners.map((w) => w.name).join(", "))}</strong> · ${left === 1 ? "ultimo giorno" : `mancano ${left} giorni`}</div>`
      : `<div class="banner">Nessun punto ancora · mancano ${left} giorni</div>`;
  }

  const table = `<table>
      <thead><tr><th></th><th>Giocatore</th><th>Punti</th><th>Giocate</th><th>Vinte</th><th>Media</th></tr></thead>
      <tbody>${stats.standings
        .map(
          (s) => `<tr class="${s.id === me ? "me" : ""}">
            <td class="pos">${s.points ? (s.rank === 1 ? "🥇" : s.rank === 2 ? "🥈" : s.rank === 3 ? "🥉" : s.rank) : ""}</td>
            <td class="name">${esc(s.name)}</td>
            <td class="pts">${s.points}</td>
            <td>${s.played}</td>
            <td>${s.played ? Math.round((100 * s.wins) / s.played) + "%" : "-"}</td>
            <td>${s.wins ? (s.guesses / s.wins).toFixed(1) : "-"}</td>
          </tr>`
        )
        .join("")}</tbody>
    </table>
    <p class="muted small">Punti: parola indovinata al 1° tentativo 6, al 2° 5, ... al 6° 1. Non indovinata o non giocata 0. Media = tentativi medi per le parole indovinate.</p>`;

  const anyPlayed = stats.standings.some((s) => s.played);

  $app.innerHTML =
    groupTabs() +
    `<div class="month">
      <button data-action="month" data-step="-1" ${state.month <= firstMonth ? "disabled" : ""} aria-label="Mese precedente">‹</button>
      <strong>${monthLabel(state.month)}</strong>
      <button data-action="month" data-step="1" ${state.month >= thisMonth ? "disabled" : ""} aria-label="Mese successivo">›</button>
    </div>
    ${banner}
    <h2>Classifica</h2>
    ${table}
    ${state.month === thisMonth ? todaySection(data, stats) : ""}
    ${anyPlayed ? `<h2>Andamento dei punti</h2><div class="chart-box"><canvas id="chart"></canvas></div>` : ""}
    ${anyPlayed ? `<h2>Distribuzione dei tentativi</h2>${distributionSection(stats)}` : ""}
    ${hallOfFame(data, firstMonth, thisMonth)}
    ${manageSection(group, data)}
    ${profileCard()}`;

  if (anyPlayed) drawChart(stats);
}

function todaySection(data, stats) {
  const me = state.session.user.id;
  const todays = new Map(data.results.filter((r) => r.day === stats.today).map((r) => [r.user_id, r]));
  const iPlayed = todays.has(me);
  const items = data.members
    .map((m) => {
      const r = todays.get(m.id);
      let text;
      if (!r) text = `<span class="muted">non ancora</span>`;
      else if (!iPlayed && m.id !== me) text = "✓ fatto";
      else text = r.won ? `${r.num_guesses}/6 · +${points(r)}` : "X/6 · 0";
      return `<li><span>${esc(m.name)}</span><span>${text}</span></li>`;
    })
    .join("");
  return `<h2>Oggi</h2><ul class="today">${items}</ul>
    ${iPlayed ? "" : `<p class="muted small">Gioca la parola di oggi per vedere come è andata agli altri. <a href="../">Vai al gioco</a></p>`}`;
}

function distributionSection(stats) {
  return stats.standings
    .filter((s) => s.played)
    .map((s) => {
      const max = Math.max(...s.dist, 1);
      const best = s.dist.indexOf(Math.max(...s.dist));
      const rows = s.dist
        .map(
          (n, i) => `<div class="row"><span>${i < 6 ? i + 1 : "X"}</span>
            <div class="bar ${i === best && n ? "best" : ""}" style="width:${Math.max(8, (100 * n) / max)}%">${n}</div></div>`
        )
        .join("");
      return `<div class="dist"><div class="who">${esc(s.name)}</div>${rows}</div>`;
    })
    .join("");
}

function hallOfFame(data, firstMonth, thisMonth) {
  const titles = new Map();
  const lines = [];
  for (let m = thisMonth - 1; m >= firstMonth; m--) {
    const winners = winnersOf(monthStats(data, m).standings);
    winners.forEach((w) => titles.set(w.name, (titles.get(w.name) || 0) + 1));
    lines.push(
      `<li><strong>${monthLabel(m)}</strong>: ${winners.length ? `${esc(winners.map((w) => w.name).join(" e "))} (${winners[0].points} punti)` : `<span class="muted">nessuno</span>`}</li>`
    );
  }
  if (!lines.length) return "";
  const totals = [...titles.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${esc(name)} ${"🏆".repeat(Math.min(n, 5))}${n > 5 ? " ×" + n : ""}`)
    .join(" · ");
  return `<h2>Albo d'oro</h2>
    ${totals ? `<p>${totals}</p>` : ""}
    <ul class="hall">${lines.join("")}</ul>`;
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
  const players = stats.standings.filter((s) => s.played);
  const datasets = players.map((s) => {
    const byDay = new Map(data.results.filter((r) => r.user_id === s.id).map((r) => [r.day, points(r)]));
    let total = 0;
    const color = LINE_COLORS[data.members.findIndex((m) => m.id === s.id) % LINE_COLORS.length];
    return {
      label: s.name,
      data: days.map((d) => (total += byDay.get(d) || 0)),
      borderColor: color,
      backgroundColor: color,
      borderWidth: 2.5,
      pointRadius: 0,
      pointHoverRadius: 4,
      tension: 0.25,
    };
  });
  if (state.chart) state.chart.destroy();
  state.chart = new window.Chart(canvas, {
    type: "line",
    data: { labels: days.map((d) => dayDate(d).getUTCDate()), datasets },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "bottom", labels: { color: textColor, boxWidth: 12, boxHeight: 12 } },
        tooltip: { itemSort: (a, b) => b.parsed.y - a.parsed.y, callbacks: { title: (items) => `Giorno ${items[0].label}` } },
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
  return `<h2>Gruppo</h2>
    <div class="card">
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

function profileCard() {
  return `<h2>Il tuo profilo</h2>
    <div class="card profile">
      <span><strong>${esc(state.profile.display_name)}</strong><br><span class="muted small">${esc(state.session.user.email || "")}</span></span>
      <button class="link" data-action="edit-name">Cambia nome</button>
    </div>
    <p class="actions"><button class="link danger" data-action="delete-account">Elimina il mio account</button></p>`;
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
    prompt("Copia il link di invito:", url);
  }
}

async function refreshGroup() {
  delete state.data[state.groupId];
  await loadGroups();
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
    loadGroups();
  },
  group: (el) => {
    state.creating = false;
    state.groupId = el.dataset.id;
    store("parle-group", state.groupId);
    state.month = monthOfDate(new Date());
    loadGroup();
  },
  "new-group": () => {
    state.creating = true;
    if (state.groups.length) renderShell(createForm());
    else $app.innerHTML = `<h2>Ciao ${esc(state.profile.display_name)}!</h2>${createForm()}`;
    $app.querySelector("input").focus();
  },
  "cancel-create": () => {
    state.creating = false;
    state.groupId ? loadGroup() : renderNoGroups();
  },
  month: (el) => {
    state.month += Number(el.dataset.step);
    renderGroup();
  },
  share: shareInvite,
  rename: async () => {
    const group = currentGroup();
    const name = prompt("Nuovo nome del gruppo:", group.name)?.trim();
    if (!name || name === group.name) return;
    const { error } = await sb.from("groups").update({ name: name.slice(0, 40) }).eq("id", group.id);
    if (error) return toast(errorText(error), 3000);
    loadGroups();
  },
  "new-code": async () => {
    if (!confirm("Il vecchio link di invito smetterà di funzionare. Continuare?")) return;
    const { error } = await sb.rpc("new_invite_code", { p_group: state.groupId });
    if (error) return toast(errorText(error), 3000);
    await loadGroups();
    toast("Nuovo link creato");
  },
  remove: async (el) => {
    if (!confirm(`Rimuovere ${el.dataset.name} dal gruppo?`)) return;
    const { error } = await sb.from("group_members").delete().eq("group_id", state.groupId).eq("user_id", el.dataset.id);
    if (error) return toast(errorText(error), 3000);
    refreshGroup();
  },
  leave: async () => {
    if (!confirm(`Uscire dal gruppo "${currentGroup().name}"?`)) return;
    const { error } = await sb.from("group_members").delete().eq("group_id", state.groupId).eq("user_id", state.session.user.id);
    if (error) return toast(errorText(error), 3000);
    state.groupId = null;
    loadGroups();
  },
  "delete-group": async () => {
    const group = currentGroup();
    if (!confirm(`Eliminare il gruppo "${group.name}" per tutti? I risultati dei giocatori restano.`)) return;
    const { error } = await sb.from("groups").delete().eq("id", group.id);
    if (error) return toast(errorText(error), 3000);
    state.groupId = null;
    loadGroups();
  },
  "edit-name": () => {
    renderName();
    $app.querySelector("input").value = state.profile.display_name;
  },
  "delete-account": async () => {
    const ok = confirm(
      "Eliminare il tuo account?\n\n" +
        "Verranno cancellati per sempre la tua email, il tuo nome, i tuoi risultati e la tua presenza nei gruppi. " +
        "I gruppi che hai creato passano a chi è entrato per primo dopo di te; quelli dove sei da solo vengono eliminati.\n\n" +
        "Potrai sempre rientrare con la stessa email, ma ripartirai da zero."
    );
    if (!ok) return;
    const { error } = await sb.rpc("delete_my_account");
    if (error) return toast(errorText(error), 3000);
    ["parle-synced", "parle-group"].forEach((k) => store(k, null));
    state.data = {};
    state.groups = [];
    state.groupId = null;
    state.profile = null;
    await sb.auth.signOut({ scope: "local" });
    toast("Account eliminato", 2500);
  },
};

const forms = { login: submitLogin, code: submitCode, name: submitName, create: submitCreate };

$app.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (el && !el.disabled) actions[el.dataset.action]?.(el);
});

$app.addEventListener("submit", (e) => {
  e.preventDefault();
  forms[e.target.dataset.form]?.(e.target);
});

$logout.addEventListener("click", async () => {
  await sb.auth.signOut();
  state.data = {};
  state.groups = [];
});

init();
