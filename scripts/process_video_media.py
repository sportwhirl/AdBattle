#!/usr/bin/env python3
"""Validate a generated audiovisual MP4 and publish bounded derivatives.

This is an offline media processor, not a content moderation or publishing step.
It needs Python 3, ffmpeg, ffprobe, and Linux renameat2(2).
"""

from __future__ import annotations

import argparse
from array import array
import ctypes
import errno
from fractions import Fraction
import json
import math
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile


MAX_INPUT_BYTES = 30 * 1024 * 1024
MAX_FULL_BYTES = 5 * 1024 * 1024
MAX_HOVER_BYTES = 500 * 1024
MAX_POSTER_BYTES = 100 * 1024
MIN_DURATION = 8.0
MAX_DURATION = 12.0
HOVER_SECONDS = 4
HOVER_FPS = 13
FULL_SECONDS = 10
FULL_FPS = 24
MAX_INPUT_PIXELS = 1920 * 1080
MAX_INPUT_FPS = 60
DIMENSIONS = {"landscape": (640, 360), "portrait": (360, 640)}
OUTPUT_NAMES = ("full.mp4", "hover.mp4", "poster.jpg")
INPUT_AUDIO_CODEC = "aac"
FULL_AUDIO_CODEC = "aac"
FULL_AUDIO_SAMPLE_RATE = 48_000
FULL_AUDIO_CHANNELS = 2
FULL_AUDIO_BITRATE = "64k"
FULL_AUDIO_FILTER = "apad=pad_dur=2,loudnorm=I=-16:LRA=11:TP=-1.5"
AUDIBILITY_SAMPLE_RATE = 8_000
AUDIBILITY_WINDOW_SAMPLES = 800
AUDIBILITY_MIN_WINDOWS = 5
AUDIBILITY_MIN_WINDOW_RMS = 16.0
AUDIBILITY_MIN_PEAK = 64


class VideoProcessingError(Exception):
    """A bounded, user-safe error from processing an untrusted input."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _run(command: list[str], *, timeout: int = 90) -> bytes:
    try:
        result = subprocess.run(
            command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=timeout, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise VideoProcessingError("MEDIA_TOOL_FAILED", "Media tool unavailable or timed out") from exc
    if result.returncode != 0:
        raise VideoProcessingError("MEDIA_TOOL_FAILED", "Media tool rejected the video")
    return result.stdout


def _probe(path: Path) -> dict:
    output = _run([
        "ffprobe", "-v", "error", "-protocol_whitelist", "file",
        "-enable_drefs", "0", "-use_absolute_path", "0",
        "-show_entries", "format=format_name,duration:format_tags=title,comment,artist,creation_time"
        ":stream=index,codec_type,codec_name,width,height,pix_fmt,sample_aspect_ratio,"
        "duration,start_time,avg_frame_rate,sample_rate,channels,channel_layout:"
        "stream_tags=title,comment,artist,creation_time,handler_name",
        "-show_format", "-show_streams", "-of", "json", str(path),
    ], timeout=30)
    try:
        return json.loads(output)
    except (ValueError, UnicodeError) as exc:
        raise VideoProcessingError("INVALID_MEDIA", "Could not inspect the video") from exc


def _number(value: object, label: str) -> float:
    try:
        number = float(value)
        if not (0 <= number < float("inf")):
            raise ValueError()
        return number
    except (TypeError, ValueError) as exc:
        raise VideoProcessingError("INVALID_MEDIA", f"Invalid {label}") from exc


def _video_stream(probe: dict, *, only_stream: bool = False) -> dict:
    streams = probe.get("streams", [])
    if not isinstance(streams, list):
        raise VideoProcessingError("INVALID_MEDIA", "Invalid media streams")
    videos = [stream for stream in streams if stream.get("codec_type") == "video"]
    if len(videos) != 1 or (only_stream and len(streams) != 1):
        raise VideoProcessingError("INVALID_MEDIA", "Expected exactly one video stream")
    video = videos[0]
    if video.get("codec_name") != "h264":
        raise VideoProcessingError("UNSUPPORTED_CODEC", "Video must be H.264")
    return video


def _audio_stream(probe: dict, *, require_exact_pair: bool = False) -> dict:
    streams = probe.get("streams", [])
    if not isinstance(streams, list):
        raise VideoProcessingError("INVALID_MEDIA", "Invalid media streams")
    audios = [stream for stream in streams if stream.get("codec_type") == "audio"]
    if len(audios) != 1 or (require_exact_pair and len(streams) != 2):
        raise VideoProcessingError("INVALID_MEDIA", "Expected exactly one audio stream")
    return audios[0]


def _check_input(probe: dict, orientation: str) -> float:
    fmt = probe.get("format", {})
    if "mp4" not in fmt.get("format_name", "").split(","):
        raise VideoProcessingError("UNSUPPORTED_CONTAINER", "Video must be MP4")
    video = _video_stream(probe)
    try:
        width, height = int(video["width"]), int(video["height"])
        frame_rate = Fraction(video["avg_frame_rate"])
    except (KeyError, TypeError, ValueError, ZeroDivisionError) as exc:
        raise VideoProcessingError("INVALID_MEDIA", "Invalid video dimensions or frame rate") from exc
    if not (12 <= frame_rate <= MAX_INPUT_FPS):
        raise VideoProcessingError("INVALID_MEDIA", "Input frame rate must be 12–60 fps")
    if width < 1 or height < 1 or width * height > MAX_INPUT_PIXELS:
        raise VideoProcessingError("INVALID_MEDIA", "Input dimensions exceed limit")
    target_width, target_height = DIMENSIONS[orientation]
    if min(width, height) < 360 or abs(width / height - target_width / target_height) > 0.01:
        raise VideoProcessingError("WRONG_ASPECT", "Input must match the requested 16:9 or 9:16 shape")
    if video.get("sample_aspect_ratio") not in (None, "N/A", "1:1"):
        raise VideoProcessingError("WRONG_ASPECT", "Input must use square pixels")
    duration = _number(video.get("duration"), "video stream duration")
    if not MIN_DURATION <= duration <= MAX_DURATION:
        raise VideoProcessingError("WRONG_DURATION", "Video must be between 8 and 12 seconds")
    # A late starting video can have an apparently valid container duration while
    # providing fewer actual seconds of video for the 4-second hover.
    if _number(video.get("start_time", 0), "start time") > 0.1:
        raise VideoProcessingError("INVALID_MEDIA", "Video must start near zero")
    audio = _audio_stream(probe, require_exact_pair=True)
    if audio.get("codec_name") != INPUT_AUDIO_CODEC:
        raise VideoProcessingError("UNSUPPORTED_AUDIO_CODEC", "Audio must be AAC")
    try:
        sample_rate = int(audio["sample_rate"])
        channels = int(audio["channels"])
    except (KeyError, TypeError, ValueError) as exc:
        raise VideoProcessingError("INVALID_MEDIA", "Invalid audio format") from exc
    if not 8_000 <= sample_rate <= 96_000 or channels not in (1, 2):
        raise VideoProcessingError("INVALID_MEDIA", "Audio must be mono or stereo at 8–96 kHz")
    audio_duration = _number(audio.get("duration"), "audio stream duration")
    if abs(audio_duration - duration) > 0.5:
        raise VideoProcessingError("WRONG_DURATION", "Audio and video durations must match")
    if _number(audio.get("start_time", 0), "audio start time") > 0.1:
        raise VideoProcessingError("INVALID_MEDIA", "Audio must start near zero")
    return duration


def _check_audio_audible(path: Path) -> None:
    """Reject empty/effectively silent tracks before padding or normalization."""
    pcm = _run([
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-xerror", "-err_detect", "explode", "-threads", "1",
        "-protocol_whitelist", "file", "-enable_drefs", "0",
        "-use_absolute_path", "0", "-i", str(path),
        "-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "1",
        "-ar", str(AUDIBILITY_SAMPLE_RATE), "-t", str(MAX_DURATION),
        "-c:a", "pcm_s16le", "-f", "s16le", "-",
    ], timeout=30)
    if not pcm or len(pcm) % 2:
        raise VideoProcessingError("INVALID_MEDIA", "Could not decode generated audio")
    samples = array("h")
    samples.frombytes(pcm)
    if sys.byteorder != "little":
        samples.byteswap()
    peak = max(abs(sample) for sample in samples)
    audible_windows = 0
    for start in range(0, len(samples), AUDIBILITY_WINDOW_SAMPLES):
        window = samples[start:start + AUDIBILITY_WINDOW_SAMPLES]
        if len(window) < AUDIBILITY_WINDOW_SAMPLES:
            break
        rms = math.sqrt(sum(sample * sample for sample in window) / len(window))
        if rms >= AUDIBILITY_MIN_WINDOW_RMS:
            audible_windows += 1
    if peak < AUDIBILITY_MIN_PEAK or audible_windows < AUDIBILITY_MIN_WINDOWS:
        raise VideoProcessingError("SILENT_AUDIO", "Generated soundtrack is silent")


def _snapshot_input(source: Path, stage: Path) -> Path:
    try:
        mode = source.lstat().st_mode
        if stat.S_ISLNK(mode):
            raise VideoProcessingError("UNSAFE_PATH", "Input cannot be a symbolic link")
        if not stat.S_ISREG(mode):
            raise VideoProcessingError("INVALID_INPUT", "Input must be a regular file")
        fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    except (OSError, ValueError) as exc:
        raise VideoProcessingError("INVALID_INPUT", "Cannot read input video") from exc
    copied = stage / "source.mp4"
    try:
        with os.fdopen(fd, "rb") as source_file:
            info = os.fstat(source_file.fileno())
            if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_INPUT_BYTES:
                raise VideoProcessingError("INPUT_SIZE", "Input must be a regular file of at most 30 MiB")
            with copied.open("xb") as destination:
                count = 0
                while chunk := source_file.read(1024 * 1024):
                    count += len(chunk)
                    if count > MAX_INPUT_BYTES:
                        raise VideoProcessingError("INPUT_SIZE", "Input exceeds 30 MiB")
                    destination.write(chunk)
            if count != info.st_size:
                raise VideoProcessingError("INVALID_INPUT", "Input changed while being read")
    except OSError as exc:
        raise VideoProcessingError("INVALID_INPUT", "Cannot copy input video") from exc
    # MP4 requires a box size followed by an ftyp box. This rejects accidental
    # MOV, GIF, playlists and image files even if a demuxer accepts them.
    with copied.open("rb") as file:
        header = file.read(12)
    if len(header) < 12 or header[4:8] != b"ftyp" or int.from_bytes(header[:4], "big") < 12:
        raise VideoProcessingError("UNSUPPORTED_CONTAINER", "Input must be an MP4 file")
    return copied


def _check_size(path: Path, maximum: int) -> int:
    size = path.stat().st_size
    if size < 1 or size > maximum:
        raise VideoProcessingError("OUTPUT_SIZE", f"{path.name} exceeds its size cap")
    return size


def _encode_video(source: Path, destination: Path, orientation: str, *, hover: bool) -> None:
    width, height = DIMENSIONS[orientation]
    fps = HOVER_FPS if hover else FULL_FPS
    # tpad extends the final frame when a source is shorter than ten seconds.
    # Sources longer than ten seconds are trimmed by the fixed frame count.
    filters = f"scale={width}:{height}:flags=lanczos,setsar=1,fps={fps}"
    if not hover:
        filters += ",tpad=stop_mode=clone:stop_duration=2"
    command = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-xerror", "-err_detect", "explode", "-threads", "2",
        "-protocol_whitelist", "file", "-enable_drefs", "0",
        "-use_absolute_path", "0", "-i", str(source),
        "-map", "0:v:0",
    ]
    if hover:
        command += ["-an"]
    else:
        command += ["-map", "0:a:0"]
    command += [
        "-sn", "-dn", "-map_metadata", "-1", "-map_metadata:s:v:0", "-1",
        "-map_metadata:s:a:0", "-1", "-map_chapters", "-1",
        "-vf", filters,
        "-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p",
        "-crf", "29" if hover else "26",
        "-maxrate", "480k" if hover else "2400k",
        "-bufsize", "480k" if hover else "2400k",
        "-movflags", "+faststart",
    ]
    if not hover:
        # Preserve the generated soundtrack in the full clip. A short source is
        # padded with silence in lockstep with the final held video frame.
        command += ["-af", FULL_AUDIO_FILTER, "-c:a", FULL_AUDIO_CODEC,
                    "-b:a", FULL_AUDIO_BITRATE, "-ar", str(FULL_AUDIO_SAMPLE_RATE),
                    "-ac", str(FULL_AUDIO_CHANNELS)]
    command += ["-frames:v", str(HOVER_SECONDS * HOVER_FPS if hover else FULL_SECONDS * FULL_FPS)]
    if not hover:
        command += ["-t", str(FULL_SECONDS)]
    command += ["-f", "mp4", str(destination)]
    _run(command, timeout=120)


def _make_poster(source: Path, destination: Path, orientation: str) -> None:
    width, height = DIMENSIONS[orientation]
    for quality in (5, 10, 17, 25, 31):
        destination.unlink(missing_ok=True)
        _run([
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
            "-xerror", "-err_detect", "explode", "-threads", "2",
            "-protocol_whitelist", "file", "-enable_drefs", "0",
            "-use_absolute_path", "0", "-ss", "0.5", "-i", str(source),
            "-map", "0:v:0", "-an", "-sn", "-dn", "-map_metadata", "-1",
            "-map_metadata:s:v:0", "-1", "-map_chapters", "-1", "-frames:v", "1",
            "-vf", f"scale={width}:{height}:flags=lanczos,setsar=1",
            "-q:v", str(quality), "-f", "image2", str(destination),
        ], timeout=60)
        if 0 < destination.stat().st_size <= MAX_POSTER_BYTES:
            return
    raise VideoProcessingError("OUTPUT_SIZE", "poster.jpg exceeds its size cap")


def _verify_video(path: Path, orientation: str, *, hover: bool) -> None:
    probe = _probe(path)
    if "mp4" not in probe.get("format", {}).get("format_name", "").split(","):
        raise VideoProcessingError("INVALID_OUTPUT", "Output must be MP4")
    video = _video_stream(probe, only_stream=hover)
    if tuple(video.get(dimension) for dimension in ("width", "height")) != DIMENSIONS[orientation]:
        raise VideoProcessingError("INVALID_OUTPUT", "Output dimensions do not match 360p")
    if video.get("pix_fmt") != "yuv420p":
        raise VideoProcessingError("INVALID_OUTPUT", "Output pixel format is unsupported")
    expected_fps = HOVER_FPS if hover else FULL_FPS
    try:
        if Fraction(video["avg_frame_rate"]) != expected_fps:
            raise VideoProcessingError("INVALID_OUTPUT", "Output frame rate does not match target")
    except (KeyError, ValueError, ZeroDivisionError) as exc:
        raise VideoProcessingError("INVALID_OUTPUT", "Output frame rate is invalid") from exc
    actual_duration = _number(video.get("duration", probe.get("format", {}).get("duration")), "output duration")
    expected = HOVER_SECONDS if hover else FULL_SECONDS
    if abs(actual_duration - expected) > 0.15:
        raise VideoProcessingError("INVALID_OUTPUT", "Output duration does not match input")
    if not hover:
        try:
            audio = _audio_stream(probe, require_exact_pair=True)
            sample_rate = int(audio["sample_rate"])
            channels = int(audio["channels"])
        except (KeyError, TypeError, ValueError) as exc:
            raise VideoProcessingError("INVALID_OUTPUT", "Output audio format is invalid") from exc
        if audio.get("codec_name") != FULL_AUDIO_CODEC or sample_rate != FULL_AUDIO_SAMPLE_RATE or \
                channels != FULL_AUDIO_CHANNELS:
            raise VideoProcessingError("INVALID_OUTPUT", "Output audio does not match target")
        if _number(video.get("start_time", 0), "output video start time") > 0.1 or \
                _number(audio.get("start_time", 0), "output audio start time") > 0.1:
            raise VideoProcessingError("INVALID_OUTPUT", "Output audio and video must start near zero")
        audio_duration = _number(audio.get("duration", probe.get("format", {}).get("duration")),
                                 "output audio duration")
        if abs(audio_duration - FULL_SECONDS) > 0.15:
            raise VideoProcessingError("INVALID_OUTPUT", "Output audio duration does not match target")


def _verify_poster(path: Path, orientation: str) -> None:
    probe = _probe(path)
    streams = probe.get("streams", [])
    if len(streams) != 1 or streams[0].get("codec_name") != "mjpeg":
        raise VideoProcessingError("INVALID_OUTPUT", "Poster is not a JPEG image")
    if tuple(streams[0].get(key) for key in ("width", "height")) != DIMENSIONS[orientation]:
        raise VideoProcessingError("INVALID_OUTPUT", "Poster dimensions do not match 360p")


def _publish_without_replacement(stage: Path, destination: Path) -> None:
    # Linux renameat2 with RENAME_NOREPLACE publishes all three files in one
    # directory operation and refuses a destination created by another worker.
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None:
        raise VideoProcessingError("UNSUPPORTED_SYSTEM", "Atomic no-replace publish requires Linux")
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    if renameat2(-100, os.fsencode(stage), -100, os.fsencode(destination), 1) != 0:
        code = ctypes.get_errno()
        if code == errno.EEXIST:
            raise VideoProcessingError("OUTPUT_EXISTS", "Output directory already exists")
        raise VideoProcessingError("PUBLISH_FAILED", "Cannot publish processed video")


def process_video(source: Path, output_dir: Path, orientation: str) -> dict:
    """Return sizes and paths after validating and atomically publishing outputs.

    ``output_dir`` must not already exist. Every failure removes staging files;
    the source is never modified. Caller owns moderation and later publication.
    """
    if orientation not in DIMENSIONS:
        raise VideoProcessingError("WRONG_ORIENTATION", "Choose landscape or portrait")
    source, output_dir = Path(source), Path(output_dir)
    try:
        parent = output_dir.parent.resolve(strict=True)
    except OSError as exc:
        raise VideoProcessingError("UNSAFE_PATH", "Output parent must exist") from exc
    if not parent.is_dir() or output_dir.name in ("", ".", ".."):
        raise VideoProcessingError("UNSAFE_PATH", "Output parent must be a directory")
    destination = parent / output_dir.name
    if os.path.lexists(destination):
        raise VideoProcessingError("OUTPUT_EXISTS", "Output directory already exists")
    try:
        stage = Path(tempfile.mkdtemp(prefix=".adbattle-video-", dir=parent))
    except OSError as exc:
        raise VideoProcessingError("IO_ERROR", "Cannot create temporary output directory") from exc
    try:
        snapshot = _snapshot_input(source, stage)
        metadata = _probe(snapshot)
        duration = _check_input(metadata, orientation)
        _check_audio_audible(snapshot)
        # Decode every video frame and audio sample before publishing, catching
        # files whose header probes successfully but whose payload is broken.
        _run([
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
            "-xerror", "-err_detect", "explode", "-threads", "2",
            "-protocol_whitelist", "file", "-enable_drefs", "0",
            "-use_absolute_path", "0", "-i", str(snapshot),
            "-map", "0:v:0", "-map", "0:a:0", "-sn", "-dn", "-f", "null", "-",
        ], timeout=90)
        full, hover, poster = (stage / name for name in OUTPUT_NAMES)
        _encode_video(snapshot, full, orientation, hover=False)
        _encode_video(snapshot, hover, orientation, hover=True)
        _make_poster(snapshot, poster, orientation)
        sizes = {
            "full.mp4": _check_size(full, MAX_FULL_BYTES),
            "poster.jpg": _check_size(poster, MAX_POSTER_BYTES),
        }
        _verify_video(full, orientation, hover=False)
        _verify_poster(poster, orientation)
        try:
            sizes["hover.mp4"] = _check_size(hover, MAX_HOVER_BYTES)
        except VideoProcessingError as exc:
            if exc.code != "OUTPUT_SIZE":
                raise
            hover.unlink(missing_ok=True)
        else:
            _verify_video(hover, orientation, hover=True)
        snapshot.unlink()
        _publish_without_replacement(stage, destination)
        return {"orientation": orientation, "input_duration_seconds": duration,
                "full_duration_seconds": FULL_SECONDS,
                "full_audio": {"codec": FULL_AUDIO_CODEC,
                               "sample_rate_hz": FULL_AUDIO_SAMPLE_RATE,
                               "channels": FULL_AUDIO_CHANNELS},
                "hover_fallback": "poster.jpg" if "hover.mp4" not in sizes else None,
                "files": {name: {"path": str(destination / name), "bytes": size}
                          for name, size in sizes.items()}}
    except OSError as exc:
        raise VideoProcessingError("IO_ERROR", "Cannot read or write media files") from exc
    finally:
        # A successfully renamed stage no longer exists at this path.
        if stage.exists():
            shutil.rmtree(stage)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Existing local H.264 MP4 file")
    parser.add_argument("output_dir", type=Path, help="New output directory; parent must exist")
    parser.add_argument("--orientation", required=True, choices=tuple(DIMENSIONS))
    args = parser.parse_args()
    try:
        print(json.dumps(process_video(args.input, args.output_dir, args.orientation)))
    except VideoProcessingError as exc:
        print(f"{exc.code}: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
