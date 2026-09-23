# Optional still animation processor

`scripts/animate_stills.py` makes a simple 10-second moving ad from **one or two
already-approved local JPEG/PNG stills**. It is an offline alternative to a
text-to-video model call. AI can make the source stills, while the pan, zoom,
transition and video encoding run locally with FFmpeg. This step uses no model
tokens itself; it still needs worker CPU time. It does not call a provider,
check approval, moderate video, upload, or publish anything.

The caller must establish the stills' approval and rights before invoking this
tool. The resulting video, including all frames and the exact final files,
needs its own video review and publication gate. A still approval is not a video
approval.

## Example

Requires Python 3.10+, Linux `renameat2`, FFmpeg/ffprobe with `libx264`, and an
existing output parent directory. The output directory itself must be new.

```sh
python3 scripts/animate_stills.py /approved/first.png /approved/second.jpg \
  --output-dir /private/new-animation --orientation landscape \
  --motion zoom-in --transition dissolve --matte light
```

Omit the second image for one-still animation. Use `--orientation portrait` for
360×640 output. Defaults are `zoom-in`, `dissolve`, and `light`.

| Setting | Fixed choices | Result |
| --- | --- | --- |
| Motion | `zoom-in`, `zoom-out`, `drift-left`, `drift-right`, `hold` | At most 3.5% zoom, with small horizontal movement or a still hold. |
| Transition with two stills | `dissolve`, `cut` | One-second dissolve from 4.5 to 5.5 seconds, or a cut at five seconds. |
| Matte | `light`, `dark` | Fixed off-white or charcoal border; the entire source image remains visible. |

Each image fits within 90% of the canvas so zoom and drift do not cut off its
edges. A square input can therefore become a landscape or portrait video with
an intentional matte. Inputs must be single-frame JPEG or PNG, regular files
(no symlinks), each at most 10 MiB, with both sides at least 360 pixels, neither
side above 2048 pixels, and no more than 4,194,304 decoded pixels. The script
checks magic bytes, decoded codec, one frame, dimensions, and full decoding.
There are no user-supplied FFmpeg filter expressions or shell commands.

The tool copies inputs into a private temporary directory, creates an
intermediate silent H.264 MP4, and hands it to
[`process_video_media.py`](VIDEO_MEDIA_PROCESSOR.md). That processor validates
and atomically publishes `full.mp4` (exactly 10 seconds at 24 fps, at most
5 MiB), `poster.jpg` (at most 100 KiB), and optionally `hover.mp4` (four seconds
at 13 fps, at most 500 KiB). If hover alone exceeds its cap, `poster.jpg` is the
fallback. A full or poster cap failure leaves no output directory. Source stills
are never modified; temporary copies and the intermediate video are removed.

The CLI emits JSON with output paths and byte counts, source SHA-256 hashes,
selected motion and transition, and any hover fallback. A failure exits with
status 2 and a stable error code such as `STILL_SIZE`, `STILL_DIMENSIONS`,
`INVALID_STILL`, `UNSUPPORTED_STILL`, `OUTPUT_SIZE`, or `OUTPUT_EXISTS`.

Run the synthetic offline tests:

```sh
python3 -m unittest discover -s tests -p still_animation_test.py -v
```

This script is not wired to the public API or ad gallery. A future worker must
authenticate the caller, verify approval and asset ownership, enforce job and
CPU quotas, review the finished video, and store exact reviewed bytes before
release. No hosting changes are part of this processor.
