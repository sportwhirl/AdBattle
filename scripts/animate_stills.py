#!/usr/bin/env python3
"""Animate one or two already-approved stills locally into bounded video files.

The caller must verify approval and rights; this script only processes pixels.
No provider, upload, moderation, or publication is performed here.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
from typing import Sequence

from process_video_media import (DIMENSIONS, MAX_INPUT_BYTES, VideoProcessingError,
                                 process_video)


MAX_STILL_BYTES = 10 * 1024 * 1024
MAX_STILL_PIXELS = 2048 * 2048
MAX_SIDE = 2048
MIN_SIDE = 360
FRAMES = 120
FPS = 24
MOTIONS = ("zoom-in", "zoom-out", "drift-left", "drift-right", "hold")
TRANSITIONS = ("dissolve", "cut")
MATTES = {"light": "0xF3F2EB", "dark": "0x191C21"}


def _run(command: list[str], *, inspect: bool = False, timeout: int = 120) -> bytes:
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE if inspect else subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise VideoProcessingError("MEDIA_TOOL_FAILED", "Media tool unavailable or timed out") from exc
    if result.returncode != 0:
        raise VideoProcessingError("INVALID_STILL" if inspect else "MEDIA_TOOL_FAILED",
                                   "Media tool rejected a still or animation")
    return result.stdout if inspect else b""


def _snapshot_still(source: Path, stage: Path, index: int) -> Path:
    try:
        mode = source.lstat().st_mode
        if stat.S_ISLNK(mode):
            raise VideoProcessingError("UNSAFE_PATH", "A still cannot be a symbolic link")
        if not stat.S_ISREG(mode):
            raise VideoProcessingError("INVALID_STILL", "Still must be a regular file")
        fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    except OSError as exc:
        raise VideoProcessingError("INVALID_STILL", "Cannot read still") from exc
    try:
        with os.fdopen(fd, "rb") as original:
            info = os.fstat(original.fileno())
            if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_STILL_BYTES:
                raise VideoProcessingError("STILL_SIZE", "Still must be at most 10 MiB")
            header = original.read(12)
            if header.startswith(b"\x89PNG\r\n\x1a\n"):
                extension = "png"
            elif header.startswith(b"\xff\xd8\xff"):
                extension = "jpg"
            else:
                raise VideoProcessingError("UNSUPPORTED_STILL", "Still must be PNG or JPEG")
            destination = stage / f"still-{index}.{extension}"
            original.seek(0)
            with destination.open("xb") as output:
                count = 0
                while chunk := original.read(1024 * 1024):
                    count += len(chunk)
                    if count > MAX_STILL_BYTES:
                        raise VideoProcessingError("STILL_SIZE", "Still exceeds 10 MiB")
                    output.write(chunk)
            if count != info.st_size:
                raise VideoProcessingError("INVALID_STILL", "Still changed while being read")
            return destination
    except OSError as exc:
        raise VideoProcessingError("INVALID_STILL", "Cannot copy still") from exc


def _validate_still(path: Path, expected_codec: str) -> None:
    raw = _run([
        "ffprobe", "-v", "error", "-protocol_whitelist", "file",
        "-count_frames", "-show_entries",
        "stream=codec_name,codec_type,width,height,nb_read_frames,sample_aspect_ratio",
        "-show_streams", "-of", "json", str(path),
    ], inspect=True, timeout=30)
    try:
        streams = json.loads(raw)["streams"]
        if len(streams) != 1:
            raise ValueError("Wrong stream count")
        video = streams[0]
        width, height = int(video["width"]), int(video["height"])
        frames = int(video["nb_read_frames"])
    except (KeyError, TypeError, ValueError) as exc:
        raise VideoProcessingError("INVALID_STILL", "Cannot inspect still") from exc
    if video.get("codec_type") != "video" or video.get("codec_name") != expected_codec or frames != 1:
        raise VideoProcessingError("UNSUPPORTED_STILL", "Still must be one JPEG or PNG frame")
    if (min(width, height) < MIN_SIDE or max(width, height) > MAX_SIDE
            or width * height > MAX_STILL_PIXELS):
        raise VideoProcessingError("STILL_DIMENSIONS", "Still dimensions are outside limits")
    if video.get("sample_aspect_ratio") not in (None, "N/A", "1:1"):
        raise VideoProcessingError("STILL_DIMENSIONS", "Still must use square pixels")
    _run([
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-xerror", "-err_detect", "explode", "-threads", "2",
        "-protocol_whitelist", "file", "-i", str(path),
        "-frames:v", "1", "-f", "null", "-",
    ], timeout=45)


def _motion_filter(motion: str, frames: int) -> str:
    last = frames - 1
    if motion == "zoom-in":
        zoom, x = f"1+0.035*on/{last}", "(iw-iw/zoom)/2"
    elif motion == "zoom-out":
        zoom, x = f"1.035-0.035*on/{last}", "(iw-iw/zoom)/2"
    elif motion == "drift-left":
        zoom, x = "1.03", f"(iw-iw/zoom)*(1-on/{last})"
    elif motion == "drift-right":
        zoom, x = "1.03", f"(iw-iw/zoom)*on/{last}"
    else:
        zoom, x = "1", "0"
    return f"zoompan=z='{zoom}':x='{x}':y='(ih-ih/zoom)/2':d={frames}:fps={FPS}"


def _render(stills: list[Path], destination: Path, orientation: str,
            motion: str, transition: str, matte: str) -> None:
    width, height = DIMENSIONS[orientation]
    two = len(stills) == 2
    frames_per_image = 72 if two and transition == "dissolve" else 60 if two else FRAMES
    filters = []
    for index in range(len(stills)):
        filters.append(
            f"[{index}:v]scale={width * 9 // 10}:{height * 9 // 10}:"
            "force_original_aspect_ratio=decrease:flags=lanczos,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color={MATTES[matte]},"
            f"setsar=1,{_motion_filter(motion, frames_per_image)}:s={width}x{height},"
            f"format=yuv420p[v{index}]"
        )
    if two:
        filters.append("[v0][v1]xfade=transition=fade:duration=1:offset=2[v]"
                       if transition == "dissolve" else "[v0][v1]concat=n=2:v=1:a=0[v]")
        output_label = "[v]"
    else:
        output_label = "[v0]"
    command = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
               "-xerror", "-err_detect", "explode", "-threads", "2"]
    for still in stills:
        command += ["-protocol_whitelist", "file", "-i", str(still)]
    command += [
        "-filter_complex_threads", "1", "-filter_complex", ";".join(filters),
        "-map", output_label, "-an", "-sn", "-dn",
        "-map_metadata", "-1", "-map_metadata:s:v:0", "-1", "-map_chapters", "-1",
        "-frames:v", str(FRAMES), "-c:v", "libx264", "-preset", "medium",
        "-crf", "26", "-maxrate", "2200k", "-bufsize", "2200k",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4",
        str(destination),
    ]
    _run(command, timeout=120)
    if destination.stat().st_size > MAX_INPUT_BYTES:
        raise VideoProcessingError("OUTPUT_SIZE", "Animation intermediate exceeds 30 MiB")


def animate_stills(stills: Sequence[Path], output_dir: Path, *, orientation: str,
                   motion: str = "zoom-in", transition: str = "dissolve",
                   matte: str = "light") -> dict:
    """Create media derivatives from one or two already-reviewed local stills."""
    if not 1 <= len(stills) <= 2:
        raise VideoProcessingError("STILL_COUNT", "Provide one or two stills")
    if orientation not in DIMENSIONS or motion not in MOTIONS or transition not in TRANSITIONS or matte not in MATTES:
        raise VideoProcessingError("INVALID_OPTION", "Unsupported orientation, motion, transition, or matte")
    output_dir = Path(output_dir)
    try:
        parent = output_dir.parent.resolve(strict=True)
    except OSError as exc:
        raise VideoProcessingError("UNSAFE_PATH", "Output parent must exist") from exc
    if not parent.is_dir() or output_dir.name in ("", ".", ".."):
        raise VideoProcessingError("UNSAFE_PATH", "Output parent must be a directory")
    final = parent / output_dir.name
    if os.path.lexists(final):
        raise VideoProcessingError("OUTPUT_EXISTS", "Output directory already exists")
    try:
        stage = Path(tempfile.mkdtemp(prefix=".adbattle-animation-", dir=parent))
    except OSError as exc:
        raise VideoProcessingError("IO_ERROR", "Cannot create temporary directory") from exc
    try:
        snapshots = []
        hashes = []
        for index, source in enumerate(stills, start=1):
            snapshot = _snapshot_still(Path(source), stage, index)
            _validate_still(snapshot, "png" if snapshot.suffix == ".png" else "mjpeg")
            snapshots.append(snapshot)
            hashes.append(hashlib.sha256(snapshot.read_bytes()).hexdigest())
        intermediate = stage / "animation.mp4"
        _render(snapshots, intermediate, orientation, motion, transition, matte)
        result = process_video(intermediate, final, orientation)
        result.update({"source_count": len(stills), "source_sha256": hashes,
                       "motion": motion, "transition": transition if len(stills) == 2 else None,
                       "matte": matte})
        return result
    except OSError as exc:
        raise VideoProcessingError("IO_ERROR", "Cannot read or write animation files") from exc
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stills", nargs="+", type=Path, help="One or two approved PNG/JPEG stills")
    parser.add_argument("--output-dir", required=True, type=Path, help="New output directory")
    parser.add_argument("--orientation", required=True, choices=tuple(DIMENSIONS))
    parser.add_argument("--motion", choices=MOTIONS, default="zoom-in")
    parser.add_argument("--transition", choices=TRANSITIONS, default="dissolve")
    parser.add_argument("--matte", choices=tuple(MATTES), default="light")
    args = parser.parse_args()
    try:
        print(json.dumps(animate_stills(args.stills, args.output_dir, orientation=args.orientation,
                                        motion=args.motion, transition=args.transition, matte=args.matte)))
    except VideoProcessingError as exc:
        print(f"{exc.code}: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
