"use strict";
(function () {
if (window.SETOMETRO_BLOQUEADO) return;

const SP = window.ESPECIES;
const $ = s => document.querySelector(s);
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const MESES = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
const DIAS = ["dom","lun","mar","mié","jue","vie","sáb"];
const esc = s => String(s ?? "").replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }
};
const spById = id => SP.find(s => s.id === id);
const shortName = sp => sp.name.split(" / ")[0];
const gmaps = (lat, lon) => `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(5)},${lon.toFixed(5)}`;

// ---------- estado ----------
const state = {
  sp: null, day: 0, area: null, layer: null, markers: null, run: 0,
  detail: null, detailRun: 0, detailLayer: null,
  finds: ls.get("setometro-hallazgos", []),
  watch: ls.get("setometro-vigiladas", []),
  watchRes: {}
};

// ---------- mapa ----------
const map = L.map("map", { zoomControl: true }).setView([40.86, -4.02], 11); // Valsaín / Guadarrama
const capas = {
  "Topográfico": L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { maxZoom: 17, attribution: "© OpenTopoMap, © OpenStreetMap" }),
  "Satélite": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 18, attribution: "© Esri" }),
  "Callejero": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" })
};
capas["Topográfico"].addTo(map);
const gbifLayer = L.layerGroup().addTo(map);
const findsLayer = L.layerGroup().addTo(map);
const geoLayer = L.tileLayer.wms("https://mapas.igme.es/gis/services/Cartografia_Geologica/IGME_Geode_50/MapServer/WMSServer", {
  layers: "1,3,2", format: "image/png", transparent: true, opacity: 0.55, attribution: "© IGME" });
L.control.layers(capas, { "Citas históricas (GBIF)": gbifLayer, "Mis hallazgos": findsLayer, "Mapa geológico (IGME)": geoLayer }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);

// ---------- utilidades de red ----------
async function fetchJSON(url, opt, timeout = 45000) {
  const c = new AbortController(); const tm = setTimeout(() => c.abort(), timeout);
  try { const r = await fetch(url, { ...opt, signal: c.signal }); if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e; } return await r.json(); }
  finally { clearTimeout(tm); }
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch { out[k] = null; } }
  }));
  return out;
}

// ---------- Open-Meteo: clima (caché 1 h por punto, reintento si hay límite) ----------
const wxCache = new Map();
const wxKey = p => p.lat.toFixed(3) + "," + p.lon.toFixed(3);
async function fetchWeather(pts, onWait) {
  const fresh = k => { const c = wxCache.get(k); return c && Date.now() - c.when < 36e5 ? c.data : null; };
  const missing = pts.filter(p => !fresh(wxKey(p)));
  for (let i = 0; i < missing.length; i += 60) {
    const ch = missing.slice(i, i + 60);
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${ch.map(p => p.lat.toFixed(4))}&longitude=${ch.map(p => p.lon.toFixed(4))}` +
      `&daily=precipitation_sum,temperature_2m_max,temperature_2m_min,et0_fao_evapotranspiration,wind_speed_10m_max&hourly=soil_moisture_3_to_9cm,soil_temperature_6cm,snow_depth` +
      `&past_days=30&forecast_days=14&timezone=auto`;
    let j;
    for (let intento = 0; ; intento++) {
      const r = await fetch(url);
      if (r.ok) { j = await r.json(); break; }
      let reason = ""; try { reason = (await r.json()).reason || ""; } catch {}
      if (r.status === 429 && intento < 3 && !/daily|hourly/i.test(reason)) { const s = 25 * (intento + 1); onWait && onWait(s); await sleep(s * 1000); continue; }
      const e = new Error(reason || "HTTP " + r.status); e.status = r.status; throw e;
    }
    const arr = Array.isArray(j) ? j : [j];
    ch.forEach((p, k) => wxCache.set(wxKey(p), { when: Date.now(), data: arr[k] }));
  }
  return pts.map(p => fresh(wxKey(p)));
}
async function fetchElevPts(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i += 100) {
    const ch = pts.slice(i, i + 100);
    const j = await fetchJSON(`https://api.open-meteo.com/v1/elevation?latitude=${ch.map(p => p[0].toFixed(5))}&longitude=${ch.map(p => p[1].toFixed(5))}`);
    out.push(...j.elevation);
  }
  return out;
}

// ---------- Overpass (OpenStreetMap) ----------
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"];
function overpass(q, timeout = 90000) {
  // se consultan todos los espejos a la vez y gana el primero que responda bien
  return Promise.any(OVERPASS.map(u => fetchJSON(u, { method: "POST", body: "data=" + encodeURIComponent(q),
    headers: { "Content-Type": "application/x-www-form-urlencoded" } }, timeout).then(j => j.elements)));
}
async function fetchOSM(b) {
  const cached = osmCacheGet(b);
  if (cached) return cached;
  const bb = `${b.s},${b.w},${b.n},${b.e}`;
  const els = await overpass(`[out:json][timeout:60];(
    way["landuse"="forest"](${bb});relation["landuse"="forest"](${bb});
    way["natural"="wood"](${bb});relation["natural"="wood"](${bb});
    way["natural"~"^(scrub|heath|grassland)$"](${bb});relation["natural"~"^(scrub|heath)$"](${bb});
    way["landuse"="meadow"](${bb});
  );out tags bb qt;`);
  const slim = els.filter(e => e.bounds && e.tags).map(e => {
    const t = {}; for (const k of ["landuse", "natural", "leaf_type", "wood", "genus", "species", "taxon"]) if (e.tags[k]) t[k] = e.tags[k];
    return { bounds: e.bounds, tags: t };
  });
  osmCacheSet(b, slim);
  return slim;
}
function osmCacheGet(b) {
  const all = ls.get("setometro-osm", []);
  const hit = all.find(x => x.b.s <= b.s && x.b.w <= b.w && x.b.n >= b.n && x.b.e >= b.e && Date.now() - x.when < 30 * 864e5);
  return hit ? hit.els : null;
}
function osmCacheSet(b, els) {
  const all = ls.get("setometro-osm", []);
  all.unshift({ b, when: Date.now(), els });
  while (all.length && !ls.set("setometro-osm", all)) all.pop();
}

// ---------- IGME: geología → tipo de suelo ----------
const geoCache = ls.get("setometro-geo", {});
function geoClass(desc) {
  const d = desc.toLowerCase();
  const calc = /calcar|caliz|dolom|marga|yeso|carbonat|travertin|creta|tob[ao]s? calc|lumaquel/.test(d);
  const acid = /granit|granod|gneis|esquist|pizarr|cuarcit|filit|arcosa|riolit|migmat|p[oó]rfid|cuarzo|tonalit|grauvac|lidit|arenisca|raña/.test(d);
  if (calc && acid) return { tipo: "mixto", ph: 6.8 };
  if (calc) return { tipo: "calizo", ph: 7.9 };
  if (acid) return { tipo: "ácido", ph: 5.3 };
  if (/basalt|ofita|gabro|diabas|andesit/.test(d)) return { tipo: "neutro", ph: 6.8 };
  if (/arena/.test(d)) return { tipo: "arenoso", ph: 5.9 };
  if (/arcilla|limo|grava|aluvi|coluvi|terraza|conglomer|glacis|cantos|morrena|fluvial/.test(d)) return { tipo: "sedimentos", ph: 6.6 };
  return { tipo: "sin clasificar", ph: null };
}
async function fetchGeo(lat, lon) {
  const k = lat.toFixed(3) + "," + lon.toFixed(3);
  if (k in geoCache) return geoCache[k];
  const e = 0.01;
  const u = `https://mapas.igme.es/gis/rest/services/Cartografia_Geologica/IGME_Geode_50/MapServer/identify?geometry=${lon},${lat}` +
    `&geometryType=esriGeometryPoint&sr=4326&layers=all:8&tolerance=1&mapExtent=${lon - e},${lat - e},${lon + e},${lat + e}&imageDisplay=100,100,96&returnGeometry=false&f=json`;
  const j = await fetchJSON(u, {}, 20000);
  const r = (j.results || []).find(x => x.layerId === 8) || (j.results || [])[0];
  const g = r && r.value ? { desc: r.value, ...geoClass(r.value) } : null;
  geoCache[k] = g;
  if (Object.keys(geoCache).length > 4000) for (const kk of Object.keys(geoCache).slice(0, 1000)) delete geoCache[kk];
  ls.set("setometro-geo", geoCache);
  return g;
}

// ---------- SoilGrids: pH y textura (servicio inestable) ----------
async function fetchSoil(lat, lon) {
  const url = `https://rest.isric.org/soilgrids/v2.0/properties/query?lon=${lon.toFixed(4)}&lat=${lat.toFixed(4)}&property=phh2o&property=sand&property=clay&depth=0-5cm&depth=5-15cm&value=mean`;
  const j = await fetchJSON(url, {}, 20000);
  const get = n => { const l = j.properties.layers.find(x => x.name === n); if (!l) return null;
    const v = l.depths.map(d => d.values.mean).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b) / v.length / l.unit_measure.d_factor : null; };
  const ph = get("phh2o");
  if (ph == null) throw new Error("sin datos");
  return { ph, sand: get("sand"), clay: get("clay") };
}

// ---------- GBIF: citas reales de cada especie ----------
const taxCache = {};
async function taxonKey(sp) {
  if (taxCache[sp.id]) return taxCache[sp.id];
  const j = await fetchJSON(`https://api.gbif.org/v1/species/match?name=${encodeURIComponent(sp.latin)}&kingdom=Fungi`);
  return (taxCache[sp.id] = j.acceptedUsageKey || j.usageKey);
}
async function gbifArea(sp, b) {
  const key = await taxonKey(sp), recs = [];
  for (let off = 0; off < 900; off += 300) {
    const j = await fetchJSON(`https://api.gbif.org/v1/occurrence/search?taxonKey=${key}&decimalLatitude=${b.s.toFixed(4)},${b.n.toFixed(4)}` +
      `&decimalLongitude=${b.w.toFixed(4)},${b.e.toFixed(4)}&hasCoordinate=true&hasGeospatialIssue=false&occurrenceStatus=PRESENT&limit=300&offset=${off}`);
    for (const o of j.results) {
      if (o.coordinateUncertaintyInMeters > 5000) continue;
      recs.push({ lat: o.decimalLatitude, lon: o.decimalLongitude, year: o.year, month: o.month,
        date: o.eventDate ? String(o.eventDate).slice(0, 10) : (o.year || "s/f"), key: o.key, src: o.datasetName || o.institutionCode || "" });
    }
    if (j.endOfRecords) break;
  }
  return recs;
}
const monthCache = {};
async function gbifMonths(sp) {
  if (monthCache[sp.id]) return monthCache[sp.id];
  const key = await taxonKey(sp);
  const j = await fetchJSON(`https://api.gbif.org/v1/occurrence/search?taxonKey=${key}&country=ES&limit=0&facet=month&facetLimit=12`);
  const m = new Array(12).fill(0);
  for (const c of ((j.facets || [])[0] || { counts: [] }).counts) m[+c.name - 1] = c.count;
  return (monthCache[sp.id] = { m, total: m.reduce((a, b) => a + b, 0) });
}

// ---------- Nominatim ----------
async function reverseGeo(lat, lon) {
  try { return await fetchJSON(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=12&lat=${lat}&lon=${lon}&accept-language=es`, {}, 15000); }
  catch { return null; }
}

// ---------- especies UI ----------
function curTimes() { return state.area ? state.area.times : null; }
function curMonth() {
  const T = curTimes();
  if (T) return +T[state.area.t0 + state.day].slice(5, 7);
  return new Date().getMonth() + 1;
}
const inSeason = (sp, m) => sp.months.includes(m);
function renderSpecies() {
  const m = curMonth();
  $("#species").innerHTML = [["otono", "Otoño"], ["primavera", "Primavera"]].map(([g, t]) => `
    <div class="grp"><div class="grp-t">${t}</div><div class="chips">
    ${SP.filter(s => s.grupo === g).map(s => `<button class="chip ${inSeason(s, m) ? "" : "off"}" data-id="${s.id}" aria-pressed="${state.sp && state.sp.id === s.id}" title="${s.latin}${inSeason(s, m) ? "" : " · fuera de temporada"}">${shortName(s)}</button>`).join("")}
    </div></div>`).join("");
}
$("#species").addEventListener("click", e => {
  const b = e.target.closest(".chip"); if (!b) return;
  state.sp = spById(b.dataset.id);
  renderSpecies(); renderCard(); recompute(); loadGbif();
});
function renderCard() {
  const s = state.sp, m = curMonth();
  const hosts = s.hosts.length ? s.hosts.join(", ") : "saprófita (no depende de un árbol)";
  $("#spCard").innerHTML = `
    <p class="sp-name">${s.name}</p><p class="sp-latin">${s.latin}</p>
    <dl class="facts">
      <dt>Temporada</dt><dd>${s.months.map(x => MESES[x - 1]).join(" · ")} ${inSeason(s, m) ? "✓" : "· fuera de temporada"}</dd>
      <dt>Árboles</dt><dd>${hosts}</dd>
      <dt>Altitud</dt><dd>${s.alt[0]}–${s.alt[1]} m</dd>
      <dt>Suelo</dt><dd>pH ${s.ph[0]}–${s.ph[1]} ${s.ph[1] <= 6.5 ? "(ácido: granito, pizarra…)" : s.ph[0] >= 6.5 ? "(calizo: caliza, marga…)" : "(tolerante)"}${s.arena ? " · arenoso" : ""}</dd>
      <dt>Temp. media</dt><dd>${s.temp[0]}–${s.temp[1]} °C${s.soilT ? ` · suelo ${s.soilT[0]}–${s.soilT[1]} °C` : ""}</dd>
      <dt>Lluvia</dt><dd>≥${s.rain30} mm/30 d, tormenta ≥${s.trigger} mm hace ~${s.lag[0]}–${s.lag[1]} d (según el calor acumulado)</dd>
      ${s.deshielo ? "<dt>Nieve</dt><dd>sale tras el deshielo</dd>" : ""}
      ${s.borde ? "<dt>Hábitat</dt><dd>prefiere bordes de bosque y claros</dd>" : ""}
    </dl>
    <div id="months"><p class="note">Cargando citas por mes de GBIF…</p></div>
    <p style="margin:10px 0">${s.nota}</p>
    <div class="warn">⚠ ${s.aviso}</div>
    <div id="photos"></div>`;
  const sp = s;
  loadPhotos(sp);
  if (state.yearSp !== sp) $("#yearBody").textContent = `Compara las lluvias y temperaturas del último mes con las de cada año desde 2005, y dice cómo fueron para ${shortName(sp)} los años más parecidos según las citas de GBIF.`;
  gbifMonths(sp).then(({ m: cnt, total }) => {
    if (state.sp !== sp) return;
    const max = Math.max(...cnt, 1);
    $("#months").innerHTML = `<h2 style="margin:6px 0 0">Citas reales en España por mes · GBIF (${total.toLocaleString("es")})</h2>
      <div class="months">${cnt.map((v, i) => `<i class="${sp.months.includes(i + 1) ? "in" : ""}" style="height:${Math.max(3, 100 * v / max)}%" title="${MESES[i]}: ${v} citas"></i>`).join("")}</div>
      <div class="months-l">${MESES.map(x => `<span>${x[0].toUpperCase()}</span>`).join("")}</div>`;
  }).catch(() => { if (state.sp === sp) $("#months").innerHTML = `<p class="note">GBIF no responde ahora mismo.</p>`; });
}

// ---------- día ----------
$("#day").addEventListener("input", e => { state.day = +e.target.value; dayLabel(); renderSpecies(); renderCard(); recompute(); });
function dayLabel() {
  let txt = state.day === 0 ? "Hoy" : state.day === 1 ? "Mañana" : `+${state.day} días`;
  const T = curTimes();
  if (T) { const d = new Date(T[state.area.t0 + state.day] + "T12:00"); txt += ` · ${DIAS[d.getDay()]} ${d.getDate()} ${MESES[d.getMonth()]}`; }
  if (state.day > 6) txt += " · previsión poco fiable";
  $("#dayOut").textContent = txt;
}

// ---------- búsqueda ----------
$("#searchForm").addEventListener("submit", async e => {
  e.preventDefault();
  const q = $("#q").value.trim(); if (!q) return;
  statusMsg("Buscando " + q + "…");
  try {
    const j = await fetchJSON("https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=es&q=" + encodeURIComponent(q), {}, 15000);
    if (!j.length) return statusMsg("No he encontrado ese lugar. Prueba con el nombre de un pueblo o sierra.", true);
    map.setView([+j[0].lat, +j[0].lon], 11);
    analyze();
  } catch { statusMsg("No se pudo buscar el lugar. Revisa la conexión.", true); }
});
$("#geo").addEventListener("click", () => {
  if (!navigator.geolocation) return statusMsg("Tu navegador no permite obtener la ubicación.", true);
  navigator.geolocation.getCurrentPosition(p => { map.setView([p.coords.latitude, p.coords.longitude], 11); analyze(); },
    () => statusMsg("No se pudo obtener tu ubicación.", true));
});

// ---------- estado de carga ----------
function statusMsg(t, err) { $("#status").innerHTML = `<p style="${err ? "color:var(--warn)" : ""}">${esc(t)}</p>`; }
function renderStatus() {
  const A = state.area; if (!A) return;
  const L_ = A.load, item = (n, v) => `<span class="${v.ok ? "ok" : v.err ? "err" : ""}">${v.ok ? "✓" : v.err ? "✗" : "…"} ${n}${v.txt ? " " + v.txt : ""}</span>`;
  const gb = A.gbif[state.sp.id];
  const g = Array.isArray(gb) ? { ok: true, txt: `(${gb.length})` } : gb === "error" ? { err: true } : {};
  $("#status").innerHTML = `<div class="ld">${item("Clima", L_.wx)}${item("Vegetación", L_.veg)}${item("Geología", L_.geo)}${item("Citas GBIF", g)}${L_.aemet ? item("Lluvia AEMET", L_.aemet) : ""}</div>
    <p>${A.cells.length} cuadrículas de ~${(A.grid.dLat * 111).toFixed(1)} km. Cambia de especie o día sin volver a descargar.</p>
    ${L_.veg.err ? `<p style="color:var(--warn)">OpenStreetMap está saturado: de momento se puntúa sin tipo de bosque. <button type="button" class="small" id="retryVeg">Reintentar vegetación</button></p>` : ""}`;
  const rb = $("#retryVeg");
  if (rb) rb.onclick = () => { A.load.veg = {}; renderStatus(); loadVeg(state.run, fetchOSM(A.b)); };
}

// ---------- hábitat desde OSM ----------
const CONIF = ["Pinus", "Abies", "Picea", "Juniperus", "Larix", "Cedrus", "Pseudotsuga", "Taxus"];
const BROAD = ["Quercus", "Fagus", "Castanea", "Betula", "Fraxinus", "Populus", "Ulmus", "Alnus", "Corylus", "Acer", "Salix", "Olea"];
function classify(t) {
  let g = (t.genus || t.species || t.taxon || "").split(/[\s;]/)[0];
  g = g ? g[0].toUpperCase() + g.slice(1).toLowerCase() : "";
  const lt = t.leaf_type || ({ coniferous: "needleleaved", deciduous: "broadleaved", mixed: "mixed" })[t.wood] || "";
  if (t.landuse === "forest" || t.natural === "wood") {
    if (g === "Eucalyptus") return { cls: "euca", g };
    if (lt === "needleleaved" || CONIF.includes(g)) return { cls: "conifer", g };
    if (lt === "broadleaved" || BROAD.includes(g)) return { cls: "broad", g };
    if (lt === "mixed") return { cls: "mixed", g };
    return { cls: "forest", g };
  }
  if (t.natural === "scrub" || t.natural === "heath") return { cls: "scrub", g };
  return { cls: "open", g };
}
function coverageFor(box, els) {
  const cov = {}, gen = {}, area = (box.n - box.s) * (box.e - box.w);
  for (const el of els || []) {
    const b = el.bounds;
    const ox = Math.min(b.maxlon, box.e) - Math.max(b.minlon, box.w), oy = Math.min(b.maxlat, box.n) - Math.max(b.minlat, box.s);
    if (ox <= 0 || oy <= 0) continue;
    const { cls, g } = classify(el.tags);
    const big = (b.maxlat - b.minlat) * (b.maxlon - b.minlon) > 25 * area ? 0.6 : 0.85; // el bbox sobreestima formas irregulares
    const f = ox * oy / area * big;
    cov[cls] = Math.min(1, (cov[cls] || 0) + f);
    if (g) gen[g] = Math.min(1, (gen[g] || 0) + f);
  }
  return { cov, gen, vegOk: !!els };
}
const HAB_ES = { conifer: "pinar/coníferas", broad: "frondosas", mixed: "bosque mixto", forest: "bosque", scrub: "matorral", open: "prado/pastizal", euca: "eucaliptal" };
function habitatScore(sp, c) {
  if (!c.vegOk) return { v: 0.5, txt: "vegetación pendiente", edge: 0 };
  let best = 0;
  for (const [cls, cov] of Object.entries(c.cov)) best = Math.max(best, (sp.hab[cls] || 0) * clamp(cov / 0.3));
  let host = null;
  for (const [g, cov] of Object.entries(c.gen)) if (sp.hosts.includes(g) && cov > 0.05) { best = Math.min(1, best + 0.2 * clamp(cov / 0.2)); host = g; }
  // borde de bosque: mezcla de bosque y claro/matorral
  const fc = Math.max(c.cov.conifer || 0, c.cov.broad || 0, c.cov.mixed || 0, c.cov.forest || 0);
  const oc = Math.max(c.cov.open || 0, c.cov.scrub || 0);
  const edge = clamp(Math.min(fc, oc) / 0.25);
  if (sp.borde) best = Math.min(1, best + 0.15 * edge);
  const tipos = Object.entries(c.cov).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${HAB_ES[k]} ${Math.round(v * 100)}%`);
  let txt = tipos.length ? tipos.join(", ") + (host ? ` · ${host}` : "") : "sin bosque ni prado cartografiado";
  if (edge > 0.5) txt += " · borde de bosque";
  return { v: best, txt, edge };
}

// ---------- clima por celda ----------
function dailyAgg(arr, d, fn) { const v = []; for (let h = d * 24; h < d * 24 + 24; h++) if (arr && arr[h] != null) v.push(arr[h]); return v.length ? fn(v) : null; }
const avg = v => v.reduce((a, b) => a + b) / v.length;
function prepWeather(cell, w) {
  const d = w.daily;
  cell.times = d.time;
  cell.P = d.precipitation_sum.map(x => x || 0);
  cell.P0 = cell.P.slice(); // lluvia del modelo sin corregir (para la corrección con AEMET)
  cell.Tx = d.temperature_2m_max; cell.Tn = d.temperature_2m_min;
  cell.ET = (d.et0_fao_evapotranspiration || []).map(x => x || 0);
  cell.WI = d.wind_speed_10m_max || [];
  cell.SM = d.time.map((_, i) => dailyAgg(w.hourly.soil_moisture_3_to_9cm, i, avg));
  cell.ST = d.time.map((_, i) => dailyAgg(w.hourly.soil_temperature_6cm, i, avg));
  cell.SN = d.time.map((_, i) => dailyAgg(w.hourly.snow_depth, i, v => Math.max(...v)));
}
const sum = (a, i, j) => { let s = 0; for (let k = Math.max(0, i); k <= j; k++) s += a[k] || 0; return s; };
const mean = (a, i, j) => { let s = 0, n = 0; for (let k = Math.max(0, i); k <= j; k++) if (a[k] != null) { s += a[k]; n++; } return n ? s / n : null; };
const trap = (x, lo, hi, fall) => x == null ? 0.5 : x < lo ? clamp(1 - (lo - x) / fall) : x > hi ? clamp(1 - (x - hi) / fall) : 1;
function phFactor(sp, ph, soft) {
  if (ph == null) return 1;
  const d = ph < sp.ph[0] ? sp.ph[0] - ph : ph > sp.ph[1] ? ph - sp.ph[1] : 0;
  return Math.max(soft ? 0.5 : 0.45, 1 - (soft ? 0.3 : 0.35) * d);
}
function monthNear(m, target) { const d = Math.abs(m - target) % 12; return Math.min(d, 12 - d) <= 1; }

function scoreCell(sp, c, t) {
  const p7 = sum(c.P, t - 6, t), p15 = sum(c.P, t - 14, t), p30 = sum(c.P, t - 29, t);
  const Tm = c.Tx.map((x, i) => (x + c.Tn[i]) / 2);
  // tormenta disparadora: se busca hacia atrás según los grados-día acumulados desde la lluvia (base 4 °C)
  const ddRate = Math.max(2, (sp.temp[0] + sp.temp[1]) / 2 - 4);
  const ddLo = sp.lag[0] * ddRate, ddHi = sp.lag[1] * ddRate;
  let trig = 0, trigAgo = null, trigDD = null, dd = 0;
  for (let d = t; d >= 2; d--) {
    if (d < t) dd += Math.max(0, (Tm[d + 1] ?? 4) - 4);
    if (dd > ddHi) break;
    if (dd >= ddLo) { const v = sum(c.P, d - 2, d); if (v > trig) { trig = v; trigAgo = t - d; trigDD = dd; } }
  }
  const tm7 = mean(Tm, t - 6, t);
  let frost = 0; for (let d = t - 6; d <= t; d++) if (c.Tn[d] < -1) frost++;
  const sm = mean(c.SM, t - 2, t), st = mean(c.ST, t - 2, t);

  // la lluvia de los últimos días todavía no ha dado setas: solo cuenta la que tiene "edad" suficiente
  const p30old = sum(c.P, t - 29, t - sp.lag[0]);
  const rain = 0.55 * Math.pow(clamp(trig / sp.trigger), 0.8) + 0.3 * Math.pow(clamp(p30old / (sp.rain30 * 0.8)), 0.8) + 0.15 * clamp(p15 / (sp.rain30 * 0.35));
  const pRecent = sum(c.P, t - sp.lag[0] + 1, t);
  let temp = trap(tm7, sp.temp[0], sp.temp[1], 5);
  if (sp.soilT) temp = 0.5 * temp + 0.5 * trap(st, sp.soilT[0], sp.soilT[1], 4);
  if (!sp.frostTol) temp *= clamp(1 - 0.12 * frost);
  const soil = sm == null ? 0.5 : clamp((sm - 0.10) / 0.18);
  const alt = trap(c.elev, sp.alt[0], sp.alt[1], 250);
  const hab = habitatScore(sp, c);
  const m = +c.times[t].slice(5, 7);
  const season = sp.months.includes(m) ? 1 : (sp.months.includes(m % 12 + 1) || sp.months.includes((m + 10) % 12 + 1)) ? 0.45 : 0.1;

  // nieve
  const snowNow = c.SN[t] || 0; let snowPast = 0; for (let d = Math.max(0, t - 30); d <= t - 3; d++) snowPast = Math.max(snowPast, c.SN[d] || 0);
  let snowF = 1, snowTxt = null;
  if (sp.deshielo) { snowF = snowNow > 0.05 ? 0.35 : snowPast > 0.05 ? 1.15 : 0.9; snowTxt = snowNow > 0.05 ? "aún nevado" : snowPast > 0.05 ? "deshielo reciente" : "sin nieve reciente"; }
  else if (snowNow > 0.05) { snowF = 0.3; snowTxt = "suelo nevado"; }

  // suelo: SoilGrids si lo hay, si no la geología del IGME
  const ph = c.soil ? c.soil.ph : c.geo ? c.geo.ph : null;
  let phF = phFactor(sp, ph, !c.soil);
  if (sp.arena && c.geo) phF *= /aren/.test(c.geo.tipo) || /arena|arcosa|granit/.test(c.geo.desc.toLowerCase()) ? 1.05 : 0.9;

  // historial: citas GBIF y hallazgos propios
  let histF = 1;
  if (c.hist) histF = 0.85 + 0.2 * (1 - Math.exp(-c.hist.n / 2)) + 0.15 * (1 - Math.exp(-c.hist.nSeason / 1.5));
  const findF = c.myFinds ? 1.15 : 1;

  // secado: balance lluvia − evaporación de 7 días y días de viento fuerte (cierzo, etc.)
  const et7 = c.ET && c.ET.length ? sum(c.ET, t - 6, t) : null;
  const bal7 = et7 == null ? null : p7 - et7;
  let windy = 0; for (let d = t - 4; d <= t; d++) if ((c.WI && c.WI[d]) > 40) windy++;
  const dryF = (bal7 == null ? 1 : clamp(1 + Math.min(0, bal7 + 8) / 50, 0.55, 1)) * Math.pow(0.94, windy);

  const water = rain * (0.7 + 0.3 * soil) * dryF;
  const cond = 0.6 * temp + 0.4 * alt;
  const score = Math.min(100, 100 * season * Math.pow(water, 0.9) * Math.sqrt(cond) * (0.2 + 0.8 * hab.v) * phF * snowF * histF * findF);
  return { score, rain, temp, soil, alt, hab, season, phF, snowF, snowTxt, histF, findF, water, dryF, bal7, et7, windy, p7, p15, p30, pRecent, trig, trigAgo, trigDD, tm7, frost, sm, st };
}

// ---------- análisis de la zona ----------
async function analyze() {
  if (map.getZoom() < 10) { statusMsg("Acércate un poco más al mapa (nivel de zoom 10 o más) para analizar una comarca.", true); return; }
  const btn = $("#analyze"); btn.disabled = true;
  const B = map.getBounds();
  const b = { s: B.getSouth(), n: B.getNorth(), w: B.getWest(), e: B.getEast() };
  const aspect = (b.e - b.w) * Math.cos((b.s + b.n) / 2 * Math.PI / 180) / (b.n - b.s);
  const cols = Math.round(clamp(7 * Math.sqrt(aspect), 4, 9)), rows = Math.round(clamp(7 / Math.sqrt(aspect), 4, 9));
  const dLon = (b.e - b.w) / cols, dLat = (b.n - b.s) / rows;
  const cells = [];
  for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) {
    const box = { s: b.s + r * dLat, n: b.s + (r + 1) * dLat, w: b.w + k * dLon, e: b.w + (k + 1) * dLon };
    cells.push({ i: cells.length, box, lat: (box.s + box.n) / 2, lon: (box.w + box.e) / 2, cov: {}, gen: {}, vegOk: false });
  }
  const run = ++state.run;
  clearDetail();
  statusMsg(`Descargando lluvia, temperatura, humedad del suelo, nieve y altitud de ${cells.length} zonas…`);
  const osmP = fetchOSM(b);
  const onWait = s => { if (run === state.run) statusMsg(`Open-Meteo pide esperar (límite de consultas por minuto). Reintentando en ${s} s…`); };
  const [wR, eR] = await Promise.allSettled([fetchWeather(cells, onWait), fetchElevPts(cells.map(c => [c.lat, c.lon]))]);
  btn.disabled = false;
  if (run !== state.run) return;
  if (wR.status !== "fulfilled") {
    const e = wR.reason || {};
    statusMsg(e.status === 429
      ? `Open-Meteo ha alcanzado el límite gratuito de consultas (${e.message}). Espera unos minutos y vuelve a analizar.`
      : `No se pudieron descargar los datos meteorológicos de Open-Meteo (${e.message || "sin conexión"}). Revisa la conexión y vuelve a intentarlo.` +
        (ls.get("setometro-salida", null) ? ` Si estás sin cobertura, pulsa "Abrir salida guardada" en Modo campo.` : ""), true);
    return;
  }
  const W = wR.value;
  state.area = { cells, b, times: W[0].daily.time, t0: 30, grid: { w: b.w, s: b.s, dLon, dLat, cols, rows }, gbif: {},
    load: { wx: { ok: true }, veg: {}, geo: {}, aemet: null } };
  cells.forEach((c, i) => { prepWeather(c, W[i]); c.elev = eR.status === "fulfilled" ? eR.value[i] : W[i].elevation; });
  markFinds();
  dayLabel(); renderSpecies(); renderCard(); renderStatus();
  recompute();
  loadGbif();
  loadGeo(run);
  applyAemet(run);
  await loadVeg(run, osmP);
}
$("#analyze").addEventListener("click", analyze);

async function loadVeg(run, osmP) {
  const A = state.area;
  try {
    const els = await osmP;
    if (run !== state.run) return;
    A.els = els;
    A.cells.forEach(c => Object.assign(c, coverageFor(c.box, els)));
    if (state.detail) state.detail.subs.forEach(s => Object.assign(s, coverageFor(s.box, els)));
    A.load.veg = { ok: true, txt: `(${els.length})` };
  } catch {
    if (run !== state.run) return;
    A.load.veg = { err: true };
  }
  renderStatus(); recompute2();
}
async function loadGeo(run) {
  const A = state.area;
  let n = 0;
  await pool(A.cells, 6, async c => { c.geo = await fetchGeo(c.lat, c.lon); if (c.geo) n++; });
  if (run !== state.run) return;
  A.load.geo = n ? { ok: true } : { err: true, txt: "(IGME no responde o fuera de España)" };
  renderStatus(); recompute2();
}
async function loadGbif() {
  const A = state.area, sp = state.sp; if (!A) return;
  if (A.gbif[sp.id]) return;
  A.gbif[sp.id] = "loading"; renderStatus();
  try { A.gbif[sp.id] = await gbifArea(sp, A.b); } catch { A.gbif[sp.id] = "error"; }
  if (state.area === A) { renderStatus(); if (state.sp === sp) recompute2(); }
}
function assignHist() {
  const A = state.area, recs = A.gbif[state.sp.id];
  const m = curMonth();
  for (const c of A.cells) c.hist = Array.isArray(recs) ? { n: 0, nSeason: 0 } : null;
  if (!Array.isArray(recs)) return [];
  const { w, s, dLon, dLat, cols, rows } = A.grid;
  for (const r of recs) {
    const k = Math.floor((r.lon - w) / dLon), rr = Math.floor((r.lat - s) / dLat);
    if (k < 0 || k >= cols || rr < 0 || rr >= rows) continue;
    const c = A.cells[rr * cols + k];
    c.hist.n++; if (r.month && monthNear(r.month, m)) c.hist.nSeason++;
  }
  return recs;
}
function markFinds() {
  const A = state.area; if (!A) return;
  for (const c of A.cells) c.myFinds = state.finds.filter(f => f.sp === state.sp.id && f.lat >= c.box.s && f.lat < c.box.n && f.lon >= c.box.w && f.lon < c.box.e).length;
}

function color(v) {
  const st = getComputedStyle(document.documentElement);
  return ["--s0", "--s1", "--s2", "--s3", "--s4"].map(k => st.getPropertyValue(k).trim())[Math.min(4, Math.floor(v / 20))];
}
const lvl = v => v >= 70 ? "Muy alta" : v >= 50 ? "Alta" : v >= 30 ? "Media" : v >= 15 ? "Baja" : "Muy baja";

function recompute() {
  const A = state.area; if (!A || !state.sp) return;
  const t = A.t0 + state.day, sp = state.sp;
  const recs = assignHist(); markFinds();
  A.cells.forEach(c => c.res = scoreCell(sp, c, t));
  if (state.layer) state.layer.remove();
  if (state.markers) state.markers.remove();
  state.layer = L.layerGroup().addTo(map);
  state.markers = L.layerGroup().addTo(map);
  for (const c of A.cells) {
    const v = c.res.score;
    c.rect = L.rectangle([[c.box.s, c.box.w], [c.box.n, c.box.e]], { color: color(v), weight: 0.6, fillColor: color(v), fillOpacity: v < 10 ? 0.05 : 0.18 + 0.42 * v / 100 })
      .addTo(state.layer).bindPopup(() => popup(c), { maxWidth: 330 });
    // puntuación abajo a la derecha de cada cuadrícula
    L.marker([c.box.s, c.box.e], { interactive: false, keyboard: false,
      icon: L.divIcon({ className: "", html: `<div class="cell-n">${Math.round(v)}</div>`, iconSize: [36, 16], iconAnchor: [39, 19] }) })
      .addTo(state.layer);
  }
  const top = [...A.cells].sort((a, b) => b.res.score - a.res.score).slice(0, 5);
  top.forEach((c, i) => L.marker([c.lat, c.lon], { icon: L.divIcon({ className: "", html: `<div class="marker-n">${i + 1}</div>`, iconSize: [26, 26] }) })
    .addTo(state.markers).bindPopup(() => popup(c), { maxWidth: 330, offset: [0, -6] }));
  $("#rank").innerHTML = top.map((c, i) => {
    const r = c.res;
    const why = [`${Math.round(r.p30)} mm/30d`, r.tm7 != null ? `${r.tm7.toFixed(0)} °C` : "", `${Math.round(c.elev)} m`, r.hab.txt.split(",")[0],
      c.geo ? `suelo ${c.geo.tipo}` : "", c.hist && c.hist.n ? `${c.hist.n} cita${c.hist.n > 1 ? "s" : ""}` : "", c.myFinds ? "★ tu hallazgo" : "", r.snowTxt || ""];
    return `<li data-i="${c.i}"><span class="num" style="background:${color(r.score)}">${i + 1}</span>
      <span class="rk-why"><b>${lvl(r.score)}</b> · ${why.filter(Boolean).join(" · ")}</span>
      <span class="rk-score">${Math.round(r.score)}</span></li>`;
  }).join("");
  drawGbif(recs);
  renderValidation(recs);
  renderDetail();
  renderFinds();
  if (state.me) renderField();
}
$("#rank").addEventListener("click", e => {
  const li = e.target.closest("li[data-i]"); if (!li) return;
  const c = state.area.cells[+li.dataset.i];
  map.setView([c.lat, c.lon], Math.max(map.getZoom(), 12));
  c.rect.openPopup([c.lat, c.lon]);
});
function recompute2() { // recalcula manteniendo abierta la ficha
  const open = state.area && state.area.cells.find(c => c.rect && c.rect.isPopupOpen());
  recompute();
  if (open) open.rect.openPopup([open.lat, open.lon]);
}

function drawGbif(recs) {
  gbifLayer.clearLayers();
  const m = curMonth();
  for (const r of recs) {
    const inS = r.month && monthNear(r.month, m);
    L.circleMarker([r.lat, r.lon], { radius: inS ? 5 : 3.5, color: "#fff", weight: 1, fillColor: inS ? "#7d2a12" : "#6b5a8e", fillOpacity: 0.9 })
      .bindPopup(`<b>${esc(state.sp.latin)}</b><br>Cita del ${esc(r.date)}${r.src ? `<br><span style="color:var(--muted)">${esc(r.src)}</span>` : ""}<br><a href="https://www.gbif.org/occurrence/${r.key}" target="_blank" rel="noopener">Ver en GBIF ↗</a>`)
      .addTo(gbifLayer);
  }
}
// validación: ¿caen las citas reales en las cuadrículas que el modelo considera buen hábitat?
function renderValidation(recs) {
  const A = state.area, sp = state.sp, el = $("#valid");
  if (!recs.length) { el.textContent = Array.isArray(A.gbif[sp.id]) ? "No hay citas de esta especie en GBIF dentro de la zona; la puntuación se basa solo en el modelo." : ""; return; }
  if (!A.cells.some(c => c.vegOk)) { el.textContent = `${recs.length} citas reales en la zona (puntos en el mapa).`; return; }
  const stat = c => (0.2 + 0.8 * habitatScore(sp, c).v) * trap(c.elev, sp.alt[0], sp.alt[1], 250) * phFactor(sp, c.geo ? c.geo.ph : null, true);
  const fav = new Set(A.cells.filter(c => stat(c) >= 0.6));
  const fc = fav.size / A.cells.length;
  let inFav = 0, tot = 0;
  for (const c of A.cells) if (c.hist) { tot += c.hist.n; if (fav.has(c)) inFav += c.hist.n; }
  if (tot < 5) { el.textContent = `${tot} citas reales en la zona: pocas para comprobar el modelo.`; return; }
  const fr = inFav / tot, lift = fc ? fr / fc : 0;
  el.innerHTML = `<b style="color:var(--fg)">Comprobación con datos reales:</b> el ${Math.round(fr * 100)} % de las ${tot} citas de GBIF cae en el ${Math.round(fc * 100)} % de la zona que el modelo marca como hábitat favorable. ` +
    (lift >= 1.3 ? "El modelo acierta bien aquí." : lift >= 1 ? "El modelo acierta solo en parte aquí." : "Aquí el modelo no distingue bien; fíate más de las citas (puntos en el mapa).");
}

// ---------- ¿qué sale hoy aquí? (todas las especies en una cuadrícula) ----------
function scoreAny(sp, c, t) {
  if (sp === state.sp) return scoreCell(sp, c, t).score; // la elegida, con sus citas: igual que en el mapa
  // el resto sin citas GBIF (solo están descargadas para la especie elegida)
  const h = c.hist, f = c.myFinds;
  c.hist = null;
  c.myFinds = state.finds.filter(x => x.sp === sp.id && x.lat >= c.box.s && x.lat < c.box.n && x.lon >= c.box.w && x.lon < c.box.e).length;
  const r = scoreCell(sp, c, t);
  c.hist = h; c.myFinds = f;
  return r.score;
}
function rankAt(c, t) { return SP.map(sp => ({ sp, v: scoreAny(sp, c, t) })).sort((a, b) => b.v - a.v); }
function rankHTML(c) {
  const t = state.area.t0 + state.day, rk = rankAt(c, t).slice(0, 6);
  return `<h2 style="margin:10px 0 6px">¿Qué sale ${state.day ? "ese día" : "hoy"} aquí?</h2>
    ${rk.map(({ sp, v }) => `<div class="bar"><button type="button" class="linklike" data-sp="${sp.id}" title="Ver ${esc(sp.latin)} en el mapa">${esc(shortName(sp))}</button><i><u style="width:${Math.round(v)}%;background:${color(Math.max(v, 30))}"></u></i><span>${Math.round(v)}</span></div>`).join("")}`;
}
// curva de los próximos 14 días: especie elegida + las dos mejores de la cuadrícula
function chartHTML(c) {
  const A = state.area, t0 = A.t0, N = Math.min(14, A.times.length - t0);
  const rk = rankAt(c, t0 + Math.min(state.day, N - 1)).map(x => x.sp);
  const sps = [state.sp, ...rk.filter(s => s !== state.sp).slice(0, 2)];
  const cols = ["var(--s4)", "var(--moss)", "var(--cep)"];
  const W = 280, H = 96, padL = 22, padB = 16, w = W - padL - 4, h = H - padB - 6;
  const x = i => padL + i * w / (N - 1), y = v => 6 + h - v / 100 * h;
  const series = sps.map(sp => Array.from({ length: N }, (_, i) => sp === state.sp ? scoreCell(sp, c, t0 + i).score : scoreAny(sp, c, t0 + i)));
  const path = vs => vs.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const grid = [0, 50, 100].map(v => `<line x1="${padL}" x2="${W - 4}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${padL - 4}" y="${y(v) + 3}" text-anchor="end" font-size="9" fill="var(--muted)">${v}</text>`).join("");
  const days = Array.from({ length: N }, (_, i) => i).filter(i => i % 2 === 0).map(i => {
    const d = new Date(A.times[t0 + i] + "T12:00");
    return `<text x="${x(i)}" y="${H - 3}" text-anchor="middle" font-size="9" fill="var(--muted)">${i ? d.getDate() : "hoy"}</text>`;
  }).join("");
  const unreliable = `<rect x="${x(7)}" y="6" width="${x(N - 1) - x(7)}" height="${h}" fill="var(--line)" opacity=".35"/>`;
  const cur = `<line x1="${x(state.day)}" x2="${x(state.day)}" y1="6" y2="${6 + h}" stroke="var(--fg)" stroke-dasharray="2 2" stroke-width="1"/>`;
  return `<h2 style="margin:10px 0 4px">Previsión 14 días</h2>
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Previsión de puntuación por especie">
      ${unreliable}${grid}${cur}${series.map((vs, k) => `<path d="${path(vs)}" fill="none" stroke="${cols[k]}" stroke-width="${k ? 1.6 : 2.4}" stroke-linejoin="round"/>`).join("")}${days}
    </svg>
    <div class="legend" style="flex-wrap:wrap;gap:4px 10px">${sps.map((sp, k) => `<span><b style="color:${cols[k]}">━</b> ${esc(shortName(sp))}</span>`).join("")}<span>· zona gris: previsión poco fiable</span></div>`;
}

// ---------- ficha de cuadrícula ----------
function popup(c) {
  const r = c.res, sp = state.sp;
  const bar = (n, v) => `<div class="bar"><span>${n}</span><i><u style="width:${Math.round(clamp(v) * 100)}%"></u></i><span>${Math.round(clamp(v) * 100)}</span></div>`;
  const T = state.area.times, t0 = state.area.t0;
  const div = document.createElement("div");
  div.innerHTML = `
    <div class="pp-h"><b>${lvl(r.score)} · ${shortName(sp)}</b><span class="pp-score" style="color:${color(Math.max(r.score, 40))}">${Math.round(r.score)}</span></div>
    ${bar("Lluvia", r.rain)}${bar("Temperatura", r.temp)}${bar("Humedad suelo", r.soil)}${bar("Altitud", r.alt)}${bar("Hábitat", r.hab.v)}${bar("Suelo/geología", (r.phF - 0.45) / 0.6)}
    ${r.season < 1 ? `<div class="warn" style="margin:6px 0">Fuera de temporada este mes (×${r.season}).</div>` : ""}
    <div class="pp-data">
      Lluvia: ${r.p7.toFixed(0)} mm/7d · ${r.p15.toFixed(0)} mm/15d · ${r.p30.toFixed(0)} mm/30d${state.day > 0 ? " (incluye previsión)" : ""}<br>
      Tormenta útil: ${r.trig > 1 ? `${r.trig.toFixed(0)} mm hace ${r.trigAgo} d (${Math.round(r.trigDD)} grados-día)` : "ninguna en la ventana de fructificación"}<br>
      ${r.pRecent >= sp.trigger ? `<b>Lluvia reciente: ${r.pRecent.toFixed(0)} mm → buena señal para dentro de ~${sp.lag[0]}–${sp.lag[1]} días</b><br>` : ""}
      T media 7d: ${r.tm7 != null ? r.tm7.toFixed(1) : "–"} °C · heladas: ${r.frost} · suelo ${r.st != null ? r.st.toFixed(1) : "–"} °C${r.snowTxt ? " · " + r.snowTxt : ""}<br>
      Humedad suelo: ${r.sm != null ? (r.sm * 100).toFixed(0) + " %" : "–"} · Altitud: ${Math.round(c.elev)} m<br>
      ${r.bal7 != null ? `Secado 7d: lluvia − evaporación = ${r.bal7 > 0 ? "+" : ""}${r.bal7.toFixed(0)} mm${r.windy ? ` · ${r.windy} día(s) de viento fuerte` : ""}${r.dryF < 0.95 ? ` → el monte se seca (×${r.dryF.toFixed(2)})` : ""}<br>` : ""}
      ${c.aemetK ? `Lluvia corregida con estaciones AEMET (×${c.aemetK.toFixed(2)})<br>` : ""}
      Vegetación: ${esc(r.hab.txt)}<br>
      Geología: ${c.geo ? `${esc(c.geo.desc)} → <b>${c.geo.tipo}</b>` : "sin datos"}<br>
      Citas GBIF: ${c.hist ? `${c.hist.n} (${c.hist.nSeason} en esta época)` : "cargando…"}${c.myFinds ? ` · ★ ${c.myFinds} hallazgo(s) tuyo(s)` : ""}
    </div>
    ${rankHTML(c)}
    ${chartHTML(c)}
    <div class="pp-act">
      <button type="button" class="solid" data-a="det">Analizar en detalle</button>
      <button type="button" data-a="watch">Vigilar</button>
      <button type="button" data-a="find">★ Hallazgo</button>
      <a href="${gmaps(c.lat, c.lon)}" target="_blank" rel="noopener">Google Maps ↗</a>
    </div>
    <form class="pp-form" hidden>
      <label>Especie <select name="sp">${SP.map(s => `<option value="${s.id}" ${s.id === sp.id ? "selected" : ""}>${shortName(s)}</option>`).join("")}</select></label>
      <label>Fecha <input type="date" name="date" min="${T[0]}" max="${T[t0]}" value="${T[t0]}"></label>
      <input type="text" name="nota" placeholder="Nota (opcional): ladera, cantidad…">
      <button type="submit" class="solid">Guardar en mi cuaderno</button>
    </form>`;
  div.querySelector('[data-a="det"]').onclick = () => analyzeDetail(c);
  div.querySelectorAll("[data-sp]").forEach(b => b.onclick = () => {
    state.sp = spById(b.dataset.sp); renderSpecies(); renderCard(); recompute(); loadGbif();
    c.rect.openPopup([c.lat, c.lon]);
  });
  div.querySelector('[data-a="watch"]').onclick = e => { addWatch(c); e.target.textContent = "Vigilada ✓"; e.target.disabled = true; };
  const form = div.querySelector("form");
  div.querySelector('[data-a="find"]').onclick = () => { form.hidden = !form.hidden; };
  form.onsubmit = e => { e.preventDefault(); addFind(c.lat, c.lon, form.sp.value, form.date.value, form.nota.value, c); map.closePopup(); };
  return div;
}

// ---------- análisis detallado de una cuadrícula ----------
const RUMBOS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
const rumbo = a => RUMBOS[Math.round(a / 45) % 8];
const soilWord = ph => ph < 5.5 ? "ácido" : ph < 6.5 ? "algo ácido" : ph < 7.5 ? "neutro" : "calizo";
const distM = (a, b, c, d) => Math.hypot((a - c) * 111320, (b - d) * 111320 * Math.cos(a * Math.PI / 180));

async function analyzeDetail(c) {
  map.closePopup();
  const N = 5, run = ++state.detailRun;
  const dLa = (c.box.n - c.box.s) / N, dLo = (c.box.e - c.box.w) / N;
  const subs = [];
  for (let r = 0; r < N; r++) for (let k = 0; k < N; k++) {
    const box = { s: c.box.s + r * dLa, n: c.box.s + (r + 1) * dLa, w: c.box.w + k * dLo, e: c.box.w + (k + 1) * dLo };
    subs.push({ box, lat: (box.s + box.n) / 2, lon: (box.w + box.e) / 2 });
  }
  map.fitBounds([[c.box.s, c.box.w], [c.box.n, c.box.e]], { padding: [20, 20] });
  $("#detail").hidden = false;
  $("#detailBody").innerHTML = `<p class="note">Calculando relieve, geología y vegetación de 25 puntos…</p>`;
  $("#detail").scrollIntoView({ behavior: "smooth", block: "nearest" });
  const off = 150 / 111320;
  const pts = subs.flatMap(s => { const ol = off / Math.cos(s.lat * Math.PI / 180);
    return [[s.lat, s.lon], [s.lat + off, s.lon], [s.lat - off, s.lon], [s.lat, s.lon + ol], [s.lat, s.lon - ol]]; });
  const [zR] = await Promise.allSettled([fetchElevPts(pts), pool(subs, 6, async s => { s.geo = await fetchGeo(s.lat, s.lon); })]);
  if (run !== state.detailRun) return;
  if (zR.status !== "fulfilled") { $("#detailBody").innerHTML = `<p class="note" style="color:var(--warn)">No se pudo descargar el relieve de Open-Meteo. Espera un minuto y vuelve a intentarlo.</p>`; return; }
  const z = zR.value;
  subs.forEach((s, i) => {
    const [z0, zN, zS, zE, zW] = z.slice(i * 5, i * 5 + 5);
    const dzdx = (zE - zW) / 300, dzdy = (zN - zS) / 300;
    s.elev = z0;
    s.slope = Math.atan(Math.hypot(dzdx, dzdy)) * 180 / Math.PI;
    s.aspect = (Math.atan2(-dzdx, -dzdy) * 180 / Math.PI + 360) % 360; // hacia dónde mira la ladera (0 = norte)
    Object.assign(s, coverageFor(s.box, state.area.els));
  });
  state.detail = { cell: c, subs, info: {} };
  renderDetail();
  // pistas, cortafuegos y espacios protegidos (OpenStreetMap) + comunidad autónoma
  const bb = `${c.box.s},${c.box.w},${c.box.n},${c.box.e}`;
  overpass(`[out:json][timeout:40];
    way["highway"~"^(track|path|unclassified|tertiary|secondary|primary|residential|service)$"](${bb});out geom qt;
    (way["man_made"="cutline"](${bb});way["landuse"="firebreak"](${bb}););out geom qt;
    (relation["boundary"~"^(protected_area|national_park)$"](${bb});way["boundary"="protected_area"](${bb});relation["leisure"="nature_reserve"](${bb});way["leisure"="nature_reserve"](${bb}););out tags bb qt;
    (way["landuse"~"^(forest|meadow)$"](${bb});relation["landuse"="forest"](${bb});way["natural"~"^(wood|scrub|heath|grassland)$"](${bb});relation["natural"~"^(wood|scrub|heath)$"](${bb}););out geom qt;`, 90000)
    .then(els => {
      if (run !== state.detailRun) return;
      const nodes = [], veg = [];
      for (const e of els) {
        const t = e.tags || {};
        if (e.geometry && (t.highway || t.man_made === "cutline" || t.landuse === "firebreak")) for (const g of e.geometry) nodes.push(g);
        else if (/^(forest|meadow)$/.test(t.landuse) || /^(wood|scrub|heath|grassland)$/.test(t.natural)) veg.push(e);
      }
      for (const s of subs) { let best = Infinity; for (const g of nodes) { const d = distM(s.lat, s.lon, g.lat, g.lon); if (d < best) best = d; } s.track = best; }
      if (veg.length) { exactCoverage(subs, veg); state.detail.info.vegExact = true; }
      state.detail.info.protected = [...new Set(els.filter(e => e.tags && e.tags.name && (/^(protected_area|national_park)$/.test(e.tags.boundary) || e.tags.leisure === "nature_reserve")).map(e => e.tags.name))];
      renderDetail();
    }).catch(() => { if (run === state.detailRun) { state.detail.info.osmErr = true; renderDetail(); } });
  reverseGeo(c.lat, c.lon).then(j => { if (run !== state.detailRun || !j) return; state.detail.info.place = j.address; renderDetail(); });
  // textura del suelo de los 3 mejores puntos (SoilGrids, ~5 consultas/min y a veces caído)
  const top = [...subs].sort((a, b) => b.res.score - a.res.score).slice(0, 3);
  for (const s of top) {
    if (run !== state.detailRun) return;
    s.soilLoading = true; renderDetail();
    try { s.soil = await fetchSoil(s.lat, s.lon); } catch { s.soilErr = true; }
    s.soilLoading = false;
    if (run === state.detailRun) renderDetail();
  }
}

// Cobertura con la forma real de cada mancha: se muestrean 7×7 puntos por subcuadrícula
// y se comprueba si caen dentro de cada polígono (regla par-impar sobre todos sus segmentos,
// que vale también para multipolígonos con huecos sin tener que unir los anillos).
function exactCoverage(subs, veg) {
  const feats = veg.map(e => {
    const lines = e.geometry ? [e.geometry] : (e.members || []).filter(m => m.geometry && m.role !== "subarea").map(m => m.geometry);
    const segs = [];
    let s = 90, n = -90, w = 180, ea = -180;
    for (const L_ of lines) for (let i = 0; i < L_.length; i++) {
      const p = L_[i]; if (!p) continue;
      s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lon); ea = Math.max(ea, p.lon);
      const q = L_[i + 1]; if (q) segs.push([p.lon, p.lat, q.lon, q.lat]);
    }
    return { ...classify(e.tags || {}), segs, bb: { s, n, w, e: ea } };
  }).filter(f => f.segs.length > 2);
  const inside = (f, x, y) => {
    if (y < f.bb.s || y > f.bb.n || x < f.bb.w || x > f.bb.e) return false;
    let odd = false;
    for (const [x1, y1, x2, y2] of f.segs) if ((y1 > y) !== (y2 > y) && x < x1 + (y - y1) * (x2 - x1) / (y2 - y1)) odd = !odd;
    return odd;
  };
  const K = 7;
  for (const sub of subs) {
    const cnt = {}, gcnt = {};
    for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) {
      const y = sub.box.s + (i + 0.5) * (sub.box.n - sub.box.s) / K, x = sub.box.w + (j + 0.5) * (sub.box.e - sub.box.w) / K;
      const seen = new Set(), gs = new Set();
      for (const f of feats) if (!seen.has(f.cls) || (f.g && !gs.has(f.g))) if (inside(f, x, y)) { seen.add(f.cls); if (f.g) gs.add(f.g); }
      for (const k of seen) cnt[k] = (cnt[k] || 0) + 1;
      for (const g of gs) gcnt[g] = (gcnt[g] || 0) + 1;
    }
    sub.cov = {}; sub.gen = {};
    for (const k in cnt) sub.cov[k] = cnt[k] / (K * K);
    for (const g in gcnt) sub.gen[g] = gcnt[g] / (K * K);
    sub.vegOk = true; sub.vegExact = true;
  }
}

function scoreSub(sp, s, c) {
  const cr = c.res;
  const dT = -0.0065 * (s.elev - c.elev); // −0,65 °C cada 100 m
  let temp = trap(cr.tm7 == null ? null : cr.tm7 + dT, sp.temp[0], sp.temp[1], 5);
  if (sp.soilT) temp = 0.5 * temp + 0.5 * trap(cr.st == null ? null : cr.st + dT, sp.soilT[0], sp.soilT[1], 4);
  if (!sp.frostTol) temp *= clamp(1 - 0.12 * cr.frost);
  const alt = trap(s.elev, sp.alt[0], sp.alt[1], 250);
  const hab = habitatScore(sp, s);
  // orientación: en tiempo seco ganan las umbrías (norte); si hace frío para la especie, las solanas (sur)
  const north = Math.cos(s.aspect * Math.PI / 180), flat = clamp(s.slope / 10);
  const frio = cr.tm7 != null && cr.tm7 + dT < sp.temp[0];
  const pref = frio ? -0.8 : 0.3 + 0.6 * (1 - cr.water);
  const aspF = clamp(0.55 + 0.45 * (0.5 + 0.5 * north * pref * flat * 1.6), 0.3, 1.1);
  const slopeF = s.slope > 30 ? clamp(1 - (s.slope - 30) / 20, 0.3) : 1;
  // acceso: distancia a pista o camino
  const accF = s.track == null ? 1 : s.track < 300 ? 1 : s.track < 1500 ? 1 - 0.15 * (s.track - 300) / 1200 : 0.8;
  // suelo: SoilGrids (pH, textura) si responde; si no, geología IGME
  const ph = s.soil ? s.soil.ph : s.geo ? s.geo.ph : null;
  let soilF = phFactor(sp, ph, !s.soil);
  if (sp.arena && s.soil && s.soil.sand != null) soilF *= 0.8 + 0.2 * clamp((s.soil.sand - 35) / 30);
  if (s.soil && s.soil.clay != null && cr.water < 0.5) soilF *= 0.95 + 0.1 * clamp((s.soil.clay - 15) / 20);
  // historial dentro del punto
  const recs = Array.isArray(state.area.gbif[sp.id]) ? state.area.gbif[sp.id] : [];
  const inBox = p => p.lat >= s.box.s && p.lat < s.box.n && p.lon >= s.box.w && p.lon < s.box.e;
  s.nGbif = recs.filter(inBox).length;
  s.nFind = state.finds.filter(f => f.sp === sp.id && inBox(f)).length;
  const histF = (0.9 + 0.2 * (1 - Math.exp(-s.nGbif / 2))) * (s.nFind ? 1.15 : 1);
  const score = 100 * cr.season * Math.pow(cr.water, 0.9) * Math.sqrt(0.6 * temp + 0.4 * alt) * (0.2 + 0.8 * hab.v) * aspF * slopeF * accF * soilF * cr.snowF * histF;
  return { score: Math.min(100, score), hab, aspPref: frio ? "solana" : "umbría" };
}

function renderDetail() {
  const D = state.detail; if (!D || !state.sp || !state.area) return;
  const sp = state.sp, c = D.cell;
  D.subs.forEach(s => s.res = scoreSub(sp, s, c));
  if (state.detailLayer) state.detailLayer.remove();
  state.detailLayer = L.layerGroup().addTo(map);
  for (const s of D.subs) {
    L.rectangle([[s.box.s, s.box.w], [s.box.n, s.box.e]], { color: color(s.res.score), weight: 1, dashArray: "3 3", fillColor: color(s.res.score), fillOpacity: 0.12 + 0.5 * s.res.score / 100 })
      .addTo(state.detailLayer).bindTooltip(`${Math.round(s.res.score)} · ${Math.round(s.elev)} m · ladera ${rumbo(s.aspect)} ${s.slope.toFixed(0)}°${s.geo ? " · " + s.geo.tipo : ""}`);
  }
  const top = [...D.subs].sort((a, b) => b.res.score - a.res.score).slice(0, 3);
  const letras = ["A", "B", "C"];
  top.forEach((s, i) => L.marker([s.lat, s.lon], { icon: L.divIcon({ className: "", html: `<div class="marker-n" style="background:var(--moss)">${letras[i]}</div>`, iconSize: [26, 26] }) }).addTo(state.detailLayer));
  const r = c.res, I = D.info, place = I.place || {};
  const region = place.state || "";
  const municipio = place.village || place.town || place.city || place.municipality || "";
  let norma = region === "Castilla y León"
    ? `En Castilla y León muchos montes tienen la recolección regulada (programa Micocyl): necesitas un permiso. Consulta micocyl.es.`
    : `Consulta la normativa de recolección de ${region ? "la comunidad (" + esc(region) + ")" : "tu comunidad autónoma"} y del ayuntamiento${municipio ? " de " + esc(municipio) : ""}; en fincas privadas necesitas permiso del propietario.`;
  if (I.protected && I.protected.length) norma += ` <b>Espacios protegidos en la cuadrícula:</b> ${I.protected.map(esc).join(", ")}. En ellos suele haber límites o prohibición de recolectar.`;
  $("#detailBody").innerHTML = `
    <p class="note">${municipio ? `<b style="color:var(--fg)">${esc(municipio)}</b> · ` : ""}25 puntos de ~${((c.box.n - c.box.s) / 5 * 111).toFixed(1)} km.
    ${top[0].res.aspPref === "umbría"
      ? `Con ${Math.round(r.p30)} mm en 30 días ganan las <b>umbrías (laderas norte)</b>, que guardan más la humedad.`
      : `Con ${r.tm7 != null ? r.tm7.toFixed(0) : "–"} °C de media hace frío para esta especie: ganan las <b>solanas (laderas sur)</b>.`}
    ${I.osmErr ? " Pistas, espacios protegidos y forma exacta de los bosques no disponibles (OpenStreetMap saturado)." : I.vegExact ? " Vegetación calculada con la forma real de cada bosque." : " Cargando la forma real de los bosques…"}</p>
    <ol class="rank">${top.map((s, i) => {
      const soil = s.soil ? `pH ${s.soil.ph.toFixed(1)} (${soilWord(s.soil.ph)}), arena ${Math.round(s.soil.sand)} %, arcilla ${Math.round(s.soil.clay)} %`
        : s.soilLoading ? "consultando textura…" : "";
      const why = [`ladera ${rumbo(s.aspect)} ${s.slope.toFixed(0)}°`, `${Math.round(s.elev)} m`, esc(s.res.hab.txt),
        s.geo ? `${esc(s.geo.desc.split(".")[0])} → <b>${s.geo.tipo}</b>` : "", soil,
        s.track != null && isFinite(s.track) ? `a ${s.track < 1000 ? Math.round(s.track / 10) * 10 + " m" : (s.track / 1000).toFixed(1) + " km"} de pista` : "",
        s.nGbif ? `${s.nGbif} citas GBIF` : "", s.nFind ? "★ tu hallazgo" : ""].filter(Boolean).join(" · ");
      return `<li data-k="${D.subs.indexOf(s)}"><span class="num" style="background:var(--moss)">${letras[i]}</span>
        <span class="rk-why">${why}<br><a href="${gmaps(s.lat, s.lon)}" target="_blank" rel="noopener">Abrir en Google Maps ↗</a></span>
        <span class="rk-score">${Math.round(s.res.score)}</span></li>`;
    }).join("")}</ol>
    <div class="warn" style="margin-top:10px">${norma}</div>`;
}
$("#detailBody").addEventListener("click", e => {
  const li = e.target.closest("li[data-k]"); if (!li || e.target.closest("a")) return;
  const s = state.detail.subs[+li.dataset.k];
  map.setView([s.lat, s.lon], 14);
});
$("#detailClose").addEventListener("click", clearDetail);
function clearDetail() {
  state.detailRun++; state.detail = null;
  if (state.detailLayer) state.detailLayer.remove();
  $("#detail").hidden = true;
}

// ---------- cuaderno de hallazgos ----------
function condAt(cell, spId, date) {
  const sp = spById(spId), t = cell.times.indexOf(date);
  if (t < 0) return null;
  const r = scoreCell(sp, cell, t);
  return { p30: r.p30, trig: r.trig, tm7: r.tm7, sm: r.sm };
}
function addFind(lat, lon, spId, date, nota, cell) {
  const f = { id: Date.now().toString(36), sp: spId, lat, lon, date, nota: nota.trim(), cond: cell ? condAt(cell, spId, date) : null };
  state.finds.unshift(f);
  ls.set("setometro-hallazgos", state.finds);
  recompute2();
}
function similarity(f) {
  const A = state.area; if (!A || !f.cond) return null;
  const c = A.cells.find(c => f.lat >= c.box.s && f.lat < c.box.n && f.lon >= c.box.w && f.lon < c.box.e);
  if (!c) return null;
  const r = scoreCell(spById(f.sp), c, A.t0 + state.day);
  const s = [1 - Math.abs(r.p30 - f.cond.p30) / 60, 1 - Math.abs(r.trig - f.cond.trig) / 25];
  if (r.tm7 != null && f.cond.tm7 != null) s.push(1 - Math.abs(r.tm7 - f.cond.tm7) / 5);
  return clamp(avg(s.map(x => clamp(x))));
}
function renderFinds() {
  findsLayer.clearLayers();
  for (const f of state.finds) {
    L.marker([f.lat, f.lon], { icon: L.divIcon({ className: "", html: `<div class="marker-star">★</div>`, iconSize: [22, 22] }) })
      .bindPopup(`<b>${esc(shortName(spById(f.sp)))}</b> · ${esc(f.date)}${f.nota ? "<br>" + esc(f.nota) : ""}`).addTo(findsLayer);
  }
  if (!state.finds.length) { $("#findList").innerHTML = `<li><span></span><span class="rk-why">Aún no hay hallazgos. Abre una cuadrícula y pulsa "★ Hallazgo".</span><span></span></li>`; return; }
  $("#findList").innerHTML = state.finds.map(f => {
    const sim = similarity(f);
    return `<li class="${sim != null && sim >= 0.75 ? "hot" : ""}"><span class="marker-star" style="font-size:18px">★</span>
      <span class="rk-why"><b>${esc(shortName(spById(f.sp)))}</b> · ${esc(f.date)}${f.nota ? " · " + esc(f.nota) : ""}<br>
      ${f.cond ? `Ese día: ${Math.round(f.cond.p30)} mm/30d, ${f.cond.tm7 != null ? f.cond.tm7.toFixed(0) + " °C" : ""}` : ""}
      ${sim != null ? `<br><b>${state.day ? "Ese día" : "Hoy"}: condiciones parecidas al ${Math.round(sim * 100)} %</b>${sim >= 0.75 ? " ¡se repiten!" : ""}` : ""}
      · <a href="#" data-go="${f.id}">ver</a></span>
      <button type="button" class="small" data-del="${f.id}" aria-label="Borrar hallazgo">✕</button></li>`;
  }).join("");
}
$("#findList").addEventListener("click", e => {
  const d = e.target.closest("[data-del]"), g = e.target.closest("[data-go]");
  if (d) { state.finds = state.finds.filter(f => f.id !== d.dataset.del); ls.set("setometro-hallazgos", state.finds); recompute2(); renderFinds(); }
  if (g) { e.preventDefault(); const f = state.finds.find(x => x.id === g.dataset.go); map.setView([f.lat, f.lon], 13); }
});
$("#expBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ hallazgos: state.finds, vigiladas: state.watch }, null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "setometro-cuaderno.json"; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
$("#impFile").addEventListener("change", async e => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const j = JSON.parse(await file.text());
    const ids = new Set(state.finds.map(f => f.id));
    state.finds.push(...(j.hallazgos || []).filter(f => !ids.has(f.id)));
    const wids = new Set(state.watch.map(w => w.id));
    state.watch.push(...(j.vigiladas || []).filter(w => !wids.has(w.id)));
    ls.set("setometro-hallazgos", state.finds); ls.set("setometro-vigiladas", state.watch);
    renderFinds(); renderWatch(); recompute2(); checkWatch();
  } catch { alert("El archivo no es un cuaderno de Setómetro válido."); }
  e.target.value = "";
});

// ---------- zonas vigiladas y avisos ----------
function addWatch(c) {
  const w = { id: Date.now().toString(36), sp: state.sp.id, lat: c.lat, lon: c.lon, elev: c.elev, cov: c.cov, gen: c.gen, vegOk: c.vegOk, geo: c.geo || null,
    umbral: 60, name: `${c.lat.toFixed(3)}, ${c.lon.toFixed(3)}` };
  state.watch.push(w); ls.set("setometro-vigiladas", state.watch);
  reverseGeo(c.lat, c.lon).then(j => {
    const a = j && j.address; if (!a) return;
    w.name = a.village || a.town || a.city || a.municipality || a.county || w.name;
    ls.set("setometro-vigiladas", state.watch); renderWatch();
  });
  checkWatch();
}
async function checkWatch() {
  if (!state.watch.length) { renderWatch(); return; }
  renderWatch();
  try {
    const W = await fetchWeather(state.watch);
    state.watch.forEach((w, i) => {
      const cell = { ...w, cov: w.cov || {}, gen: w.gen || {} }; prepWeather(cell, W[i]);
      const sp = spById(w.sp); let best = -1, bestT = 30;
      for (let t = 30; t <= 36; t++) { const s = scoreCell(sp, cell, t).score; if (s > best) { best = s; bestT = t; } }
      state.watchRes[w.id] = { best, date: cell.times[bestT], today: scoreCell(sp, cell, 30).score, rainNext: sum(cell.P, 31, 36), lag: sp.lag, trigger: sp.trigger };
    });
  } catch { state.watch.forEach(w => state.watchRes[w.id] = { err: true }); }
  renderWatch(); notifyWatch();
}
function renderWatch() {
  if (!state.watch.length) { $("#watchList").innerHTML = `<li><span></span><span class="rk-why">No vigilas ninguna zona todavía.</span><span></span></li>`; return; }
  $("#watchList").innerHTML = state.watch.map(w => {
    const r = state.watchRes[w.id], sp = spById(w.sp);
    const hot = r && !r.err && r.best >= w.umbral;
    const d = r && r.date ? new Date(r.date + "T12:00") : null;
    return `<li class="${hot ? "hot" : ""}"><span class="num" style="background:${r && !r.err ? color(r.best) : "var(--line)"}">${r && !r.err ? Math.round(r.best) : "…"}</span>
      <span class="rk-why"><b>${esc(w.name)}</b> · ${esc(shortName(sp))}<br>
      ${!r ? "comprobando…" : r.err ? "no se pudo comprobar" : `hoy ${Math.round(r.today)} · máximo ${Math.round(r.best)} el ${DIAS[d.getDay()]} ${d.getDate()}`}
      ${hot ? " · <b>¡supera tu umbral!</b>" : ""}
      ${r && !r.err && r.rainNext >= r.trigger ? `<br>Lluvia prevista: ${Math.round(r.rainNext)} mm → buena señal para dentro de ~${r.lag[0]}–${r.lag[1]} días` : ""}<br>
      avisar desde <select data-um="${w.id}" aria-label="Umbral">${[40, 50, 60, 70, 80].map(u => `<option ${u === w.umbral ? "selected" : ""}>${u}</option>`).join("")}</select>
      · <a href="#" data-go="${w.id}">ver</a></span>
      <button type="button" class="small" data-del="${w.id}" aria-label="Dejar de vigilar">✕</button></li>`;
  }).join("");
}
$("#watchList").addEventListener("change", e => {
  const s = e.target.closest("[data-um]"); if (!s) return;
  const w = state.watch.find(x => x.id === s.dataset.um); w.umbral = +s.value;
  ls.set("setometro-vigiladas", state.watch); renderWatch(); notifyWatch();
});
$("#watchList").addEventListener("click", e => {
  const d = e.target.closest("[data-del]"), g = e.target.closest("[data-go]");
  if (d) { state.watch = state.watch.filter(w => w.id !== d.dataset.del); ls.set("setometro-vigiladas", state.watch); renderWatch(); }
  if (g) { e.preventDefault(); const w = state.watch.find(x => x.id === g.dataset.go); state.sp = spById(w.sp); renderSpecies(); renderCard(); map.setView([w.lat, w.lon], 12); analyze(); }
});
function notifyWatch() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const today = new Date().toISOString().slice(0, 10);
  const sent = ls.get("setometro-avisados", {});
  for (const w of state.watch) {
    const r = state.watchRes[w.id];
    if (!r || r.err || r.best < w.umbral || sent[w.id] === today) continue;
    new Notification(`Setómetro: ${shortName(spById(w.sp))} en ${w.name}`, { body: `Puntuación ${Math.round(r.best)} prevista para el ${r.date}. Supera tu umbral de ${w.umbral}.`, icon: "icon.svg" });
    sent[w.id] = today;
  }
  ls.set("setometro-avisados", sent);
}
function renderNotifBtn() {
  const b = $("#notifBtn");
  if (!("Notification" in window)) { b.hidden = true; return; }
  b.textContent = Notification.permission === "granted" ? "Avisos activados ✓" : Notification.permission === "denied" ? "Avisos bloqueados" : "Activar avisos";
  b.disabled = Notification.permission !== "default";
}
$("#notifBtn").addEventListener("click", async () => { try { await Notification.requestPermission(); } catch {} renderNotifBtn(); notifyWatch(); });
setInterval(checkWatch, 3 * 36e5);

// ---------- fotos de Wikimedia Commons ----------
const photoCache = {};
async function commonsPhotos(latin, n) {
  const ck = latin + "|" + n;
  if (photoCache[ck]) return photoCache[ck];
  const api = "https://commons.wikimedia.org/w/api.php?format=json&origin=*&action=query&prop=imageinfo&iiprop=url|extmetadata|mime&iiurlwidth=360";
  let imgs = [];
  try {
    const j = await fetchJSON(`${api}&generator=categorymembers&gcmtitle=${encodeURIComponent("Category:" + latin)}&gcmtype=file&gcmlimit=${n * 4}`, {}, 15000);
    imgs = Object.values((j.query && j.query.pages) || {}).map(p => p.imageinfo && p.imageinfo[0]).filter(i => i && /jpeg|png/.test(i.mime));
  } catch {}
  if (!imgs.length) { // si no hay categoría, la foto principal del artículo de Wikipedia
    try {
      const j = await fetchJSON(`https://es.wikipedia.org/w/api.php?format=json&origin=*&action=query&redirects=1&prop=pageimages&piprop=name&titles=${encodeURIComponent(latin)}`, {}, 15000);
      const pg = Object.values(j.query.pages)[0];
      if (pg && pg.pageimage) {
        const k = await fetchJSON(`${api}&titles=${encodeURIComponent("File:" + pg.pageimage)}`, {}, 15000);
        imgs = Object.values(k.query.pages).map(p => p.imageinfo && p.imageinfo[0]).filter(Boolean);
      }
    } catch {}
  }
  const strip = h => String(h || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  return (photoCache[ck] = imgs.slice(0, n).map(i => ({ src: i.thumburl || i.url, page: i.descriptionurl,
    autor: strip(i.extmetadata && i.extmetadata.Artist && i.extmetadata.Artist.value).slice(0, 40),
    lic: strip(i.extmetadata && i.extmetadata.LicenseShortName && i.extmetadata.LicenseShortName.value) })));
}
async function loadPhotos(sp) {
  const el = $("#photos"); if (!el) return;
  el.innerHTML = `<p class="note">Cargando fotos…</p>`;
  const [own, ...bad] = await Promise.all([commonsPhotos(sp.latin, 3), ...sp.parecidas.map(p => commonsPhotos(p.latin, 1))]);
  if (state.sp !== sp || !$("#photos")) return;
  const fig = (ph, cap, cls = "") => ph ? `<figure class="${cls}"><a href="${esc(ph.page)}" target="_blank" rel="noopener"><img src="${esc(ph.src)}" alt="" loading="lazy"></a>
    <figcaption>${cap}<br><a href="${esc(ph.page)}" target="_blank" rel="noopener">${esc(ph.autor || "Wikimedia")}${ph.lic ? " · " + esc(ph.lic) : ""}</a></figcaption></figure>` : "";
  $("#photos").innerHTML = `<h2 style="margin:12px 0 0">Fotos · Wikimedia Commons</h2>
    ${own.length ? `<div class="photos">${own.map(p => fig(p, `<i>${esc(sp.latin)}</i>`)).join("")}</div>` : `<p class="note">Sin fotos disponibles ahora mismo.</p>`}
    ${sp.parecidas.length ? `<h2 style="margin:10px 0 0">No confundir con</h2><div class="photos">${sp.parecidas.map((p, i) =>
      fig(bad[i][0], `<b>${esc(p.nivel.toUpperCase())}</b> · <i>${esc(p.latin)}</i>`, "bad") ||
      `<figure class="bad"><figcaption><b>${esc(p.nivel.toUpperCase())}</b> · <i>${esc(p.latin)}</i> (sin foto)</figcaption></figure>`).join("")}</div>` : ""}`;
}

// ---------- ¿es buen año? ----------
const fmtD = d => `${+d.slice(8, 10)} ${MESES[+d.slice(5, 7) - 1]}`;
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
async function goodYear() {
  const A = state.area, sp = state.sp, el = $("#yearBody");
  if (!A) { el.textContent = "Analiza primero una zona."; return; }
  state.yearSp = sp;
  $("#yearBtn").disabled = true;
  el.textContent = "Descargando el clima de este periodo en cada año desde 2005 y las citas por año de GBIF…";
  const lat = (A.b.s + A.b.n) / 2, lon = (A.b.w + A.b.e) / 2;
  const end = new Date(A.times[A.t0 - 6] + "T12:00:00Z"); // el histórico de Open-Meteo va con unos días de retraso
  const thisYear = end.getUTCFullYear();
  const iso = d => d.toISOString().slice(0, 10);
  const win = y => { const e = new Date(end); e.setUTCFullYear(y); const s = new Date(e); s.setUTCDate(s.getUTCDate() - 29); return [iso(s), iso(e)]; };
  const years = []; for (let y = 2005; y <= thisYear; y++) years.push(y);
  const ck = ls.get("setometro-clima", {});
  const clim = await pool(years, 3, async y => {
    const [s, e] = win(y), k = `${lat.toFixed(2)},${lon.toFixed(2)},${s}`;
    if (ck[k] && y < thisYear) return ck[k];
    const j = await fetchJSON(`https://archive-api.open-meteo.com/v1/archive?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&start_date=${s}&end_date=${e}&daily=precipitation_sum,temperature_2m_mean`, {}, 30000);
    const P = j.daily.precipitation_sum.filter(x => x != null), T = j.daily.temperature_2m_mean.filter(x => x != null);
    return (ck[k] = { y, p: P.reduce((a, b) => a + b, 0), t: T.length ? avg(T) : null, n: P.length });
  });
  ls.set("setometro-clima", ck);
  $("#yearBtn").disabled = false;
  if (state.yearSp !== sp) return;
  const ok = clim.filter(r => r && r.n >= 25 && r.t != null);
  const cur = ok.find(r => r.y === thisYear), past = ok.filter(r => r.y < thisYear);
  if (!cur || past.length < 8) { el.textContent = "No se pudo descargar suficiente histórico de Open-Meteo. Inténtalo de nuevo en un rato."; return; }
  const pMed = median(past.map(r => r.p)), tMed = median(past.map(r => r.t));
  // calidad de cada año para la especie: sus citas en GBIF (España, estos meses) respecto al total de setas citadas
  // ese año, para no confundir "año bueno" con "año con más aficionados subiendo fotos"
  const m1 = end.getUTCMonth() + 1, m0 = (m1 + 10) % 12 + 1;
  const ratio = {};
  try {
    const key = await taxonKey(sp);
    const fy = async q => { const j = await fetchJSON(`https://api.gbif.org/v1/occurrence/search?${q}&country=ES&month=${m0}&month=${m1}&limit=0&facet=year&facetLimit=80`);
      const o = {}; for (const x of ((j.facets || [])[0] || { counts: [] }).counts) o[+x.name] = x.count; return o; };
    const [s, f] = await Promise.all([fy(`taxonKey=${key}`), fy("taxonKey=5")]);
    for (const y of years) if (f[y] >= 300) ratio[y] = (s[y] || 0) / f[y];
  } catch {}
  const rv = Object.values(ratio), rMed = rv.length >= 5 ? median(rv) : null;
  const qual = y => rMed && ratio[y] != null ? ratio[y] / rMed : null;
  const word = q => q == null ? "sin datos de citas" : q >= 1.3 ? "buen año" : q <= 0.75 ? "año flojo" : "año normal";
  const pScale = Math.max(15, 0.5 * pMed);
  const an = past.map(r => ({ ...r, d: Math.hypot((r.p - cur.p) / pScale, (r.t - cur.t) / 1.5) })).sort((a, b) => a.d - b.d).slice(0, 3);
  const qs = an.map(r => qual(r.y)).filter(q => q != null), qAvg = qs.length ? avg(qs) : null;
  const n = shortName(sp);
  const verdict = qAvg == null ? "No hay suficientes citas en GBIF para saber cómo fueron esos años."
    : qAvg >= 1.2 ? `<b>Pinta bien:</b> los años parecidos fueron buenos para ${esc(n)}.`
    : qAvg <= 0.85 ? `<b>Pinta flojo:</b> los años parecidos dieron pocas citas de ${esc(n)}.` : `<b>Pinta normal</b> para ${esc(n)}.`;
  const [ws, we] = win(thisYear);
  el.innerHTML = `<p style="margin:0 0 6px">Periodo: ${fmtD(ws)} – ${fmtD(we)} (30 días), centro de la zona.</p>
    <p style="margin:0 0 6px">Lluvia: <b>${Math.round(cur.p)} mm</b>, el ${Math.round(100 * cur.p / Math.max(1, pMed))} % de lo normal (mediana ${past[0].y}–${thisYear - 1}: ${Math.round(pMed)} mm).
    Temperatura: ${cur.t.toFixed(1)} °C, ${cur.t - tMed >= 0 ? "+" : ""}${(cur.t - tMed).toFixed(1)} °C respecto a lo normal.</p>
    <p style="margin:0 0 4px">Años más parecidos:</p>
    <ul style="margin:0 0 6px;padding-left:18px">${an.map(r => { const q = qual(r.y);
      return `<li><b>${r.y}</b>: ${Math.round(r.p)} mm, ${r.t.toFixed(1)} °C → ${word(q)}${q != null ? ` (×${q.toFixed(1)} citas de lo normal)` : ""}</li>`; }).join("")}</ul>
    <p style="margin:0;color:var(--fg)">${verdict}</p>
    <p style="margin:6px 0 0;font-size:11.5px">Orientativo: la calidad de cada año sale de las citas de ${esc(sp.latin)} en GBIF en toda España en ${MESES[m0 - 1]}–${MESES[m1 - 1]}, comparadas con el total de setas citadas ese año.</p>`;
}
$("#yearBtn").addEventListener("click", goodYear);

// ---------- lluvia medida: estaciones AEMET (necesita clave gratuita del usuario) ----------
async function aemet(path) {
  const key = ls.get("setometro-aemet", "");
  const url = `https://opendata.aemet.es/opendata/api/${path}`;
  let j;
  try { j = await fetchJSON(url, { headers: { api_key: key } }, 30000); }
  catch (e) { if (e.status) throw e; j = await fetchJSON(`${url}?api_key=${encodeURIComponent(key)}`, {}, 30000); } // si el navegador no deja enviar la cabecera
  if (!j.datos) { const e = new Error(j.descripcion || "sin datos"); e.status = j.estado; throw e; }
  const r = await fetch(j.datos);
  return JSON.parse(new TextDecoder("iso-8859-15").decode(await r.arrayBuffer()));
}
const dms = s => { const m = /^(\d{2,3})(\d{2})(\d{2})([NSEW])$/.exec(String(s || "")); if (!m) return null; const v = +m[1] + m[2] / 60 + m[3] / 3600; return /[SW]/.test(m[4]) ? -v : v; };
function nearestCell(lat, lon) { let b = null, bd = Infinity; for (const c of state.area.cells) { const d = distM(lat, lon, c.lat, c.lon); if (d < bd) { bd = d; b = c; } } return b; }
const stationLayer = L.layerGroup().addTo(map);
async function applyAemet(run) {
  const A = state.area;
  if (!ls.get("setometro-aemet", "")) { A.load.aemet = null; return; }
  A.load.aemet = {}; renderStatus();
  try {
    let inv = ls.get("setometro-aemet-inv", null);
    if (!inv || Date.now() - inv.when > 30 * 864e5) {
      const d = await aemet("valores/climatologicos/inventarioestaciones/todasestaciones");
      inv = { when: Date.now(), st: d.map(x => ({ id: x.indicativo, nombre: x.nombre, lat: dms(x.latitud), lon: dms(x.longitud), alt: +x.altitud })).filter(x => x.lat != null) };
      ls.set("setometro-aemet-inv", inv);
    }
    const mg = 0.08, st = inv.st.filter(s => s.lat > A.b.s - mg && s.lat < A.b.n + mg && s.lon > A.b.w - mg && s.lon < A.b.e + mg).slice(0, 10);
    const fi = A.times[A.t0 - 30], ff = A.times[A.t0], res = [];
    for (const s of st) {
      if (run !== state.run) return;
      try {
        const d = await aemet(`valores/climatologicos/diarios/datos/fechaini/${fi}T00:00:00UTC/fechafin/${ff}T23:59:59UTC/estacion/${s.id}`);
        const cell = nearestCell(s.lat, s.lon);
        let meas = 0, mod = 0, n = 0;
        for (const x of d) {
          if (x.prec == null || /acum/i.test(x.prec)) continue;
          const v = x.prec === "Ip" ? 0.05 : parseFloat(String(x.prec).replace(",", "."));
          const i = A.times.indexOf(x.fecha);
          if (isNaN(v) || i < 0) continue;
          meas += v; mod += cell.P0[i]; n++;
        }
        if (n >= 15) res.push({ ...s, meas, mod, n, k: clamp((meas + 5) / (mod + 5), 0.3, 3) });
      } catch {}
      await sleep(300);
    }
    A.stations = res;
    // cada cuadrícula toma el factor de las estaciones a menos de 25 km, ponderado por distancia
    for (const c of A.cells) {
      let ws = 0, lsum = 0;
      for (const s of res) { const d = distM(c.lat, c.lon, s.lat, s.lon) / 1000; if (d > 25) continue; const w = 1 / Math.max(1, d) ** 2; ws += w; lsum += w * Math.log(s.k); }
      c.aemetK = ws ? Math.exp(lsum / ws) : null;
      c.P = c.P0.map((v, i) => i <= A.t0 && c.aemetK ? v * c.aemetK : v);
    }
    A.load.aemet = { ok: true, txt: res.length ? `(${res.length} estaciones)` : "(sin estaciones con datos en la zona)" };
  } catch (e) {
    A.load.aemet = { err: true, txt: e.status === 401 || /JWT|api_key|clave/i.test(e.message) ? "(clave no válida)" : "(no responde)" };
  }
  if (run !== state.run) return;
  renderStatus(); drawStations(); recompute2();
}
function drawStations() {
  stationLayer.clearLayers();
  for (const s of (state.area && state.area.stations) || [])
    L.marker([s.lat, s.lon], { icon: L.divIcon({ className: "", html: `<div class="marker-st">▲</div>`, iconSize: [16, 16] }) })
      .bindPopup(`<b>Estación AEMET</b><br>${esc(s.nombre)} (${s.alt} m)<br>Lluvia medida: <b>${Math.round(s.meas)} mm</b> en ${s.n} días<br>Modelo: ${Math.round(s.mod)} mm → factor ×${s.k.toFixed(2)}`)
      .addTo(stationLayer);
}
function renderAemetBox() {
  const has = !!ls.get("setometro-aemet", "");
  $("#aemetMsg").textContent = has ? "Clave guardada en este navegador. Se usará en el próximo análisis." : "";
  $("#aemetDel").hidden = !has;
}
$("#aemetForm").addEventListener("submit", e => {
  e.preventDefault();
  const k = $("#aemetKey").value.trim(); if (!k) return;
  ls.set("setometro-aemet", k); $("#aemetKey").value = ""; renderAemetBox();
  if (state.area) applyAemet(state.run);
});
$("#aemetDel").addEventListener("click", () => {
  try { localStorage.removeItem("setometro-aemet"); } catch {}
  renderAemetBox();
  if (state.area) { state.area.cells.forEach(c => { c.P = c.P0.slice(); c.aemetK = null; }); state.area.stations = []; state.area.load.aemet = null; drawStations(); renderStatus(); recompute2(); }
});

// ---------- modo campo: GPS en directo y salida sin cobertura ----------
let watchId = null, meMarker = null, meCircle = null, wakeLock = null;
$("#fieldBtn").addEventListener("click", () => watchId == null ? startField() : stopField());
function startField() {
  if (!navigator.geolocation) { $("#fieldBody").textContent = "Este navegador no permite usar el GPS."; return; }
  $("#fieldBtn").textContent = "Desactivar GPS";
  $("#fieldBody").textContent = "Buscando tu posición…";
  let first = true;
  watchId = navigator.geolocation.watchPosition(p => {
    const ll = [p.coords.latitude, p.coords.longitude];
    if (!meMarker) {
      meCircle = L.circle(ll, { radius: p.coords.accuracy, color: "#1a73e8", weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
      meMarker = L.circleMarker(ll, { radius: 7, color: "#fff", weight: 2, fillColor: "#1a73e8", fillOpacity: 1, interactive: false }).addTo(map);
    } else { meMarker.setLatLng(ll); meCircle.setLatLng(ll).setRadius(p.coords.accuracy); }
    if (first) { map.setView(ll, Math.max(map.getZoom(), 13)); first = false; }
    state.me = { lat: ll[0], lon: ll[1], acc: p.coords.accuracy };
    renderField();
  }, e => { $("#fieldBody").textContent = "No se pudo obtener tu posición (" + (e.code === 1 ? "permiso denegado" : "sin señal GPS") + ")."; },
  { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
  try { if (navigator.wakeLock) navigator.wakeLock.request("screen").then(l => { wakeLock = l; }).catch(() => {}); } catch {}
}
function stopField() {
  navigator.geolocation.clearWatch(watchId); watchId = null;
  if (meMarker) meMarker.remove(); if (meCircle) meCircle.remove(); meMarker = meCircle = null; state.me = null;
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  $("#fieldBtn").textContent = "Activar GPS";
  $("#fieldBody").textContent = "GPS desactivado.";
}
function renderField() {
  const me = state.me, A = state.area; if (!me) return;
  const pos = `${me.lat.toFixed(5)}, ${me.lon.toFixed(5)} (±${Math.round(me.acc)} m)`;
  const inBox = b => me.lat >= b.s && me.lat < b.n && me.lon >= b.w && me.lon < b.e;
  const c = A && A.cells.find(x => inBox(x.box));
  if (!c || !c.res) {
    $("#fieldBody").innerHTML = `Estás en ${pos}, fuera de la zona analizada. <button type="button" class="small" id="fieldAnalyze">Analizar aquí</button>`;
    $("#fieldAnalyze").onclick = () => { map.setView([me.lat, me.lon], 12); analyze(); };
    return;
  }
  const sub = state.detail && state.detail.cell === c ? state.detail.subs.find(s => inBox(s.box) && s.res) : null;
  const v = sub ? sub.res.score : c.res.score;
  const rk = rankAt(c, A.t0 + state.day).slice(0, 3);
  $("#fieldBody").innerHTML = `<b>Aquí: ${esc(shortName(state.sp))} ${Math.round(v)} (${lvl(v)})</b>${sub ? ` · ladera ${rumbo(sub.aspect)} ${sub.slope.toFixed(0)}°, ${Math.round(sub.elev)} m` : ` · ${Math.round(c.elev)} m`}<br>
    Lo mejor en esta cuadrícula: ${rk.map(x => `${esc(shortName(x.sp))} ${Math.round(x.v)}`).join(" · ")}<br><span style="font-size:11.5px">${pos}</span>`;
}
$("#prepBtn").addEventListener("click", async () => {
  const A = state.area, msg = $("#prepMsg");
  if (!A) { msg.textContent = "Analiza primero la zona a la que vas."; return; }
  const snap = { when: Date.now(), sp: state.sp.id, center: map.getCenter(), zoom: map.getZoom(),
    area: { b: A.b, times: A.times, t0: A.t0, grid: A.grid, load: A.load, stations: A.stations || [],
      gbif: Object.fromEntries(Object.entries(A.gbif).filter(([, v]) => Array.isArray(v))),
      cells: A.cells.map(c => ({ i: c.i, box: c.box, lat: c.lat, lon: c.lon, cov: c.cov, gen: c.gen, vegOk: c.vegOk, geo: c.geo, elev: c.elev,
        times: c.times, P: c.P, P0: c.P0, Tx: c.Tx, Tn: c.Tn, SM: c.SM, ST: c.ST, SN: c.SN, ET: c.ET, WI: c.WI, aemetK: c.aemetK })) } };
  if (!ls.set("setometro-salida", snap)) { msg.textContent = "No hay espacio en este navegador para guardar la salida."; return; }
  msg.textContent = "Análisis guardado. Guardando el mapa…";
  // teselas de la capa de fondo visible: nivel actual y dos más de detalle (máximo 400, uso personal)
  const tl = Object.values(capas).find(l => map.hasLayer(l)), B = map.getBounds(), z0 = map.getZoom(), urls = [];
  for (let z = z0; z <= Math.min(z0 + 2, 17); z++) {
    const p1 = map.project(B.getNorthWest(), z).divideBy(256).floor(), p2 = map.project(B.getSouthEast(), z).divideBy(256).floor();
    for (let x = p1.x; x <= p2.x; x++) for (let y = p1.y; y <= p2.y; y++) urls.push(L.Util.template(tl._url, { s: "a", x, y, z, r: "" }));
  }
  let ok = 0;
  try {
    const cache = await caches.open("setometro-tiles");
    await pool(urls.slice(0, 400), 4, async u => { const r = await fetch(u, { mode: "no-cors" }); await cache.put(u, r); ok++; });
  } catch {}
  msg.textContent = `Salida guardada: ${A.cells.length} cuadrículas y ${ok} teselas de mapa${urls.length > 400 ? ` (de ${urls.length}; acerca el mapa a tu zona para guardarla con más detalle)` : ""}. Sin cobertura, abre la app y pulsa "Abrir salida guardada".`;
  $("#loadSnapBtn").hidden = false;
});
function loadSnapshot() {
  const s = ls.get("setometro-salida", null); if (!s) return false;
  state.run++; clearDetail();
  const A = s.area;
  A.load = A.load || { wx: { ok: true }, veg: {}, geo: {} };
  const today = new Date(); const tStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const ti = A.times.indexOf(tStr); if (ti >= 29) A.t0 = ti; // "hoy" de verdad si cae dentro de los datos guardados
  state.area = A; state.sp = spById(s.sp) || state.sp;
  map.setView(s.center, s.zoom);
  dayLabel(); renderSpecies(); renderCard(); recompute(); drawStations();
  statusMsg(`Mostrando la salida guardada el ${new Date(s.when).toLocaleString("es")}. Las fotos y los datos nuevos necesitan conexión.`);
  return true;
}
$("#loadSnapBtn").addEventListener("click", loadSnapshot);
$("#loadSnapBtn").hidden = !ls.get("setometro-salida", null);

// ---------- app instalable ----------
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("sw.js").catch(() => {});

// ---------- arranque ----------
const m0 = new Date().getMonth() + 1;
state.sp = SP.find(s => s.id === "niscalo" && inSeason(s, m0)) || SP.find(s => inSeason(s, m0)) || SP[0];
renderSpecies(); renderCard(); dayLabel(); renderFinds(); renderWatch(); renderNotifBtn(); renderAemetBox();
if (!navigator.onLine && loadSnapshot()) { /* sin conexión: se muestra la salida guardada */ }
else analyze().then(() => setTimeout(checkWatch, 4000));

window.__setometro = { state, scoreCell, geoClass }; // para depurar desde la consola
})();
