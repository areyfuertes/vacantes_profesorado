if (!window.L) {
  document.body.innerHTML = "<pre>Leaflet no se ha cargado. Revisa que /vendor/leaflet/leaflet.js exista.</pre>";
  throw new Error("Leaflet failed to load");
}

const state = {
  meta: null,
  centers: [],
  selected: null,
  home: null,
  markers: new Map(),
  homeMarker: null,
  radiusCircle: null,
  routeCache: new Map(),
  selectedRoute: null,
};

const els = {};
const filterIds = [
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
  for (const id of filterIds) {
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
  const vacancyColumn = params.get("vacancy_column") || "total_libres";
  const onlyAvailable = (params.get("only_available") || "1") === "1";
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
    if (!vacancies.length) continue;

    const selectedTotal = vacancies.reduce((sum, vacancy) => sum + Number(vacancy[vacancyColumn]), 0);
    centers.push({ ...center, distance_km: distance, selected_total: selectedTotal, vacancies });
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
    vacancy_column: vacancyColumn,
    vacancy_label: vacancyLabel,
    center_count: centers.length,
    vacancy_row_count: centers.reduce((sum, center) => sum + center.vacancies.length, 0),
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

function updateDependentFilters() {
  const th = els.th_id.value;
  const level = els.level_id.value;

  const municipalities = state.meta.municipalities.filter((item) => {
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

  const localities = state.meta.localities.filter((item) => {
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

function setupMeta(meta) {
  state.meta = meta;
  fillSelect(els.th_id, meta.territories, (item) => `${item.th_id} · ${item.th_name}`, (item) => item.th_id);
  fillSelect(els.level_id, meta.levels, (item) => `${item.level_id} · ${item.level_name}`, (item) => item.level_id);
  fillSelect(els.vacancy_column, meta.vacancy_columns, (item) => item.name, (item) => item.id, "Total libres");
  els.vacancy_column.value = "total_libres";
  updateDependentFilters();
}

function markerColor(total) {
  if (total >= 15) return "#0f766e";
  if (total >= 6) return "#285d8f";
  if (total >= 2) return "#a15c18";
  return "#607067";
}

function createMarker(center) {
  const html = `<div class="popup-title">${center.centro_name}</div>
    <div>${center.localidad_name}, ${center.th_name}</div>
    <div class="popup-total">${center.selected_total} ${state.currentLabel}</div>`;
  const marker = L.circleMarker([center.lat, center.lon], {
    radius: Math.max(7, Math.min(17, 6 + Math.sqrt(center.selected_total || 1) * 2)),
    color: "#ffffff",
    weight: 2,
    fillColor: markerColor(center.selected_total),
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
    fillColor: "#111827",
    fillOpacity: 0.95,
  }).addTo(map).bindPopup("Casa");
  state.radiusCircle = L.circle([state.home.lat, state.home.lon], {
    radius: Number(els.radius_km.value) * 1000,
    color: "#0f766e",
    weight: 1,
    fillColor: "#0f766e",
    fillOpacity: 0.08,
  }).addTo(map);
}

function renderList(data) {
  els.summaryTotal.textContent = data.total_selected;
  els.centerCount.textContent = `${data.center_count} centros`;
  els.rowCount.textContent = `${data.vacancy_row_count} filas`;
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
    button.innerHTML = `
      <div class="center-title">
        <span>${center.centro_name}</span>
        <span class="badge">${center.selected_total}</span>
      </div>
      <div class="meta">${distance}${center.localidad_name}, ${center.th_name}</div>
      <div class="meta">${center.vacancies.length} especialidades</div>
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
  if (state.home) params.set("origin", `${state.home.lat},${state.home.lon}`);
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

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return "";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function renderTravelSummary(center) {
  if (!state.home) {
    return `<div class="travel-summary muted-box">Pon tu casa para calcular la ruta.</div>`;
  }
  const route = state.selectedRoute;
  let carValue = "Calculando...";
  let carMeta = "OSRM";
  if (route?.status === "ok") {
    carValue = formatDuration(route.duration_seconds);
    carMeta = `${route.distance_km} km por carretera`;
  } else if (route && route.status !== "ok") {
    carValue = "No disponible";
    carMeta = "No se pudo calcular";
  }
  return `
    <div class="travel-summary">
      <div class="travel-metric">
        <span>Coche</span>
        <strong>${carValue}</strong>
        <small>${carMeta}</small>
        <a class="metric-link" href="${googleMapsModeLink(center, "driving")}" target="_blank" rel="noreferrer">Ruta coche</a>
      </div>
      <div class="travel-metric">
        <span>Transporte público</span>
        <strong>Google Maps</strong>
        <small>requiere abrir la ruta</small>
        <a class="metric-link" href="${googleMapsModeLink(center, "transit")}" target="_blank" rel="noreferrer">Ruta transporte público</a>
      </div>
    </div>
  `;
}

function renderSelected(center) {
  const distance = center.distance_km === null ? "" : `${center.distance_km.toFixed(1)} km · `;
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
    <table class="vacancy-table">
      <thead>
        <tr><th>Código</th><th>Especialidad</th><th>Nivel</th>${countHeader}</tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

async function loadRouteForSelected(center) {
  if (!state.home) return;
  const key = `${state.home.lat},${state.home.lon}|${center.lat},${center.lon}`;
  if (state.routeCache.has(key)) {
    state.selectedRoute = state.routeCache.get(key);
    if (state.selected === center) renderSelected(center);
    return;
  }
  const params = new URLSearchParams({
    from_lat: state.home.lat,
    from_lon: state.home.lon,
    to_lat: center.lat,
    to_lon: center.lon,
  });
  try {
    const route = await api(`/api/route?${params.toString()}`);
    state.routeCache.set(key, route);
    if (
      state.selected &&
      state.selected.centro_id === center.centro_id &&
      state.selected.centro_codigo === center.centro_codigo
    ) {
      state.selectedRoute = route;
      renderSelected(center);
    }
  } catch {
    const route = { status: "error" };
    state.routeCache.set(key, route);
    state.selectedRoute = route;
    if (state.selected === center) renderSelected(center);
  }
}

async function loadCenters() {
  const data = await api(`/api/centers?${paramsFromFilters().toString()}`);
  state.centers = data.centers;
  state.currentLabel = data.vacancy_label.toLowerCase();
  state.lastData = data;
  if (state.selected) {
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
    ...Object.values(comboConfigs).flatMap((config) => [config.inputId, config.listId]),
    "summaryTotal",
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
  ]) {
    els[id] = document.getElementById(id);
  }

  setupMeta(await api("/api/meta"));
  await loadCenters();

  const reload = debounce(async () => {
    updateDependentFilters();
    await loadCenters();
  });

  for (const id of filterIds) {
    const event = els[id].type === "search" || els[id].type === "range" ? "input" : "change";
    els[id].addEventListener(event, async () => {
      if (id === "radius_km") els.radiusValue.textContent = `${els.radius_km.value} km`;
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
    els.homeStatus.textContent = "";
    els.homeResults.replaceChildren();
    state.selectedRoute = null;
    await loadCenters();
  });
}

init().catch((error) => {
  console.error(error);
  document.body.innerHTML = `<pre>${error.message}</pre>`;
});
