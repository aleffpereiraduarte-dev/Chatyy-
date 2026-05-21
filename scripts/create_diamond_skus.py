#!/usr/bin/env python3
"""
Create Diamond IAP SKUs on Apple App Store Connect + Google Play Console via API.

For Apple (ASC v2 API):
  1. POST /v2/inAppPurchases (CONSUMABLE)
  2. POST /v1/inAppPurchaseLocalizations  (en-US + pt-BR)
  3. POST /v1/inAppPurchasePriceSchedules  (base territory BRA + manual price point)

  Note: result will be in MISSING_METADATA until a "Review Screenshot" is
  uploaded via the App Store Connect UI. The SKU IS billable in StoreKit
  sandbox + production once approved (screenshot must be added manually).

For Google Play (Monetization v3 API):
  1. PATCH /v3/applications/{pkg}/onetimeproducts/{productId}?allowMissing=true&regionsVersion.version=2022/02
     with a CONSUMABLE one-time product + a single ACTIVE purchase option
  2. POST  /v3/applications/{pkg}/oneTimeProducts/{productId}/purchaseOptions:batchUpdateStates
     to ACTIVATE the purchase option (created in DRAFT state by default)

Run:
  python3 scripts/create_diamond_skus.py                  # both platforms, create+verify
  python3 scripts/create_diamond_skus.py --verify-only    # just list existing
  python3 scripts/create_diamond_skus.py --apple          # apple only
  python3 scripts/create_diamond_skus.py --google         # google only
"""
import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

import jwt  # PyJWT (with cryptography for ES256)
from google.auth.transport.requests import Request as GAuthRequest
from google.oauth2 import service_account

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASC_KEY_PATH = os.path.join(ROOT, "asc_key.p8")
ASC_KEY_ID = "QSYM3KX73P"
ASC_ISSUER_ID = "494360d0-0420-4f1f-a1db-6be19eeb2d89"
ASC_APP_ID = "6759975575"

GPLAY_SA_PATH = os.path.join(ROOT, "gcloud-sa-key.json")
GPLAY_PACKAGE = "com.onemundo.mail"
GPLAY_REGIONS_VERSION = "2022/02"  # latest stable as of Discovery doc

# Apple BRL price-point tier numbers (resolved from App Store Connect v2 pricePoints,
# stable across IAPs; only the iap_id (`s`) component changes per product).
# Apple BR does NOT offer 149.99 or 399.99 — closest tiers are 149.90 / 399.90.
ASC_BRA_TIERS = {
    "4.99":  "10018",
    "19.99": "10078",
    "49.99": "10198",
    "149.90": "10329",
    "399.90": "10448",
}

# Bundle of SKUs to create. Apple price tier is the BR tier we use (slightly
# rounded for 149.90/399.90 because Apple doesn't carry .99 at those points).
# Google price is exact (no tier restriction in BRL).
SKUS = [
    {
        "sku": "chatyy_diamonds_100", "diamonds": 100,
        "name_pt": "100 Diamantes", "name_en": "100 Diamonds",
        "desc_pt_short": "100 diamantes para gifts e premium.",
        "desc_pt_long":  "Compre 100 diamantes para enviar presentes e desbloquear funcionalidades premium no Chatyy.",
        "desc_en_short": "100 diamonds for gifts and premium.",
        "desc_en_long":  "Buy 100 diamonds to send gifts and unlock premium features on Chatyy.",
        "apple_tier": "4.99",     "gplay_micros": "4990000",  "gplay_units": "4",  "gplay_nanos": 990000000,
        "new_regions_usd_units": "0", "new_regions_usd_nanos": 990000000,
        "new_regions_eur_units": "0", "new_regions_eur_nanos": 990000000,
        "best": False,
    },
    {
        "sku": "chatyy_diamonds_550", "diamonds": 550,
        "name_pt": "550 Diamantes", "name_en": "550 Diamonds",
        "desc_pt_short": "550 diamantes (bonus +10%).",
        "desc_pt_long":  "Compre 550 diamantes (bonus +10%) para enviar presentes e usar premium no Chatyy.",
        "desc_en_short": "550 diamonds (+10% bonus).",
        "desc_en_long":  "Buy 550 diamonds (+10% bonus) to send gifts and unlock premium on Chatyy.",
        "apple_tier": "19.99",    "gplay_micros": "19990000", "gplay_units": "19", "gplay_nanos": 990000000,
        "new_regions_usd_units": "3", "new_regions_usd_nanos": 990000000,
        "new_regions_eur_units": "3", "new_regions_eur_nanos": 990000000,
        "best": False,
    },
    {
        "sku": "chatyy_diamonds_1700", "diamonds": 1700,
        "name_pt": "1.700 Diamantes", "name_en": "1,700 Diamonds",
        "desc_pt_short": "1.700 diamantes (bonus +13%).",
        "desc_pt_long":  "Compre 1.700 diamantes (bonus +13%) para enviar presentes e usar premium no Chatyy.",
        "desc_en_short": "1,700 diamonds (+13% bonus).",
        "desc_en_long":  "Buy 1,700 diamonds (+13% bonus) to send gifts and unlock premium on Chatyy.",
        "apple_tier": "49.99",    "gplay_micros": "49990000", "gplay_units": "49", "gplay_nanos": 990000000,
        "new_regions_usd_units": "9", "new_regions_usd_nanos": 990000000,
        "new_regions_eur_units": "9", "new_regions_eur_nanos": 990000000,
        "best": False,
    },
    {
        "sku": "chatyy_diamonds_6000", "diamonds": 6000,
        "name_pt": "6.000 Diamantes", "name_en": "6,000 Diamonds",
        "desc_pt_short": "MELHOR OFERTA - 6.000 diamantes.",
        "desc_pt_long":  "MELHOR OFERTA: 6.000 diamantes (bonus +20%) para enviar presentes e usar premium.",
        "desc_en_short": "BEST DEAL - 6,000 diamonds.",
        "desc_en_long":  "BEST DEAL: 6,000 diamonds (+20% bonus) to send gifts and unlock premium on Chatyy.",
        # Apple BR has no 149.99 tier — use 149.90 (closest available).
        "apple_tier": "149.90",   "gplay_micros": "149990000", "gplay_units": "149", "gplay_nanos": 990000000,
        "new_regions_usd_units": "29", "new_regions_usd_nanos": 990000000,
        "new_regions_eur_units": "27", "new_regions_eur_nanos": 990000000,
        "best": True,
    },
    {
        "sku": "chatyy_diamonds_19500", "diamonds": 19500,
        "name_pt": "19.500 Diamantes", "name_en": "19,500 Diamonds",
        "desc_pt_short": "19.500 diamantes (bonus +30%).",
        "desc_pt_long":  "Compre 19.500 diamantes (bonus +30%) para enviar presentes e usar premium no Chatyy.",
        "desc_en_short": "19,500 diamonds (+30% bonus).",
        "desc_en_long":  "Buy 19,500 diamonds (+30% bonus) to send gifts and unlock premium on Chatyy.",
        # Apple BR has no 399.99 tier — use 399.90 (closest available).
        "apple_tier": "399.90",   "gplay_micros": "399990000", "gplay_units": "399", "gplay_nanos": 990000000,
        "new_regions_usd_units": "79", "new_regions_usd_nanos": 990000000,
        "new_regions_eur_units": "74", "new_regions_eur_nanos": 990000000,
        "best": False,
    },
]


# -------------------- HTTP helper --------------------
def http(method, url, headers=None, body=None, timeout=30):
    headers = dict(headers or {})
    data = body
    if body is not None and not isinstance(body, (bytes, bytearray)):
        data = json.dumps(body).encode("utf-8")
        headers.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")
    except urllib.error.URLError as e:
        return 0, f"URLERROR: {e}"


# -------------------- Apple ASC --------------------
def asc_jwt():
    with open(ASC_KEY_PATH, "rb") as f:
        key = f.read()
    now = int(time.time())
    payload = {"iss": ASC_ISSUER_ID, "iat": now, "exp": now + 19 * 60, "aud": "appstoreconnect-v1"}
    return jwt.encode(payload, key, algorithm="ES256", headers={"kid": ASC_KEY_ID, "typ": "JWT"})


def asc_auth():
    return {"Authorization": "Bearer " + asc_jwt()}


def asc_list_iaps():
    url = f"https://api.appstoreconnect.apple.com/v1/apps/{ASC_APP_ID}/inAppPurchasesV2?limit=200"
    existing = {}
    while url:
        st, bd = http("GET", url, asc_auth())
        if st != 200:
            return st, bd, existing
        d = json.loads(bd)
        for item in d.get("data", []):
            pid = item.get("attributes", {}).get("productId")
            if pid:
                existing[pid] = {
                    "id": item.get("id"),
                    "state": item.get("attributes", {}).get("state"),
                }
        url = d.get("links", {}).get("next")
    return 200, "", existing


def asc_create_iap(sku):
    payload = {
        "data": {
            "type": "inAppPurchases",
            "attributes": {
                "name": sku["name_pt"][:30],  # ASC name max 30 chars
                "productId": sku["sku"],
                "inAppPurchaseType": "CONSUMABLE",
                "reviewNote": "Moeda virtual consumivel (diamantes) para envio de presentes em chat e desbloqueio de features premium.",
                "familySharable": False,
            },
            "relationships": {"app": {"data": {"type": "apps", "id": ASC_APP_ID}}},
        }
    }
    return http("POST", "https://api.appstoreconnect.apple.com/v2/inAppPurchases", asc_auth(), payload)


def asc_add_localization(iap_id, locale, name, desc):
    payload = {
        "data": {
            "type": "inAppPurchaseLocalizations",
            "attributes": {
                "locale": locale,
                "name": name[:30],     # ASC IAP localization name max 30
                "description": desc[:55],  # ASC IAP localization desc max 55
            },
            "relationships": {
                "inAppPurchaseV2": {"data": {"type": "inAppPurchases", "id": iap_id}}
            },
        }
    }
    return http("POST", "https://api.appstoreconnect.apple.com/v1/inAppPurchaseLocalizations", asc_auth(), payload)


def asc_make_price_point_id(iap_id, territory, tier):
    j = json.dumps({"s": iap_id, "t": territory, "p": tier}, separators=(",", ":"))
    return base64.urlsafe_b64encode(j.encode()).rstrip(b"=").decode()


def asc_set_price(iap_id, apple_tier):
    """Create a price schedule with base territory BRA + manual price point for the tier."""
    tier_num = ASC_BRA_TIERS[apple_tier]
    pp_id = asc_make_price_point_id(iap_id, "BRA", tier_num)
    payload = {
        "data": {
            "type": "inAppPurchasePriceSchedules",
            "relationships": {
                "inAppPurchase": {"data": {"type": "inAppPurchases", "id": iap_id}},
                "baseTerritory": {"data": {"type": "territories", "id": "BRA"}},
                "manualPrices": {"data": [{"type": "inAppPurchasePrices", "id": "${price1}"}]},
            },
        },
        "included": [
            {
                "type": "inAppPurchasePrices",
                "id": "${price1}",
                "attributes": {"startDate": None},
                "relationships": {
                    "inAppPurchasePricePoint": {
                        "data": {"type": "inAppPurchasePricePoints", "id": pp_id}
                    }
                },
            }
        ],
    }
    return http("POST", "https://api.appstoreconnect.apple.com/v1/inAppPurchasePriceSchedules", asc_auth(), payload)


def run_apple():
    print("\n=== APPLE App Store Connect ===")
    if not os.path.exists(ASC_KEY_PATH):
        print(f"  MISSING key file: {ASC_KEY_PATH}")
        return {}
    try:
        asc_jwt()
        print("  JWT minted OK")
    except Exception as e:
        print(f"  JWT mint FAILED: {e}")
        return {}

    st, body, existing = asc_list_iaps()
    if st != 200:
        print(f"  list FAILED status={st}: {body[:300]}")
        return {}
    print(f"  existing IAPs in app: {len(existing)} ({[k for k in existing if 'diamond' in k.lower()]})")

    results = {}
    for s in SKUS:
        pid = s["sku"]
        if pid in existing:
            print(f"  [SKIP] {pid} exists id={existing[pid]['id']} state={existing[pid]['state']}")
            results[pid] = {"status": "exists", "id": existing[pid]["id"], "state": existing[pid]["state"]}
            continue

        st, bd = asc_create_iap(s)
        if st not in (200, 201):
            print(f"  [FAIL] {pid} create HTTP {st}: {bd[:300]}")
            results[pid] = {"status": "error", "step": "create", "http": st, "body": bd[:300]}
            continue
        iap_id = json.loads(bd)["data"]["id"]
        print(f"  [OK]   {pid} created id={iap_id}")

        # Localizations
        loc_results = {}
        st, bd = asc_add_localization(iap_id, "en-US", s["name_en"], s["desc_en_short"])
        loc_results["en-US"] = st
        if st not in (200, 201):
            print(f"    en-US loc FAIL {st}: {bd[:200]}")
        st, bd = asc_add_localization(iap_id, "pt-BR", s["name_pt"], s["desc_pt_short"])
        loc_results["pt-BR"] = st
        if st not in (200, 201):
            print(f"    pt-BR loc FAIL {st}: {bd[:200]}")

        # Price schedule
        st, bd = asc_set_price(iap_id, s["apple_tier"])
        if st not in (200, 201):
            print(f"    price schedule FAIL {st}: {bd[:300]}")
            results[pid] = {"status": "partial", "id": iap_id, "locs": loc_results, "price_http": st, "price_body": bd[:200]}
        else:
            print(f"    price tier R$ {s['apple_tier']} attached")
            results[pid] = {"status": "created", "id": iap_id, "locs": loc_results, "price_tier_brl": s["apple_tier"]}
    return results


# -------------------- Google Play --------------------
def gplay_token():
    creds = service_account.Credentials.from_service_account_file(
        GPLAY_SA_PATH,
        scopes=["https://www.googleapis.com/auth/androidpublisher"],
    )
    creds.refresh(GAuthRequest())
    return creds.token


def gplay_auth(tok):
    return {"Authorization": "Bearer " + tok}


def gplay_list(tok):
    """List existing one-time products (new Monetization API)."""
    url = f"https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{GPLAY_PACKAGE}/oneTimeProducts?pageSize=200"
    st, bd = http("GET", url, gplay_auth(tok))
    if st not in (200, 204):
        return st, bd, {}
    if st == 204 or not bd.strip():
        return 200, "", {}
    d = json.loads(bd)
    out = {}
    for item in d.get("oneTimeProducts", []):
        pid = item.get("productId")
        if pid:
            # Find the purchase option state(s)
            opts = item.get("purchaseOptions", [])
            states = [o.get("state") for o in opts]
            out[pid] = {"id": pid, "states": states, "options": opts}
    return 200, "", out


def gplay_upsert(tok, sku):
    url = (
        f"https://androidpublisher.googleapis.com/androidpublisher/v3/applications/"
        f"{GPLAY_PACKAGE}/onetimeproducts/{sku['sku']}"
        f"?allowMissing=true&regionsVersion.version={urllib.request.quote(GPLAY_REGIONS_VERSION)}"
        f"&updateMask=listings,purchaseOptions,taxAndComplianceSettings"
    )
    body = {
        "packageName": GPLAY_PACKAGE,
        "productId": sku["sku"],
        "listings": [
            {"languageCode": "pt-BR", "title": sku["name_pt"], "description": sku["desc_pt_long"]},
            {"languageCode": "en-US", "title": sku["name_en"], "description": sku["desc_en_long"]},
        ],
        "purchaseOptions": [
            {
                "purchaseOptionId": "default",
                "buyOption": {
                    "legacyCompatible": True,
                    "multiQuantityEnabled": False,
                },
                "regionalPricingAndAvailabilityConfigs": [
                    {
                        "regionCode": "BR",
                        "price": {
                            "currencyCode": "BRL",
                            "units": sku["gplay_units"],
                            "nanos": sku["gplay_nanos"],
                        },
                        "availability": "AVAILABLE",
                    }
                ],
                "newRegionsConfig": {
                    # Required by Google Play schema. USD/EUR prices roughly
                    # match the BRL tier (5 BRL ~ 1 USD ~ 0.9 EUR; tweak in UI later).
                    "usdPrice": {
                        "currencyCode": "USD",
                        "units": sku["new_regions_usd_units"],
                        "nanos": sku["new_regions_usd_nanos"],
                    },
                    "eurPrice": {
                        "currencyCode": "EUR",
                        "units": sku["new_regions_eur_units"],
                        "nanos": sku["new_regions_eur_nanos"],
                    },
                    "availability": "AVAILABLE",
                },
            }
        ],
        "taxAndComplianceSettings": {"isTokenizedDigitalAsset": False},
    }
    return http("PATCH", url, gplay_auth(tok), body)


def gplay_activate(tok, sku_id):
    url = (
        f"https://androidpublisher.googleapis.com/androidpublisher/v3/applications/"
        f"{GPLAY_PACKAGE}/oneTimeProducts/{sku_id}/purchaseOptions:batchUpdateStates"
    )
    body = {
        "requests": [
            {
                "activatePurchaseOptionRequest": {
                    "packageName": GPLAY_PACKAGE,
                    "productId": sku_id,
                    "purchaseOptionId": "default",
                }
            }
        ]
    }
    return http("POST", url, gplay_auth(tok), body)


def run_google():
    print("\n=== GOOGLE Play Developer (Monetization v3) ===")
    if not os.path.exists(GPLAY_SA_PATH):
        print(f"  MISSING SA file: {GPLAY_SA_PATH}")
        return {}
    try:
        tok = gplay_token()
        print(f"  OAuth token minted (len={len(tok)})")
    except Exception as e:
        print(f"  Token mint FAILED: {e}")
        return {}

    st, body, existing = gplay_list(tok)
    if st != 200:
        print(f"  list FAILED status={st}: {body[:400]}")
        return {}
    diamonds_existing = {k: v for k, v in existing.items() if k.startswith("chatyy_diamonds_")}
    print(f"  existing oneTimeProducts (total {len(existing)}, diamond {len(diamonds_existing)}): {list(diamonds_existing.keys())}")

    results = {}
    for s in SKUS:
        sku = s["sku"]
        already = sku in existing
        st, bd = gplay_upsert(tok, s)
        if st not in (200, 201):
            print(f"  [FAIL] {sku} upsert HTTP {st}: {bd[:300]}")
            results[sku] = {"status": "error", "step": "upsert", "http": st, "body": bd[:300]}
            continue
        action = "updated" if already else "created"
        print(f"  [OK]   {sku} {action} (BRL {s['gplay_units']}.{s['gplay_nanos']//10000000:02d})")

        # Activate the purchase option (no-op if already active)
        st2, bd2 = gplay_activate(tok, sku)
        if st2 in (200, 201):
            print(f"    activated default purchase option")
            results[sku] = {"status": "active", "id": sku, "previously_existed": already}
        else:
            # Activation can fail with INVALID_ARGUMENT if already active — treat as soft success
            short = bd2[:200].replace("\n", " ")
            print(f"    activate HTTP {st2}: {short}")
            results[sku] = {"status": action, "id": sku, "activate_http": st2, "activate_body": short, "previously_existed": already}
    return results


# -------------------- main --------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apple", action="store_true")
    ap.add_argument("--google", action="store_true")
    ap.add_argument("--verify-only", action="store_true")
    args = ap.parse_args()

    do_apple = args.apple or (not args.apple and not args.google)
    do_google = args.google or (not args.apple and not args.google)

    if args.verify_only:
        if do_apple:
            print("\n[VERIFY] Apple IAPs:")
            st, body, existing = asc_list_iaps()
            target = {s["sku"] for s in SKUS}
            ours = [k for k in existing if k in target]
            print(f"  HTTP {st} -- total {len(existing)} -- ours {len(ours)}/{len(target)}")
            for sku in sorted(target):
                if sku in existing:
                    print(f"    [OK] {sku}  id={existing[sku]['id']}  state={existing[sku]['state']}")
                else:
                    print(f"    [--] {sku}  MISSING")
        if do_google:
            print("\n[VERIFY] Google Play oneTimeProducts:")
            tok = gplay_token()
            st, body, existing = gplay_list(tok)
            target = {s["sku"] for s in SKUS}
            ours = [k for k in existing if k in target]
            print(f"  HTTP {st} -- total {len(existing)} -- ours {len(ours)}/{len(target)}")
            for sku in sorted(target):
                if sku in existing:
                    print(f"    [OK] {sku}  states={existing[sku]['states']}")
                else:
                    print(f"    [--] {sku}  MISSING")
        return 0

    summary = {}
    if do_apple:
        summary["apple"] = run_apple()
    if do_google:
        summary["google"] = run_google()
    print("\n=== SUMMARY ===")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
