# IMPL — PJSIP Android: pending legal / licensing action

> Status: **BLOCKER**. Build infrastructure is in place
> (`scripts/pjsip/build-android.sh`, `vendor/pjsip-android/`), but no
> `.aar` produced by it may be linked into a released APK/AAB until this
> ticket is closed. Mirrors the same legal item the iOS plan (Agent 6)
> raised for `vendor/pjsip-ios`.

Owner: TBD (founder / legal). Drafted by BUILD AGENT 7, 2026-05-21.

---

## 1. Problem statement

pjproject — the C library powering the entire Android call-engine
replacement described in
[`02-pjsip-android.md`](./02-pjsip-android.md) — is published by Teluu
Ltd. under a dual license:

- **GPLv2** (free), or
- **Commercial** (paid, terms negotiated per-product with Teluu).

The Chatyy / OneMundo Mail app is a closed-source product distributed
through the Apple App Store and Google Play. Linking GPLv2 code into a
proprietary product triggers GPL's "derivative work" + "viral" clauses:
the whole containing app would have to be released under GPLv2,
including source. That is not something we can do (we have third-party
SDK dependencies whose own licences forbid GPL relicensing — LiveKit
client, Firebase, expo-callkit's internal modules, etc.).

Therefore: **we cannot ship a PJSIP-linked release build until a
commercial license is in hand.** This applies to:

- Production builds (`eas build --profile production`).
- Internal-track / TestFlight beta builds distributed to humans outside
  the engineering team.
- Any artefact published to a public artefact store.

It does **NOT** apply to:

- Local developer builds for personal evaluation on a single device.
- CI dry-runs that produce binaries which are immediately discarded.
- Source-only commits to this repository.

(The script writers and reviewers have been operating under the second
category. The line gets crossed the moment a tester at
`duarte@chatyy.com.br` is given an APK.)

---

## 2. What we need to buy

| Item | Vendor | Approx cost | Notes |
|------|--------|-------------|-------|
| Commercial license, pjproject 2.14.x, single product, perpetual | Teluu Ltd. (`info@teluu.com`) | USD 5 000–15 000 | Historic pricing; quote required. |
| 1 year support / minor-version updates | Teluu | included in above for first year, then ~25 %/yr | Optional renewal. |
| Same coverage **for iOS** (Agent 6's `vendor/pjsip-ios`) | Teluu | bundle pricing — ask for combined quote | One legal package covering both platforms. |

Recommendation: a single contract covering both iOS and Android,
labelled "Chatyy Voice Engine" so future products under the
`com.onemundo.*` package family are covered.

### Negotiation points

- We do NOT redistribute the PJSIP source — only the linked `.so` (Android)
  and `.a` archives (iOS). Teluu's standard agreement covers this.
- Modified `pjmedia` (we added an AAudio + CameraX hook). Confirm the
  contract allows shipping a modified library without source release.
- Sub-licensing rights for derived works (e.g. an internal SDK exposed to
  a hypothetical third-party app). Probably not needed today; flag the
  question to keep options open.
- Termination: confirm clear language that an expired support contract
  does NOT terminate the perpetual license to ship versions built during
  the supported window.

---

## 3. Engineering hooks to add once licensed

These should be implemented as part of the *same PR* that drops the
licence PDF into the repo, so no race condition lets an unlicensed build
escape:

1. `legal/pjsip-commercial-license.pdf` — committed (small file, OK in
   git; if NDA-sensitive, store hash + path in a private S3 bucket
   referenced by env).
2. New env var consumed by `scripts/ship.sh`:
   ```
   PJSIP_LICENSED=true
   ```
   Without it, `ship.sh ios|android|both` aborts before any build/upload
   step if `vendor/pjsip-android/pjsip-*.aar` or `vendor/pjsip-ios/*.a`
   are referenced by the current commit.
3. CI guard in `.github/workflows/*` that fails the build if both:
   - The HEAD diff touches `vendor/pjsip-*` or `modules/expo-pjsip/**`,
   - AND the secret `PJSIP_LICENSED` is not set on the workflow.
4. In-app credit screen update: the commercial license usually requires
   a small "Powered by PJSIP" credit somewhere accessible. Add to
   `app/settings.js` → "About / Open source licences".

---

## 4. Timeline blocker map

From `02-pjsip-android.md` §8 (migration phases):

| Week | Phase | Legal gating |
|------|-------|--------------|
| W1 | Vendor `.aar`, wire no-op call. App still on LK. | Not blocked — engineering-only. |
| W2 | SIP REGISTER smoke test on emul-5554. | **Not blocked** — emulator on a single internal server. |
| W3 | A/B audio outbound vs LK behind flag. | **BLOCKED** — first phase that surfaces PJSIP code to a human tester. License must be signed before this week starts. |
| W4–W8 | Rollout phases. | Same blocker — already covered by W3 cutoff. |

So the contract must be **signed and counter-signed before week 3 of the
Android rollout starts.** Equivalent gating applies for iOS (Agent 6).

---

## 5. Action items (checklist)

- [ ] Request quote from `info@teluu.com` for **iOS + Android combined**
      commercial license, pjproject 2.14.x, single product
      (com.onemundo.mail).
- [ ] Founder to approve cost.
- [ ] Legal to review contract (3rd-party SDK compatibility, termination
      clause, source modification, App Store / Play Store distribution
      language).
- [ ] Sign + counter-sign. Drop PDF at `legal/pjsip-commercial-license.pdf`.
- [ ] Implement engineering hooks listed in §3 (single PR).
- [ ] Flip `PJSIP_LICENSED=true` in `scripts/ship.sh` env + GH Actions
      repo secret.
- [ ] Update [`02-pjsip-android.md`](./02-pjsip-android.md) §8 to mark
      the legal blocker resolved.
- [ ] Update [`01-pjsip-ios.md`](./01-pjsip-ios.md) §similar to mark the
      legal blocker resolved.
- [ ] First gated build: an `ABIS_OVERRIDE="arm64-v8a"` Android internal
      track build for emul-5554 QA.

---

## 6. References

- Teluu licensing: <https://www.pjsip.org/licensing.htm>
- pjproject GPL FAQ: <https://github.com/pjsip/pjproject/blob/master/COPYING>
- Internal: `vendor/pjsip-android/README.md` (build instructions).
- Internal: `docs/whatsapp-migration/02-pjsip-android.md` (architecture).
- Related: same item for iOS, owned by BUILD AGENT 6 (`vendor/pjsip-ios/`).
