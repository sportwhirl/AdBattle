#!/usr/bin/env python3
"""Two-user hosted wallet read-isolation test, fixed to adbattle-test.

Only Auth sign-in POSTs and allowlisted GETs are permitted. No database writes,
RPC calls, Edge Function calls, payments or local credential/state files.
Run the companion check_wallet_access.sql first to audit write privileges.
"""
import argparse
import base64
import getpass
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import warnings
from dataclasses import dataclass

PROJECT = "nccqnrcdygujulrnwair"
BASE = f"https://{PROJECT}.supabase.co"
# table: (owner column, primary key, selected columns)
TABLES = {
    "wallets": ("user_id", "user_id", "user_id,available_cents,status,lifetime_topup_cents,lifetime_support_cents"),
    "wallet_topups": ("user_id", "id", "id,user_id"),
    "wallet_transactions": ("user_id", "id", "id,user_id"),
    "ad_settlement_state": ("creator_user_id", "ad_id", "ad_id,creator_user_id"),
    "support_settlements": ("creator_user_id", "id", "id,creator_user_id"),
}
PRIVATE = ("wallet_payment_risks", "wallet_payment_risk_events", "wallet_transfer_guards")
MAX_BYTES = 1024 * 1024
PAGE_SIZE = 100
MAX_ROWS = 5000


class Stopped(Exception):
    """Safe, fixed diagnostic without credentials or response bodies."""


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def decode_jwt(value):
    try:
        parts = value.split(".")
        if len(parts) != 3:
            raise ValueError()
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
        if not isinstance(payload, dict):
            raise ValueError()
        return payload
    except (ValueError, TypeError, UnicodeError):
        raise Stopped("Invalid JWT structure.") from None


def check_public_key(key):
    if re.fullmatch(r"sb_publishable_[A-Za-z0-9_-]{8,}", key):
        return
    try:
        claims = decode_jwt(key)
        if claims.get("role") == "anon" and claims.get("ref") == PROJECT:
            return
    except Stopped:
        pass
    raise Stopped("Use only adbattle-test's publishable or legacy anon key; no service-role, secret or Stripe keys.")


@dataclass
class Response:
    status: int
    data: object
    headers: dict


class Api:
    def __init__(self, key):
        check_public_key(key)
        self.key = key
        self.http = urllib.request.build_opener(NoRedirects())

    def request(self, method, path, token=None, body=None):
        parsed = urllib.parse.urlsplit(path)
        allowed_get = {"/auth/v1/settings", "/auth/v1/user"} | {
            "/rest/v1/" + t for t in (*TABLES, *PRIVATE)
        }
        if parsed.scheme or parsed.netloc or parsed.fragment:
            raise Stopped("Request target refused.")
        if method == "POST":
            if path != "/auth/v1/token?grant_type=password" or not isinstance(body, dict) or set(body) != {"email", "password"}:
                raise Stopped("Only an ordinary Auth password sign-in POST is permitted.")
        elif method != "GET" or parsed.path not in allowed_get or body is not None:
            raise Stopped("Only allowlisted reads are permitted.")
        headers = {"apikey": self.key, "Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        if parsed.path.startswith("/rest/v1/"):
            headers["Prefer"] = "count=exact"
        req = urllib.request.Request(BASE + path, method=method, headers=headers,
            data=None if body is None else json.dumps(body).encode())
        try:
            response = self.http.open(req, timeout=25)
        except urllib.error.HTTPError as error:
            response = error
        except (urllib.error.URLError, TimeoutError, OSError):
            raise Stopped("Network request failed; no wallet operation was attempted.") from None
        with response:
            raw = response.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise Stopped("Response exceeded the safety limit.")
            try:
                data = json.loads(raw)
            except (ValueError, UnicodeError):
                raise Stopped("Expected a JSON API response; redirects and HTML are not accepted.") from None
            return Response(response.code, data, {k.lower(): v for k, v in response.headers.items()})


def require_ok(response, label):
    if response.status not in (200, 206):
        raise Stopped(f"{label}: unexpected HTTP {response.status}; not a passing check.")
    return response.data


def require_denied(response, label):
    if (response.status not in (401, 403) or not isinstance(response.data, dict)
            or response.data.get("code") != "42501"):
        raise Stopped(f"{label}: expected a database permission denial (42501), got HTTP {response.status}.")


def login(api, email, password):
    result = require_ok(api.request("POST", "/auth/v1/token?grant_type=password",
        body={"email": email, "password": password}), "Sign-in")
    try:
        token = result["access_token"]
        uid = str(uuid.UUID(result["user"]["id"]))
        claims = decode_jwt(token)
        if (claims.get("role") != "authenticated" or claims.get("sub") != uid
                or claims.get("iss") != BASE + "/auth/v1"
                or not isinstance(claims.get("exp"), (int, float))
                or claims["exp"] <= time.time()
                or result["user"].get("is_anonymous", False)):
            raise ValueError()
    except (KeyError, TypeError, ValueError, AttributeError):
        raise Stopped("Sign-in did not return an ordinary user session for adbattle-test.") from None
    # The decode above is only a local shape check, NOT signature verification.
    # Auth must independently accept this token and confirm the same identity.
    user = require_ok(api.request("GET", "/auth/v1/user", token), "Session verification")
    if not isinstance(user, dict) or user.get("id") != uid:
        raise Stopped("Auth session identity mismatch.")
    return token, uid


def rows(api, table, token, owner_id=None):
    owner, primary, columns = TABLES[table]
    out, total = [], None
    while True:
        query = {"select": columns, "order": primary + ".asc", "limit": str(PAGE_SIZE), "offset": str(len(out))}
        if owner_id is not None:
            query[owner] = "eq." + str(uuid.UUID(owner_id))
        response = api.request("GET", "/rest/v1/" + table + "?" + urllib.parse.urlencode(query), token)
        data = require_ok(response, table + " read")
        match = re.fullmatch(r"(?:(\d+)-(\d+)|\*)/(\d+)", response.headers.get("content-range", ""))
        if not isinstance(data, list) or not match:
            raise Stopped(table + ": missing exact pagination evidence.")
        count = int(match[3])
        if count > MAX_ROWS or (total is not None and total != count):
            raise Stopped(table + ": too many rows or data changed during pagination.")
        total = count
        if not data:
            if total != 0 or out:
                raise Stopped(table + ": incomplete pagination.")
            return []
        if (match[1] is None or int(match[1]) != len(out)
                or int(match[2]) - int(match[1]) + 1 != len(data)):
            raise Stopped(table + ": inconsistent page boundaries.")
        if any(not isinstance(row, dict) or primary not in row or owner not in row for row in data):
            raise Stopped(table + ": unexpected row shape.")
        out.extend(data)
        if len({str(row[primary]) for row in out}) != len(out) or len(out) > total:
            raise Stopped(table + ": duplicate or inconsistent page rows.")
        if len(out) == total:
            return out


def run_checks(api, user_a, user_b):
    token_a, uid_a = user_a
    token_b, uid_b = user_b
    if uid_a == uid_b:
        raise Stopped("Use two DIFFERENT ordinary test accounts.")
    # Populated A rows make B's explicit foreign-owner probes meaningful.
    baseline = {table: rows(api, table, token_a, uid_a) for table in TABLES}
    for table, data in baseline.items():
        if not data:
            raise Stopped(table + ": account A needs existing own rows; an empty fixture cannot pass.")
        if any(row[TABLES[table][0]] != uid_a for row in data):
            raise Stopped(table + ": owner control returned a foreign row.")
    for token, uid, foreign_uid in [(token_a, uid_a, uid_b), (token_b, uid_b, uid_a)]:
        for table, (owner, _, _) in TABLES.items():
            visible = rows(api, table, token)
            if any(row[owner] != uid for row in visible):
                raise Stopped(table + ": unfiltered read exposed another user's row.")
            own = baseline[table] if uid == uid_a else rows(api, table, token, uid)
            if visible != own:
                raise Stopped(table + ": unfiltered and own-row controls disagree.")
            if rows(api, table, token, foreign_uid):
                raise Stopped(table + ": explicit cross-user read exposed rows.")
        for table in PRIVATE:
            response = api.request("GET", "/rest/v1/" + table + "?select=*&limit=1", token)
            require_denied(response, "Private table " + table)
    for table in (*TABLES, *PRIVATE):
        response = api.request("GET", "/rest/v1/" + table + "?select=*&limit=1")
        require_denied(response, "Signed-out read " + table)
    invalid = api.request("GET", "/rest/v1/wallets?select=user_id&limit=1", "not-a-valid-jwt")
    if invalid.status != 401:
        raise Stopped("Invalid-token read did not return HTTP 401.")
    for table in TABLES:
        if rows(api, table, token_a, uid_a) != baseline[table]:
            raise Stopped(table + ": account A's visible snapshot changed during the test; investigate before claiming PASS.")
    return {table: len(data) for table, data in baseline.items()}


def hidden(prompt):
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        try:
            return getpass.getpass(prompt)
        except getpass.GetPassWarning:
            raise Stopped("An interactive terminal with hidden credential input is required.") from None


def main():
    argparse.ArgumentParser(description=__doc__).parse_args()
    if not sys.stdin.isatty():
        raise Stopped("Run this script in your own interactive terminal.")
    print("AdBattle hosted wallet access test — adbattle-test only")
    print("First run supabase/staging/check_wallet_access.sql and resolve any non-PASS result.")
    print("A: existing account with wallet/top-up/ledger/creator settlement history.")
    print("B: different ordinary test account; it does not need a wallet or a payment.")
    print("Passwords/tokens stay in memory. Paste the public key at the hidden prompt.")
    api = Api(hidden("adbattle-test public API key (hidden): ").strip())
    settings = require_ok(api.request("GET", "/auth/v1/settings"), "Public key check")
    if not isinstance(settings, dict):
        raise Stopped("Invalid Auth settings response.")
    identities = []
    for label in ("A", "B"):
        email = input(f"Account {label} email: ").strip()
        password = hidden(f"Account {label} password (hidden): ")
        identities.append(login(api, email, password))
        password = None
        print(f"Account {label} sign-in and Auth identity: PASS")
    counts = run_checks(api, *identities)
    print("\nACCESS RESULTS — safe to share:")
    print("Project: adbattle-test")
    print("Two distinct ordinary Auth sessions: PASS")
    print("Populated account A owner reads: PASS (" + ", ".join(f"{t}={n}" for t, n in counts.items()) + ")")
    print("Account B cannot read account A's populated wallet/settlement rows: PASS")
    print("Both users' unfiltered and explicit foreign-owner reads: PASS")
    print("Private risk/guard tables denied to both users: PASS")
    print("Signed-out private wallet reads and invalid JWT rejected: PASS")
    print("Account A visible wallet and row identities unchanged: PASS")
    print("Wallet mutations, RPC/Edge calls and Stripe payments attempted: NONE")
    print("Write/RPC privilege audit: SEPARATE SQL RESULT REQUIRED")
    print("Scope: these tables and sessions; A-to-B positive isolation requires populated B rows.")


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print("\nStopped. No wallet mutation was attempted.")
        sys.exit(1)
    except Stopped as error:
        print("\nSTOPPED: " + str(error))
        sys.exit(1)
    except Exception as error:
        # Never echo unexpected exception text: it can contain a token or response.
        print("\nSTOPPED: Unexpected local/API response (" + type(error).__name__ + ").")
        sys.exit(1)
