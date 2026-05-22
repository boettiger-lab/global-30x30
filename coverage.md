# Reproducibility coverage

This app's layers are a partial reproduction kit for Fajardo et al. 2026, *Social implications of the 30×30 global conservation target* (Nature Communications, [doi:10.1038/s41467-026-71860-8](https://doi.org/10.1038/s41467-026-71860-8)). The table below tracks what we can and cannot reproduce against the paper's reported figures.

Datasets we currently lack are tracked in [boettiger-lab/data-workflows#161](https://github.com/boettiger-lab/data-workflows/issues/161) — see also #140 (Theobald gHM), #157 (KBA + IUCN AOH ranges).

## Reproducibility status by figure / table

| Paper artefact | What it shows | Reproducible? | Blocker |
|---|---|:---:|---|
| **Headline: 396 M in existing PAs, 1.15 B within 10 km** | Resident + buffer population for current PA/OECM network | 🟡 Partial | Have WDPA + GHS-POP, missing WD-OECM. Numbers will differ by year (we have 2020 not 2023). |
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

- **Global PA coverage**: `% of land area inside a designated PA` — `wdpa-december-2025`. Will land short of the paper's 17.2% figure because WD-OECM is missing.
- **Population inside / near PAs**: `ghs-pop-2020` × `wdpa-december-2025`. Comparable to the paper's first row.
- **Country-level PA coverage**: WDPA `ISO3` × Overture countries.
- **Ecoregion representation**: `wwf-ecoregions-2017` × `wdpa-december-2025`. % of each ecoregion inside the PA network — speaks to the biodiversity-representation argument of the paper without reproducing the `prioritizr` optimization.
- **Biodiversity value of PAs vs unprotected**: `iucn-richness-2025` (combined or per-taxon) × WDPA. Aggregated richness only — not the per-species coverage check the paper performs.
- **Carbon stocks inside / outside PAs**: `irrecoverable-carbon` × WDPA. Closest analogue to one of the paper's 10 NCP layers (vulnerable ecosystem carbon).
- **IPLC × PA overlap**: `landmark-iplc-poly` × `wdpa-december-2025`. Proxy for the ITT lens.

## Things we should *not* fabricate

If a user asks for HDI breakdowns, wild-harvesting estimates, farm-size or livestock-area overlaps, or scenario-specific results: say plainly we don't host those layers and point at the source datasets in [data-workflows#161](https://github.com/boettiger-lab/data-workflows/issues/161). Do not substitute unrelated layers (e.g. don't approximate HDI with SVI — SVI is US-only and a different construct).
