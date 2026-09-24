import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import test, { before, after, beforeEach } from "node:test";
import { PGlite } from "@electric-sql/pglite";
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const moderator = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const ordinary = "00000000-0000-4000-8000-000000000003";
const sessions = new Map(
  [moderator, other, ordinary].map((id) => [id, randomUUID()]),
);
let db;
before(async () => {
  db = new PGlite();
  await db.exec(`create schema auth;
    create table auth.users(id uuid primary key,is_anonymous boolean default false,deleted_at timestamptz,banned_until timestamptz);
    create table auth.sessions(id uuid primary key,user_id uuid references auth.users,not_after timestamptz);
    create function auth.jwt() returns jsonb language sql as $$ select nullif(current_setting('request.jwt.claims',true),'')::jsonb $$;
    create function auth.uid() returns uuid language sql as $$ select (auth.jwt()->>'sub')::uuid $$;
    create role anon; create role authenticated; create role service_role;
    grant usage on schema public,auth to anon,authenticated,service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;`);
  await db.exec(read("../supabase/staging/00_test_base.sql"));
  await db.exec(
    read("../supabase/migrations/20260922_duplicate_screening.sql"),
  );
  await db.exec(
    read("../supabase/migrations/20260923164716_private_moderation_review.sql"),
  );
  for (const [id, session] of sessions) {
    await db.query("insert into auth.users(id) values($1)", [id]);
    await db.query("insert into auth.sessions(id,user_id) values($1,$2)", [
      session,
      id,
    ]);
  }
  await db.query(
    "insert into moderation_private.reviewers(user_id,granted_by,reason) values($1,'test-operator','Verified test reviewer'),($2,'test-operator','Second test reviewer')",
    [moderator, other],
  );
});
after(async () => db.close());
beforeEach(async () => db.exec("reset role"));
async function login(user = moderator, extras = {}) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claims',$1,false)", [
    JSON.stringify({ sub: user, session_id: sessions.get(user), ...extras }),
  ]);
  await db.exec("set role authenticated");
}
async function fixture(safety = "held", duplicate = "passed", match = null) {
  await db.exec("reset role");
  const { rows } = await db.query(
    "insert into ads(user_id,title,caption,image_url,image_storage_path) values($1,'Flagged ad','Caption','https://evil.invalid/untrusted','original.png') returning id",
    [ordinary],
  );
  const id = rows[0].id;
  await db.query(
    `update ads set safety_status=$2,duplicate_status=$3,duplicate_of_ad_id=$4,
    moderation_reason='Scanner requires human review',moderation_details='{"policy_review":{"decision":"manual_review"}}',moderation_scan_version='test-v1' where id=$1`,
    [id, safety, duplicate, match],
  );
  await db.query("select refresh_ad_moderation_status($1)", [id]);
  return String(id);
}
const detail = async (id) =>
  (await db.query("select moderator_ad($1) result", [id])).rows[0].result;
const access = async () =>
  (await db.query("select moderator_access() result")).rows[0].result;
const queue = async (after = "0") =>
  (await db.query("select moderator_queue($1) result", [after])).rows[0].result;
async function request(
  id,
  kind = "safety",
  decision = "clear",
  reason = "Reviewed the complete creative and policy findings",
) {
  return [randomUUID(), id, kind, decision, reason, (await detail(id)).version];
}
const decide = async (args) =>
  (await db.query("select moderator_decide($1,$2,$3,$4,$5,$6) result", args))
    .rows[0].result;

test("anonymous, ordinary users and forged metadata cannot read or decide", async () => {
  const id = await fixture();
  await db.exec("set role anon");
  await assert.rejects(access(), /permission denied/);
  await login(ordinary, {
    user_metadata: { moderator: true },
    app_metadata: { role: "moderator" },
  });
  for (const fn of [
    access,
    queue,
    () => detail(id),
    () =>
      decide([
        randomUUID(),
        id,
        "safety",
        "clear",
        "Forged identity request",
        "a".repeat(32),
      ]),
  ])
    await assert.rejects(fn(), /MODERATOR_ACCESS_REQUIRED/);
  await assert.rejects(
    db.query("select * from moderation_private.reviewers"),
    /permission denied/,
  );
  await assert.rejects(
    db.query("select * from moderation_private.decisions"),
    /permission denied/,
  );
  await assert.rejects(
    db.query(
      "insert into moderation_private.reviewers values($1,now(),'forged','Forged access grant')",
      [ordinary],
    ),
    /permission denied/,
  );
  await assert.rejects(
    db.query("select moderation_private.snapshot($1)", [id]),
    /permission denied/,
  );
  await assert.rejects(
    db.query("select record_ad_safety_scan($1,'passed',null)", [id]),
    /permission denied/,
  );
  await assert.rejects(
    db.query(
      "select resolve_ad_duplicate_review($1,'clear','spoofed','Spoofed reviewer identity')",
      [id],
    ),
    /permission denied/,
  );
  await assert.rejects(
    db.query("update ads set safety_status='passed' where id=$1", [id]),
    /permission denied/,
  );
});

test("live allowlist and session checks reject revoked, anonymous, expired, deleted and banned accounts", async () => {
  await login();
  assert.equal((await access()).reviewer_id, moderator);
  for (const extras of [
    { session_id: randomUUID() },
    { session_id: sessions.get(ordinary) },
    { session_id: null },
    { session_id: "bad" },
  ]) {
    await login(moderator, extras);
    await assert.rejects(access(), /MODERATOR_ACCESS_REQUIRED/);
  }
  for (const clause of [
    "is_anonymous=true",
    "deleted_at=now()",
    "banned_until=now()+interval '1 hour'",
  ]) {
    await db.exec("reset role");
    await db.query(`update auth.users set ${clause} where id=$1`, [moderator]);
    await login();
    await assert.rejects(access(), /MODERATOR_ACCESS_REQUIRED/);
    await db.exec("reset role");
    await db.query(
      "update auth.users set is_anonymous=false,deleted_at=null,banned_until=null where id=$1",
      [moderator],
    );
  }
  await db.query(
    "update auth.sessions set not_after=now()-interval '1 minute' where id=$1",
    [sessions.get(moderator)],
  );
  await login();
  await assert.rejects(access(), /MODERATOR_ACCESS_REQUIRED/);
  await db.exec("reset role");
  await db.query("update auth.sessions set not_after=null where id=$1", [
    sessions.get(moderator),
  ]);
  await db.query("delete from moderation_private.reviewers where user_id=$1", [
    moderator,
  ]);
  await login();
  await assert.rejects(access(), /MODERATOR_ACCESS_REQUIRED/);
  await db.exec("reset role");
  await db.query(
    "insert into moderation_private.reviewers(user_id,granted_by,reason) values($1,'operator','Restore test membership')",
    [moderator],
  );
});

test("safety clearance publishes only with duplicate pass and preserves scanner evidence", async () => {
  const id = await fixture();
  await login();
  const before = await detail(id);
  const result = await decide(await request(id));
  assert.equal(result.moderation_status, "approved");
  const after = await detail(id);
  assert.deepEqual(after.ad.details, before.ad.details);
  assert.equal(after.ad.reason, before.ad.reason);
  assert.equal(after.history.length, 1);
  assert.equal(after.history[0].reviewer_id, moderator);
  await db.exec("reset role");
  const audit = (
    await db.query(
      "select before_snapshot from moderation_private.decisions where ad_id=$1",
      [id],
    )
  ).rows[0];
  assert.deepEqual(audit.before_snapshot, before.ad);
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from moderation_events where ad_id=$1 and stage='human_safety_review'",
        [id],
      )
    ).rows[0].n,
    1,
  );
  await assert.rejects(
    db.query("select record_ad_safety_scan($1,'held','Old scanner retry')", [
      id,
    ]),
    /SAFETY_STATUS_TERMINAL/,
  );
  await login();
  await assert.rejects(
    db.query("delete from moderation_private.decisions"),
    /permission denied/,
  );
});

test("safety and duplicate reviews remain independent in either order", async () => {
  const source = await fixture("passed", "passed");
  for (const order of [
    ["safety", "duplicate"],
    ["duplicate", "safety"],
  ]) {
    const id = await fixture("held", "review_identical", source);
    await login();
    const first = await decide(await request(id, order[0]));
    assert.equal(first.moderation_status, "pending_scan");
    const second = await decide(await request(id, order[1]));
    assert.equal(second.moderation_status, "approved");
    const row = await detail(id);
    assert.equal(row.ad.duplicate_of_ad_id, source);
    assert.equal(row.history.length, 2);
    assert.equal(row.duplicate_audit.reviewer_identity, moderator);
  }
});

test("rejection cannot be undone by clearing the other check; removed and terminal states cannot be reviewed", async () => {
  const source = await fixture("passed", "passed");
  const id = await fixture("held", "review_similar", source);
  await login();
  assert.equal(
    (await decide(await request(id, "safety", "reject"))).moderation_status,
    "rejected",
  );
  assert.equal(
    (await decide(await request(id, "duplicate"))).moderation_status,
    "rejected",
  );
  for (const [safety, duplicate, kind, error] of [
    ["passed", "passed", "safety", "SAFETY_REVIEW_NOT_HELD"],
    ["failed", "passed", "safety", "SAFETY_REVIEW_NOT_HELD"],
    ["pending", "passed", "safety", "SAFETY_REVIEW_NOT_HELD"],
    [
      "passed",
      "duplicate_same_creator",
      "duplicate",
      "DUPLICATE_REVIEW_NOT_HELD",
    ],
  ]) {
    const x = await fixture(safety, duplicate, source);
    await login();
    await assert.rejects(decide(await request(x, kind)), new RegExp(error));
  }
  const removed = await fixture();
  await db.query("update ads set moderation_status='removed' where id=$1", [
    removed,
  ]);
  await login();
  await assert.rejects(
    decide(await request(removed)),
    /REMOVED_AD_CANNOT_BE_REVIEWED/,
  );
});

test("identical retry returns one recorded decision; UUID changes and other reviewers cannot reuse it", async () => {
  const id = await fixture();
  await login();
  const args = await request(id);
  const first = await decide(args);
  assert.deepEqual(await decide(args), first);
  assert.equal((await detail(id)).history.length, 1);
  const changed = [...args];
  changed[4] = "A different reason for the same request";
  await assert.rejects(decide(changed), /REVIEW_REQUEST_CONFLICT/);
  await login(other);
  await assert.rejects(decide(args), /REVIEW_REQUEST_CONFLICT/);
  await login();
  const again = [...args];
  again[0] = randomUUID();
  await assert.rejects(decide(again), /REVIEW_ALREADY_RESOLVED/);
});

test("stale content, findings or the other screening result require a fresh review", async () => {
  const id = await fixture();
  await login();
  const args = await request(id);
  await db.exec("reset role");
  await db.query("update ads set caption='Changed creative text' where id=$1", [
    id,
  ]);
  await login();
  await assert.rejects(decide(args), /REVIEW_CHANGED_REFRESH_REQUIRED/);
  assert.equal((await detail(id)).history.length, 0);
  const source = await fixture("passed", "passed");
  const both = await fixture("held", "review_similar", source);
  await login();
  const safety = await request(both);
  await decide(await request(both, "duplicate"));
  await assert.rejects(decide(safety), /REVIEW_CHANGED_REFRESH_REQUIRED/);
});

test("invalid reasons and nulls fail atomically; monetary changes do not stale a decision", async () => {
  const id = await fixture();
  await login();
  const args = await request(id);
  for (const [index, value] of [
    [0, null],
    [1, null],
    [2, null],
    [2, "all"],
    [3, null],
    [3, "approve"],
    [4, "short"],
    [4, "x".repeat(2001)],
    [5, null],
  ]) {
    const invalid = [...args];
    invalid[index] = value;
    await assert.rejects(decide(invalid), /INVALID_REVIEW/);
  }
  assert.equal((await detail(id)).history.length, 0);
  await db.exec("reset role");
  await db.query("update ads set support_total=1 where id=$1", [id]);
  await login();
  assert.equal((await decide(args)).moderation_status, "approved");
});

test("queue is bounded and keyset-paged; excludes scanner-pending and same-owner duplicates", async () => {
  const excluded = [
    await fixture("pending", "pending"),
    await fixture("passed", "duplicate_same_creator"),
  ];
  for (let i = 0; i < 28; i++) await fixture();
  await login();
  const first = await queue();
  assert.equal(first.items.length, 25);
  assert.ok(first.next_after_id);
  const second = await queue(first.next_after_id);
  assert.ok(second.items.length);
  assert.ok(
    second.items.every((i) => BigInt(i.id) > BigInt(first.next_after_id)),
  );
  assert.ok(
    [...first.items, ...second.items].every((i) => !excluded.includes(i.id)),
  );
  await assert.rejects(queue("-1"), /INVALID_PAGE/);
});

test("API functions are invokers, privileged implementations fixed-path, and private table privileges closed", async () => {
  const functions = (
    await db.query(`select n.nspname,p.proname,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='public' and p.proname like 'moderator_%') or n.nspname='moderation_private'`)
  ).rows;
  assert.equal(functions.filter((f) => f.nspname === "public").length, 4);
  for (const f of functions) {
    if (f.nspname === "public") assert.equal(f.prosecdef, false);
    assert.ok(f.proconfig.some((s) => s.startsWith("search_path=")));
  }
  for (const role of ["anon", "authenticated", "service_role"])
    for (const table of ["reviewers", "decisions"]) {
      const row = (
        await db.query(
          "select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') allowed",
          [role, `moderation_private.${table}`],
        )
      ).rows[0];
      assert.equal(row.allowed, false);
    }
});
