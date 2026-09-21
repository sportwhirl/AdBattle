#!/usr/bin/env python3
"""Test a $10 wallet top-up and one-cent support in adbattle-test.

Python 3; no extra packages. Run locally in a terminal:
  python3 scripts/adbattle_topup_test.py            # top-up / recheck existing credit
  python3 scripts/adbattle_topup_test.py --support  # spend one cent; retry the same UUID
Uses a public Supabase API key and an ordinary test user's credentials.
Passwords and access tokens stay in memory. A private local state file stores
the checkout request ID and URL so rerunning does not start another payment.
No database credentials, service-role keys, or Stripe keys are needed.
"""

import argparse
import base64
from decimal import Decimal
import fcntl
import getpass
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import warnings
import webbrowser


PROJECT = "nccqnrcdygujulrnwair"
BASE = f"https://{PROJECT}.supabase.co"
AMOUNT = 1000
PRIVATE_VALUES = []


class TestStopped(Exception):
    pass


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward login credentials or authorization headers elsewhere.
        return None


HTTP = urllib.request.build_opener(NoRedirects())


def safe_message(value):
    message = str(value)
    for private in PRIVATE_VALUES:
        if private:
            message = message.replace(private, "[redacted]")
    return message[:400]


def check_public_key(key):
    if key.startswith("sb_publishable_"):
        return
    try:
        parts = key.split(".")
        if len(parts) != 3:
            raise ValueError()
        claims = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
        if claims.get("role") != "anon" or claims.get("ref") != PROJECT:
            raise ValueError()
    except (ValueError, TypeError, KeyError):
        raise TestStopped("Use adbattle-test's publishable key or legacy anon key. Do not use a secret, service-role, or Stripe key.") from None


def api(key, path, token=None, body=None):
    if not path.startswith("/") or path.startswith("//"):
        raise TestStopped("Unexpected API path.")
    headers = {"apikey": key, "Content-Type": "application/json"}
    if path.startswith("/rest/v1/") and body is not None:
        headers["Prefer"] = "return=representation"
    if token:
        headers["Authorization"] = "Bearer " + token
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers=headers,
                                 method="POST" if body is not None else "GET")
    try:
        with HTTP.open(req, timeout=25) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        text = error.read(8192).decode("utf-8", "replace")
        try:
            detail = json.loads(text)
            text = detail.get("error_description") or detail.get("message") or detail.get("error") or "Request failed"
        except (ValueError, AttributeError):
            text = text or "Request failed"
        raise TestStopped(f"HTTP {error.code} on {path.split('?')[0]}: {safe_message(text)}") from None
    except (urllib.error.URLError, TimeoutError):
        raise TestStopped("Network request did not complete. Rerun this same command; keep its saved request state.") from None


def rows(key, token, user_id, table, columns, **filters):
    query = {"select": columns, "user_id": "eq." + user_id, **filters}
    result = api(key, "/rest/v1/" + table + "?" + urllib.parse.urlencode(query), token)
    if not isinstance(result, list):
        raise TestStopped("Unexpected database response.")
    return result


def checkout_id(url):
    try:
        parsed = urllib.parse.urlsplit(url)
        match = re.search(r"/(cs_test_[A-Za-z0-9]+)(?:/|$)", parsed.path)
        if (parsed.scheme != "https" or parsed.hostname != "checkout.stripe.com"
                or parsed.username or parsed.password or parsed.port not in (None, 443) or not match):
            raise ValueError()
        return match.group(1)
    except (TypeError, ValueError):
        raise TestStopped("The function did not return an approved Stripe TEST checkout URL. No browser was opened.") from None


def save_state(path, state):
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as handle:
        temp = Path(handle.name)
        json.dump(state, handle, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    try:
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def credited(key, token, user_id, state):
    if not state.get("checkout_url"):
        return False
    session = checkout_id(state["checkout_url"])
    topups = rows(key, token, user_id, "wallet_topups", "id,amount_cents,status,reversed_cents",
                  stripe_session_id="eq." + session)
    if not topups:
        return False
    if len(topups) != 1:
        raise TestStopped("Expected one top-up record for this Checkout session.")
    topup = topups[0]
    if topup["amount_cents"] != AMOUNT or topup["status"] != "paid" or topup["reversed_cents"] != 0:
        raise TestStopped("The top-up exists but its amount or payment-risk state needs review.")
    entries = rows(key, token, user_id, "wallet_transactions", "amount_cents,balance_after_cents",
                   topup_id="eq." + str(topup["id"]), entry_type="eq.topup")
    wallets = rows(key, token, user_id, "wallets",
                   "available_cents,lifetime_topup_cents,lifetime_support_cents,status")
    if len(entries) != 1 or entries[0]["amount_cents"] != AMOUNT or len(wallets) != 1:
        raise TestStopped("The top-up was recorded, but its ledger credit or wallet needs review.")
    wallet = wallets[0]
    if wallet["status"] != "active":
        raise TestStopped("The wallet is frozen; investigate payment-risk records before spending.")
    if (entries[0]["balance_after_cents"] != AMOUNT
            or wallet["lifetime_topup_cents"] != AMOUNT
            or wallet["available_cents"] != AMOUNT - wallet["lifetime_support_cents"]):
        raise TestStopped("The fresh test wallet's balance or totals do not match its credit and spending.")
    print("\nRESULTS — safe to share:")
    print("Project: adbattle-test")
    print("Test-user login: PASS")
    print("Stripe test Checkout: PASS")
    print("One $10.00 top-up record: PASS")
    print("One matching $10.00 ledger credit: PASS")
    print(f"Wallet balance: ${wallet['available_cents'] / 100:.2f}")
    print(f"Lifetime top-ups: ${wallet['lifetime_topup_cents'] / 100:.2f}")
    print(f"Lifetime support: ${wallet['lifetime_support_cents'] / 100:.2f}")
    print("Top-up verified. Support retries and duplicate webhook deliveries are separate checks.")
    return True


def run_checkout(key, token, user_id, state_path):
    if state_path.exists():
        state = json.loads(state_path.read_text())
        if (state.get("project") != PROJECT or state.get("user_id") != user_id
                or state.get("amount_cents") != AMOUNT):
            raise TestStopped("Saved checkout state does not match this test user/project.")
        uuid.UUID(state["request_id"])
        if credited(key, token, user_id, state):
            return
    else:
        wallet = rows(key, token, user_id, "wallets", "lifetime_topup_cents")
        topups = rows(key, token, user_id, "wallet_topups", "id", limit="1")
        if topups or any(row["lifetime_topup_cents"] for row in wallet):
            raise TestStopped("This user already has top-up history. No new Checkout was created; inspect the existing wallet first.")
        state = {"project": PROJECT, "user_id": user_id, "amount_cents": AMOUNT,
                 "request_id": str(uuid.uuid4()), "created_at": time.time()}
        save_state(state_path, state)

    age = time.time() - float(state["created_at"])
    if not 0 <= age < 20 * 60 * 60:
        raise TestStopped("This checkout attempt is over 20 hours old or the clock changed. Check Stripe and the ledger before creating another attempt.")
    if not state.get("checkout_url"):
        print("Creating the $10.00 TEST checkout...")
        result = api(key, "/functions/v1/create-wallet-checkout", token,
                     {"amount_cents": AMOUNT, "request_id": state["request_id"]})
        url = result.get("url") if isinstance(result, dict) else None
        checkout_id(url)
        state["checkout_url"] = url
        save_state(state_path, state)

    checkout_id(state["checkout_url"])
    print("\nComplete this TEST payment in your browser:")
    print("Card: 4242 4242 4242 4242 | Expiry: 12/34 | CVC: 123")
    print("Check that Checkout says TEST and the amount is $10.00. Use no real card.")
    print("The current function returns to adbattle.io afterward. That page is not")
    print("connected to this test wallet; return to this terminal to check the credit.")
    print("\nCheckout link (keep this link private):\n" + state["checkout_url"])
    try:
        webbrowser.open(state["checkout_url"], new=2)
    except webbrowser.Error:
        pass
    input("\nAfter the test payment succeeds, press Enter here: ")
    for attempt in range(15):
        if credited(key, token, user_id, state):
            return
        if attempt == 0:
            print("Waiting for the signed Stripe webhook to credit the wallet...")
        time.sleep(2)
    raise TestStopped("No credit seen yet. Do not pay again. Check this destination's Stripe delivery status and stripe-webhook logs, then rerun this same script.")


def rest_rows(key, token, table, columns, **filters):
    query = {"select": columns, **filters}
    result = api(key, "/rest/v1/" + table + "?" + urllib.parse.urlencode(query), token)
    if not isinstance(result, list):
        raise TestStopped("Unexpected database response.")
    return result


def one_record(records, description):
    if len(records) != 1:
        raise TestStopped(f"Expected exactly one {description}; found {len(records)}. No new request ID was generated.")
    return records[0]


def wallet_snapshot(key, token, user_id):
    return one_record(rows(key, token, user_id, "wallets",
                          "available_cents,lifetime_topup_cents,lifetime_support_cents,status"), "wallet")


def support_ad(key, token, user_id, test):
    return one_record(rows(key, token, user_id, "ads",
                          "id,user_id,title,moderation_status,promotion_stopped_at,support_total",
                          id="eq." + str(test["ad_id"]), title="eq." + test["ad_title"]), "test ad")


def verify_support(key, token, user_id, test, first, second):
    request_id = test["request_id"]
    support = one_record(rows(key, token, user_id, "supports",
        "id,ad_id,amount,source,creator_share_percent,creator_amount,platform_amount,publishing_amount,creator_amount_micros,platform_amount_micros",
        wallet_request_id="eq." + request_id), "support record for this request")
    debit = one_record(rows(key, token, user_id, "wallet_transactions",
        "amount_cents,balance_after_cents,ad_id,support_id,entry_type",
        request_id="eq." + request_id), "wallet transaction for this request")
    wallet = wallet_snapshot(key, token, user_id)
    ad = support_ad(key, token, user_id, test)
    settlement = one_record(rest_rows(key, token, "ad_settlement_state",
        "lifetime_support_cents,pending_creator_micros,pending_platform_micros",
        ad_id="eq." + str(test["ad_id"]), creator_user_id="eq." + user_id), "creator settlement state")
    if (not isinstance(first, dict) or not isinstance(second, dict)
            or first.get("ok") is not True or type(first.get("recorded")) is not bool
            or second.get("ok") is not True or second.get("recorded") is not False
            or first.get("support_id") != support["id"] or second.get("support_id") != support["id"]
            or first.get("balance_cents") != 999 or second.get("balance_cents") != 999):
        raise TestStopped("Support/retry responses did not identify one successful one-cent debit.")
    if (wallet["available_cents"] != 999 or wallet["lifetime_topup_cents"] != 1000
            or wallet["lifetime_support_cents"] != 1 or wallet["status"] != "active"):
        raise TestStopped("Wallet totals differ from the expected $9.99 balance and $0.01 spent. Keep the request state for review.")
    if (debit["amount_cents"] != -1 or debit["balance_after_cents"] != 999
            or debit["entry_type"] != "support_debit" or debit["ad_id"] != test["ad_id"]
            or debit["support_id"] != support["id"]):
        raise TestStopped("The wallet debit does not match this support request.")
    if (support["ad_id"] != test["ad_id"] or support["source"] != "wallet"
            or Decimal(str(support["amount"])) != Decimal("0.01")
            or Decimal(str(support["creator_amount"])) != Decimal("0.009")
            or Decimal(str(support["platform_amount"])) != Decimal("0.001")
            or Decimal(str(support["publishing_amount"])) != 0
            or support["creator_share_percent"] != 90
            or support["creator_amount_micros"] != 9000 or support["platform_amount_micros"] != 1000):
        raise TestStopped("The one-cent support's 90/10 split does not match the expected ledger values.")
    if (Decimal(str(ad["support_total"])) != Decimal("0.01")
            or settlement["lifetime_support_cents"] != 1
            or settlement["pending_creator_micros"] != 9000
            or settlement["pending_platform_micros"] != 1000):
        raise TestStopped("Ad totals or pending creator settlement balances differ from the expected one-cent support.")
    print("\nSUPPORT RESULTS — safe to share:")
    print("Project: adbattle-test")
    print("One-cent wallet support: PASS")
    print("Same request sent twice; one debit and one support record: PASS")
    print("Wallet balance: $9.99")
    print("Lifetime top-ups: $10.00")
    print("Lifetime support: $0.01")
    print("Test ad support total: $0.01")
    print("Creator accrual: $0.009 (9000 microdollars)")
    print("AdBattle accrual: $0.001 (1000 microdollars)")
    print("No new Stripe Checkout or creator transfer was requested.")
    print("Next: resend the original paid Checkout webhook and verify there is still one credit.")


def run_support(key, token, user_id, state_path):
    if not state_path.exists():
        raise TestStopped("Support mode needs the saved state from your successful top-up. Use the same computer and test login.")
    state = json.loads(state_path.read_text())
    if state.get("project") != PROJECT or state.get("user_id") != user_id or state.get("amount_cents") != AMOUNT:
        raise TestStopped("Saved top-up state does not match this test user/project.")
    if not credited(key, token, user_id, state):
        raise TestStopped("The original test top-up is not yet credited. Support mode never creates a Checkout session.")
    test = state.get("support_test")
    if test is None:
        wallet = wallet_snapshot(key, token, user_id)
        if wallet["available_cents"] != 1000 or wallet["lifetime_support_cents"] != 0:
            raise TestStopped("Expected the original untouched $10 test wallet. Inspect existing spending before starting a new test.")
        request_id = str(uuid.uuid4())
        test = {"request_id": request_id, "amount_cents": 1,
                "ad_title": "Wallet one-cent staging test " + request_id}
        state["support_test"] = test
        # Save the UUID before any request; retain it after errors or lost replies.
        save_state(state_path, state)
    uuid.UUID(test["request_id"])
    if test.get("amount_cents") != 1 or test.get("ad_title") != "Wallet one-cent staging test " + test["request_id"]:
        raise TestStopped("Saved support test parameters are inconsistent.")
    if "ad_id" not in test:
        existing = rows(key, token, user_id, "ads", "id", title="eq." + test["ad_title"])
        if not existing:
            existing = api(key, "/rest/v1/ads", token, {
                "user_id": user_id, "title": test["ad_title"],
                "caption": "Synthetic staging fixture for one-cent wallet support. Not a real promotion.",
                "image_url": "https://example.invalid/adbattle-wallet-test.png",
                "moderation_status": "pending_scan",
            })
        ad = one_record(existing, "synthetic ad")
        test["ad_id"] = int(ad["id"])
        if test["ad_id"] <= 0:
            raise TestStopped("Invalid test ad ID.")
        save_state(state_path, state)
    ad = support_ad(key, token, user_id, test)
    if ad["moderation_status"] == "pending_scan":
        print("\nThe synthetic test ad needs administrator approval.")
        print(f"Open ONLY adbattle-test's SQL Editor: https://supabase.com/dashboard/project/{PROJECT}/sql/new")
        print("Run this statement there, then return to this terminal:")
        print("\nUPDATE public.ads\nSET moderation_status = 'approved', moderated_at = now(),")
        print("    moderation_reason = 'Synthetic wallet staging test approved by test administrator'")
        print(f"WHERE id = {int(test['ad_id'])}")
        print(f"  AND user_id = '{uuid.UUID(user_id)}'::uuid")
        print(f"  AND title = '{test['ad_title']}'")
        print("  AND moderation_status = 'pending_scan'\nRETURNING id, moderation_status;\n")
        input("After it returns this ad as approved, press Enter here: ")
        ad = support_ad(key, token, user_id, test)
    if ad["moderation_status"] != "approved" or ad["promotion_stopped_at"] is not None:
        raise TestStopped("The test ad is not approved for support. No support call was made.")
    if not test.get("started"):
        wallet = wallet_snapshot(key, token, user_id)
        if (wallet["available_cents"] != 1000 or wallet["lifetime_support_cents"] != 0
                or Decimal(str(ad["support_total"] or 0)) != 0):
            raise TestStopped("Expected an untouched $10 wallet and zero support on the synthetic ad.")
        test["started"] = True
        save_state(state_path, state)
    body = {"ad_id": test["ad_id"], "amount_cents": 1, "request_id": test["request_id"]}
    print("Sending one-cent support, then retrying the identical request...")
    first = api(key, "/functions/v1/support-from-wallet", token, body)
    second = api(key, "/functions/v1/support-from-wallet", token, body)
    verify_support(key, token, user_id, test, first, second)
    test["verified"] = True
    save_state(state_path, state)


def main():
    parser = argparse.ArgumentParser(description="AdBattle staging wallet checks; test project only.")
    parser.add_argument("--support", action="store_true", help="Spend one cent from the existing test balance and retry the same request.")
    args = parser.parse_args()
    if not sys.stdin.isatty():
        raise TestStopped("Run this file in your own interactive terminal.")
    print("AdBattle wallet test — adbattle-test only\n")
    print("Get this project's PUBLISHABLE or legacy ANON key from:")
    print(f"https://supabase.com/dashboard/project/{PROJECT}/settings/api-keys")
    key = input("\nPublic API key: ").strip()
    PRIVATE_VALUES.append(key)
    check_public_key(key)
    email = input("Test user's email: ").strip()
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        try:
            password = getpass.getpass("Test user's password (hidden): ")
        except getpass.GetPassWarning:
            raise TestStopped("A terminal with hidden password input is required.") from None
    PRIVATE_VALUES.extend([email, password])
    login = api(key, "/auth/v1/token?grant_type=password", body={"email": email, "password": password})
    token = login.get("access_token")
    if not token:
        raise TestStopped("Login did not return an access token.")
    PRIVATE_VALUES.append(token)
    user_id = str(uuid.UUID(login["user"]["id"]))
    print("Login succeeded.")
    state_dir = Path.home() / ".local" / "state" / "adbattle-wallet-test" / PROJECT
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(state_dir, 0o700)
    state_path = state_dir / (user_id + ".json")
    fd = os.open(state_dir / (user_id + ".lock"), os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(fd, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise TestStopped("A test for this user is already running in another terminal.") from None
        if args.support:
            run_support(key, token, user_id, state_path)
        else:
            run_checkout(key, token, user_id, state_path)


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print("\nStopped. Keep the saved state and rerun this same script to continue.")
        sys.exit(1)
    except TestStopped as error:
        print("\nSTOPPED: " + safe_message(error))
        sys.exit(1)
    except (KeyError, ValueError, OSError, TypeError, ArithmeticError) as error:
        print("\nSTOPPED: Unexpected local state or response (" + type(error).__name__ + ").")
        print("Keep the saved state and report this message before starting another payment.")
        sys.exit(1)
