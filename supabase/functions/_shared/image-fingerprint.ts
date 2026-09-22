export const VISUAL_HASH_VERSION = "dhash-9x8-luma-v1";
export const VISUAL_MATCH_DISTANCE = 8;

export type PixelSource = {
  width: number;
  height: number;
  getRGBAAt(x: number, y: number): ArrayLike<number>;
};

export function differenceHash(image: PixelSource): string {
  if (image.width !== 9 || image.height !== 8) {
    throw new Error("differenceHash requires a 9 by 8 image");
  }
  let value = 0n;
  for (let y = 1; y <= 8; y++) {
    for (let x = 1; x <= 8; x++) {
      const left = image.getRGBAAt(x, y);
      const right = image.getRGBAAt(x + 1, y);
      const luma = (pixel: ArrayLike<number>) =>
        Number(pixel[0]) * 299 + Number(pixel[1]) * 587 + Number(pixel[2]) * 114;
      value = (value << 1n) | (luma(left) > luma(right) ? 1n : 0n);
    }
  }
  return value.toString(16).padStart(16, "0");
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
