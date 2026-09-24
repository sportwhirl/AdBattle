#!/usr/bin/env python3
"""Independent adbattle-test health reader; no payment or repair operations."""

import argparse
import contextlib
import datetime as dt
import fcntl
import getpass
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import uuid

PROJECT = "nccqnrcdygujulrnwair"
ENDPOINT = f"https://api.supabase.com/v1/projects/{PROJECT}/database/query"
ROOT = Path(__file__).resolve().parents[1]
SQL_PATH = ROOT / "supabase/staging/check_wallet_health.sql"
SQL_SHA256 = "bb3ab3934be1972b89bf38caab5551fd3a2d71fff6e5ff99530b36e781ce5978"
MAX_BYTES = 256 * 1024
MAX_AGE = 180
STALE_AFTER = 12 * 60
WALLET_CHECKS = {
    "wallet_ledger_balance", "wallet_lifetime_totals", "negative_wallet_balances",
    "frozen_wallets", "unresolved_payment_risks", "risk_wallet_hold_consistency",
    "retrying_settlements", "overdue_retries", "stale_processing_settlements",
    "manual_review_settlements", "expired_transfer_retry_windows",
    "unfinished_settlement_integrity", "changed_transfer_destinations",
    "completed_settlement_integrity", "active_settlement_pointers",
    "eligible_unclaimed_settlements", "eligible_creator_not_ready",
}
SCHEDULER_CHECKS = {
    "scheduler_configuration", "scheduler_recent_dispatch", "scheduler_last_completion",
}
ACCESS_CHECKS = {
    **{f"public.{name}:read_access": "wallet" for name in (
        "wallets", "wallet_transactions", "wallet_payment_risks", "wallet_transfer_guards",
        "support_settlements", "ad_settlement_state", "creator_accounts")},
    "cron.job:read_access": "scheduler", "cron.job_run_details:read_access": "scheduler",
}
CHECKS = WALLET_CHECKS | SCHEDULER_CHECKS | ACCESS_CHECKS.keys()
ERRORS = {"credential_unavailable", "report_changed", "http_error", "transport_error",
          "invalid_report", "stale_report", "rate_limited"}


class MonitorError(Exception):
    """Only fixed codes may reach logs or notification text."""


def timestamp(now):
    return now.isoformat()


def parse_time(value):
    if not isinstance(value, str):
        raise ValueError("timestamp")
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timezone")
    return parsed


def integer(value):
    if type(value) is not int or value < 0:
        raise ValueError("count")
    return value


def validate_report(rows, now):
    """Require the versioned contract; never log or persist raw API text."""
    try:
        if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
            raise ValueError("rows")
        report = rows[0]
        if type(report.get("report_version")) is not int or report["report_version"] != 1:
            raise ValueError("version")
        checked = parse_time(report["checked_at"])
        age = (now - checked).total_seconds()
        if age > MAX_AGE or age < -30:
            raise MonitorError("stale_report")
        checks = report["checks"]
        if not isinstance(checks, list) or not checks or len(checks) > len(CHECKS):
            raise ValueError("checks")
        statuses = {}
        for item in checks:
            name, status_value = item["check"], item["status"]
            if name not in CHECKS or name in statuses or status_value not in {"PASS", "WARN", "FAIL", "INCOMPLETE"}:
                raise ValueError("check")
            if name in ACCESS_CHECKS and status_value not in {"PASS", "INCOMPLETE"}:
                raise ValueError("access")
            statuses[name] = status_value
        if not ACCESS_CHECKS.keys() <= statuses.keys():
            raise ValueError("access missing")
        expected = set(ACCESS_CHECKS)
        for source, names in (("wallet", WALLET_CHECKS), ("scheduler", SCHEDULER_CHECKS)):
            ready = all(statuses[n] == "PASS" for n, s in ACCESS_CHECKS.items() if s == source)
            if ready:
                expected |= names
            summary = report[f"{source}_summary"]
            if ready != isinstance(summary, dict):
                raise ValueError("summary")
            if not ready and summary is not None:
                raise ValueError("skipped summary")
            if ready and source == "wallet":
                for key in ("wallet_count", "wallet_debt_cents", "pending_creator_micros",
                            "unfinished_settlements", "wallet_liability_cents", "pending_platform_micros"):
                    integer(summary[key])
                if type(summary["global_payment_risk_hold"]) is not bool:
                    raise ValueError("risk flag")
            if ready and source == "scheduler":
                integer(summary["job_count"])
                for key in ("latest_run", "latest_completed_run"):
                    if summary[key] is not None and not isinstance(summary[key], dict):
                        raise ValueError("run")
        if set(statuses) != expected:
            raise ValueError("missing checks")
        problems = {k: v for k, v in statuses.items() if v != "PASS"}
        health = "INCOMPLETE" if "INCOMPLETE" in statuses.values() else "ATTENTION" if problems else "HEALTHY"
        if report["health_status"] != health or integer(report["checks_total"]) != len(statuses):
            raise ValueError("health")
        if integer(report["nonpassing_checks"]) != len(problems):
            raise ValueError("totals")
        return {"health": health, "checked_at": timestamp(checked), "problems": problems}
    except MonitorError:
        raise
    except (KeyError, TypeError, ValueError, OverflowError):
        raise MonitorError("invalid_report") from None


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise MonitorError("transport_error")


def fetch_report(token, sql, now_fn, opener=None):
    # Fixed host/project, no ambient proxy/netrc, TLS certificate verification,
    # and no redirect carrying a Management API token to another destination.
    opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirects())
    request = urllib.request.Request(ENDPOINT, method="POST", data=json.dumps({
        "query": sql, "read_only": True,
    }).encode(), headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with opener.open(request, timeout=45) as response:
            if response.status not in (200, 201) or response.geturl() != ENDPOINT:
                raise MonitorError("http_error")
            raw = response.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise MonitorError("invalid_report")
        rows = json.loads(raw)
    except urllib.error.HTTPError as exc:
        exc.close()
        raise MonitorError("rate_limited" if exc.code == 429 else "http_error") from None
    except MonitorError:
        raise
    except (ValueError, UnicodeError):
        raise MonitorError("invalid_report") from None
    except (OSError, urllib.error.URLError, http.client.HTTPException):
        raise MonitorError("transport_error") from None
    return validate_report(rows, now_fn())


def private_dir(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError("private directory required")


def private_open(path, flags=os.O_RDONLY):
    fd = os.open(path, flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
        os.close(fd)
        raise ValueError("private regular file required")
    return fd


def read_private(path, limit=MAX_BYTES):
    with os.fdopen(private_open(path), "r") as stream:
        text = stream.read(limit + 1)
    if len(text) > limit:
        raise ValueError("oversized file")
    return text


def atomic_write(path, text):
    # Refuse existing symlinks or permissive files, rather than silently repair.
    if path.exists() or path.is_symlink():
        os.close(private_open(path))
    fd, temporary = tempfile.mkstemp(prefix=".monitor-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        parent_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(parent_fd)
        finally:
            os.close(parent_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def credential(path):
    try:
        value = read_private(path, 4096).strip()
        if not re.fullmatch(r"sbp_[A-Za-z0-9_-]{20,4000}", value):
            raise ValueError("not a Management API token")
        return value
    except (OSError, ValueError, UnicodeError):
        raise MonitorError("credential_unavailable") from None


def report_sql():
    try:
        raw = SQL_PATH.read_bytes()
        if hashlib.sha256(raw).hexdigest() != SQL_SHA256:
            raise ValueError("review changed report first")
        return raw.decode()
    except (OSError, ValueError):
        raise MonitorError("report_changed") from None


def fresh_state():
    return {"version": 1, "project": PROJECT, "last": None, "history": [], "events": []}


def validate_observation(item):
    if item["health"] not in {"HEALTHY", "ATTENTION", "INCOMPLETE", "MONITOR_ERROR"}:
        raise ValueError("health")
    parse_time(item["observed_at"])
    if item["checked_at"] is not None:
        parse_time(item["checked_at"])
    problems = item["problems"]
    if not isinstance(problems, dict) or len(problems) > len(CHECKS):
        raise ValueError("problems")
    for name, status_value in problems.items():
        if name not in CHECKS | ERRORS or status_value not in {"WARN", "FAIL", "INCOMPLETE", "ERROR"}:
            raise ValueError("finding")
    if (item["health"] == "HEALTHY") != (not problems):
        raise ValueError("health mismatch")


def load_state(path):
    if not path.exists() and not path.is_symlink():
        return fresh_state()
    state = json.loads(read_private(path, 4 * 1024 * 1024))
    if state["version"] != 1 or state["project"] != PROJECT:
        raise ValueError("state identity")
    if not isinstance(state["history"], list) or not isinstance(state["events"], list) or len(state["history"]) > 288 or len(state["events"]) > 100:
        raise ValueError("state bounds")
    if state["last"] is not None:
        validate_observation(state["last"])
    for item in state["history"]:
        validate_observation(item)
    for item in state["events"]:
        uuid.UUID(item["id"])
        if item["kind"] not in {"PROBLEM", "UPDATED", "RECOVERY"} or type(item["delivered"]) is not bool:
            raise ValueError("event")
        validate_observation(item["observation"])
    return state


def record(state, observation, now):
    observation = {**observation, "observed_at": timestamp(now)}
    previous = state["last"]
    changed = observation["problems"] != (previous["problems"] if previous else {})
    if changed:
        # Keep undelivered transitions. If their bounded outbox is exhausted,
        # fail visibly instead of dropping events or claiming notification.
        if len(state["events"]) == 100:
            delivered = next((i for i, e in enumerate(state["events"]) if e["delivered"]), None)
            if delivered is None:
                raise ValueError("notification outbox full")
            del state["events"][delivered]
        kind = "RECOVERY" if not observation["problems"] else "UPDATED" if previous and previous["problems"] else "PROBLEM"
        state["events"].append({"id": str(uuid.uuid4()), "kind": kind,
                                "observation": observation, "delivered": False})
    state["last"] = observation
    state["history"] = (state["history"] + [observation])[-288:]


def desktop_notify(event):
    # No shell, credentials, balances, raw API text, or user-supplied content.
    names = ", ".join(sorted(event["observation"]["problems"])) or "All database and cron checks passed."
    try:
        result = subprocess.run([
            "/usr/bin/notify-send", "--app-name=AdBattle staging monitor",
            "--urgency=normal" if event["kind"] == "RECOVERY" else "--urgency=critical",
            f"AdBattle test: {event['kind'].lower()}", names,
        ], timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def save_state(path, state):
    atomic_write(path, json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n")


def deliver_pending(path, state, notify, budget):
    attempted = 0
    if notify:
        for event in state["events"]:
            if event["delivered"]:
                continue
            if attempted >= budget:
                break
            attempted += 1
            if not notify(event):
                break
            event["delivered"] = True
            save_state(path, state)
    return attempted


def cycle(path, state, poll, notify, now_fn):
    try:
        observation = poll()
    except MonitorError as exc:
        code = str(exc) if str(exc) in ERRORS else "transport_error"
        observation = {"health": "MONITOR_ERROR", "checked_at": None, "problems": {code: "ERROR"}}
    attempts = 0
    if len(state["events"]) == 100 and not any(e["delivered"] for e in state["events"]):
        # A restored notifier must be able to drain a full outbox. Deliver only
        # previously persisted events here; never drop one to make room.
        attempts = deliver_pending(path, state, notify, 3)
    record(state, observation, now_fn())
    save_state(path, state)  # Persist the observation/event BEFORE notification.
    deliver_pending(path, state, notify, 3 - attempts)
    pending = sum(not event["delivered"] for event in state["events"])
    summary = {"project": "adbattle-test", **state["last"], "pending_notifications": pending}
    return summary, 2 if pending else 0 if observation["health"] == "HEALTHY" else 1


@contextlib.contextmanager
def locked(path):
    fd = private_open(path, os.O_RDWR | os.O_CREAT)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--configure", action="store_true", help="Save a Management API token using a hidden local prompt; no network call")
    mode.add_argument("--status", action="store_true", help="Read private local status without a network call")
    parser.add_argument("--notify-desktop", action="store_true", help="Deliver queued transitions to the local desktop")
    args = parser.parse_args()
    config = Path.home() / ".config/adbattle-wallet-monitor"
    directory = Path.home() / ".local/state/adbattle-wallet-monitor" / PROJECT
    token_path, state_path = config / "access-token", directory / "state.json"
    now_fn = lambda: dt.datetime.now(dt.timezone.utc)
    try:
        private_dir(directory)
        with locked(directory / "monitor.lock"):
            if args.configure:
                if not sys.stdin.isatty():
                    raise ValueError("hidden terminal prompt required")
                private_dir(config)
                token = getpass.getpass("Supabase Management API access token (hidden): ").strip()
                if not re.fullmatch(r"sbp_[A-Za-z0-9_-]{20,4000}", token):
                    raise ValueError("invalid token format")
                atomic_write(token_path, token + "\n")
                print("Token saved privately. No network request or timer activation was performed.")
                return 0
            state = load_state(state_path)
            if args.status:
                last = state["last"]
                age = (now_fn() - parse_time(last["observed_at"])).total_seconds() if last else None
                stale = age is None or age < -30 or age > STALE_AFTER
                print(json.dumps({"project": "adbattle-test", "monitor_status": "STALE" if stale else "RECENT",
                                  "last": last, "pending_notifications": sum(not e["delivered"] for e in state["events"])}))
                return 2 if stale else 0
            def poll():
                try:
                    private_dir(config)
                except (OSError, ValueError):
                    raise MonitorError("credential_unavailable") from None
                return fetch_report(credential(token_path), report_sql(), now_fn)
            summary, exit_code = cycle(state_path, state, poll, desktop_notify if args.notify_desktop else None, now_fn)
            print(json.dumps(summary))
            return exit_code
    except BlockingIOError:
        print("MONITOR_BUSY: another local run holds the lock.", file=sys.stderr)
        return 3
    except (OSError, ValueError, TypeError, KeyError):
        # Do not erase unreadable/corrupt state: it may contain pending alerts.
        print("MONITOR_LOCAL_ERROR: inspect private state/config permissions, format, disk space, and notification backlog; state was not reset.", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
