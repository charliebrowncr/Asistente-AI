import {
  AuthError,
  acceptInvite,
  getUser,
  handleAuthCallback,
  login,
  logout,
  requestPasswordRecovery,
  updateUser,
  type User,
} from "@netlify/identity";

type Reservation = {
  id: number;
  externalId: string;
  codes: string[];
  source: string;
  status: string;
  guestName: string;
  guestEmail: string | null;
  houseName: string;
  villa: string;
  arrival: string;
  departure: string;
  nights: number;
  guests: number;
  currency: string;
  total: string | null;
};
type ImportRow = { id: number; fileName: string; reservationCount: number; importedBy: string | null; createdAt: string };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// All dates are handled as YYYY-MM-DD strings in Costa Rica time.
const TZ = "America/Costa_Rica";
const todayIso = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const addDays = (iso: string, n: number) => {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const fmt = (iso: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" }) =>
  new Date(iso + "T12:00:00Z").toLocaleDateString("es-CR", { ...opts, timeZone: "UTC" });

const SOURCE_COLORS: Record<string, string> = { airbnb: "--airbnb", "booking.com": "--booking", expedia: "--expedia", website: "--website" };
const sourceColor = (s: string) => `var(${SOURCE_COLORS[s.toLowerCase()] ?? "--other"})`;

const DAYS = 28;
let data: Reservation[] = [];
let gridStart = todayIso();
let tab = "arrivals";

// ---------- Auth ----------

type AuthMode = "login" | "recover" | "invite" | "reset";
let authMode: AuthMode = "login";
let inviteToken = "";

function showMsg(el: HTMLElement, text: string, ok = false) {
  el.innerHTML = text ? `<div class="msg ${ok ? "ok" : "err"}">${esc(text)}</div>` : "";
}

function setAuthMode(mode: AuthMode) {
  authMode = mode;
  const copy = {
    login: ["Panel de ocupación", "Ingresa con tu cuenta del equipo Canavida.", "Entrar"],
    recover: ["Recuperar contraseña", "Te enviaremos un enlace para crear una nueva.", "Enviar enlace"],
    invite: ["Bienvenido al equipo", "Crea tu contraseña para activar la cuenta.", "Crear contraseña"],
    reset: ["Nueva contraseña", "Escribe tu nueva contraseña.", "Guardar"],
  }[mode];
  $("auth-title").textContent = copy[0];
  $("auth-sub").textContent = copy[1];
  $("auth-submit").textContent = copy[2];
  $("email-row").hidden = mode === "invite" || mode === "reset";
  $("password-row").hidden = mode === "recover";
  $<HTMLInputElement>("email").required = !$("email-row").hidden;
  $<HTMLInputElement>("password").required = !$("password-row").hidden;
  $<HTMLInputElement>("password").autocomplete = mode === "login" ? "current-password" : "new-password";
  $("forgot").textContent = mode === "login" ? "¿Olvidaste tu contraseña?" : "Volver a iniciar sesión";
  showMsg($("auth-msg"), "");
}

function authErrorText(e: unknown) {
  if (e instanceof AuthError) {
    if (e.status === 401) return "Correo o contraseña incorrectos.";
    if (e.status === 422) return "Revisa el correo y la contraseña (mínimo 8 caracteres).";
    return e.message;
  }
  return "No se pudo conectar. Intenta de nuevo.";
}

$("auth-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const btn = $<HTMLButtonElement>("auth-submit");
  const email = $<HTMLInputElement>("email").value.trim();
  const password = $<HTMLInputElement>("password").value;
  btn.disabled = true;
  try {
    if (authMode === "login") return enter(await login(email, password));
    if (authMode === "recover") {
      await requestPasswordRecovery(email);
      return showMsg($("auth-msg"), "Revisa tu correo para crear una nueva contraseña.", true);
    }
    if (authMode === "invite") return enter(await acceptInvite(inviteToken, password));
    if (authMode === "reset") return enter(await updateUser({ password }));
  } catch (e) {
    showMsg($("auth-msg"), authErrorText(e));
  } finally {
    btn.disabled = false;
  }
});
$("forgot").addEventListener("click", () => setAuthMode(authMode === "login" ? "recover" : "login"));
$("logout").addEventListener("click", async () => {
  await logout();
  $("app").hidden = true;
  $("auth").hidden = false;
  setAuthMode("login");
});

function enter(user: User) {
  $("auth").hidden = true;
  $("app").hidden = false;
  $("who").textContent = user.email ?? "";
  load();
}

// ---------- Data ----------

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin", ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Error del servidor (" + res.status + ")");
  return body as T;
}

async function load() {
  const t = todayIso();
  try {
    const res = await api<{ reservations: Reservation[]; imports: ImportRow[] }>(
      `/api/admin/reservations?from=${addDays(t, -90)}&to=${addDays(t, 400)}`,
    );
    data = res.reservations;
    renderImports(res.imports);
    render();
  } catch (e) {
    $("stats").innerHTML = `<div class="msg err">${esc((e as Error).message)}</div>`;
  }
}

// ---------- Import ----------

const drop = $("drop");
const fileInput = $<HTMLInputElement>("file");
fileInput.addEventListener("change", () => fileInput.files?.[0] && upload(fileInput.files[0]));
$("import-btn").addEventListener("click", () => {
  $("import-panel").scrollIntoView({ behavior: "smooth", block: "center" });
  fileInput.click();
});
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  const f = e.dataTransfer?.files[0];
  if (f) upload(f);
});

async function upload(file: File) {
  const msg = $("import-msg");
  const isPdf = file.name.toLowerCase().endsWith(".pdf");
  msg.innerHTML = `<div class="msg ok">Importando ${esc(file.name)}${isPdf ? " · leyendo el PDF, puede tardar hasta un minuto" : ""}…</div>`;
  const form = new FormData();
  form.append("file", file);
  if ($<HTMLInputElement>("sync").checked) form.append("sync", "1");
  try {
    const r = await api<{ total: number; created: number; updated: number; cancelled: number; removed: number; withoutCode: string[] }>(
      "/api/admin/import",
      { method: "POST", body: form },
    );
    let text = `${r.total} reservas importadas: ${r.created} nuevas, ${r.updated} actualizadas` +
      (r.cancelled ? `, ${r.cancelled} canceladas` : "") + "." +
      (r.removed ? ` ${r.removed} reservas que ya no estaban en el archivo se marcaron como canceladas.` : "");
    if (r.withoutCode.length) text += ` Sin número de confirmación: ${r.withoutCode.join(", ")}.`;
    showMsg(msg, text, true);
    load();
  } catch (e) {
    showMsg(msg, (e as Error).message);
  } finally {
    fileInput.value = "";
  }
}

function renderImports(list: ImportRow[]) {
  $("imports").innerHTML = list.length
    ? "Últimas importaciones: " +
      list.map((i) => `${esc(i.fileName)} (${i.reservationCount}) · ${new Date(i.createdAt).toLocaleString("es-CR")}`).join(" — ")
    : "Todavía no hay importaciones.";
}

// ---------- Rendering ----------

const active = (r: Reservation) => r.status !== "cancelled";
const inHouseOn = (r: Reservation, day: string) => active(r) && r.arrival <= day && r.departure > day;

function villas() {
  return [...new Set(data.map((r) => r.villa || r.houseName))].sort((a, b) => a.localeCompare(b, "es"));
}

function render() {
  renderStats();
  renderGrid();
  renderList();
}

function renderStats() {
  const t = todayIso();
  const units = villas().length;
  const occupied = data.filter((r) => inHouseOn(r, t)).length;
  const arrivals = data.filter((r) => active(r) && r.arrival === t).length;
  const departures = data.filter((r) => active(r) && r.departure === t).length;
  // Occupied unit-nights over the next 30 days.
  let nights = 0;
  for (let i = 0; i < 30; i++) {
    const d = addDays(t, i);
    nights += data.filter((r) => inHouseOn(r, d)).length;
  }
  const pct = units ? Math.round((nights / (units * 30)) * 100) : 0;
  const guestsIn = data.filter((r) => inHouseOn(r, t)).reduce((s, r) => s + r.guests, 0);
  $("stats").innerHTML = [
    ["Ocupadas hoy", `${occupied} <small>/ ${units} villas</small>`],
    ["Llegadas hoy", arrivals],
    ["Salidas hoy", departures],
    ["Huéspedes en casa", guestsIn],
    ["Ocupación 30 días", `${pct}<small>%</small>`],
  ].map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");
}

function renderGrid() {
  const t = todayIso();
  const days = Array.from({ length: DAYS }, (_, i) => addDays(gridStart, i));
  const end = addDays(gridStart, DAYS);
  const head =
    `<thead><tr><th class="villa">Villa</th>` +
    days.map((d) => {
      const wd = new Date(d + "T12:00:00Z").getUTCDay();
      const cls = d === t ? "today" : wd === 0 || wd === 6 ? "wk" : "";
      return `<th class="${cls}">${fmt(d, { weekday: "narrow" })}<br>${+d.slice(8)}</th>`;
    }).join("") +
    `</tr></thead>`;

  const rows = villas().map((v) => {
    const stays = data
      .filter((r) => (r.villa || r.houseName) === v && r.arrival < end && r.departure > gridStart)
      .sort((a, b) => Number(active(b)) - Number(active(a)) || a.arrival.localeCompare(b.arrival));
    let cells = "";
    for (let i = 0; i < DAYS; ) {
      const d = days[i];
      const r = stays.find((s) => s.arrival <= d && s.departure > d && (active(s) || !stays.some((o) => active(o) && inHouseOn(o, d))));
      if (!r) { cells += "<td></td>"; i++; continue; }
      const span = Math.min(DAYS - i, Math.round((Date.parse(r.departure) - Date.parse(d)) / 86400000));
      const title = `${r.guestName} · ${fmt(r.arrival)} → ${fmt(r.departure)} · ${r.source} · ${r.codes.join(", ")}`;
      cells += `<td colspan="${span}"><div class="bar ${active(r) ? "" : "cancelled"}" style="background:${sourceColor(r.source)}" title="${esc(title)}">${esc(r.guestName)}</div></td>`;
      i += Math.max(1, span);
    }
    return `<tr><th class="villa">${esc(v)}</th>${cells}</tr>`;
  });
  $("occ").innerHTML = head + `<tbody>${rows.join("") || `<tr><td class="empty" colspan="${DAYS + 1}">Importa un reporte para ver la ocupación.</td></tr>`}</tbody>`;
  $("legend").innerHTML = ["Airbnb", "Booking.com", "Expedia", "Website", "Otro"]
    .map((s) => `<span><i style="background:${sourceColor(s)}"></i>${s}</span>`).join("");
}

function renderList() {
  const t = todayIso();
  const q = $<HTMLInputElement>("search").value.trim().toLowerCase();
  let list = data;
  if (tab === "arrivals") list = data.filter((r) => r.arrival >= t && r.arrival < addDays(t, 30));
  if (tab === "inhouse") list = data.filter((r) => inHouseOn(r, t));
  if (tab === "departures") list = [...data].filter((r) => active(r) && r.departure >= t && r.departure < addDays(t, 14)).sort((a, b) => a.departure.localeCompare(b.departure));
  if (q) {
    list = list.filter((r) => [r.guestName, r.villa, r.houseName, r.source, ...r.codes].join(" ").toLowerCase().includes(q));
  }
  if (!list.length) {
    $("list").innerHTML = `<div class="empty">No hay reservas para mostrar.</div>`;
    return;
  }
  $("list").innerHTML =
    `<table class="list"><thead><tr><th>Huésped</th><th>Villa</th><th>Llegada</th><th>Salida</th><th>Pers.</th><th>Canal</th><th>Confirmación</th><th></th></tr></thead><tbody>` +
    list.map((r) => `<tr class="${active(r) ? "" : "cancelled"}">
      <td><strong>${esc(r.guestName)}</strong>${active(r) ? "" : " · cancelada"}</td>
      <td>${esc(r.villa)}</td>
      <td>${fmt(r.arrival)}</td>
      <td>${fmt(r.departure)} <span style="color:var(--muted)">· ${r.nights} n</span></td>
      <td>${r.guests || "—"}</td>
      <td><span class="pill" style="background:${sourceColor(r.source)}">${esc(r.source || "—")}</span></td>
      <td>${r.codes.map((c) => `<span class="code">${esc(c)}</span>`).join("") || "—"}</td>
      <td>${r.codes.length && active(r) ? `<button class="btn ghost small" data-copy="${esc(r.codes[0])}">Copiar enlace</button>` : ""}</td>
    </tr>`).join("") +
    `</tbody></table>`;
}

$("list").addEventListener("click", async (e) => {
  const code = (e.target as HTMLElement).closest<HTMLElement>("[data-copy]")?.dataset.copy;
  if (!code) return;
  await navigator.clipboard.writeText(`${location.origin}/?c=${encodeURIComponent(code)}`);
  toast("Enlace personalizado copiado · envíalo al huésped");
});
$("tabs").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]");
  if (!b) return;
  tab = b.dataset.tab!;
  document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("on", x === b));
  renderList();
});
$("search").addEventListener("input", renderList);
$("prev").addEventListener("click", () => { gridStart = addDays(gridStart, -14); renderGrid(); });
$("next").addEventListener("click", () => { gridStart = addDays(gridStart, 14); renderGrid(); });
$("today").addEventListener("click", () => { gridStart = todayIso(); renderGrid(); });

function toast(text: string) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2400);
}

// ---------- Boot ----------

(async () => {
  try {
    const cb = await handleAuthCallback();
    if (cb?.type === "invite" && cb.token) {
      inviteToken = cb.token;
      setAuthMode("invite");
      $("auth").hidden = false;
      return;
    }
    if (cb?.type === "recovery") {
      setAuthMode("reset");
      $("auth").hidden = false;
      return;
    }
  } catch (e) {
    showMsg($("auth-msg"), authErrorText(e));
  }
  const user = await getUser();
  if (user) enter(user);
  else {
    setAuthMode("login");
    $("auth").hidden = false;
  }
})();
