#!/usr/bin/env python3
"""Generate one private, silent URSA tiny video draft on a local CUDA GPU.

This staging tool does not upload, moderate, publish, or create an AdBattle ad.
Run one process at a time on the dedicated GPU. See docs/URSA_TINY_STAGING.md.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import fcntl
from fractions import Fraction
import hashlib
import json
import math
import os
from pathlib import Path
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import time

from process_video_media import VideoProcessingError, _publish_without_replacement


MODEL = "BAAI/URSA-0.6B-FSQ320"
MODEL_REVISION = "2440a09773270ad8ff1f11ba02185a48c5e9de30"
URSA_REVISION = "68ed282b0ed788cf02d0cc615ef2a8b96c855dba"
WIDTH, HEIGHT, SOURCE_FRAMES = 256, 160, 17
PREVIEW_HEIGHT = 144  # Center crop, preserving a 16:9 site preview.
FPS, PREVIEW_SECONDS = 8, 4
PREVIEW_FRAMES = FPS * PREVIEW_SECONDS
STEPS = 50
NEGATIVE_PROMPT = (
    "worst quality, low quality, inconsistent motion, static, still, "
    "blurry, jittery, distorted, ugly"
)
MAX_VIDEO_BYTES = 500 * 1024
MAX_POSTER_BYTES = 100 * 1024


class DraftError(Exception):
    """A local staging failure with a short stable code."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def pingpong_indices(frame_count: int = SOURCE_FRAMES) -> list[int]:
    """Omit duplicate endpoint frames so both the turn and seam are adjacent."""
    if frame_count != SOURCE_FRAMES:
        raise DraftError("FRAME_COUNT", "URSA tiny must decode exactly 17 frames")
    indices = list(range(frame_count)) + list(range(frame_count - 2, 0, -1))
    assert len(indices) == PREVIEW_FRAMES
    return indices


def _rgb_frames(frames) -> list[bytes]:
    import numpy as np

    video = np.asarray(frames)
    if video.shape != (SOURCE_FRAMES, HEIGHT, WIDTH, 3):
        raise DraftError("FRAME_SHAPE", "Model returned unexpected frame dimensions")
    if video.dtype != np.uint8:
        if not np.issubdtype(video.dtype, np.floating) or not np.isfinite(video).all() or \
                video.min() < 0 or video.max() > 1:
            raise DraftError("FRAME_FORMAT", "Model returned unsupported pixel values")
        video = np.rint(video * 255).astype(np.uint8)
    return [np.ascontiguousarray(frame).tobytes() for frame in video]


def _ffmpeg(input_bytes: bytes, destination: Path, *, frames: int, codec: str,
            crop: bool = False) -> None:
    command = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{WIDTH}x{HEIGHT}",
        "-r", str(FPS), "-i", "pipe:0", "-an", "-sn", "-dn",
        "-map_metadata", "-1", "-frames:v", str(frames),
    ]
    if crop:
        command += ["-vf", f"crop={WIDTH}:{PREVIEW_HEIGHT}:0:{(HEIGHT - PREVIEW_HEIGHT) // 2}"]
    if codec == "video":
        command += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
                    "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4"]
    else:
        command += ["-c:v", "mjpeg", "-q:v", "5", "-f", "image2"]
    try:
        result = subprocess.run(command + [str(destination)], input=input_bytes,
                                capture_output=True, timeout=45, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise DraftError("ENCODE_FAILED", "FFmpeg unavailable or timed out") from exc
    if result.returncode:
        raise DraftError("ENCODE_FAILED", "FFmpeg rejected generated frames")


def _verify(path: Path, *, frames: int, codec: str) -> int:
    try:
        result = subprocess.run([
            "ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path),
        ], capture_output=True, timeout=15, check=True)
        info = json.loads(result.stdout)
        streams = info["streams"]
        stream = streams[0]
        expected_height = HEIGHT if path.name == "source.mp4" else PREVIEW_HEIGHT
        if len(streams) != 1 or stream["codec_name"] != ("h264" if codec == "video" else "mjpeg") or \
                (stream["width"], stream["height"]) != (WIDTH, expected_height):
            raise ValueError("unexpected stream")
        if codec == "video" and (int(stream["nb_frames"]) != frames or
                                  stream["pix_fmt"] != "yuv420p" or
                                  Fraction(stream["avg_frame_rate"]) != FPS or
                                  abs(float(stream["duration"]) - frames / FPS) > 0.01):
            raise ValueError("unexpected video timing")
        size = path.stat().st_size
        if not 0 < size <= (MAX_VIDEO_BYTES if codec == "video" else MAX_POSTER_BYTES):
            raise ValueError("output exceeds size cap")
        return size
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, IndexError,
            TypeError, ZeroDivisionError) as exc:
        raise DraftError("INVALID_OUTPUT", "Encoded output failed media validation") from exc


def write_private_draft(frames, output_dir: Path, *, seed: int, generation_s: float) -> dict:
    """Atomically publish source, forward/back preview and poster to a private dir."""
    rgb = _rgb_frames(frames)
    output_dir = Path(output_dir)
    try:
        parent = output_dir.parent.resolve(strict=True)
    except OSError as exc:
        raise DraftError("OUTPUT_PARENT", "Output parent must already exist") from exc
    if not parent.is_dir() or output_dir.name in ("", ".", ".."):
        raise DraftError("OUTPUT_PARENT", "Invalid output directory")
    destination = parent / output_dir.name
    if destination.exists():
        raise DraftError("OUTPUT_EXISTS", "Output directory already exists")
    with tempfile.TemporaryDirectory(prefix=".adbattle-ursa-", dir=parent) as temporary:
        stage = Path(temporary)
        source, preview, poster = (stage / name for name in
                                   ("source.mp4", "preview.mp4", "poster.jpg"))
        _ffmpeg(b"".join(rgb), source, frames=SOURCE_FRAMES, codec="video")
        _ffmpeg(b"".join(rgb[i] for i in pingpong_indices()), preview,
                frames=PREVIEW_FRAMES, codec="video", crop=True)
        _ffmpeg(rgb[0], poster, frames=1, codec="poster", crop=True)
        sizes = {
            "source.mp4": _verify(source, frames=SOURCE_FRAMES, codec="video"),
            "preview.mp4": _verify(preview, frames=PREVIEW_FRAMES, codec="video"),
            "poster.jpg": _verify(poster, frames=1, codec="poster"),
        }
        manifest = {
            "model": MODEL, "model_revision": MODEL_REVISION, "ursa_revision": URSA_REVISION,
            "width": WIDTH, "height": HEIGHT, "preview_width": WIDTH,
            "preview_height": PREVIEW_HEIGHT, "source_frames": SOURCE_FRAMES,
            "preview_frames": PREVIEW_FRAMES, "preview_fps": FPS,
            "preview_seconds": PREVIEW_SECONDS, "loop": "forward_then_reverse_without_endpoints",
            "steps": STEPS, "seed": seed, "generation_s": round(generation_s, 3),
            "files": {name: {"bytes": size,
                             "sha256": hashlib.sha256((stage / name).read_bytes()).hexdigest()}
                      for name, size in sizes.items()},
        }
        (stage / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        try:
            _publish_without_replacement(stage, destination)
        except VideoProcessingError as exc:
            raise DraftError(exc.code, str(exc)) from exc
    return {"output_dir": str(destination), **manifest}


@contextmanager
def single_gpu_slot(state_dir: Path, wait_seconds: float):
    """Coordinate separate local invocations before either loads a CUDA model."""
    state_dir = Path(state_dir)
    try:
        state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        metadata = state_dir.lstat()
    except OSError as exc:
        raise DraftError("UNSAFE_STATE_DIR", "Could not create private GPU lock directory") from exc
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid() or \
            metadata.st_mode & 0o077:
        raise DraftError("UNSAFE_STATE_DIR", "GPU lock directory must be private and owned by you")
    try:
        fd = os.open(state_dir / "cuda0.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    except OSError as exc:
        raise DraftError("GPU_LOCK", "Could not open private GPU lock") from exc
    try:
        deadline = time.monotonic() + wait_seconds
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise DraftError("GPU_BUSY", "Another URSA staging generation owns the GPU")
                time.sleep(min(0.2, max(0, deadline - time.monotonic())))
        yield
    finally:
        os.close(fd)


def generate(prompt: str, output_dir: Path, *, seed: int, state_dir: Path,
             wait_seconds: float) -> dict:
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise DraftError("MISSING_MEDIA_TOOLS", "FFmpeg and ffprobe are required")
    # Pin to the exact dependency pair used for the successful RTX 5090 run.
    try:
        import torch
        import diffusers
        import transformers
        from diffnext.pipelines import URSAPipeline
    except ImportError as exc:
        raise DraftError("MISSING_GPU_DEPENDENCY", "Install the tested GPU environment") from exc
    if (transformers.__version__, diffusers.__version__) != ("4.57.1", "0.35.2"):
        raise DraftError("DEPENDENCY_VERSION", "Use transformers 4.57.1 and diffusers 0.35.2")
    if not torch.cuda.is_available():
        raise DraftError("NO_CUDA", "A CUDA GPU is required")
    with single_gpu_slot(state_dir, wait_seconds):
        device = torch.device("cuda:0")
        try:
            pipe = URSAPipeline.from_pretrained(
                MODEL, revision=MODEL_REVISION, torch_dtype=torch.float16, trust_remote_code=True
            ).to(device)
            if pipe.vae_temporal_stride != 4 or pipe.vae_spatial_stride != 8:
                raise DraftError("MODEL_STRIDE", "Pinned model tokenizer stride changed")
            torch.cuda.synchronize(device)
            started = time.perf_counter()
            frames = pipe(prompt=f"motion=9.0, {prompt}", negative_prompt=NEGATIVE_PROMPT,
                          width=WIDTH, height=HEIGHT, num_frames=SOURCE_FRAMES,
                          num_inference_steps=STEPS,
                          generator=torch.Generator(device=device).manual_seed(seed),
                          output_type="np").frames[0]
            torch.cuda.synchronize(device)
        except DraftError:
            raise
        except Exception as exc:
            raise DraftError("GENERATION_FAILED", "Pinned model load or inference failed") from exc
        return write_private_draft(frames, output_dir, seed=seed,
                                   generation_s=time.perf_counter() - started)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prompt-file", required=True, type=Path,
                        help="Private UTF-8 file containing one local creative prompt")
    parser.add_argument("--output-dir", required=True, type=Path,
                        help="New, private output directory; its parent must already exist")
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--state-dir", type=Path,
                        default=Path.home() / ".local/state/adbattle-ursa")
    parser.add_argument("--wait-seconds", type=float, default=600)
    args = parser.parse_args()
    if not math.isfinite(args.wait_seconds) or not 0 <= args.wait_seconds <= 3600 or \
            not 0 <= (args.seed or 0) < 2**31:
        parser.error("wait-seconds must be 0..3600 and seed must be 0..2147483647")
    try:
        with args.prompt_file.open("rb") as file:
            raw = file.read(2401)
        if len(raw) > 2400:
            parser.error("Prompt file is too large")
        prompt = raw.decode("utf-8").strip()
    except (OSError, UnicodeError) as exc:
        parser.error(f"Cannot read prompt file: {type(exc).__name__}")
    if not 12 <= len(prompt) <= 600 or any(ord(char) < 32 for char in prompt):
        parser.error("Prompt must be 12..600 characters of plain text")
    try:
        result = generate(prompt, args.output_dir,
                          seed=args.seed if args.seed is not None else secrets.randbelow(2**31),
                          state_dir=args.state_dir, wait_seconds=args.wait_seconds)
    except DraftError as exc:
        print(f"{exc.code}: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
