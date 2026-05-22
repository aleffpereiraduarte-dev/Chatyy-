# 07 — Signal Protocol E2EE for Voice/Video Calls

**Author:** Agent 7 of 10 — WhatsApp migration design series
**Status:** DESIGN ONLY — no production code touched
**Scope:** Extend our tweetnacl-based chat E2EE to call media (SRTP keys), matching WhatsApp's documented stack: **Noise Pipes (transport) → Signal Protocol (E2E) → FunXMPP (signaling)**.

---

## 1. Goals & Non-Goals

**Goals**
- Every 1:1 and group call has a **per-call 256-bit master secret** that the server never sees.
- SRTP/SRTCP session keys are HKDF-derived from that master secret.
- Multi-device delivery (each callee device gets its own ciphertext copy).
- Forward secrecy via periodic master rotation on long calls.
- Reuse our existing identity / pre-key infrastructure (`chat_device_key_publish`).

**Non-Goals**
- Replacing PJSIP / LiveKit. We layer E2EE keys **on top** of existing SDP/SRTP negotiation.
- TURN/STUN path encryption (handled by DTLS at hop level).
- Replacing Telnyx for PSTN (PSTN calls cannot be E2EE — clearly flagged in UI).

---

## 2. Key Exchange Sequence (ASCII)

```
Caller (Alice, device A1)              Server (chat.php / WS)          Callee (Bob, devices B1, B2)
─────────────────────────             ─────────────────────           ─────────────────────────────
1. random master M (32 B)
2. fetch Bob's device bundles  ──────► chat_device_bundles_fetch
                              ◄──────  [(B1.idPub, B1.signedPre, B1.otp_k),
                                        (B2.idPub, B2.signedPre, B2.otp_k)]
3. for each Bob device Bi:
     X3DH(A1.idPriv, A1.eph, Bi.idPub,
          Bi.signedPre, Bi.otp_k) → SK_i
     ct_i = AEAD(SK_i, M || call_id || sdp_fp)
4. call_invite_e2ee {                   FunXMPP-like envelope
     call_id, caller=A1,                stored ephemerally,
     fingerprint_sdp,                   pushed to Bob devices
     keys: [{B1, ct_1}, {B2, ct_2}]  ──► relay (no plaintext access)──►  5. Bi:
   }                                                                       SK_i = X3DH(...)
                                                                           M = AEAD_open(SK_i, ct_i)
                                                                           verify call_id, sdp_fp
                                                                       6. derive SRTP keys via HKDF
                                                                          (see §4)
7. ◄──── DTLS-SRTP handshake over LiveKit/PJSIP (media plane) ──────►
   Both sides also verify SDP fingerprint matches sdp_fp from step 4
   (binds Signal channel to SRTP channel — prevents MITM at media SFU)

8. Every N minutes (default 15):
   Alice rolls M' = HKDF(M, "rotate", counter)
   call_key_rotate event over Signal envelope; both sides advance HKDF salt
```

The `sdp_fp` binding (step 7) is the critical anti-relay defense: even if the media SFU substitutes its own DTLS cert, the fingerprint mismatch aborts the call.

---

## 3. Cryptographic Primitives & Libraries

| Layer | Primitive | Library (native) | Library (web/RN-JS) |
|---|---|---|---|
| Identity / device keys | X25519 + Ed25519 | `libsignal-protocol-c` (BSD-3) | `@signalapp/libsignal-client` WASM, or our existing `tweetnacl` |
| Session establishment | X3DH | libsignal | libsignal-js / tweetnacl-based shim |
| Symmetric ratchet | Double Ratchet (HMAC-SHA256 + AES-256) | libsignal | libsignal-js |
| AEAD wrap | XChaCha20-Poly1305 (envelope) | libsodium | tweetnacl `secretbox` (XSalsa20-Poly1305) |
| KDF | HKDF-SHA256 | libsodium / libsignal | `@noble/hashes` |
| SRTP | AES-128-GCM (RFC 7714) or AES-256-CTR + HMAC-SHA1 | already in PJSIP / WebRTC stack | WebRTC stack |

We already have `tweetnacl` + identity/device keys live in `services/e2e.js`. Recommended path: **stay on tweetnacl/libsodium for envelope, adopt libsignal-js only for the Double Ratchet** when we add long-lived call rotation. Native PJSIP integration uses `libsignal-protocol-c` linked into our C++ WS (`/opt/chatyy-ws-cpp` already links libhiredis/libpqxx; adding libsignal is ~280 KB).

---

## 4. SRTP Key Derivation

```
master_secret M  (32 B)              from X3DH-wrapped envelope (§2)
salt           = first 14 B of HKDF(M, "", "chatyy-call-salt-v1", 14)
srtp_master_key_AB  = HKDF(M, salt, "srtp/A->B/key", 16)
srtp_master_salt_AB = HKDF(M, salt, "srtp/A->B/salt", 14)
srtp_master_key_BA  = HKDF(M, salt, "srtp/B->A/key", 16)
srtp_master_salt_BA = HKDF(M, salt, "srtp/B->A/salt", 14)
srtcp_*             = HKDF(M, salt, "srtcp/<dir>/<part>", ..)
```

Direction-asymmetric keys avoid the "two-time pad" attack if SSRC collides. Keys are injected into PJSIP/WebRTC via the `setSrtpKeyingMaterial` hook (PJSIP) or `RTCRtpSender.setParameters` extensions (web). DTLS-SRTP is **still negotiated** at media layer but its output is XORed with our keys → server-side SFU recordings produce ciphertext gibberish.

---

## 5. Group Calls — Sender Keys

Reuses the **sender-key distribution** we already ship for group chat (`chat_sender_key_distribute`). Each participant generates an SKDM (Sender Key Distribution Message):

```
sender_key_i     = random 32 B
sender_chain_key = HMAC-SHA256(sender_key_i, "chain")
sender_sig_key   = Ed25519 keypair
SKDM_i           = (sender_chain_key, sender_sig_pub, iteration=0)
```

For each peer device j in the call, Alice wraps `SKDM_i` with the same X3DH(Alice→j) channel used in §2. Joining mid-call: new participant requests SKDMs; existing members issue a fresh SKDM (forward secrecy: old media not decryptable by joiner). Leaving: surviving members rotate their sender key (post-compromise security on member kick).

SRTP keys per stream are derived from each sender's chain key — receivers maintain N concurrent decryptor contexts, one per SSRC/sender pair.

---

## 6. DB Schema Additions

```sql
-- Ephemeral per-call key state. Rows TTL'd 24h after call_end.
CREATE TABLE chat_call_keys (
  call_id          UUID PRIMARY KEY,
  caller_device_id TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotation_counter INT NOT NULL DEFAULT 0,
  sdp_fingerprint  TEXT NOT NULL,      -- hex sha-256 of DTLS cert; binds channels
  state            TEXT NOT NULL,      -- 'ringing'|'active'|'ended'
  ended_at         TIMESTAMPTZ
);

-- Per-recipient encrypted master copies (one row per callee device).
CREATE TABLE chat_call_key_envelopes (
  call_id           UUID REFERENCES chat_call_keys(call_id) ON DELETE CASCADE,
  recipient_device  TEXT NOT NULL,
  ciphertext        BYTEA NOT NULL,    -- AEAD output, ≤ 256 B
  ephemeral_pub     BYTEA NOT NULL,    -- caller's X25519 ephemeral
  one_time_pre_id   INT,               -- which OTP key was consumed
  delivered_at      TIMESTAMPTZ,
  PRIMARY KEY (call_id, recipient_device)
);

-- Group SKDM distribution.
CREATE TABLE chat_call_sender_keys (
  call_id            UUID,
  sender_device      TEXT,
  recipient_device   TEXT,
  skdm_ciphertext    BYTEA NOT NULL,
  iteration          INT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (call_id, sender_device, recipient_device, iteration)
);

CREATE INDEX idx_call_key_envelopes_recipient ON chat_call_key_envelopes(recipient_device, delivered_at);
```

The **master secret is never stored server-side** — only opaque ciphertext envelopes. After all envelopes are delivered (or 24h), rows are purged via cron (extending the existing `cron-worker.php` token-cleanup job).

---

## 7. Integration with Existing Stack

- **services/e2e.js** — add `wrapCallMaster(masterBytes, recipientBundle)` and `unwrapCallMaster(envelope)` reusing our X3DH primitives (`identityKeyPair`, `signedPreKey`, `oneTimePreKey`).
- **chat_device_key_publish** (PHP) — no change; bundle fetch already covers all callee devices.
- **New endpoints:**
  - `POST chat_call_invite_e2ee` — caller uploads `(call_id, sdp_fingerprint, envelopes[])`.
  - `POST chat_call_key_ack` — callee confirms decrypt, marks `delivered_at`.
  - `POST chat_call_key_rotate` — periodic rotation envelopes.
- **WS events** (`/opt/chatyy-ws-cpp`): `call_invite_e2ee`, `call_key_rotate`, `call_sender_key`. Push body carries only metadata + opaque blobs.
- **LiveKit hook** — we already self-host; configure LiveKit in **insertable-streams passthrough mode** so our SRTP layer wraps RTP payload before LK SFU sees it. For PJSIP native, use the `pjmedia_transport_srtp` custom keying callback.
- **Safety number UI** — surface in profile screen (matches WhatsApp): `SHA-256(idPub_self || idPub_peer)` rendered as 60-digit decimal in 12 groups of 5, plus QR.

---

## 8. Migration Path (Zero-Break Rollout)

1. **Phase 0 (week 0):** Ship DB schema + endpoints behind `CALL_E2EE_ENABLED=0`. No client changes. Endpoints return 501.
2. **Phase 1 (week 1):** Native + web clients add `wrapCallMaster` and `e2ee_supported=true` capability flag in `call_invite`. Caller sends BOTH legacy unencrypted invite AND e2ee envelope. Callee uses e2ee if both sides flag support, falls back to legacy SRTP (DTLS-only).
3. **Phase 2 (week 3):** Telemetry confirms ≥95% calls negotiate E2EE. Enable a per-account opt-in toggle ("End-to-end encrypted calls").
4. **Phase 3 (week 6):** Default ON for all 1:1 calls. Group calls Phase 4.
5. **Phase 4 (week 10):** Sender-keys group calls default ON. PSTN/SIP outbound (Telnyx) explicitly badged "**not E2EE**" — matches WhatsApp's behavior for SIP gateway calls.
6. **Kill-switch:** `CALL_E2EE_KILLSWITCH=1` in `/etc/mail-api.env` flips clients back to legacy. Mirrors our existing chat E2EE killswitch pattern (see memory: `e2ee_killswitch_off_2026_05_19`).

A wire-version byte in every envelope (`v=1`) lets us deprecate cleanly.

---

## 9. Threat Model & Risk Assessment

| Threat | Mitigation | Residual risk |
|---|---|---|
| SFU operator records media | SRTP keys derived from M which server never sees → ciphertext-only recording | Metadata (who-called-who, duration) still visible |
| Compromised callee device | X3DH ratchet rotation + master rotation every 15 min | That device's frames decryptable until rotation |
| MITM at media path (rogue SFU cert) | SDP fingerprint bound into encrypted envelope (§2 step 7) | None if user verifies safety number |
| Stolen one-time pre-key | OTP keys consumed once + signed by identity key | Replay only inside short bundle TTL |
| Multi-device — lost device | Identity key revocation via `chat_device_revoke`; surviving devices rotate sender keys | Window between loss and revoke |
| Forensic recovery from RAM | Master zeroized on call_end + `sodium_memzero` / `mlock` where available | Cold-boot attack still possible |
| Quantum (Harvest-Now-Decrypt-Later) | Out of scope v1; **track Signal's PQXDH adoption** (post-quantum X3DH); plan v2 | Acceptable for 2026 threat model |
| Backdoor via app update | Reproducible builds + cert pinning on update channel (already in place) | Trust the publisher |

---

## 10. Compliance & Export Controls

- **US EAR (Cat 5 Part 2):** Open-source crypto (libsignal, libsodium) — qualifies for License Exception ENC under §740.17(b)(1). File **email notification to BIS + NSA** (5D002, mass-market self-classified) when shipping outside US; one-time TSU notification suffices because primitives are publicly available.
- **Brazil:** No import licensing required for software crypto. ANATEL homologation unaffected (no RF change).
- **EU Dual-Use Reg 2021/821:** Same open-source carve-out (Annex I §5D002 note 3). No export license.
- **France / India / China / Russia / UAE:** Country-specific restrictions on E2EE call apps. We already geofence Russia for IAP — extend the geofence: in restricted jurisdictions, disable the E2EE toggle and display the legacy-SRTP-only badge. Coordinate with legal before Phase 3 GA.
- **CALEA / LI:** As an OTT app outside the US, we are not a Title II carrier. Document this position in legal-policy.md. PSTN bridge (Telnyx) carries lawful-intercept exposure on the telco side only — already disclosed in privacy policy.
- **GDPR / LGPD:** Master secrets and envelopes are pseudonymous keying material with ≤24h retention; falls under "technical and organizational measures" Art. 32. Update DPA appendix.
- **Apple / Play store:** Both stores explicitly permit E2EE; no extra review path. App Privacy Manifest already declares "Communications Content — not collected".

---

## 11. Open Questions for Agents 8–10

- Agent 8 (PJSIP integration): does our PJSIP fork expose `pjmedia_transport_srtp_create_2` keying callback, or do we need to patch?
- Agent 9 (LiveKit): confirm insertable-streams passthrough works with our SFU build (LK ≥ 1.5 required).
- Agent 10 (rollout): align kill-switch naming with the chat E2EE killswitch so ops has one mental model.

**File ends. ~1,470 words.**
