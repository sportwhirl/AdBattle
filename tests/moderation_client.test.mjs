import assert from "node:assert/strict";
import test from "node:test";
import {
  createDecisionClient,
  safeImageUrl,
  reviewKinds,
} from "../moderation.mjs";
const user = "00000000-0000-4000-8000-000000000001";
const config = { supabaseUrl: "https://nccqnrcdygujulrnwair.supabase.co" };
const ad = { ad: { id: "4" }, version: "a".repeat(32) };
function storage() {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) || null,
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
}
test("preview accepts only signed owner paths from the configured project", () => {
  const image = { owner_id: user, image_storage_path: `${user}/image.png`, image_url: "https://evil.test/x" };
  const signed = `${config.supabaseUrl}/storage/v1/object/sign/ad-pending-images/${user}/image.png?token=test-token`;
  assert.equal(safeImageUrl(image, config, signed), signed);
  assert.equal(safeImageUrl(image, config, signed.replace("ad-pending-images", "ad-images")), signed.replace("ad-pending-images", "ad-images"));
  for (const candidate of [undefined, image.image_url, signed.replace("sign", "public"),
    signed.replace("nccqnrcdygujulrnwair", "another-project"), signed.replace(user, "stranger"),
    signed.replace("image.png", "other.png"), signed.replace("?token=test-token", ""),
    signed + "#fragment", signed + "&redirect=https://evil.test", signed.replace("https://", "https://user:pass@")]) {
    assert.equal(safeImageUrl(image, config, candidate), null);
  }
  for (const path of [null, "other/image.png", `${user}/../x`, `${user}//x`, `${user}/x%2fimage.png`]) {
    assert.equal(safeImageUrl({ ...image, image_storage_path: path }, config, signed), null);
  }
});
test("review controls expose only held checks and never removed, failed or same-owner duplicate states", () => {
  assert.deepEqual(
    reviewKinds({ safety_status: "held", duplicate_status: "review_similar" }),
    ["safety", "duplicate"],
  );
  assert.deepEqual(
    reviewKinds({
      safety_status: "failed",
      duplicate_status: "duplicate_same_creator",
    }),
    [],
  );
  assert.deepEqual(
    reviewKinds({
      safety_status: "held",
      duplicate_status: "review_identical",
      moderation_status: "removed",
    }),
    [],
  );
});
test("lost response survives reload and reuses exactly the persisted decision", async () => {
  const saved = storage();
  const calls = [];
  let fail = true;
  const db = {
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (fail) throw new Error("network");
      return { data: { ad_id: "4", review_kind: "safety", decision: "clear" } };
    },
  };
  const c = createDecisionClient(db, saved, "test", user, () => "uuid-one");
  await assert.rejects(
    c.submit(ad, "safety", "clear", " A sufficiently detailed reason "),
    /network/,
  );
  assert.equal(c.pending().p_request_id, "uuid-one");
  await assert.rejects(
    c.submit(ad, "safety", "reject", "Different review"),
    /Resolve the saved/,
  );
  fail = false;
  const reloaded = createDecisionClient(
    db,
    saved,
    "test",
    user,
    () => "uuid-two",
  );
  await reloaded.retry();
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(reloaded.pending(), null);
});
test("storage failure prevents dispatch and pending state is project/user scoped", async () => {
  let calls = 0;
  const db = {
    rpc: async () => {
      calls++;
      throw new Error("offline");
    },
  };
  const broken = {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota");
    },
  };
  await assert.rejects(
    createDecisionClient(db, broken, "test", user).submit(
      ad,
      "safety",
      "clear",
      "Reviewed the full ad",
    ),
    /quota/,
  );
  assert.equal(calls, 0);
  const saved = storage();
  const c = createDecisionClient(db, saved, "test", user);
  await assert.rejects(
    c.submit(ad, "safety", "clear", "Reviewed the full ad"),
    /offline/,
  );
  assert.equal(
    createDecisionClient(db, saved, "production", user).pending(),
    null,
  );
  assert.equal(
    createDecisionClient(db, saved, "test", "other").pending(),
    null,
  );
});
test("definitive conflicts clear the retry while auth/network uncertainty retains it", async () => {
  for (const [error, retained] of [
    ["REVIEW_CHANGED_REFRESH_REQUIRED", false],
    ["MODERATOR_ACCESS_REQUIRED", true],
    ["unavailable", true],
  ]) {
    const c = createDecisionClient(
      { rpc: async () => ({ error: { message: error } }) },
      storage(),
      "test",
      user,
    );
    await assert.rejects(
      c.submit(ad, "safety", "clear", "Reviewed the full ad"),
    );
    assert.equal(!!c.pending(), retained);
  }
});
test("unmatched success responses cannot discard saved decisions", async () => {
  const c = createDecisionClient(
    {
      rpc: async () => ({
        data: { ad_id: "5", review_kind: "safety", decision: "clear" },
      }),
    },
    storage(),
    "test",
    user,
  );
  await assert.rejects(
    c.submit(ad, "safety", "clear", "Reviewed the full ad"),
    /unconfirmed/,
  );
  assert.ok(c.pending());
});
