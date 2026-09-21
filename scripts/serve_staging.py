#!/usr/bin/env python3
"""Serve AdBattle on localhost:8000 with fail-closed adbattle-test config."""

import base64
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import urllib.error
import urllib.request

PROJECT_REF = "nccqnrcdygujulrnwair"
SUPABASE_URL = f"https://{PROJECT_REF}.supabase.co"
FRONTEND_ORIGIN = "http://localhost:8000"
ROOT = Path(__file__).resolve().parent.parent


def public_key_valid(key):
    if key.startswith("sb_publishable_"):
        return True
    try:
        parts = key.split(".")
        claims = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
        return len(parts) == 3 and claims.get("role") == "anon" and claims.get("ref") == PROJECT_REF
    except (ValueError, TypeError, KeyError, IndexError, json.JSONDecodeError):
        return False


def staging_config():
    required = {
        "ADBATTLE_SUPABASE_PROJECT_REF": PROJECT_REF,
        "ADBATTLE_SUPABASE_URL": SUPABASE_URL,
        "ADBATTLE_FRONTEND_ORIGIN": FRONTEND_ORIGIN,
    }
    for name, expected in required.items():
        if os.environ.get(name) != expected:
            raise SystemExit(f"{name} must be explicitly set to {expected!r}; refusing to start.")
    key = os.environ.get("ADBATTLE_SUPABASE_PUBLISHABLE_KEY", "").strip()
    if not public_key_valid(key):
        raise SystemExit("ADBATTLE_SUPABASE_PUBLISHABLE_KEY must be adbattle-test's publishable or legacy anon key.")
    return {
        "environment": "staging", "projectRef": PROJECT_REF,
        "supabaseUrl": SUPABASE_URL, "frontendOrigin": FRONTEND_ORIGIN,
        "publishableKey": key,
    }


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward the supplied project key to another origin.
        return None


def validate_key_with_project(config):
    request = urllib.request.Request(
        SUPABASE_URL + "/auth/v1/settings",
        headers={"apikey": config["publishableKey"]},
    )
    try:
        with urllib.request.build_opener(NoRedirects()).open(request, timeout=15) as response:
            if response.status != 200:
                raise SystemExit("adbattle-test rejected the supplied public key; refusing to start.")
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError):
        raise SystemExit(
            "Could not validate the public key with adbattle-test; refusing to start."
        ) from None


class Handler(SimpleHTTPRequestHandler):
    config = None

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/adbattle.local-config.js":
            body = ("window.ADBATTLE_LOCAL_CONFIG = " + json.dumps(self.config) + ";\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


if __name__ == "__main__":
    Handler.config = staging_config()
    validate_key_with_project(Handler.config)
    server = ThreadingHTTPServer(("127.0.0.1", 8000), partial(Handler, directory=ROOT))
    print(f"AdBattle STAGING: {FRONTEND_ORIGIN} -> {SUPABASE_URL}")
    print("Press Ctrl-C to stop. The supplied public key is held in memory and is not written to disk.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
