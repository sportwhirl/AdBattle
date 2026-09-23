export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
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
  return normalized;
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
  requireSupportedImage(bytes, info.contentType ?? info.metadata?.mimetype);
  return bytes;
}
