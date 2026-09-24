"""Offline tests of the private GPU bridge; no model or hosted service needed."""

from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import wan21_t2v_gpu_worker as worker  # noqa: E402


OWNER = "00000000-0000-4000-8000-000000000001"
JOB = "20000000-0000-4000-8000-000000000001"
TASK = JOB


def job():
    return {"id": JOB, "user_id": OWNER,
            "status": "dispatching", "model": worker.MODEL, "duration": "5s",
            "resolution": "480p", "aspect_ratio": "16:9", "style": "flat_illustration",
            "prompt": "A playful pencil dances around a bright notebook"}


class FakeApi:
    def __init__(self, *, adult=True, granted=True):
        self.adult, self.granted = adult, granted
        self.local_calls = []
        self.uploads = []

    def json(self, path, *, method="GET", body=None, local=False):
        if local:
            self.local_calls.append((path, body))
            if path == "/v1/tasks/video/":
                assert body["task_id"] == JOB
                Path(body["save_result_path"]).write_bytes(b"generated-video-fixture")
                return {"task_id": TASK, "task_status": "pending"}
            return {"task_id": TASK, "status": "completed"}
        if path.endswith("/claim_wan21_video_job"):
            return [job()]
        if path.startswith("/auth/v1/admin/users/"):
            return {"id": OWNER, "app_metadata": {"ai_video_adult_test_approved": self.adult}}
        if path.endswith("/has_adult_entitlement"):
            assert body == {"p_user_id": OWNER, "p_scope": "ai_video_dispatch",
                            "p_provider_route": "wan21_t2v"}
            return self.granted
        raise AssertionError(path)

    def request(self, path, *, method="GET", body=None, local=False,
                limit=0, content_type="application/json"):
        if path.startswith("/storage/v1/object/ai-video-drafts/"):
            self.uploads.append((path, body, content_type))
            return b"{}"
        raise AssertionError(path)


class Wan21T2VGpuWorkerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.patches = []
        patcher = mock.patch.object(worker, "patch_job", side_effect=lambda api, job, data: self.patches.append(data))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_denied_adult_or_grant_never_reaches_gpu(self):
        for api, code in [(FakeApi(adult=False), "ADULT_TEST_ACCESS_REVOKED"),
                          (FakeApi(granted=False), "ADULT_ENTITLEMENT_UNAVAILABLE")]:
            self.patches.clear()
            result = worker.process_one(api, self.root)
            self.assertEqual("needs_review", result["status"])
            self.assertEqual(code, self.patches[-1]["error_code"])
            self.assertEqual([], api.local_calls)

    def test_exactly_one_t2v_submission_and_private_media_only(self):
        api = FakeApi()
        def processed(source, destination, orientation):
            self.assertEqual("landscape", orientation)
            destination.mkdir()
            for filename in ("full.mp4", "hover.mp4", "poster.jpg"):
                (destination / filename).write_bytes(filename.encode())
            return {"files": {name: {} for name in ("full.mp4", "hover.mp4", "poster.jpg")}}
        with mock.patch.object(worker, "process_video", side_effect=processed):
            result = worker.process_one(api, self.root, poll_seconds=0)
        self.assertEqual("ready_for_processing", result["status"])
        self.assertEqual(1, len([path for path, _ in api.local_calls if path == "/v1/tasks/video/"]))
        submission = api.local_calls[0][1]
        self.assertEqual("t2v", submission["task"])
        self.assertEqual(JOB, submission["task_id"])
        self.assertNotIn("image_path", submission)
        self.assertEqual([480, 832], submission["size"])
        self.assertEqual(81, submission["num_frames"])
        self.assertEqual(4, len(api.uploads))
        self.assertTrue(all("ai-video-drafts" in path for path, _, _ in api.uploads))
        self.assertEqual("ready_for_processing", self.patches[-1]["status"])
        self.assertEqual(TASK, self.patches[0]["gpu_task_id"])
        self.assertEqual([], list(self.root.iterdir()))

    def test_uncertain_gpu_response_is_never_requeued(self):
        api = FakeApi()
        original = api.json
        def missing_id(path, **kwargs):
            if path == "/v1/tasks/video/":
                api.local_calls.append((path, kwargs["body"]))
                return {}
            return original(path, **kwargs)
        api.json = missing_id
        with self.assertRaises(worker.WorkerError):
            worker.process_one(api, self.root)
        self.assertEqual(1, len(api.local_calls))
        self.assertEqual("dispatch_unknown", self.patches[-1]["status"])
        self.assertEqual(JOB, self.patches[0]["gpu_task_id"])
        retained = Path(api.local_calls[0][1]["save_result_path"]).parent
        self.assertTrue(retained.is_dir())
        self.assertIn(JOB, retained.name)


if __name__ == "__main__":
    unittest.main()
