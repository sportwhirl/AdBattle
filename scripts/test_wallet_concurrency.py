#!/usr/bin/env python3
"""Exercise the real wallet RPCs across independent PostgreSQL connections.

Creates and removes its own cluster. Accepts no database URL or credentials.
Requires Python 3 and PostgreSQL server/client binaries; run as a non-root user.
"""

import argparse
from contextlib import ExitStack, contextmanager
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
import uuid


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = (
    "20260920_wallet_ledger.sql",
    "20260921_wallet_safety.sql",
    "20260922_wallet_capability_recovery.sql",
    "20260923_wallet_balance_recovery.sql",
    "20260923_wallet_table_privileges.sql",
    "20260923093000_paid_seeds.sql",
    "20260923164351_paid_seed_read_rpc_privileges.sql",
)


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


class SqlError(RuntimeError):
    pass


class Session:
    """A persistent psql process; each instance is a separate DB connection."""

    def __init__(self, cluster):
        self.process = subprocess.Popen(
            cluster.psql, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, bufsize=1, env=cluster.env,
        )
        self.lines = queue.Queue()
        self.marker = None
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        self.pid = int(self.query("select pg_backend_pid();")[0])

    def _read(self):
        try:
            for line in self.process.stdout:
                self.lines.put(line.rstrip("\n"))
        finally:
            self.lines.put(None)

    def start(self, sql):
        if self.marker is not None:
            raise RuntimeError("A query is already pending on this connection")
        self.marker = "done_" + uuid.uuid4().hex
        self.process.stdin.write(sql + "\n\\echo " + self.marker + "\n")
        self.process.stdin.flush()

    def finish(self):
        result = []
        deadline = time.monotonic() + 20
        try:
            while True:
                line = self.lines.get(timeout=max(0.01, deadline - time.monotonic()))
                if line is None:
                    raise SqlError("\n".join(result) or "psql exited unexpectedly")
                if line == self.marker:
                    return result
                result.append(line)
        except queue.Empty as error:
            raise TimeoutError("Timed out waiting for psql") from error
        finally:
            self.marker = None

    def query(self, sql):
        self.start(sql)
        return self.finish()

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
        self.reader.join(timeout=5)
        self.process.stdin.close()
        self.process.stdout.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


class Cluster:
    def __init__(self, bindir, directory):
        self.bindir = bindir
        self.directory = Path(directory)
        self.data = self.directory / "data"
        self.socket = self.directory / "socket"
        self.socket.mkdir(mode=0o700)
        # Inherited libpq settings must never redirect tests to an existing DB.
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
        self.env.update(LC_ALL="C", PGOPTIONS="-c statement_timeout=15000 -c lock_timeout=10000")
        self.psql = [str(bindir / "psql"), "-X", "-qAt", "--no-password",
                     "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=terse",
                     "-h", str(self.socket), "-p", "55432", "-U", "wallet_test",
                     "-d", "postgres"]

    def run(self, args, timeout=30):
        result = subprocess.run(args, capture_output=True, text=True,
                                env=self.env, timeout=timeout)
        if result.returncode:
            raise RuntimeError(result.stderr or result.stdout)
        return result.stdout

    def query(self, sql):
        result = subprocess.run(self.psql, input=sql, capture_output=True,
                                text=True, env=self.env, timeout=20)
        if result.returncode:
            raise SqlError(result.stderr)
        return result.stdout.strip()

    def start(self):
        self.run([str(self.bindir / "initdb"), "-D", str(self.data),
                  "-U", "wallet_test", "-A", "trust", "--no-locale", "-E", "UTF8"])
        # No TCP listener; trust auth is confined to this private 0700 directory.
        options = (f"-c listen_addresses='' -c unix_socket_directories='{self.socket}' "
                   "-c unix_socket_permissions=0700 -c port=55432 "
                   "-c max_connections=20 -c shared_buffers=16MB")
        self.run([str(self.bindir / "pg_ctl"), "-D", str(self.data), "-w", "-t", "15",
                  "-l", str(self.directory / "postgres.log"), "-o", options, "start"])
        self.query("create database wallet_concurrency;")
        self.psql[-1] = "wallet_concurrency"
        self.query((ROOT / "tests/fixtures/wallet_concurrency.sql").read_text())
        for name in MIGRATIONS:
            # Apply repository SQL verbatim, including pgcrypto and privileges.
            self.query((ROOT / "supabase/migrations" / name).read_text())

    def stop(self):
        if (self.data / "postmaster.pid").exists():
            self.run([str(self.bindir / "pg_ctl"), "-D", str(self.data),
                      "-m", "immediate", "-w", "-t", "15", "stop"])

    def wait_for_locks(self, sessions):
        pids = [s.pid for s in sessions]
        if len(pids) != len(set(pids)):
            raise AssertionError("Workers must use distinct PostgreSQL backends")
        deadline = time.monotonic() + 5
        observed = []
        while time.monotonic() < deadline:
            observed = json.loads(self.query(f"""
                select coalesce(jsonb_agg(jsonb_build_object(
                  'pid', pid, 'state', state, 'wait', wait_event_type,
                  'blockers', pg_blocking_pids(pid))), '[]'::jsonb)
                from pg_stat_activity where pid in ({','.join(map(str, pids))});
            """))
            if len(observed) == len(pids) and all(
                r["state"] == "active" and r["wait"] == "Lock" and r["blockers"]
                for r in observed
            ):
                print(f"  observed {len(pids)} independent blocked requests: {observed}", flush=True)
                return
            if any(s.process.poll() is not None for s in sessions):
                break
            time.sleep(0.05)
        raise AssertionError(f"Requests did not overlap at the lock barrier: {observed}")


class WalletConcurrency(unittest.TestCase):
    cluster = None
    next_ad = 0

    def setUp(self):
        self.users = [str(uuid.uuid4()), str(uuid.uuid4())]
        self.creator = str(uuid.uuid4())
        type(self).next_ad += 2
        self.ads = [self.next_ad - 1, self.next_ad]
        self.cluster.query(
            "insert into auth.users values " +
            ",".join(f"({literal(u)})" for u in [*self.users, self.creator]) + ";" +
            "insert into public.ads(id,user_id) values " +
            ",".join(f"({ad},{literal(self.creator)})" for ad in self.ads) + ";"
        )
        for user in self.users:
            self.cluster.query(f"""set role service_role;
                select public.record_wallet_topup(
                  'cs_fixture_{user}', 'pi_fixture_{user}', {literal(user)}, 1000);
            """)

    def request(self, user=0, ad=0, cents=1, key=None):
        return {"user": self.users[user], "ad": self.ads[ad], "cents": cents,
                "key": key or str(uuid.uuid4())}

    @staticmethod
    def spend(request):
        return ("set role service_role; select public.spend_wallet_support("
                f"{literal(request['user'])},{request['ad']},{request['cents']},"
                f"{literal(request['key'])});")

    @staticmethod
    def seed(request):
        return ("set role service_role; select public.seed_ad_from_wallet("
                f"{literal(request['user'])},{request['ad']},"
                f"{literal(request['key'])});")

    @contextmanager
    def blocked_requests(self, blocker_sql, requests, operation=None):
        operation = operation or self.spend
        with ExitStack() as stack:
            blocker = stack.enter_context(Session(self.cluster))
            blocker.query("begin; " + blocker_sql)
            sessions = [stack.enter_context(Session(self.cluster)) for _ in requests]
            for session, request in zip(sessions, requests):
                session.start(operation(request))
            self.cluster.wait_for_locks(sessions)
            blocker.query("commit;")
            yield sessions

    def race(self, requests, lock_ad=False, operation=None):
        if lock_ad:
            lock = f"select id from public.ads where id={self.ads[0]} for update;"
        else:
            lock = ("select user_id from public.wallets where user_id="
                    f"{literal(self.users[0])} for update;")
        with self.blocked_requests(lock, requests, operation) as sessions:
            results = []
            for session in sessions:
                try:
                    results.append(json.loads(session.finish()[0]))
                except SqlError as error:
                    results.append(error)
            return results

    def assert_accounting(self, requests, refunded=0):
        user_list = ",".join(map(literal, self.users))
        ad_list = ",".join(map(str, self.ads))
        snapshot = json.loads(self.cluster.query(f"""
          select jsonb_build_object(
            'wallets', (select jsonb_agg(to_jsonb(w)) from public.wallets w
                        where user_id in ({user_list})),
            'ledger', (select jsonb_agg(to_jsonb(t) order by id) from public.wallet_transactions t
                       where user_id in ({user_list})),
            'supports', (select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb)
                         from public.supports s where ad_id in ({ad_list})),
            'ads', (select jsonb_agg(to_jsonb(a)) from public.ads a where id in ({ad_list})),
            'accruals', (select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb)
                        from public.ad_settlement_state s where ad_id in ({ad_list}))
          );
        """))
        expected = {r["key"]: r for r in requests}
        self.assertEqual(len(expected), len(requests))
        self.assertEqual(len(snapshot["supports"]), len(requests))
        debits = [t for t in snapshot["ledger"] if t["entry_type"] == "support_debit"]
        self.assertEqual(len(debits), len(requests))
        self.assertEqual({t["request_id"] for t in debits}, set(expected))
        supports = {s["wallet_request_id"]: s for s in snapshot["supports"]}
        for debit in debits:
            r = expected[debit["request_id"]]
            support = supports[r["key"]]
            self.assertEqual((debit["user_id"], debit["ad_id"], debit["amount_cents"]),
                             (r["user"], r["ad"], -r["cents"]))
            self.assertEqual(debit["support_id"], support["id"])
            self.assertEqual((support["user_id"], support["ad_id"]), (r["user"], r["ad"]))
            self.assertEqual(support["creator_amount_micros"], r["cents"] * 9000)
            self.assertEqual(support["platform_amount_micros"], r["cents"] * 1000)
        for wallet in snapshot["wallets"]:
            user = wallet["user_id"]
            spent = sum(r["cents"] for r in requests if r["user"] == user)
            refund = refunded if user == self.users[0] else 0
            self.assertEqual(wallet["available_cents"], 1000 - spent - refund)
            self.assertEqual(wallet["lifetime_topup_cents"], 1000)
            self.assertEqual(wallet["lifetime_support_cents"], spent)
            self.assertEqual(wallet["status"], "frozen" if refund else "active")
            running = 0
            ledger = [t for t in snapshot["ledger"] if t["user_id"] == user]
            self.assertEqual(sum(t["entry_type"] == "topup" for t in ledger), 1)
            self.assertEqual(sum(t["entry_type"] == "refund" for t in ledger), bool(refund))
            self.assertTrue(all(t["entry_type"] in ("topup", "support_debit", "refund") for t in ledger))
            for entry in ledger:
                running += entry["amount_cents"]
                self.assertEqual(entry["balance_after_cents"], running)
            self.assertEqual(running, wallet["available_cents"])
        accruals = {s["ad_id"]: s for s in snapshot["accruals"]}
        for ad in snapshot["ads"]:
            total = sum(r["cents"] for r in requests if r["ad"] == ad["id"])
            self.assertEqual(round(ad["support_total"] * 100), total)
            if total:
                state = accruals[ad["id"]]
                self.assertEqual(state["lifetime_support_cents"], total)
                self.assertEqual(state["pending_creator_micros"], total * 9000)
                self.assertEqual(state["pending_platform_micros"], total * 1000)
            else:
                self.assertNotIn(ad["id"], accruals)

    def test_duplicate_one_cent_request_debits_once(self):
        request = self.request()
        results = self.race([request, request])
        self.assertTrue(all(isinstance(r, dict) for r in results), results)
        self.assertEqual(sorted(r["recorded"] for r in results), [False, True])
        self.assertEqual(results[0]["support_id"], results[1]["support_id"])
        self.assertEqual([r["balance_cents"] for r in results], [999, 999])
        self.assert_accounting([request])

    def test_distinct_concurrent_seed_requests_debit_once(self):
        requests = [self.request(), self.request()]
        results = self.race(requests, operation=self.seed)
        self.assertTrue(all(isinstance(r, dict) for r in results), results)
        self.assertEqual(
            sorted(r["already_seeded"] for r in results),
            [False, True],
        )
        marker = json.loads(self.cluster.query(f"""
          select to_jsonb(s) from public.ad_seeds s
          where s.user_id={literal(self.users[0])}
            and s.ad_id={self.ads[0]};
        """))
        winner = next(r for r in requests if r["key"] == marker["wallet_request_id"])
        self.assert_accounting([winner])
        self.assertEqual(self.cluster.query(
            f"select source from public.supports where id={marker['support_id']};"
        ), "wallet_seed")

    def test_two_requests_cannot_overspend_across_ads(self):
        requests = [self.request(cents=700), self.request(ad=1, cents=700)]
        results = self.race(requests)
        winners = [r for r, result in zip(requests, results) if isinstance(result, dict)]
        failures = [result for result in results if isinstance(result, SqlError)]
        self.assertEqual(len(winners), 1, results)
        self.assertEqual(len(failures), 1, results)
        self.assertIn("INSUFFICIENT_WALLET_BALANCE", str(failures[0]))
        self.assert_accounting(winners)

    def test_distinct_affordable_requests_both_commit(self):
        requests = [self.request(cents=400), self.request(ad=1, cents=600)]
        results = self.race(requests)
        self.assertTrue(all(isinstance(r, dict) and r["recorded"] for r in results), results)
        self.assert_accounting(requests)

    def assert_conflicting_requests(self, requests):
        results = self.race(requests)
        winners = [r for r, result in zip(requests, results) if isinstance(result, dict)]
        failures = [result for result in results if isinstance(result, SqlError)]
        self.assertEqual(len(winners), 1, results)
        self.assertEqual(len(failures), 1, results)
        self.assertIn("REQUEST_ID_CONFLICT", str(failures[0]))
        self.assert_accounting(winners)

    def test_duplicate_key_with_changed_amount_conflicts(self):
        request = self.request()
        self.assert_conflicting_requests([request, {**request, "cents": 2}])

    def test_duplicate_key_with_changed_ad_conflicts(self):
        request = self.request()
        self.assert_conflicting_requests([request, {**request, "ad": self.ads[1]}])

    def test_two_wallets_supporting_same_ad_preserve_totals(self):
        requests = [self.request(cents=1), self.request(user=1, cents=2)]
        results = self.race(requests, lock_ad=True)
        self.assertTrue(all(isinstance(r, dict) and r["recorded"] for r in results), results)
        self.assert_accounting(requests)

    def test_waiting_support_observes_committed_refund_hold(self):
        user = self.users[0]
        risk = ("set local role service_role; select public.record_wallet_payment_risk("
                f"'pi_fixture_{user}',{literal(user)},100,false,"
                f"'evt_fixture_{user}','charge.refunded');")
        with self.blocked_requests(risk, [self.request()]) as sessions:
            with self.assertRaisesRegex(SqlError, "WALLET_FROZEN"):
                sessions[0].finish()
        self.assert_accounting([], refunded=100)
        self.assertEqual(self.cluster.query(
            "select count(*) from public.wallet_payment_risks where user_id="
            f"{literal(user)} and resolved_at is null;"), "1")


def postgres_directory(explicit):
    if explicit:
        directory = Path(explicit).resolve()
    elif shutil.which("pg_config"):
        directory = Path(subprocess.check_output(["pg_config", "--bindir"], text=True).strip())
    elif shutil.which("initdb"):
        directory = Path(shutil.which("initdb")).resolve().parent
    else:
        raise RuntimeError("Install PostgreSQL server/client binaries, or pass --postgres-bin DIR.")
    for name in ("initdb", "pg_ctl", "psql", "postgres"):
        if not os.access(directory / name, os.X_OK):
            raise RuntimeError(f"Missing PostgreSQL binary: {directory / name}")
    return directory


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--postgres-bin", help="Directory containing initdb, pg_ctl, psql and postgres")
    args = parser.parse_args()
    if os.geteuid() == 0:
        parser.error("Run as an ordinary user; PostgreSQL refuses to initialize as root.")
    bindir = postgres_directory(args.postgres_bin)
    print(subprocess.check_output([str(bindir / "postgres"), "--version"], text=True).strip(), flush=True)
    # A private path also prevents collisions between concurrent runner instances.
    with tempfile.TemporaryDirectory(prefix="adbattle-concurrency-", dir="/tmp") as directory:
        cluster = Cluster(bindir, directory)
        try:
            cluster.start()
            WalletConcurrency.cluster = cluster
            suite = unittest.defaultTestLoader.loadTestsFromTestCase(WalletConcurrency)
            result = unittest.TextTestRunner(verbosity=2).run(suite)
            return 0 if result.wasSuccessful() else 1
        finally:
            cluster.stop()


if __name__ == "__main__":
    raise SystemExit(main())
