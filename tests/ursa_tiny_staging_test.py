"""Offline integration checks for the private 4-second URSA draft encoder."""

from __future__ import annotations

import json
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

import numpy as np


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import generate_ursa_tiny as tiny  # noqa: E402


def decoded_frames(path: Path, width: int, height: int) -> list[bytes]:
    output = subprocess.run([
        "ffmpeg", "-v", "error", "-i", str(path), "-f", "rawvideo",
        "-pix_fmt", "rgb24", "-",
    ], check=True, capture_output=True).stdout
    size = width * height * 3
    assert len(output) % size == 0
    return [output[i:i + size] for i in range(0, len(output), size)]


def distance(left: bytes, right: bytes) -> float:
    return sum(abs(a - b) for a, b in zip(left, right)) / len(left)


class URSATinyDraftTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def sample(self) -> np.ndarray:
        frames = np.zeros((17, 160, 256, 3), dtype=np.uint8)
        # Make the final frame visually far from the first. Direct repetition
        # should jump, while a forward/back encoding should not.
        for index in range(17):
            frames[index, :, :, :] = (index * 14, index * 8, 60)
        return frames

    def test_exact_private_output_and_small_loop_seam(self) -> None:
        output = self.root / "draft"
        result = tiny.write_private_draft(self.sample(), output, seed=7, generation_s=12.3)
        self.assertEqual({"source.mp4", "preview.mp4", "poster.jpg", "manifest.json"},
                         {file.name for file in output.iterdir()})
        self.assertEqual(0, stat.S_IMODE(output.stat().st_mode) & 0o077)
        self.assertEqual(4, result["preview_seconds"])
        self.assertEqual((256, 144), (result["preview_width"], result["preview_height"]))
        self.assertEqual(result["files"], json.loads((output / "manifest.json").read_text())["files"])
        source = decoded_frames(output / "source.mp4", 256, 160)
        preview = decoded_frames(output / "preview.mp4", 256, 144)
        self.assertEqual((17, 32), (len(source), len(preview)))
        self.assertGreater(distance(preview[16], preview[0]), 50)
        self.assertLess(distance(preview[-1], preview[0]), 20)
        info = subprocess.run([
            "ffprobe", "-v", "error", "-show_entries",
            "stream=codec_name,width,height,avg_frame_rate,nb_frames:format=duration",
            "-of", "json", str(output / "preview.mp4"),
        ], check=True, capture_output=True)
        video = json.loads(info.stdout)
        self.assertEqual("h264", video["streams"][0]["codec_name"])
        self.assertEqual("8/1", video["streams"][0]["avg_frame_rate"])
        self.assertEqual(4.0, float(video["format"]["duration"]))
        self.assertFalse(list(self.root.glob(".adbattle-ursa-*")))

    def test_bad_frames_and_existing_draft_do_not_overwrite(self) -> None:
        output = self.root / "draft"
        with self.assertRaisesRegex(tiny.DraftError, "dimensions"):
            tiny.write_private_draft(self.sample()[:-1], output, seed=7, generation_s=1)
        self.assertFalse(output.exists())
        tiny.write_private_draft(self.sample(), output, seed=7, generation_s=1)
        first = (output / "preview.mp4").read_bytes()
        with self.assertRaises(tiny.DraftError) as raised:
            tiny.write_private_draft(self.sample(), output, seed=8, generation_s=1)
        self.assertEqual("OUTPUT_EXISTS", raised.exception.code)
        self.assertEqual(first, (output / "preview.mp4").read_bytes())

    def test_second_process_cannot_generate_while_gpu_lock_is_held(self) -> None:
        state = self.root / "state"
        code = """import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from generate_ursa_tiny import DraftError, single_gpu_slot
try:
    with single_gpu_slot(Path(sys.argv[2]), 0.1):
        sys.exit(9)
except DraftError as exc:
    sys.exit(0 if exc.code == 'GPU_BUSY' else 8)
"""
        with tiny.single_gpu_slot(state, 0):
            child = subprocess.run([sys.executable, "-c", code, str(SCRIPTS), str(state)],
                                   timeout=5, capture_output=True)
        self.assertEqual(0, child.returncode, child.stderr.decode())
        with tiny.single_gpu_slot(state, 0):
            pass


if __name__ == "__main__":
    unittest.main()
