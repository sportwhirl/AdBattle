# Local video media processor

`scripts/process_video_media.py` converts a generated H.264 MP4 into a small,
silent 360p video and poster, plus a hover clip when its size cap is met. It runs on a
local worker. It does not generate video, perform content moderation, upload
media, alter the original file, or publish an ad.

## Usage

Requirements: Python 3.10+, Linux with `renameat2`, and `ffmpeg`/`ffprobe` on
`PATH` (including the `libx264` encoder). The requested output directory must
not exist; its parent directory must exist.

```sh
python3 scripts/process_video_media.py /path/to/generated.mp4 \
  /path/to/new-output-directory --orientation landscape
```

Use `--orientation portrait` for 9:16 source. On success, stdout is one JSON
object containing the measured input duration, output paths and byte counts,
and `hover_fallback` (`poster.jpg` if hover cannot meet its cap). On failure,
exit code is 2, stderr begins with a stable error
code, and no output directory exists. Example errors include `WRONG_DURATION`,
`WRONG_ASPECT`, `UNSUPPORTED_CODEC`, `INPUT_SIZE`, `OUTPUT_SIZE`, and
`OUTPUT_EXISTS`.

| File | Output | Hard size cap |
| --- | --- | ---: |
| `full.mp4` | 640×360 or 360×640, H.264, 24 fps, silent, exactly 10 seconds | 5 MiB |
| `hover.mp4` | Same dimensions, H.264, 13 fps, first four seconds, silent; optional | 500 KiB |
| `poster.jpg` | Same dimensions, still frame at 0.5 seconds | 100 KiB |

Input must be a regular, non-symlink MP4 file at most 30 MiB, with exactly one
H.264 video stream, square pixels, an 8–12 second video duration, a frame rate
between 12 and 60 fps, and a 16:9 or 9:16 ratio within 1%. The shorter side must be
at least 360 pixels; input resolution is capped at 2,073,600 pixels. Audio on
the source is allowed but excluded from both output videos. Source metadata,
including title, comment, artist, chapters, and creation time, is excluded.
The source is fully decoded before derivative generation. A corrupt, oversized,
or nonconforming file fails before publication. Sources shorter than 10 seconds
hold the final frame to reach exactly 10 seconds; sources longer than 10 seconds
are trimmed at 10 seconds. The first four source seconds form the hover clip.

All files are prepared in a private staging directory. The script verifies
their output streams, dimensions, durations, formats and byte caps, then
publishes the files with one atomic, no-replacement directory rename.
Failed processing deletes the staging directory; a preexisting output is never
replaced. The source is copied to staging first, leaving the original intact.
If hover exceeds 500 KiB, the script omits it and identifies `poster.jpg` as
the hover fallback. If the full video or poster exceeds its cap, the request
fails closed without publishing files.

The processor accepts a local path from an upstream job. Run it in a restricted
worker with resource and concurrency limits when integrating it with untrusted
uploads. A moderation and approval process must occur separately before any
public use. These derivative caps describe delivery format and size; they do
not define acceptable generated content or artistic style.

Run its offline integration tests with:

```sh
python3 -m unittest discover -s tests -p video_media_processor_test.py -v
```
