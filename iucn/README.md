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

A species' range joins every IUCN `id_no` that shares its scientific name in the range
index; whether that is right for split taxa is open (issue #75).

The map draws protected areas only where they overlap the range, as the H3 cells the
shares are counted on. Cells are grouped to the finest resolution that keeps the range
under 25,000 cells, coloured by their main kind of protection and shaded by how much of
the cell is protected. The full WDPA and OECM maps are in the layer list.

The Habitat trends tab uses Hansen Global Forest Change v1.13 (H3 resolution 8). Tree
cover in 2000 is canopy area weighted by cover. Loss is the whole area of 30 m pixels
that lost canopy in each year from 2001 to 2025, from any cause, without regrowth.
Because one is cover-weighted and the other counts whole pixels, loss is reported as a
share of land area (of the range, its protected part and the rest), not of tree cover.
The producers improved their method from 2011 on, which the chart marks.
