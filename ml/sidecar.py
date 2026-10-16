"""ML HTTP sidecar.

Stateless-per-request inference service with the U-Net resident in memory.
The Node backend proxies to this; the browser never talks to it directly.

Run:
    python sidecar.py --checkpoint checkpoints/model.pt --port 8001

Step 1 surface: /health + model-load-on-boot. Prediction / training endpoints
are added in later steps; the module is structured so they slot into STATE.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import math
import os
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import cv2
import numpy as np
import torch
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from augment import normalize_only
from heatmap import extract_components, extract_peaks, extract_trace_polylines
from model import build_model, infer_num_classes
from tiling import tile_predict
from trainer import TrainParams, run_training


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()

_NORM_TF = normalize_only()


def _normalize(tile_uint8_rgb: np.ndarray) -> torch.Tensor:
    return _NORM_TF(image=tile_uint8_rgb)["image"]

ML_DIR = Path(__file__).resolve().parent


def auto_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def checkpoint_hash(path: Path) -> str:
    """Stable short hash of the checkpoint file content. Drives Node cache keys —
    a retrained model produces a new hash, so cached predictions auto-invalidate."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:12]


@dataclass
class ModelState:
    device: str = field(default_factory=auto_device)
    data_root: Path = ML_DIR.parent / "data"
    checkpoint_path: Path | None = None
    checkpoint_hash: str | None = None
    encoder: str = "resnet18"
    num_classes: int = 1
    model: torch.nn.Module | None = None
    model_loaded: bool = False
    training_active: bool = False
    # Serializes GPU work. Step 1 doesn't use it yet; later steps (predict /
    # train) acquire this so concurrent tile requests don't race the device.
    lock: threading.Lock = field(default_factory=threading.Lock)

    def load(self, checkpoint_path: Path) -> None:
        if not checkpoint_path.exists():
            self.checkpoint_path = checkpoint_path
            self.model = None
            self.model_loaded = False
            self.checkpoint_hash = None
            print(f"[sidecar] no checkpoint at {checkpoint_path} — running unloaded")
            return
        try:
            ckpt = torch.load(checkpoint_path, map_location=self.device, weights_only=True)
            encoder = ckpt.get("encoder", "resnet18")
            n_classes = infer_num_classes(ckpt["model_state"])
            model = build_model(encoder_name=encoder, encoder_weights=None,
                                classes=n_classes).to(self.device)
            model.load_state_dict(ckpt["model_state"])
            model.eval()
        except Exception as exc:  # noqa: BLE001 — degrade gracefully, never crash boot
            self.model = None
            self.model_loaded = False
            self.checkpoint_path = checkpoint_path
            self.checkpoint_hash = None
            print(f"[sidecar] failed to load {checkpoint_path}: {exc} — running unloaded")
            return
        self.model = model
        self.encoder = encoder
        self.num_classes = n_classes
        self.checkpoint_path = checkpoint_path
        self.checkpoint_hash = checkpoint_hash(checkpoint_path)
        self.model_loaded = True
        print(f"[sidecar] loaded {checkpoint_path} ({encoder}, {n_classes} classes) "
              f"hash={self.checkpoint_hash} device={self.device}")


STATE = ModelState()

# The checkpoint last loaded successfully, so a sidecar restart (e.g. `npm run
# dev`) comes back on the model the user picked instead of the CLI default.
# Node keys its prediction cache by checkpoint hash, so coming up on a
# different model makes every cached via "disappear" from the UI.
RESIDENT_FILE = ML_DIR / "checkpoints" / ".resident"


def remember_resident(path: Path) -> None:
    try:
        RESIDENT_FILE.parent.mkdir(parents=True, exist_ok=True)
        RESIDENT_FILE.write_text(str(path.resolve()) + "\n", encoding="utf-8")
    except OSError as exc:
        print(f"[sidecar] could not record resident checkpoint: {exc}")


def recall_resident() -> Path | None:
    try:
        raw = RESIDENT_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    p = Path(raw)
    return p if raw and p.exists() else None


@dataclass
class JobRecord:
    job_id: str
    kind: str  # "train" | "predict_die"
    status: str  # "running" | "done" | "error"
    epochs: int = 0
    epoch: int = 0
    loss: float | None = None
    checkpoint_path: str | None = None
    error: str | None = None
    cancel: bool = False
    started_at: str = field(default_factory=_now)
    updated_at: str = field(default_factory=_now)

    def as_dict(self) -> dict:
        # NaN/inf are not valid JSON — surface them as null so the Node/UI
        # contract is always parseable (a diverged run shows loss: null).
        loss = self.loss if (self.loss is not None and math.isfinite(self.loss)) else None
        return {
            "job_id": self.job_id,
            "kind": self.kind,
            "status": self.status,
            "epoch": self.epoch,
            "epochs": self.epochs,
            "loss": loss,
            "checkpoint_path": self.checkpoint_path,
            "error": self.error,
            "started_at": self.started_at,
            "updated_at": self.updated_at,
        }


JOBS: dict[str, JobRecord] = {}
JOBS_LOCK = threading.Lock()


class TrainBody(BaseModel):
    data_dir: str
    epochs: int = 50  # snappier than the CLI default (200) for the retrain loop
    encoder: str = "resnet18"
    lr: float = 1e-3
    crop_size: int = 256
    steps_per_epoch: int = 100
    batch_size: int = 8
    output: str | None = None  # defaults to the resident checkpoint path


class ReloadBody(BaseModel):
    checkpoint_path: str


app = FastAPI(title="chiptool-ml-sidecar")


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "device": STATE.device,
        "checkpoint": STATE.checkpoint_path.name if STATE.checkpoint_path else None,
        "checkpoint_hash": STATE.checkpoint_hash,
        "encoder": STATE.encoder,
        "num_classes": STATE.num_classes,
        "model_loaded": STATE.model_loaded,
        "training_active": STATE.training_active,
    }


@app.post("/predict/region")
def predict_region(
    image: UploadFile = File(...),
    threshold: float = Form(0.5),
    min_distance: int = Form(4),
    return_heatmap: bool = Form(False),
) -> dict:
    """Stateless: decode the posted crop, run the U-Net, return peaks in
    *crop-local* pixel coords. Node owns the source-coord translation,
    tile math, padding, filtering and caching. Sync endpoint so FastAPI
    runs it in a worker thread; STATE.lock serializes the single device."""
    if not STATE.model_loaded or STATE.model is None:
        raise HTTPException(status_code=503, detail="model not loaded")
    if STATE.training_active:
        raise HTTPException(status_code=503, detail="training")

    raw = image.file.read()
    arr = np.frombuffer(raw, dtype=np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        raise HTTPException(status_code=400, detail="could not decode image")
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    h, w = rgb.shape[:2]

    with STATE.lock:
        maps = tile_predict(
            STATE.model, rgb,
            tile_size=512, overlap=64,
            device=STATE.device, batch_size=4,
            normalize=_normalize,
        )  # (C, H, W) — C=1 (old vias-only model) or C=3 (multi-class)
    n_ch = maps.shape[0]
    ch0 = maps[0]
    ch1 = maps[1] if n_ch >= 2 else None
    ch2 = maps[2] if n_ch >= 3 else None

    peaks = extract_peaks(ch0, threshold=threshold, min_distance=min_distance)
    resp: dict = {
        "point_vias": [{"x": int(x), "y": int(y), "score": float(s)} for (x, y, s) in peaks],
        "irregular_vias": extract_components(ch1, threshold=threshold) if ch1 is not None else [],
        "traces": extract_trace_polylines(ch2, threshold=threshold) if ch2 is not None else [],
        "width": w,
        "height": h,
        "num_classes": n_ch,
        "checkpoint_hash": STATE.checkpoint_hash,
    }
    if return_heatmap:
        # Raw sigmoid maps → RGB PNG: R=point_via, G=irregular_via, B=trace.
        # 1-class model → point_via in R, G/B zero. Node crops to the exact
        # tile; frontend colorizes / splits channels.
        zeros = np.zeros_like(ch0)
        rgb_hm = np.stack([
            np.clip(ch0 * 255.0, 0, 255),
            np.clip((ch1 if ch1 is not None else zeros) * 255.0, 0, 255),
            np.clip((ch2 if ch2 is not None else zeros) * 255.0, 0, 255),
        ], axis=-1).astype(np.uint8)
        ok, png = cv2.imencode(".png", cv2.cvtColor(rgb_hm, cv2.COLOR_RGB2BGR))
        if not ok:
            raise HTTPException(status_code=500, detail="heatmap encode failed")
        resp["heatmap_png_b64"] = base64.b64encode(png.tobytes()).decode("ascii")
    return resp


def _train_worker(job: JobRecord, params: TrainParams, out: str) -> None:
    def on_epoch(ep: int, total: int, loss: float) -> None:
        with JOBS_LOCK:
            job.epoch = ep
            job.epochs = total
            job.loss = loss
            job.updated_at = _now()

    try:
        run_training(params, on_epoch=on_epoch,
                     should_stop=lambda: job.cancel, use_tqdm=False)
        # Auto-reload: new weights → new checkpoint_hash → Node caches invalidate.
        with STATE.lock:
            STATE.load(Path(out))
        with JOBS_LOCK:
            job.status = "done"
            job.checkpoint_path = out
            job.updated_at = _now()
    except Exception as exc:  # noqa: BLE001 — surface any failure to the job
        with JOBS_LOCK:
            job.status = "error"
            job.error = str(exc)
            job.updated_at = _now()
        print(f"[sidecar] train job {job.job_id} failed: {exc}")
    finally:
        STATE.training_active = False


@app.post("/train")
def train(body: TrainBody) -> dict:
    if STATE.training_active:
        raise HTTPException(status_code=409, detail="training already in progress")

    data_dir = Path(body.data_dir)
    if not data_dir.is_absolute():
        data_dir = STATE.data_root / body.data_dir
    if not data_dir.exists():
        raise HTTPException(status_code=400, detail=f"data_dir not found: {data_dir}")

    if body.output:
        out = body.output if Path(body.output).is_absolute() else str(ML_DIR / body.output)
    elif STATE.checkpoint_path:
        out = str(STATE.checkpoint_path)
    else:
        out = str(ML_DIR / "checkpoints" / "model.pt")

    job = JobRecord(job_id=uuid4().hex[:12], kind="train",
                    status="running", epochs=body.epochs)
    with JOBS_LOCK:
        JOBS[job.job_id] = job
    # Set before the thread starts so an immediate /predict gets 503.
    STATE.training_active = True

    params = TrainParams(
        data_dir=str(data_dir),
        epochs=body.epochs,
        batch_size=body.batch_size,
        lr=body.lr,
        crop_size=body.crop_size,
        steps_per_epoch=body.steps_per_epoch,
        encoder=body.encoder,
        output=out,
        device=STATE.device,
    )
    threading.Thread(target=_train_worker, args=(job, params, out), daemon=True).start()
    return {"job_id": job.job_id}


@app.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="job not found")
        return job.as_dict()


@app.get("/models")
def list_models() -> dict:
    """List checkpoint files the sidecar can load (the checkpoints/ dir).

    Node surfaces this as the model dropdown. Hashes let the caller tell
    whether a switch actually changes the resident weights."""
    ckpt_dir = ML_DIR / "checkpoints"
    resident = STATE.checkpoint_path.resolve() if STATE.checkpoint_path else None
    models: list[dict] = []
    if ckpt_dir.is_dir():
        for p in sorted(ckpt_dir.glob("*.pt")):
            try:
                h: str | None = checkpoint_hash(p)
            except Exception:  # noqa: BLE001 — a bad file shouldn't drop the list
                h = None
            models.append({
                "name": p.name,
                "hash": h,
                "size_bytes": p.stat().st_size,
                "resident": resident is not None and p.resolve() == resident,
            })
    return {"models": models}


@app.post("/model/reload")
def model_reload(body: ReloadBody) -> dict:
    if STATE.training_active:
        raise HTTPException(status_code=409, detail="cannot reload during training")
    p = Path(body.checkpoint_path)
    if not p.is_absolute():
        p = ML_DIR / body.checkpoint_path
    if not p.exists():
        raise HTTPException(status_code=400, detail=f"checkpoint not found: {p}")
    with STATE.lock:
        STATE.load(p)
    if STATE.model_loaded and STATE.checkpoint_path:
        remember_resident(STATE.checkpoint_path)
    return {
        "checkpoint": STATE.checkpoint_path.name if STATE.checkpoint_path else None,
        "checkpoint_hash": STATE.checkpoint_hash,
        "model_loaded": STATE.model_loaded,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", default=os.environ.get("ML_CHECKPOINT"),
                        help="checkpoint to load; default: the last one loaded via "
                             "/model/reload, else checkpoints/model.pt")
    parser.add_argument("--data-root", default=os.environ.get("ML_DATA_ROOT", str(ML_DIR.parent / "data")))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("ML_SIDECAR_PORT", 8001)))
    args = parser.parse_args()

    STATE.data_root = Path(args.data_root)
    if args.checkpoint:
        ckpt = Path(args.checkpoint)
        if not ckpt.is_absolute():
            ckpt = ML_DIR / ckpt
    else:
        remembered = recall_resident()
        if remembered is not None:
            print(f"[sidecar] resuming resident checkpoint {remembered}")
        ckpt = remembered or (ML_DIR / "checkpoints" / "model.pt")
    STATE.load(ckpt)
    if STATE.model_loaded and STATE.checkpoint_path:
        remember_resident(STATE.checkpoint_path)

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
