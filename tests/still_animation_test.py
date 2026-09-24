"""Offline synthetic integration tests for the still animation processor."""

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
import animate_stills as animation  # noqa: E402
import process_video_media as media  # noqa: E402


def make_still(path: Path, source: str, *, size: str = "640x360") -> None:
    filter_source = f"testsrc2=s={size}:d=1" if source == "testsrc2" else f"{source}:s={size}:d=1"
    subprocess.run([
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", filter_source,
        "-frames:v", "1", str(path),
    ], check=True, capture_output=True, timeout=20)


def center_pixel(path: Path, time: float, *, width: int = 640, height: int = 360) -> tuple[int, int, int]:
    raw = subprocess.run([
        "ffmpeg", "-nostdin", "-v", "error", "-ss", str(time), "-i", str(path),
        "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-",
    ], check=True, capture_output=True, timeout=20).stdout
    index = ((height // 2) * width + width // 2) * 3
    return tuple(raw[index:index + 3])


class StillAnimationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name)
        cls.red = cls.root / "red.png"
        cls.blue = cls.root / "blue.jpg"
        cls.pattern = cls.root / "pattern.png"
        make_still(cls.red, "color=c=red")
        make_still(cls.blue, "color=c=blue")
        make_still(cls.pattern, "testsrc2")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def _no_stage(self) -> None:
        self.assertEqual([], list(self.root.glob(".adbattle-animation-*")))
        self.assertEqual([], list(self.root.glob(".adbattle-video-*")))

    def _reject(self, sources: list[Path], name: str, code: str) -> None:
        output = self.root / name
        with self.assertRaises(media.VideoProcessingError) as raised:
            animation.animate_stills(sources, output, orientation="landscape")
        self.assertEqual(code, raised.exception.code)
        self.assertFalse(output.exists())
        self._no_stage()

    def test_one_still_motion_and_derivative_caps(self) -> None:
        before = hashlib.sha256(self.pattern.read_bytes()).hexdigest()
        output = self.root / "one-still"
        result = animation.animate_stills([self.pattern], output, orientation="landscape",
                                          motion="zoom-in", matte="dark")
        self.assertEqual(before, hashlib.sha256(self.pattern.read_bytes()).hexdigest())
        self.assertEqual([before], result["source_sha256"])
        self.assertEqual(1, result["source_count"])
        self.assertIsNone(result["transition"])
        self.assertEqual(set(media.OUTPUT_NAMES), set(result["files"]))
        for name, cap in (("full.mp4", media.MAX_FULL_BYTES),
                          ("hover.mp4", media.MAX_HOVER_BYTES),
                          ("poster.jpg", media.MAX_POSTER_BYTES)):
            self.assertLessEqual((output / name).stat().st_size, cap)
        full = media._probe(output / "full.mp4")["streams"]
        self.assertEqual(1, len(full))
        self.assertEqual(("h264", 640, 360),
                         (full[0]["codec_name"], full[0]["width"], full[0]["height"]))
        self.assertEqual(Fraction(24), Fraction(full[0]["avg_frame_rate"]))
        self.assertAlmostEqual(10, float(full[0]["duration"]), delta=0.05)
        self.assertNotEqual(center_pixel(output / "full.mp4", 0.2),
                            center_pixel(output / "full.mp4", 9.2))
        self._no_stage()

    def test_two_stills_dissolve_and_optional_cut(self) -> None:
        output = self.root / "dissolve"
        animation.animate_stills([self.red, self.blue], output, orientation="landscape",
                                 transition="dissolve", motion="hold")
        early = center_pixel(output / "full.mp4", 1)
        middle = center_pixel(output / "full.mp4", 5)
        late = center_pixel(output / "full.mp4", 9)
        self.assertGreater(early[0], 150)
        self.assertLess(early[2], 80)
        self.assertGreater(middle[0], 60)
        self.assertGreater(middle[2], 60)
        self.assertLess(late[0], 80)
        self.assertGreater(late[2], 150)
        cut = self.root / "cut"
        animation.animate_stills([self.red, self.blue], cut, orientation="landscape",
                                 transition="cut", motion="drift-left")
        self.assertGreater(center_pixel(cut / "full.mp4", 4.8)[0], 150)
        self.assertGreater(center_pixel(cut / "full.mp4", 5.2)[2], 150)

    def test_square_still_to_portrait_and_motion_presets(self) -> None:
        square = self.root / "square.png"
        make_still(square, "testsrc2", size="512x512")
        for preset in ("zoom-out", "drift-right"):
            output = self.root / preset
            animation.animate_stills([square], output, orientation="portrait", motion=preset)
            video = media._probe(output / "full.mp4")["streams"][0]
            poster = media._probe(output / "poster.jpg")["streams"][0]
            self.assertEqual((360, 640), (video["width"], video["height"]))
            self.assertEqual((360, 640), (poster["width"], poster["height"]))

    def test_bad_stills_fail_before_output(self) -> None:
        corrupt = self.root / "corrupt.png"
        corrupt.write_bytes(b"\x89PNG\r\n\x1a\n" + b"invalid" * 100)
        self._reject([corrupt], "corrupt-output", "INVALID_STILL")
        gif = self.root / "fake.gif"
        gif.write_bytes(b"GIF89a" + b"x" * 100)
        self._reject([gif], "gif-output", "UNSUPPORTED_STILL")
        huge = self.root / "huge.png"
        with huge.open("wb") as file:
            file.truncate(animation.MAX_STILL_BYTES + 1)
        self._reject([huge], "huge-output", "STILL_SIZE")
        small = self.root / "small.png"
        make_still(small, "color=c=white", size="128x128")
        self._reject([small], "small-output", "STILL_DIMENSIONS")
        link = self.root / "link.png"
        link.symlink_to(self.red)
        self._reject([link], "link-output", "UNSAFE_PATH")

    def test_count_and_existing_output(self) -> None:
        self._reject([], "zero-output", "STILL_COUNT")
        self._reject([self.red] * 3, "three-output", "STILL_COUNT")
        output = self.root / "exists"
        output.mkdir()
        (output / "keep").write_text("original")
        with self.assertRaises(media.VideoProcessingError) as raised:
            animation.animate_stills([self.red], output, orientation="landscape")
        self.assertEqual("OUTPUT_EXISTS", raised.exception.code)
        self.assertEqual("original", (output / "keep").read_text())

    def test_final_processor_failure_cleans_animation_stage(self) -> None:
        with mock.patch.object(media, "MAX_FULL_BYTES", 1):
            self._reject([self.red], "over-cap", "OUTPUT_SIZE")

    def test_hover_cap_uses_poster_fallback(self) -> None:
        with mock.patch.object(media, "MAX_HOVER_BYTES", 1):
            output = self.root / "hover-fallback"
            result = animation.animate_stills([self.red], output, orientation="landscape")
        self.assertEqual("poster.jpg", result["hover_fallback"])
        self.assertEqual({"full.mp4", "poster.jpg"}, {file.name for file in output.iterdir()})


if __name__ == "__main__":
    unittest.main()
