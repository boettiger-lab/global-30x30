# global-30x30 — geo-agent app

A geo-agent configuration for exploring the spatial and social context of the **Kunming-Montreal Global Biodiversity Framework Target 3** ("30×30") — the commitment that at least 30% of terrestrial, inland water, marine and coastal areas be effectively conserved by 2030.

Inspired by the analysis in Fajardo et al. 2026, *Social implications of the 30×30 global conservation target* (Nature Communications, [doi:10.1038/s41467-026-71860-8](https://doi.org/10.1038/s41467-026-71860-8)). See [`coverage.md`](coverage.md) for which of that paper's analyses can and cannot be reproduced from the current STAC catalog.

## Layers

- **WDPA December 2025** — current global protected areas
- **LandMark IPLC v202509** — Indigenous and community-mapped lands
- **WWF Terrestrial Ecoregions (2017)** — biodiversity representation framing
- **IUCN Species Richness (2025)** — vertebrate richness rasters
- **NCP — Biodiversity & Natural Habitat** (Chaplin-Kramer 2019) and **Irrecoverable / Vulnerable Carbon** (Noon 2022)
- **GHS-POP 2020** — gridded global population
- **Overture countries / regions** — admin context

## Repository structure

```
index.html          ← HTML shell — loads core JS/CSS from CDN
layers-input.json   ← STAC collections + LLM settings + welcome examples
system-prompt.md    ← LLM system prompt (30×30 framing + caveats)
k8s/                ← Kubernetes deployment manifests (optional)
```

This is a fork of [`boettiger-lab/geo-agent-template`](https://github.com/boettiger-lab/geo-agent-template); the JavaScript runtime is loaded from CDN. See the [geo-agent docs](https://boettiger-lab.github.io/geo-agent/) for the full configuration reference.

## Local preview

```bash
python -m http.server 8000
# Open http://localhost:8000 — enter an API key in the settings panel
```
