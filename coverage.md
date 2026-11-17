# Reproducibility coverage

This app's layers are a partial reproduction kit for Fajardo et al. 2026, *Social implications of the 30×30 global conservation target* (Nature Communications, [doi:10.1038/s41467-026-71860-8](https://doi.org/10.1038/s41467-026-71860-8)). The table below tracks what we can and cannot reproduce against the paper's reported figures.

Datasets we currently lack are tracked in [boettiger-lab/data-workflows#161](https://github.com/boettiger-lab/data-workflows/issues/161) — see also #140 (Theobald gHM), #157 (KBA + IUCN AOH ranges).

## Reproducibility status by figure / table

| Paper artefact | What it shows | Reproducible? | Blocker |
|---|---|:---:|---|
| **Headline: 396 M in existing PAs, 1.15 B within 10 km** | Resident + buffer population for current PA/OECM network | 🟡 Resident, by a different method | The paper's 396 M is far above an exact count (235.4 M) because it counts whole coarse cells; see [Why the paper's coverage figures are higher](#why-the-papers-coverage-figures-are-higher). The 10 km buffer figure still needs a spatial buffer step. |
| **Fig 1 — scenario maps** | Three Target-3 scenarios overlaid with current PAs | ❌ | Scenario rasters not hosted; the `prioritizr` runs that produced them require species AOH, KBA, NCP, HMI we don't have |
| **Fig 2a — resident + neighbouring population by scenario** | Population in new PAs vs buffer | ❌ | Same scenario rasters |
| **Fig 2b — HDI breakdown by scenario** | % of scenario population in Low / Medium / High / Very High HDI | ❌ | MOSAIKS gridded HDI not in catalog |
| **Fig 2c — livelihood overlap (wild harvest / farm / livestock)** | % of scenario area / population overlapping each livelihood class | ❌ | Wells (wild harvesting), Lesiv/Mehrabi (farm size), GLPS v5 (livestock) all missing |
| **Fig 3 — continental HDI × population** | Per-continent comparison of scenario populations and HDI | ❌ | Both blockers above |
| **Suppl Table 1 — population in each scenario** | Per-scenario population totals + % of global | 🟡 Partial | Row for "Existing PAs" only; scenario rows need the rasters |
| **Suppl Table 2 — population in scenarios by continent** | Continent-level totals | 🟡 Partial | Existing-PA row only |
| **Suppl Table 3 — population × HDI** | All scenarios × HDI groups | ❌ | MOSAIKS HDI |
| **Suppl Table 4 — livelihood overlap** | Wild harvesting / farm area / livestock × scenario | ❌ | Livelihood layers |
| **Suppl Fig 1 — % global area in scenarios + buffers** | Area accounting | 🟡 Partial | Existing-PA portion only |
| **Suppl Fig 2 / 3 — spatial overlap between scenarios** | Venn / overlap maps | ❌ | Scenario rasters |
| **Suppl Fig 5 — ITT scenario distribution** | 100-replicate ITT map | 🟡 Partial | Have LandMark IPLC as a proxy, not the ICCA Registry + HMI-masked composite the paper uses |

## What we can reproduce today

These analyses are doable with the layers currently configured in `layers-input.json`:

- **Global conserved-area coverage**: `% of land area inside a designated PA or OECM` from `wdpa` and `wdoecm-may-2026`, with `cgls-lc100-2019` as the land mask (exclude `lc_class` 0/80/200 = no-data/water/sea so ocean PAs don't inflate the denominator). Measured on each feature's finest cells this is 16.60%, not the paper's 17.2%; see below.
- **Population inside conserved areas**: `ghs-pop-2020` × (`wdpa` ∪ `wdoecm-may-2026`), 248.5 M on finest cells; see below.
- **Country-level coverage**: `ISO3` on WDPA/OECM × Overture countries.
- **Ecoregion representation**: `wwf-ecoregions-2017` × (`wdpa` ∪ `wdoecm-may-2026`). % of each ecoregion inside the conserved-area network (388 of 846 ecoregions reach 17% on finest cells; 418 on h8) — speaks to the biodiversity-representation argument of the paper without reproducing the `prioritizr` optimization.
- **Biodiversity value of PAs vs unprotected**: `iucn-ranges-2025` × `wdpa`. Per-species range hex enables on-demand richness (`COUNT(DISTINCT id_no)`) for any taxon and a true per-species coverage check (what fraction of each species' range is inside the network) — closer to the paper's analysis than the old aggregated richness rasters.
- **Carbon stocks inside / outside PAs**: `irrecoverable-carbon` × `wdpa`. Closest analogue to one of the paper's 10 NCP layers (vulnerable ecosystem carbon).
- **IPLC × PA overlap**: `landmark-iplc-poly` × `wdpa`. Proxy for the ITT lens.

## Why the paper's coverage figures are higher

The paper's headline coverage and population figures come out only of a coarse-cell
count. Our June 2026 notes reproduced them the same way, by unioning WDPA and WD-OECM on
`h8` cells: 17.54% of land and 385.5 M people, close to the paper's 17.2% and 396 M. That
match was the error, not a validation. An `h8` cell is about 0.74 km², and a protected
area smaller than that, or one that only clips a cell's edge, credits the whole cell, so
the count runs high. The paper counts 25 km² Mollweide cells as protected when at least
50% covered, which runs high for the same reason. It also uses WDPA August 2024 with
Protected Planet's filters and supplementary data for China and India, so even a correct
method on our data would not land on its numbers.

The catalog records for `wdpa` and `wdoecm-may-2026` say how to measure coverage: use
each feature's finest cells, `h9` where the feature has it and `h8` only for the 1,297
features of 5,000 km² or more, whose `h9` is NULL. WD-OECM has `h8` only, and its hex
holds 2,594 of the layer's 7,378 features; the rest, smaller than an `h8` cell, are
missing from it (data-workflows#879).

| Figure | Paper | `h8` cells | Finest cells | Exact polygons |
|---|---|---|---|---|
| Land in PAs + OECMs, excluding Antarctica | 17.2% | 17.45% | **16.60%** (21.76 M of 131.09 M km²) | 16.58% |
| People in PAs + OECMs (GHS-POP 2020) | 396 M | 385.5 M | **248.5 M** | 235.4 M |
| People in WDPA alone | | 357.3 M | **220.1 M** | 207.8 M |
| Ecoregions with ≥ 17% protected | | 418 | **388** | 388 |

Measured 2026-11-04 to 11-06 on WDPA June 2026 and WD-OECM May 2026. The exact figures
attribute GHS-POP pixel centres, or CGLS land pixels, to the original polygons. To
reproduce the paper's numbers, use the `h8` column: `SELECT DISTINCT h8` from both hex
assets, union them, and count land or population cells under them. The finest-cell
people count:

```sql
WITH w AS (SELECT h0, h8, h9 FROM read_parquet('s3://public-wdpa/wdpa/hex/h0=*/data_0.parquet')),
     w9  AS (SELECT DISTINCT h0, h9 FROM w WHERE h9 IS NOT NULL),
     w8n AS (SELECT DISTINCT h0, h8 FROM w WHERE h9 IS NULL),
     o8  AS (SELECT DISTINCT h0, h8 FROM read_parquet('s3://public-wdpa/wdoecm-may-2026/hex/h0=*/data_0.parquet')),
     p   AS (SELECT h0, h8, h9, population FROM read_parquet('s3://public-population/ghs-pop-2020/hex/h0=*/data_0.parquet') WHERE population > 0),
     hit AS (SELECT h9 FROM p SEMI JOIN w9 USING (h0, h9)
             UNION SELECT h9 FROM p SEMI JOIN w8n USING (h0, h8)
             UNION SELECT h9 FROM p SEMI JOIN o8 USING (h0, h8))
SELECT CAST(ROUND(SUM(population)) AS BIGINT) FROM p SEMI JOIN hit USING (h9);   -- 248,516,575
```

Land coverage uses the same membership over CGLS `h9` land cells (not class 0, 80 or
200, latitude above −60°), summing `h3_cell_area`. The global join is too large for one
query, so it was run one `h0` partition at a time.

These notes are for people. The app's system prompt deliberately does not mention the
paper's figures, so the model is not steered toward a method that matches them.

## Things we should *not* fabricate

If a user asks for HDI breakdowns, wild-harvesting estimates, farm-size or livestock-area overlaps, or scenario-specific results: say plainly we don't host those layers and point at the source datasets in [data-workflows#161](https://github.com/boettiger-lab/data-workflows/issues/161). Do not substitute unrelated layers (e.g. don't approximate HDI with SVI — SVI is US-only and a different construct).
