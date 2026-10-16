"""Security regressions; inference/training are mocked and never use a GPU."""
import asyncio
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image

import security
import sidecar


class SidecarSecurityTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="chiptool-ml-security-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.ml = self.root / "ml"
        (self.ml / "checkpoints").mkdir(parents=True)
        self.data = self.root / "data"
        (self.data / "ml_exports" / "export1").mkdir(parents=True)
        state = sidecar.ModelState()
        state.device = "cpu"
        state.data_root = self.data
        for name, value in [("ML_DIR", self.ml), ("STATE", state), ("RESIDENT_FILE", self.ml / "checkpoints/.resident")]:
            patcher = patch.object(sidecar, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.client = TestClient(sidecar.app, headers={"x-chiptool-token": security.DEV_TOKEN})
        self.addCleanup(self.client.close)

    def resident(self):
        state = sidecar.STATE
        state.model = object()
        state.model_loaded = True
        state.checkpoint_path = self.ml / "checkpoints/resident.pt"
        state.checkpoint_hash = "resident-hash"
        return state.model

    def test_all_http_routes_require_token(self):
        raw = TestClient(sidecar.app)
        self.addCleanup(raw.close)
        for path in ["/health", "/models", "/openapi.json"]:
            self.assertEqual(raw.get(path).status_code, 401)
        self.assertEqual(raw.post("/train", json={"data_dir": "/tmp"}).status_code, 401)
        self.assertEqual(self.client.get("/health").status_code, 200)
        self.assertEqual(self.client.get("/health", headers={"origin": "http://attacker.example"}).status_code, 403)

    def test_checkpoint_traversal_does_not_probe_external_files(self):
        model = self.resident()
        (self.root / "existing.json").write_text("{}")
        for name in ["../../existing.json", "../../missing.json", "checkpoints/../../existing.json", str(self.root / "existing.json")]:
            response = self.client.post("/model/reload", json={"checkpoint_path": name})
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.json()["detail"], "Invalid checkpoint selection")
        self.assertIs(sidecar.STATE.model, model)

    def test_bad_checkpoint_preserves_every_resident_field_and_marker(self):
        model = self.resident()
        sidecar.RESIDENT_FILE.write_text("preserved\n")
        (self.ml / "checkpoints/invalid.pt").write_text("not a checkpoint")
        with patch("builtins.print"):
            response = self.client.post("/model/reload", json={"checkpoint_path": "invalid.pt"})
        self.assertEqual(response.status_code, 400)
        self.assertIs(sidecar.STATE.model, model)
        self.assertTrue(sidecar.STATE.model_loaded)
        self.assertEqual(sidecar.STATE.checkpoint_hash, "resident-hash")
        self.assertEqual(sidecar.STATE.checkpoint_path.name, "resident.pt")
        self.assertEqual(sidecar.RESIDENT_FILE.read_text(), "preserved\n")

    def test_valid_checkpoint_load_is_transactional(self):
        self.resident()
        checkpoint = self.ml / "checkpoints/model.pt"
        checkpoint.write_bytes(b"mock weights")
        model = MagicMock()
        model.to.return_value = model
        with patch.object(sidecar.torch, "load", return_value={"model_state": {}, "encoder": "resnet18"}), \
             patch.object(sidecar, "infer_num_classes", return_value=3), \
             patch.object(sidecar, "build_model", return_value=model):
            response = self.client.post("/model/reload", json={"checkpoint_path": "model.pt"})
        self.assertEqual(response.status_code, 200)
        self.assertIs(sidecar.STATE.model, model)
        self.assertEqual(sidecar.RESIDENT_FILE.read_text().strip(), str(checkpoint.resolve()))
        model.load_state_dict.assert_called_once_with({})

    def test_symlinked_checkpoints_are_not_listed_or_loaded(self):
        outside = self.root / "outside.pt"
        outside.write_bytes(b"external")
        (self.ml / "checkpoints/linked.pt").symlink_to(outside)
        self.assertEqual(self.client.get("/models").json(), {"models": []})
        self.assertEqual(self.client.post("/model/reload", json={"checkpoint_path": "linked.pt"}).status_code, 400)

    def test_training_disabled_and_parameters_bounded(self):
        with patch.dict(os.environ, {"CHIPTOOL_ENABLE_TRAINING": "0"}):
            self.assertEqual(self.client.post("/train", json={"data_dir": "ml_exports/export1"}).status_code, 403)
        with patch.dict(os.environ, {"CHIPTOOL_ENABLE_TRAINING": "1"}):
            for parameters in [{"output": "/tmp/overwrite.pt"}, {"epochs": 999999}, {"batch_size": 64}, {"crop_size": 33},
                               {"epochs": 200, "steps_per_epoch": 1000, "batch_size": 16}, {"lr": -1}, {"encoder": "huge-model"}]:
                self.assertEqual(self.client.post("/train", json={"data_dir": "ml_exports/export1", **parameters}).status_code, 422)
            for directory in [str(self.root), "../outside", "/tmp"]:
                self.assertEqual(self.client.post("/train", json={"data_dir": directory}).status_code, 400)

    def test_training_uses_generated_output_and_admits_only_one_worker(self):
        with patch.dict(os.environ, {"CHIPTOOL_ENABLE_TRAINING": "1"}), patch.object(sidecar.threading, "Thread") as thread:
            body = sidecar.TrainBody(data_dir="ml_exports/export1", epochs=1, steps_per_epoch=1, batch_size=1)
            result = sidecar.train(body)
            self.assertIn("job_id", result)
            params = thread.call_args.kwargs["args"][1]
            self.assertEqual(Path(params.output).parent, self.ml / "checkpoints")
            self.assertTrue(Path(params.output).name.startswith("train-"))
            self.assertFalse(Path(params.output).exists())
            self.assertEqual(params.num_workers, 0)
            with self.assertRaises(HTTPException) as rejected:
                sidecar.train(body)
            self.assertEqual(rejected.exception.status_code, 409)
            thread.return_value.start.assert_called_once()

    def test_training_rejects_symlinked_dataset_files(self):
        (self.data / "ml_exports/export1/linked.json").symlink_to(self.root / "outside.json")
        with patch.dict(os.environ, {"CHIPTOOL_ENABLE_TRAINING": "1"}):
            self.assertEqual(self.client.post("/train", json={"data_dir": "ml_exports/export1"}).status_code, 400)

    def test_image_header_limits_run_before_opencv_decode(self):
        self.resident()
        image = io.BytesIO()
        Image.new("RGB", (16, 16)).save(image, format="PNG")
        with patch.object(sidecar, "MAX_REGION_PIXELS", 100), patch.object(sidecar.cv2, "imdecode") as decode:
            response = self.client.post("/predict/region", files={"image": ("test.png", image.getvalue(), "image/png")})
            self.assertEqual(response.status_code, 413)
            decode.assert_not_called()

    def test_prediction_queue_rejects_before_decoding(self):
        self.resident()
        sidecar.PREDICTION_SLOT.acquire()
        try:
            response = self.client.post("/predict/region", files={"image": ("test.png", b"unused", "image/png")})
            self.assertEqual(response.status_code, 429)
        finally:
            sidecar.PREDICTION_SLOT.release()

    def test_body_limits_cover_content_length_and_chunked_requests(self):
        with patch.object(security, "MAX_BODY_BYTES", 8):
            self.assertEqual(self.client.post("/train", content=b"x" * 9).status_code, 413)
            async def exercise():
                output = []
                chunks = iter([{"type": "http.request", "body": b"12345", "more_body": True},
                               {"type": "http.request", "body": b"67890", "more_body": False}])
                async def receive():
                    return next(chunks)
                async def send(message):
                    output.append(message)
                async def downstream(scope, recv, sender):
                    while (await recv()).get("more_body"):
                        pass
                    raise AssertionError("oversized body reached handler")
                scope = {"type": "http", "headers": [(b"x-chiptool-token", security.DEV_TOKEN.encode())]}
                await security.LocalAccessMiddleware(downstream)(scope, receive, send)
                self.assertEqual(output[0]["status"], 413)
            asyncio.run(exercise())


if __name__ == "__main__":
    unittest.main()
