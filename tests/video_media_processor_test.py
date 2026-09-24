"""Offline integration tests; create tiny synthetic videos with local ffmpeg."""

from __future__ import annotations

from fractions import Fraction
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import process_video_media as media  # noqa: E402


def fixture(path: Path, *, duration: int = 10, orientation: str = "landscape",
            codec: str = "libx264", with_audio: bool = True,
            audio_codec: str = "aac", audio_duration: int | None = None,
            extra_audio: bool = False, silent_audio: bool = False) -> None:
    width, height = media.DIMENSIONS[orientation]
    command = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", f"testsrc2=size={width}x{height}:rate=24",
    ]
    if with_audio:
        source = "anullsrc=r=8000:cl=mono" if silent_audio else \
            "sine=frequency=440:sample_rate=8000"
        if audio_duration is not None:
            source += f":duration={audio_duration}"
        command += ["-f", "lavfi", "-i", source]
        if extra_audio:
            command += ["-f", "lavfi", "-i", "sine=frequency=660:sample_rate=8000"]
    command += ["-t", str(duration), "-map", "0:v:0"]
    if with_audio:
        command += ["-map", "1:a:0"]
        if extra_audio:
            command += ["-map", "2:a:0"]
    command += [
        "-c:v", codec, "-preset", "ultrafast" if codec == "libx264" else "medium",
        "-pix_fmt", "yuv420p",
    ]
    if with_audio:
        command += ["-c:a", audio_codec]
    command += ["-metadata", "title=PRIVATE SOURCE TITLE",
        "-metadata", "comment=PRIVATE SOURCE COMMENT",
        "-metadata:s:v:0", "handler_name=PRIVATE SOURCE HANDLER",
        "-f", "mp4", str(path),
    ]
    subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=40)


class VideoMediaProcessorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name)
        cls.source = cls.root / "landscape.mp4"
        fixture(cls.source)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def _staging_is_clean(self) -> None:
        self.assertEqual([], list(self.root.glob(".adbattle-video-*")))

    def _rejects_without_output(self, path: Path, name: str, code: str,
                                orientation: str = "landscape") -> None:
        output = self.root / name
        with self.assertRaises(media.VideoProcessingError) as raised:
            media.process_video(path, output, orientation)
        self.assertEqual(code, raised.exception.code)
        self.assertFalse(output.exists())
        self._staging_is_clean()

    def test_landscape_keeps_audio_only_in_full_output_without_changing_input(self) -> None:
        initial_hash = hashlib.sha256(self.source.read_bytes()).hexdigest()
        destination = self.root / "landscape-output"
        result = media.process_video(self.source, destination, "landscape")
        self.assertEqual(set(media.OUTPUT_NAMES), set(result["files"]))
        self.assertEqual(set(media.OUTPUT_NAMES), {file.name for file in destination.iterdir()})
        self.assertEqual(initial_hash, hashlib.sha256(self.source.read_bytes()).hexdigest())
        for name, cap in (("full.mp4", media.MAX_FULL_BYTES),
                          ("hover.mp4", media.MAX_HOVER_BYTES),
                          ("poster.jpg", media.MAX_POSTER_BYTES)):
            self.assertLessEqual(result["files"][name]["bytes"], cap)
            self.assertEqual(result["files"][name]["bytes"], (destination / name).stat().st_size)
        self.assertEqual({"codec": "aac", "sample_rate_hz": 48_000, "channels": 2},
                         result["full_audio"])
        for name, seconds, fps in (("full.mp4", 10, 24), ("hover.mp4", 4, 13)):
            info = media._probe(destination / name)
            expected_streams = 2 if name == "full.mp4" else 1
            self.assertEqual(expected_streams, len(info["streams"]))
            stream = next(item for item in info["streams"] if item["codec_type"] == "video")
            self.assertEqual("h264", stream["codec_name"])
            self.assertEqual((640, 360), (stream["width"], stream["height"]))
            self.assertEqual(Fraction(fps), Fraction(stream["avg_frame_rate"]))
            self.assertAlmostEqual(seconds, float(stream["duration"]), delta=0.15)
            tags = info["format"].get("tags", {})
            for forbidden in ("title", "comment", "artist", "creation_time"):
                self.assertNotIn(forbidden, tags)
            self.assertNotEqual("PRIVATE SOURCE HANDLER", stream.get("tags", {}).get("handler_name"))
            if name == "full.mp4":
                audio = next(item for item in info["streams"] if item["codec_type"] == "audio")
                self.assertEqual("aac", audio["codec_name"])
                self.assertEqual(48_000, int(audio["sample_rate"]))
                self.assertEqual(2, int(audio["channels"]))
                self.assertAlmostEqual(10, float(audio["duration"]), delta=0.15)
            else:
                self.assertFalse(any(item["codec_type"] == "audio" for item in info["streams"]))
        poster = media._probe(destination / "poster.jpg")["streams"][0]
        self.assertEqual("mjpeg", poster["codec_name"])
        self.assertEqual((640, 360), (poster["width"], poster["height"]))
        self._staging_is_clean()

    def test_portrait(self) -> None:
        source = self.root / "portrait.mp4"
        fixture(source, duration=8, orientation="portrait")
        destination = self.root / "portrait-output"
        media.process_video(source, destination, "portrait")
        for name in media.OUTPUT_NAMES:
            stream = media._probe(destination / name)["streams"][0]
            self.assertEqual((360, 640), (stream["width"], stream["height"]))
        full = media._probe(destination / "full.mp4")["streams"][0]
        self.assertAlmostEqual(10, float(full["duration"]), delta=0.05)
        # Last frame is retained to fill the final two seconds.
        def raw_frame_at(seconds: float) -> bytes:
            return subprocess.run([
                "ffmpeg", "-nostdin", "-v", "error", "-ss", str(seconds),
                "-i", str(destination / "full.mp4"), "-frames:v", "1",
                "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
            ], check=True, capture_output=True).stdout
        earlier, later = raw_frame_at(8.5), raw_frame_at(9.5)
        self.assertEqual(len(earlier), len(later))
        # Re-encoding a repeated frame can change a few pixel values.
        mean_difference = sum(abs(a - b) for a, b in zip(earlier, later)) / len(earlier)
        self.assertLess(mean_difference, 0.1)

    def test_twelve_second_source_is_trimmed_to_ten_seconds(self) -> None:
        source = self.root / "long.mp4"
        fixture(source, duration=12)
        destination = self.root / "trimmed-output"
        media.process_video(source, destination, "landscape")
        full = media._probe(destination / "full.mp4")["streams"][0]
        self.assertAlmostEqual(10, float(full["duration"]), delta=0.05)

    def test_wrong_duration_rejected_before_publication(self) -> None:
        source = self.root / "short.mp4"
        fixture(source, duration=3)
        self._rejects_without_output(source, "short-output", "WRONG_DURATION")

    def test_missing_generated_audio_is_rejected_before_publication(self) -> None:
        source = self.root / "silent.mp4"
        fixture(source, with_audio=False)
        self._rejects_without_output(source, "silent-output", "INVALID_MEDIA")

    def test_effectively_silent_generated_audio_is_rejected_before_publication(self) -> None:
        source = self.root / "silent-track.mp4"
        fixture(source, silent_audio=True)
        self._rejects_without_output(source, "silent-track-output", "SILENT_AUDIO")

    def test_missing_stream_duration_fails_closed(self) -> None:
        probe = media._probe(self.source)
        next(stream for stream in probe["streams"] if stream["codec_type"] == "audio").pop("duration")
        with self.assertRaises(media.VideoProcessingError) as raised:
            media._check_input(probe, "landscape")
        self.assertEqual("INVALID_MEDIA", raised.exception.code)

    def test_extra_or_mismatched_audio_is_rejected_before_publication(self) -> None:
        extra = self.root / "extra-audio.mp4"
        fixture(extra, extra_audio=True)
        self._rejects_without_output(extra, "extra-audio-output", "INVALID_MEDIA")
        short = self.root / "short-audio.mp4"
        fixture(short, audio_duration=5)
        self._rejects_without_output(short, "short-audio-output", "WRONG_DURATION")

    def test_unsupported_audio_codec_is_rejected_before_publication(self) -> None:
        source = self.root / "ac3-audio.mp4"
        fixture(source, audio_codec="ac3")
        self._rejects_without_output(source, "ac3-audio-output", "UNSUPPORTED_AUDIO_CODEC")

    def test_corrupt_file_rejected_before_publication(self) -> None:
        source = self.root / "corrupt.mp4"
        source.write_bytes(b"\x00\x00\x00\x18ftypisom" + b"broken payload" * 200)
        self._rejects_without_output(source, "corrupt-output", "MEDIA_TOOL_FAILED")

    def test_oversize_file_rejected_before_copy(self) -> None:
        source = self.root / "huge.mp4"
        with source.open("wb") as file:
            file.truncate(media.MAX_INPUT_BYTES + 1)
        self._rejects_without_output(source, "huge-output", "INPUT_SIZE")

    def test_wrong_codec_and_orientation_rejected(self) -> None:
        source = self.root / "mpeg4.mp4"
        fixture(source, codec="mpeg4")
        self._rejects_without_output(source, "wrong-codec-output", "UNSUPPORTED_CODEC")
        self._rejects_without_output(self.source, "wrong-orientation-output", "WRONG_ASPECT", "portrait")

    def test_symlink_input_and_existing_output_rejected(self) -> None:
        link = self.root / "link.mp4"
        link.symlink_to(self.source)
        self._rejects_without_output(link, "symlink-output", "UNSAFE_PATH")
        destination = self.root / "collision-output"
        destination.mkdir()
        (destination / "keep.txt").write_text("safe")
        with self.assertRaises(media.VideoProcessingError) as raised:
            media.process_video(self.source, destination, "landscape")
        self.assertEqual("OUTPUT_EXISTS", raised.exception.code)
        self.assertEqual("safe", (destination / "keep.txt").read_text())

    def test_exceeded_hover_cap_uses_poster_fallback(self) -> None:
        with mock.patch.object(media, "MAX_HOVER_BYTES", 1):
            destination = self.root / "hover-fallback"
            result = media.process_video(self.source, destination, "landscape")
        self.assertEqual("poster.jpg", result["hover_fallback"])
        self.assertEqual({"full.mp4", "poster.jpg"}, set(result["files"]))
        self.assertEqual({"full.mp4", "poster.jpg"}, {file.name for file in destination.iterdir()})
        self._staging_is_clean()

    def test_exceeded_full_cap_fails_without_publishing_anything(self) -> None:
        with mock.patch.object(media, "MAX_FULL_BYTES", 1):
            self._rejects_without_output(self.source, "over-full-cap", "OUTPUT_SIZE")


if __name__ == "__main__":
    unittest.main()
