/**
 * species.js — a glen core plugin for the IUCN species explorer.
 *
 * It adds a species search and a species card to the top of the side panel,
 * draws the chosen species' IUCN range and GBIF records on the map, and keeps
 * the `species` control of plugins/controls.js in step with the choice, so
 * every chart and query that uses {{SPECIES}} or {{SPECIES_NAME}} re-runs when
 * the species changes. The agent changes species with `select_species` and
 * reads the card with `get_species_card`.
 *
 * List it after plugins/mcp.js, plugins/controls.js and plugins/charts.js:
 *
 *   { "url": "species.js", "options": { "control": "species" } }
 *
 * The controls config must define the `species` control with at least one
 * option, `{ "value": "<IUCN id_no>", "label": "...", "tokens": { "SPECIES_NAME": "<binomial>" } }`.
 * This plugin adds an option for each species the reader picks.
 *
 * Queries go to the deployment's MCP server (config.json `mcp_server_url`)
 * with glen-charts' stateless client, so they do not appear in the chat.
 */

import { McpQueryClient } from 'https://cdn.jsdelivr.net/gh/SchmidtDSE/glen-charts@v0.18.0/core/mcp.js';

const PATHS = {
    index: 's3://public-iucn/iucn-ranges-2025/species-h0-index.parquet',
    hex: 's3://public-iucn/iucn-ranges-2025/hex/h0=*/data_0.parquet',
    taxonomy: 's3://public-iucn/taxonomy/iucn-taxonomy.parquet',
    gbif: 's3://public-gbif/2026-09/hex/h0=*/data_0.parquet',
    gbifIndex: 's3://public-gbif/2026-09/species-h0-index.parquet',
    wdpa: 's3://public-wdpa/wdpa/hex/h0=*/data_0.parquet',
    oecm: 's3://public-wdpa/wdoecm-may-2026/hex/h0=*/data_0.parquet',
    treeCover: 's3://public-forest-change/tree-cover-loss/tree-cover-2000/hex/h0=*/data_0.parquet',
    treeLoss: 's3://public-forest-change/tree-cover-loss/loss-year/hex/h0=*/data_0.parquet',
};

const GBIF_FILTER = `NOT list_has_any(issue, ['ZERO_COORDINATE', 'COORDINATE_INVALID', 'COORDINATE_OUT_OF_RANGE', 'COUNTRY_COORDINATE_MISMATCH'])
      AND coalesce(occurrencestatus, 'PRESENT') <> 'ABSENT'
      AND basisofrecord NOT IN ('FOSSIL_SPECIMEN', 'LIVING_SPECIMEN')`;

// WDPA sites that count toward coverage: not proposed, not UNESCO-MAB.
const WDPA_FILTER = `STATUS <> 'Proposed' AND DESIG_ENG <> 'UNESCO-MAB Biosphere Reserve'`;

// IUCN Red List category colours (IUCN's own palette).
const CATEGORIES = {
    EX: ['Extinct', '#000000', '#fff'],
    EW: ['Extinct in the Wild', '#542344', '#fff'],
    CR: ['Critically Endangered', '#d81e05', '#fff'],
    EN: ['Endangered', '#fc7f3f', '#1a1a1a'],
    VU: ['Vulnerable', '#f9e814', '#1a1a1a'],
    NT: ['Near Threatened', '#cce226', '#1a1a1a'],
    LC: ['Least Concern', '#60c659', '#1a1a1a'],
    DD: ['Data Deficient', '#d1d1c6', '#1a1a1a'],
};

const COLORS = { range: '#7cb342', rangeLine: '#33691e', occ: '#7b4fc9', strict: '#e8a33d', other: '#5b8cc0', oecm: '#4db6ac', none: '#e6e6e0', loss: '#a0522d' };
const RANGE_LAYER = 'iucn-range';
const PA_LAYER = 'protected-in-range';
const OCC_LAYER = 'gbif-records';
// Protected cells drawn on the map: the finest H3 resolution that keeps the range under this many cells.
const PA_MAX_CELLS = 25000;
const SAFE_NAME = /^[A-Z][a-z]+( [a-z][a-z-]*){1,2}$/;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sqlStr = s => `'${String(s).replace(/'/g, "''")}'`;
const titleCase = s => (s ? String(s).charAt(0) + String(s).slice(1).toLowerCase() : '');
const pct = (x, d = 0) => (x == null || !isFinite(x) ? '—' : `${(100 * x).toFixed(x > 0 && x < 0.01 ? 1 : d)}%`);
const num = x => (x == null || !isFinite(x) ? '—' : Math.round(x).toLocaleString('en-US'));
const clean = v => (v === null || v === undefined || v === 'nan' || v === '' ? null : v);

/**
 * The share of a species' range that protection should cover, from its range
 * size: 100% below 10,000 km², 15% above 2.5 million km², and log-linear in
 * between (the Species Protection Score rule of Jetz et al. 2022).
 */
export function protectionTarget(km2) {
    const lo = 1e4, hi = 2.5e6;
    if (!(km2 > 0)) return null;
    if (km2 <= lo) return 1;
    if (km2 >= hi) return 0.15;
    const t = (Math.log10(km2) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo));
    return 1 - t * (1 - 0.15);
}

const plugin = {
    name: 'species',

    async setup(ctx, options = {}) {
        const bus = ctx.params;
        if (!bus) throw new Error('species.js needs plugins/controls.js listed before it.');
        const controlId = options.control || 'species';
        if (!bus.get(controlId)) throw new Error(`species.js needs a "${controlId}" control.`);
        const paths = { ...PATHS, ...(options.paths || {}) };
        const mcpUrl = ctx.runtimeConfig?.mcp_server_url || options.mcp_url;
        if (!mcpUrl) throw new Error('species.js needs mcp_server_url in config.json.');
        const db = new McpQueryClient(mcpUrl, { timeoutMs: 180000 });
        const mm = ctx.map;
        const ml = mm.map;

        const state = { taxon: null, stats: null, occ: null, wiki: null, photo: null, habitat: null };
        const taxa = new Map();   // id → taxonomy row
        const seq = { info: 0, range: 0, occ: 0, stats: 0, habitat: 0 };
        let habitatKey = null, habitatJob = null;

        /* ── Queries ─────────────────────────────────────────────────── */

        async function lookup(id) {
            id = String(id);
            if (taxa.has(id)) return taxa.get(id);
            const [row] = await db.query(`
                SELECT i.id_no AS id, coalesce(t.scientific_name, i.sci_name) AS name, t.common_name_en AS common,
                       t.kingdom, t.class, t."order" AS ord, t.family, t.latest_category_code AS cat,
                       t.population_trend AS trend, t.redlist_criteria AS criteria,
                       left(CAST(t.assessment_date AS VARCHAR), 4) AS assessed, t.latest_year_published AS published,
                       t.eoo_km2, t.systems, t.realm, t.country_codes AS countries, t.possibly_extinct
                FROM (SELECT DISTINCT id_no, sci_name FROM read_parquet('${paths.index}') WHERE id_no = ${Number(id)}) i
                LEFT JOIN read_parquet('${paths.taxonomy}') t ON t.sis_taxon_id = i.id_no
                LIMIT 1`);
            if (!row) return null;
            for (const k of Object.keys(row)) row[k] = clean(row[k]);
            row.id = String(row.id);
            taxa.set(row.id, row);
            return row;
        }

        async function search(text) {
            const q = String(text).replace(/[^\p{L}\p{N} .'-]/gu, ' ').trim().replace(/\s+/g, ' ');
            if (q.length < 3) return [];
            const like = sqlStr(`%${q}%`), pre = sqlStr(`${q}%`), exact = sqlStr(q.toLowerCase());
            const rows = await db.query(`
                SELECT t.sis_taxon_id AS id, t.scientific_name AS name, t.common_name_en AS common,
                       t.latest_category_code AS cat, t.class
                FROM read_parquet('${paths.taxonomy}') t
                WHERE (t.scientific_name ILIKE ${like} OR array_to_string(t.common_names_en, '|') ILIKE ${like})
                  AND t.sis_taxon_id IN (SELECT id_no FROM read_parquet('${paths.index}'))
                ORDER BY (lower(t.common_name_en) = ${exact} OR lower(t.scientific_name) = ${exact}) DESC,
                         (t.common_name_en ILIKE ${pre} OR t.scientific_name ILIKE ${pre}) DESC,
                         length(t.scientific_name)
                LIMIT 12`);
            return rows.map(r => ({ ...r, id: String(r.id), common: clean(r.common), cat: clean(r.cat), class: clean(r.class) }));
        }

        const tokens = () => bus.tokens();
        const rangeSrc = (id, presence) => `
            idx AS (SELECT id_no, sci_name, h0 FROM read_parquet('${paths.index}')),
            ids AS (SELECT DISTINCT id_no FROM idx WHERE sci_name IN
                        (SELECT sci_name FROM read_parquet('${paths.index}') WHERE id_no = ${Number(id)})),
            h0s AS (SELECT DISTINCT h0 FROM idx WHERE id_no IN (SELECT id_no FROM ids)),
            src AS (SELECT native_res, h8, h7, h6, h5, h4 FROM read_parquet('${paths.hex}', hive_partitioning = true)
                    WHERE h0 IN (SELECT h0 FROM h0s) AND id_no IN (SELECT id_no FROM ids)
                      AND presence IN (${presence}) AND origin IN (1, 2))`;

        /** Range cells at a resolution fit for drawing: finer for small ranges. */
        async function rangeCells(id, presence) {
            const rows = await db.query(`
                WITH ${rangeSrc(id, presence)},
                k AS (SELECT min(native_res) AS m, count(DISTINCT h6) AS n6 FROM src)
                SELECT DISTINCT h3_h3_to_string(CASE
                    WHEN (SELECT m FROM k) >= 8 AND (SELECT n6 FROM k) < 3000 THEN h7
                    WHEN (SELECT m FROM k) >= 6 AND (SELECT n6 FROM k) < 20000 THEN h6
                    WHEN (SELECT n6 FROM k) < 140000 THEN h5 ELSE h4 END) AS cell
                FROM src`);
            return rows.map(r => r.cell).filter(Boolean);
        }

        /** Share of the range in strict protected areas, other protected areas and OECMs, counted on H3 resolution 8 cells. */
        async function protection(id, presence) {
            const [row] = await db.query(`
                WITH ${rangeSrc(id, presence)},
                nr AS (SELECT CASE WHEN min(native_res) >= 8 THEN 8 WHEN min(native_res) >= 6 THEN 6 ELSE 5 END AS r FROM src),
                rng AS (SELECT DISTINCT CASE (SELECT r FROM nr) WHEN 8 THEN h8 WHEN 6 THEN h6 ELSE h5 END AS cell FROM src),
                pa AS (SELECT h8, max(CASE WHEN IUCN_CAT IN ('Ia', 'Ib', 'II') THEN 2 ELSE 1 END) AS lvl
                       FROM read_parquet('${paths.wdpa}', hive_partitioning = true)
                       WHERE h0 IN (SELECT h0 FROM h0s) AND ${WDPA_FILTER}
                         AND h3_cell_to_parent(h8, (SELECT r FROM nr)) IN (SELECT cell FROM rng)
                       GROUP BY h8),
                oe AS (SELECT DISTINCT h8 FROM read_parquet('${paths.oecm}', hive_partitioning = true)
                       WHERE h0 IN (SELECT h0 FROM h0s)
                         AND h3_cell_to_parent(h8, (SELECT r FROM nr)) IN (SELECT cell FROM rng)),
                dr AS (SELECT CASE WHEN n <= ${PA_MAX_CELLS} THEN 8 WHEN n <= ${PA_MAX_CELLS} * 7 THEN 7 WHEN n <= ${PA_MAX_CELLS} * 49 THEN 6
                                   WHEN n <= ${PA_MAX_CELLS} * 343 THEN 5 ELSE 4 END AS r
                       FROM (SELECT count(*) * pow(7, 8 - (SELECT r FROM nr)) AS n FROM rng)),
                pc AS (SELECT h3_cell_to_parent(h8, (SELECT r FROM dr)) AS c, count(*) FILTER (lvl = 2) AS s, count(*) FILTER (lvl = 1) AS o, 0 AS e
                       FROM pa GROUP BY 1
                       UNION ALL
                       SELECT h3_cell_to_parent(h8, (SELECT r FROM dr)), 0, 0, count(*) FROM oe WHERE h8 NOT IN (SELECT h8 FROM pa) GROUP BY 1),
                pcs AS (SELECT h3_h3_to_string(c) AS c, sum(s)::INT AS s, sum(o)::INT AS o, sum(e)::INT AS e FROM pc GROUP BY c)
                SELECT (SELECT r FROM nr) AS res,
                       (SELECT r FROM dr) AS pa_res,
                       (SELECT list({'c': c, 's': s, 'o': o, 'e': e}) FROM pcs) AS pa_cells,
                       (SELECT sum(h3_cell_area(cell, 'km^2')) FROM rng) AS range_km2,
                       (SELECT count(*) FROM rng) * pow(7, 8 - (SELECT r FROM nr)) AS cells,
                       (SELECT count(*) FILTER (lvl = 2) FROM pa) AS strict,
                       (SELECT count(*) FILTER (lvl = 1) FROM pa) AS other,
                       (SELECT count(*) FROM oe WHERE h8 NOT IN (SELECT h8 FROM pa)) AS oecm`);
            return row || null;
        }

        /**
         * Tree cover in the range in 2000 and its loss each year since, inside and
         * outside protected areas (Hansen Global Forest Change, H3 resolution 8).
         */
        async function habitat(id, presence) {
            const [row] = await db.query(`
                WITH ${rangeSrc(id, presence)},
                nr AS (SELECT CASE WHEN min(native_res) >= 8 THEN 8 WHEN min(native_res) >= 6 THEN 6 ELSE 5 END AS r FROM src),
                rng AS (SELECT DISTINCT CASE (SELECT r FROM nr) WHEN 8 THEN h8 WHEN 6 THEN h6 ELSE h5 END AS cell FROM src),
                pa AS (SELECT DISTINCT h8 FROM read_parquet('${paths.wdpa}', hive_partitioning = true)
                       WHERE h0 IN (SELECT h0 FROM h0s) AND ${WDPA_FILTER}
                         AND h3_cell_to_parent(h8, (SELECT r FROM nr)) IN (SELECT cell FROM rng)),
                tc AS (SELECT h8, tree_cover_2000 / 100 * h3_cell_area(h8, 'km^2') AS t, h3_cell_area(h8, 'km^2') AS a
                       FROM read_parquet('${paths.treeCover}', hive_partitioning = true)
                       WHERE h0 IN (SELECT h0 FROM h0s) AND h3_cell_to_parent(h8, (SELECT r FROM nr)) IN (SELECT cell FROM rng)),
                ls AS (SELECT h8, loss_year AS y, frac * h3_cell_area(h8, 'km^2') AS km2
                       FROM read_parquet('${paths.treeLoss}', hive_partitioning = true)
                       WHERE h0 IN (SELECT h0 FROM h0s) AND loss_year BETWEEN 1 AND 25
                         AND h3_cell_to_parent(h8, (SELECT r FROM nr)) IN (SELECT cell FROM rng)),
                yr AS (SELECT 2000 + y AS year, coalesce(sum(km2) FILTER (h8 IN (SELECT h8 FROM pa)), 0) AS p,
                              coalesce(sum(km2) FILTER (h8 NOT IN (SELECT h8 FROM pa)), 0) AS u
                       FROM ls GROUP BY y)
                SELECT (SELECT sum(a) FROM tc) AS land_km2,
                       (SELECT sum(t) FROM tc) AS tree_km2,
                       (SELECT sum(t) FROM tc WHERE h8 IN (SELECT h8 FROM pa)) AS tree_pa_km2,
                       (SELECT sum(a) FROM tc WHERE h8 IN (SELECT h8 FROM pa)) AS land_pa_km2,
                       (SELECT list({'year': year, 'p': p, 'u': u} ORDER BY year) FROM yr) AS loss`);
            return row || null;
        }

        /** GBIF records hexed for the map: H3 resolution 6, or 5 or 4 for widespread species. */
        async function occurrences(name, since) {
            if (!SAFE_NAME.test(name || '')) return { cells: [], total: 0 };
            const rows = await db.query(`
                WITH r AS (SELECT h6, h5, h4 FROM read_parquet('${paths.gbif}', hive_partitioning = true)
                           WHERE h0 IN (SELECT h0 FROM read_parquet('${paths.gbifIndex}') WHERE species = ${sqlStr(name)})
                             AND species = ${sqlStr(name)} AND ${GBIF_FILTER}
                             AND (${Number(since)} = 0 OR "year" >= ${Number(since)})),
                k AS (SELECT count(DISTINCT h6) AS n6, count(DISTINCT h5) AS n5 FROM r)
                SELECT h3_h3_to_string(CASE WHEN (SELECT n6 FROM k) <= 1500 THEN h6
                                            WHEN (SELECT n5 FROM k) <= 1500 THEN h5 ELSE h4 END) AS cell, count(*)::INT AS n
                FROM r GROUP BY 1`);
            return { cells: rows, total: rows.reduce((a, r) => a + r.n, 0) };
        }

        async function wikipedia(name) {
            try {
                const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name.replace(/ /g, '_'))}`);
                if (!res.ok) return null;
                const d = await res.json();
                if (d.type !== 'standard' || !d.extract) return null;
                return { text: d.extract, url: d.content_urls?.desktop?.page, image: d.thumbnail?.source || null, title: d.title };
            } catch { return null; }
        }

        async function inatPhoto(name) {
            try {
                const res = await fetch(`https://api.inaturalist.org/v1/taxa?q=${encodeURIComponent(name)}&rank=species&per_page=5`);
                if (!res.ok) return null;
                const hit = (await res.json()).results?.find(r => r.name === name && r.default_photo);
                if (!hit) return null;
                return { src: hit.default_photo.medium_url, credit: hit.default_photo.attribution, url: `https://www.inaturalist.org/taxa/${hit.id}` };
            } catch { return null; }
        }

        /* ── Map layers ──────────────────────────────────────────────── */

        const layerId = id => `upload-${id}`;

        /** Put GeoJSON in one of this plugin's panel layers, adding the layer the first time. */
        function setLayer(id, geojson, opts) {
            const lid = layerId(id);
            if (mm.layers.has(lid) && ml.getSource(lid)) {
                ml.getSource(lid).setData(geojson);
                return;
            }
            mm.addUploadedLayer({ id, geojson, fitBounds: false, ...opts });
            opts.after?.(lid);
            restack();
        }

        function cellsToFeature(cells) {
            const coords = h3.cellsToMultiPolygon(cells, true);
            return { type: 'FeatureCollection', features: coords.length ? [{ type: 'Feature', properties: { layer: 'IUCN range' }, geometry: { type: 'MultiPolygon', coordinates: coords } }] : [] };
        }

        function occFeatures(rows) {
            return {
                type: 'FeatureCollection',
                features: rows.map(r => {
                    const ring = h3.cellToBoundary(r.cell, true);
                    return { type: 'Feature', properties: { records: r.n }, geometry: { type: 'Polygon', coordinates: [ring] } };
                }),
            };
        }

        /** Protected cells of the range, classed by their strictest majority: strict, other or OECM. */
        function paFeatures(st) {
            const withOecm = tokens().OECM === '1';
            const full = 7 ** (8 - Number(st?.pa_res ?? 8));
            const features = [];
            for (const r of st?.pa_cells || []) {
                const e = withOecm ? r.e : 0;
                const prot = r.s + r.o + e;
                if (!prot) continue;
                const cls = r.s >= r.o && r.s >= e ? 'strict' : r.o >= e ? 'other' : 'oecm';
                features.push({
                    type: 'Feature',
                    properties: {
                        cls,
                        cover: Math.min(1, prot / full),
                        protection: { strict: 'Mostly strict protected areas', other: 'Mostly other protected areas', oecm: 'Mostly OECMs' }[cls],
                        'share of cell protected': pct(Math.min(1, prot / full)),
                    },
                    geometry: { type: 'Polygon', coordinates: [h3.cellToBoundary(r.c, true)] },
                });
            }
            return { type: 'FeatureCollection', features };
        }

        /** Keep the range at the bottom, protected cells above it and GBIF records on top. */
        function restack() {
            for (const id of [RANGE_LAYER, PA_LAYER, OCC_LAYER]) {
                const lid = layerId(id);
                for (const l of [lid, `${lid}-outline`]) if (ml.getLayer(l)) ml.moveLayer(l);
            }
        }

        function drawProtected() {
            const st = state.stats;
            if (!st || st.error) return;
            setLayer(PA_LAYER, paFeatures(st), {
                displayName: 'Protected areas in the range', fillColor: COLORS.other, outlineColor: COLORS.other, opacity: 0.6,
                tooltipFields: ['protection', 'share of cell protected'],
                after: lid => {
                    const color = ['match', ['get', 'cls'], 'strict', COLORS.strict, 'oecm', COLORS.oecm, COLORS.other];
                    ml.setPaintProperty(lid, 'fill-color', color);
                    ml.setPaintProperty(lid, 'fill-opacity', ['+', 0.3, ['*', 0.45, ['get', 'cover']]]);
                    if (ml.getLayer(`${lid}-outline`)) {
                        ml.setPaintProperty(`${lid}-outline`, 'line-color', color);
                        ml.setPaintProperty(`${lid}-outline`, 'line-width', 0.3);
                    }
                },
            });
            restack();
        }

        function fitTo(fc) {
            let w = 180, s = 90, e = -180, n = -90;
            const visit = c => { if (typeof c[0] === 'number') { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); } else c.forEach(visit); };
            fc.features.forEach(f => visit(f.geometry.coordinates));
            if (w > e) return;
            // a range that crosses the antimeridian spans the globe; show it whole
            if (e - w > 300) { ml.fitBounds([[-180, -60], [180, 75]], { padding: 20, duration: 800 }); return; }
            ml.fitBounds([[w, s], [e, n]], { padding: 50, duration: 800, maxZoom: 7 });
        }

        /* ── Card ────────────────────────────────────────────────────── */

        const doc = document;
        const pane = ctx.layout?.menuMountId ? doc.getElementById(ctx.layout.menuMountId) : null;
        const card = doc.createElement('section');
        card.className = 'species-card menu-section';
        card.setAttribute('aria-label', 'Species');
        card.innerHTML = `
            <div class="sp-search">
                <input type="search" id="sp-input" autocomplete="off" spellcheck="false"
                       placeholder="Search a species by scientific or common name" aria-label="Species search">
                <ul id="sp-results" role="listbox" hidden></ul>
            </div>
            <div class="sp-head">
                <div class="sp-photo" id="sp-photo"></div>
                <div class="sp-names">
                    <div class="sp-family" id="sp-family"></div>
                    <div class="sp-common" id="sp-common"></div>
                    <div class="sp-sci" id="sp-sci"></div>
                    <div class="sp-badges" id="sp-badges"></div>
                </div>
            </div>
            <div class="sp-about" id="sp-about"></div>
            <div class="sp-tabs" role="tablist">
                <button role="tab" aria-selected="true" data-tab="protection">Protection</button>
                <button role="tab" aria-selected="false" data-tab="habitat">Habitat trends</button>
                <button role="tab" aria-selected="false" data-tab="data">Data</button>
                <button role="tab" aria-selected="false" data-tab="assessment">Assessment</button>
            </div>
            <div class="sp-tab" data-pane="protection" id="sp-protection"></div>
            <div class="sp-tab" data-pane="habitat" id="sp-habitat" hidden></div>
            <div class="sp-tab" data-pane="data" id="sp-data" hidden></div>
            <div class="sp-tab" data-pane="assessment" id="sp-assessment" hidden></div>`;
        if (pane) pane.prepend(card);
        const $ = id => card.querySelector(`#${id}`);

        card.querySelectorAll('[role=tab]').forEach(b => b.addEventListener('click', () => {
            card.querySelectorAll('[role=tab]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
            card.querySelectorAll('.sp-tab').forEach(p => { p.hidden = p.dataset.pane !== b.dataset.tab; });
            if (b.dataset.tab === 'habitat') loadHabitat().catch(() => {});
        }));
        const habitatOpen = () => !$('sp-habitat').hidden;

        // search box
        const input = $('sp-input'), list = $('sp-results');
        let searchTimer = null, searchSeq = 0;
        input.addEventListener('input', () => {
            clearTimeout(searchTimer);
            const text = input.value;
            if (text.trim().length < 3) { list.hidden = true; return; }
            searchTimer = setTimeout(async () => {
                const s = ++searchSeq;
                list.hidden = false;
                list.innerHTML = '<li class="sp-muted">Searching…</li>';
                try {
                    const rows = await search(text);
                    if (s !== searchSeq) return;
                    list.innerHTML = rows.length ? rows.map(r => `
                        <li role="option" data-id="${esc(r.id)}">
                            ${badge(r.cat, true)}<span><i>${esc(r.name)}</i>${r.common ? ` <span class="sp-muted">${esc(r.common)}</span>` : ''}</span>
                        </li>`).join('') : '<li class="sp-muted">No species with an IUCN range map matches.</li>';
                } catch (err) {
                    if (s === searchSeq) list.innerHTML = `<li class="sp-muted">Search failed: ${esc(err.message.slice(0, 120))}</li>`;
                }
            }, 350);
        });
        list.addEventListener('click', e => {
            const li = e.target.closest('li[data-id]');
            if (!li) return;
            list.hidden = true;
            input.value = '';
            selectById(li.dataset.id).catch(err => console.error('[species]', err));
        });
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') { const first = list.querySelector('li[data-id]'); if (first) first.click(); }
            if (e.key === 'Escape') list.hidden = true;
        });
        doc.addEventListener('click', e => { if (!card.querySelector('.sp-search').contains(e.target)) list.hidden = true; });

        function badge(cat, small = false) {
            const c = CATEGORIES[cat];
            if (!c) return small ? '<span class="sp-cat sp-cat-small sp-cat-ne" title="Not evaluated">NE</span>' : '';
            return small
                ? `<span class="sp-cat sp-cat-small" style="background:${c[1]};color:${c[2]}" title="${c[0]}">${cat}</span>`
                : `<span class="sp-cat" style="background:${c[1]};color:${c[2]}">${c[0]} on the IUCN Red List</span>`;
        }

        function renderHead() {
            const t = state.taxon;
            if (!t) return;
            $('sp-family').textContent = [titleCase(t.class), titleCase(t.family)].filter(Boolean).join(' · ');
            $('sp-common').textContent = t.common || '';
            $('sp-sci').innerHTML = `<i>${esc(t.name)}</i>`;
            const trend = t.trend && t.trend !== 'Unknown' ? `<span class="sp-chip">Population ${esc(t.trend.toLowerCase())}</span>` : '';
            $('sp-badges').innerHTML = badge(t.cat) + trend;
            const w = state.wiki, p = state.photo;
            const img = w?.image ? { src: w.image, credit: 'Wikipedia', url: w.url } : p;
            $('sp-photo').innerHTML = img
                ? `<a href="${esc(img.url || '#')}" target="_blank" rel="noopener"><img src="${esc(img.src)}" alt="${esc(t.common || t.name)}"></a><div class="sp-credit">${esc(img.credit || '')}</div>`
                : `<div class="sp-nophoto">No photo</div>`;
            $('sp-about').innerHTML = w
                ? `<p class="sp-extract">${esc(w.text)}</p><div class="sp-source"><button type="button" class="sp-more">Show more</button><span>Source <a href="${esc(w.url)}" target="_blank" rel="noopener">Wikipedia</a></span></div>`
                : state.wiki === null ? '' : '<p class="sp-muted">Loading the description…</p>';
            $('sp-about').querySelector('.sp-more')?.addEventListener('click', e => {
                const ex = $('sp-about').querySelector('.sp-extract');
                ex.classList.toggle('open');
                e.target.textContent = ex.classList.contains('open') ? 'Show less' : 'Show more';
            });
            renderAssessment();
        }

        function renderAssessment() {
            const t = state.taxon;
            const row = (k, v) => (v ? `<tr><th>${k}</th><td>${v}</td></tr>` : '');
            const cat = CATEGORIES[t.cat]?.[0];
            $('sp-assessment').innerHTML = `
                <table class="sp-table">
                    ${row('Red List category', cat ? `${esc(cat)} (${esc(t.cat)})` : 'Not evaluated')}
                    ${row('Criteria', esc(t.criteria))}
                    ${row('Assessed', esc(t.assessed || t.published))}
                    ${row('Population trend', esc(t.trend))}
                    ${row('Possibly extinct', t.possibly_extinct === true || t.possibly_extinct === 'True' ? 'Yes' : '')}
                    ${row('Extent of occurrence', t.eoo_km2 ? `${num(Number(t.eoo_km2))} km²` : '')}
                    ${row('Systems', esc(t.systems?.replace(/\|/g, ', ')))}
                    ${row('Realm', esc(t.realm?.replace(/\|/g, ', ')))}
                    ${row('Countries', Array.isArray(t.countries) ? esc(t.countries.join(', ')) : '')}
                    ${row('Order', esc(titleCase(t.ord)))}
                </table>
                <p class="sp-note">From the IUCN Red List taxonomy and assessment table, 2025.
                <a href="https://www.iucnredlist.org/search?query=${encodeURIComponent(t.name)}" target="_blank" rel="noopener">Open the assessment on the Red List.</a></p>`;
        }

        function renderProtection() {
            const el = $('sp-protection');
            const s = state.stats;
            if (!s) { el.innerHTML = '<div class="sp-loading">Measuring protected habitat in the range…</div>'; return; }
            if (s.error) { el.innerHTML = `<p class="sp-muted">The protection measures failed: ${esc(s.error.slice(0, 160))}</p>`; return; }
            const withOecm = tokens().OECM === '1';
            const tot = Number(s.cells) || 0;
            const strict = tot ? s.strict / tot : null, other = tot ? s.other / tot : null, oecm = tot && withOecm ? s.oecm / tot : 0;
            const prot = strict + other + oecm;
            const target = protectionTarget(Number(s.range_km2));
            const score = target ? Math.min(1, prot / target) * 100 : null;
            const seg = (x, color, label) => (x > 0 ? `<span style="width:${(100 * x).toFixed(2)}%;background:${color}" title="${label} ${pct(x, 1)}"></span>` : '');
            el.innerHTML = `
                <div class="sp-tiles">
                    <div class="sp-tile"><div class="sp-tile-label">Range area</div><div class="sp-tile-value">${num(Number(s.range_km2))} km²</div></div>
                    <div class="sp-tile"><div class="sp-tile-label">Protected</div><div class="sp-tile-value">${pct(prot)}</div></div>
                    <div class="sp-tile"><div class="sp-tile-label">Strictly protected</div><div class="sp-tile-value">${pct(strict)}</div></div>
                    <div class="sp-tile"><div class="sp-tile-label">Protection score</div><div class="sp-tile-value">${score == null ? '—' : Math.round(score)}<small> / 100</small></div></div>
                </div>
                <div class="sp-bar" aria-label="Share of the range by protection">${seg(strict, COLORS.strict, 'Strict')}${seg(other, COLORS.other, 'Other protected areas')}${seg(oecm, COLORS.oecm, 'OECMs')}</div>
                <div class="sp-legend">
                    <span><i style="background:${COLORS.strict}"></i>Strict protected areas</span>
                    <span><i style="background:${COLORS.other}"></i>Other protected areas</span>
                    ${withOecm ? `<span><i style="background:${COLORS.oecm}"></i>OECMs</span>` : ''}
                    <span><i style="background:${COLORS.none}"></i>Unprotected</span>
                </div>
                <p class="sp-note">Shares are of the ${tokens().PRESENCE === '1' ? 'extant' : 'extant and possibly extant'} native IUCN range, counted on H3 cells of about 0.7 km².
                Strict protected areas are IUCN management categories Ia, Ib and II.
                The score compares protection with a target that falls from 100% of ranges under 10,000 km² to 15% of ranges over 2.5 million km² (Jetz et al. 2022).
                ${target ? `For this range the target is ${pct(target)}.` : ''}
                Map of Life computes its score on habitat-refined ranges, so its values differ from these.</p>`;
        }

        function renderHabitat() {
            const el = $('sp-habitat');
            const h = state.habitat;
            if (!h) { el.innerHTML = '<div class="sp-loading">Measuring tree cover and its loss in the range…</div>'; return; }
            if (h.error) { el.innerHTML = `<p class="sp-muted">The habitat measures failed: ${esc(h.error.slice(0, 160))}</p>`; return; }
            const land = Number(h.land_km2) || 0, tree = Number(h.tree_km2) || 0, treePa = Number(h.tree_pa_km2) || 0;
            const landPa = Number(h.land_pa_km2) || 0;
            if (!land) { el.innerHTML = '<p class="sp-muted">The tree cover data cover land between 80° N and 60° S, and none of this range is in it.</p>'; return; }
            const years = h.loss || [];
            const lossP = years.reduce((a, r) => a + r.p, 0), lossU = years.reduce((a, r) => a + r.u, 0);
            const ratio = (a, b) => (b > 0 ? a / b : null);
            el.innerHTML = `
                <div class="sp-tiles">
                    <div class="sp-tile"><div class="sp-tile-label">Tree cover in 2000</div><div class="sp-tile-value">${pct(ratio(tree, land))}<small> of the range</small></div></div>
                    <div class="sp-tile"><div class="sp-tile-label">Tree cover lost 2001–2025</div><div class="sp-tile-value">${pct(ratio(lossP + lossU, land), 1)}<small> of the range</small></div></div>
                    <div class="sp-tile"><div class="sp-tile-label">Loss inside protected areas</div><div class="sp-tile-value">${pct(ratio(lossP, landPa), 1)}<small> of their area</small></div></div>
                    <div class="sp-tile"><div class="sp-tile-label">Loss outside protected areas</div><div class="sp-tile-value">${pct(ratio(lossU, land - landPa), 1)}<small> of the rest</small></div></div>
                </div>
                ${lossChart(years)}
                ${tree < 0.1 * land ? '<p class="sp-note"><b>Less than a tenth of this range had tree cover in 2000, so tree cover loss says little about this species’ habitat.</b></p>' : ''}
                <p class="sp-note">Tree cover in 2000 is canopy area, ${num(tree)} km² in the range and ${num(treePa)} km² of it in protected areas.
                Loss is the area of 30 m pixels whose tree canopy was removed, from any cause including logging, fire and plantation harvest, ${num(lossP + lossU)} km² in all; regrowth is not counted.
                Loss counts whole pixels while canopy area is weighted by cover, so the two are not divided; shares are of the land area of the range, of its protected part and of the rest.
                The producers improved their method from 2011 on, so compare years on the same side of 2011.
                From Hansen Global Forest Change v1.13, summarised on H3 cells of about 0.7 km² over the ${tokens().PRESENCE === '1' ? 'extant' : 'extant and possibly extant'} native IUCN range; protected areas are WDPA sites as on the Protection tab.</p>`;
        }

        /** Annual tree cover loss as stacked bars, inside and outside protected areas. */
        function lossChart(years) {
            if (!years.length) return '<p class="sp-muted">No tree cover loss was recorded in the range.</p>';
            const W = 320, H = 130, L = 36, B = 18, T = 8, R = 4;
            const max = Math.max(...years.map(r => r.p + r.u)) || 1;
            const bw = (W - L - R) / 25;
            const x = yr => L + (yr - 2001) * bw;
            const y = v => T + (H - T - B) * (1 - v / max);
            const fmtKm = v => (v >= 100 ? num(v) : v >= 1 ? v.toFixed(1) : v.toFixed(2));
            const bars = years.map(r => {
                const x0 = x(r.year) + 1, w = Math.max(1, bw - 2);
                const tip = `<title>${r.year}: ${fmtKm(r.p + r.u)} km² lost, ${fmtKm(r.p)} km² in protected areas</title>`;
                return `<g>${tip}<rect x="${x0}" y="${y(r.u + r.p)}" width="${w}" height="${y(r.p) - y(r.u + r.p)}" fill="${COLORS.loss}"/>`
                    + `<rect x="${x0}" y="${y(r.p)}" width="${w}" height="${y(0) - y(r.p)}" fill="${COLORS.other}"/></g>`;
            }).join('');
            const m = x(2011);
            return `
                <figure class="sp-chart">
                    <figcaption>Tree cover loss each year in km²</figcaption>
                    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Tree cover loss each year from 2001 to 2025">
                        <line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" class="sp-axis"/>
                        <line x1="${L}" x2="${W - R}" y1="${y(max)}" y2="${y(max)}" class="sp-grid"/>
                        <text x="${L - 4}" y="${y(max) + 4}" text-anchor="end">${fmtKm(max)}</text>
                        <text x="${L - 4}" y="${y(0) + 4}" text-anchor="end">0</text>
                        ${bars}
                        <line x1="${m}" x2="${m}" y1="${T}" y2="${y(0)}" class="sp-break"><title>Method change in 2011</title></line>
                        ${[2001, 2011, 2021].map(yr => `<text x="${x(yr) + bw / 2}" y="${H - 4}" text-anchor="middle">${yr}</text>`).join('')}
                    </svg>
                </figure>
                <div class="sp-legend">
                    <span><i style="background:${COLORS.other}"></i>Inside protected areas</span>
                    <span><i style="background:${COLORS.loss}"></i>Outside protected areas</span>
                    <span><i class="sp-break-key"></i>Method change</span>
                </div>`;
        }

        function renderData() {
            const o = state.occ;
            const rangeOn = mm.layers.get(layerId(RANGE_LAYER))?.visible !== false;
            const occOn = mm.layers.get(layerId(OCC_LAYER))?.visible !== false;
            const paOn = mm.layers.get(layerId(PA_LAYER))?.visible !== false;
            const since = tokens().SINCE;
            $('sp-data').innerHTML = `
                <ul class="sp-layers">
                    <li><label><input type="checkbox" data-layer="${RANGE_LAYER}" ${rangeOn ? 'checked' : ''}>
                        <i class="sp-swatch" style="background:${COLORS.range};border-color:${COLORS.rangeLine}"></i>IUCN expert range map</label></li>
                    <li><label><input type="checkbox" data-layer="${PA_LAYER}" ${paOn ? 'checked' : ''}>
                        <i class="sp-swatch" style="background:linear-gradient(90deg, ${COLORS.strict} 50%, ${COLORS.other} 50%)"></i>Protected areas in the range</label></li>
                    <li><label><input type="checkbox" data-layer="${OCC_LAYER}" ${occOn ? 'checked' : ''}>
                        <i class="sp-swatch" style="background:${COLORS.occ}"></i>GBIF occurrence records</label>
                        <span class="sp-count">${o ? num(o.total) : '…'}</span></li>
                </ul>
                <p class="sp-note">Occurrence records are GBIF's September 2026 snapshot${since && since !== '0' ? ` from ${esc(since)} on` : ''}, without fossils, living specimens or records with coordinate issues, counted in H3 cells.
                They are matched to the IUCN name, so records filed under a synonym are missing.
                Protected areas are the WDPA June 2026 edition, drawn only where they overlap the range, as H3 cells coloured by their main kind of protection and shaded by how much of the cell is protected.
                The full protected area and OECM maps are in the layer list.</p>`;
            $('sp-data').querySelectorAll('input[data-layer]').forEach(cb => cb.addEventListener('change', () => {
                const lid = layerId(cb.dataset.layer);
                if (!mm.layers.has(lid)) return;
                if (cb.checked) mm.showLayer(lid); else mm.hideLayer(lid);
                mm.syncCheckbox?.(lid);
            }));
        }

        /* ── Updates ─────────────────────────────────────────────────── */

        async function refreshInfo(id) {
            const s = ++seq.info;
            let t = null;
            try { t = await lookup(id); } catch (err) { console.error('[species] lookup failed:', err); }
            if (s !== seq.info || !t) return;
            state.taxon = t;
            state.wiki = undefined;
            state.photo = null;
            renderHead();
            const [wiki, photo] = await Promise.all([wikipedia(t.name), inatPhoto(t.name)]);
            if (s !== seq.info) return;
            state.wiki = wiki;
            state.photo = photo;
            renderHead();
        }

        async function refreshRange(id, { fit = true } = {}) {
            const s = ++seq.range;
            try {
                const cells = await rangeCells(id, tokens().PRESENCE);
                if (s !== seq.range) return;
                const fc = cellsToFeature(cells);
                setLayer(RANGE_LAYER, fc, {
                    displayName: 'IUCN range', fillColor: COLORS.range, outlineColor: COLORS.rangeLine, opacity: 0.45,
                    tooltipFields: ['layer'],
                    after: lid => { if (ml.getLayer(`${lid}-outline`)) ml.setPaintProperty(`${lid}-outline`, 'line-width', 1); },
                });
                if (fit) fitTo(fc);
            } catch (err) {
                console.error('[species] range failed:', err);
            }
        }

        async function refreshOcc(name) {
            const s = ++seq.occ;
            state.occ = null;
            renderData();
            try {
                const o = await occurrences(name, tokens().SINCE || 0);
                if (s !== seq.occ) return;
                state.occ = o;
                setLayer(OCC_LAYER, occFeatures(o.cells), {
                    displayName: 'GBIF records', fillColor: COLORS.occ, outlineColor: COLORS.occ, opacity: 0.6,
                    tooltipFields: ['records'],
                    after: lid => {
                        ml.setPaintProperty(lid, 'fill-opacity', ['interpolate', ['linear'], ['ln', ['+', 1, ['get', 'records']]], 0, 0.3, 6, 0.75]);
                        if (ml.getLayer(`${lid}-outline`)) ml.setPaintProperty(`${lid}-outline`, 'line-width', 0.4);
                    },
                });
            } catch (err) {
                console.error('[species] occurrences failed:', err);
                state.occ = { cells: [], total: null, error: err.message };
            }
            renderData();
        }

        async function refreshStats(id) {
            const s = ++seq.stats;
            state.stats = null;
            renderProtection();
            ml.getSource(layerId(PA_LAYER))?.setData({ type: 'FeatureCollection', features: [] });
            try {
                const st = await protection(id, tokens().PRESENCE);
                if (s !== seq.stats) return;
                state.stats = st || { error: 'no range cells' };
            } catch (err) {
                if (s !== seq.stats) return;
                state.stats = { error: err.message };
            }
            renderProtection();
            drawProtected();
            renderData();
        }

        /** Compute the habitat measures for the current species and range once, when first asked for. */
        function loadHabitat() {
            const id = bus.values[controlId], presence = tokens().PRESENCE;
            const key = `${id}|${presence}`;
            if (key === habitatKey && habitatJob) return habitatJob;
            habitatKey = key;
            const s = ++seq.habitat;
            state.habitat = null;
            renderHabitat();
            habitatJob = habitat(id, presence)
                .then(h => { if (s === seq.habitat) state.habitat = h || { error: 'no range cells' }; })
                .catch(err => { if (s === seq.habitat) state.habitat = { error: err.message }; })
                .finally(() => { if (s === seq.habitat) renderHabitat(); });
            return habitatJob;
        }

        function resetHabitat() {
            habitatKey = null; habitatJob = null; state.habitat = null; seq.habitat++;
            if (habitatOpen()) loadHabitat(); else renderHabitat();
        }

        function refreshAll(id, name) {
            refreshInfo(id);
            refreshRange(id);
            refreshOcc(name);
            refreshStats(id);
            resetHabitat();
            try { history.replaceState(null, '', `#species=${id}`); } catch { /* sandboxed */ }
        }

        /** Add the species to the control's options (newest first, at most 20) and choose it. */
        function chooseOption(t, { silent = false } = {}) {
            const p = bus.get(controlId);
            const name = SAFE_NAME.test(t.name) ? t.name : '';
            const opt = { value: String(t.id), label: t.common ? `${t.name} (${t.common})` : t.name, tokens: { SPECIES_NAME: name } };
            const options = [opt, ...p.options.filter(o => String(o.value ?? o) !== opt.value)].slice(0, 20);
            bus.define({ ...p, options, value: opt.value }, { silent });
            ctx.controls?.render?.();
        }

        async function selectById(id) {
            const t = await lookup(id);
            if (!t) throw new Error(`No IUCN range map has id_no ${id}.`);
            chooseOption(t);   // the bus subscriber refreshes the card
            return t;
        }

        bus.subscribe(changed => {
            const id = bus.values[controlId];
            const name = tokens().SPECIES_NAME;
            if (changed.has('SPECIES')) { refreshAll(id, name); return; }
            if (changed.has('PRESENCE')) { refreshRange(id, { fit: false }); refreshStats(id); resetHabitat(); }
            if (changed.has('OECM')) { renderProtection(); drawProtected(); }
            if (changed.has('SINCE')) refreshOcc(name);
        });

        /* ── Agent tools ─────────────────────────────────────────────── */

        ctx.tools.registerLocal({
            name: 'select_species',
            description: 'Show a species in the species card and on the map: its IUCN range, GBIF records and the protection measures of its range. This sets the species control, so {{SPECIES}} (IUCN id_no) and {{SPECIES_NAME}} (binomial) change and the charts re-run. Takes a scientific or English common name, or an IUCN id_no. When several species match and none exactly, it returns them without changing the species; call again with the exact scientific name or id.',
            inputSchema: {
                type: 'object',
                properties: { name: { type: 'string', description: 'Scientific name, English common name, or IUCN id_no' } },
                required: ['name'],
            },
            execute: async ({ name } = {}) => {
                const q = String(name ?? '').trim();
                try {
                    if (/^\d+$/.test(q)) {
                        const t = await selectById(q);
                        return JSON.stringify({ success: true, species: { id_no: t.id, name: t.name, common: t.common, category: t.cat } });
                    }
                    const rows = await search(q);
                    const lower = q.toLowerCase();
                    const exact = rows.find(r => r.name.toLowerCase() === lower || (r.common || '').toLowerCase() === lower);
                    const hit = exact || (rows.length === 1 ? rows[0] : null);
                    if (!hit) {
                        return JSON.stringify({ success: false, error: rows.length ? 'Several species match; call again with one of these.' : 'No species with an IUCN range map matches.', candidates: rows.map(r => ({ id_no: r.id, name: r.name, common: r.common, category: r.cat })) });
                    }
                    const t = await selectById(hit.id);
                    return JSON.stringify({ success: true, species: { id_no: t.id, name: t.name, common: t.common, category: t.cat }, note: 'The card, map and charts are updating. Call get_species_card for the protection measures once they finish.' });
                } catch (err) {
                    return JSON.stringify({ success: false, error: err.message });
                }
            },
        });

        ctx.tools.registerLocal({
            name: 'get_species_card',
            description: 'Read what the species card shows for the current species: names, Red List assessment, Wikipedia summary, GBIF record count, and the protection measures of its IUCN range (range area, shares in strict and other protected areas and OECMs, protection target and score). With include_habitat, it also returns the Habitat trends tab: tree cover in the range in 2000 and its loss each year from 2001 to 2025, inside and outside protected areas (this can take 20 seconds). Measures still being computed are returned as null.',
            inputSchema: {
                type: 'object',
                properties: { include_habitat: { type: 'boolean', description: 'Also compute and return the tree cover and loss measures.' } },
                required: [],
            },
            execute: async ({ include_habitat = false } = {}) => {
                if (include_habitat) await loadHabitat().catch(() => {});
                const h = state.habitat;
                const t = state.taxon, s = state.stats;
                const tot = Number(s?.cells) || 0;
                const withOecm = tokens().OECM === '1';
                const share = k => (tot && s && !s.error ? s[k] / tot : null);
                const prot = share('strict') == null ? null : share('strict') + share('other') + (withOecm ? share('oecm') : 0);
                const target = s && !s.error ? protectionTarget(Number(s.range_km2)) : null;
                return JSON.stringify({
                    species: t && { id_no: t.id, name: t.name, common: t.common, class: t.class, order: t.ord, family: t.family, category: t.cat, criteria: t.criteria, assessed: t.assessed || t.published, population_trend: t.trend, eoo_km2: t.eoo_km2, countries: t.countries },
                    wikipedia: state.wiki ? { summary: state.wiki.text, url: state.wiki.url } : null,
                    gbif_records: state.occ?.total ?? null,
                    gbif_records_since: tokens().SINCE === '0' ? 'all years' : tokens().SINCE,
                    range: tokens().PRESENCE === '1' ? 'extant, native and reintroduced' : 'extant and possibly extant, native and reintroduced',
                    protection: s && !s.error ? {
                        range_km2: Math.round(Number(s.range_km2)),
                        share_strict: share('strict'), share_other_protected: share('other'), share_oecm_only: share('oecm'),
                        oecms_counted: withOecm, share_protected: prot,
                        target_share: target, protection_score: target && prot != null ? Math.round(Math.min(1, prot / target) * 100) : null,
                        method: 'H3 resolution 8 cells of the range inside WDPA (not proposed, not UNESCO-MAB); strict = IUCN categories Ia, Ib, II; target from Jetz et al. 2022 (100% below 10,000 km2, 15% above 2.5 million km2, log-linear between).',
                    } : (s?.error ? { error: s.error } : null),
                    habitat: !include_habitat ? undefined : h && !h.error ? {
                        land_km2: Math.round(Number(h.land_km2)), land_in_protected_km2: Math.round(Number(h.land_pa_km2)),
                        tree_cover_2000_km2: Math.round(Number(h.tree_km2)),
                        tree_cover_2000_in_protected_km2: Math.round(Number(h.tree_pa_km2)),
                        loss_km2_by_year: (h.loss || []).map(r => ({ year: r.year, inside_protected: +r.p.toFixed(2), outside_protected: +r.u.toFixed(2) })),
                        method: 'Hansen Global Forest Change v1.13 on H3 resolution 8 cells of the range. Tree cover is canopy area in 2000 (cover-weighted); loss is the whole area of 30 m pixels that lost canopy, any cause, no regrowth, so do not divide loss by tree cover; compare loss with land area instead. Method improved from 2011, so compare years on the same side of 2011.',
                    } : (h?.error ? { error: h.error } : null),
                });
            },
        });

        ctx.addPrompt(`## Species card

The side panel shows one species at a time: the species control (\`${controlId}\`) holds its IUCN \`id_no\` as {{SPECIES}} and its binomial as {{SPECIES_NAME}}. Change species with \`select_species\`, never with \`create_control\`. Read the card's numbers with \`get_species_card\` rather than recomputing them. The map layers \`upload-${RANGE_LAYER}\` (IUCN range), \`upload-${PA_LAYER}\` (protected areas within the range, as H3 cells) and \`upload-${OCC_LAYER}\` (GBIF records) follow the species. The card's Habitat trends tab gives tree cover loss in the range; read it with \`get_species_card\` and \`include_habitat: true\`.`);

        /* ── First species ───────────────────────────────────────────── */

        const fromHash = (location.hash.match(/species=(\d+)/) || [])[1];
        let first = bus.values[controlId];
        if (fromHash && fromHash !== String(first)) {
            try {
                const t = await lookup(fromHash);
                if (t) { chooseOption(t, { silent: true }); first = t.id; }
            } catch (err) { console.warn('[species] species from the link not found:', err.message); }
        }
        refreshAll(first, tokens().SPECIES_NAME);
    },
};

export default plugin;
