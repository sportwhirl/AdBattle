"""Offline safety/behavior tests. No hosted credentials or network required."""
import base64
import importlib.util
import io
import json
from email.message import Message
from pathlib import Path
import sys
import time
import unittest
import urllib.parse
import urllib.request
import urllib.response

path = Path(__file__).resolve().parents[1] / "scripts" / "test_wallet_access.py"
spec = importlib.util.spec_from_file_location("wallet_access", path)
m = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = m
spec.loader.exec_module(m)
A = "00000000-0000-4000-8000-000000000001"
B = "00000000-0000-4000-8000-000000000002"


def jwt(**claims):
    encoded = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return "e30." + encoded + ".signature"


class FakeApi:
    def __init__(self):
        self.data = {t: [{pk: A if pk == owner else 1, owner: A}]
                     for t, (owner, pk, _) in m.TABLES.items()}
        self.calls = []
        self.leak = None
        self.denial = "42501"
        self.b_has_rows = False

    def request(self, method, path, token=None, body=None):
        self.calls.append((method, path, token))
        assert method == "GET"
        parts = urllib.parse.urlsplit(path)
        table = parts.path.rsplit("/", 1)[-1]
        if token == "not-a-valid-jwt":
            return m.Response(401, {"code": "PGRST301"}, {})
        if token is None or table in m.PRIVATE:
            return m.Response(403 if token else 401, {"code": self.denial}, {})
        owner, pk, _ = m.TABLES[table]
        uid = {"token-a": A, "token-b": B}[token]
        params = urllib.parse.parse_qs(parts.query)
        data = list(self.data[table])
        if self.b_has_rows:
            data.append({pk: B if pk == owner else 2, owner: B})
        if self.leak != table:
            data = [r for r in data if r[owner] == uid]
        if owner in params:
            data = [r for r in data if r[owner] == params[owner][0][3:]]
        offset, limit = int(params.get("offset", [0])[0]), int(params.get("limit", [100])[0])
        page = data[offset:offset + limit]
        content_range = f"{offset}-{offset+len(page)-1}/{len(data)}" if page else "*/0"
        return m.Response(200, page, {"content-range": content_range})


class AccessTests(unittest.TestCase):
    def run_fake(self, api):
        return m.run_checks(api, ("token-a", A), ("token-b", B))

    def test_safe_success_and_no_mutation_requests(self):
        api = FakeApi()
        counts = self.run_fake(api)
        self.assertEqual(counts, {t: 1 for t in m.TABLES})
        self.assertTrue(all(c[0] == "GET" and "/rest/v1/" in c[1] for c in api.calls))

    def test_both_populated_accounts(self):
        api = FakeApi()
        api.b_has_rows = True
        self.run_fake(api)

    def test_cross_user_leak_fails_each_table(self):
        for table in m.TABLES:
            api = FakeApi()
            api.leak = table
            with self.subTest(table=table), self.assertRaisesRegex(m.Stopped, "another user's|cross-user"):
                self.run_fake(api)

    def test_empty_positive_control_cannot_pass(self):
        for table in m.TABLES:
            api = FakeApi()
            api.data[table] = []
            with self.subTest(table=table), self.assertRaisesRegex(m.Stopped, "empty fixture"):
                self.run_fake(api)

    def test_same_account_cannot_pass(self):
        with self.assertRaisesRegex(m.Stopped, "DIFFERENT"):
            m.run_checks(FakeApi(), ("token-a", A), ("token-a", A))

    def test_arbitrary_http_errors_are_not_permission_passes(self):
        for status, code in [(404, "42501"), (500, "42501"), (403, "PGRST202"), (200, "42501"), (401, "bad_key")]:
            with self.subTest(status=status, code=code), self.assertRaises(m.Stopped):
                m.require_denied(m.Response(status, {"code": code}, {}), "test")
        api = FakeApi()
        api.denial = "PGRST202"
        with self.assertRaises(m.Stopped):
            self.run_fake(api)

    def test_paginated_owner_read(self):
        api = FakeApi()
        api.data["wallet_transactions"] = [{"id": i, "user_id": A} for i in range(205)]
        self.assertEqual(len(m.rows(api, "wallet_transactions", "token-a", A)), 205)
        offsets = [urllib.parse.parse_qs(urllib.parse.urlsplit(p).query)["offset"][0]
                   for _, p, _ in api.calls]
        self.assertEqual(offsets, ["0", "100", "200"])

    def test_missing_or_truncated_pagination_fails(self):
        api = FakeApi()
        original = api.request
        def broken(*args, **kwargs):
            result = original(*args, **kwargs)
            result.headers = {}
            return result
        api.request = broken
        with self.assertRaisesRegex(m.Stopped, "pagination evidence"):
            m.rows(api, "wallets", "token-a")

    def test_public_keys_reject_privileged_and_wrong_project(self):
        m.check_public_key("sb_publishable_12345678")
        m.check_public_key(jwt(role="anon", ref=m.PROJECT))
        for key in ["sk_test_secret", "sb_secret_secret", "sb_publishable_", "abc",
                    jwt(role="service_role", ref=m.PROJECT), jwt(role="anon", ref="other")]:
            with self.subTest(key_type=key[:8]), self.assertRaises(m.Stopped):
                m.check_public_key(key)

    def test_transport_rejects_every_mutation_and_foreign_host(self):
        api = m.Api("sb_publishable_12345678")
        for method, target, body in [
            ("PATCH", "/rest/v1/wallets", {}), ("DELETE", "/rest/v1/wallets", None),
            ("POST", "/rest/v1/wallets", {}), ("POST", "/rest/v1/rpc/spend_wallet_support", {}),
            ("POST", "/functions/v1/create-wallet-checkout", {}),
            ("GET", "https://evil.invalid/rest/v1/wallets", None),
            ("GET", "//evil.invalid/rest/v1/wallets", None),
            ("GET", "/rest/v1/../rpc/spend_wallet_support", None),
        ]:
            with self.subTest(method=method, target=target), self.assertRaises(m.Stopped):
                api.request(method, target, body=body)

    def test_redirect_does_not_forward_credentials(self):
        seen = []
        class Redirect(urllib.request.BaseHandler):
            handler_order = 100
            def https_open(self, request):
                seen.append(request.full_url)
                headers = Message()
                headers["Location"] = "https://evil.invalid/collect"
                response = urllib.response.addinfourl(io.BytesIO(b'{}'), headers, request.full_url, 302)
                response.msg = "Found"
                return response
        api = m.Api("sb_publishable_12345678")
        api.http = urllib.request.build_opener(m.NoRedirects(), Redirect())
        result = api.request("POST", "/auth/v1/token?grant_type=password",
                             body={"email": "test@example.invalid", "password": "private"})
        self.assertEqual(result.status, 302)
        self.assertEqual(seen, [m.BASE + "/auth/v1/token?grant_type=password"])
        with self.assertRaises(m.Stopped):
            m.require_ok(result, "login")

    def test_login_requires_auth_verified_identity(self):
        token = jwt(role="authenticated", sub=A, iss=m.BASE + "/auth/v1", exp=time.time()+600)
        class Auth:
            def __init__(self, user_id): self.user_id = user_id
            def request(self, method, path, token_arg=None, body=None):
                if method == "POST":
                    return m.Response(200, {"access_token": token, "user": {"id": A}}, {})
                return m.Response(200, {"id": self.user_id}, {})
        self.assertEqual(m.login(Auth(A), "private@example.invalid", "private"), (token, A))
        with self.assertRaisesRegex(m.Stopped, "identity mismatch"):
            m.login(Auth(B), "private@example.invalid", "private")


if __name__ == "__main__":
    unittest.main()
