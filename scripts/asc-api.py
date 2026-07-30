#!/usr/bin/env python3
"""Minimal App Store Connect API client, used by the TestFlight release lane.

Auth is an ES256 JWT minted from the team's API key. The key id and issuer live
in the app-store-connect directory beside the key itself, so nothing here is
configured per invocation and nothing secret is on the command line.

Usage:
  asc-api.py GET  /v1/apps?filter[bundleId]=fm.partyparty.app
  asc-api.py PATCH /v1/builds/<id> '{"data":{...}}'
  asc-api.py POST /v1/betaGroups '{"data":{...}}'

Prints the JSON response body; exits nonzero on HTTP errors with the body on
stderr, because the caller is a shell script that must be able to gate on
failure.
"""

import base64
import json
import os
import sys
import time
import urllib.request

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

CONFIG_DIR = os.path.expanduser("~/Library/Application Support/partyparty/app-store-connect")
API = "https://api.appstoreconnect.apple.com"


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def load_env() -> dict:
    env = {}
    with open(os.path.join(CONFIG_DIR, "release.env")) as f:
        for line in f:
            line = line.strip()
            if line and "=" in line and not line.startswith("#"):
                key, _, value = line.partition("=")
                env[key] = value
    return env


def mint_token() -> str:
    env = load_env()
    key_id = env["APP_STORE_CONNECT_KEY_ID"]
    issuer = env["APP_STORE_CONNECT_ISSUER_ID"]
    with open(os.path.join(CONFIG_DIR, f"AuthKey_{key_id}.p8"), "rb") as f:
        private_key = serialization.load_pem_private_key(f.read(), password=None)

    now = int(time.time())
    header = {"alg": "ES256", "kid": key_id, "typ": "JWT"}
    payload = {"iss": issuer, "iat": now, "exp": now + 900, "aud": "appstoreconnect-v1"}
    signing_input = b64url(json.dumps(header, separators=(",", ":")).encode()) + "." + \
        b64url(json.dumps(payload, separators=(",", ":")).encode())

    der = private_key.sign(signing_input.encode(), ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    signature = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    return signing_input + "." + b64url(signature)


def main() -> int:
    if len(sys.argv) < 3:
        sys.stderr.write(__doc__)
        return 2
    method, path = sys.argv[1].upper(), sys.argv[2]
    body = sys.argv[3].encode() if len(sys.argv) > 3 else None

    request = urllib.request.Request(API + path, data=body, method=method)
    request.add_header("Authorization", "Bearer " + mint_token())
    if body:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            text = response.read().decode()
            print(text if text else "{}")
            return 0
    except urllib.error.HTTPError as err:
        sys.stderr.write(err.read().decode())
        return 1


if __name__ == "__main__":
    sys.exit(main())
