export class DuplicateScanRequestError extends Error {
  code: string;
  status: number;

  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function requirePositiveId(value: unknown) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new DuplicateScanRequestError("INVALID_AD_ID", 400);
  }
  return id;
}

function requireSecret(expected: string, supplied: string) {
  if (!expected) {
    throw new DuplicateScanRequestError("SERVER_CONFIGURATION_ERROR", 500);
  }
  if (supplied !== expected) {
    throw new DuplicateScanRequestError("UNAUTHORIZED", 401);
  }
}

export function parseDuplicateScanRequest(
  body: unknown,
  headers: Headers,
  webhookSecret: string,
  backfillSecret: string,
) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new DuplicateScanRequestError("INVALID_WEBHOOK_PAYLOAD", 400);
  }

  const payload = body as Record<string, unknown>;
  if (Object.hasOwn(payload, "legacy_ad_id")) {
    requireSecret(
      backfillSecret,
      headers.get("x-adbattle-backfill-secret") || "",
    );
    return { adId: requirePositiveId(payload.legacy_ad_id), legacyBackfill: true };
  }

  requireSecret(
    webhookSecret,
    headers.get("x-adbattle-duplicate-scanner-secret") || "",
  );
  const record = payload.record;
  if (
    payload.type !== "INSERT" || payload.table !== "ads" ||
    payload.schema !== "public" || !record || typeof record !== "object" ||
    Array.isArray(record)
  ) {
    throw new DuplicateScanRequestError("INVALID_WEBHOOK_PAYLOAD", 400);
  }

  // Only the identifier crosses the webhook trust boundary. The function must
  // reload every owner, path, and moderation field from the database.
  return {
    adId: requirePositiveId((record as Record<string, unknown>).id),
    legacyBackfill: false,
  };
}
