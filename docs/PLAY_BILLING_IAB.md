# Google Play Billing — Diamond IAP Setup

Live since 2026-05-19 (task #1203). Mirrors the iOS StoreKit flow but runs through Google Play Billing v6 via `expo-iap` 4.x. Same backend endpoint (`wallet_topup_verify`), same `chat_wallet_balances` credit, same idempotency table.

## Architecture

```
┌──────────────────┐         ┌────────────────────────┐         ┌──────────────────────┐
│ Android device   │         │  /var/www/mail/api/    │         │ Google Play          │
│ DiamondTopUpSheet│─POST───▶│  chat.php              │─HTTPS──▶│ androidpublisher v3  │
│ purchaseDiamonds │         │  wallet_topup_verify   │         │ SA-signed JWT        │
└──────────────────┘         └─────────┬──────────────┘         └──────────────────────┘
                                       │
                                       │ verify → credit → consume
                                       ▼
                              ┌────────────────────┐
                              │ chat_wallet_*      │ Postgres
                              │ (topups, balances, │
                              │  ledger)           │
                              └────────────────────┘
```

## Frontend pieces

| File | Role |
|------|------|
| `services/iap.js` | `initIAP`, `purchaseDiamonds`, `restorePurchases`, `flushPendingPurchases`, `_finalizePurchase` |
| `components/DiamondTopUpSheet.js` | Bottom sheet grid of packs, calls `purchaseDiamonds(pack.sku)` |
| `app/diamond-shop.js` | Full-screen shop, same flow |

The same code path serves iOS and Android because `expo-iap` exposes a unified JS surface. `Platform.OS === 'android'` branches only matter for:
- which fields end up in the `_finalizePurchase` POST (`purchase_token`, `order_id`, `package_name`)
- `flushPendingPurchases()` recovery on cold-start (Android-only — StoreKit replays via its own queue)

## Backend pieces (live in `/var/www/mail/api/chat.php`)

| Function | Role |
|----------|------|
| `_gplayAccessToken()` | SA JWT → OAuth2 access token, cached for ~50min in `/var/www/mail/data/gplay_access_token.json` |
| `_gplayVerifyPurchase($pkg, $sku, $token)` | GET `androidpublisher v3 purchases.products.get`; returns `state`, `order_id`, `acknowledged` |
| `_gplayConsumePurchase($pkg, $sku, $token)` | POST `:consume` — acknowledges + marks consumable so the user can rebuy. 409 treated as success (idempotent) |
| case `wallet_topup_verify` | Branches on `$platform`; for Android requires `purchase_token` + `package_name`, verifies, credits, consumes |

Idempotency: Android uses `gplay:<orderId>` (Google's authoritative orderId) as the topup key — defends against malicious clients submitting the same purchase under multiple `transaction_id`s.

## Play Console setup (manual — one-time per app)

### 1. Create the 5 in-app products

Play Console → **Monetize → Products → In-app products → Create product**.

For each SKU below: type **Managed product** (consumable), status **Active**, set price matching iOS:

| Product ID | Diamonds | Price BRL |
|------------|---------:|----------:|
| `chatyy_diamond_100`   |    100 |  R$ 4,99  |
| `chatyy_diamond_500`   |    550 |  R$ 19,99 |
| `chatyy_diamond_1500`  |  1.700 |  R$ 49,99 |
| `chatyy_diamond_5000`  |  6.000 |  R$ 149,99 |
| `chatyy_diamond_15000` | 19.500 |  R$ 399,99 |

Diamond counts (with bonus) must match `_walletPackCatalog()` in `chat.php` and `DIAMOND_PACKS` in `services/iap.js` — server is the source of truth (the SKU is the only thing the client tells us; we look up diamond count server-side).

### 2. Service account with Play Developer API access

Play Console → **Setup → API access**.

1. Click **Link** under "Linked Google Cloud projects" and link the `onemundo-52ca6` project (same one used for FCM).
2. Under **Service accounts**, either create a new SA *or* reuse `gcloud-sa-key.json` — but the SA must be granted permissions inside Play Console:
   - Click **Grant access** next to the SA.
   - Permissions: **View financial data, orders, and cancellation survey responses** + **Manage orders and subscriptions** (or any custom role with those two).
   - Restrict to the **com.onemundo.mail** app.
3. Download the JSON key.

### 3. Deploy the SA key to prod

```bash
# From local machine
scp gcloud-sa-key.json root@217.216.67.99:/etc/gplay-sa.json
ssh root@217.216.67.99 'chmod 640 /etc/gplay-sa.json && chown root:www-data /etc/gplay-sa.json'
```

If the SA is missing, `_gplayAccessToken()` returns `null` → verify fails with reason `no_sa_token` → **purchases get HTTP 402** and no diamonds credited. This is the fail-closed behavior we want; do not soften it.

### 4. License testing (sandbox purchases)

Play Console → **Setup → License testing** → add Gmail accounts that should be able to make test purchases for free. Add the QA accounts (`apitest@onemundo.com.br` if Gmail-linked, plus dev devices).

### 5. Upload an Internal Testing build

`expo-iap` requires the app to be installed via the Play Store (or Internal Testing track) to talk to Play Billing — sideloaded APKs return `BillingResponseCode.SERVICE_UNAVAILABLE`. After the next native rebuild:

```bash
scripts/ship.sh both "Google Play Billing IAB live (#1203)"
```

Internal Testing track gets the AAB automatically via `eas submit`. Open testers can install via the testing URL.

## QA checklist

- [ ] SA key deployed (`ls /etc/gplay-sa.json` on prod)
- [ ] 5 products active in Play Console (Active status, not Draft)
- [ ] License tester account installed via Internal Testing
- [ ] Buy chatyy_diamond_100 → see "Test card, always approves" → balance jumps to +100
- [ ] Backend log shows `[wallet_topup_verify.android]` only on failure paths (success = silent)
- [ ] `chat_wallet_topups` row created with `platform='android'` and `transaction_id` like `gplay:GPA.xxxxx`
- [ ] After purchase, `_gplayConsumePurchase` succeeds (no 409 unless replayed) — same SKU buyable again immediately
- [ ] Cold-start with airplane mode toggled mid-purchase: `flushPendingPurchases()` recovers and credits

## Failure modes

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| All Android purchases fail with `verify_failed:no_sa_token` | SA key missing or 600 perms | `chmod 640 /etc/gplay-sa.json && chown root:www-data` |
| `verify_failed:verify_failed` http=401 | SA lacks permission on the app | Re-grant "Manage orders" in Play Console |
| `verify_failed:verify_failed` http=404 | productId not registered or wrong package | Confirm SKU active + `package_name=com.onemundo.mail` |
| `purchase_state=2` | Pending payment (boleto, slow card) | Client should retry after Play notifies, or wait for RTDN webhook |
| `order_id_mismatch` | Client sent stale/forged orderId | Investigate device logs; backend uses Google's value |
| SKU not in catalog (frontend) | Product still propagating (~6h after create) or status=Draft | Wait or set Active |

## Future hardening (not blocking ship)

- Real-time Developer Notifications (RTDN) — Play pushes refund/cancel webhooks to a Pub/Sub topic. Wire a new endpoint `wallet_gplay_rtdn` that consumes the topic and reverses credit on `voidedPurchase` events.
- Subscriptions (Plus/Pro plans) on Android — same SA, different endpoint (`purchases.subscriptionsv2.get`).
