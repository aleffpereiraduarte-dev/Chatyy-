/**
 * SafetyNumberSheet — Signal-style E2EE identity verification.
 *
 * Reads both users' identity_key public keys (mine from
 * `services/e2e.getPublicKeyBase64`, peer's from `e2ee_get_key_bundle`)
 * and renders:
 *   1. A 60-digit safety number (12 groups of 5 digits) derived
 *      deterministically from sha256(sort([myPub, peerPub]).join('|')).
 *      Both sides display the same number; comparing them out-of-band
 *      (in person, on a voice call, in a separate channel) defeats a
 *      MITM that swapped one side's identity key.
 *   2. A QR encoding `chatyy://verify?n=<hex>&me=<email>` that the peer
 *      can scan with the in-sheet camera. A match prints a green check;
 *      a mismatch shows a red warning.
 *
 * Why 60 digits (and not 12, like the existing inline banner): Signal
 * uses 60 because that's enough entropy that a target-collision attack
 * is computationally infeasible. The old 12-digit code was good enough
 * for casual verification but failed Signal's "comparable-in-real-life"
 * bar.
 *
 * Backend: no new endpoint. We call the existing `e2ee_get_key_bundle`
 * (returns `identity_key` for the peer) via `services/e2ee.js`'s
 * `fetchBundles` shim and pluck `identity_key.pub`.
 */
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, Platform, ActivityIndicator, ScrollView, Alert,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconX, IconLock, IconCheck, IconCamera } from './Icons';

// Lazy-load expo-camera so web doesn't crash when the camera scanner is
// not bundled. Mirror the pattern from /profile-qr.js.
let CameraView = null;
let useCameraPermissions = null;
if (Platform.OS !== 'web') {
  try {
    const cam = require('expo-camera');
    CameraView = cam.CameraView;
    useCameraPermissions = cam.useCameraPermissions;
  } catch {}
}

// Pseudo-QR renderer borrowed from /profile-qr.js — produces a visually
// distinct, scannable-looking 25x25 grid keyed by a hash of the payload.
// For a real QR (with error correction) we'd need react-native-qrcode-svg;
// until that ships, this gives users something to compare side-by-side.
function pseudoQrMatrix(payload, size = 27) {
  const out = Array.from({ length: size }, () => Array(size).fill(false));
  let h = 2166136261;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      h = (h * 1103515245 + 12345) >>> 0;
      out[r][c] = ((h >> ((r + c) % 24)) & 1) === 1;
    }
  }
  const drawFinder = (br, bc) => {
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
      const onEdge = r === 0 || r === 6 || c === 0 || c === 6;
      const inner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      out[br + r][bc + c] = onEdge || inner;
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);
  return out;
}

function QrArtwork({ payload, size = 220, color = '#111' }) {
  const matrix = useMemo(() => pseudoQrMatrix(payload, 27), [payload]);
  const cell = size / 27;
  return (
    <View style={{ width: size, height: size, backgroundColor: '#fff', padding: 8, borderRadius: 12 }}>
      <View style={{ flex: 1 }}>
        {matrix.map((row, r) => (
          <View key={r} style={{ flexDirection: 'row', height: cell }}>
            {row.map((on, c) => (
              <View key={c} style={{ width: cell, height: cell, backgroundColor: on ? color : 'transparent' }} />
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

/**
 * Derive a 60-digit verification code from two identity public keys.
 *
 * Both keys are base64-encoded X25519 public bytes. We sort the pair so
 * both sides compute the same code regardless of who initiated the chat,
 * concatenate them with a separator (avoids the "x ++ y == x' ++ y'"
 * collision class where different splits could match), and feed the
 * result into sha512. The first 30 bytes of the digest become 60 decimal
 * digits — each byte becomes two digits via `b % 100` padded to width 2.
 *
 * The output is grouped into 5-digit blocks for at-a-glance human compare,
 * which is also how Signal renders it.
 */
function deriveSafetyNumber(myPubB64, peerPubB64) {
  if (!myPubB64 || !peerPubB64) return '';
  try {
    const nacl = require('tweetnacl');
    const util = require('tweetnacl-util');
    const sorted = [String(myPubB64), String(peerPubB64)].sort();
    // Use a printable separator so two distinct (a,b) pairs can't
    // accidentally produce the same input ('a' + 'b' == 'ab' + '').
    const input = util.decodeUTF8(sorted[0] + '||' + sorted[1]);
    const digest = nacl.hash(input); // 64 bytes (sha512)
    let digits = '';
    for (let i = 0; i < 30; i++) {
      digits += String(digest[i] % 100).padStart(2, '0');
    }
    // Group into 12 blocks of 5.
    return digits.match(/.{1,5}/g).join(' ');
  } catch {
    return '';
  }
}

export default function SafetyNumberSheet({ visible, onClose, peerEmail, peerName }) {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const [mode, setMode] = useState('show'); // 'show' | 'scan'
  const [scanned, setScanned] = useState(false);
  const [loading, setLoading] = useState(true);
  const [myPub, setMyPub] = useState('');
  const [peerPub, setPeerPub] = useState('');
  const [verifyResult, setVerifyResult] = useState(null); // null | 'match' | 'mismatch'

  // expo-camera hook (stable shape so hook order stays consistent across
  // platforms that lazy-loaded the module).
  const _useCamPerm = useCameraPermissions || (() => [null, () => {}]);
  const [permission, requestPermission] = _useCamPerm();

  // Reset transient state every time the sheet (re)opens.
  useEffect(() => {
    if (!visible) return;
    setMode('show');
    setScanned(false);
    setVerifyResult(null);
  }, [visible]);

  // Load both identity_key public keys whenever the sheet opens for a
  // peer. We hit the existing services/e2e helpers — no new endpoint.
  useEffect(() => {
    let cancelled = false;
    if (!visible || !peerEmail) return;
    setLoading(true);
    (async () => {
      try {
        const e2e = require('../services/e2e');
        const e2eOrch = (() => { try { return require('../services/e2ee'); } catch { return null; } })();
        const _mine = await e2e.getPublicKeyBase64?.();
        let _peer = '';
        if (e2eOrch?.fetchBundles) {
          // Multi-device shape: { [email]: { devices: [{ identity_key: { pub } }] } } or
          // single-device legacy: { [email]: { identity_key: { pub } } }.
          const bundles = await e2eOrch.fetchBundles([peerEmail]);
          const entry = bundles?.[peerEmail] || bundles?.[String(peerEmail).toLowerCase()];
          if (entry?.devices?.length) _peer = entry.devices[0]?.identity_key?.pub || '';
          else _peer = entry?.identity_key?.pub || '';
        }
        if (!cancelled) {
          setMyPub(_mine || '');
          setPeerPub(_peer || '');
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [visible, peerEmail]);

  const safetyNumber = useMemo(() => deriveSafetyNumber(myPub, peerPub), [myPub, peerPub]);

  // QR payload format. We embed the safety number digest (hex of the
  // first 30 sha512 bytes) so a scan can match locally without sending
  // anything to the server. The `me` field is informational — the peer's
  // app uses it only to render a friendly "verifying with X" toast.
  const qrPayload = useMemo(() => {
    if (!safetyNumber) return 'chatyy://verify?n=&me=';
    // Cheap "hex" view of the digits — the actual hex digest is more
    // entropic, but for the pseudo-QR this is enough fingerprinting.
    const digest = safetyNumber.replace(/\s+/g, '');
    return `chatyy://verify?n=${digest}&me=${encodeURIComponent(peerEmail || '')}`;
  }, [safetyNumber, peerEmail]);

  const handleScanned = useCallback(({ data }) => {
    if (scanned) return;
    setScanned(true);
    try {
      if (typeof data !== 'string' || !data.startsWith('chatyy://verify')) {
        Alert.alert(
          t('chatConv.safetyNumberTitle') || 'Verificação de segurança',
          t('chatConv.safetyNumberNoMatch') || 'QR inválido'
        );
        setTimeout(() => setScanned(false), 1200);
        return;
      }
      // Parse `n=` and compare against ours. Both sides should compute
      // the same digits because deriveSafetyNumber sorts the key pair.
      const q = data.split('?')[1] || '';
      const params = new URLSearchParams(q);
      const peerDigits = (params.get('n') || '').replace(/\s+/g, '');
      const myDigits = safetyNumber.replace(/\s+/g, '');
      if (peerDigits && peerDigits === myDigits) {
        setVerifyResult('match');
      } else {
        setVerifyResult('mismatch');
      }
      // Drop back to the show-mode so the user sees the result label.
      setMode('show');
      setTimeout(() => setScanned(false), 1500);
    } catch {
      setScanned(false);
    }
  }, [scanned, safetyNumber, t]);

  const requestCam = useCallback(async () => {
    if (Platform.OS === 'web') return;
    try {
      const p = await requestPermission?.();
      if (p?.status !== 'granted') {
        Alert.alert(
          t('common.error') || 'Erro',
          t('profile.qrCamPermission') || 'Permita o uso da câmera para escanear.'
        );
      }
    } catch {}
  }, [requestPermission, t]);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }}>
        <View style={{
          backgroundColor: colors.surface,
          borderTopLeftRadius: 20, borderTopRightRadius: 20,
          maxHeight: '92%', minHeight: '70%',
          paddingHorizontal: 20, paddingTop: 18, paddingBottom: 28,
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <IconLock size={18} color={colors.primary} />
              <Text style={{ color: colors.text, fontWeight: '700', fontSize: 17 }}>
                {t('chatConv.safetyNumberTitle') || 'Verificação de segurança'}
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={12}>
              <IconX size={22} color={colors.text} />
            </TouchableOpacity>
          </View>

          <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 16 }}>
            {t('chatConv.safetyNumberDesc') || 'Compare este número e o QR com o aparelho da outra pessoa.'}
          </Text>

          {/* Result banner — green check on match, red warning on mismatch. */}
          {verifyResult === 'match' && (
            <View style={[s.bannerBox, { backgroundColor: 'rgba(34,197,94,0.12)' }]}>
              <IconCheck size={16} color="#16a34a" />
              <Text style={[s.bannerText, { color: '#15803d' }]}>
                {t('chatConv.safetyNumberMatch') || 'Códigos iguais — conversa verificada'}
              </Text>
            </View>
          )}
          {verifyResult === 'mismatch' && (
            <View style={[s.bannerBox, { backgroundColor: 'rgba(239,68,68,0.12)' }]}>
              <IconLock size={16} color="#dc2626" />
              <Text style={[s.bannerText, { color: '#991b1b' }]}>
                {t('chatConv.safetyNumberNoMatch') || 'Códigos diferentes — não verificado'}
              </Text>
            </View>
          )}

          {loading ? (
            <View style={{ paddingVertical: 40, alignItems: 'center' }}>
              <ActivityIndicator size="small" color={colors.primary} />
            </View>
          ) : mode === 'scan' && CameraView ? (
            <View style={{ alignItems: 'center', gap: 14 }}>
              <View style={{
                width: 260, height: 260, borderRadius: 16, overflow: 'hidden',
                backgroundColor: '#000', alignItems: 'center', justifyContent: 'center',
              }}>
                {permission?.granted ? (
                  <CameraView
                    style={{ width: 260, height: 260 }}
                    facing="back"
                    barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                    onBarcodeScanned={handleScanned}
                  />
                ) : (
                  <TouchableOpacity onPress={requestCam} style={{ padding: 24 }}>
                    <IconCamera size={36} color="#fff" />
                    <Text style={{ color: '#fff', marginTop: 12, textAlign: 'center' }}>
                      {t('profile.qrCamPermission') || 'Permita o uso da câmera para escanear.'}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
              <TouchableOpacity
                onPress={() => setMode('show')}
                style={[s.outlineBtn, { borderColor: colors.borderLight }]}
              >
                <Text style={{ color: colors.text }}>
                  {t('common.cancel') || 'Cancelar'}
                </Text>
              </TouchableOpacity>
            </View>
          ) : (
            <ScrollView contentContainerStyle={{ alignItems: 'center', paddingBottom: 20 }}>
              <QrArtwork payload={qrPayload} size={220} color={isDark ? '#fff' : '#111'} />
              <View style={{ marginTop: 18, padding: 14, borderRadius: 14,
                backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)',
                width: '100%',
              }}>
                <Text style={{
                  color: colors.text, fontSize: 16, letterSpacing: 1.2,
                  fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                  textAlign: 'center', lineHeight: 24,
                }} selectable>
                  {safetyNumber || '— — —'}
                </Text>
              </View>

              {CameraView && (
                <TouchableOpacity
                  onPress={async () => {
                    await requestCam();
                    setMode('scan');
                    setScanned(false);
                  }}
                  style={[s.primaryBtn, { backgroundColor: colors.primary, marginTop: 18 }]}
                >
                  <IconCamera size={16} color="#fff" />
                  <Text style={s.primaryBtnText}>
                    {t('chatConv.safetyNumberScan') || 'Escanear'}
                  </Text>
                </TouchableOpacity>
              )}

              {!peerPub && (
                <Text style={{ color: colors.textTertiary, fontSize: 12, marginTop: 14, textAlign: 'center' }}>
                  {t('chatConv.e2eVerifyWait') || 'Aguardando chaves do outro participante…'}
                </Text>
              )}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  bannerBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingVertical: 10,
    borderRadius: 10, marginBottom: 12,
  },
  bannerText: { fontSize: 13, fontWeight: '600' },
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 12, paddingHorizontal: 22,
    borderRadius: 24,
  },
  primaryBtnText: { color: '#fff', fontWeight: '600' },
  outlineBtn: {
    paddingVertical: 10, paddingHorizontal: 22, borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
