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
| `species.js` | Species search, card, range and record layers, agent tools |
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
