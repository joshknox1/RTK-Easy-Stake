'use strict';

/* ---------------------------------------------------------------------
 * RTK Point Mapper
 * Single-file app logic: geolocation tracking, point storage (localStorage),
 * list/map rendering, export/import, and an experimental Web Bluetooth
 * link to the Facet for live NMEA fix-quality readout.
 * ------------------------------------------------------------------- */

const STORAGE_KEY = 'rtk-points-v1';
const BLE_SETTINGS_KEY = 'rtk-ble-settings-v1';
const DESIGN_POINTS_KEY = 'rtk-design-points-v1';

const FT_TO_M = 0.3048;
const IN_TO_M = 0.0254;
const EARTH_R = 6378137; // WGS84 equatorial radius, meters — fine for flat-earth math at building-lot scale

// Best-effort default: many ESP32 UART-bridge firmwares (incl. common
// Nordic-UART-style bridges) use this service/characteristic pair. SparkFun's
// exact BLE NMEA service UUID is not publicly documented as of this writing,
// so this is a starting guess the user can override in Settings if their
// unit advertises something different (check with a BLE scanner app).
const DEFAULT_BLE_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const DEFAULT_BLE_TX_CHAR = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

const FIX_STALE_MS = 12000;

// ----- state -----
let points = loadPoints();
let currentFix = null; // { lat, lon, alt, accuracy, sats, quality, source, ts }
let geoWatchId = null;
let staleCheckTimer = null;
let map = null;
let markerLayer = null;
let editingPointId = null;
let bleDevice = null;
let bleBuffer = '';
let designPoints = loadDesignPoints();
let stakeoutId = null;
let stakeoutTimer = null;

// ----- storage -----
function loadPoints() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function savePoints() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(points));
}

function loadBleSettings() {
  try {
    const raw = localStorage.getItem(BLE_SETTINGS_KEY);
    return raw ? JSON.parse(raw) : { service: DEFAULT_BLE_SERVICE, tx: DEFAULT_BLE_TX_CHAR };
  } catch {
    return { service: DEFAULT_BLE_SERVICE, tx: DEFAULT_BLE_TX_CHAR };
  }
}

function saveBleSettings(s) {
  localStorage.setItem(BLE_SETTINGS_KEY, JSON.stringify(s));
}

function loadDesignPoints() {
  try {
    const raw = localStorage.getItem(DESIGN_POINTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveDesignPoints() {
  localStorage.setItem(DESIGN_POINTS_KEY, JSON.stringify(designPoints));
}

function newId() {
  return (crypto.randomUUID ? crypto.randomUUID() : 'p-' + Date.now() + '-' + Math.random().toString(36).slice(2));
}

// ----- geo math -----
function toRad(d) { return d * Math.PI / 180; }
function toDeg(r) { return r * 180 / Math.PI; }

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function formatDistance(m) {
  if (m == null) return '';
  if (m < 1000) return Math.round(m) + ' m';
  return (m / 1000).toFixed(2) + ' km';
}

function compassPoint(deg) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(deg / 45) % 8];
}

function formatCoord(lat, lon) {
  return lat.toFixed(7) + ', ' + lon.toFixed(7);
}

// ----- fix quality helpers -----
// NMEA GGA fix quality: 0 none, 1 GPS, 2 DGPS, 4 RTK Fixed, 5 RTK Float, 6 estimated
function qualityLabel(q) {
  switch (q) {
    case 0: return 'no fix';
    case 1: return 'GPS';
    case 2: return 'DGPS';
    case 4: return 'RTK fixed';
    case 5: return 'RTK float';
    case 6: return 'estimated';
    default: return 'fix';
  }
}
function qualityClass(q) {
  switch (q) {
    case 4: return 'rtk-fixed';
    case 5: return 'rtk-float';
    case 0: return 'stale';
    default: return 'ok';
  }
}

// ----- DOM refs -----
const $ = (id) => document.getElementById(id);
const fixBadge = $('fix-badge');
const fixSource = $('fix-source');
const coordsEl = $('coords');
const fixAlt = $('fix-alt');
const fixAcc = $('fix-acc');
const fixSats = $('fix-sats');
const btnSave = $('btn-save');
const quickList = $('quick-list');
const fullList = $('full-list');
const emptyHint = $('empty-hint');
const searchBox = $('search-box');

// ----- tabs -----
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});
$('btn-settings').addEventListener('click', () => switchTab('tab-settings', true));

function switchTab(tabId, fromSettings) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === tabId));
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabId));
  if (tabId === 'tab-map') {
    requestAnimationFrame(() => {
      ensureMap();
      map.invalidateSize();
      renderMapMarkers();
    });
  }
  if (tabId === 'tab-list') renderFullList();
  if (tabId === 'tab-layout') renderLayoutList();
  if (!fromSettings && tabId !== 'tab-settings') {
    // leaving settings via bottom nav is implicit; nothing else needed
  }
}

// ----- geolocation -----
function startGeolocation() {
  if (!('geolocation' in navigator)) {
    fixSource.textContent = 'geolocation unavailable';
    return;
  }
  geoWatchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 15000,
  });
  staleCheckTimer = setInterval(refreshFixDisplay, 2000);
}

function onPosition(pos) {
  // Don't let phone GPS clobber a live BLE-sourced RTK fix.
  if (currentFix && currentFix.source === 'ble' && Date.now() - currentFix.ts < FIX_STALE_MS) return;
  currentFix = {
    lat: pos.coords.latitude,
    lon: pos.coords.longitude,
    alt: pos.coords.altitude,
    accuracy: pos.coords.accuracy,
    sats: null,
    quality: null,
    source: 'phone',
    ts: Date.now(),
  };
  refreshFixDisplay();
}

function onPositionError() {
  fixSource.textContent = 'location error — check permissions';
}

function refreshFixDisplay() {
  if (!currentFix) {
    fixBadge.textContent = 'no fix';
    fixBadge.className = 'fix-badge';
    btnSave.disabled = true;
    return;
  }
  const age = Date.now() - currentFix.ts;
  const stale = age > FIX_STALE_MS;

  if (stale) {
    fixBadge.textContent = 'stale';
    fixBadge.className = 'fix-badge stale';
  } else if (currentFix.quality != null) {
    fixBadge.textContent = qualityLabel(currentFix.quality);
    fixBadge.className = 'fix-badge ' + qualityClass(currentFix.quality);
  } else {
    fixBadge.textContent = 'ok';
    fixBadge.className = 'fix-badge ok';
  }

  fixSource.textContent = currentFix.source === 'ble' ? 'Facet (Bluetooth)' : 'phone GPS';
  coordsEl.textContent = formatCoord(currentFix.lat, currentFix.lon);
  fixAlt.textContent = currentFix.alt != null ? Math.round(currentFix.alt) + ' m' : '--';
  fixAcc.textContent = currentFix.accuracy != null ? '±' + Math.round(currentFix.accuracy) + ' m' : '--';
  fixSats.textContent = currentFix.sats != null ? currentFix.sats : '--';

  btnSave.disabled = stale;
  renderQuickList();
  if ($('tab-layout').classList.contains('active')) renderLayoutList();
  if (stakeoutId) updateStakeoutDisplay();
}

// ----- save point flow -----
const dialog = $('point-dialog');
const pointForm = $('point-form');
const pointName = $('point-name');
const pointNotes = $('point-notes');
const pointDialogCoords = $('point-dialog-coords');
const pointDialogTitle = $('point-dialog-title');

btnSave.addEventListener('click', () => {
  if (!currentFix) return;
  editingPointId = null;
  pointDialogTitle.textContent = 'Save point';
  pointName.value = '';
  pointNotes.value = '';
  pointDialogCoords.textContent =
    formatCoord(currentFix.lat, currentFix.lon) +
    (currentFix.alt != null ? '  ·  ' + Math.round(currentFix.alt) + ' m' : '');
  dialog.showModal();
  setTimeout(() => pointName.focus(), 50);
});

$('point-cancel').addEventListener('click', () => dialog.close());

pointForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = pointName.value.trim();
  if (!name) return;

  if (editingPointId) {
    const p = points.find((pt) => pt.id === editingPointId);
    if (p) {
      p.name = name;
      p.notes = pointNotes.value.trim();
    }
  } else {
    points.unshift({
      id: newId(),
      name,
      notes: pointNotes.value.trim(),
      lat: currentFix.lat,
      lon: currentFix.lon,
      alt: currentFix.alt,
      accuracy: currentFix.accuracy,
      quality: currentFix.quality,
      source: currentFix.source,
      createdAt: new Date().toISOString(),
    });
  }
  savePoints();
  dialog.close();
  renderQuickList();
  renderFullList();
  if (map) renderMapMarkers();
});

function openEditDialog(id) {
  const p = points.find((pt) => pt.id === id);
  if (!p) return;
  editingPointId = id;
  pointDialogTitle.textContent = 'Edit point';
  pointName.value = p.name;
  pointNotes.value = p.notes || '';
  pointDialogCoords.textContent =
    formatCoord(p.lat, p.lon) + (p.alt != null ? '  ·  ' + Math.round(p.alt) + ' m' : '');
  dialog.showModal();
}

function deletePoint(id) {
  const p = points.find((pt) => pt.id === id);
  if (!p) return;
  if (!confirm('Delete "' + p.name + '"?')) return;
  points = points.filter((pt) => pt.id !== id);
  savePoints();
  renderQuickList();
  renderFullList();
  if (map) renderMapMarkers();
}

function navigateTo(p) {
  window.location.href = 'geo:' + p.lat + ',' + p.lon + '?q=' + p.lat + ',' + p.lon + '(' + encodeURIComponent(p.name) + ')';
}

async function copyCoords(p) {
  const text = formatCoord(p.lat, p.lon);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    prompt('Coordinates', text);
  }
}

// ----- list rendering -----
function pointRow(p, opts) {
  const li = document.createElement('li');
  li.className = 'point-item';

  const dist = currentFix ? haversine(currentFix.lat, currentFix.lon, p.lat, p.lon) : null;
  const dir = currentFix ? compassPoint(bearing(currentFix.lat, currentFix.lon, p.lat, p.lon)) : '';

  const main = document.createElement('div');
  main.className = 'pi-main';
  const nameEl = document.createElement('div');
  nameEl.className = 'pi-name';
  nameEl.textContent = p.name;
  const metaEl = document.createElement('div');
  metaEl.className = 'pi-meta';
  const when = new Date(p.createdAt).toLocaleDateString();
  metaEl.textContent = when + (p.quality != null ? ' · ' + qualityLabel(p.quality) : '');
  main.append(nameEl, metaEl);

  const distEl = document.createElement('div');
  distEl.className = 'pi-dist';
  if (dist != null) distEl.textContent = formatDistance(dist) + ' ' + dir;

  const actions = document.createElement('div');
  actions.className = 'pi-actions';
  const btnNav = document.createElement('button');
  btnNav.textContent = '↗';
  btnNav.title = 'Navigate';
  btnNav.addEventListener('click', () => navigateTo(p));
  const btnEdit = document.createElement('button');
  btnEdit.textContent = '✎';
  btnEdit.title = 'Edit';
  btnEdit.addEventListener('click', () => openEditDialog(p.id));
  const btnDel = document.createElement('button');
  btnDel.textContent = '✕';
  btnDel.title = 'Delete';
  btnDel.className = 'danger';
  btnDel.addEventListener('click', () => deletePoint(p.id));
  actions.append(btnNav, btnEdit, btnDel);

  li.append(main, distEl, actions);
  li.addEventListener('click', (e) => {
    if (e.target.closest('.pi-actions')) return;
    copyCoords(p);
  });
  return li;
}

function renderQuickList() {
  quickList.innerHTML = '';
  const recent = points.slice(0, 5);
  emptyHint.style.display = points.length ? 'none' : 'block';
  recent.forEach((p) => quickList.appendChild(pointRow(p)));
}

function renderFullList() {
  fullList.innerHTML = '';
  const q = searchBox.value.trim().toLowerCase();
  const filtered = q
    ? points.filter((p) => (p.name + ' ' + (p.notes || '')).toLowerCase().includes(q))
    : points;
  filtered.forEach((p) => fullList.appendChild(pointRow(p)));
}

searchBox.addEventListener('input', renderFullList);

// ----- map -----
function ensureMap() {
  if (map) return;
  const center = currentFix ? [currentFix.lat, currentFix.lon] : (points[0] ? [points[0].lat, points[0].lon] : [0, 0]);
  map = L.map('map', { zoomControl: true }).setView(center, points.length ? 15 : 3);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
}

function renderMapMarkers() {
  markerLayer.clearLayers();
  const bounds = [];
  points.forEach((p) => {
    const m = L.marker([p.lat, p.lon]).addTo(markerLayer);
    m.bindPopup(
      '<b>' + escapeHtml(p.name) + '</b>' +
      formatCoord(p.lat, p.lon) +
      (p.notes ? '<br>' + escapeHtml(p.notes) : '')
    );
    bounds.push([p.lat, p.lon]);
  });
  if (currentFix) {
    L.circleMarker([currentFix.lat, currentFix.lon], {
      radius: 7, color: '#22c55e', fillColor: '#22c55e', fillOpacity: 0.9,
    }).addTo(markerLayer).bindPopup('You are here');
    bounds.push([currentFix.lat, currentFix.lon]);
  }
  if (bounds.length > 1) map.fitBounds(bounds, { padding: [30, 30] });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ----- export / import -----
function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function toGeoJSON() {
  return JSON.stringify({
    type: 'FeatureCollection',
    features: points.map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lon, p.lat, p.alt || 0] },
      properties: {
        name: p.name, notes: p.notes, accuracy: p.accuracy,
        quality: p.quality, source: p.source, createdAt: p.createdAt,
      },
    })),
  }, null, 2);
}

function toGPX() {
  const wpts = points.map((p) => `  <wpt lat="${p.lat}" lon="${p.lon}">
    ${p.alt != null ? `<ele>${p.alt}</ele>` : ''}
    <name>${escapeXml(p.name)}</name>
    ${p.notes ? `<desc>${escapeXml(p.notes)}</desc>` : ''}
    <time>${p.createdAt}</time>
  </wpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="RTK Point Mapper" xmlns="http://www.topografix.com/GPX/1/1">\n${wpts}\n</gpx>`;
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function toCSV() {
  const header = 'name,lat,lon,alt,accuracy_m,quality,source,notes,createdAt';
  const rows = points.map((p) => [
    p.name, p.lat, p.lon, p.alt ?? '', p.accuracy ?? '', p.quality ?? '', p.source, p.notes || '', p.createdAt,
  ].map(csvField).join(','));
  return [header, ...rows].join('\n');
}

function csvField(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

$('btn-export-geojson').addEventListener('click', () => download('rtk-points.geojson', toGeoJSON(), 'application/geo+json'));
$('btn-export-gpx').addEventListener('click', () => download('rtk-points.gpx', toGPX(), 'application/gpx+xml'));
$('btn-export-csv').addEventListener('click', () => download('rtk-points.csv', toCSV(), 'text/csv'));

$('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const feats = data.features || [];
    let added = 0;
    feats.forEach((f) => {
      if (f.geometry?.type !== 'Point') return;
      const [lon, lat, alt] = f.geometry.coordinates;
      points.unshift({
        id: newId(),
        name: f.properties?.name || 'Imported point',
        notes: f.properties?.notes || '',
        lat, lon, alt: alt || null,
        accuracy: f.properties?.accuracy ?? null,
        quality: f.properties?.quality ?? null,
        source: f.properties?.source || 'import',
        createdAt: f.properties?.createdAt || new Date().toISOString(),
      });
      added++;
    });
    savePoints();
    renderQuickList();
    renderFullList();
    if (map) renderMapMarkers();
    alert('Imported ' + added + ' point(s).');
  } catch (err) {
    alert('Import failed: ' + err.message);
  }
  e.target.value = '';
});

$('btn-clear-all').addEventListener('click', () => {
  if (!points.length) return;
  if (!confirm('Delete all ' + points.length + ' saved points? This cannot be undone.')) return;
  points = [];
  savePoints();
  renderQuickList();
  renderFullList();
  if (map) renderMapMarkers();
});

// ----- layout: CAD-relative design points, on-site calibration, stakeout -----
//
// Design points come from a CAD file in arbitrary local units with no
// real-world coordinates. The user captures an RTK fix at two or more of
// those same physical points on site ("Set Here"); from those pairs we fit
// a 2D similarity transform (rotation + uniform scale + translation, no
// reflection) mapping local (x, y) -> real-world lat/lon, using a flat-earth
// projection centered on the calibration points (accurate to sub-millimeter
// at building-lot scale). Every other imported point then gets a live GPS
// target you can walk to.

const layoutList = $('layout-list');
const layoutEmptyHint = $('layout-empty-hint');
const calibBanner = $('calib-banner');
const importUnitsSelect = $('import-units');
const layoutImportFile = $('layout-import-file');

function unitToMeters(code) {
  return code === 'ft' ? FT_TO_M : code === 'in' ? IN_TO_M : 1;
}

// ---- similarity transform fit (complex-number least squares / Procrustes) ----
function fitTransform(calibratedPts) {
  const n = calibratedPts.length;
  if (n < 2) return null;

  let originLat = 0, originLon = 0;
  calibratedPts.forEach((p) => { originLat += p.calibLat; originLon += p.calibLon; });
  originLat /= n;
  originLon /= n;

  const cosOrigin = Math.cos(toRad(originLat));
  const pts = calibratedPts.map((p) => ({
    x: p.x, y: p.y,
    E: EARTH_R * toRad(p.calibLon - originLon) * cosOrigin,
    N: EARTH_R * toRad(p.calibLat - originLat),
  }));

  let xBar = 0, yBar = 0, eBar = 0, nBar = 0;
  pts.forEach((p) => { xBar += p.x; yBar += p.y; eBar += p.E; nBar += p.N; });
  xBar /= n; yBar /= n; eBar /= n; nBar /= n;

  let num_a = 0, num_b = 0, den = 0;
  pts.forEach((p) => {
    const dx = p.x - xBar, dy = p.y - yBar;
    const dE = p.E - eBar, dN = p.N - nBar;
    num_a += dx * dE + dy * dN;
    num_b += dx * dN - dy * dE;
    den += dx * dx + dy * dy;
  });
  if (den === 0) return null; // all calibration points coincide locally

  const a = num_a / den;
  const b = num_b / den;
  const tx = eBar - a * xBar + b * yBar;
  const ty = nBar - b * xBar - a * yBar;

  let sqErr = 0;
  pts.forEach((p) => {
    const E = a * p.x - b * p.y + tx;
    const N = b * p.x + a * p.y + ty;
    sqErr += (E - p.E) ** 2 + (N - p.N) ** 2;
  });
  const rmsResidual = Math.sqrt(sqErr / n);

  return { a, b, tx, ty, originLat, originLon, n, rmsResidual };
}

function transformToLatLon(transform, x, y) {
  const E = transform.a * x - transform.b * y + transform.tx;
  const N = transform.b * x + transform.a * y + transform.ty;
  const lat = transform.originLat + toDeg(N / EARTH_R);
  const lon = transform.originLon + toDeg(E / (EARTH_R * Math.cos(toRad(transform.originLat))));
  return { lat, lon };
}

function currentTransform() {
  const calibrated = designPoints.filter((p) => p.calibLat != null && p.calibLon != null);
  return fitTransform(calibrated);
}

// ---- DXF import (subset: POINT, LWPOLYLINE, POLYLINE/VERTEX, LINE, INSERT) ----
function parseDXF(text) {
  const rawLines = text.split(/\r\n|\r|\n/);
  const tokens = [];
  for (let i = 0; i + 1 < rawLines.length; i += 2) {
    const code = parseInt(rawLines[i].trim(), 10);
    const value = rawLines[i + 1].trim();
    tokens.push({ code, value });
  }

  let insunits = null;
  let inHeader = false;
  let lastHeaderVar = null;
  const points = [];
  let inEntities = false;
  let counters = {};

  function nextName(prefix) {
    counters[prefix] = (counters[prefix] || 0) + 1;
    return prefix + '-' + counters[prefix];
  }

  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];

    if (t.code === 0 && t.value === 'SECTION') {
      const nameTok = tokens[i + 1];
      if (nameTok && nameTok.code === 2) {
        inHeader = nameTok.value === 'HEADER';
        inEntities = nameTok.value === 'ENTITIES';
      }
      i += 2;
      continue;
    }
    if (t.code === 0 && t.value === 'ENDSEC') {
      inHeader = false;
      inEntities = false;
      i++;
      continue;
    }

    if (inHeader) {
      if (t.code === 9) lastHeaderVar = t.value;
      else if (t.code === 70 && lastHeaderVar === '$INSUNITS') insunits = parseInt(t.value, 10);
      i++;
      continue;
    }

    if (inEntities && t.code === 0) {
      const entity = t.value;
      if (entity === 'POINT') {
        const rec = readEntityFields(tokens, i);
        if (rec.fields[10] != null && rec.fields[20] != null) {
          points.push({ name: nextName(rec.fields[8] || 'PT'), x: rec.fields[10], y: rec.fields[20], z: rec.fields[30] || 0 });
        }
        i = rec.nextIndex;
        continue;
      }
      if (entity === 'LWPOLYLINE') {
        const { vertices, nextIndex, layer } = readPolylineVertices(tokens, i);
        vertices.forEach((v) => points.push({ name: nextName(layer || 'POLY'), x: v.x, y: v.y, z: v.z || 0 }));
        i = nextIndex;
        continue;
      }
      if (entity === 'POLYLINE') {
        const { vertices, nextIndex, layer } = readOldPolyline(tokens, i);
        vertices.forEach((v) => points.push({ name: nextName(layer || 'POLY'), x: v.x, y: v.y, z: v.z || 0 }));
        i = nextIndex;
        continue;
      }
      if (entity === 'LINE') {
        const rec = readEntityFields(tokens, i);
        if (rec.fields[10] != null && rec.fields[20] != null) {
          points.push({ name: nextName(rec.fields[8] || 'LINE'), x: rec.fields[10], y: rec.fields[20], z: rec.fields[30] || 0 });
        }
        if (rec.fields[11] != null && rec.fields[21] != null) {
          points.push({ name: nextName(rec.fields[8] || 'LINE'), x: rec.fields[11], y: rec.fields[21], z: rec.fields[31] || 0 });
        }
        i = rec.nextIndex;
        continue;
      }
      if (entity === 'INSERT') {
        const rec = readEntityFields(tokens, i);
        if (rec.fields[10] != null && rec.fields[20] != null) {
          points.push({ name: nextName(rec.fields[2] || rec.fields[8] || 'INS'), x: rec.fields[10], y: rec.fields[20], z: rec.fields[30] || 0 });
        }
        i = rec.nextIndex;
        continue;
      }
    }
    i++;
  }

  return { points, insunits };
}

// Reads group codes for a single simple entity until the next 0-code, collecting
// the last-seen value per code (10/20/30 = primary point, 11/21/31 = secondary, 2 = name/block, 8 = layer).
function readEntityFields(tokens, startIndex) {
  const fields = {};
  let i = startIndex + 1;
  for (; i < tokens.length && tokens[i].code !== 0; i++) {
    const { code, value } = tokens[i];
    if ([10, 20, 30, 11, 21, 31].includes(code)) fields[code] = parseFloat(value);
    else if (code === 2 || code === 8) fields[code] = value;
  }
  return { fields, nextIndex: i };
}

function readPolylineVertices(tokens, startIndex) {
  const vertices = [];
  let layer = null;
  let cur = null;
  let i = startIndex + 1;
  for (; i < tokens.length && tokens[i].code !== 0; i++) {
    const { code, value } = tokens[i];
    if (code === 8 && layer == null) layer = value;
    if (code === 10) { if (cur) vertices.push(cur); cur = { x: parseFloat(value), y: 0, z: 0 }; }
    else if (code === 20 && cur) cur.y = parseFloat(value);
    else if (code === 30 && cur) cur.z = parseFloat(value);
  }
  if (cur) vertices.push(cur);
  return { vertices, nextIndex: i, layer };
}

function readOldPolyline(tokens, startIndex) {
  const vertices = [];
  let layer = null;
  let i = startIndex + 1;
  // skip POLYLINE header fields until we hit VERTEX or SEQEND entities
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.code === 8 && layer == null) layer = t.value;
    if (t.code === 0 && t.value === 'VERTEX') {
      const rec = readEntityFields(tokens, i);
      if (rec.fields[10] != null && rec.fields[20] != null) {
        vertices.push({ x: rec.fields[10], y: rec.fields[20], z: rec.fields[30] || 0 });
      }
      i = rec.nextIndex - 1;
      continue;
    }
    if (t.code === 0 && t.value === 'SEQEND') { i++; break; }
    if (t.code === 0 && t.value !== 'VERTEX' && t.value !== 'POLYLINE') break;
  }
  return { vertices, nextIndex: i, layer };
}

// ---- CSV import (flexible header detection; falls back to PNEZD if no header) ----
function parseLayoutCSV(text) {
  const lines = text.split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];

  const splitRow = (line) => line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
  const header = splitRow(lines[0]).map((h) => h.toLowerCase());

  const findCol = (patterns) => header.findIndex((h) => patterns.some((p) => p.test(h)));
  let nameCol = findCol([/^(pt|point|pnt|id|name|num|no)/]);
  let xCol = findCol([/^(x|east|easting)/]);
  let yCol = findCol([/^(y|north|northing)/]);
  let zCol = findCol([/^(z|elev)/]);
  let descCol = findCol([/^(desc|notes?)/]);

  let dataLines = lines.slice(1);
  let mode = 'header';

  if (xCol < 0 || yCol < 0) {
    // No recognizable header — treat every line as data.
    dataLines = lines;
    const cols = splitRow(lines[0]).length;
    if (cols >= 5) {
      // Classic data-collector PNEZD: Point, Northing, Easting, Elevation, Description
      nameCol = 0; yCol = 1; xCol = 2; zCol = 3; descCol = 4;
      mode = 'pnezd';
    } else {
      nameCol = 0; xCol = 1; yCol = 2; zCol = cols >= 4 ? 3 : -1;
      mode = 'xyz';
    }
  }

  const points = dataLines.map((line, idx) => {
    const cols = splitRow(line);
    const x = parseFloat(cols[xCol]);
    const y = parseFloat(cols[yCol]);
    if (isNaN(x) || isNaN(y)) return null;
    const z = zCol >= 0 ? parseFloat(cols[zCol]) : NaN;
    const name = nameCol >= 0 && cols[nameCol] ? cols[nameCol] : 'PT-' + (idx + 1);
    const desc = descCol >= 0 ? cols[descCol] : '';
    return { name: desc ? name + ' ' + desc : name, x, y, z: isNaN(z) ? 0 : z };
  }).filter(Boolean);

  return { points, mode, mapping: { nameCol, xCol, yCol, zCol, descCol } };
}

async function importLayoutFile(file) {
  const text = await file.text();
  const ext = file.name.toLowerCase().split('.').pop();
  const chosenUnits = importUnitsSelect.value;
  let rawPoints, summary;

  if (ext === 'dxf') {
    const { points: parsed, insunits } = parseDXF(text);
    rawPoints = parsed;
    const unitFromHeader = { 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm' }[insunits];
    summary = `Found ${parsed.length} point(s) in the DXF (POINT/LWPOLYLINE/POLYLINE/LINE/INSERT entities).\n` +
      `Units: using "${chosenUnits}" from the dropdown` +
      (unitFromHeader ? ` (file header suggests "${unitFromHeader}" — change the dropdown first if that's different).` : '.');
  } else {
    const result = parseLayoutCSV(text);
    rawPoints = result.points;
    summary = `Found ${result.points.length} point(s) in the CSV, read as ${result.mode === 'pnezd' ? 'Point,Northing,Easting,Elevation,Description (no header found)' : result.mode === 'xyz' ? 'Point,X,Y,Z (no header found)' : 'header-matched columns'}.\n` +
      `Units: using "${chosenUnits}" from the dropdown.`;
  }

  if (!rawPoints.length) {
    alert('No points found in that file.');
    return;
  }
  const preview = rawPoints.slice(0, 3).map((p) => `  ${p.name}: x=${p.x}, y=${p.y}, z=${p.z}`).join('\n');
  if (!confirm(summary + '\n\nFirst points:\n' + preview + '\n\nImport ' + rawPoints.length + ' point(s)?')) return;

  const scale = unitToMeters(chosenUnits);
  rawPoints.forEach((p) => {
    designPoints.push({
      id: newId(),
      name: p.name,
      x: p.x * scale, y: p.y * scale, z: p.z * scale, // stored in meters internally
      xDisplay: p.x, yDisplay: p.y, zDisplay: p.z, unitsDisplay: chosenUnits,
      calibLat: null, calibLon: null, calibAccuracy: null, calibTs: null,
      createdAt: new Date().toISOString(),
    });
  });
  saveDesignPoints();
  renderLayoutList();
}

layoutImportFile.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    await importLayoutFile(file);
  } catch (err) {
    alert('Import failed: ' + err.message);
  }
  e.target.value = '';
});

function captureCalibration(id) {
  if (!currentFix) return;
  const p = designPoints.find((dp) => dp.id === id);
  if (!p) return;
  p.calibLat = currentFix.lat;
  p.calibLon = currentFix.lon;
  p.calibAccuracy = currentFix.accuracy;
  p.calibTs = Date.now();
  saveDesignPoints();
  renderLayoutList();
}

function clearCalibration(id) {
  const p = designPoints.find((dp) => dp.id === id);
  if (!p) return;
  p.calibLat = p.calibLon = p.calibAccuracy = p.calibTs = null;
  saveDesignPoints();
  renderLayoutList();
}

function renderLayoutList() {
  layoutList.innerHTML = '';
  layoutEmptyHint.style.display = designPoints.length ? 'none' : 'block';

  const transform = currentTransform();
  const calibratedCount = designPoints.filter((p) => p.calibLat != null).length;

  if (calibratedCount < 2) {
    calibBanner.textContent = `${calibratedCount}/2 reference points captured — capture at least 2 (tap "Set Here" while standing on that point) to enable stakeout.`;
    calibBanner.className = 'hint small';
  } else {
    calibBanner.textContent = `Calibrated from ${calibratedCount} reference point(s). Fit residual: ${(transform.rmsResidual * 100).toFixed(1)} cm` +
      (transform.rmsResidual > 0.03 ? ' — that’s higher than typical RTK noise; consider recapturing a reference point.' : '.');
    calibBanner.className = 'hint small calibrated';
  }

  designPoints.forEach((p) => {
    const li = document.createElement('li');
    li.className = 'point-item design-point';

    const main = document.createElement('div');
    main.className = 'pi-main';
    const nameEl = document.createElement('div');
    nameEl.className = 'pi-name';
    nameEl.textContent = p.name;
    const metaEl = document.createElement('div');
    metaEl.className = 'pi-meta';

    let target = null;
    if (transform) target = transformToLatLon(transform, p.x, p.y);

    if (p.calibLat != null) {
      metaEl.innerHTML = '<span class="calibrated-tag">reference point set</span>';
    } else if (target && currentFix) {
      const dist = haversine(currentFix.lat, currentFix.lon, target.lat, target.lon);
      const dir = compassPoint(bearing(currentFix.lat, currentFix.lon, target.lat, target.lon));
      metaEl.textContent = formatDistance(dist) + ' ' + dir + ' from you';
    } else {
      metaEl.innerHTML = '<span class="uncalibrated">not yet located</span>';
    }
    main.append(nameEl, metaEl);

    const distEl = document.createElement('div');
    distEl.className = 'pi-dist';
    if (target && currentFix && p.calibLat == null) {
      distEl.textContent = formatDistance(haversine(currentFix.lat, currentFix.lon, target.lat, target.lon));
    }

    const actions = document.createElement('div');
    actions.className = 'pi-actions';
    const btnCapture = document.createElement('button');
    btnCapture.className = 'capture-btn';
    btnCapture.textContent = p.calibLat != null ? 'Recapture' : 'Set Here';
    btnCapture.disabled = !currentFix;
    btnCapture.addEventListener('click', () => captureCalibration(p.id));
    actions.appendChild(btnCapture);

    if (p.calibLat != null) {
      const btnClearCal = document.createElement('button');
      btnClearCal.textContent = '✕';
      btnClearCal.title = 'Clear reference';
      btnClearCal.className = 'danger';
      btnClearCal.addEventListener('click', () => clearCalibration(p.id));
      actions.appendChild(btnClearCal);
    } else if (target) {
      const btnStake = document.createElement('button');
      btnStake.className = 'stakeout-btn';
      btnStake.textContent = '⌖';
      btnStake.title = 'Stakeout';
      btnStake.addEventListener('click', () => openStakeout(p.id));
      actions.appendChild(btnStake);
    }

    const btnDel = document.createElement('button');
    btnDel.textContent = '\u{1F5D1}';
    btnDel.title = 'Delete';
    btnDel.className = 'danger';
    btnDel.addEventListener('click', () => deleteDesignPoint(p.id));
    actions.appendChild(btnDel);

    li.append(main, distEl, actions);
    layoutList.appendChild(li);
  });
}

function deleteDesignPoint(id) {
  const p = designPoints.find((dp) => dp.id === id);
  if (!p) return;
  if (!confirm('Delete design point "' + p.name + '"?')) return;
  designPoints = designPoints.filter((dp) => dp.id !== id);
  saveDesignPoints();
  renderLayoutList();
}

$('btn-clear-layout').addEventListener('click', () => {
  if (!designPoints.length) return;
  if (!confirm('Delete all ' + designPoints.length + ' design points and reference calibration? This cannot be undone.')) return;
  designPoints = [];
  saveDesignPoints();
  renderLayoutList();
});

// ---- stakeout live view ----
const stakeoutDialog = $('stakeout-dialog');
const stakeoutNameEl = $('stakeout-name');
const stakeoutArrowEl = $('stakeout-arrow');
const stakeoutDistanceEl = $('stakeout-distance');
const stakeoutBearingEl = $('stakeout-bearing');
const stakeoutDeltaEl = $('stakeout-delta');
const stakeoutNoteEl = $('stakeout-note');

function openStakeout(id) {
  stakeoutId = id;
  const p = designPoints.find((dp) => dp.id === id);
  stakeoutNameEl.textContent = 'Stakeout: ' + (p ? p.name : '');
  stakeoutNoteEl.textContent = 'Bearing is relative to true north (not device heading) — use a compass or watch the distance shrink as you walk.';
  stakeoutDialog.showModal();
  updateStakeoutDisplay();
}

function updateStakeoutDisplay() {
  const p = designPoints.find((dp) => dp.id === stakeoutId);
  const transform = currentTransform();
  if (!p || !transform || !currentFix) return;
  const target = transformToLatLon(transform, p.x, p.y);
  const dist = haversine(currentFix.lat, currentFix.lon, target.lat, target.lon);
  const brg = bearing(currentFix.lat, currentFix.lon, target.lat, target.lon);

  stakeoutDistanceEl.textContent = dist < 1 ? (dist * 100).toFixed(1) + ' cm' : formatDistance(dist);
  stakeoutBearingEl.textContent = Math.round(brg) + '° ' + compassPoint(brg) + ' to walk';
  stakeoutArrowEl.style.transform = 'rotate(' + brg + 'deg)';

  // ΔE/ΔN in the local tangent plane, useful for "move N ft east / N ft north" style guidance
  const dE = EARTH_R * toRad(target.lon - currentFix.lon) * Math.cos(toRad(currentFix.lat));
  const dN = EARTH_R * toRad(target.lat - currentFix.lat);
  stakeoutDeltaEl.textContent =
    (dN >= 0 ? Math.abs(dN).toFixed(2) + ' m N' : Math.abs(dN).toFixed(2) + ' m S') + '  ·  ' +
    (dE >= 0 ? Math.abs(dE).toFixed(2) + ' m E' : Math.abs(dE).toFixed(2) + ' m W');

  stakeoutArrowEl.className = 'stakeout-arrow' + (dist < 0.05 ? ' near' : dist < 0.3 ? ' close' : '');
  stakeoutDistanceEl.className = 'stakeout-distance' + (dist < 0.05 ? ' near' : '');
}

$('stakeout-close').addEventListener('click', () => {
  stakeoutId = null;
  stakeoutDialog.close();
});

// ----- experimental Web Bluetooth link -----
const bleStatus = $('ble-status');
const bleServiceInput = $('ble-service-uuid');
const bleTxInput = $('ble-tx-uuid');

(function initBleSettingsUI() {
  const s = loadBleSettings();
  bleServiceInput.value = s.service;
  bleTxInput.value = s.tx;
  [bleServiceInput, bleTxInput].forEach((el) =>
    el.addEventListener('change', () => saveBleSettings({ service: bleServiceInput.value.trim(), tx: bleTxInput.value.trim() }))
  );
})();

$('btn-ble-connect').addEventListener('click', connectBLE);

async function connectBLE() {
  if (!('bluetooth' in navigator)) {
    bleStatus.textContent = 'Web Bluetooth is not available in this browser (use Chrome on Android).';
    return;
  }
  const settings = loadBleSettings();
  const serviceUuid = settings.service || DEFAULT_BLE_SERVICE;
  const txUuid = settings.tx || DEFAULT_BLE_TX_CHAR;

  try {
    bleStatus.textContent = 'Requesting device...';
    bleDevice = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [serviceUuid],
    });
    bleStatus.textContent = 'Connecting to ' + (bleDevice.name || 'device') + '...';
    const server = await bleDevice.gatt.connect();
    const service = await server.getPrimaryService(serviceUuid);
    const characteristic = await service.getCharacteristic(txUuid);
    await characteristic.startNotifications();
    characteristic.addEventListener('characteristicvaluechanged', onBleNotify);
    bleDevice.addEventListener('gattserverdisconnected', () => {
      bleStatus.textContent = 'Disconnected. Falling back to phone GPS.';
    });
    bleStatus.textContent = 'Connected. Waiting for NMEA data...';
  } catch (err) {
    bleStatus.textContent = 'Could not connect (' + err.message + '). Check the service/characteristic UUIDs above, or keep using phone GPS.';
  }
}

function onBleNotify(event) {
  const chunk = new TextDecoder().decode(event.target.value);
  bleBuffer += chunk;
  let idx;
  while ((idx = bleBuffer.indexOf('\n')) >= 0) {
    const line = bleBuffer.slice(0, idx).trim();
    bleBuffer = bleBuffer.slice(idx + 1);
    if (line.startsWith('$')) handleNmeaSentence(line);
  }
}

function handleNmeaSentence(sentence) {
  const body = sentence.split('*')[0];
  const fields = body.split(',');
  const type = fields[0].slice(3); // strip talker id, e.g. GNGGA -> GGA
  if (type !== 'GGA') return;

  const lat = nmeaToDecimal(fields[2], fields[3]);
  const lon = nmeaToDecimal(fields[4], fields[5]);
  const quality = parseInt(fields[6], 10);
  const sats = parseInt(fields[7], 10);
  const hdop = parseFloat(fields[8]);
  const alt = parseFloat(fields[9]);

  if (lat == null || lon == null || quality === 0) return;

  currentFix = {
    lat, lon, alt: isNaN(alt) ? null : alt,
    accuracy: isNaN(hdop) ? null : hdop * 5, // rough estimate, HDOP is not directly meters
    sats: isNaN(sats) ? null : sats,
    quality: isNaN(quality) ? null : quality,
    source: 'ble',
    ts: Date.now(),
  };
  refreshFixDisplay();
}

function nmeaToDecimal(raw, hemi) {
  if (!raw || !hemi) return null;
  const degLen = raw.indexOf('.') - 2;
  const deg = parseFloat(raw.slice(0, degLen));
  const min = parseFloat(raw.slice(degLen));
  let dec = deg + min / 60;
  if (hemi === 'S' || hemi === 'W') dec = -dec;
  return dec;
}

// ----- service worker -----
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// ----- init -----
renderQuickList();
startGeolocation();
