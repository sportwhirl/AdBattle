export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_EDGE = 4096;
export const MAX_IMAGE_PIXELS = 16_777_216;
export const ACCEPTED_IMAGE_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
]);

type StorageResult<T> = Promise<{ data: T | null; error: { message?: string } | null }>;
export type StorageBucket = {
  info(path: string): StorageResult<{ size?: number; contentType?: string; metadata?: Record<string, unknown> }>;
  download(path: string): StorageResult<Blob>;
};

export function requireOwnedStoragePath(ownerId: string, path: unknown): string {
  if (typeof path !== "string" || !path.startsWith(`${ownerId}/`)) {
    throw new Error("The image storage path is outside the ad owner's namespace");
  }
  const segments = path.split("/");
  if (segments.length < 2 || segments.some((segment) => !segment || segment === "." || segment === "..") || path.includes("\\")) {
    throw new Error("The image storage path is invalid");
  }
  return path;
}

function detectedContentType(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.slice(0, 8).every((byte, i) => byte === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][i])) return "image/png";
  return null;
}

export function requireSupportedImage(bytes: Uint8Array, declaredType: unknown): string {
  const normalized = typeof declaredType === "string" ? declaredType.toLowerCase().split(";", 1)[0].trim() : "";
  const detected = detectedContentType(bytes);
  if (!ACCEPTED_IMAGE_TYPES.includes(normalized) || detected !== normalized) {
    throw new Error("The stored object is not a supported JPEG or PNG image");
  }
  requireImageDimensions(bytes, detected);
  return normalized;
}

export function requireImageDimensions(bytes: Uint8Array, mimeType: string) {
  let width = 0;
  let height = 0;
  if (mimeType === "image/png") {
    // IHDR must be the first PNG chunk, and have exactly 13 bytes.
    if (bytes.length < 33 || bytes[8] !== 0 || bytes[9] !== 0 || bytes[10] !== 0 ||
        bytes[11] !== 13 || String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") {
      throw new Error("Invalid PNG dimensions");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (mimeType === "image/jpeg") {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) throw new Error("Malformed JPEG marker");
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      if (offset >= bytes.length) break;
      const marker = bytes[offset++];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (marker === 0xd9 || marker === 0xda) break;
      if (offset + 2 > bytes.length) break;
      const length = (bytes[offset] << 8) | bytes[offset + 1];
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
           0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 7) break;
        height = (bytes[offset + 3] << 8) | bytes[offset + 4];
        width = (bytes[offset + 5] << 8) | bytes[offset + 6];
        break;
      }
      offset += length;
    }
  }
  if (!width || !height || width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE ||
      width * height > MAX_IMAGE_PIXELS) throw new Error("Image dimensions are invalid or too large");
  return { width, height };
}

export async function loadOwnedImage(bucket: StorageBucket, ownerId: string, candidatePath: unknown): Promise<Uint8Array> {
  // Ownership is checked before either service-role storage operation.
  const path = requireOwnedStoragePath(ownerId, candidatePath);
  const { data: info, error: infoError } = await bucket.info(path);
  if (infoError || !info) throw new Error(infoError?.message || "Image metadata lookup failed");
  if (!Number.isSafeInteger(info.size) || Number(info.size) < 0) throw new Error("Image size metadata is missing");
  if (Number(info.size) > MAX_IMAGE_BYTES) throw new Error("Image exceeds the scanner limit");

  const { data: file, error: downloadError } = await bucket.download(path);
  if (downloadError || !file) throw new Error(downloadError?.message || "Image download failed");
  if (file.size > MAX_IMAGE_BYTES) throw new Error("Image exceeds the scanner limit");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength !== info.size) throw new Error("Image size changed while downloading");
  requireSupportedImage(bytes, info.contentType ?? info.metadata?.mimetype);
  return bytes;
}
