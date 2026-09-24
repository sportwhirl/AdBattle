"""Offline HTTP and media tests. These results are not GPU performance evidence."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import benchmark_wan21 as bench


def telemetry():
    return [{"uuid": "fixture-gpu", "used_mib": 100, "utilization_percent": 20}]


class FakeClient:
    def __init__(self, port=8001, *, fail_post=False, mismatch=False, never_finishes=False):
        self.server = f"http://127.0.0.1:{port}"
        self.fail_post, self.mismatch, self.never_finishes = fail_post, mismatch, never_finishes
        self.posts = []
        self.polls = 0

    def json(self, path, body=None, **kwargs):
        if body is not None:
            self.posts.append(body)
            if self.fail_post:
                raise OSError("lost response")
            Path(body["save_result_path"]).write_bytes(b"test video placeholder")
            return {"task_id": body["task_id"], "task_status": "pending"}
        self.polls += 1
        return {"task_id": "wrong" if self.mismatch else path.split("/")[-2],
                "status": "pending" if self.never_finishes else "completed"}


class Wan21BenchmarkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_real_loopback_http_and_ffmpeg_output(self):
        fixture = self.root / "fixture.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
                        "color=c=blue:size=832x480:rate=16", "-frames:v", "81",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", str(fixture)],
                       check=True, timeout=30)
        posts = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, value):
                raw = json.dumps(value).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_POST(self):
                if self.path != "/v1/tasks/video/":
                    self.send_response(307)
                    self.send_header("Location", "/v1/tasks/video/")
                    self.end_headers()
                    return
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                posts.append(body)
                shutil.copyfile(fixture, body["save_result_path"])
                self.reply({"task_id": body["task_id"], "task_status": "pending"})

            def do_GET(self):
                self.reply({"task_id": self.path.split("/")[-2], "status": "completed"})
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = bench.Client(f"http://127.0.0.1:{server.server_port}")
            report = bench.benchmark([client], self.root / "output", sample_gpu=telemetry)
            self.assertEqual("completed", report["status"])
            self.assertEqual(1, report["summary"]["validated_clips"])
            job = report["jobs"][0]
            self.assertEqual(job["task_id"], posts[0]["task_id"])
            self.assertEqual([480, 832], posts[0]["size"])
            self.assertEqual(81, posts[0]["num_frames"])
            self.assertNotIn("image_path", posts[0])
            for name in ("full.mp4", "hover.mp4", "poster.jpg"):
                self.assertTrue((self.root / "output/clip-1/derivatives" / name).is_file())
            self.assertEqual(report, json.loads((self.root / "output/report.json").read_text()))
            # A POST redirect must fail instead of following/repeating the paid operation.
            with self.assertRaises(bench.BenchmarkError):
                client.json("/v1/tasks/video", {"task_id": "unused"})
            self.assertEqual(1, len(posts))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_two_workers_and_portrait_are_explicit(self):
        clients = [FakeClient(8001), FakeClient(8002)]
        report = bench.benchmark(clients, self.root / "two", clips=2, concurrency=2,
                                 sample_gpu=telemetry, process=lambda *args: {"files": {}})
        self.assertEqual([0, 1], [j["server_index"] for j in report["jobs"]])
        self.assertEqual([832, 480], clients[1].posts[0]["size"])
        self.assertEqual(2, report["summary"]["validated_clips"])
        self.assertEqual("pending_human_review", report["summary"]["quality_review"])

    def test_lost_post_or_wrong_poll_id_stops_more_submissions(self):
        for mode in ("fail_post", "mismatch"):
            client = FakeClient(**{mode: True})
            output = self.root / mode
            report = bench.benchmark([client], output, clips=3, sample_gpu=telemetry)
            self.assertEqual(1, len(client.posts))
            self.assertEqual("outcome_unknown", report["jobs"][0]["status"])
            self.assertIsNone(report["summary"]["clips_per_hour_in_this_run"])
            self.assertEqual(client.posts[0]["task_id"],
                             json.loads((output / "report.json").read_text())["jobs"][0]["task_id"])

    def test_timeout_keeps_identity_and_never_resubmits(self):
        now = [0.0]
        def pause(seconds):
            now[0] += seconds
        client = FakeClient(never_finishes=True)
        report = bench.benchmark([client], self.root / "timeout", clips=2, timeout=2,
                                 sample_gpu=telemetry, clock=lambda: now[0], pause=pause)
        self.assertEqual(1, len(client.posts))
        self.assertEqual("outcome_unknown", report["jobs"][0]["status"])

    def test_invalid_video_does_not_count_as_capacity(self):
        report = bench.benchmark([FakeClient()], self.root / "invalid", sample_gpu=telemetry)
        self.assertEqual("invalid_output", report["jobs"][0]["status"])
        self.assertEqual(0, report["summary"]["validated_clips"])
        self.assertIsNone(report["summary"]["clips_per_hour_in_this_run"])

    def test_limits_and_private_loopback_boundary(self):
        for server in ("https://example.com", "http://localhost:8001", "http://127.0.0.1:99999",
                       "http://127.0.0.1:8001/elsewhere", "http://user@127.0.0.1:8001"):
            with self.assertRaises(bench.BenchmarkError):
                bench.Client(server)
        for clips, concurrency in ((9, 1), (0, 1), (1, 2), (4, 4)):
            with self.assertRaises(bench.BenchmarkError):
                bench.benchmark([FakeClient()], self.root / "invalid-options",
                                clips=clips, concurrency=concurrency)
        self.assertFalse((self.root / "invalid-options").exists())


if __name__ == "__main__":
    unittest.main()
