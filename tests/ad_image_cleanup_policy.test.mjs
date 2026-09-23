import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260923180000_ad_image_cleanup_policy.sql",
    import.meta.url,
  ),
  "utf8",
);
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("ad posting keeps its column-level insert boundary", () => {
  assert.match(
    migration,
    /grant insert \(user_id, title, caption, image_url, promotion_allocation\)\s+on table public\.ads\s+to authenticated;/i,
  );
  assert.doesNotMatch(
    migration,
    /grant\s+insert\s+on\s+(?:table\s+)?public\.ads/i,
  );
  assert.doesNotMatch(migration, /grant\s+update/i);
});

test("failed upload cleanup is restricted to the signed-in owner folder", () => {
  assert.match(
    migration,
    /for delete\s+to authenticated\s+using\s*\(\s*bucket_id = 'ad-images'\s+and \(storage\.foldername\(name\)\)\[1\] = \(select auth\.uid\(\)::text\)\s*\)/i,
  );
  assert.match(
    html,
    /const fileName =\s*`\$\{currentUser\.id\}\/\$\{crypto\.randomUUID\(\)\}\.\$\{extension\}`;/,
  );
  assert.match(
    html,
    /if \(adError\)[\s\S]*?\.from\("ad-images"\)\s*\.remove\(\[fileName\]\)/,
  );
});
