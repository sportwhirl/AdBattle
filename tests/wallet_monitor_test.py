"""Offline tests: no credentials, desktop delivery, Supabase or Stripe access."""
import contextlib
import copy
import datetime as dt
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("monitor", ROOT / "scripts/monitor_wallet_health.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
NOW = dt.datetime(2026, 9, 23, 9, tzinfo=dt.timezone.utc)


def report():
    return {"report_version": 1, "checked_at": NOW.isoformat(), "health_status": "HEALTHY",
            "checks_total": 29, "nonpassing_checks": 0,
            "checks": [{"check": name, "status": "PASS", "note": "SECRET_RAW_TEXT"} for name in sorted(m.CHECKS)],
            "wallet_summary": {"wallet_count": 1, "wallet_debt_cents": 0,
                               "pending_creator_micros": 0, "unfinished_settlements": 0,
                               "wallet_liability_cents": 300, "pending_platform_micros": 0,
                               "global_payment_risk_hold": False},
            "scheduler_summary": {"job_count": 1, "latest_run": {}, "latest_completed_run": {}}}


def finding(value, name, status):
    next(c for c in value["checks"] if c["check"] == name)["status"] = status
    statuses = [c["status"] for c in value["checks"]]
    value["nonpassing_checks"] = sum(s != "PASS" for s in statuses)
    value["health_status"] = "INCOMPLETE" if "INCOMPLETE" in statuses else "ATTENTION" if value["nonpassing_checks"] else "HEALTHY"


class Response:
    status = 201

    def __init__(self, data):
        self.data = data

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def geturl(self):
        return m.ENDPOINT

    def read(self, limit):
        return self.data[:limit]


class MonitorTests(unittest.TestCase):
    def test_contract_and_redaction(self):
        parsed = m.validate_report([report()], NOW)
        self.assertEqual(parsed["health"], "HEALTHY")
        self.assertEqual(parsed["problems"], {})
        self.assertNotIn("SECRET", json.dumps(parsed))
        self.assertNotIn("300", json.dumps(parsed))
        r = report()
        finding(r, "scheduler_recent_dispatch", "FAIL")
        self.assertEqual(m.validate_report([r], NOW)["problems"], {"scheduler_recent_dispatch": "FAIL"})

    def test_malformed_unknown_duplicate_missing_and_stale_fail_closed(self):
        changes = [lambda r: r.update(report_version=2), lambda r: r.update(checks=[]),
                   lambda r: r.update(checks_total=28), lambda r: r.update(nonpassing_checks=1),
                   lambda r: r["checks"].pop(), lambda r: r["checks"].__setitem__(0, r["checks"][1]),
                   lambda r: r["checks"][0].update(check="attacker secret"),
                   lambda r: r["checks"][0].update(status="UNKNOWN"),
                   lambda r: r.update(wallet_summary={}),
                   lambda r: r["wallet_summary"].update(wallet_liability_cents=True),
                   lambda r: r.update(checked_at="2026-09-23T09:00:00"),
                   lambda r: r.update(health_status="ATTENTION")]
        for change in changes:
            r = report()
            change(r)
            with self.subTest(r=r), self.assertRaisesRegex(m.MonitorError, "invalid_report"):
                m.validate_report([r], NOW)
        for seconds in (181, -31):
            r = report()
            r["checked_at"] = (NOW - dt.timedelta(seconds=seconds)).isoformat()
            with self.assertRaisesRegex(m.MonitorError, "stale_report"):
                m.validate_report([r], NOW)
        for rows in ([], [report(), report()], {}, [None]):
            with self.assertRaises(m.MonitorError):
                m.validate_report(rows, NOW)

    def test_missing_source_is_incomplete_and_skipped_checks_are_accounted_for(self):
        r = report()
        r["checks"] = [c for c in r["checks"] if c["check"] not in m.SCHEDULER_CHECKS]
        r["checks_total"] = len(r["checks"])
        r["scheduler_summary"] = None
        finding(r, "cron.job:read_access", "INCOMPLETE")
        self.assertEqual(m.validate_report([r], NOW)["health"], "INCOMPLETE")
        r["health_status"] = "HEALTHY"
        with self.assertRaises(m.MonitorError):
            m.validate_report([r], NOW)

    def test_request_is_pinned_and_read_only_with_bounded_response(self):
        class Transport:
            def open(this, request, timeout):
                self.assertEqual(request.full_url, m.ENDPOINT)
                self.assertIn(m.PROJECT, request.full_url)
                self.assertEqual(request.method, "POST")
                self.assertEqual(timeout, 45)
                self.assertEqual(json.loads(request.data), {"query": m.report_sql(), "read_only": True})
                self.assertEqual(request.get_header("Authorization"), "Bearer TOKEN_SENTINEL")
                return Response(json.dumps([report()]).encode())
        self.assertEqual(m.fetch_report("TOKEN_SENTINEL", m.report_sql(), lambda: NOW, Transport())["health"], "HEALTHY")
        with patch("urllib.request.build_opener") as build:
            build.return_value.open.return_value = Response(json.dumps([report()]).encode())
            m.fetch_report("TOKEN_SENTINEL", "select 1", lambda: NOW)
            handlers = build.call_args.args
            self.assertEqual(handlers[0].proxies, {})
            self.assertIsInstance(handlers[1], m.NoRedirects)
        with patch.object(m.SQL_PATH.__class__, "read_bytes", return_value=b"delete from wallets"):
            with self.assertRaisesRegex(m.MonitorError, "report_changed"):
                m.report_sql()

    def test_network_errors_redirects_and_raw_bodies_are_not_exposed(self):
        for code in (301, 302, 303, 307, 308):
            with self.assertRaises(m.MonitorError):
                m.NoRedirects().redirect_request(None, None, code, "SECRET", {}, "https://evil.invalid")
        for body in (b"SECRET_ERROR", b"x" * (m.MAX_BYTES + 1), b"\xff"):
            with patch("urllib.request.build_opener") as build:
                build.return_value.open.return_value = Response(body)
                with self.assertRaisesRegex(m.MonitorError, "invalid_report"):
                    m.fetch_report("SECRET_TOKEN", "select 1", lambda: NOW)
        for exc, code in [(TimeoutError("SECRET"), "transport_error"),
                          (urllib.error.HTTPError(m.ENDPOINT, 403, "SECRET", {}, io.BytesIO(b"SECRET")), "http_error"),
                          (urllib.error.HTTPError(m.ENDPOINT, 429, "SECRET", {}, io.BytesIO(b"SECRET")), "rate_limited")]:
            with patch("urllib.request.build_opener") as build:
                build.return_value.open.side_effect = exc
                with self.assertRaisesRegex(m.MonitorError, f"^{code}$"):
                    m.fetch_report("SECRET_TOKEN", "select 1", lambda: NOW)

    def test_incident_deduplication_changed_findings_and_recovery_survive_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "state.json"
            good = m.validate_report([report()], NOW)
            bad_report = report()
            finding(bad_report, "wallet_ledger_balance", "FAIL")
            bad = m.validate_report([bad_report], NOW)
            delivered = []
            def notify(event):
                persisted = m.load_state(path)
                self.assertTrue(any(e["id"] == event["id"] and not e["delivered"] for e in persisted["events"]))
                delivered.append(event["kind"])
                return True
            for observation in [good, bad, bad, good, good]:
                state = m.load_state(path)
                m.cycle(path, state, lambda: observation, notify, lambda: NOW)
            self.assertEqual(delivered, ["PROBLEM", "RECOVERY"])
            self.assertEqual(len(m.load_state(path)["history"]), 5)
            self.assertNotIn("SECRET", path.read_text())
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            state = m.load_state(path)
            m.cycle(path, state, lambda: bad, notify, lambda: NOW)
            changed = copy.deepcopy(bad)
            changed["problems"]["overdue_retries"] = "WARN"
            m.cycle(path, state, lambda: changed, notify, lambda: NOW)
            self.assertEqual(delivered[-2:], ["PROBLEM", "UPDATED"])

    def test_failed_notifications_retry_same_event_then_recover_in_order(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "state.json"
            def unavailable():
                raise m.MonitorError("transport_error")
            state = m.fresh_state()
            summary, code = m.cycle(path, state, unavailable, lambda _: False, lambda: NOW)
            event_id = state["events"][0]["id"]
            self.assertEqual(code, 2)
            self.assertEqual(summary["health"], "MONITOR_ERROR")
            m.cycle(path, m.load_state(path), unavailable, lambda _: False, lambda: NOW)
            self.assertEqual(len(m.load_state(path)["events"]), 1)
            delivered = []
            def notify(event):
                delivered.append((event["kind"], event["id"]))
                return True
            m.cycle(path, m.load_state(path), lambda: m.validate_report([report()], NOW), notify, lambda: NOW)
            self.assertEqual(delivered[0], ("PROBLEM", event_id))
            self.assertEqual(delivered[1][0], "RECOVERY")
            self.assertTrue(all(e["delivered"] for e in m.load_state(path)["events"]))

    def test_private_files_lock_and_corrupt_state(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder) / "private"
            m.private_dir(directory)
            self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
            path = directory / "access-token"
            m.atomic_write(path, "sbp_" + "x" * 40)
            self.assertEqual(m.credential(path), "sbp_" + "x" * 40)
            path.chmod(0o644)
            with self.assertRaises(m.MonitorError):
                m.credential(path)
            path.chmod(0o600)
            symlink = directory / "link"
            symlink.symlink_to(path)
            with self.assertRaises(m.MonitorError):
                m.credential(symlink)
            with m.locked(directory / "lock"):
                with self.assertRaises(BlockingIOError):
                    with m.locked(directory / "lock"):
                        pass
            state_path = directory / "state.json"
            m.atomic_write(state_path, "CORRUPT_SENTINEL")
            with self.assertRaises(ValueError):
                m.load_state(state_path)
            self.assertEqual(state_path.read_text(), "CORRUPT_SENTINEL")
            bad = m.fresh_state()
            bad["project"] = "production"
            m.save_state(state_path, bad)
            with self.assertRaises(ValueError):
                m.load_state(state_path)

    def test_retention_and_full_notification_outbox(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "state.json"
            good = m.validate_report([report()], NOW)
            state = m.fresh_state()
            for _ in range(300):
                m.record(state, good, NOW)
            self.assertEqual(len(state["history"]), 288)
            bad = copy.deepcopy(good)
            bad.update(health="ATTENTION", problems={k: "FAIL" for k in m.CHECKS})
            for i in range(100):
                m.record(state, bad if i % 2 == 0 else good, NOW)
            m.save_state(path, state)
            self.assertEqual(len(m.load_state(path)["events"]), 100)
            with self.assertRaisesRegex(ValueError, "outbox full"):
                m.record(state, bad, NOW)
            delivered = []
            def restored_notifier(event):
                delivered.append(event["id"])
                return True
            m.cycle(path, state, lambda: bad, restored_notifier, lambda: NOW)
            self.assertEqual(len(delivered), 3)
            self.assertEqual(len(state["events"]), 100)

    def test_desktop_delivery_is_bounded_and_does_not_use_shell(self):
        event = {"kind": "PROBLEM", "observation": {"problems": {"http_error": "ERROR"}}}
        with patch("subprocess.run") as run:
            run.return_value.returncode = 0
            self.assertTrue(m.desktop_notify(event))
            self.assertEqual(run.call_args.args[0][0], "/usr/bin/notify-send")
            self.assertNotIn("shell", run.call_args.kwargs)
            self.assertEqual(run.call_args.kwargs["timeout"], 10)
            run.side_effect = FileNotFoundError()
            self.assertFalse(m.desktop_notify(event))

    def test_status_detects_absent_and_stale_observations_without_network(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(Path, "home", return_value=Path(folder)):
            with patch.object(sys := m.sys, "argv", ["monitor", "--status"]), patch.object(m, "fetch_report") as fetch:
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    self.assertEqual(m.main(), 2)
                self.assertEqual(json.loads(output.getvalue())["monitor_status"], "STALE")
                fetch.assert_not_called()
                state = m.fresh_state()
                m.record(state, m.validate_report([report()], NOW), dt.datetime(2000, 1, 1, tzinfo=dt.timezone.utc))
                path = Path(folder) / ".local/state/adbattle-wallet-monitor" / m.PROJECT / "state.json"
                m.save_state(path, state)
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(m.main(), 2)


if __name__ == "__main__":
    unittest.main()
