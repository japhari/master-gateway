#!/usr/bin/env python3
"""
Restore TAIV1TOV2 subQueue channelUrl in master-gateway's OpenHIM config.

Why: during the multipart pass-through smoke test we temporarily redirected
this queue to an echo server on :5002. Run this script to put it back to
the real destination on :15001.

Usage:
    python3 scripts/restore-taiv1tov2.py
"""
import hashlib
import json
import sys

try:
    import requests
    import urllib3
except ImportError:
    print("pip install requests urllib3", file=sys.stderr)
    sys.exit(1)

urllib3.disable_warnings()

OPENHIM = "https://127.0.0.1:17070"
USER = "admin@mnrt.go.tz"
PASS = "default-password@"
TARGET_URL = "http://localhost:15001/api/v1/faru/tai/sync"


def auth_headers():
    s = requests.get(f"{OPENHIM}/authenticate/{USER}", verify=False).json()
    ph = hashlib.sha512((s["salt"] + PASS).encode()).hexdigest()
    tok = hashlib.sha512((ph + s["salt"] + s["ts"]).encode()).hexdigest()
    return {
        "auth-username": USER,
        "auth-ts": s["ts"],
        "auth-salt": s["salt"],
        "auth-token": tok,
    }


def main():
    H = auth_headers()
    meds = requests.get(f"{OPENHIM}/mediators", verify=False, headers=H).json()
    mediator = next((m for m in meds if "master" in m["urn"].lower()), None)
    if not mediator:
        print("ERROR: master-gateway mediator not found in OpenHIM")
        sys.exit(2)

    cfg = mediator["config"]
    found = False
    for q in cfg.get("subQueues", []):
        if q.get("queueName") == "TAIV1TOV2":
            before = q.get("channelUrl")
            q["channelUrl"] = TARGET_URL
            found = True
            print(f"TAIV1TOV2 channelUrl: {before} -> {TARGET_URL}")

    if not found:
        print("ERROR: TAIV1TOV2 not found in master-gateway subQueues")
        sys.exit(3)

    r = requests.put(
        f"{OPENHIM}/mediators/{mediator['urn']}/config",
        verify=False,
        headers={**H, "Content-Type": "application/json"},
        data=json.dumps(cfg),
    )
    print(f"PUT /mediators/*/config -> {r.status_code} {r.text[:200]}")
    if r.status_code >= 300:
        sys.exit(4)


if __name__ == "__main__":
    main()
