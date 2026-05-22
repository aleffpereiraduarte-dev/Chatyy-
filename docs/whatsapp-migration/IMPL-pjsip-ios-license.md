# PJSIP iOS — Commercial License Procurement (LEGAL BLOCKER)

> **STATUS:** OPEN — blocks merge of any PR that links `PJSIP.xcframework` into
> `Chatyy.ipa`. Build infra (Agent 6) is scaffolded; no link step exists yet.
>
> **DO NOT MERGE THIS PR (or any downstream phase 2 PR) until legal signs the
> Teluu commercial license. Linking PJSIP into `Chatyy.ipa` without it = GPL
> violation — Chatyy source becomes redistributable under GPLv2 and Apple's
> repackaging on App Store upload likely counts as redistribution.**

---

## Why a commercial license

PJSIP/PJProject 2.14.1 (`https://github.com/pjsip/pjproject`) is dual-licensed:

1. **GPLv2 + FOSS exception** — only safe if Chatyy itself ships under one of
   the listed FOSS licenses (Apache 2.0, MIT, BSD, MPL, LGPL, GPL...). Chatyy
   is a proprietary closed-source product. The FOSS exception does NOT apply.
2. **LGPL** — Teluu does NOT offer PJSIP under LGPL. (Common confusion; only
   linphone-sdk does.)
3. **Commercial license from Teluu** — single-app perpetual, allows static
   linking into a closed-source IPA. Industry-standard for SIP-in-app vendors.

WhatsApp, Zoom, 8x8, RingCentral, Vonage all hold one. The license is required
even for "free" apps that don't sell SIP; the trigger is *closed-source
redistribution*, not commercial intent.

## Cost estimate

| Tier | One-time | Apps | Support | Notes |
|------|----------|------|---------|-------|
| Standard | USD $4,000 | 1 (com.onemundo.mail) | none | Sufficient for Chatyy |
| Standard + support | USD $6,000 | 1 | 1 yr email | Recommended — debugging help worth it |
| Multi-app | USD $8,000 | up to 3 | none | Future-proof if BoraUm adopts too |

All tiers: perpetual, no royalties, source access included (for our own
patches). Update access: 1 year at standard, lifetime at enterprise.

## Procurement steps

- [ ] **Step 1 — Quote request** (owner: founder)
  Send a quote request to `licensing@teluu.com`. Template:

  ```
  Subject: Commercial license quote — PJProject 2.14.x for iOS + Android app

  Hello,

  We're integrating PJProject 2.14.1 into our closed-source mobile app
  (iOS bundle id com.onemundo.mail, Android com.chatyy.app). Please quote
  the single-app perpetual commercial license with 1 year of email support
  and source-tree access.

  App details:
   - Name: Chatyy (Brazilian super-app — chat, calls, email)
   - Distribution: Apple App Store + Google Play (free, no SIP-product sale)
   - Expected MAU: 100k (12-month horizon)
   - Use of PJSIP: SIP UA for voice + video calls (Opus codec, SDES SRTP,
     ICE/STUN/TURN against our own Kamailio + Telnyx). No reselling.

  Please advise on tier options + payment terms (wire/PayPal).

  Thanks,
  <founder name>
  Chatyy / OneMundo
  CNPJ <…>
  ```

- [ ] **Step 2 — Term sheet review** (owner: legal, est. 1 week response)
  Confirm: perpetual, no per-install royalty, allows static linking into
  IPA/AAB, allows future minor-version PJSIP updates, transferable if
  com.onemundo.mail bundle changes ownership.

- [ ] **Step 3 — Sign + wire payment** (owner: founder + finance)
  Get a signed PDF copy of the license. Store at `s3://chatyy-legal/pjsip-license-<YYYYMMDD>.pdf`
  (NOT in this repo). Update [License status](#license-status) below.

- [ ] **Step 4 — Update this doc + remove blocker** (owner: build agent)
  Flip [License status](#license-status) to `SIGNED`, add the PDF SHA-256 to
  the audit trail below, and the merge gate in CI can pass for downstream
  Phase 2 PRs.

- [ ] **Step 5 — Notify Apple legal** (owner: legal, optional)
  Apple Developer Program agreement requires you to retain third-party
  licenses on request. Keep the PDF on file; no proactive disclosure needed.

## License status

```
STATUS:        UNSIGNED  ← FLIP TO "SIGNED" AFTER PROCUREMENT
TIER:          (TBD)
SIGNATORY:     (TBD)
DATE:          (TBD)
PDF_SHA256:    (TBD)
EXPIRES:       perpetual (commercial license)
SUPPORT_UNTIL: (TBD — typically purchase date + 365d)
```

## CI / merge gate

The CI workflow `.github/workflows/ios-build.yml` (added in Phase 2) MUST check
the value above before linking the xcframework. Until status is `SIGNED`:

- `scripts/pjsip/build-ios.sh` is allowed (build infra only).
- Podfile MUST NOT contain `pod 'PJSIP', :path => 'vendor/pjsip-ios'`.
- `Chatyy.xcodeproj` MUST NOT have `PJSIP.xcframework` in Frameworks.
- Any PR touching either is auto-rejected by `tools/ci/check-pjsip-license.sh`
  (script TBD in Phase 2 prep — Agent 7).

## Plan-B (if Teluu refuses or quotes >$10k)

Switch to **linphone-sdk** (`https://gitlab.linphone.org/BC/public/linphone-sdk`).
- Pros: LGPL — closed-source linking allowed if dynamically loaded; SIP UA
  feature parity; iOS xcframework prebuilt.
- Cons: heavier (≈18 MB per slice vs PJSIP's 12 MB), less battle-tested for
  background VoIP push, GPL/LGPL viral risk if we patch the source statically.
- Decision: only triggered if Teluu does not respond within 14 days or quote
  exceeds USD $10k.

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Teluu silent > 2 weeks | M | M | Fall back to linphone-sdk (LGPL) |
| Quote > budget | L | M | Escalate, or buy multi-app tier for amortized cost |
| License loses "Apple App Store" clause | L | H | Demand explicit redistribution clause in term sheet |
| GPL violation leak (someone links xcframework pre-signing) | L | severe | CI gate (above) + CODEOWNERS on Podfile + this doc |

## References

- PJSIP licensing: https://www.pjsip.org/licensing.htm
- WhatsApp using PJSIP: webrtchacks 2023 ("Decoding WhatsApp Voice Calls")
- GPLv2 + Apple Store incompatibility: FSF FAQ — gpl-violations.org thread on
  VLC iOS removal (2011), and Free Software Foundation Europe legal opinion.

---

**Owner:** founder + legal counsel
**Last reviewed:** 2026-05-21 (Agent 6 build infra)
**Next review:** when first quote arrives from Teluu
