if (!window.L) {
  document.body.innerHTML = "<pre>Leaflet no se ha cargado. Revisa que /vendor/leaflet/leaflet.js exista.</pre>";
  throw new Error("Leaflet failed to load");
}

const state = {
  meta: null,
  silviaMeta: null,
  silviaAllCenters: [],
  transit: null,
  centers: [],
  selected: null,
  home: null,
  markers: new Map(),
  homeMarker: null,
  radiusCircle: null,
  routeCache: new Map(),
  pendingRoutes: new Map(),
  selectedRoute: null,
  shortlist: null,
  plazaIndex: new Map(),
  activeWorkspace: "explore",
  draggedPlazaId: null,
  dialogPlazaId: null,
  boardRouteLoading: false,
};

const SHORTLIST_STORAGE_KEY = "silvia-shortlist-v1";
const ROUTE_STORAGE_KEY = "silvia-driving-times-v1";
const SHORTLIST_BACKUP_FORMAT = "silvia-plazas-shortlist";
const SHORTLIST_BACKUP_VERSION = 1;
const shortlistColumns = [
  { id: "good", label: "Preferidas" },
  { id: "maybe", label: "Con dudas" },
  { id: "no", label: "Descartadas" },
];

const els = {};
const filterIds = [
  "view_mode",
  "q",
  "th_id",
  "municipio_id",
  "localidad_id",
  "level_id",
  "teacher_body",
  "specialty_code",
  "vacancy_column",
  "only_available",
  "radius_km",
];

const silviaFilterIds = [
  "silvia_subject_scope",
  "silvia_status",
  "silvia_jornada",
  "silvia_vacancy_status",
  "silvia_profile",
  "silvia_english",
  "silvia_stage",
  "silvia_review",
  "silvia_transit_max",
  "silvia_only_listed",
];

const practiceLabels = {
  yes: "Apta",
  possible: "Posible",
  review: "Revisar",
  no: "No apta",
};

const stageLabels = {
  fp: "FP",
  eso_bach: "ESO/Bach",
  epa: "EPA",
  mixed: "Mixto",
  unknown: "Sin tipo",
};

const scheduleLabels = {
  morning_only: "Mañana",
  afternoon_only: "Tarde",
  morning_and_afternoon: "Mañana/tarde",
  night: "Nocturno",
  unknown: "Horario sin dato",
};

const vacancyColumns = [
  { id: "pl1_sin_vencer_libres", short: "PL1 sin vencer" },
  { id: "pl1_hasta_2013_libres", short: "PL1 hasta 2013" },
  { id: "pl1_vencido_libres", short: "PL1 vencido" },
  { id: "pl2_hasta_2013_libres", short: "PL2 hasta 2013" },
  { id: "pl2_vencido_libres", short: "PL2 vencido" },
  { id: "total_libres", short: "Total" },
];

const comboConfigs = {
  th_id: { inputId: "th_id_combo", listId: "th_id_options" },
  municipio_id: { inputId: "municipio_id_combo", listId: "municipio_id_options" },
  localidad_id: { inputId: "localidad_id_combo", listId: "localidad_id_options" },
  level_id: { inputId: "level_id_combo", listId: "level_id_options" },
  teacher_body: { inputId: "teacher_body_combo", listId: "teacher_body_options" },
  specialty_code: { inputId: "specialty_code_combo", listId: "specialty_code_options" },
};

const map = L.map("map", { zoomControl: true }).setView([43.05, -2.45], 8);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

const markerLayer = L.layerGroup().addTo(map);
const staticCache = {};

function option(label, value = "") {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = label;
  return opt;
}

function fillSelect(select, items, labelFn, valueFn, emptyLabel = "Todos") {
  select.replaceChildren(option(emptyLabel));
  for (const item of items) {
    select.appendChild(option(labelFn(item), valueFn(item)));
  }
  syncComboOptions(select.id);
}

function normalizeSearchText(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function debounce(fn, wait = 250) {
  let timer = null;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
}

function emptyShortlist() {
  return {
    version: 1,
    columns: { good: [], maybe: [], no: [] },
    items: {},
  };
}

function normalizeShortlist(source, strict = false) {
  if (strict && (!source || typeof source !== "object" || Array.isArray(source))) {
    throw new Error("La copia no contiene una lista válida");
  }
  if (strict && (!source.columns || typeof source.columns !== "object" || Array.isArray(source.columns))) {
    throw new Error("Faltan las columnas de la lista");
  }
  if (strict && (!source.items || typeof source.items !== "object" || Array.isArray(source.items))) {
    throw new Error("Faltan los nombres y descripciones");
  }

  const clean = emptyShortlist();
  const seen = new Set();
  for (const column of shortlistColumns) {
    const rawIds = source?.columns?.[column.id];
    if (strict && !Array.isArray(rawIds)) throw new Error(`Falta la columna ${column.label}`);
    const ids = Array.isArray(rawIds) ? rawIds : [];
    if (strict && ids.length > 1000) throw new Error("La copia contiene demasiadas plazas");
    for (const rawId of ids) {
      const id = String(rawId || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      clean.columns[column.id].push(id);
    }
  }
  for (const id of seen) {
    const item = source?.items?.[id] || {};
    clean.items[id] = {
      alias: String(item.alias || "").slice(0, 80),
      note: String(item.note || "").slice(0, 500),
    };
  }
  return clean;
}

function loadShortlist() {
  let parsed = null;
  try {
    parsed = JSON.parse(localStorage.getItem(SHORTLIST_STORAGE_KEY) || "null");
  } catch {
    parsed = null;
  }
  state.shortlist = normalizeShortlist(parsed, false);
}

function loadRouteCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ROUTE_STORAGE_KEY) || "{}");
    for (const [key, value] of Object.entries(parsed || {})) {
      if (value && typeof value === "object") state.routeCache.set(key, value);
    }
  } catch {
    state.routeCache.clear();
  }
}

function saveRouteCache() {
  try {
    localStorage.setItem(ROUTE_STORAGE_KEY, JSON.stringify(Object.fromEntries(state.routeCache)));
  } catch {
    // The in-memory cache still works when browser storage is unavailable.
  }
}

function saveShortlist() {
  try {
    localStorage.setItem(SHORTLIST_STORAGE_KEY, JSON.stringify(state.shortlist));
  } catch {
    showToast("No se pudo guardar la lista en este navegador");
  }
  updateShortlistCount();
}

function shortlistCount() {
  return shortlistColumns.reduce((sum, column) => sum + state.shortlist.columns[column.id].length, 0);
}

function shortlistColumnFor(plazaId) {
  const id = String(plazaId);
  return shortlistColumns.find((column) => state.shortlist.columns[column.id].includes(id))?.id || "";
}

function isPlazaListed(plazaId) {
  return Boolean(shortlistColumnFor(plazaId));
}

function shortlistItem(plazaId) {
  return state.shortlist.items[String(plazaId)] || { alias: "", note: "" };
}

function shortlistColumnLabel(columnId) {
  return shortlistColumns.find((column) => column.id === columnId)?.label || "Fuera de la lista";
}

function removeFromShortlistColumns(plazaId) {
  const id = String(plazaId);
  for (const column of shortlistColumns) {
    state.shortlist.columns[column.id] = state.shortlist.columns[column.id].filter((itemId) => itemId !== id);
  }
}

function setShortlistColumn(plazaId, columnId, targetIndex = null) {
  const id = String(plazaId);
  removeFromShortlistColumns(id);
  if (!shortlistColumns.some((column) => column.id === columnId)) {
    delete state.shortlist.items[id];
    return;
  }
  if (!state.shortlist.items[id]) state.shortlist.items[id] = { alias: "", note: "" };
  const target = state.shortlist.columns[columnId];
  const index = targetIndex === null ? target.length : Math.max(0, Math.min(Number(targetIndex), target.length));
  target.splice(index, 0, id);
}

function moveShortlistItem(plazaId, columnId, targetIndex) {
  const id = String(plazaId);
  const sourceColumn = shortlistColumnFor(id);
  let adjustedIndex = targetIndex;
  if (sourceColumn === columnId) {
    const sourceIndex = state.shortlist.columns[columnId].indexOf(id);
    if (sourceIndex >= 0 && sourceIndex < targetIndex) adjustedIndex -= 1;
  }
  setShortlistColumn(id, columnId, adjustedIndex);
  shortlistChanged();
}

function updateShortlistCount() {
  const count = shortlistCount();
  if (els.shortlistCount) els.shortlistCount.textContent = count;
  if (els.boardSummary) els.boardSummary.textContent = `${count} ${count === 1 ? "plaza" : "plazas"}`;
}

function showToast(message, duration = 1800) {
  if (!els.toast) return;
  window.clearTimeout(showToast.timer);
  els.toast.textContent = message;
  els.toast.classList.add("visible");
  showToast.timer = window.setTimeout(() => els.toast.classList.remove("visible"), duration);
}

function shortlistChanged(message = "") {
  saveShortlist();
  renderBoard();
  if (state.selected && state.lastData?.view_mode === "silvia") renderSelected(state.selected);
  if (els.silvia_only_listed?.checked) loadCenters();
  if (message) showToast(message);
}

function shortlistOptions(selectedColumn, includeEmpty = true) {
  const options = [];
  if (includeEmpty) options.push(`<option value=""${selectedColumn ? "" : " selected"}>Fuera de la lista</option>`);
  for (const column of shortlistColumns) {
    options.push(
      `<option value="${column.id}"${selectedColumn === column.id ? " selected" : ""}>${column.label}</option>`
    );
  }
  return options.join("");
}

function syncComboOptions(selectId) {
  const config = comboConfigs[selectId];
  if (!config || !els[config.listId]) return;
  const select = els[selectId];
  const datalist = els[config.listId];
  datalist.replaceChildren();
  for (const opt of select.options) {
    if (!opt.value) continue;
    const item = document.createElement("option");
    item.value = opt.textContent;
    item.dataset.value = opt.value;
    datalist.appendChild(item);
  }
  syncComboInput(selectId);
}

function syncComboInput(selectId) {
  const config = comboConfigs[selectId];
  if (!config || !els[config.inputId]) return;
  const select = els[selectId];
  const selected = select.options[select.selectedIndex];
  els[config.inputId].value = selected && select.value ? selected.textContent : "";
}

function applyComboValue(selectId) {
  const config = comboConfigs[selectId];
  const input = els[config.inputId];
  const select = els[selectId];
  const typed = normalizeSearchText(input.value);
  if (!typed) {
    select.value = "";
    syncComboInput(selectId);
    return true;
  }

  for (const opt of select.options) {
    if (!opt.value) continue;
    if (normalizeSearchText(opt.textContent) === typed) {
      select.value = opt.value;
      applyParentComboValues(selectId);
      syncComboInput(selectId);
      return true;
    }
  }
  return false;
}

function selectFirstComboMatch(selectId) {
  const config = comboConfigs[selectId];
  const input = els[config.inputId];
  const select = els[selectId];
  const typed = normalizeSearchText(input.value);
  if (!typed) return applyComboValue(selectId);

  for (const opt of select.options) {
    if (!opt.value) continue;
    if (normalizeSearchText(opt.textContent).includes(typed)) {
      select.value = opt.value;
      applyParentComboValues(selectId);
      syncComboInput(selectId);
      return true;
    }
  }
  return false;
}

function applyParentComboValues(selectId) {
  if (selectId === "municipio_id" && els.municipio_id.value) {
    const [th] = els.municipio_id.value.split("|");
    els.th_id.value = th;
    syncComboInput("th_id");
  }
  if (selectId === "localidad_id" && els.localidad_id.value) {
    const [th, municipio] = els.localidad_id.value.split("|");
    els.th_id.value = th;
    els.municipio_id.value = `${th}|${municipio}`;
    syncComboInput("th_id");
    syncComboInput("municipio_id");
  }
}

function paramsFromFilters() {
  const params = new URLSearchParams();
  for (const id of [...filterIds, ...silviaFilterIds]) {
    const el = els[id];
    if (!el) continue;
    if (id === "th_id" || id === "municipio_id" || id === "localidad_id") continue;
    if (el.type === "checkbox") {
      params.set(id, el.checked ? "1" : "0");
    } else if (el.value) {
      params.set(id, el.value);
    }
  }
  if (els.localidad_id.value) {
    const [th, municipio, localidad] = els.localidad_id.value.split("|");
    params.set("th_id", th);
    params.set("municipio_id", municipio);
    params.set("localidad_id", localidad);
  } else if (els.municipio_id.value) {
    const [th, municipio] = els.municipio_id.value.split("|");
    params.set("th_id", th);
    params.set("municipio_id", municipio);
  } else if (els.th_id.value) {
    params.set("th_id", els.th_id.value);
  }
  if (state.home) {
    params.set("home_lat", state.home.lat);
    params.set("home_lon", state.home.lon);
  }
  return params;
}

async function api(path) {
  try {
    const response = await fetch(path);
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  } catch (error) {
    return staticApi(path, error);
  }
}

async function staticJson(path) {
  if (!staticCache[path]) {
    const response = await fetch(path);
    if (!response.ok) throw new Error(await response.text());
    staticCache[path] = await response.json();
  }
  return staticCache[path];
}

async function staticApi(path, originalError) {
  const url = new URL(path, window.location.href);
  if (url.pathname === "/api/meta") {
    return staticJson("data/meta.json");
  }
  if (url.pathname === "/api/centers") {
    return staticQueryCenters(url.searchParams);
  }
  if (url.pathname === "/api/geocode") {
    return geocodeAddressStatic(url.searchParams.get("q") || "");
  }
  if (url.pathname === "/api/route") {
    return drivingRouteStatic(url.searchParams);
  }
  throw originalError;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const radius = 6371.0088;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(deltaPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function staticQueryCenters(params) {
  const allCenters = await staticJson("data/centers.json");
  const viewMode = params.get("view_mode") || "vacancies";
  const vacancyColumn = params.get("vacancy_column") || "total_libres";
  const onlyAvailable = viewMode === "vacancies" && (params.get("only_available") || "1") === "1";
  const q = normalizeSearchText(params.get("q") || "");
  const exact = {
    th_id: params.get("th_id") || "",
    municipio_id: params.get("municipio_id") || "",
    localidad_id: params.get("localidad_id") || "",
    level_id: params.get("level_id") || "",
    teacher_body: params.get("teacher_body") || "",
    specialty_code: params.get("specialty_code") || "",
  };
  const hasHome = params.get("home_lat") && params.get("home_lon");
  const homeLat = hasHome ? Number(params.get("home_lat")) : null;
  const homeLon = hasHome ? Number(params.get("home_lon")) : null;
  const radiusKm = hasHome && params.get("radius_km") ? Number(params.get("radius_km")) : null;

  const centers = [];
  for (const center of allCenters) {
    if (exact.th_id && center.th_id !== exact.th_id) continue;
    if (exact.municipio_id && center.municipio_id !== exact.municipio_id) continue;
    if (exact.localidad_id && center.localidad_id !== exact.localidad_id) continue;

    let distance = null;
    if (hasHome) {
      distance = haversineKm(homeLat, homeLon, Number(center.lat), Number(center.lon));
      if (radiusKm !== null && distance > radiusKm) continue;
    }

    const vacancies = center.vacancies.filter((vacancy) => {
      if (exact.level_id && vacancy.level_id !== exact.level_id) return false;
      if (exact.teacher_body && vacancy.teacher_body !== exact.teacher_body) return false;
      if (exact.specialty_code && vacancy.specialty_code !== exact.specialty_code) return false;
      if (onlyAvailable && Number(vacancy[vacancyColumn]) <= 0) return false;
      if (!q) return true;
      return [
        center.centro_name,
        center.centro_id,
        center.centro_codigo,
        center.municipio_name,
        center.localidad_name,
        vacancy.specialty_name,
        vacancy.specialty_code,
      ].some((value) => normalizeSearchText(value).includes(q));
    });

    const transferSpecialty = exact.specialty_code ? String(Number(exact.specialty_code)) : "";
    const transfers = (center.transfers || []).filter((transfer) => {
      if (transferSpecialty && String(Number(transfer.awarded_specialty_code)) !== transferSpecialty) return false;
      if (!q) return true;
      return [
        center.centro_name,
        center.centro_codigo,
        center.municipio_name,
        center.localidad_name,
        transfer.awarded_body,
        transfer.awarded_specialty_code,
      ].some((value) => normalizeSearchText(value).includes(q));
    });
    if (viewMode === "vacancies" && !vacancies.length) continue;
    if (viewMode === "transfers" && !transfers.length) continue;

    const selectedTotal = vacancies.reduce((sum, vacancy) => sum + Number(vacancy[vacancyColumn]), 0);
    const transferTotal = transfers.reduce((sum, transfer) => sum + Number(transfer.adjudications), 0);
    centers.push({
      ...center,
      distance_km: distance,
      selected_total: viewMode === "transfers" ? transferTotal : selectedTotal,
      transfer_total: transferTotal,
      vacancies,
      transfers,
    });
  }

  centers.sort((a, b) => {
    const distanceA = a.distance_km ?? 999999;
    const distanceB = b.distance_km ?? 999999;
    return distanceA - distanceB || b.selected_total - a.selected_total || a.centro_name.localeCompare(b.centro_name);
  });
  for (const center of centers) {
    center.vacancies.sort((a, b) => Number(b[vacancyColumn]) - Number(a[vacancyColumn]) || a.specialty_name.localeCompare(b.specialty_name));
  }
  const meta = await staticJson("data/meta.json");
  const vacancyLabel = meta.vacancy_columns.find((column) => column.id === vacancyColumn)?.name || "Total libres";
  return {
    view_mode: viewMode,
    vacancy_column: vacancyColumn,
    vacancy_label: vacancyLabel,
    center_count: centers.length,
    vacancy_row_count: centers.reduce((sum, center) => sum + center.vacancies.length, 0),
    transfer_row_count: centers.reduce((sum, center) => sum + (center.transfers || []).length, 0),
    total_selected: centers.reduce((sum, center) => sum + center.selected_total, 0),
    centers,
  };
}

async function geocodeAddressStatic(query) {
  if (!query) return { results: [] };
  const encoded = new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: "5",
    countrycodes: "es",
    addressdetails: "1",
  });
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${encoded.toString()}`);
  const raw = await response.json();
  return {
    results: raw.map((item) => ({
      lat: Number(item.lat),
      lon: Number(item.lon),
      display_name: item.display_name || "",
    })),
  };
}

async function drivingRouteStatic(params) {
  const fromLat = params.get("from_lat");
  const fromLon = params.get("from_lon");
  const toLat = params.get("to_lat");
  const toLon = params.get("to_lon");
  if (!fromLat || !fromLon || !toLat || !toLon) return { status: "missing_parameters" };
  const response = await fetch(
    `https://router.project-osrm.org/route/v1/driving/${fromLon},${fromLat};${toLon},${toLat}?overview=false&alternatives=false&steps=false`
  );
  const payload = await response.json();
  if (!payload.routes?.length) return { status: payload.code || "not_found" };
  const route = payload.routes[0];
  return {
    status: "ok",
    duration_seconds: Math.round(route.duration),
    distance_km: Math.round((route.distance / 1000) * 10) / 10,
    provider: "OSRM",
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isSilviaView() {
  return els.view_mode?.value === "silvia";
}

function subjectScopeMatches(plaza, scope) {
  if (!scope || scope === "all") return true;
  if (scope === "eligible") return ["237", "1910", "1585", "1960"].includes(plaza.subject_code);
  return plaza.subject_code === scope;
}

function plazaHasReviewFlags(plaza) {
  return Boolean(
    (plaza.review_reasons || []).length ||
      (plaza.obs_flags || []).length ||
      (plaza.llm_classification?.flags || []).length ||
      plaza.practice_status === "review" ||
      plaza.practice_status === "possible"
  );
}

function practiceStatus(plaza) {
  return plaza.practice_status || plaza.llm_classification?.valid_for_practices || "review";
}

function stageType(plaza) {
  return plaza.stage_type || plaza.llm_classification?.stage_type || "unknown";
}

function scheduleType(plaza) {
  return plaza.schedule_type || plaza.llm_classification?.schedule_type || "unknown";
}

function displayNumber(value, suffix = "") {
  if (value === null || value === undefined || value === "") return "Sin dato";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return escapeHtml(value);
  const rounded = Math.round(numeric * 10) / 10;
  return `${rounded.toLocaleString("es-ES", { maximumFractionDigits: 1 })}${suffix}`;
}

function joinOrEmpty(items) {
  return (items || []).filter(Boolean).join("; ");
}

function centerKey(center) {
  return `${center.centro_id}|${center.centro_codigo}`;
}

function indexSilviaCenters(centers) {
  state.silviaAllCenters = centers;
  state.plazaIndex.clear();
  for (const center of centers) {
    for (const plaza of center.plazas || []) {
      state.plazaIndex.set(String(plaza.id), { center, plaza });
    }
  }
}

function transitOrigin() {
  const origin = state.transit?.metadata?.origin;
  if (!origin) return null;
  const lat = Number(origin.lat);
  const lon = Number(origin.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon, label: origin.label || "Casa" } : null;
}

function drivingOrigin() {
  return state.home || transitOrigin();
}

function routeCacheKey(center) {
  const origin = drivingOrigin();
  if (!origin) return "";
  return `${origin.lat},${origin.lon}|${center.lat},${center.lon}`;
}

function routeForCenter(center) {
  const key = routeCacheKey(center);
  return key ? state.routeCache.get(key) || null : null;
}

async function loadTransitTimes() {
  try {
    state.transit = await staticJson("data/silvia_transit_times.json");
  } catch {
    state.transit = null;
  }
}

function transitEntry(center) {
  if (!state.transit?.centers) return null;
  return state.transit.centers[centerKey(center)] || null;
}

function transitMinutes(center) {
  const item = transitEntry(center);
  if (!item || item.status !== "ok") return null;
  const seconds = Number(item.duration_seconds);
  return Number.isFinite(seconds) ? seconds / 60 : null;
}

function transitOriginLabel() {
  return state.transit?.metadata?.origin?.label || "Barakaldo";
}

function transitArrivalLabel() {
  const arrival = state.transit?.metadata?.arrival;
  if (!arrival) return "";
  return `${arrival.date} · ${arrival.time.slice(0, 5)}`;
}

function formatTransitCompact(center) {
  const item = transitEntry(center);
  if (!item) return "";
  if (item.status !== "ok") return "TP sin ruta";
  const transfers = Number(item.transfers || 0);
  const transferText = transfers === 1 ? "1 transb." : `${transfers} transb.`;
  return `TP ${formatDuration(Number(item.duration_seconds))} · ${transferText}`;
}

async function querySilviaCenters(params) {
  const allCenters = await staticJson("data/silvia_centers.json");
  const q = normalizeSearchText(params.get("q") || "");
  const exact = {
    th_id: params.get("th_id") || "",
    municipio_id: params.get("municipio_id") || "",
    localidad_id: params.get("localidad_id") || "",
  };
  const scope = params.get("silvia_subject_scope") || "237";
  const status = params.get("silvia_status") || "";
  const jornada = params.get("silvia_jornada") || "";
  const vacancyStatus = params.get("silvia_vacancy_status") || "";
  const profile = params.get("silvia_profile") || "";
  const english = params.get("silvia_english") || "";
  const stage = params.get("silvia_stage") || "";
  const review = params.get("silvia_review") || "";
  const transitMax = Number(params.get("silvia_transit_max") || 0);
  const onlyListed = params.get("silvia_only_listed") === "1";
  const hasHome = params.get("home_lat") && params.get("home_lon");
  const homeLat = hasHome ? Number(params.get("home_lat")) : null;
  const homeLon = hasHome ? Number(params.get("home_lon")) : null;
  const radiusKm = hasHome && params.get("radius_km") ? Number(params.get("radius_km")) : null;

  const centers = [];
  for (const center of allCenters) {
    if (exact.th_id && center.th_id !== exact.th_id) continue;
    if (exact.municipio_id && center.municipio_id !== exact.municipio_id) continue;
    if (exact.localidad_id && center.localidad_id !== exact.localidad_id) continue;
    if (transitMax) {
      const minutes = transitMinutes(center);
      if (minutes === null || minutes > transitMax) continue;
    }

    let distance = null;
    if (hasHome) {
      distance = haversineKm(homeLat, homeLon, Number(center.lat), Number(center.lon));
      if (radiusKm !== null && distance > radiusKm) continue;
    }

    const plazas = (center.plazas || []).filter((plaza) => {
      if (onlyListed && !isPlazaListed(plaza.id)) return false;
      if (!subjectScopeMatches(plaza, scope)) return false;
      if (status && practiceStatus(plaza) !== status) return false;
      if (jornada === "full" && plaza.is_reduction) return false;
      if (jornada === "reduction" && !plaza.is_reduction) return false;
      if (jornada === "below12" && !plaza.reduced_below_12) return false;
      if (vacancyStatus && plaza.vacancy_status !== vacancyStatus) return false;
      if (profile && plaza.profile !== profile) return false;
      if (english === "requires" && !plaza.requires_english) return false;
      if (english === "no" && plaza.requires_english) return false;
      if (stage && stageType(plaza) !== stage) return false;
      if (review === "flags" && !plazaHasReviewFlags(plaza)) return false;
      if (review === "clean" && plazaHasReviewFlags(plaza)) return false;
      if (!q) return true;
      return [
        center.centro_name,
        center.centro_id,
        center.municipio_name,
        center.localidad_name,
        plaza.num_plaza,
        plaza.subject_code,
        plaza.subject_name,
        practiceLabels[practiceStatus(plaza)],
        stageLabels[stageType(plaza)],
        scheduleLabels[scheduleType(plaza)],
        plaza.vacancy_status,
        plaza.observations,
        plaza.llm_classification?.short_reason,
        joinOrEmpty(plaza.llm_classification?.main_direct_subjects),
        joinOrEmpty(plaza.llm_classification?.flags),
        shortlistItem(plaza.id).alias,
        shortlistItem(plaza.id).note,
      ].some((value) => normalizeSearchText(value).includes(q));
    });
    if (!plazas.length) continue;

    const statusSummary = plazas.reduce((acc, plaza) => {
      const key = practiceStatus(plaza);
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    centers.push({
      ...center,
      distance_km: distance,
      selected_total: plazas.length,
      status_summary: statusSummary,
      plazas,
    });
  }

  centers.sort((a, b) => {
    const distanceA = a.distance_km ?? 999999;
    const distanceB = b.distance_km ?? 999999;
    const transitA = transitMax ? transitMinutes(a) ?? 999999 : 999999;
    const transitB = transitMax ? transitMinutes(b) ?? 999999 : 999999;
    const validA = (a.status_summary.yes || 0) + (a.status_summary.possible || 0);
    const validB = (b.status_summary.yes || 0) + (b.status_summary.possible || 0);
    return (
      transitA - transitB ||
      distanceA - distanceB ||
      validB - validA ||
      b.selected_total - a.selected_total ||
      a.centro_name.localeCompare(b.centro_name)
    );
  });

  return {
    view_mode: "silvia",
    vacancy_label: "plazas",
    center_count: centers.length,
    vacancy_row_count: centers.reduce((sum, center) => sum + center.plazas.length, 0),
    transfer_row_count: 0,
    total_selected: centers.reduce((sum, center) => sum + center.selected_total, 0),
    centers,
  };
}

function updateDependentFilters() {
  const th = els.th_id.value;
  const level = els.level_id.value;
  const locationMeta = isSilviaView() && state.silviaMeta ? state.silviaMeta : state.meta;

  const municipalities = locationMeta.municipalities.filter((item) => {
    if (th && item.th_id !== th) return false;
    return true;
  });
  const previousMunicipio = els.municipio_id.value;
  fillSelect(
    els.municipio_id,
    municipalities,
    (item) => `${item.th_id}/${item.municipio_id} · ${item.municipio_name}`,
    (item) => `${item.th_id}|${item.municipio_id}`,
    "Todos"
  );
  els.municipio_id.value = municipalities.some((item) => `${item.th_id}|${item.municipio_id}` === previousMunicipio)
    ? previousMunicipio
    : "";
  syncComboInput("municipio_id");
  const municipioParts = els.municipio_id.value ? els.municipio_id.value.split("|") : [];
  const municipioTh = municipioParts[0] || "";
  const municipioId = municipioParts[1] || "";

  const localities = locationMeta.localities.filter((item) => {
    if (th && item.th_id !== th) return false;
    if (municipioId && (item.th_id !== municipioTh || item.municipio_id !== municipioId)) return false;
    return true;
  });
  const previousLocality = els.localidad_id.value;
  fillSelect(
    els.localidad_id,
    localities,
    (item) => `${item.th_id}/${item.municipio_id}/${item.localidad_id} · ${item.localidad_name}`,
    (item) => `${item.th_id}|${item.municipio_id}|${item.localidad_id}`,
    "Todas"
  );
  els.localidad_id.value = localities.some(
    (item) => `${item.th_id}|${item.municipio_id}|${item.localidad_id}` === previousLocality
  )
    ? previousLocality
    : "";
  syncComboInput("localidad_id");

  if (isSilviaView()) return;

  const bodies = state.meta.teacher_bodies;
  const previousBody = els.teacher_body.value;
  fillSelect(els.teacher_body, bodies, (item) => item.teacher_body, (item) => item.teacher_body);
  els.teacher_body.value = bodies.some((item) => item.teacher_body === previousBody) ? previousBody : "";
  syncComboInput("teacher_body");

  const activeBody = els.teacher_body.value;
  const specialties = state.meta.specialties.filter((item) => {
    if (level && item.level_id !== level) return false;
    if (activeBody && item.teacher_body !== activeBody) return false;
    return true;
  });
  const previousSpecialty = els.specialty_code.value;
  fillSelect(
    els.specialty_code,
    specialties,
    (item) => `${item.specialty_code} · ${item.specialty_name}`,
    (item) => item.specialty_code,
    "Todas"
  );
  els.specialty_code.value = specialties.some((item) => item.specialty_code === previousSpecialty)
    ? previousSpecialty
    : "";
  syncComboInput("specialty_code");
}

function updateTerritoryFilter() {
  const locationMeta = isSilviaView() && state.silviaMeta ? state.silviaMeta : state.meta;
  const previousTh = els.th_id.value;
  fillSelect(els.th_id, locationMeta.territories, (item) => `${item.th_id} · ${item.th_name}`, (item) => item.th_id);
  els.th_id.value = locationMeta.territories.some((item) => item.th_id === previousTh) ? previousTh : "";
  syncComboInput("th_id");
}

function updateViewControls() {
  const silvia = isSilviaView();
  els.silviaFilters.classList.toggle("hidden", !silvia);
  for (const id of ["level_id_combo", "teacher_body_combo", "specialty_code_combo", "vacancy_column", "only_available"]) {
    const el = els[id];
    const container = el?.closest(".field") || el?.closest(".check-row");
    if (container) container.classList.toggle("hidden", silvia);
  }
  updateTerritoryFilter();
}

function setupMeta(meta) {
  state.meta = meta;
  fillSelect(els.th_id, meta.territories, (item) => `${item.th_id} · ${item.th_name}`, (item) => item.th_id);
  fillSelect(els.level_id, meta.levels, (item) => `${item.level_id} · ${item.level_name}`, (item) => item.level_id);
  fillSelect(els.vacancy_column, meta.vacancy_columns, (item) => item.name, (item) => item.id, "Total libres");
  els.vacancy_column.value = "total_libres";
  updateDependentFilters();
}

function setupSilviaMeta(meta) {
  state.silviaMeta = meta;
  fillSelect(
    els.silvia_vacancy_status,
    meta.vacancy_statuses || [],
    (item) => `${item.value} (${item.count})`,
    (item) => item.value,
    "Todos"
  );
}

function markerColor(total) {
  if (total >= 15) return "#b8326d";
  if (total >= 6) return "#7a5a8d";
  if (total >= 2) return "#a66a22";
  return "#6f6f78";
}

function markerColorForCenter(center) {
  if (!center.plazas) return markerColor(center.selected_total);
  if (center.status_summary.yes) return "#b8326d";
  if (center.status_summary.possible) return "#345d8b";
  if (center.status_summary.review) return "#a66a22";
  return "#6f6f78";
}

function createMarker(center) {
  const html = `<div class="popup-title">${center.centro_name}</div>
    <div>${center.localidad_name}, ${center.th_name}</div>
    <div class="popup-total">${center.selected_total} ${state.currentLabel}</div>`;
  const marker = L.circleMarker([center.lat, center.lon], {
    radius: Math.max(7, Math.min(17, 6 + Math.sqrt(center.selected_total || 1) * 2)),
    color: "#ffffff",
    weight: 2,
    fillColor: markerColorForCenter(center),
    fillOpacity: 0.9,
  });
  marker.bindPopup(html);
  marker.on("click", () => selectCenter(center));
  return marker;
}

function renderMap(data) {
  markerLayer.clearLayers();
  state.markers.clear();
  const bounds = [];

  for (const center of data.centers) {
    const marker = createMarker(center);
    marker.addTo(markerLayer);
    state.markers.set(`${center.centro_id}|${center.centro_codigo}`, marker);
    bounds.push([center.lat, center.lon]);
  }

  renderHomeLayer();

  if (bounds.length) {
    const groupBounds = L.latLngBounds(bounds);
    if (state.home) groupBounds.extend([state.home.lat, state.home.lon]);
    map.fitBounds(groupBounds.pad(0.16), { maxZoom: 13 });
  }
}

function formatSilviaSummary(center) {
  const parts = [];
  const labels = {
    yes: "aptas",
    possible: "posibles",
    review: "revisar",
    no: "no aptas",
  };
  for (const key of ["yes", "possible", "review", "no"]) {
    if (center.status_summary?.[key]) parts.push(`${center.status_summary[key]} ${labels[key]}`);
  }
  return parts.join(" · ");
}

function renderHomeLayer() {
  if (state.homeMarker) state.homeMarker.remove();
  if (state.radiusCircle) state.radiusCircle.remove();
  state.homeMarker = null;
  state.radiusCircle = null;

  if (!state.home) return;
  state.homeMarker = L.circleMarker([state.home.lat, state.home.lon], {
    radius: 8,
    color: "#ffffff",
    weight: 2,
    fillColor: "#1d1d1f",
    fillOpacity: 0.95,
  }).addTo(map).bindPopup("Casa");
  state.radiusCircle = L.circle([state.home.lat, state.home.lon], {
    radius: Number(els.radius_km.value) * 1000,
    color: "#b8326d",
    weight: 1,
    fillColor: "#b8326d",
    fillOpacity: 0.08,
  }).addTo(map);
}

function renderList(data) {
  els.summaryTotal.textContent = data.total_selected;
  els.summaryLabel.textContent =
    data.view_mode === "silvia" ? "plazas" : data.view_mode === "transfers" ? "adjudicaciones" : "vacantes";
  els.centerCount.textContent = `${data.center_count} centros`;
  els.rowCount.textContent =
    data.view_mode === "transfers" ? `${data.transfer_row_count} filas` : `${data.vacancy_row_count} filas`;
  els.centerList.replaceChildren();

  for (const center of data.centers.slice(0, 120)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "center-item";
    if (
      state.selected &&
      state.selected.centro_id === center.centro_id &&
      state.selected.centro_codigo === center.centro_codigo
    ) {
      button.classList.add("active");
    }
    const distance = center.distance_km === null ? "" : `${center.distance_km.toFixed(1)} km · `;
    const transit = data.view_mode === "silvia" ? formatTransitCompact(center) : "";
    button.innerHTML = `
      <div class="center-title">
        <span>${escapeHtml(center.centro_name)}</span>
        <span class="badge">${center.selected_total}</span>
      </div>
      <div class="meta">${distance}${escapeHtml(center.localidad_name)}, ${escapeHtml(center.th_name)}</div>
      ${transit ? `<div class="meta transit-meta">${escapeHtml(transit)} desde ${escapeHtml(transitOriginLabel())}</div>` : ""}
      <div class="meta">${
        data.view_mode === "silvia"
          ? formatSilviaSummary(center)
          : data.view_mode === "transfers"
            ? `${(center.transfers || []).length} adjudicaciones agregadas`
            : `${center.vacancies.length} especialidades`
      }</div>
    `;
    button.addEventListener("click", () => selectCenter(center));
    els.centerList.appendChild(button);
  }
}

function googleMapsLink(center) {
  return googleMapsModeLink(center, "driving");
}

function googleMapsModeLink(center, mode) {
  const destination = `${center.lat},${center.lon}`;
  const params = new URLSearchParams({
    api: "1",
    destination,
    travelmode: mode,
  });
  const origin = mode === "transit" ? transitOrigin() : drivingOrigin();
  if (origin) params.set("origin", `${origin.lat},${origin.lon}`);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function selectCenter(center) {
  state.selected = center;
  state.selectedRoute = null;
  const marker = state.markers.get(`${center.centro_id}|${center.centro_codigo}`);
  if (marker) {
    marker.openPopup();
    map.panTo([center.lat, center.lon]);
  }
  renderSelected(center);
  loadRouteForSelected(center);
  renderList({ ...state.lastData, centers: state.lastData.centers });
}

function clearSelectedPanel() {
  state.selected = null;
  state.selectedRoute = null;
  els.selectedPanel.className = "selected-panel empty";
  els.selectedPanel.innerHTML = "<span>Selecciona un centro</span>";
}

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return "";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function formatTime(ms) {
  const date = new Date(Number(ms));
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("es-ES", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function renderTravelSummary(center, routeOverride) {
  const route = routeOverride === undefined ? state.selectedRoute : routeOverride;
  const origin = drivingOrigin();
  let carValue = origin ? "Calculando..." : "Sin origen";
  let carMeta = "OSRM";
  if (origin) {
    if (route?.status === "ok") {
      carValue = formatDuration(route.duration_seconds);
      carMeta = `${route.distance_km} km por carretera`;
    } else if (route && route.status !== "ok") {
      carValue = "No disponible";
      carMeta = "No se pudo calcular";
    }
  }

  const transit = transitEntry(center);
  const arrivalInfo = transitArrivalLabel();
  let transitValue = "Sin datos";
  let transitMeta = state.transit
    ? `desde ${transitOriginLabel()}${arrivalInfo ? ` · ${arrivalInfo}` : ""}`
    : "genera tiempos con OTP";
  let transitDetail = "";
  if (transit?.status === "ok") {
    const transfers = Number(transit.transfers || 0);
    const transferText = transfers === 1 ? "1 transbordo" : `${transfers} transbordos`;
    transitValue = formatDuration(Number(transit.duration_seconds));
    transitMeta = `${transferText} · ${Math.round(Number(transit.walk_distance_m || 0))} m andando`;
    const times = [formatTime(transit.start_time), formatTime(transit.end_time)].filter(Boolean).join(" → ");
    const routes = (transit.routes || []).slice(0, 4).join(" + ");
    transitDetail = [times, routes, `desde ${transitOriginLabel()}`].filter(Boolean).join(" · ");
  } else if (transit && transit.status !== "ok") {
    transitValue = "Sin ruta";
    transitMeta = `desde ${transitOriginLabel()}`;
  }
  return `
    <div class="travel-summary">
      <div class="travel-metric">
        <span>Coche</span>
        <strong>${carValue}</strong>
        <small>${carMeta}${origin ? ` · desde ${escapeHtml(origin.label || "Casa")}` : ""}</small>
        <a class="metric-link" href="${googleMapsModeLink(center, "driving")}" target="_blank" rel="noreferrer">Ruta coche</a>
      </div>
      <div class="travel-metric">
        <span>Transporte público</span>
        <strong>${escapeHtml(transitValue)}</strong>
        <small>${escapeHtml(transitMeta)}</small>
        ${transitDetail ? `<small>${escapeHtml(transitDetail)}</small>` : ""}
        <a class="metric-link secondary" href="${googleMapsModeLink(center, "transit")}" target="_blank" rel="noreferrer">Comparar en Google</a>
      </div>
    </div>
  `;
}

function formatFlagLabel(flag) {
  const labels = {
    afternoon_or_split_schedule: "tarde / partido",
    direct_hours_confidence: "confianza",
    english_required: "inglés",
    eso_bach: "ESO/Bach",
    epa: "EPA",
    fp: "FP",
    hours_ambiguous: "horas ambiguas",
    hours_missing: "sin horas",
    itinerant: "itinerante",
    manual_review: "revisión manual",
    mixed_stage: "tipo mixto",
    not_plain_vacante: "no vacante ordinaria",
    reduction: "reducción",
    reduction_below_12h: "reducción <12h",
    subject_1585_review: "1585 revisar",
    support_heavy: "mucho soporte",
    technology_not_informatika_review: "tecnología revisar",
    tknika_or_singular: "singular / Tknika",
  };
  return labels[flag] || String(flag).replace(/^obs_/, "").replace(/_/g, " ");
}

function formatHoursRange(min, max) {
  if (min === null && max === null) return "Sin dato";
  if (min !== null && max !== null && Number(min) !== Number(max)) {
    return `${displayNumber(min)}-${displayNumber(max)}h`;
  }
  return `${displayNumber(min ?? max)}h`;
}

function directHoursFor(plaza) {
  const llm = plaza.llm_classification || {};
  return {
    min: llm.direct_hours_min ?? plaza.direct_hours_min ?? null,
    max: llm.direct_hours_max ?? plaza.direct_hours_possible ?? plaza.direct_hours_min ?? null,
  };
}

function confidenceLabel(value) {
  return { high: "alta", medium: "media", low: "baja" }[value] || value || "sin dato";
}

function renderMetric(label, value, detail = "") {
  return `
    <div class="class-metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      ${detail ? `<small>${escapeHtml(detail)}</small>` : ""}
    </div>
  `;
}

function renderPills(items, className = "flag-pill") {
  const unique = [...new Set((items || []).filter(Boolean))];
  if (!unique.length) return "";
  return `<div class="flag-list">${unique
    .map((item) => `<span class="${className}">${escapeHtml(formatFlagLabel(item))}</span>`)
    .join("")}</div>`;
}

function plazaClassification(plaza) {
  const llm = plaza.llm_classification || {};
  return {
    llm,
    status: practiceStatus(plaza),
    stage: stageType(plaza),
    schedule: scheduleType(plaza),
    flags: [
      ...(llm.flags || []),
      ...(plaza.schedule_risk ? ["afternoon_or_split_schedule"] : []),
      ...(plaza.is_reduction ? ["reduction"] : []),
      ...(plaza.reduced_below_12 ? ["reduction_below_12h"] : []),
    ],
  };
}

function renderPlazaListControl(plaza) {
  const currentColumn = shortlistColumnFor(plaza.id);
  return `
    <div class="plaza-list-control">
      <label for="list-${escapeHtml(plaza.id)}">Mi lista</label>
      <select id="list-${escapeHtml(plaza.id)}" class="plaza-list-select" data-plaza-id="${escapeHtml(plaza.id)}">
        ${shortlistOptions(currentColumn)}
      </select>
    </div>`;
}

function renderPlazaInformation(plaza) {
  const { llm, flags } = plazaClassification(plaza);
  const directSubjects = llm.main_direct_subjects || [];
  const nonDirectCategories = llm.non_direct_categories || [];
  const hours = directHoursFor(plaza);
  const directHours = formatHoursRange(hours.min, hours.max);
  const confidence = confidenceLabel(llm.direct_hours_confidence);
  const directSubjectHtml = directSubjects.length
    ? `<div class="classification-line"><span>Directas</span><p>${escapeHtml(joinOrEmpty(directSubjects))}</p></div>`
    : "";
  const nonDirectHtml = nonDirectCategories.length
    ? `<div class="classification-line"><span>No directas</span><p>${escapeHtml(joinOrEmpty(nonDirectCategories.map(formatFlagLabel)))}</p></div>`
    : "";
  return `
    <div class="classification-grid">
      ${renderMetric("Directas", directHours, `confianza ${confidence}`)}
      ${renderMetric("Soporte", `${displayNumber(llm.non_direct_hours, "h")}`)}
      ${renderMetric("Otras", `${displayNumber(llm.other_subject_hours, "h")}`)}
      ${renderMetric("Dudosas", `${displayNumber(llm.unknown_hours, "h")}`)}
      ${renderMetric("Jornada", `${plaza.percentage_hours}% · ${plaza.jornada_type}`, `máx. ${displayNumber(plaza.effective_max_hours, "h")}`)}
      ${renderMetric("Perfil", plaza.profile_desc || `PL${plaza.profile}`, plaza.preceptivity)}
      ${renderMetric("Inglés", plaza.requires_english ? "Sí" : "No")}
      ${renderMetric("Estado", plaza.vacancy_status)}
    </div>
    ${llm.short_reason ? `<p class="classification-reason">${escapeHtml(llm.short_reason)}</p>` : ""}
    ${directSubjectHtml}
    ${nonDirectHtml}
    ${renderPills(flags)}
    <details class="obs-details">
      <summary>OBSERVACIONES</summary>
      <p>${escapeHtml(plaza.observations || "Sin observaciones")}</p>
    </details>`;
}

function renderSilviaSelected(center) {
  const distance = center.distance_km === null ? "" : `${center.distance_km.toFixed(1)} km · `;
  const cards = center.plazas
    .slice(0, 80)
    .map((plaza) => {
      const { status, stage, schedule } = plazaClassification(plaza);
      return `
        <article class="silvia-plaza-card">
          <div class="plaza-card-header">
            <div>
              <div class="plaza-title">Plaza ${escapeHtml(plaza.num_plaza)}</div>
              <div class="meta">${escapeHtml(plaza.subject_code)} · ${escapeHtml(plaza.subject_name)}</div>
            </div>
            <div class="plaza-badges">
              <span class="status-pill practice-${escapeHtml(status)}">${escapeHtml(practiceLabels[status] || status)}</span>
              <span class="type-pill">${escapeHtml(stageLabels[stage] || stage)}</span>
              <span class="type-pill ${plaza.schedule_risk ? "schedule-risk" : ""}">${escapeHtml(scheduleLabels[schedule] || schedule)}</span>
            </div>
          </div>
          ${renderPlazaListControl(plaza)}
          ${renderPlazaInformation(plaza)}
        </article>`;
    })
    .join("");
  els.selectedPanel.className = "selected-panel";
  els.selectedPanel.innerHTML = `
    <div class="selected-header">
      <div>
        <h2>${escapeHtml(center.centro_name)}</h2>
        <div class="meta">${distance}${escapeHtml(center.localidad_name)}, ${escapeHtml(center.municipio_name)}</div>
        <div class="meta">${escapeHtml(formatSilviaSummary(center))}</div>
      </div>
    </div>
    ${renderTravelSummary(center)}
    <div class="silvia-card-list">${cards}</div>
  `;
}

function boardTransitText(center) {
  const transit = transitEntry(center);
  if (!transit) return "Sin dato";
  if (transit.status !== "ok") return "Sin ruta";
  return formatDuration(Number(transit.duration_seconds));
}

function boardCarText(center) {
  const route = routeForCenter(center);
  if (!drivingOrigin()) return "Sin origen";
  if (!route) return "Calculando";
  return route.status === "ok" ? formatDuration(Number(route.duration_seconds)) : "Sin ruta";
}

function renderBoardCard(plazaId, columnId, index) {
  const record = state.plazaIndex.get(String(plazaId));
  const item = shortlistItem(plazaId);
  if (!record) {
    return `
      <article class="board-card" draggable="true" data-plaza-id="${escapeHtml(plazaId)}">
        <div class="board-card-top"><span class="board-rank">#${index + 1}</span><span class="drag-handle" aria-hidden="true">⠿</span></div>
        <div class="board-card-title">Plaza no encontrada</div>
        <div class="board-card-official">${escapeHtml(plazaId)}</div>
        <div class="board-card-actions">
          <span class="meta">Puede haber cambiado en los datos</span>
          <button class="icon-button remove-button" type="button" data-action="remove" aria-label="Eliminar" title="Eliminar">×</button>
        </div>
      </article>`;
  }

  const { center, plaza } = record;
  const title = item.alias || center.centro_name;
  const official = item.alias
    ? `${center.centro_name} · Plaza ${plaza.num_plaza}`
    : `Plaza ${plaza.num_plaza} · ${plaza.subject_code} ${plaza.subject_name}`;
  const hours = directHoursFor(plaza);
  const directHours = formatHoursRange(hours.min, hours.max);
  const schedule = scheduleType(plaza);
  const stage = stageType(plaza);
  return `
    <article class="board-card" draggable="true" data-plaza-id="${escapeHtml(plaza.id)}">
      <div class="board-card-top">
        <span class="board-rank">#${index + 1}</span>
        <span class="drag-handle" aria-hidden="true">⠿</span>
      </div>
      <button class="board-card-main" type="button" data-action="open">
        <span class="board-card-title">${escapeHtml(title)}</span>
        <span class="board-card-official">${escapeHtml(official)}</span>
        <span class="board-card-location">${escapeHtml(center.localidad_name)}, ${escapeHtml(center.municipio_name)}</span>
      </button>
      ${item.note ? `<p class="board-card-note">${escapeHtml(item.note)}</p>` : ""}
      <div class="board-card-metrics">
        <div class="board-card-metric"><span>TP</span><strong>${escapeHtml(boardTransitText(center))}</strong></div>
        <div class="board-card-metric"><span>Coche</span><strong>${escapeHtml(boardCarText(center))}</strong></div>
        <div class="board-card-metric"><span>Directas</span><strong>${escapeHtml(directHours)}</strong></div>
      </div>
      <div class="board-card-tags">
        <span class="type-pill ${plaza.schedule_risk ? "schedule-risk" : ""}">${escapeHtml(scheduleLabels[schedule] || schedule)}</span>
        <span class="type-pill">${escapeHtml(stageLabels[stage] || stage)}</span>
        <span class="type-pill">${escapeHtml(plaza.percentage_hours)}% · ${escapeHtml(plaza.jornada_type)}</span>
      </div>
      <div class="board-card-actions">
        <label class="sr-only" for="board-column-${escapeHtml(plaza.id)}">Decisión</label>
        <select id="board-column-${escapeHtml(plaza.id)}" data-action="change-column" aria-label="Mover de columna">
          ${shortlistOptions(columnId, false)}
        </select>
        <div class="icon-actions">
          <button class="icon-button" type="button" data-action="up" aria-label="Subir" title="Subir"${index === 0 ? " disabled" : ""}>↑</button>
          <button class="icon-button" type="button" data-action="down" aria-label="Bajar" title="Bajar"${index === state.shortlist.columns[columnId].length - 1 ? " disabled" : ""}>↓</button>
          <button class="icon-button remove-button" type="button" data-action="remove" aria-label="Eliminar de la lista" title="Eliminar de la lista">×</button>
        </div>
      </div>
    </article>`;
}

function renderBoard(queueRoutes = true) {
  if (!state.shortlist || !els.goodList) return;
  for (const column of shortlistColumns) {
    const ids = state.shortlist.columns[column.id];
    const list = els[`${column.id}List`];
    els[`${column.id}Count`].textContent = ids.length;
    list.innerHTML = ids.length
      ? ids.map((plazaId, index) => renderBoardCard(plazaId, column.id, index)).join("")
      : `<div class="board-empty">Sin plazas</div>`;
  }
  updateShortlistCount();
  if (queueRoutes && state.activeWorkspace === "board") queueBoardRoutes();
}

function setWorkspace(workspace) {
  state.activeWorkspace = workspace === "board" ? "board" : "explore";
  const boardActive = state.activeWorkspace === "board";
  els.exploreView.classList.toggle("hidden", boardActive);
  els.boardView.classList.toggle("hidden", !boardActive);
  els.exploreTab.classList.toggle("active", !boardActive);
  els.boardTab.classList.toggle("active", boardActive);
  els.exploreTab.setAttribute("aria-selected", String(!boardActive));
  els.boardTab.setAttribute("aria-selected", String(boardActive));
  if (boardActive) {
    renderBoard();
  } else {
    window.setTimeout(() => map.invalidateSize(), 0);
  }
}

function updateBoardDialogTravel(plazaId) {
  if (state.dialogPlazaId !== String(plazaId) || !els.plazaDialog.open) return;
  const record = state.plazaIndex.get(String(plazaId));
  const travel = document.getElementById("dialogTravel");
  if (record && travel) travel.innerHTML = renderTravelSummary(record.center, routeForCenter(record.center));
}

async function queueBoardRoutes() {
  if (state.boardRouteLoading) return;
  const records = [];
  const seenCenters = new Set();
  for (const column of shortlistColumns) {
    for (const plazaId of state.shortlist.columns[column.id]) {
      const record = state.plazaIndex.get(String(plazaId));
      if (!record || seenCenters.has(centerKey(record.center)) || routeForCenter(record.center)) continue;
      seenCenters.add(centerKey(record.center));
      records.push(record);
    }
  }
  if (!records.length || !drivingOrigin()) return;

  state.boardRouteLoading = true;
  let cursor = 0;
  const worker = async () => {
    while (cursor < records.length) {
      const record = records[cursor++];
      await ensureRouteForCenter(record.center);
      if (state.activeWorkspace === "board") renderBoard(false);
      updateBoardDialogTravel(record.plaza.id);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, records.length) }, worker));
  state.boardRouteLoading = false;
}

function renderPlazaDialog(plazaId) {
  const record = state.plazaIndex.get(String(plazaId));
  if (!record) return;
  const { center, plaza } = record;
  const item = shortlistItem(plazaId);
  const columnId = shortlistColumnFor(plazaId);
  const { status, stage, schedule } = plazaClassification(plaza);
  const heading = item.alias || `Plaza ${plaza.num_plaza}`;
  els.dialogHeading.innerHTML = `
    <h2>${escapeHtml(heading)}</h2>
    <div class="meta">${escapeHtml(center.centro_name)} · ${escapeHtml(center.localidad_name)}, ${escapeHtml(center.municipio_name)}</div>
    <div class="meta">Plaza ${escapeHtml(plaza.num_plaza)} · ${escapeHtml(plaza.subject_code)} ${escapeHtml(plaza.subject_name)}</div>`;
  els.dialogContent.innerHTML = `
    <section class="dialog-personal">
      <div class="field">
        <label for="dialogAlias">Nombre personal</label>
        <input id="dialogAlias" type="text" maxlength="80" value="${escapeHtml(item.alias)}" placeholder="Ej. cerca de casa" />
      </div>
      <div class="field">
        <label for="dialogNote">Valoración personal</label>
        <textarea id="dialogNote" maxlength="500" placeholder="Por qué te gusta o qué dudas tienes">${escapeHtml(item.note)}</textarea>
      </div>
      <div class="field">
        <label for="dialogColumn">Decisión</label>
        <select id="dialogColumn">${shortlistOptions(columnId)}</select>
      </div>
      <button id="saveDialog" class="dialog-save" type="button">Guardar</button>
    </section>
    <div class="plaza-badges">
      <span class="status-pill practice-${escapeHtml(status)}">${escapeHtml(practiceLabels[status] || status)}</span>
      <span class="type-pill">${escapeHtml(stageLabels[stage] || stage)}</span>
      <span class="type-pill ${plaza.schedule_risk ? "schedule-risk" : ""}">${escapeHtml(scheduleLabels[schedule] || schedule)}</span>
    </div>
    <h3 class="dialog-section-title">Desplazamiento</h3>
    <div id="dialogTravel">${renderTravelSummary(center, routeForCenter(center))}</div>
    <h3 class="dialog-section-title">Datos de la plaza</h3>
    ${renderPlazaInformation(plaza)}`;
  document.getElementById("saveDialog").addEventListener("click", saveDialogChanges);
}

function openPlazaDialog(plazaId) {
  const id = String(plazaId);
  if (!state.plazaIndex.has(id)) return;
  state.dialogPlazaId = id;
  renderPlazaDialog(id);
  els.plazaDialog.showModal();
  const record = state.plazaIndex.get(id);
  ensureRouteForCenter(record.center).then(() => updateBoardDialogTravel(id));
}

function saveDialogChanges() {
  const plazaId = state.dialogPlazaId;
  if (!plazaId) return;
  const columnId = document.getElementById("dialogColumn").value;
  const alias = document.getElementById("dialogAlias").value.trim();
  const note = document.getElementById("dialogNote").value.trim();
  const currentColumn = shortlistColumnFor(plazaId);
  if (currentColumn !== columnId) setShortlistColumn(plazaId, columnId);
  if (columnId) state.shortlist.items[plazaId] = { alias, note };
  shortlistChanged("Cambios guardados");
  els.plazaDialog.close();
}

function reorderShortlist(plazaId, delta) {
  const columnId = shortlistColumnFor(plazaId);
  if (!columnId) return;
  const ids = state.shortlist.columns[columnId];
  const index = ids.indexOf(String(plazaId));
  const nextIndex = index + delta;
  if (index < 0 || nextIndex < 0 || nextIndex >= ids.length) return;
  [ids[index], ids[nextIndex]] = [ids[nextIndex], ids[index]];
  shortlistChanged();
}

function removeShortlistItem(plazaId) {
  const record = state.plazaIndex.get(String(plazaId));
  const label = shortlistItem(plazaId).alias || record?.center?.centro_name || "esta plaza";
  if (!window.confirm(`¿Quitar ${label} de la lista?`)) return;
  setShortlistColumn(plazaId, "");
  shortlistChanged("Plaza eliminada de la lista");
}

function downloadTextFile(contents, filename, mimeType) {
  const url = URL.createObjectURL(new Blob([contents], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportShortlistBackup() {
  const payload = {
    format: SHORTLIST_BACKUP_FORMAT,
    version: SHORTLIST_BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    candidate: state.silviaMeta?.candidate || null,
    source_data_generated_at: state.silviaMeta?.generated_at || null,
    shortlist: state.shortlist,
  };
  const date = new Date().toISOString().slice(0, 10);
  downloadTextFile(
    `${JSON.stringify(payload, null, 2)}\n`,
    `silvia-lista-plazas-${date}.json`,
    "application/json;charset=utf-8"
  );
  showToast("Copia completa guardada");
}

async function importShortlistBackup(file) {
  if (!file) return;
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error("El archivo es demasiado grande");
    const payload = JSON.parse(await file.text());
    if (payload?.format !== SHORTLIST_BACKUP_FORMAT) throw new Error("El archivo no es una copia de esta lista");
    if (Number(payload.version) !== SHORTLIST_BACKUP_VERSION) throw new Error("La versión de la copia no es compatible");
    const restored = normalizeShortlist(payload.shortlist, true);
    const restoredCount = shortlistColumns.reduce((sum, column) => sum + restored.columns[column.id].length, 0);
    if (shortlistCount() && !window.confirm(`¿Reemplazar la lista actual por esta copia de ${restoredCount} plazas?`)) return;

    state.shortlist = restored;
    const unknownCount = shortlistColumns.reduce(
      (sum, column) => sum + restored.columns[column.id].filter((plazaId) => !state.plazaIndex.has(plazaId)).length,
      0
    );
    shortlistChanged();
    setWorkspace("board");
    showToast(
      unknownCount
        ? `Copia importada: ${restoredCount} plazas, ${unknownCount} ya no están en los datos actuales`
        : `Copia importada: ${restoredCount} plazas`,
      4200
    );
  } catch (error) {
    showToast(`No se pudo importar: ${error.message}`, 4200);
  } finally {
    els.shortlistBackupFile.value = "";
  }
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function exportShortlistCsv() {
  const previousLabel = els.exportShortlist.textContent;
  els.exportShortlist.disabled = true;
  els.exportShortlist.textContent = "Preparando...";
  await queueBoardRoutes();
  while (state.boardRouteLoading) {
    await new Promise((resolve) => window.setTimeout(resolve, 80));
  }
  const header = [
    "decision",
    "orden",
    "nombre_personal",
    "valoracion_personal",
    "numero_plaza",
    "centro_oficial",
    "municipio",
    "codigo_asignatura",
    "asignatura",
    "horas_directas_min",
    "horas_directas_max",
    "jornada_porcentaje",
    "tipo_jornada",
    "horario",
    "etapa",
    "transporte_publico_min",
    "transbordos",
    "coche_min",
    "observaciones",
  ];
  const rows = [header];
  for (const column of shortlistColumns) {
    state.shortlist.columns[column.id].forEach((plazaId, index) => {
      const record = state.plazaIndex.get(String(plazaId));
      if (!record) return;
      const { center, plaza } = record;
      const item = shortlistItem(plazaId);
      const hours = directHoursFor(plaza);
      const transit = transitEntry(center);
      const car = routeForCenter(center);
      rows.push([
        column.label,
        index + 1,
        item.alias,
        item.note,
        plaza.num_plaza,
        center.centro_name,
        center.municipio_name,
        plaza.subject_code,
        plaza.subject_name,
        hours.min,
        hours.max,
        plaza.percentage_hours,
        plaza.jornada_type,
        scheduleLabels[scheduleType(plaza)] || scheduleType(plaza),
        stageLabels[stageType(plaza)] || stageType(plaza),
        transit?.status === "ok" ? Math.round(Number(transit.duration_seconds) / 60) : "",
        transit?.status === "ok" ? transit.transfers : "",
        car?.status === "ok" ? Math.round(Number(car.duration_seconds) / 60) : "",
        plaza.observations,
      ]);
    });
  }
  const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  downloadTextFile(csv, "silvia-orden-plazas.csv", "text/csv;charset=utf-8");
  els.exportShortlist.disabled = false;
  els.exportShortlist.textContent = previousLabel;
}

function setupBoardEvents() {
  els.boardView.addEventListener("click", (event) => {
    const card = event.target.closest(".board-card");
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!card || !action) return;
    const plazaId = card.dataset.plazaId;
    if (action === "open") openPlazaDialog(plazaId);
    if (action === "up") reorderShortlist(plazaId, -1);
    if (action === "down") reorderShortlist(plazaId, 1);
    if (action === "remove") removeShortlistItem(plazaId);
  });
  els.boardView.addEventListener("change", (event) => {
    if (event.target.dataset.action !== "change-column") return;
    const card = event.target.closest(".board-card");
    if (!card) return;
    setShortlistColumn(card.dataset.plazaId, event.target.value);
    shortlistChanged(`Movida a ${shortlistColumnLabel(event.target.value)}`);
  });
  els.boardView.addEventListener("dragstart", (event) => {
    const card = event.target.closest(".board-card");
    if (!card) return;
    state.draggedPlazaId = card.dataset.plazaId;
    card.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", card.dataset.plazaId);
  });
  els.boardView.addEventListener("dragover", (event) => {
    const list = event.target.closest(".board-list");
    if (!list || !state.draggedPlazaId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    for (const item of els.boardView.querySelectorAll(".board-list")) item.classList.toggle("drag-over", item === list);
  });
  els.boardView.addEventListener("drop", (event) => {
    const list = event.target.closest(".board-list");
    if (!list || !state.draggedPlazaId) return;
    event.preventDefault();
    const cards = [...list.querySelectorAll(".board-card")];
    const targetCard = event.target.closest(".board-card");
    let index = cards.length;
    if (targetCard) {
      index = cards.indexOf(targetCard);
      if (event.clientY > targetCard.getBoundingClientRect().top + targetCard.offsetHeight / 2) index += 1;
    }
    const plazaId = state.draggedPlazaId;
    state.draggedPlazaId = null;
    moveShortlistItem(plazaId, list.dataset.boardList, index);
  });
  els.boardView.addEventListener("dragend", () => {
    state.draggedPlazaId = null;
    for (const item of els.boardView.querySelectorAll(".dragging, .drag-over")) {
      item.classList.remove("dragging", "drag-over");
    }
  });
}

function renderSelected(center) {
  const distance = center.distance_km === null ? "" : `${center.distance_km.toFixed(1)} km · `;
  const viewMode = state.lastData?.view_mode || "vacancies";
  if (viewMode === "silvia") {
    renderSilviaSelected(center);
    return;
  }
  const transferRows = (center.transfers || [])
    .slice(0, 80)
    .map(
      (transfer) => `
        <tr>
          <td>${transfer.awarded_body}</td>
          <td>${transfer.awarded_specialty_code}</td>
          <td>${transfer.adjudications}</td>
          <td>${transfer.initial_adjudications}</td>
          <td>${transfer.resulting_adjudications}</td>
          <td>${transfer.min_score || ""}</td>
          <td>${transfer.avg_score || ""}</td>
        </tr>`
    )
    .join("");
  const selectedColumn = state.lastData?.vacancy_column || "total_libres";
  const countColumns =
    selectedColumn === "total_libres"
      ? vacancyColumns
      : [
          vacancyColumns.find((column) => column.id === selectedColumn),
          vacancyColumns.find((column) => column.id === "total_libres"),
        ].filter(Boolean);
  const countHeader = countColumns.map((column) => `<th>${column.short}</th>`).join("");
  const rows = center.vacancies
    .slice(0, 80)
    .map(
      (vacancy) => `
        <tr>
          <td>${vacancy.specialty_code}</td>
          <td>${vacancy.specialty_name}</td>
          <td>${vacancy.level_name}</td>
          ${countColumns.map((column) => `<td>${vacancy[column.id]}</td>`).join("")}
        </tr>`
    )
    .join("");
  els.selectedPanel.className = "selected-panel";
  els.selectedPanel.innerHTML = `
    <div class="selected-header">
      <div>
        <h2>${center.centro_name}</h2>
        <div class="meta">${distance}${center.localidad_name}, ${center.municipio_name}</div>
        <div class="meta">${center.geocode_precision}</div>
      </div>
    </div>
    ${renderTravelSummary(center)}
    ${
      viewMode === "transfers"
        ? `<table class="vacancy-table">
            <thead>
              <tr><th>Cuerpo</th><th>Especialidad</th><th>Total</th><th>Inicial</th><th>Result.</th><th>Min.</th><th>Media</th></tr>
            </thead>
            <tbody>${transferRows}</tbody>
          </table>`
        : `<table class="vacancy-table">
            <thead>
              <tr><th>Código</th><th>Especialidad</th><th>Nivel</th>${countHeader}</tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>`
    }
  `;
}

async function ensureRouteForCenter(center) {
  const origin = drivingOrigin();
  const key = routeCacheKey(center);
  if (!origin || !key) return null;
  if (state.routeCache.has(key)) return state.routeCache.get(key);
  if (state.pendingRoutes.has(key)) return state.pendingRoutes.get(key);
  const params = new URLSearchParams({
    from_lat: origin.lat,
    from_lon: origin.lon,
    to_lat: center.lat,
    to_lon: center.lon,
  });
  const request = (async () => {
    try {
      const route = await api(`/api/route?${params.toString()}`);
      state.routeCache.set(key, route);
      saveRouteCache();
      return route;
    } catch {
      const route = { status: "error" };
      state.routeCache.set(key, route);
      saveRouteCache();
      return route;
    } finally {
      state.pendingRoutes.delete(key);
    }
  })();
  state.pendingRoutes.set(key, request);
  return request;
}

async function loadRouteForSelected(center) {
  const route = await ensureRouteForCenter(center);
  if (
    state.selected &&
    state.selected.centro_id === center.centro_id &&
    state.selected.centro_codigo === center.centro_codigo
  ) {
    state.selectedRoute = route;
    renderSelected(state.selected);
  }
}

async function loadCenters() {
  const params = paramsFromFilters();
  const data = isSilviaView() ? await querySilviaCenters(params) : await api(`/api/centers?${params.toString()}`);
  state.centers = data.centers;
  state.currentLabel =
    data.view_mode === "silvia" ? "plazas" : data.view_mode === "transfers" ? "adjudicaciones" : data.vacancy_label.toLowerCase();
  state.lastData = data;
  const hadSelected = Boolean(state.selected);
  if (hadSelected) {
    state.selected = data.centers.find(
      (center) =>
        center.centro_id === state.selected.centro_id &&
        center.centro_codigo === state.selected.centro_codigo
    );
  }
  renderMap(data);
  renderList(data);
  if (state.selected) {
    renderSelected(state.selected);
    loadRouteForSelected(state.selected);
  } else if (hadSelected) {
    clearSelectedPanel();
  }
}

async function setHome(lat, lon, label) {
  state.home = { lat: Number(lat), lon: Number(lon), label };
  els.homeStatus.textContent = label;
  els.homeResults.replaceChildren();
  state.selectedRoute = null;
  await loadCenters();
}

async function geocodeHome() {
  const query = els.homeAddress.value.trim();
  if (!query) return;
  els.homeStatus.textContent = "Buscando...";
  els.homeResults.replaceChildren();
  const result = await api(`/api/geocode?q=${encodeURIComponent(query)}`);
  if (!result.results.length) {
    els.homeStatus.textContent = "No encontrado";
    return;
  }
  els.homeStatus.textContent = "Elige una ubicación";
  renderHomeResults(result.results);
}

function renderHomeResults(results) {
  els.homeResults.replaceChildren();
  for (const result of results) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "home-result";
    button.textContent = result.display_name;
    button.addEventListener("click", () => setHome(result.lat, result.lon, result.display_name));
    els.homeResults.appendChild(button);
  }
}

function useCurrentLocation() {
  if (!navigator.geolocation) {
    els.homeStatus.textContent = "Geolocalización no disponible";
    return;
  }
  els.homeStatus.textContent = "Localizando...";
  navigator.geolocation.getCurrentPosition(
    async (position) => {
      await setHome(position.coords.latitude, position.coords.longitude, "Ubicación actual");
    },
    () => {
      els.homeStatus.textContent = "No se pudo obtener la ubicación";
    },
    { enableHighAccuracy: true, timeout: 12000 }
  );
}

async function init() {
  for (const id of [
    ...filterIds,
    ...silviaFilterIds,
    ...Object.values(comboConfigs).flatMap((config) => [config.inputId, config.listId]),
    "silviaFilters",
    "summaryTotal",
    "summaryLabel",
    "centerCount",
    "rowCount",
    "centerList",
    "selectedPanel",
    "homeAddress",
    "homeResults",
    "geocodeHome",
    "useLocation",
    "clearHome",
    "radiusValue",
    "homeStatus",
    "exploreView",
    "boardView",
    "exploreTab",
    "boardTab",
    "shortlistCount",
    "boardSummary",
    "importShortlist",
    "exportShortlistBackup",
    "exportShortlist",
    "shortlistBackupFile",
    "goodList",
    "maybeList",
    "noList",
    "goodCount",
    "maybeCount",
    "noCount",
    "plazaDialog",
    "dialogHeading",
    "dialogContent",
    "closeDialog",
    "toast",
  ]) {
    els[id] = document.getElementById(id);
  }

  loadShortlist();
  loadRouteCache();
  setupSilviaMeta(await staticJson("data/silvia_meta.json"));
  await loadTransitTimes();
  indexSilviaCenters(await staticJson("data/silvia_centers.json"));
  setupMeta(await api("/api/meta"));
  updateViewControls();
  updateDependentFilters();
  await loadCenters();
  renderBoard(false);
  const fixedOrigin = transitOrigin();
  if (fixedOrigin) els.homeStatus.textContent = `TP calculado desde ${fixedOrigin.label}`;

  const reload = debounce(async () => {
    updateViewControls();
    updateDependentFilters();
    await loadCenters();
  });

  for (const id of filterIds) {
    const event = els[id].type === "search" || els[id].type === "range" ? "input" : "change";
    els[id].addEventListener(event, async () => {
      if (id === "radius_km") els.radiusValue.textContent = `${els.radius_km.value} km`;
      if (id === "view_mode") {
        clearSelectedPanel();
      }
      await reload();
    });
  }

  for (const id of silviaFilterIds) {
    els[id].addEventListener("change", async () => {
      clearSelectedPanel();
      await reload();
    });
  }

  for (const selectId of Object.keys(comboConfigs)) {
    const input = els[comboConfigs[selectId].inputId];
    input.addEventListener("input", async () => {
      const hadValue = Boolean(els[selectId].value);
      const matched = applyComboValue(selectId);
      if (!matched && els[selectId].value) {
        els[selectId].value = "";
      }
      if (matched || hadValue) {
        await reload();
      }
    });
    input.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (selectFirstComboMatch(selectId)) {
        await reload();
      }
    });
    input.addEventListener("blur", async () => {
      if (!input.value.trim() || applyComboValue(selectId) || selectFirstComboMatch(selectId)) {
        await reload();
      }
    });
  }

  els.geocodeHome.addEventListener("click", geocodeHome);
  els.homeAddress.addEventListener("keydown", (event) => {
    if (event.key === "Enter") geocodeHome();
  });
  els.useLocation.addEventListener("click", useCurrentLocation);
  els.clearHome.addEventListener("click", async () => {
    state.home = null;
    const origin = transitOrigin();
    els.homeStatus.textContent = origin ? `TP calculado desde ${origin.label}` : "";
    els.homeResults.replaceChildren();
    state.selectedRoute = null;
    await loadCenters();
  });

  els.selectedPanel.addEventListener("change", (event) => {
    if (!event.target.classList.contains("plaza-list-select")) return;
    const plazaId = event.target.dataset.plazaId;
    const columnId = event.target.value;
    setShortlistColumn(plazaId, columnId);
    shortlistChanged(columnId ? `Añadida a ${shortlistColumnLabel(columnId)}` : "Plaza eliminada de la lista");
  });
  els.exploreTab.addEventListener("click", () => setWorkspace("explore"));
  els.boardTab.addEventListener("click", () => setWorkspace("board"));
  els.importShortlist.addEventListener("click", () => els.shortlistBackupFile.click());
  els.exportShortlistBackup.addEventListener("click", exportShortlistBackup);
  els.exportShortlist.addEventListener("click", exportShortlistCsv);
  els.shortlistBackupFile.addEventListener("change", () => importShortlistBackup(els.shortlistBackupFile.files?.[0]));
  els.closeDialog.addEventListener("click", () => els.plazaDialog.close());
  els.plazaDialog.addEventListener("click", (event) => {
    if (event.target === els.plazaDialog) els.plazaDialog.close();
  });
  els.plazaDialog.addEventListener("close", () => {
    state.dialogPlazaId = null;
  });
  setupBoardEvents();
}

init().catch((error) => {
  console.error(error);
  document.body.innerHTML = `<pre>${error.message}</pre>`;
});
