import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import test from 'node:test';

test('independent staging wallet monitor: offline safety, state, and notification tests', () => {
  const result = spawnSync('python3', ['tests/wallet_monitor_test.py'], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('monitor accepts the actual report with missing wallet/cron sources as INCOMPLETE', async () => {
  const db = new PGlite();
  try {
    const sql = readFileSync(new URL('../supabase/staging/check_wallet_health.sql', import.meta.url), 'utf8');
    const report = (await db.query(sql)).rows;
    const result = spawnSync('python3', ['-c', `
import datetime, json, runpy, sys
m = runpy.run_path('scripts/monitor_wallet_health.py')
r = m['validate_report'](json.load(sys.stdin), datetime.datetime.now(datetime.timezone.utc))
assert r['health'] == 'INCOMPLETE'
assert len(r['problems']) == 9
`], { cwd: new URL('../', import.meta.url), input: JSON.stringify(report), encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { await db.close(); }
});
