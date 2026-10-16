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
const DOMAIN_TYPES = [
    { id: 'buffer', label: 'Around the records' },
    { id: 'country', label: 'Country' },
    { id: 'region', label: 'State / province' },
    { id: 'bbox', label: 'Current map view' },
];

const $ = id => document.getElementById(id);
const state = { species: null, domain: 'buffer', result: null, view: 'current', running: false };

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

const layerOn = { suit: true, range: true, wdpa: false, oecm: false };

function applyVisibility() {
    const vis = on => (on ? 'visible' : 'none');
    if (map.getLayer('sdm-suit')) map.setLayoutProperty('sdm-suit', 'visibility', vis(layerOn.suit));
    for (const id of ['sdm-range', 'sdm-range-line'])
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis(layerOn.range));
    for (const pa of cfg.protected_areas)
        if (map.getLayer(`${pa.id}-line`)) map.setLayoutProperty(`${pa.id}-line`, 'visibility', vis(layerOn[pa.id]));
}

function renderMapChips() {
    const r = state.result;
    const chips = $('map-chips');
    chips.hidden = !r;
    if (!r) return;
    const btn = (key, label, c) => `<button class="map-btn" data-layer="${key}" aria-pressed="${layerOn[key]}" style="--c:${c}">${label}</button>`;
    const views = r.artifacts.map_layers_future
        ? `<span class="lbl">Climate</span>
           <button class="map-btn" data-view="current" aria-pressed="${state.view === 'current'}" style="--c:var(--primary)">1981–2010</button>
           <button class="map-btn" data-view="future" aria-pressed="${state.view === 'future'}" style="--c:var(--primary)">${escapeHtml(scenarioLabel(r.projection?.scenario || ''))}</button>`
        : '';
    chips.innerHTML = `${views}<span class="lbl">Show</span>${btn('suit', 'Suitability', '#21918c')}${btn('range', 'Range', RANGE_COLOR)}`
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
    el.hidden = !r;
    if (!r) return;
    const when = state.view === 'future' ? scenarioLabel(r.projection?.scenario || '') : '1981–2010 climate';
    el.innerHTML = `<div class="title">${escapeHtml(state.species?.name || '')}</div>
        ${layerOn.suit ? `<div class="row">Habitat suitability, ${escapeHtml(when)}</div>
        <div class="ramp">${VIRIDIS.map(c => `<span style="background:${c}"></span>`).join('')}</div>
        <div class="ends"><span>0 low</span><span>1 high</span></div>` : ''}
        ${layerOn.range ? `<div class="row"><span class="swatch" style="background:${RANGE_COLOR};opacity:.6"></span>Modelled range (threshold ${fmt(r.threshold?.value, 'num2')})</div>` : ''}
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
    $('species-help').innerHTML = `<span class="species-chosen"><i>${escapeHtml(s.name)}</i>${s.common ? `, ${escapeHtml(s.common)}` : ''}</span>`;
    updateRunButton();
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
    const gbif = { species: state.species.name };
    const unc = Number($('max-unc').value);
    if (unc && unc !== 1000) gbif.max_uncertainty_m = unc;
    if ($('min-year').value) gbif.min_year = Number($('min-year').value);
    const spec = {
        occurrences: { gbif },
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
    $('run').disabled = state.running || !state.species || !algos.length || !checked('cov').length;
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
    history.replaceState(null, '', `#spec=${encodeURIComponent(JSON.stringify(spec))}`);
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
    } catch (err) {
        clearInterval(tick);
        setStatus(`Failed: ${err.message.slice(0, 300)}`, true);
    } finally {
        state.running = false; updateRunButton();
    }
}

/** Fit the map to a GeoJSON layer's extent. */
async function fitToGeojson(url) {
    try {
        const gj = await (await fetch(url)).json();
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
            <div class="card-head"><h3><i>${escapeHtml(state.species.name)}</i></h3>
                <button class="ghost-btn" id="copy-link">Copy link</button></div>
            <p class="card-blurb">${escapeHtml(final)} model at H3 resolution ${r.resolution}, ${fmt(r.occurrences?.presence_cells_at_res, 'int')} presence cells from ${fmt(r.occurrences?.records, 'int')} GBIF records.</p>
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
            <h4>Cross-validation (${cv._blocks?.folds ?? spec.cv_folds ?? 5} spatial folds)</h4>
            <table class="results-table"><tr><th>Model</th><th class="n">AUC</th><th class="n">TSS</th><th class="n">Boyce</th><th class="n">Weight</th></tr>
            ${models.map(m => `<tr class="${m === final ? 'final' : ''}"><td>${escapeHtml(m)}</td><td class="n">${fmt(cv[m].auc, 'num2')}</td><td class="n">${fmt(cv[m].tss, 'num2')}</td><td class="n">${fmt(cv[m].boyce, 'num2')}</td><td class="n">${r.ensemble_weights?.[m] !== undefined ? fmt(r.ensemble_weights[m], 'num2') : ''}</td></tr>`).join('')}
            </table>
            ${regions(r.range_by_region, 'Where the range lies')}
            ${proj ? regions(proj.range_by_region, `Where the range lies, ${escapeHtml(scenarioLabel(proj.scenario))}`) : ''}
            ${r.top_covariates?.length ? `<h4>Most important predictors</h4><p class="card-blurb">${r.top_covariates.map(escapeHtml).join(', ')}</p>` : ''}
            <h4>Notes</h4>
            <ul class="notes">${[r.occurrences?.uncertainty_note, ...(r.notes || [])].filter(Boolean).map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul>
            <div class="links">
                ${a.map ? `<a href="${a.map}" target="_blank" rel="noopener">Full-resolution viewer</a>` : ''}
                ${a.predictions_parquet ? `<a href="${a.predictions_parquet}">predictions.parquet</a>` : ''}
                ${a.projection_parquet ? `<a href="${a.projection_parquet}">projection.parquet</a>` : ''}
                ${a.range_geojson ? `<a href="${a.range_geojson}">range.geojson</a>` : ''}
                ${a.summary ? `<a href="${a.summary}">summary.json</a>` : ''}
            </div>
            <details><summary class="card-blurb">fit_sdm request (run ${escapeHtml(r.run_id)})</summary>
                <pre class="request">${escapeHtml(JSON.stringify(spec, null, 2))}</pre></details>
        </div>`;
    $('copy-link').onclick = () => navigator.clipboard?.writeText(location.href).then(() => { $('copy-link').textContent = 'Copied'; });
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
