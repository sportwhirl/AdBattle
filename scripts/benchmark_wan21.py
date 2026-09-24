#!/usr/bin/env python3
"""Bounded Wan2.1 benchmark against private local LightX2V servers.

No application credentials, database writes, cloud rental or automatic retries.
Run in the same Linux filesystem/network namespace as the model server(s).
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
from pathlib import Path
import re
import statistics
import subprocess
import time
from urllib.request import Request, build_opener, HTTPRedirectHandler, ProxyHandler
import uuid

from process_video_media import process_video

MODEL = "Wan-AI/Wan2.1-T2V-1.3B"
MODEL_REVISION = "37ec512624d61f7aa208f7ea8140a131f93afc9a"
RUNTIME_REVISION = "a4b8ce30ac73ae561ec9d1a8bc6629e4aed9d2d8"
PROMPT = ("Five-second silent ad scene. Flat illustration with clean outlines and simple shapes. "
          "A playful pencil dances around a bright notebook on a plain background.")


class BenchmarkError(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise BenchmarkError("Unexpected redirect; check the pinned server API")


class Client:
    def __init__(self, server: str):
        match = re.fullmatch(r"http://127\.0\.0\.1:([0-9]{2,5})", server)
        if not match or not 1024 <= int(match[1]) <= 65535:
            raise BenchmarkError("Use a loopback server on port 1024-65535")
        self.server = server
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def json(self, path: str, body=None, *, timeout=30):
        payload = None if body is None else json.dumps(body).encode()
        request = Request(self.server + path, payload,
                          headers={"content-type": "application/json"},
                          method="GET" if body is None else "POST")
        with self.opener.open(request, timeout=timeout) as response:
            raw = response.read(128 * 1024 + 1)
        if len(raw) > 128 * 1024:
            raise BenchmarkError("Runtime response exceeds bound")
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise BenchmarkError("Runtime response must be an object")
        return result


def gpu_snapshot() -> list[dict]:
    command = ["nvidia-smi", "--query-gpu=index,name,uuid,memory.total,memory.used,utilization.gpu,driver_version",
               "--format=csv,noheader,nounits"]
    try:
        raw = subprocess.check_output(command, text=True, stderr=subprocess.DEVNULL, timeout=5)
        rows = []
        for row in csv.reader(io.StringIO(raw)):
            index, name, ident, total, used, util, driver = [field.strip() for field in row]
            rows.append({"index": index, "name": name, "uuid": ident, "driver": driver,
                         "total_mib": int(total), "used_mib": int(used),
                         "utilization_percent": int(util)})
        if not rows:
            raise ValueError("No devices")
        return rows
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        raise BenchmarkError("NVIDIA GPU telemetry is unavailable on this host") from exc


def save(path: Path, value: dict) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def summarize(report: dict) -> None:
    valid = [job for job in report["jobs"] if job["status"] == "validated"]
    seconds = report["generation_wall_seconds"]
    all_valid = len(valid) == report["requested_clips"]
    # Never estimate capacity from a partially failed run or count invalid MP4s.
    report["summary"] = {
        "validated_clips": len(valid),
        "all_outputs_valid": all_valid,
        "clips_per_hour_in_this_run": len(valid) * 3600 / seconds if all_valid and seconds > 0 else None,
        "median_request_seconds": statistics.median(j["request_seconds"] for j in valid) if valid else None,
        "quality_review": "pending_human_review",
        "capacity_note": "Small local run including the first request; excludes model startup. Not a production capacity claim.",
    }


def benchmark(clients, output: Path, *, clips=1, concurrency=1, timeout=900,
              poll_seconds=1, sample_gpu=gpu_snapshot, process=process_video,
              clock=time.monotonic, pause=time.sleep) -> dict:
    if not 1 <= clips <= 8 or concurrency not in (1, 2) or concurrency > clips:
        raise BenchmarkError("Use 1-8 clips and concurrency 1 or 2, no greater than clips")
    if not 1 <= len(clients) <= concurrency or not math.isfinite(timeout) or timeout <= 0:
        raise BenchmarkError("Invalid server count or timeout")
    output = output.resolve()
    output.mkdir(mode=0o700, exist_ok=False)
    config_bytes = Path(__file__).with_name("wan21_benchmark_config.json").read_bytes()
    report = {"model": MODEL, "expected_model_revision": MODEL_REVISION,
              "expected_runtime_revision": RUNTIME_REVISION, "requested_clips": clips,
              "expected_config": json.loads(config_bytes),
              "expected_config_sha256": hashlib.sha256(config_bytes).hexdigest(),
              "runtime_verification": "Model class/path checked by CLI; runtime commit and loaded config require startup evidence.",
              "client_concurrency": concurrency, "servers": [c.server for c in clients],
              "jobs": [], "gpu_peak_used_mib": {}, "gpu_peak_utilization_percent": {}, "telemetry_samples": 0,
              "telemetry_errors": 0, "status": "running"}
    start = clock()
    active = {}
    next_index = 0
    abort = False
    def checkpoint():
        save(output / "report.json", report)
    def capture_gpu():
        try:
            snapshot = sample_gpu()
            report.setdefault("gpu_baseline", snapshot)
            report["telemetry_samples"] += 1
            for gpu in snapshot:
                ident = gpu["uuid"]
                report["gpu_peak_used_mib"][ident] = max(
                    report["gpu_peak_used_mib"].get(ident, 0), gpu["used_mib"])
                report["gpu_peak_utilization_percent"][ident] = max(
                    report["gpu_peak_utilization_percent"].get(ident, 0), gpu.get("utilization_percent", 0))
        except BenchmarkError:
            report["telemetry_errors"] += 1
    capture_gpu()
    checkpoint()
    while active or (next_index < clips and not abort):
        while not abort and next_index < clips and len(active) < concurrency:
            # One server is sequential. With two servers, keep one job on each.
            busy = {job["server_index"] for job in active.values()}
            server_index = next((i for i in range(len(clients)) if i not in busy), 0)
            task_id = str(uuid.uuid4())
            job_dir = output / f"clip-{next_index + 1}"
            job_dir.mkdir(mode=0o700)
            orientation = "landscape" if next_index % 2 == 0 else "portrait"
            job = {"task_id": task_id, "server_index": server_index,
                   "orientation": orientation, "seed": 42 + next_index,
                   "status": "submitting", "submitted_offset_seconds": clock() - start,
                   "raw_path": str(job_dir / "generated.mp4")}
            report["jobs"].append(job)
            next_index += 1
            checkpoint()  # Keep reconciliation ID and path even if the POST reply is lost.
            request = {"task_id": task_id, "task": "t2v", "prompt": PROMPT,
                       "seed": job["seed"], "num_frames": 81,
                       "size": [480, 832] if orientation == "landscape" else [832, 480],
                       "save_result_path": job["raw_path"]}
            try:
                reply = clients[server_index].json("/v1/tasks/video/", request)
                if reply.get("task_id") != task_id:
                    raise BenchmarkError("Submission task identity mismatch")
                job["status"] = "pending"
                active[task_id] = job
            except Exception as exc:
                job.update(status="outcome_unknown", error_type=type(exc).__name__)
                abort = True
            checkpoint()
        capture_gpu()
        for task_id, job in list(active.items()):
            elapsed = clock() - start - job["submitted_offset_seconds"]
            try:
                if elapsed >= timeout:
                    raise BenchmarkError("Task deadline exceeded")
                state = clients[job["server_index"]].json(
                    f"/v1/tasks/{task_id}/status", timeout=min(30, timeout - elapsed))
                if state.get("task_id") != task_id:
                    raise BenchmarkError("Polled task identity mismatch")
                status = state.get("status")
                if status not in ("pending", "processing", "completed", "failed", "cancelled"):
                    raise BenchmarkError("Unknown runtime state")
                job["status"] = status
                if status == "processing":
                    job.setdefault("first_processing_observed_seconds", clock() - start - job["submitted_offset_seconds"])
                if status in ("completed", "failed", "cancelled"):
                    job["request_seconds"] = clock() - start - job["submitted_offset_seconds"]
                    del active[task_id]
                    abort = abort or status != "completed"
            except Exception as exc:
                job.update(status="outcome_unknown", error_type=type(exc).__name__)
                del active[task_id]
                abort = True
            checkpoint()
        if active:
            pause(poll_seconds)
    report["generation_wall_seconds"] = clock() - start
    for job in report["jobs"]:
        if job["status"] != "completed":
            continue
        process_start = clock()
        try:
            raw = Path(job["raw_path"])
            result = process(raw, raw.parent / "derivatives", job["orientation"])
            job.update(status="validated", derivatives=result,
                       source_sha256=hashlib.sha256(raw.read_bytes()).hexdigest())
        except Exception as exc:
            job.update(status="invalid_output", error_type=type(exc).__name__)
        job["processing_seconds"] = clock() - process_start
        checkpoint()
    report["total_wall_seconds"] = clock() - start
    summarize(report)
    report["status"] = "completed" if report["summary"]["all_outputs_valid"] else "needs_review"
    checkpoint()
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", action="append", help="Loopback LightX2V URL; repeat for two workers")
    parser.add_argument("--checkpoint-dir", type=Path, required=True,
                        help="Immutable Hugging Face snapshot directory ending in the pinned model revision")
    parser.add_argument("--output-dir", type=Path, required=True, help="New private directory on the shared filesystem")
    parser.add_argument("--clips", type=int, default=1)
    parser.add_argument("--concurrency", type=int, choices=(1, 2), default=1)
    parser.add_argument("--timeout", type=int, default=900, help="Per-task wall seconds; includes runtime queue time")
    args = parser.parse_args()
    if not 60 <= args.timeout <= 1800:
        raise BenchmarkError("Task timeout must be 60-1800 seconds")
    checkpoint = args.checkpoint_dir.resolve(strict=True)
    if checkpoint.name != MODEL_REVISION or not (checkpoint / "config.json").is_file():
        raise BenchmarkError("Use the pinned Hugging Face cache snapshot")
    gpu_snapshot()  # Fail before submission on a machine without NVIDIA telemetry.
    servers = args.server or ["http://127.0.0.1:8001"]
    if len(set(servers)) != len(servers):
        raise BenchmarkError("Duplicate server URLs are not independent workers")
    clients = [Client(server) for server in servers]
    for client in clients:
        metadata = client.json("/v1/service/metadata")
        if metadata.get("model_cls") != "wan2.1" or Path(metadata.get("model_path", "")).resolve() != checkpoint:
            raise BenchmarkError("Runtime model does not match the selected checkpoint")
        state = client.json("/v1/service/status")
        if state.get("service_status") != "idle" or state.get("pending_tasks") != 0 or state.get("active_tasks") != []:
            raise BenchmarkError("Use an idle runtime dedicated to this benchmark")
    result = benchmark(clients, args.output_dir, clips=args.clips,
                       concurrency=args.concurrency, timeout=args.timeout)
    print(json.dumps({"report": str(args.output_dir.resolve() / "report.json"),
                      "status": result["status"], "summary": result["summary"]}))
    return 0 if result["status"] == "completed" else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (BenchmarkError, OSError, ValueError) as exc:
        print(f"Benchmark stopped: {type(exc).__name__}: {exc}")
        raise SystemExit(2)
