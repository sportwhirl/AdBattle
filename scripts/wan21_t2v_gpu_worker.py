#!/usr/bin/env python3
"""Process one manually approved Wan2.1 T2V staging job on a private GPU host.

Run beside a local LightX2V server with a shared filesystem. This deliberately
does not publish an ad or expose any video to the browser. A claimed job is
never automatically retried after an uncertain GPU submission.
"""

from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import time
from urllib.parse import quote, urlencode
from urllib.request import Request, build_opener, HTTPRedirectHandler

from process_video_media import MAX_INPUT_BYTES, process_video, VideoProcessingError


STAGING_URL = "https://nccqnrcdygujulrnwair.supabase.co"
MODEL = "Wan-AI/Wan2.1-T2V-1.3B"
UUID = re.compile(r"^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$", re.I)
STYLES = {
    "pixel_art": "Pixel art with crisp blocky pixels and a limited palette.",
    "flat_illustration": "Flat illustration with clean outlines and simple shapes.",
    "simple_3d": "Low polygon 3D art with restrained textures.",
    "hand_drawn": "Hand drawn pencil or ink art with a restrained palette.",
    "freeform_simple": "Use the visual style described by the creator.",
}


class WorkerError(Exception):
    pass


@contextmanager
def gpu_workspace(root: Path, job_id: str):
    # Retain the exact path after a lost reply or timeout: the GPU may still
    # be writing there, and the operator needs it to reconcile the known ID.
    work = Path(tempfile.mkdtemp(prefix=f"adbattle-wan21-{job_id}-", dir=root))
    try:
        yield work
    except BaseException:
        raise
    else:
        shutil.rmtree(work)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise WorkerError("Unexpected HTTP redirect")


class Api:
    def __init__(self, key: str, local_server: str = "http://127.0.0.1:8001"):
        if not key or not local_server.startswith("http://127.0.0.1:") or not re.fullmatch(
            r"http://127\.0\.0\.1:[0-9]{2,5}", local_server
        ):
            raise WorkerError("GPU server must be on local loopback; service key required")
        self.key, self.local_server = key, local_server
        self.opener = build_opener(NoRedirect)

    def request(self, path: str, *, method: str = "GET", body=None, local=False,
                limit: int = 128 * 1024, content_type: str = "application/json") -> bytes:
        base = self.local_server if local else STAGING_URL
        headers = {"content-type": content_type}
        if not local:
            headers.update({"apikey": self.key, "authorization": f"Bearer {self.key}"})
        payload = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
        req = Request(base + path, payload, headers=headers, method=method)
        with self.opener.open(req, timeout=30) as response:
            length = response.headers.get("Content-Length")
            if length and (not length.isdigit() or int(length) > limit):
                raise WorkerError("Response exceeds bound")
            data = response.read(limit + 1)
        if len(data) > limit:
            raise WorkerError("Response exceeds bound")
        return data

    def json(self, path: str, **kwargs):
        return json.loads(self.request(path, **kwargs))


def validate_job(job: dict) -> None:
    if (job.get("model") != MODEL or job.get("duration") != "5s" or
        job.get("resolution") != "480p" or job.get("status") != "dispatching" or
        job.get("aspect_ratio") not in ("16:9", "9:16") or
        job.get("style") not in STYLES or
        not all(UUID.fullmatch(str(job.get(k, ""))) for k in ("id", "user_id")) or
        not isinstance(job.get("prompt"), str) or not 12 <= len(job["prompt"]) <= 600):
        raise WorkerError("Invalid claimed job")


def patch_job(api: Api, job: dict, changes: dict) -> None:
    path = "/rest/v1/ai_video_draft_jobs?" + urlencode({
        "id": "eq." + job["id"], "status": "eq.dispatching", "select": "id"})
    # PostgREST returns one row only if the dispatching claim is still ours.
    headers = {"apikey": api.key, "authorization": f"Bearer {api.key}",
               "content-type": "application/json", "prefer": "return=representation"}
    req = Request(STAGING_URL + path, json.dumps(changes).encode(),
                  headers=headers, method="PATCH")
    with api.opener.open(req, timeout=30) as response:
        rows = json.loads(response.read(2048))
    if len(rows) != 1 or rows[0].get("id") != job["id"]:
        raise WorkerError("Claim changed; operator reconciliation required")


def process_one(api: Api, shared_root: Path, *, poll_seconds: float = 5,
                max_wait_seconds: float = 600) -> dict:
    jobs = api.json("/rest/v1/rpc/claim_wan21_video_job", method="POST", body={})
    if not jobs:
        return {"status": "idle"}
    if not isinstance(jobs, list) or len(jobs) != 1:
        raise WorkerError("Unexpected claim response")
    job = jobs[0]
    submitted = False
    try:
        validate_job(job)
        user = api.json("/auth/v1/admin/users/" + job["user_id"])
        if user.get("id") != job["user_id"] or user.get("app_metadata", {}).get(
            "ai_video_adult_test_approved") is not True:
            patch_job(api, job, {"status": "needs_review", "error_code": "ADULT_TEST_ACCESS_REVOKED"})
            return {"status": "needs_review", "job_id": job["id"]}
        granted = api.json("/rest/v1/rpc/has_adult_entitlement", method="POST", body={
            "p_user_id": job["user_id"], "p_scope": "ai_video_dispatch",
            "p_provider_route": "wan21_t2v"})
        if granted is not True:
            patch_job(api, job, {"status": "needs_review", "error_code": "ADULT_ENTITLEMENT_UNAVAILABLE"})
            return {"status": "needs_review", "job_id": job["id"]}
        # The server and bridge must share this root. No prompt becomes a path.
        with gpu_workspace(shared_root, job["id"]) as work:
            raw = work / "generated.mp4"
            style = STYLES[job["style"]]
            prompt = f"Five-second silent ad scene. {style} {job['prompt']}"
            request = {"task_id": job["id"], "task": "t2v", "prompt": prompt,
                       "save_result_path": str(raw), "num_frames": 81,
                       "size": [832, 480] if job["aspect_ratio"] == "9:16" else [480, 832]}
            # One GPU submission after the durable claim. Never retry on a lost response.
            # Native LightX2V IDs are not UUIDs by default. Supply and persist our
            # own stable ID before submission so a lost response can be reconciled.
            patch_job(api, job, {"gpu_task_id": job["id"]})
            submitted = True
            result = api.json("/v1/tasks/video/", method="POST", body=request, local=True)
            task_id = result.get("task_id")
            if task_id != job["id"]:
                raise WorkerError("GPU task identity changed")
            deadline = time.monotonic() + max_wait_seconds
            while time.monotonic() < deadline:
                state = api.json("/v1/tasks/" + task_id + "/status", local=True)
                if state.get("task_id") != task_id:
                    raise WorkerError("GPU task identity changed")
                if state.get("status") == "completed":
                    break
                if state.get("status") in ("failed", "cancelled"):
                    patch_job(api, job, {"status": "failed", "error_code": "GPU_INFERENCE_FAILED"})
                    return {"status": "failed", "job_id": job["id"]}
                if state.get("status") not in ("pending", "processing"):
                    raise WorkerError("Unknown GPU task state")
                time.sleep(poll_seconds)
            else:
                raise WorkerError("GPU task timed out")
            if not raw.is_file() or raw.stat().st_size > MAX_INPUT_BYTES:
                raise WorkerError("GPU output is missing or too large")
            derivatives = work / "derivatives"
            processed = process_video(raw, derivatives,
                                      "portrait" if job["aspect_ratio"] == "9:16" else "landscape")
            prefix = f"{job['user_id']}/{job['id']}"
            uploaded = {}
            for name, source_path, mime in [
                ("original.mp4", raw, "video/mp4"),
                ("full.mp4", derivatives / "full.mp4", "video/mp4"),
                ("poster.jpg", derivatives / "poster.jpg", "image/jpeg"),
                *(([("hover.mp4", derivatives / "hover.mp4", "video/mp4")])
                  if "hover.mp4" in processed["files"] else []),
            ]:
                object_path = prefix + "/" + name
                data = source_path.read_bytes()
                api.request("/storage/v1/object/ai-video-drafts/" + quote(object_path, safe="/"),
                            method="POST", body=data, content_type=mime, limit=2048)
                uploaded[name] = (object_path, hashlib.sha256(data).hexdigest())
            patch_job(api, job, {
                "status": "ready_for_processing", "error_code": None,
                "original_private_path": uploaded["original.mp4"][0],
                "original_sha256": uploaded["original.mp4"][1],
                "full_private_path": uploaded["full.mp4"][0],
                "full_sha256": uploaded["full.mp4"][1],
                "poster_private_path": uploaded["poster.jpg"][0],
                "poster_sha256": uploaded["poster.jpg"][1],
                "hover_private_path": uploaded.get("hover.mp4", (None, None))[0],
                "hover_sha256": uploaded.get("hover.mp4", (None, None))[1],
            })
            return {"status": "ready_for_processing", "job_id": job["id"]}
    except Exception:
        # A remote call or DB response may be ambiguous. Do not requeue or
        # delete any private objects; operator reconciliation is required.
        try:
            patch_job(api, job, {"status": "dispatch_unknown" if submitted else "needs_review",
                                 "error_code": "GPU_OUTCOME_UNCERTAIN" if submitted else "PREFLIGHT_FAILED"})
        except Exception:
            pass
        raise


def main() -> int:
    if os.getenv("ADBATTLE_AI_STAGING_ENABLED") != "video-drafts-v1":
        raise WorkerError("Staging video flag is off")
    root = Path(os.environ["WAN21_SHARED_ROOT"]).resolve(strict=True)
    if not root.is_dir():
        raise WorkerError("Shared GPU volume missing")
    api = Api(os.environ["SUPABASE_SERVICE_ROLE_KEY"],
              os.getenv("WAN21_SERVER", "http://127.0.0.1:8001"))
    result = process_one(api, root)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (WorkerError, VideoProcessingError, OSError, ValueError) as exc:
        print(f"Wan2.1 worker stopped: {type(exc).__name__}", file=sys.stderr)
        raise SystemExit(2) from exc
