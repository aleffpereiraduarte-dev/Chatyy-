#!/usr/bin/env python3
"""
Create Diamond IAP SKUs on Apple App Store Connect + Google Play Console via API.

Usage:
  python3 scripts/create_diamond_skus.py [--apple] [--google] [--verify]
  (no flags = do both create+verify on both platforms)
"""
import json
import os
import sys
import time
import argparse
import urllib.request
import urllib.error

import jwt  # PyJWT (with cryptography for ES256)
from google.oauth2 import service_account
from google.auth.transport.requests import Request as GAuthRequest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASC_KEY_PATH = os.path.join(ROOT, "asc_key.p8")
ASC_KEY_ID = "QSYM3KX73P"
ASC_ISSUER_ID = "494360d0-0420-4f1f-a1db-6be19eeb2d89"
ASC_APP_ID = "6759975575"

GPLAY_SA_PATH = os.path.join(ROOT, "gcloud-sa-key.json")
GPLAY_PACKAGE = "com.onemundo.mail"

SKUS = [
    {"sku": "chatyy_diamonds_100",   "name": "100 Diamantes",          "diamonds": 100,   "price_brl_micros": "4990000",   "price_brl": "4.99",   "best": False, "desc_pt": "Compre 100 diamantes para enviar a amigos e desbloquear features premium."},
    {"sku": "chatyy_diamonds_550",   "name": "550 Diamantes",          "diamonds": 550,   "price_brl_micros": "19990000",  "price_brl": "19.99",  "best": False, "desc_pt": "Compre 550 diamantes (bônus +10%) para enviar a amigos."},
    {"sku": "chatyy_diamonds_1700",  "name": "1.700 Diamantes",        "diamonds": 1700,  "price_brl_micros": "49990000",  "price_brl": "49.99",  "best": False, "desc_pt": "Compre 1.700 diamantes (bônus +13%) para enviar a amigos."},
    {"sku": "chatyy_diamonds_6000",  "name": "6.000 Diamantes",        "diamonds": 6000,  "price_brl_micros": "149990000", "price_brl": "149.99", "best": True,  "desc_pt": "MELHOR OFERTA: Compre 6.000 diamantes (bônus +20%) para enviar a amigos."},
    {"sku": "chatyy_diamonds_19500", "name": "19.500 Diamantes",       "diamonds": 19500, "price_brl_micros": "399990000", "price_brl": "399.99", "best": False, "desc_pt": "Compre 19.500 diamantes (bônus +30%) para enviar a amigos."},
]


# -------------------- helpers --------------------
def http(method, url, headers=None, body=None, timeout=30):
    headers = headers or {}
    if body is not None and not isinstance(body, (bytes, bytearray)):
        body = json.dumps(body).encode("utf-8")
        headers.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, raw.decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")
    except urllib.error.URLError as e:
        return 0, f"URLERROR: {e}"


# -------------------- Apple ASC --------------------
def asc_jwt():
    with open(ASC_KEY_PATH, "rb") as f:
        key = f.read()
    now = int(time.time())
    payload = {
        "iss": ASC_ISSUER_ID,
        "iat": now,
        "exp": now + 19 * 60,
        "aud": "appstoreconnect-v1",
    }
    headers = {"kid": ASC_KEY_ID, "typ": "JWT"}
    return jwt.encode(payload, key, algorithm="ES256", headers=headers)


def asc_auth_headers():
    return {"Authorization": "Bearer " + asc_jwt()}


def asc_list_iaps():
    """Return list of existing IAPs (v2 endpoint) for this app."""
    url = f"https://api.appstoreconnect.apple.com/v2/inAppPurchases?filter[app]={ASC_APP_ID}&limit=200"
    # The v2 endpoint requires filter[app] via different path; actually correct path:
    url = f"https://api.appstoreconnect.apple.com/v1/apps/{ASC_APP_ID}/inAppPurchasesV2?limit=200"
    status, body = http("GET", url, asc_auth_headers())
    return status, body


def asc_create_iap(sku):
    """Create CONSUMABLE IAP via v2 endpoint."""
    url = "https://api.appstoreconnect.apple.com/v2/inAppPurchases"
    payload = {
        "data": {
            "type": "inAppPurchases",
            "attributes": {
                "name": sku["name"],
                "productId": sku["sku"],
                "inAppPurchaseType": "CONSUMABLE",
                "reviewNote": "Diamantes (moeda virtual consumível) para envio de presentes em chat e features premium.",
                "familySharable": False,
                "availableInAllTerritories": True,
            },
            "relationships": {
                "app": {"data": {"type": "apps", "id": ASC_APP_ID}}
            },
        }
    }
    status, body = http("POST", url, asc_auth_headers(), payload)
    return status, body


def run_apple():
    print("\n=== APPLE App Store Connect ===")
    if not os.path.exists(ASC_KEY_PATH):
        print(f"  MISSING: {ASC_KEY_PATH}")
        return {}
    try:
        token = asc_jwt()
        print(f"  JWT minted (len={len(token)})")
    except Exception as e:
        print(f"  JWT mint FAILED: {e}")
        return {}

    print("  Listing existing IAPs for app...")
    status, body = asc_list_iaps()
    existing_pids = {}
    if status == 200:
        try:
            data = json.loads(body)
            for item in data.get("data", []):
                pid = item.get("attributes", {}).get("productId")
                if pid:
                    existing_pids[pid] = item.get("id")
            print(f"  Found {len(existing_pids)} existing IAPs")
        except Exception as e:
            print(f"  parse error: {e}")
    else:
        print(f"  list status={status} body[:300]={body[:300]}")

    results = {}
    for s in SKUS:
        pid = s["sku"]
        if pid in existing_pids:
            print(f"  [SKIP] {pid} already exists id={existing_pids[pid]}")
            results[pid] = {"status": "exists", "id": existing_pids[pid]}
            continue
        st, bd = asc_create_iap(s)
        if st in (200, 201):
            try:
                iid = json.loads(bd).get("data", {}).get("id")
            except Exception:
                iid = None
            print(f"  [OK]   {pid} created id={iid}")
            results[pid] = {"status": "created", "id": iid}
        else:
            short = bd[:400].replace("\n", " ")
            print(f"  [FAIL] {pid} HTTP {st}: {short}")
            results[pid] = {"status": "error", "http": st, "body": short}
    return results


# -------------------- Google Play --------------------
def gplay_token():
    creds = service_account.Credentials.from_service_account_file(
        GPLAY_SA_PATH,
        scopes=["https://www.googleapis.com/auth/androidpublisher"],
    )
    creds.refresh(GAuthRequest())
    return creds.token


def gplay_list():
    tok = gplay_token()
    url = f"https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{GPLAY_PACKAGE}/inappproducts"
    return http("GET", url, {"Authorization": "Bearer " + tok})


def gplay_create(sku):
    tok = gplay_token()
    url = f"https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{GPLAY_PACKAGE}/inappproducts?autoConvertMissingPrices=true"
    payload = {
        "packageName": GPLAY_PACKAGE,
        "sku": sku["sku"],
        "status": "active",
        "purchaseType": "managedUser",  # consumable managed product
        "defaultPrice": {"priceMicros": sku["price_brl_micros"], "currency": "BRL"},
        "listings": {
            "pt-BR": {"title": sku["name"], "description": sku["desc_pt"]},
            "en-US": {"title": sku["name"].replace("Diamantes", "Diamonds"),
                      "description": f"Buy {sku['diamonds']} diamonds for gifts and premium features."},
        },
        "defaultLanguage": "pt-BR",
    }
    return http("POST", url, {"Authorization": "Bearer " + tok}, payload)


def run_google():
    print("\n=== GOOGLE Play Developer ===")
    if not os.path.exists(GPLAY_SA_PATH):
        print(f"  MISSING: {GPLAY_SA_PATH}")
        return {}

    try:
        tok = gplay_token()
        print(f"  OAuth token minted (len={len(tok)})")
    except Exception as e:
        print(f"  Token mint FAILED: {e}")
        return {}

    print("  Listing existing in-app products...")
    st, bd = gplay_list()
    existing = {}
    if st == 200:
        try:
            for item in json.loads(bd).get("inappproduct", []):
                existing[item.get("sku")] = item
        except Exception:
            pass
        print(f"  Found {len(existing)} existing in-app products")
    else:
        print(f"  list status={st} body[:400]={bd[:400]}")

    results = {}
    for s in SKUS:
        sku = s["sku"]
        if sku in existing:
            print(f"  [SKIP] {sku} already exists status={existing[sku].get('status')}")
            results[sku] = {"status": "exists", "id": sku}
            continue
        st, bd = gplay_create(s)
        if st in (200, 201):
            print(f"  [OK]   {sku} created price={s['price_brl_micros']} BRL")
            results[sku] = {"status": "created", "id": sku}
        else:
            short = bd[:400].replace("\n", " ")
            print(f"  [FAIL] {sku} HTTP {st}: {short}")
            results[sku] = {"status": "error", "http": st, "body": short}
    return results


# -------------------- main --------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apple", action="store_true")
    ap.add_argument("--google", action="store_true")
    ap.add_argument("--verify-only", action="store_true",
                    help="Only list existing products, do not create")
    args = ap.parse_args()

    do_apple = args.apple or (not args.apple and not args.google)
    do_google = args.google or (not args.apple and not args.google)

    summary = {}
    if args.verify_only:
        if do_apple:
            print("\n[VERIFY] Apple IAPs:")
            st, bd = asc_list_iaps()
            print(f"  HTTP {st}")
            if st == 200:
                pids = [i["attributes"]["productId"] for i in json.loads(bd).get("data", [])]
                target = [s["sku"] for s in SKUS]
                print("  total: {}, of-our-diamonds: {}/{}".format(
                    len(pids), len([p for p in pids if p in target]), len(target)))
                print("  found:", [p for p in pids if p in target])
            else:
                print("  body[:400]:", bd[:400])
        if do_google:
            print("\n[VERIFY] Google Play IAPs:")
            st, bd = gplay_list()
            print(f"  HTTP {st}")
            if st == 200:
                items = json.loads(bd).get("inappproduct", [])
                target = [s["sku"] for s in SKUS]
                ours = [i["sku"] for i in items if i.get("sku") in target]
                print(f"  total: {len(items)}, of-our-diamonds: {len(ours)}/{len(target)}")
                print("  found:", ours)
            else:
                print("  body[:400]:", bd[:400])
        return 0

    if do_apple:
        summary["apple"] = run_apple()
    if do_google:
        summary["google"] = run_google()

    print("\n=== SUMMARY ===")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
