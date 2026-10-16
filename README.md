# mmo-chip

A tool for reverse-engineering integrated circuits from die photographs, with a special focus on CMOS Gate Array/Standard Cell chips.
Import and tile gigapixel die shots, annotate them (vias, traces, standard cells) with optional ML assistance, and extract the circuit,
per-cell transistor and logic-gate schematics, and a die-level Verilog netlist.

**Die viewer** — navigate the whole die, with placed cells, nets, and I/O pins.

![Die viewer](docs/die-viewer.png)

**Cell RE** — annotate a cell's layers; transistors, gates, and logic are inferred.

![Cell reverse-engineering](docs/cell-re.png)

Die shots in those screenshots are from [InfoSecDJ](http://infosecdj.net/).

**Clean specimens and the wire map** — with cells recognised, the *Cells* tab can
build a clean specimen per cell type: every instance is cropped, un-flipped,
registered and brightness-matched, and the per-pixel median is kept, so wires
routed over the cell and debris drop out. The image shown in the UI is a
sharper rendering of the same idea: only the best-focused third of the
instances, each registered with a small affine, reconstructed at 2× and
sharpened. Merge cells uses it as the reference, and Cell RE shows it when a
cell type is selected (selecting one instance shows that instance). Running it in reverse gives the wire map:
each placed cell minus its type's specimen, keeping long straight residue, is
pasted back over the die as a translucent overlay of the wires crossing
recognised cells. Both are derived data under `data/dies/<die>/cell-specimens/`
and `data/dies/<die>/wire-map/`.

## Structure

```
frontend/   Vite + React + TypeScript UI (die viewer, cell RE, schematics, Verilog)
backend/    Node + TypeScript API — image import, tiling, JSON persistence, WebSocket
shared/     Shared TypeScript types (the annotation schema)
ml/         Python U-Net for via/trace detection + FastAPI prediction sidecar
data/       Imported dies, tile pyramids, and ML exports
```

## Dependencies

- **Node ≥ 20** (npm workspaces) — required.
- **Python ≥ 3.10** — only for the ML sidecar (assisted via/trace annotation).

```sh
# JS/TS workspaces (frontend + backend + shared)
npm install

# ML sidecar (optional)
python3 -m venv ml/.venv
ml/.venv/bin/pip install -r ml/requirements.txt
```

## Run locally

```sh
npm run dev
```

Starts the backend (http://localhost:3001), the frontend
(http://localhost:5173), and the ML sidecar together. Open the frontend URL.

Without the ML sidecar, run just the two TypeScript apps:

```sh
npm run dev -w backend
npm run dev -w frontend
```

Build and test:

```sh
npm run build
npm test
```

**IMPORTANT NOTE:** This software is still very early in development and has been tested only locally (firewalled). Use at your own risk.

## Local access and processing limits

The frontend and backend bind to `127.0.0.1` by default. Use the frontend at
http://localhost:5173 or http://127.0.0.1:5173. Its proxy supplies an automatically
created local token to the backend; the browser does not need to handle tokens,
including for image tiles and WebSockets. The Python sidecar requires the same
token. Restart all three processes after upgrading to these access protections.

Native API clients calling port 3001 or the sidecar directly must send the
`x-chiptool-token` header. The token is stored with owner-only permissions in
`node_modules/.cache/chiptool-token`. Set `CHIPTOOL_TOKEN_FILE` to share another
local token file, or supply `CHIPTOOL_DEV_TOKEN` (at least 32 characters) to all
three processes. Keep these values out of browser code and URLs. To change the
frontend origin, set `CHIPTOOL_ALLOWED_ORIGINS` to a comma-separated list of exact
origins in the backend and frontend environments. The proxy validates Host,
Origin and browser fetch metadata before forwarding requests.

Training is disabled by default. To enable it, set `CHIPTOOL_ENABLE_TRAINING=1`
for both backend and sidecar. Training data must be under `data/ml_exports`
(or the configured data root), and checkpoint outputs are generated under
`ml/checkpoints`. Requests cannot choose output paths. Limits are 200 epochs,
1,000 steps per epoch, batch size 16, crop size 512, and 1,000,000 total samples
(`epochs × steps × batch size`). Supported training encoders are `resnet18`
and `resnet34`. Only one training job can run at a time. Model selection accepts
checkpoint basenames ending in `.pt`; a failed reload preserves the resident
model and prediction caches.

Image imports and processing have finite limits. The large input-pixel ceiling
supports gigapixel die photographs; decoded crops and inference regions have a
smaller ceiling. These environment settings accept positive integers:

| Setting | Default |
| --- | --- |
| `CHIPTOOL_MAX_UPLOAD_BYTES` | 1 GiB per file; one file per request |
| `CHIPTOOL_LIMIT_INPUT_PIXELS` | 4,000,000,000 source pixels |
| `CHIPTOOL_MAX_IMAGE_DIMENSION` | 100,000 pixels per side |
| `CHIPTOOL_MAX_REGION_PIXELS` | 4,194,304 decoded pixels, including ML padding |
| `CHIPTOOL_MAX_REGION_DIMENSION` | 4,096 pixels per side |
| `CHIPTOOL_MAX_SIDECAR_BYTES` | 32 MiB per sidecar request |

Use the same region limits for backend and sidecar. `CHIPTOOL_DATA_ROOT` applies
to both; `ML_DATA_ROOT` can override it for the sidecar. Import, tile, crop and
inference work queues are bounded and return HTTP 429 when full. Imports that
fail remove their temporary uploads. Training export scans reject symlinks and
are limited to 10,000 entries, 1 GiB total, and 16 MiB per sample file.

Datastore identifiers and metadata are validated before use. Original images
must belong to their die's `original` directory; symlinked datastore paths are
rejected. Invalid die records are omitted from the list and logged, and direct
access fails without modifying them.

Security regressions run with `npm test`. For the Python sidecar checks:

```sh
ml/.venv/bin/pip install -r ml/requirements-test.txt
ml/.venv/bin/python -m unittest discover -s ml -p test_security.py
```

The checks use temporary data and mocked inference/training workers.
