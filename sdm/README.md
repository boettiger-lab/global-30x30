# SDM builder

A menu-driven page for fitting species distribution models, with no LLM. It is served at `/sdm/` next to the 30×30 chat app.

The page calls MCP tools directly from the browser, one stateless JSON-RPC POST per call, using the client from [glen-charts](https://github.com/SchmidtDSE/glen-charts) (`core/mcp.js`):

| Server | Tools | Used for |
|---|---|---|
| `sdm-mcp` ([glen-sdm](https://boettiger-lab.github.io/glen-sdm/)) | `list_sdm_algorithms`, `list_covariate_layers` | the method and predictor menus and the future scenarios |
| | `fit_sdm`, `get_sdm_result` | fitting, and waiting for long fits |
| `duckdb-mcp` | `query` | checking species names against the GBIF 2026-09 snapshot index; the share of the modelled range in protected areas and OECMs |

Common names are resolved with the public [GBIF species API](https://techdocs.gbif.org/en/openapi/v1/species). Only names present in the snapshot index are offered, so any name shown can be fitted.

The fit request is kept in the URL (`#spec=…`). Opening a link restores the settings and refits; the server caches identical requests, so the stored result returns at once.

## Files

| File | Contents |
|---|---|
| `index.html` | page shell (glen-charts sidebar layout) |
| `datasets.html` | the datasets each model reads, with citations and licenses |
| `app.js` | controls, MCP calls, map layers, results |
| `sdm.css` | styles added to the glen-charts stylesheet |
| `config.json` | server URLs, initial view, protected-area layers |

The protected-area share credits each model cell by the fraction of its H3 resolution-8 children that fall in a WDPA or WD-OECM area, so it is exact at resolution 8 and approximate at coarser resolutions.
