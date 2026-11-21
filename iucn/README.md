# IUCN species explorer

A second glen app in this repository, served at `/iucn/`. A reader picks any of the
roughly 98,000 species in the IUCN 2025 range maps and sees its range, its GBIF
records, its Red List assessment, a Wikipedia summary and photo, and how much of its
range lies in protected areas. The settings and charts in the side panel follow the
species, and the chat can change species and answer questions about it.

It runs glen core v4.1.0 with the controls and charts plugins and one plugin of its
own, `species.js`, which adds the species search and card and draws the range and
record layers. `species.js` keeps the `species` control in step with the choice, so
every chart whose SQL uses `{{SPECIES}}` or `{{SPECIES_NAME}}` re-runs when the
species changes. A link carries the species as `#species=<IUCN id_no>`.

| File | Purpose |
|---|---|
| `index.html` | Page shell; loads glen from the CDN |
| `layers-input.json` | Layers, controls, charts and plugins |
| `species.js` | Species search, card, range, protected area and record layers, agent tools |
| `species.css` | Card styles |
| `system-prompt.md` | Chat guidance for this app |

The deployment copies this folder to `/usr/share/nginx/html/iucn/` and writes the same
`config.json` there as at the root (see `k8s/deployment.yaml`).

## Methods

Range shares count H3 resolution 8 cells of the native, extant (optionally possibly
extant) IUCN range inside WDPA sites that are not proposed and are not UNESCO-MAB
biosphere reserves. Strict protection is IUCN categories Ia, Ib and II. The protection
score compares the protected share with a target that falls log-linearly from 100% of
ranges under 10,000 km² to 15% of ranges over 2.5 million km², the Species Protection
Score rule of Jetz et al. (2022). Map of Life applies that rule to habitat-refined
ranges, so its scores differ from these.

A species' range is the range of its current Red List `id_no` only. The range data also
holds an older, superseded `id_no` for 337 names, mostly ranges from before a species
split; these are left out (issue #75).

The map draws protected areas only where they overlap the range, as the H3 cells the
shares are counted on. Cells are grouped to the finest resolution that keeps the range
under 25,000 cells, coloured by their main kind of protection and shaded by how much of
the cell is protected. The full WDPA and OECM maps are in the layer list.

The Habitat tab gives the area of habitat (Brooks et al. 2019): the H3 resolution 9
cells of the range whose class on the Lumbierres et al. (2021) habitat map matches the
species' IUCN habitat codes through the Lumbierres crosswalk, and whose mean elevation
on the Copernicus GLO-90 surface model lies within the assessment's elevation limits
(no limit where none is recorded). The share of it in protected areas is counted as for
the range, and the habitat protection score applies the same target to the area of
habitat, which is closer to Map of Life's method. The map's classes are broad, so for
generalists the area of habitat is close to the range.

The tab also gives tree cover loss from Hansen Global Forest Change v1.13 (H3 resolution 8). Tree
cover in 2000 is canopy area weighted by cover. Loss is the whole area of 30 m pixels
that lost canopy in each year from 2001 to 2025, from any cause, without regrowth.
Because one is cover-weighted and the other counts whole pixels, loss is reported as a
share of land area (of the range, its protected part and the rest), not of tree cover.
The producers improved their method from 2011 on, which the chart marks.

The Projection tab measures climate exposure after Trisos et al. (2020), with CHELSA 2.1
bioclimate on H3 resolution 8. The species' realized thermal limit is the warmest
1981–2010 mean annual temperature in its range; a range cell is exposed in a period when
its projected mean annual temperature exceeds that limit. The tab gives the exposed
share of the range for 2011–2040, 2041–2070 and 2071–2100 under the scenario chosen in
the Climate scenario setting (SSP1-2.6, SSP3-7.0 or SSP5-8.5), as the median of the five
CMIP6 models with their range, together with median warming and precipitation change,
and maps the exposed cells for a chosen period. Exposure is heat beyond the conditions
the species occupies now, not certain loss: the realized limit understates tolerance
for small ranges, and the measure leaves out habitat, land use and dispersal. The
catalogue has no future land-use layers, so the tab does not project habitat change as
Map of Life does.

The Habitat tab also gives the STAR threat abatement score (Mair et al. 2021): 100 times
the species' Red List weight (NT 1, VU 2, EN 3, CR 4; LC 0), spread over its area of
habitat, and split into the parts in protected areas, strict protected areas and the
rest. STAR also divides the score among threats by scope and severity, but the taxonomy
table keeps only threat codes, so that split is not shown; the restoration score needs
past habitat loss and is not computed. This is calculated from Red List data under its
non-commercial terms and is not the official STAR layer distributed through IBAT.
