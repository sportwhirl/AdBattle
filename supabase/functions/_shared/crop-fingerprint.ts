import type { PixelSource } from "./image-fingerprint.ts";

// Fixed geometry/order is part of the version. Compare a whole image against
// these regions, never region against region. Matches require human review.
export const CROP_HASH_VERSION = "crop-grid-49-rgb-dhash128-v1";
export const CROP_REGIONS = [1, .9, .8].flatMap((width) =>
  [1, .9, .8].flatMap((height) =>
    (width === 1 ? [0] : [0, .5, 1]).flatMap((x) =>
      (height === 1 ? [0] : [0, .5, 1]).map((y) => ({
        x: x * (1 - width), y: y * (1 - height), width, height,
      }))
    )
  )
);

export type CropFingerprint = {
  version: string;
  width: number;
  height: number;
  regions: { hash: string; color: string; contrast: number }[];
};

export function cropFingerprint(image: PixelSource): CropFingerprint {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) ||
    image.width < 1 || image.height < 1 || image.width > 4096 || image.height > 4096) {
    throw new Error("INVALID_CROP_DIMENSIONS");
  }
  const regions = CROP_REGIONS.map((region) => {
    const rgb: number[][] = [];
    // Bounded stratified area sampling: 254,016 pixel reads per image, regardless
    // of source size. Coordinates are 1-based in ImageScript. No source mutation.
    for (let y = 0; y < 9; y++) {
      for (let x = 0; x < 9; x++) {
        const sums = [0, 0, 0];
        for (let sy = 0; sy < 8; sy++) {
          for (let sx = 0; sx < 8; sx++) {
            const px = Math.min(image.width, 1 + Math.floor(image.width *
              (region.x + region.width * (x + (sx + .5) / 8) / 9)));
            const py = Math.min(image.height, 1 + Math.floor(image.height *
              (region.y + region.height * (y + (sy + .5) / 8) / 9)));
            const pixel = image.getRGBAAt(px, py);
            const alpha = Number(pixel[3]) / 255;
            for (let c = 0; c < 3; c++) sums[c] += Number(pixel[c]) * alpha + 255 * (1 - alpha);
          }
        }
        rgb.push(sums.map((sum) => sum / 64));
      }
    }
    const luma = rgb.map(([r, g, b]) => (r * 299 + g * 587 + b * 114) / 1000);
    let hash = 0n;
    for (const step of [1, 9]) {
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const i = y * 9 + x;
          hash = (hash << 1n) | (luma[i] > luma[i + step] ? 1n : 0n);
        }
      }
    }
    const colors: number[] = [];
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) {
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let dy = 0; dy < 3; dy++) {
            for (let dx = 0; dx < 3; dx++) sum += rgb[(y * 3 + dy) * 9 + x * 3 + dx][c];
          }
          colors.push(Math.round(sum / 9));
        }
      }
    }
    const mean = luma.reduce((a, b) => a + b, 0) / 81;
    const contrast = Math.floor(Math.sqrt(luma.reduce((sum, v) => sum + (v - mean) ** 2, 0) / 81));
    return {
      hash: hash.toString(16).padStart(32, "0"),
      color: colors.map((value) => value.toString(16).padStart(2, "0")).join(""),
      contrast,
    };
  });
  return { version: CROP_HASH_VERSION, width: image.width, height: image.height, regions };
}
