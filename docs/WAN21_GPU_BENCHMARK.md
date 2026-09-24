# First Wan2.1 GPU benchmark

Status: prepared and tested with a local fake HTTP server and synthetic FFmpeg
media. **No GPU inference has been run.** This benchmark uses one fixed benign
prompt, saves private local files and needs no AdBattle/Supabase credentials.

The first run is one landscape clip. After it succeeds and the entire output
has been watched, use the same settings for serial and concurrent comparisons.
The second clip in a run is portrait. There are no automatic paid calls,
downloads, rerolls, server starts or cloud rentals in the benchmark client.

## Host setup

Use the user's NVIDIA computer. First inspect `nvidia-smi`, host RAM, free disk,
driver, OS and the available CUDA/PyTorch environment. The processor requires
Linux with `renameat2`; on Windows run the server and client together inside a
Linux environment with GPU access. All workers and this client must see the
same absolute output paths. Do not expose the runtime's native API publicly.

Use these source revisions for this initial baseline:

| Component | Pinned source |
| --- | --- |
| Hugging Face model | `Wan-AI/Wan2.1-T2V-1.3B` at `37ec512624d61f7aa208f7ea8140a131f93afc9a` |
| LightX2V runtime | `ModelTC/LightX2V` at `a4b8ce30ac73ae561ec9d1a8bc6629e4aed9d2d8` |
| Startup config | [`scripts/wan21_benchmark_config.json`](../scripts/wan21_benchmark_config.json) |

The config uses the original checkpoint, 50 steps, guidance 6, shift 8,
81 frames, 16 fps, 480p, CPU offload and PyTorch SDPA attention. This provides
a baseline before selecting faster attention kernels for the actual GPU.
CPU offload can reduce GPU memory use and increase CPU/RAM/transfer work.
This is not a tuned throughput configuration and is not a four-step model.

Follow the pinned runtime's [environment setup](https://github.com/ModelTC/LightX2V/blob/a4b8ce30ac73ae561ec9d1a8bc6629e4aed9d2d8/docs/EN/source/getting_started/quickstart.md)
for the host. Record the container image digest if using Docker, `pip freeze`,
Python/PyTorch/CUDA versions, runtime commit and any local changes alongside
the report. Choose the container/driver pairing after inspecting the host.
Keep this setup outside the AdBattle application environment.

Download the exact model snapshot with the installed Hugging Face hub package:

```python
from huggingface_hub import snapshot_download
checkpoint = snapshot_download(
    repo_id="Wan-AI/Wan2.1-T2V-1.3B",
    revision="37ec512624d61f7aa208f7ea8140a131f93afc9a",
)
print(checkpoint)
```

Use that immutable cache snapshot path as `WAN21_CHECKPOINT_DIR`, the local
AdBattle checkout as `ADBATTLE_REPO`, and the pinned LightX2V checkout as
`WAN21_RUNTIME_DIR`. Start one server from its environment:

```sh
cd "$WAN21_RUNTIME_DIR"
git rev-parse HEAD
git diff --exit-code
CUDA_VISIBLE_DEVICES=0 python -m lightx2v.server \
  --model_cls wan2.1 --task t2v \
  --model_path "$WAN21_CHECKPOINT_DIR" \
  --config_json "$ADBATTLE_REPO/scripts/wan21_benchmark_config.json" \
  --host 127.0.0.1 --port 8001
```

Retain the startup log and config hash. Verify initialization succeeds with
the expected checkpoint, task and settings before sending the first job.
The server metadata endpoint exposes model class and path, but **does not
attest the runtime commit or loaded config**. The benchmark therefore labels
those fields `expected_*`; the startup evidence is needed to confirm them.
The snapshot directory name is a provenance check, not a full weights hash.

## First clip

Create a private parent directory on the shared filesystem, then choose a
new output directory under it. From the AdBattle checkout:

```sh
python3 scripts/benchmark_wan21.py \
  --checkpoint-dir "$WAN21_CHECKPOINT_DIR" \
  --output-dir /private/wan21-runs/first-clip
```

The client checks NVIDIA telemetry, model class/path and idle server state
before submitting. It supplies its own task UUID and posts to the native
`/v1/tasks/video/` route with its trailing slash. The runtime's default task
IDs are not UUIDs; a supplied ID is retained by the pinned task manager.
Redirects and identity changes fail closed. `report.json` and task paths are
saved before dispatch. A missing reply, bad state or timeout stops new
submissions and is never retried. The default per-task deadline is 900 seconds,
including queue time; the permitted range is 60–1800 seconds.

Watch the original and derivatives to assess motion, visual coherence and
style. A valid codec, duration and byte cap do not establish useful ad quality
or content approval. All reports leave human quality review pending.

## Concurrency comparison

| Run | Client settings | What it measures |
| --- | --- | --- |
| Serial baseline | One server, `--clips 2 --concurrency 1` | Two requests processed serially, including a portrait clip |
| Queued concurrency | One server, `--clips 2 --concurrency 2` | Two users in the same runtime queue; the server still runs one inference at a time |
| Parallel workers | Two independently started servers, `--clips 2 --concurrency 2 --server http://127.0.0.1:8001 --server http://127.0.0.1:8002` | Simultaneous inference processes; record whether they share one GPU or use separate GPUs |

For each run also provide `--checkpoint-dir` and a fresh `--output-dir`.
There is a hard cap of eight clips and two simultaneous client requests.
The two-server mode keeps one active task on each server. Start a second
server only after inspecting the first run's memory headroom. On one GPU,
two processes duplicate model allocations and compete for compute; they can
be slower or run out of memory. A second GPU requires its own device selection.
An out-of-memory or unknown-outcome result stops the comparison; do not count
failed clips as capacity or automatically rerun them.

## Reading the report

- `request_seconds` includes POST time, runtime queue wait and generation.
  `first_processing_observed_seconds` is a polling observation, not exact
  queue latency. Polling and telemetry add measurement overhead.
- `generation_wall_seconds` covers the generation phase; processing runs
  afterward. `total_wall_seconds` includes derivative creation. Startup/model
  loading is excluded and must be recorded separately from startup logs.
- `gpu_peak_used_mib` is sampled whole-device VRAM usage, including the loaded
  server and other GPU processes. Short peaks can be missed; this is not the
  exact allocator peak. Telemetry errors are counted explicitly.
- `clips_per_hour_in_this_run` is shown only if every requested clip validates.
  It is a small-run generation rate, including the first request; it does not
  predict sustained throughput, queue delay under load or public capacity.
- Originals, derivatives and hashes stay under the private output directory.
  There is no moderation, publishing, Storage upload or public preview here.

After interruption or timeout, keep the report and output folders. Check the
known task IDs on their recorded server before stopping or cleaning anything;
a GPU may still be writing. A new output directory creates new tasks and can
duplicate compute. The application worker also retains uncertain work folders
named with the job ID; only terminal/successful work is cleaned automatically.

## Offline verification

```sh
python3 -m unittest tests/wan21_benchmark_test.py tests/wan21_t2v_gpu_worker_test.py
```

These tests exercise a real local HTTP server, a synthetic native-size MP4,
five-second derivatives, explicit task identities, trailing-slash behavior,
two-worker routing, timeout/lost-response recovery and invalid-output handling.
They supply synthetic GPU telemetry and provide no model speed evidence.
