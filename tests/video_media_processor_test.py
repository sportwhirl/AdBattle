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


def fixture(path: Path, *, duration: float = 5, orientation: str = "landscape",
            codec: str = "libx264", size: tuple[int, int] | None = None) -> None:
    width, height = size or media.DIMENSIONS[orientation]
    subprocess.run([
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", f"testsrc2=size={width}x{height}:rate=24",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000",
        "-t", str(duration), "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", codec, "-preset", "ultrafast" if codec == "libx264" else "medium",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-metadata", "title=PRIVATE SOURCE TITLE",
        "-metadata", "comment=PRIVATE SOURCE COMMENT",
        "-metadata:s:v:0", "handler_name=PRIVATE SOURCE HANDLER",
        "-f", "mp4", str(path),
    ], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=40)


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

    def test_landscape_creates_three_bounded_silent_outputs_without_changing_input(self) -> None:
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
        for name, seconds, fps in (("full.mp4", 5, 24), ("hover.mp4", 3, 13)):
            info = media._probe(destination / name)
            self.assertEqual(1, len(info["streams"]))
            stream = info["streams"][0]
            self.assertEqual("h264", stream["codec_name"])
            self.assertEqual((640, 360), (stream["width"], stream["height"]))
            self.assertEqual(Fraction(fps), Fraction(stream["avg_frame_rate"]))
            self.assertAlmostEqual(seconds, float(stream["duration"]), delta=0.15)
            tags = info["format"].get("tags", {})
            for forbidden in ("title", "comment", "artist", "creation_time"):
                self.assertNotIn(forbidden, tags)
            self.assertNotEqual("PRIVATE SOURCE HANDLER", stream.get("tags", {}).get("handler_name"))
        poster = media._probe(destination / "poster.jpg")["streams"][0]
        self.assertEqual("mjpeg", poster["codec_name"])
        self.assertEqual((640, 360), (poster["width"], poster["height"]))
        self._staging_is_clean()

    def test_portrait(self) -> None:
        source = self.root / "portrait.mp4"
        fixture(source, duration=4.5, orientation="portrait")
        destination = self.root / "portrait-output"
        media.process_video(source, destination, "portrait")
        for name in media.OUTPUT_NAMES:
            stream = media._probe(destination / name)["streams"][0]
            self.assertEqual((360, 640), (stream["width"], stream["height"]))
        full = media._probe(destination / "full.mp4")["streams"][0]
        self.assertAlmostEqual(5, float(full["duration"]), delta=0.05)
        # A slightly short model clip extends its last frame to five seconds.
        def raw_frame_at(seconds: float) -> bytes:
            return subprocess.run([
                "ffmpeg", "-nostdin", "-v", "error", "-ss", str(seconds),
                "-i", str(destination / "full.mp4"), "-frames:v", "1",
                "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
            ], check=True, capture_output=True).stdout
        earlier, later = raw_frame_at(4.6), raw_frame_at(4.9)
        self.assertEqual(len(earlier), len(later))
        # Re-encoding a repeated frame can change a few pixel values.
        mean_difference = sum(abs(a - b) for a, b in zip(earlier, later)) / len(earlier)
        self.assertLess(mean_difference, 0.1)

    def test_slightly_long_source_is_trimmed_to_five_seconds(self) -> None:
        source = self.root / "long.mp4"
        fixture(source, duration=5.5)
        destination = self.root / "trimmed-output"
        media.process_video(source, destination, "landscape")
        full = media._probe(destination / "full.mp4")["streams"][0]
        self.assertAlmostEqual(5, float(full["duration"]), delta=0.05)

    def test_native_wan_480p_aspects_fit_without_rejection(self) -> None:
        for orientation, size in (("landscape", (832, 480)), ("portrait", (480, 832))):
            source = self.root / f"wan-{orientation}.mp4"
            fixture(source, orientation=orientation, size=size)
            destination = self.root / f"wan-{orientation}-output"
            media.process_video(source, destination, orientation)
            for name in media.OUTPUT_NAMES:
                stream = media._probe(destination / name)["streams"][0]
                self.assertEqual(media.DIMENSIONS[orientation],
                                 (stream["width"], stream["height"]))

    def test_wrong_duration_rejected_before_publication(self) -> None:
        source = self.root / "short.mp4"
        fixture(source, duration=3)
        self._rejects_without_output(source, "short-output", "WRONG_DURATION")

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
