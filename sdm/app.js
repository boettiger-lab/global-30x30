/**
 * SDM builder: a menu-driven front end to the hexsdm MCP server, with no LLM.
 *
 * The page calls MCP tools directly with one stateless JSON-RPC POST per call
 * (glen-charts' McpQueryClient):
 *   - sdm-mcp:    list_sdm_algorithms, list_covariate_layers, fit_sdm, get_sdm_result
 *   - duckdb-mcp: query (species-name lookup in the GBIF snapshot index, and the
 *                 protected-area overlap of the modelled range)
 * Common names are resolved with the public GBIF species API, and every
 * candidate is checked against the snapshot index the model reads, so any
 * name offered can be fitted.
 *
 * The fit request is mirrored to the URL (#spec=...), so a model is a link;
 * opening the link refits, which returns the cached result at once.
 */

import { McpQueryClient } from 'https://cdn.jsdelivr.net/gh/SchmidtDSE/glen-charts@v0.2.1/core/mcp.js';
import { fmt, escapeHtml } from 'https://cdn.jsdelivr.net/gh/SchmidtDSE/glen-charts@v0.2.1/core/format.js';

const GBIF_INDEX = 's3://public-gbif/2026-09/species-h0-index.parquet';
const VIRIDIS = ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'];
const RANGE_COLOR = '#bd0026';
const OCC_COLOR = '#1f4e9c';
const IUCN_COLOR = '#e66101';
const IUCN_HEX = 's3://public-iucn/iucn-ranges-2025/hex/h0=*/data_0.parquet';
const IUCN_INDEX = 's3://public-iucn/iucn-ranges-2025/species-h0-index.parquet';
const IUCN_POLY = 's3://public-iucn/iucn-ranges-2025.parquet';
const GBIF_HEX = 's3://public-gbif/2026-09/hex/h0=*/data_0.parquet';
const GBIF_BAD_ISSUES = "['ZERO_COORDINATE','COORDINATE_INVALID','COORDINATE_OUT_OF_RANGE','COUNTRY_COORDINATE_MISMATCH']";
const DOMAIN_TYPES = [
    { id: 'buffer', label: 'Around the records' },
    { id: 'country', label: 'Country' },
    { id: 'region', label: 'State / province' },
    { id: 'bbox', label: 'Current map view' },
];

const $ = id => document.getElementById(id);
const state = { source: 'gbif', species: null, upload: null, iucn: null, domain: 'buffer', result: null, view: 'current', running: false };

const cfg = await (await fetch('config.json')).json();
const sdm = new McpQueryClient(cfg.sdm_url, { timeoutMs: 180000 });
const db = new McpQueryClient(cfg.mcp_url, { timeoutMs: 120000 });

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

const protocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);
const map = new maplibregl.Map({
    container: 'map',
    style: {
        version: 8,
        sources: {
            base: { type: 'raster', tileSize: 256, maxzoom: 16,
                tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
                attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors' },
            ref: { type: 'raster', tileSize: 256, maxzoom: 16,
                tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}'] },
        },
        layers: [{ id: 'base', type: 'raster', source: 'base' }, { id: 'ref', type: 'raster', source: 'ref' }],
    },
    center: cfg.view.center, zoom: cfg.view.zoom,
    attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
const mapReady = new Promise(r => map.on('load', r));

mapReady.then(() => {
    for (const pa of cfg.protected_areas) {
        map.addSource(pa.id, { type: 'vector', url: `pmtiles://${pa.pmtiles}` });
        map.addLayer({ id: `${pa.id}-line`, type: 'line', source: pa.id, 'source-layer': pa.source_layer,
            layout: { visibility: 'none' }, paint: { 'line-color': pa.color, 'line-width': 0.8, 'line-opacity': 0.9 } }, 'ref');
    }
});

// A map move by the user replaces a bounding box restored from a link.
map.on('moveend', e => { if (e.originalEvent) state._bbox = null; });

const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });

/** Draw (or replace) the suitability and range layers for one scenario. */
async function showLayers(layers) {
    await mapReady;
    for (const id of ['sdm-range-line', 'sdm-range', 'sdm-suit']) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of ['sdm-range', 'sdm-suit']) if (map.getSource(id)) map.removeSource(id);
    const firstPa = `${cfg.protected_areas[0].id}-line`;
    map.addSource('sdm-suit', { type: 'geojson', data: layers.suitability.geojson_url });
    map.addLayer({ id: 'sdm-suit', type: 'fill', source: 'sdm-suit', paint: {
        'fill-color': ['interpolate', ['linear'], ['get', layers.suitability.value_column || 'suitability'],
            ...VIRIDIS.flatMap((c, i) => [i / (VIRIDIS.length - 1), c])],
        'fill-opacity': 0.75 } }, firstPa);
    map.addSource('sdm-range', { type: 'geojson', data: layers.range.geojson_url });
    map.addLayer({ id: 'sdm-range', type: 'fill', source: 'sdm-range',
        paint: { 'fill-color': RANGE_COLOR, 'fill-opacity': 0.45 } }, firstPa);
    map.addLayer({ id: 'sdm-range-line', type: 'line', source: 'sdm-range',
        paint: { 'line-color': RANGE_COLOR, 'line-width': 1 } }, firstPa);
    applyVisibility();
}

map.on('mousemove', 'sdm-suit', e => {
    const v = e.features[0]?.properties?.suitability;
    if (v !== undefined) popup.setLngLat(e.lngLat).setHTML(`Suitability <b>${fmt(v, 'num2')}</b>`).addTo(map);
});
map.on('mouseleave', 'sdm-suit', () => popup.remove());

const layerOn = { suit: true, range: true, occ: true, iucn: true, wdpa: false, oecm: false };

function applyVisibility() {
    const vis = on => (on ? 'visible' : 'none');
    if (map.getLayer('sdm-suit')) map.setLayoutProperty('sdm-suit', 'visibility', vis(layerOn.suit));
    for (const id of ['sdm-range', 'sdm-range-line'])
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis(layerOn.range));
    for (const pa of cfg.protected_areas)
        if (map.getLayer(`${pa.id}-line`)) map.setLayoutProperty(`${pa.id}-line`, 'visibility', vis(layerOn[pa.id]));
    if (map.getLayer('occ')) map.setLayoutProperty('occ', 'visibility', vis(layerOn.occ));
    if (map.getLayer('iucn')) map.setLayoutProperty('iucn', 'visibility', vis(layerOn.iucn));
}

/** Replace a GeoJSON overlay drawn above the model layers (records, IUCN outline). */
async function setOverlay(id, data, layer) {
    await mapReady;
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
    if (data) {
        map.addSource(id, { type: 'geojson', data });
        map.addLayer({ id, source: id, ...layer }, 'ref');
    }
    applyVisibility(); renderMapChips(); renderLegend();
}

function renderMapChips() {
    const r = state.result;
    const chips = $('map-chips');
    const hasOcc = !!map.getLayer('occ'), hasIucn = !!map.getLayer('iucn');
    chips.hidden = !(r || hasOcc || hasIucn);
    if (chips.hidden) return;
    const btn = (key, label, c) => `<button class="map-btn" data-layer="${key}" aria-pressed="${layerOn[key]}" style="--c:${c}">${label}</button>`;
    const views = r?.artifacts.map_layers_future
        ? `<span class="lbl">Climate</span>
           <button class="map-btn" data-view="current" aria-pressed="${state.view === 'current'}" style="--c:var(--primary)">1981–2010</button>
           <button class="map-btn" data-view="future" aria-pressed="${state.view === 'future'}" style="--c:var(--primary)">${escapeHtml(scenarioLabel(r.projection?.scenario || ''))}</button>`
        : '';
    chips.innerHTML = `${views}<span class="lbl">Show</span>`
        + (r ? btn('suit', 'Suitability', '#21918c') + btn('range', 'Range', RANGE_COLOR) : '')
        + (hasOcc ? btn('occ', 'Records', OCC_COLOR) : '')
        + (hasIucn ? btn('iucn', 'IUCN range', IUCN_COLOR) : '')
        + cfg.protected_areas.map(pa => btn(pa.id, pa.label, pa.color)).join('');
    chips.querySelectorAll('[data-layer]').forEach(b => b.onclick = () => {
        layerOn[b.dataset.layer] = !layerOn[b.dataset.layer];
        applyVisibility(); renderMapChips(); renderLegend();
    });
    chips.querySelectorAll('[data-view]').forEach(b => b.onclick = () => {
        state.view = b.dataset.view;
        showLayers(state.view === 'future' ? r.artifacts.map_layers_future : r.artifacts.map_layers);
        renderMapChips(); renderLegend();
    });
}

function renderLegend() {
    const el = $('map-legend');
    const r = state.result;
    const hasOcc = !!map.getLayer('occ') && layerOn.occ, hasIucn = !!map.getLayer('iucn') && layerOn.iucn;
    el.hidden = !(r || hasOcc || hasIucn);
    if (el.hidden) return;
    const when = state.view === 'future' ? scenarioLabel(r?.projection?.scenario || '') : '1981–2010 climate';
    el.innerHTML = `<div class="title">${escapeHtml(speciesLabel())}</div>
        ${r && layerOn.suit ? `<div class="row">Habitat suitability, ${escapeHtml(when)}</div>
        <div class="ramp">${VIRIDIS.map(c => `<span style="background:${c}"></span>`).join('')}</div>
        <div class="ends"><span>0 low</span><span>1 high</span></div>` : ''}
        ${r && layerOn.range ? `<div class="row"><span class="swatch" style="background:${RANGE_COLOR};opacity:.6"></span>Modelled range (threshold ${fmt(r.threshold?.value, 'num2')})</div>` : ''}
        ${hasOcc ? `<div class="row"><span class="swatch round" style="background:${OCC_COLOR}"></span>${escapeHtml(state.occLegend || 'Occurrence records')}</div>` : ''}
        ${hasIucn ? `<div class="row"><span class="swatch" style="border:2px dashed ${IUCN_COLOR}"></span>IUCN range${state.iucn?.cat ? ` (${escapeHtml(state.iucn.cat)})` : ''}</div>` : ''}
        ${cfg.protected_areas.filter(pa => layerOn[pa.id]).map(pa =>
            `<div class="row"><span class="swatch" style="border:2px solid ${pa.color}"></span>${escapeHtml(pa.label)}</div>`).join('')}`;
}

// ---------------------------------------------------------------------------
// Species search
// ---------------------------------------------------------------------------

/** Candidate scientific names for what the user typed: GBIF vernacular and
 *  scientific search, plus the text itself. */
async function gbifCandidates(q) {
    const names = new Map();   // canonical name -> { common, cls }
    const urls = [
        `https://api.gbif.org/v1/species/search?q=${encodeURIComponent(q)}&qField=VERNACULAR&rank=SPECIES&limit=20`,
        `https://api.gbif.org/v1/species/suggest?q=${encodeURIComponent(q)}&rank=SPECIES&limit=10`,
    ];
    const res = await Promise.allSettled(urls.map(u => fetch(u).then(r => r.json())));
    for (const r of res) {
        if (r.status !== 'fulfilled') continue;
        const rows = Array.isArray(r.value) ? r.value : r.value.results || [];
        for (const row of rows) {
            const name = row.species || row.canonicalName;
            if (!name || !/^\S+ \S+$/.test(name)) continue;
            const common = (row.vernacularNames || []).find(v => v.language === 'eng')?.vernacularName;
            const prev = names.get(name) || {};
            names.set(name, { common: prev.common || common, cls: prev.cls || row.class });
        }
    }
    return names;
}

const sqlStr = s => `'${String(s).replace(/'/g, "''")}'`;

/** Keep only names present in the snapshot; rank by number of h0 partitions. */
async function lookupSpecies(q) {
    const cands = await gbifCandidates(q);
    const prefix = q.trim().replace(/\s+/g, ' ');
    const inList = [...cands.keys()].map(sqlStr).join(', ') || "''";
    const prefixCond = /^[A-Za-z]+( [a-z-]*)?$/.test(prefix) && prefix.length >= 3
        ? ` OR starts_with(species, ${sqlStr(prefix[0].toUpperCase() + prefix.slice(1))})` : '';
    const rows = await db.query(`
        SELECT species, count(*) AS n_h0 FROM read_parquet('${GBIF_INDEX}')
        WHERE species IN (${inList})${prefixCond}
        GROUP BY species ORDER BY (species IN (${inList})) DESC, n_h0 DESC LIMIT 12`);
    return rows.map(r => ({ name: r.species, n_h0: r.n_h0, ...(cands.get(r.species) || {}) }));
}

let searchSeq = 0;
let searchTimer = null;
$('species-input').addEventListener('input', e => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    state.species = null; updateRunButton();
    if (q.length < 3) { $('species-results').hidden = true; return; }
    searchTimer = setTimeout(async () => {
        const seq = ++searchSeq;
        const ul = $('species-results');
        ul.hidden = false;
        ul.innerHTML = '<li class="empty">Searching…</li>';
        try {
            const hits = await lookupSpecies(q);
            if (seq !== searchSeq) return;
            ul.innerHTML = hits.length
                ? hits.map((h, i) => `<li role="option" data-i="${i}"><span><i>${escapeHtml(h.name)}</i>${h.common ? ` — ${escapeHtml(h.common)}` : ''}</span><small>${escapeHtml(h.cls || '')}</small></li>`).join('')
                : '<li class="empty">No species of that name in the GBIF 2026-09 snapshot.</li>';
            ul.querySelectorAll('li[data-i]').forEach(li => li.onclick = () => chooseSpecies(hits[+li.dataset.i]));
        } catch (err) {
            if (seq === searchSeq) ul.innerHTML = `<li class="empty">Search failed: ${escapeHtml(err.message)}</li>`;
        }
    }, 350);
});
document.addEventListener('click', e => { if (!e.target.closest('.search')) $('species-results').hidden = true; });

function chooseSpecies(s) {
    state.species = s;
    $('species-input').value = s.name;
    $('species-results').hidden = true;
    $('species-help').innerHTML = `<span class="species-chosen"><i>${escapeHtml(s.name)}</i>${s.common ? `, ${escapeHtml(s.common)}` : ''}</span> <span id="occ-summary">· counting records…</span>`;
    updateRunButton();
    previewGbif(s.name);
    findIucn(s.name);
}

const speciesLabel = () => state.source === 'gbif'
    ? (state.species?.name || '')
    : (state.upload?.label || 'Uploaded records');

// ---------------------------------------------------------------------------
// Occurrence preview (GBIF records, or an uploaded file) and the IUCN range
// ---------------------------------------------------------------------------

/** Circles at H3 cell centres, sized by record count. */
function cellPoints(rows) {
    return {
        type: 'FeatureCollection',
        features: rows.map(r => {
            const [lat, lng] = h3.cellToLatLng(r.cell);
            return { type: 'Feature', properties: { n: r.n }, geometry: { type: 'Point', coordinates: [lng, lat] } };
        }),
    };
}

const OCC_LAYER = {
    type: 'circle',
    paint: {
        'circle-color': OCC_COLOR, 'circle-opacity': 0.75,
        'circle-stroke-color': '#fff', 'circle-stroke-width': 0.6,
        'circle-radius': ['interpolate', ['linear'], ['ln', ['+', 1, ['get', 'n']]], 0, 2.5, 7, 9],
    },
};

let previewSeq = 0;

/** GBIF records for the species, with the filters the SDM server applies,
 *  aggregated to H3 resolution 6 (resolution 4 for very widespread species). */
async function previewGbif(name) {
    const seq = ++previewSeq;
    const unc = Number($('max-unc').value) || 1000;
    const year = $('min-year').value ? ` AND year >= ${Number($('min-year').value)}` : '';
    try {
        const rows = await db.query(`
            WITH r AS (
                SELECT h6, coordinateuncertaintyinmeters AS u
                FROM read_parquet('${GBIF_HEX}', hive_partitioning=true)
                WHERE h0 IN (SELECT h0 FROM read_parquet('${GBIF_INDEX}') WHERE species = ${sqlStr(name)})
                  AND species = ${sqlStr(name)}
                  AND NOT list_has_any(issue, ${GBIF_BAD_ISSUES})
                  AND coalesce(occurrencestatus, 'PRESENT') <> 'ABSENT'
                  AND basisofrecord NOT IN ('FOSSIL_SPECIMEN', 'LIVING_SPECIMEN')${year}),
            c AS (SELECT h6, count(*) FILTER (u IS NULL OR u <= ${unc}) AS n, count(*) FILTER (u > ${unc}) AS n_drop FROM r GROUP BY h6),
            k AS (SELECT count(*) AS cells FROM c)
            SELECT h3_h3_to_string(CASE WHEN (SELECT cells FROM k) > 20000 THEN h3_cell_to_parent(h6, 4) ELSE h6 END) AS cell,
                   sum(n)::INT AS n, sum(n_drop)::INT AS n_drop
            FROM c GROUP BY 1`);
        if (seq !== previewSeq || state.source !== 'gbif') return;
        const kept = rows.reduce((a, r) => a + r.n, 0), dropped = rows.reduce((a, r) => a + r.n_drop, 0);
        state.occLegend = `GBIF records kept by the filters (${fmt(kept, 'int')})`;
        await setOverlay('occ', cellPoints(rows.filter(r => r.n > 0)), OCC_LAYER);
        const el = $('occ-summary');
        if (el) el.textContent = `· ${fmt(kept, 'int')} usable records`
            + (dropped ? `, ${fmt(dropped, 'int')} more with coordinate uncertainty over ${fmt(unc, 'int')} m (${fmt(dropped / (kept + dropped), 'pct')})` : '');
        if (!state.result) fitToGeojson(cellPoints(rows));
    } catch (err) {
        const el = $('occ-summary');
        if (el && seq === previewSeq) el.textContent = `· record preview failed: ${err.message.slice(0, 120)}`;
    }
}

let iucnSeq = 0;

/** Look the species up in the IUCN 2025 range maps (exact name, then the same
 *  epithet under another genus) and draw its range outline. */
async function findIucn(name) {
    const seq = ++iucnSeq;
    state.iucn = null;
    const help = $('iucn-help');
    await setOverlay('iucn', null);
    if (!$('iucn-on').checked || !name) { help.hidden = true; return; }
    help.hidden = false;
    help.textContent = 'Looking for an IUCN range map…';
    try {
        const epithet = name.trim().split(/\s+/)[1] || '';
        const rows = await db.query(`
            WITH idx AS (SELECT DISTINCT id_no, sci_name FROM read_parquet('${IUCN_INDEX}')
                         WHERE sci_name = ${sqlStr(name)} OR split_part(sci_name, ' ', 2) = ${sqlStr(epithet)})
            SELECT i.id_no, i.sci_name, i.sci_name = ${sqlStr(name)} AS exact,
                   any_value(t.common_name_en) AS common, any_value(t.latest_category_code) AS cat
            FROM idx i LEFT JOIN (SELECT id_no, common_name_en, latest_category_code FROM read_parquet('${IUCN_POLY}')
                                  WHERE sci_name IN (SELECT sci_name FROM idx)) t USING (id_no)
            GROUP BY ALL ORDER BY exact DESC LIMIT 5`);
        if (seq !== iucnSeq) return;
        const exact = rows.find(r => r.sci_name === name);
        // Under another genus, accept the epithet match only when it is the only one.
        const hit = exact || (rows.length === 1 ? rows[0] : null);
        if (!hit) {
            help.textContent = rows.length
                ? `No IUCN range under this name; the same epithet appears as ${rows.map(r => r.sci_name).join(', ')}.`
                : 'No IUCN range map for this species.';
            return;
        }
        state.iucn = hit;
        help.textContent = `IUCN range: ${hit.sci_name}${hit.common ? ` (${hit.common})` : ''}${hit.cat ? `, Red List ${hit.cat}` : ''}`
            + (exact ? '' : ' — matched on the species epithet under another genus.') + ' Loading outline…';
        const cells = await db.query(`
            WITH src AS (
                SELECT h6, h5, h4 FROM read_parquet('${IUCN_HEX}', hive_partitioning=true)
                WHERE h0 IN (SELECT h0 FROM read_parquet('${IUCN_INDEX}') WHERE id_no = ${Number(hit.id_no)})
                  AND id_no = ${Number(hit.id_no)} AND presence IN (1, 2, 3) AND origin IN (1, 2)),
            c AS (SELECT DISTINCT coalesce(h6, h5) AS cell, h4 FROM src),
            k AS (SELECT count(*) AS n FROM c)
            SELECT DISTINCT h3_h3_to_string(CASE WHEN (SELECT n FROM k) > 40000 THEN h4 ELSE cell END) AS cell FROM c`);
        if (seq !== iucnSeq) return;
        const poly = h3.cellsToMultiPolygon(cells.map(c => c.cell), true);
        await setOverlay('iucn', { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: poly } },
            { type: 'line', paint: { 'line-color': IUCN_COLOR, 'line-width': 1.8, 'line-dasharray': [2, 1.5] } });
        help.textContent = help.textContent.replace(' Loading outline…', '');
    } catch (err) {
        if (seq === iucnSeq) help.textContent = `IUCN lookup failed: ${err.message.slice(0, 120)}`;
    }
}

$('iucn-on').onchange = () => findIucn(state.source === 'gbif' ? state.species?.name : state.upload?.label);

/** Agreement between the modelled range and the IUCN range, inside the study
 *  area: shares of each covered by the other, and the AUC of suitability for
 *  IUCN membership (ties get their average rank). */
async function iucnAgreement(r) {
    const res = r.resolution, id = Number(state.iucn.id_no);
    const [row] = await db.query(`
        WITH pred AS (SELECT h${res} AS cell, suitability AS s, suitable FROM read_parquet('${toS3(r.artifacts.predictions_parquet)}')),
        src AS (SELECT h8, h6, h5, native_res FROM read_parquet('${IUCN_HEX}', hive_partitioning=true)
                WHERE h0 IN (SELECT h0 FROM read_parquet('${IUCN_INDEX}') WHERE id_no = ${id})
                  AND id_no = ${id} AND presence IN (1, 2, 3) AND origin IN (1, 2)),
        iu AS (SELECT h3_cell_to_parent(coalesce(h8, h6, h5), ${res}) AS cell FROM src WHERE native_res >= ${res}
               UNION SELECT unnest(h3_cell_to_children(coalesce(h6, h5), ${res})) FROM src WHERE native_res < ${res}),
        j AS (SELECT p.s, p.suitable, i.cell IS NOT NULL AS y FROM pred p LEFT JOIN (SELECT DISTINCT cell FROM iu) i USING (cell)),
        rk AS (SELECT y, rank() OVER (ORDER BY s) + (count(*) OVER (PARTITION BY s) - 1) / 2.0 AS rk FROM j)
        SELECT (SELECT count(*) FILTER (suitable) FROM j) AS model_cells,
               (SELECT count(*) FILTER (y) FROM j) AS iucn_cells,
               (SELECT count(*) FILTER (suitable AND y) FROM j) AS both_cells,
               (sum(rk) FILTER (y) - count(*) FILTER (y) * (count(*) FILTER (y) + 1) / 2.0)
                 / nullif(count(*) FILTER (y) * count(*) FILTER (NOT y), 0) AS auc
        FROM rk`);
    return row;
}

// ---------------------------------------------------------------------------
// Occurrence source: GBIF or an uploaded GeoJSON
// ---------------------------------------------------------------------------

const MAX_UPLOAD_POINTS = 50000;

function setSource(src) {
    state.source = src;
    $('source-seg').querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.src === src)));
    $('gbif-panel').hidden = src !== 'gbif';
    $('species-help').hidden = src !== 'gbif';
    $('upload-panel').hidden = src !== 'upload';
    // The study-area buffer and GBIF filters depend on the source; redraw what it previews.
    if (src === 'gbif') {
        if (state.species) { previewGbif(state.species.name); findIucn(state.species.name); }
        else { setOverlay('occ', null); findIucn(null); }
    } else {
        showUpload();
        findIucn(state.upload?.label);
    }
    updateRunButton();
}
$('source-seg').querySelectorAll('button').forEach(b => b.onclick = () => setSource(b.dataset.src));

/** Points and absences from a GeoJSON object; coordinates rounded to ~1 m. */
function parseOccurrences(gj) {
    const feats = gj?.type === 'FeatureCollection' ? gj.features : gj?.type === 'Feature' ? [gj] : null;
    if (!feats) throw new Error('expected a GeoJSON FeatureCollection or Feature');
    const points = [], absences = [];
    const r5 = v => Math.round(v * 1e5) / 1e5;
    for (const f of feats) {
        const g = f?.geometry;
        if (!g) continue;
        const coords = g.type === 'Point' ? [g.coordinates] : g.type === 'MultiPoint' ? g.coordinates : null;
        if (!coords) throw new Error(`only Point and MultiPoint features are supported (found ${g.type})`);
        const absent = Number(f.properties?.presence) === 0;
        for (const [lng, lat] of coords) {
            if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) throw new Error(`coordinate out of range: ${lng}, ${lat}`);
            (absent ? absences : points).push([r5(lng), r5(lat)]);
        }
    }
    if (points.length + absences.length > MAX_UPLOAD_POINTS) throw new Error(`more than ${fmt(MAX_UPLOAD_POINTS, 'int')} points`);
    if (points.length < 5) throw new Error(`a model needs at least 5 presence points (found ${points.length})`);
    return { points, absences };
}

$('upload-file').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    const help = $('upload-help');
    try {
        const occ = parseOccurrences(JSON.parse(await file.text()));
        state.upload = { ...occ, file: file.name, label: $('upload-label').value.trim() };
        help.textContent = `${file.name}: ${fmt(occ.points.length, 'int')} presence points`
            + (occ.absences.length ? ` and ${fmt(occ.absences.length, 'int')} absences` : '') + '.';
        help.classList.remove('err');
        showUpload(true);
    } catch (err) {
        state.upload = null;
        help.textContent = `Could not use ${file.name}: ${err.message}.`;
        help.classList.add('err');
        setOverlay('occ', null);
    }
    updateRunButton();
};

let labelTimer = null;
$('upload-label').oninput = e => {
    if (state.upload) state.upload.label = e.target.value.trim();
    clearTimeout(labelTimer);
    labelTimer = setTimeout(() => findIucn(e.target.value.trim()), 600);
};

function showUpload(fit = false) {
    const u = state.upload;
    if (!u) { setOverlay('occ', null); return; }
    const pt = (c, absent) => ({ type: 'Feature', properties: { n: 1, absent }, geometry: { type: 'Point', coordinates: c } });
    const gj = { type: 'FeatureCollection', features: [...u.points.map(c => pt(c, false)), ...u.absences.map(c => pt(c, true))] };
    state.occLegend = `Uploaded records (${fmt(u.points.length, 'int')} presences${u.absences.length ? `, ${fmt(u.absences.length, 'int')} absences` : ''})`;
    setOverlay('occ', gj, { type: 'circle', paint: {
        'circle-color': ['case', ['get', 'absent'], '#ffffff', OCC_COLOR], 'circle-radius': 3.5,
        'circle-stroke-color': OCC_COLOR, 'circle-stroke-width': 1 } });
    if (fit && !state.result) fitToGeojson(gj);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const COUNTRIES = (() => {
    const out = [];
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (const a of A) for (const b of A) {
        const code = a + b;
        let name;
        try { name = regionNames.of(code); } catch { continue; }
        if (name && name !== code && !['EU', 'EZ', 'UN', 'ZZ', 'QO'].includes(code) && !/Unknown/.test(name)) out.push({ code, name });
    }
    return out.sort((x, y) => x.name.localeCompare(y.name));
})();

function renderDomain() {
    $('domain-seg').innerHTML = DOMAIN_TYPES.map(d =>
        `<button role="radio" aria-checked="${state.domain === d.id}" data-d="${d.id}">${d.label}</button>`).join('');
    $('domain-seg').querySelectorAll('button').forEach(b => b.onclick = () => { state.domain = b.dataset.d; renderDomain(); });
    const opts = $('domain-opts');
    if (state.domain === 'buffer') {
        opts.innerHTML = `<label>Buffer <input id="buffer-km" type="number" min="10" max="2000" step="10" value="${state._buffer ?? 100}"> km around the occupied cells</label>`;
    } else if (state.domain === 'country') {
        opts.innerHTML = `<select id="country">${COUNTRIES.map(c =>
            `<option value="${c.code}" ${c.code === (state._country || 'ES') ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}</select>`;
    } else if (state.domain === 'region') {
        opts.innerHTML = `<label>ISO 3166-2 code <input id="region" type="text" size="8" value="${escapeHtml(state._region || 'US-CA')}" placeholder="US-CA"></label>`;
    } else {
        opts.innerHTML = 'Fits inside the area currently shown on the map.';
    }
}

function domainSpec() {
    if (state.domain === 'buffer') return { type: 'buffer', buffer_km: Number($('buffer-km').value) || 100 };
    if (state.domain === 'country') return { type: 'country', country: $('country').value };
    if (state.domain === 'region') return { type: 'region', region: $('region').value.trim().toUpperCase() };
    if (state._bbox) return { type: 'bbox', bbox: state._bbox };
    const b = map.getBounds();
    const r = v => Math.round(v * 100) / 100;
    return { type: 'bbox', bbox: [r(b.getWest()), r(b.getSouth()), r(b.getEast()), r(b.getNorth())] };
}

function scenarioLabel(s) {
    const m = /ssp(\d)(\d)(\d)-(\d{4})-(\d{4})/.exec(s);
    return m ? `SSP${m[1]}-${m[2]}.${m[3]}, ${m[4]}–${m[5]}` : s;
}

async function loadOptions() {
    const [algos, covs] = await Promise.all([
        sdm.callTool('list_sdm_algorithms', {}).then(JSON.parse),
        sdm.callTool('list_covariate_layers', {}).then(JSON.parse),
    ]);
    const defaults = new Set(algos.default);
    $('algo-checks').innerHTML = Object.entries(algos.algorithms)
        .filter(([id]) => id !== 'ensemble')
        .map(([id, a]) => `<label class="check" title="${escapeHtml(a.summary)} (${escapeHtml(a.reference)})">
            <input type="checkbox" name="algo" value="${id}" ${defaults.has(id) ? 'checked' : ''}>
            <span>${escapeHtml(id)}<small>${escapeHtml(a.data)}, ${escapeHtml(a.speed)}</small></span></label>`).join('');
    const covDefaults = new Set(covs.default);
    $('cov-checks').innerHTML = Object.entries(covs.layers)
        .map(([id, c]) => `<label class="check" title="${escapeHtml(c.description)}">
            <input type="checkbox" name="cov" value="${id}" ${covDefaults.has(id) ? 'checked' : ''}>
            <span>${escapeHtml(id.replace(/_/g, ' '))}<small>${escapeHtml(c.columns.join(', '))}</small></span></label>`).join('');
    $('scenario').insertAdjacentHTML('beforeend', covs.future_scenarios
        .map(s => `<option value="${s}">${escapeHtml(scenarioLabel(s))}</option>`).join(''));
    document.querySelectorAll('input[name="algo"]').forEach(i => i.onchange = updateRunButton);
    document.querySelectorAll('input[name="cov"]').forEach(i => i.onchange = updateRunButton);
}

const checked = name => [...document.querySelectorAll(`input[name="${name}"]:checked`)].map(i => i.value);

function buildSpec() {
    let occurrences;
    if (state.source === 'upload') {
        occurrences = { points: state.upload.points };
        if (state.upload.absences.length) occurrences.absences = state.upload.absences;
    } else {
        const gbif = { species: state.species.name };
        const unc = Number($('max-unc').value);
        if (unc && unc !== 1000) gbif.max_uncertainty_m = unc;
        if ($('min-year').value) gbif.min_year = Number($('min-year').value);
        occurrences = { gbif };
    }
    const spec = {
        occurrences,
        algorithms: checked('algo'),
        covariates: checked('cov'),
        domain: domainSpec(),
    };
    if (spec.algorithms.length > 1) spec.ensemble = $('ensemble').checked;
    if ($('bias').value || Number($('bg-n').value) !== 20000) {
        spec.background = { n: Number($('bg-n').value) || 20000 };
        if ($('bias').value) spec.background.bias = $('bias').value;
    }
    if ($('resolution').value) spec.resolution = Number($('resolution').value);
    if ($('threshold').value !== 'maxSSS') spec.threshold = $('threshold').value;
    if ($('scenario').value) spec.project_to = $('scenario').value;
    return spec;
}

/** Put a saved spec back into the controls (from a #spec= link). */
function applySpec(spec) {
    const g = spec.occurrences?.gbif || {};
    if (g.species) chooseSpecies({ name: g.species });
    if (g.max_uncertainty_m) $('max-unc').value = g.max_uncertainty_m;
    if (g.min_year) $('min-year').value = g.min_year;
    const setChecks = (name, vals) => vals && document.querySelectorAll(`input[name="${name}"]`)
        .forEach(i => { i.checked = vals.includes(i.value); });
    setChecks('algo', spec.algorithms);
    setChecks('cov', spec.covariates);
    if (spec.ensemble === false) $('ensemble').checked = false;
    const d = spec.domain || { type: 'buffer' };
    state.domain = d.type;
    state._buffer = d.buffer_km; state._country = d.country; state._region = d.region;
    renderDomain();
    if (d.type === 'bbox' && d.bbox) {
        // Reuse the linked box exactly, so the request (and its cached result) matches.
        state._bbox = d.bbox;
        map.fitBounds([[d.bbox[0], d.bbox[1]], [d.bbox[2], d.bbox[3]]], { duration: 0 });
    }
    if (spec.background?.bias) $('bias').value = spec.background.bias;
    if (spec.background?.n) $('bg-n').value = spec.background.n;
    if (spec.resolution) $('resolution').value = spec.resolution;
    if (spec.threshold) $('threshold').value = spec.threshold;
    if (spec.project_to) $('scenario').value = spec.project_to;
}

function updateRunButton() {
    const algos = checked('algo');
    $('ensemble').disabled = algos.length < 2;
    const haveOcc = state.source === 'gbif' ? !!state.species : !!state.upload;
    $('run').disabled = state.running || !haveOcc || !algos.length || !checked('cov').length;
}

// ---------------------------------------------------------------------------
// Fitting
// ---------------------------------------------------------------------------

function setStatus(text, isErr = false) {
    $('status').textContent = text;
    $('status').classList.toggle('err', isErr);
}

async function fit() {
    const spec = buildSpec();
    // An uploaded point set is too large for a link; only GBIF requests are kept in the URL.
    history.replaceState(null, '', state.source === 'gbif' ? `#spec=${encodeURIComponent(JSON.stringify(spec))}` : location.pathname);
    state.running = true; updateRunButton();
    const t0 = Date.now();
    const tick = setInterval(() => setStatus(`Fitting… ${Math.round((Date.now() - t0) / 1000)} s`), 1000);
    setStatus('Fitting…');
    try {
        let r = JSON.parse(await sdm.callTool('fit_sdm', spec));
        while (r.status === 'running') {
            r = JSON.parse(await sdm.callTool('get_sdm_result', { run_id: r.run_id, wait_seconds: 60 }));
        }
        if (r.status !== 'done') throw new Error(r.error || `fit ${r.status}`);
        clearInterval(tick);
        const secs = Math.round((Date.now() - t0) / 1000);
        setStatus(r.cached || secs < 3 ? 'Done (stored result).' : `Done in ${secs} s.`);
        state.result = r; state.view = 'current';
        $('intro').hidden = true;
        await showLayers(r.artifacts.map_layers);
        const bb = r.domain?.bbox;
        if (bb) map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 30 });
        else fitToGeojson(r.artifacts.map_layers.range.geojson_url);
        renderMapChips(); renderLegend(); renderResults(spec, r);
        protectedShare(r).then(share => renderProtected(share)).catch(err => renderProtected({ error: err.message }));
        if (state.iucn) iucnAgreement(r).then(renderIucn).catch(err => renderIucn({ error: err.message }));
    } catch (err) {
        clearInterval(tick);
        setStatus(`Failed: ${err.message.slice(0, 300)}`, true);
    } finally {
        state.running = false; updateRunButton();
    }
}

/** Fit the map to a GeoJSON layer's extent. */
async function fitToGeojson(src) {
    try {
        const gj = typeof src === 'string' ? await (await fetch(src)).json() : src;
        let w = 180, s = 90, e = -180, n = -90;
        const walk = c => { if (typeof c[0] === 'number') { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); } else c.forEach(walk); };
        gj.features.forEach(f => walk(f.geometry.coordinates));
        if (w < e) map.fitBounds([[w, s], [e, n]], { padding: 40 });
    } catch { /* keep the current view */ }
}

const toS3 = url => url.replace(/^https:\/\/[^/]+\//, 's3://');

/** Share of the modelled range inside protected areas or OECMs, current and
 *  future. Coarse model cells are credited by the fraction of their res-8
 *  children that fall in a protected area. */
async function protectedShare(r) {
    const res = r.resolution;
    const h = `h${res}`;
    const k = 7 ** (8 - res);
    const pa = cfg.protected_areas.map(p => `SELECT h8 FROM read_parquet('${p.hex}', hive_partitioning=true) WHERE h0 IN (SELECT h0 FROM h0s)`).join(' UNION ');
    const one = (label, url) => `
        SELECT '${label}' AS scenario, count(*) AS cells,
               sum(coalesce(c.n, 0)) / ${k} AS protected_cells
        FROM (SELECT ${h} AS cell FROM read_parquet('${toS3(url)}') WHERE suitable) s
        LEFT JOIN cov c ON c.cell = s.cell`;
    const urls = [['current', r.artifacts.predictions_parquet]];
    if (r.artifacts.projection_parquet) urls.push(['future', r.artifacts.projection_parquet]);
    const sql = `
        WITH h0s AS (SELECT DISTINCT h3_cell_to_parent(${h}, 0)::BIGINT AS h0 FROM read_parquet('${toS3(r.artifacts.predictions_parquet)}')),
        pa AS (${pa}),
        cov AS (SELECT h3_cell_to_parent(h8, ${res}) AS cell, count(DISTINCT h8) AS n FROM pa GROUP BY 1)
        ${urls.map(([l, u]) => one(l, u)).join(' UNION ALL ')}`;
    return { rows: await db.query(sql) };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function renderResults(spec, r) {
    const cv = r.cv_metrics || {};
    const final = r.final_model;
    const models = Object.keys(cv).filter(m => !m.startsWith('_'));
    const fAuc = cv[final]?.auc;
    const proj = r.projection;
    const tile = (label, value, note = '') => `<div class="tile"><div class="tile-label">${label}</div><div class="tile-value">${value}</div>${note ? `<div class="tile-note">${note}</div>` : ''}</div>`;
    const regions = (list, title) => list?.length ? `<h4>${title}</h4><table class="results-table">
        <tr><th>Region</th><th class="n">Suitable km²</th><th class="n">Share</th></tr>
        ${list.map(x => `<tr><td>${escapeHtml(x.region)}${x.country ? ` <small>${escapeHtml(x.country)}</small>` : ''}</td><td class="n">${fmt(x.suitable_km2, 'int')}</td><td class="n">${fmt(x.share_of_range, 'pct')}</td></tr>`).join('')}</table>` : '';
    const a = r.artifacts;
    $('results').innerHTML = `
        <div class="card theme-card">
            <div class="card-head"><h3><i>${escapeHtml(speciesLabel())}</i></h3>
                <button class="ghost-btn" id="copy-link">Copy link</button></div>
            <p class="card-blurb">${escapeHtml(final)} model at H3 resolution ${r.resolution}, ${fmt(r.occurrences?.presence_cells_at_res, 'int')} presence cells from ${fmt(r.occurrences?.records, 'int')} ${state.source === 'gbif' ? 'GBIF records' : `uploaded records (${escapeHtml(state.upload?.file || '')})`}.</p>
            <div class="tiles">
                ${tile('Cross-validated AUC', fmt(fAuc, 'num2'), 'presences vs background')}
                ${tile('Suitable area', `${fmt(r.suitable_area_km2, 'compact')} km²`, '1981–2010 climate')}
                ${tile('In protected areas or OECMs', '<span id="pa-current" class="skeleton">00%</span>', 'share of the modelled range')}
            </div>
            ${proj ? `<div class="tiles">
                ${tile(escapeHtml(scenarioLabel(proj.scenario)), `${fmt(proj.suitable_area_km2, 'compact')} km²`, 'suitable area')}
                ${tile('Gained / lost', `+${fmt(proj.gained_km2, 'compact')} / −${fmt(proj.lost_km2, 'compact')}`, 'km² of range')}
                ${tile('Future range protected', '<span id="pa-future" class="skeleton">00%</span>', `${fmt(proj.cells_extrapolated, 'int')} cells extrapolated`)}
            </div>` : ''}
            ${state.iucn ? `<h4>Agreement with the IUCN range (${escapeHtml(state.iucn.sci_name)})</h4>
            <div class="tiles" id="iucn-tiles">
                ${tile('Modelled range inside the IUCN range', '<span id="iucn-a" class="skeleton">00%</span>')}
                ${tile('IUCN range modelled as suitable', '<span id="iucn-b" class="skeleton">00%</span>', 'within the study area')}
                ${tile('AUC against IUCN range', '<span id="iucn-auc" class="skeleton">0.00</span>', 'threshold-free')}
            </div>
            <p class="card-blurb">The IUCN range is an expert-drawn current distribution; the model shows potential habitat, which can extend well beyond where a species lives now.</p>` : ''}
            <h4>Cross-validation (${cv._blocks?.folds ?? spec.cv_folds ?? 5} spatial folds)</h4>
            <table class="results-table"><tr><th>Model</th><th class="n">AUC</th><th class="n">TSS</th><th class="n">Boyce</th><th class="n">Weight</th></tr>
            ${models.map(m => `<tr class="${m === final ? 'final' : ''}"><td>${escapeHtml(m)}</td><td class="n">${fmt(cv[m].auc, 'num2')}</td><td class="n">${fmt(cv[m].tss, 'num2')}</td><td class="n">${fmt(cv[m].boyce, 'num2')}</td><td class="n">${r.ensemble_weights?.[m] !== undefined ? fmt(r.ensemble_weights[m], 'num2') : ''}</td></tr>`).join('')}
            </table>
            ${regions(r.range_by_region, 'Where the range lies')}
            ${proj ? regions(proj.range_by_region, `Where the range lies, ${escapeHtml(scenarioLabel(proj.scenario))}`) : ''}
            ${r.top_covariates?.length ? `<h4>Most important predictors</h4><p class="card-blurb">${r.top_covariates.map(escapeHtml).join(', ')}</p>` : ''}
            <h4>Notes</h4>
            <ul class="notes">${[r.occurrences?.uncertainty_note, ...(r.notes || [])].filter(Boolean).map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul>
            <h4>Export</h4>
            <div class="export-row">
                <button class="ghost-btn" id="export-zip">Download .zip</button>
                <label class="check inline"><input type="checkbox" id="export-parquet"> include full-resolution predictions (parquet)</label>
                <span id="export-status" class="status"></span>
            </div>
            <div class="seg code-seg" id="code-seg" role="radiogroup" aria-label="Code">
                <button role="radio" aria-checked="false" data-lang="python">Python</button>
                <button role="radio" aria-checked="false" data-lang="r">R</button>
                <button role="radio" aria-checked="false" data-lang="json">Request JSON</button>
            </div>
            <div id="code-box" hidden><button class="ghost-btn copy-code" id="copy-code">Copy</button><pre class="request" id="code-text"></pre></div>
            <div class="links">
                ${a.map ? `<a href="${a.map}" target="_blank" rel="noopener">Full-resolution viewer</a>` : ''}
                ${a.predictions_parquet ? `<a href="${a.predictions_parquet}">predictions.parquet</a>` : ''}
                ${a.projection_parquet ? `<a href="${a.projection_parquet}">projection.parquet</a>` : ''}
                ${a.range_geojson ? `<a href="${a.range_geojson}">range.geojson</a>` : ''}
                ${a.summary ? `<a href="${a.summary}">summary.json</a>` : ''}
            </div>
        </div>`;
    $('copy-link').onclick = () => navigator.clipboard?.writeText(location.href).then(() => { $('copy-link').textContent = 'Copied'; });
    const code = { python: pythonCode(spec), r: rCode(spec), json: JSON.stringify(spec, null, 2) };
    $('code-seg').querySelectorAll('button').forEach(b => b.onclick = () => {
        const open = b.getAttribute('aria-checked') !== 'true';
        $('code-seg').querySelectorAll('button').forEach(x => x.setAttribute('aria-checked', String(open && x === b)));
        $('code-box').hidden = !open;
        $('code-text').textContent = code[b.dataset.lang];
    });
    $('copy-code').onclick = () => navigator.clipboard?.writeText($('code-text').textContent)
        .then(() => { $('copy-code').textContent = 'Copied'; setTimeout(() => { $('copy-code').textContent = 'Copy'; }, 1500); });
    $('export-zip').onclick = () => exportZip(spec, r);
}

// ---------------------------------------------------------------------------
// Export: runnable code and a .zip bundle
// ---------------------------------------------------------------------------

function pythonCode(spec) {
    return `# Refit (or fetch the stored result of) this SDM from the hexsdm MCP server,
# then read its per-cell predictions. Requires: pip install requests duckdb
import json
import duckdb
import requests

URL = "${cfg.sdm_url}"
SPEC = json.loads(r'''${JSON.stringify(spec)}''')


def call(name, args):
    """One stateless MCP tools/call; returns the tool's JSON result."""
    r = requests.post(URL, timeout=300,
                      headers={"Content-Type": "application/json",
                               "Accept": "application/json, text/event-stream"},
                      json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                            "params": {"name": name, "arguments": args}})
    r.raise_for_status()
    text = r.text.strip()
    if not text.startswith("{"):  # streamable HTTP may answer as an SSE event
        text = [line[5:] for line in text.splitlines() if line.startswith("data:")][-1]
    return json.loads(json.loads(text)["result"]["content"][0]["text"])


res = call("fit_sdm", SPEC)
while res["status"] == "running":
    res = call("get_sdm_result", {"run_id": res["run_id"], "wait_seconds": 60})
if res["status"] != "done":
    raise RuntimeError(res.get("error", res["status"]))

print("run", res["run_id"], "| final model", res["final_model"],
      "| CV AUC", res["cv_metrics"][res["final_model"]]["auc"],
      "| suitable km2", res["suitable_area_km2"])

con = duckdb.connect()
con.sql("INSTALL httpfs; LOAD httpfs;")
pred = con.sql(f"SELECT * FROM read_parquet('{res['artifacts']['predictions_parquet']}')").df()
print(pred.head())
`;
}

function rCode(spec) {
    const json = JSON.stringify(spec).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `# Refit (or fetch the stored result of) this SDM from the hexsdm MCP server,
# then read its per-cell predictions. Requires: install.packages(c("httr2", "jsonlite", "duckdb"))
library(httr2)
library(jsonlite)
library(duckdb)

url <- "${cfg.sdm_url}"
spec_json <- '${json}'

# One stateless MCP tools/call. Arguments are passed as JSON text so that
# one-element arrays (e.g. "algorithms": ["rf"]) stay arrays.
call_tool <- function(name, args_json) {
  body <- sprintf('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"%s","arguments":%s}}',
                  name, args_json)
  resp <- request(url) |>
    req_headers(Accept = "application/json, text/event-stream") |>
    req_body_raw(body, type = "application/json") |>
    req_timeout(300) |>
    req_perform()
  txt <- trimws(resp_body_string(resp))
  if (!startsWith(txt, "{")) {  # streamable HTTP may answer as an SSE event
    lines <- grep("^data:", strsplit(txt, "\\n")[[1]], value = TRUE)
    txt <- sub("^data: ?", "", tail(lines, 1))
  }
  fromJSON(fromJSON(txt, simplifyVector = FALSE)$result$content[[1]]$text, simplifyVector = FALSE)
}

res <- call_tool("fit_sdm", spec_json)
while (res$status == "running") {
  res <- call_tool("get_sdm_result", sprintf('{"run_id":"%s","wait_seconds":60}', res$run_id))
}
if (res$status != "done") stop(if (is.null(res$error)) res$status else res$error)

cat("run", res$run_id, "| final model", res$final_model,
    "| CV AUC", res$cv_metrics[[res$final_model]]$auc,
    "| suitable km2", res$suitable_area_km2, "\\n")

con <- dbConnect(duckdb())
invisible(dbExecute(con, "INSTALL httpfs; LOAD httpfs;"))
# H3 cell ids are 64-bit integers, which R would round to doubles; read them as text.
h <- paste0("h", res$resolution)
pred <- dbGetQuery(con, sprintf("SELECT * REPLACE (CAST(%s AS VARCHAR) AS %s) FROM read_parquet('%s')",
                                h, h, res$artifacts$predictions_parquet))
print(head(pred))
`;
}

let jszip = null;
function loadJsZip() {
    jszip ??= new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
        s.onload = () => resolve(window.JSZip);
        s.onerror = () => reject(new Error('could not load JSZip'));
        document.head.append(s);
    });
    return jszip;
}

/** Dataset citations, read from datasets.html so there is one copy of them. */
async function citations() {
    try {
        const doc = new DOMParser().parseFromString(await (await fetch('datasets.html')).text(), 'text/html');
        return [...doc.querySelectorAll('section.ds')].map(s => ({
            name: s.querySelector('h3')?.firstChild?.textContent.trim(),
            cite: s.querySelector('blockquote')?.textContent.replace(/\s+/g, ' ').trim(),
        }));
    } catch {
        return [];
    }
}

async function readmeText(spec, r) {
    const cv = r.cv_metrics || {};
    const proj = r.projection;
    const pageUrl = new URL('.', location.href).href;
    const lines = [
        `# Species distribution model: ${speciesLabel()}`,
        '',
        `Fitted with the hexsdm MCP server (${cfg.sdm_url}), run \`${r.run_id}\`, exported ${new Date().toISOString().slice(0, 10)} from ${pageUrl}.`,
        `Reopen in the builder: ${location.href}`,
        '',
        '## Model',
        '',
        `- Final model: ${r.final_model}, H3 resolution ${r.resolution}, mode ${r.mode}`,
        `- Occurrences: ${r.occurrences?.records} ${state.source === 'gbif' ? 'GBIF records' : `uploaded records (${state.upload?.file || ''})`} in ${r.occurrences?.presence_cells_at_res} presence cells`,
        ...(state.iucn && state.iucnAgreement && !state.iucnAgreement.error ? [
            `- IUCN range (${state.iucn.sci_name}${state.iucn.cat ? `, Red List ${state.iucn.cat}` : ''}): ${(100 * state.iucnAgreement.both_cells / state.iucnAgreement.model_cells).toFixed(1)}% of the modelled range lies inside it; ${(100 * state.iucnAgreement.both_cells / state.iucnAgreement.iucn_cells).toFixed(1)}% of it (within the study area) is modelled suitable; AUC of suitability against it ${Number(state.iucnAgreement.auc).toFixed(3)}. The IUCN range itself is not included, under the IUCN terms of use.`] : []),
        `- Background: ${r.background_cells} cells${r.background_bias ? ` (${r.background_bias})` : ' (uniform)'}`,
        `- Range threshold: ${r.threshold?.rule} = ${r.threshold?.value}`,
        `- Suitable area: ${r.suitable_area_km2} km² (1981–2010 climate)`,
        ...(proj ? [`- ${scenarioLabel(proj.scenario)}: ${proj.suitable_area_km2} km² suitable, +${proj.gained_km2} / −${proj.lost_km2} km²; ${proj.cells_extrapolated} cells outside the training range`] : []),
        '',
        '| Model | AUC | TSS | Boyce |',
        '|---|---|---|---|',
        ...Object.keys(cv).filter(m => !m.startsWith('_')).map(m => `| ${m} | ${cv[m].auc} | ${cv[m].tss} | ${cv[m].boyce} |`),
        '',
        'AUC and TSS compare presences with background cells, not surveyed absences. Suitability is relative habitat suitability from presence-only data, and the range is a potential distribution, not a confirmed one.',
        '',
        '## Where the range lies',
        '',
        '| Region | Country | Suitable km² | Share |',
        '|---|---|---|---|',
        ...(r.range_by_region || []).map(x => `| ${x.region} | ${x.country || ''} | ${x.suitable_km2} | ${x.share_of_range} |`),
        '',
        '## Notes',
        '',
        ...[r.occurrences?.uncertainty_note, ...(r.notes || [])].filter(Boolean).map(n => `- ${n}`),
        '',
        '## Files',
        '',
        '- `request.json`: the fit_sdm arguments; `reproduce.py` and `reproduce.R` send them again (the server returns the stored result for an identical request with the same server version).',
        '- `summary.json`: the full server result, including variable importance and timings.',
        '- `suitability.geojson`, `range.geojson`: the map layers (suitability coarsened for display).',
        ...(proj ? ['- `suitability_future.geojson`, `range_future.geojson`: the same for the future scenario.'] : []),
        '- `predictions.parquet` (if included): one row per H3 cell with suitability, the binary range, each model\'s prediction and an extrapolation count.',
        '',
        '## Data citations',
        '',
        ...(await citations()).map(c => `- **${c.name}.** ${c.cite}`),
        '',
    ];
    return lines.join('\n');
}

async function exportZip(spec, r) {
    const status = $('export-status');
    const btn = $('export-zip');
    btn.disabled = true;
    try {
        status.textContent = 'Preparing…';
        const JSZip = await loadJsZip();
        const zip = new JSZip();
        const a = r.artifacts;
        const files = [
            ['summary.json', a.summary],
            ['suitability.geojson', a.map_layers?.suitability?.geojson_url],
            ['range.geojson', a.range_geojson],
            ['suitability_future.geojson', a.map_layers_future?.suitability?.geojson_url],
            ['range_future.geojson', a.range_future_geojson],
        ];
        if ($('export-parquet').checked) {
            files.push(['predictions.parquet', a.predictions_parquet], ['projection.parquet', a.projection_parquet]);
        }
        let done = 0;
        const todo = files.filter(([, url]) => url);
        await Promise.all(todo.map(async ([name, url]) => {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
            zip.file(name, await res.arrayBuffer());
            status.textContent = `Downloading ${++done}/${todo.length}…`;
        }));
        zip.file('request.json', JSON.stringify(spec, null, 2));
        zip.file('reproduce.py', pythonCode(spec));
        zip.file('reproduce.R', rCode(spec));
        zip.file('README.md', await readmeText(spec, r));
        status.textContent = 'Compressing…';
        const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `sdm-${speciesLabel().replace(/\W+/g, '_')}-${r.run_id}.zip`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 10000);
        status.textContent = `Saved ${(blob.size / 1e6).toFixed(1)} MB.`;
    } catch (err) {
        status.textContent = `Export failed: ${err.message}`;
        status.classList.add('err');
    } finally {
        btn.disabled = false;
    }
}

function renderIucn(row) {
    state.iucnAgreement = row;
    const set = (id, v) => { const el = $(id); if (el) { el.classList.remove('skeleton'); el.textContent = v; if (row.error) el.title = row.error; } };
    const ok = row && !row.error && row.model_cells;
    set('iucn-a', ok ? fmt(row.both_cells / row.model_cells, 'pct') : '—');
    set('iucn-b', ok && row.iucn_cells ? fmt(row.both_cells / row.iucn_cells, 'pct') : '—');
    set('iucn-auc', ok && row.auc !== null ? fmt(row.auc, 'num2') : '—');
}

function renderProtected(share) {
    for (const which of ['current', 'future']) {
        const el = $(`pa-${which}`);
        if (!el) continue;
        el.classList.remove('skeleton');
        const row = share.rows?.find(x => x.scenario === which);
        el.textContent = row && row.cells ? fmt(row.protected_cells / row.cells, 'pct') : '—';
        if (share.error) el.title = share.error;
    }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

$('run').onclick = fit;
// The record preview applies the same uncertainty and year filters as the fit.
for (const id of ['max-unc', 'min-year']) $(id).addEventListener('change', () => {
    if (state.source === 'gbif' && state.species) previewGbif(state.species.name);
});
renderDomain();
try {
    await loadOptions();
} catch (err) {
    setStatus(`Could not reach the SDM server: ${err.message}`, true);
}
updateRunButton();

const saved = new URLSearchParams(location.hash.slice(1)).get('spec');
if (saved) {
    try {
        applySpec(JSON.parse(saved));
        await mapReady;
        updateRunButton();
        if (!$('run').disabled) fit();
    } catch (err) {
        setStatus(`Could not read the link: ${err.message}`, true);
    }
}
