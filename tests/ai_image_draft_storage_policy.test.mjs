import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(new URL(
  '../supabase/migrations/20260924015116_harden_ai_draft_storage.sql',
  import.meta.url), 'utf8');

async function storageDatabase({ draftBucket = 'private' } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema storage;
    create table storage.buckets (
      id text primary key,
      public boolean not null
    );
    create table storage.objects (
      bucket_id text not null,
      name text not null,
      primary key (bucket_id, name)
    );
    alter table storage.objects enable row level security;
    grant usage on schema storage to anon, authenticated, service_role;
    grant all on storage.objects to anon, authenticated, service_role;
    insert into storage.buckets values ('other-private-bucket', false);

    -- Model unrelated hosted policies that are dangerously broad. The new
    -- restrictive policies must win for every draft-bucket operation.
    create policy broad_anon_storage_access on storage.objects
      for all to anon using (true) with check (true);
    create policy broad_authenticated_storage_access on storage.objects
      for all to authenticated using (true) with check (true);
  `);
  if (draftBucket !== 'missing') {
    await db.query(`
      insert into storage.buckets values ('ai-image-drafts', $1)
    `, [draftBucket === 'public']);
  }
  return db;
}

async function database() {
  const db = await storageDatabase();
  await db.exec(migration);
  await db.exec(`
    insert into storage.objects values
      ('ai-image-drafts', 'seeded-draft.png'),
      ('other-private-bucket', 'anon-source.png'),
      ('other-private-bucket', 'authenticated-source.png');
  `);
  return db;
}

for (const draftBucket of ['missing', 'public']) {
  test(`migration aborts when the draft bucket is ${draftBucket}`, async () => {
    const db = await storageDatabase({ draftBucket });
    try {
      await assert.rejects(
        db.exec(migration),
        /AI_DRAFT_BUCKET_MUST_BE_PRIVATE/,
      );

      // Make the failed transaction queryable, then prove no policy from the
      // migration survived the guard exception.
      await db.exec('rollback');
      assert.deepEqual((await db.query(`
        select policyname
        from pg_policies
        where schemaname = 'storage'
          and tablename = 'objects'
          and policyname like 'ai_draft_server_only_%'
      `)).rows, []);
    } finally {
      await db.close();
    }
  });
}

test('draft bucket policies are restrictive and cover every Storage command', async () => {
  const db = await database();
  try {
    const policies = (await db.query(`
      select policyname, cmd, permissive
      from pg_policies
      where schemaname = 'storage'
        and tablename = 'objects'
        and policyname like 'ai_draft_server_only_%'
      order by cmd
    `)).rows;
    assert.deepEqual(policies, [
      { policyname: 'ai_draft_server_only_delete', cmd: 'DELETE', permissive: 'RESTRICTIVE' },
      { policyname: 'ai_draft_server_only_insert', cmd: 'INSERT', permissive: 'RESTRICTIVE' },
      { policyname: 'ai_draft_server_only_select', cmd: 'SELECT', permissive: 'RESTRICTIVE' },
      { policyname: 'ai_draft_server_only_update', cmd: 'UPDATE', permissive: 'RESTRICTIVE' },
    ]);
  } finally {
    await db.close();
  }
});

for (const role of ['anon', 'authenticated']) {
  test(`broad ${role} policy cannot grant draft SELECT, INSERT, UPDATE, or DELETE`, async () => {
    const db = await database();
    try {
      await db.exec(`set role ${role}`);

      assert.deepEqual((await db.query(`
        select name from storage.objects
        where bucket_id = 'ai-image-drafts'
      `)).rows, []);

      // The restrictive policies target only the draft bucket. Applicable
      // permissive policies must continue to grant every operation elsewhere.
      assert.deepEqual((await db.query(`
        select name from storage.objects
        where bucket_id = 'other-private-bucket'
          and name = $1
      `, [`${role}-source.png`])).rows, [{ name: `${role}-source.png` }]);

      await db.query(`
        insert into storage.objects values ('other-private-bucket', $1)
      `, [`${role}-insert.png`]);
      assert.deepEqual((await db.query(`
        update storage.objects set name = $1
        where bucket_id = 'other-private-bucket'
          and name = $2
        returning name
      `, [`${role}-updated.png`, `${role}-insert.png`])).rows, [
        { name: `${role}-updated.png` },
      ]);
      assert.deepEqual((await db.query(`
        delete from storage.objects
        where bucket_id = 'other-private-bucket'
          and name = $1
        returning name
      `, [`${role}-updated.png`])).rows, [{ name: `${role}-updated.png` }]);

      await assert.rejects(db.query(`
        insert into storage.objects values ('ai-image-drafts', 'client-insert.png')
      `), /row-level security/);

      assert.deepEqual((await db.query(`
        update storage.objects set name = 'client-update.png'
        where bucket_id = 'ai-image-drafts'
        returning name
      `)).rows, []);

      assert.deepEqual((await db.query(`
        delete from storage.objects
        where bucket_id = 'ai-image-drafts'
        returning name
      `)).rows, []);

      await assert.rejects(db.query(`
        update storage.objects set bucket_id = 'ai-image-drafts'
        where bucket_id = 'other-private-bucket'
          and name = $1
      `, [`${role}-source.png`]), /row-level security/);
    } finally {
      await db.exec('reset role');
      await db.close();
    }
  });
}

test('service_role bypass retains full draft bucket access', async () => {
  const db = await database();
  try {
    await db.exec('set role service_role');
    assert.deepEqual((await db.query(`
      select name from storage.objects
      where bucket_id = 'ai-image-drafts'
      order by name
    `)).rows, [{ name: 'seeded-draft.png' }]);

    await db.query(`
      insert into storage.objects values ('ai-image-drafts', 'service-insert.png')
    `);
    assert.deepEqual((await db.query(`
      update storage.objects set name = 'service-update.png'
      where bucket_id = 'ai-image-drafts' and name = 'service-insert.png'
      returning name
    `)).rows, [{ name: 'service-update.png' }]);
    assert.deepEqual((await db.query(`
      delete from storage.objects
      where bucket_id = 'ai-image-drafts'
      returning name
    `)).rows.map(row => row.name).sort(), [
      'seeded-draft.png',
      'service-update.png',
    ]);
  } finally {
    await db.exec('reset role');
    await db.close();
  }
});
