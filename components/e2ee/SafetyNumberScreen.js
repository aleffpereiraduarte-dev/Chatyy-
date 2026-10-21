// [e2ee5 WP-15 2026-10-21] Tela "Código de segurança" (E2EE v5, igual ao WhatsApp): QR + 60 dígitos
// em 12 grupos de 5, "Ler código" com a câmera, verificado/não verificado, copiar e compartilhar.
//
// Substitui o components/SafetyNumberSheet.js (v4, sha256 das chaves antigas) quando a flag liga;
// o antigo fica intocado até o WP-19b. Os números e o QR vêm SEMPRE do núcleo (CONTRATO §6.6):
//   core.safety_number(uid) → { digits (60), qr_payload "chatyy-sn:1:…" }
//   core.identity_status(uid).verified
//   core.verify_safety_qr(uid, lido) → bool (e marca verificado)   core.mark_verified(uid)
// Este componente NÃO calcula nada de cripto.
//
// Props:
//   visible, onClose, peerName
//   load: async () => ({ digits, qr_payload, verified })        (ou digits/qrPayload/verified diretos)
//   onVerifyScanned: async (texto lido) => boolean              (sem ela, o botão "Ler código" some)
//   onMarkVerified: async () => void                            (opcional: "Marcar como verificado")
import React, { useCallback, useEffect, useState } from 'react';
import { Modal, View, Text, Pressable, StyleSheet, ScrollView, ActivityIndicator, Platform, Share } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { isE2eeUiEnabled, safetyDigitGroups, safetyDigitsText, ShieldGlyph, LockGlyph, tx } from './e2eeUi';
import E2eeInfoSheet from './E2eeInfoSheet';

let QRCode = null;
try { QRCode = require('react-native-qrcode-svg').default; } catch {}
let Clipboard = null;
try { Clipboard = require('expo-clipboard'); } catch {}
let CameraView = null; let useCameraPermissions = null;
if (Platform.OS !== 'web') {
  try { const cam = require('expo-camera'); CameraView = cam.CameraView; useCameraPermissions = cam.useCameraPermissions; } catch {}
}

function Scanner({ onScanned, onCancel, t, colors }) {
  // Só montado no nativo com expo-camera presente (o hook precisa existir).
  const [perm, requestPerm] = useCameraPermissions();
  const [done, setDone] = useState(false);
  useEffect(() => { if (perm && !perm.granted && perm.canAskAgain) requestPerm(); }, [perm, requestPerm]);
  if (!perm) return <ActivityIndicator style={{ margin: 40 }} />;
  if (!perm.granted) {
    return (
      <View style={st.scanBox}>
        <Text style={[st.explain, { color: colors.textSecondary }]}>{tx(t, 'e2ee5.safety.camera_denied', 'Permita o acesso à câmera para ler o código.')}</Text>
        <Pressable onPress={onCancel} style={st.textBtn}><Text style={[st.textBtnLabel, { color: colors.text }]}>{tx(t, 'e2ee5.common.cancel', 'Cancelar')}</Text></Pressable>
      </View>
    );
  }
  return (
    <View style={st.scanBox}>
      <View style={st.camWrap}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={done ? undefined : ({ data }) => { setDone(true); onScanned(String(data || '')); }}
        />
      </View>
      <Pressable onPress={onCancel} style={st.textBtn} accessibilityRole="button">
        <Text style={[st.textBtnLabel, { color: colors.text }]}>{tx(t, 'e2ee5.common.cancel', 'Cancelar')}</Text>
      </Pressable>
    </View>
  );
}

export default function SafetyNumberScreen({ visible, onClose, peerName = '', load, digits: digitsProp, qrPayload: qrProp, verified: verifiedProp, onVerifyScanned, onMarkVerified }) {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const [data, setData] = useState(null);       // { digits, qr_payload, verified }
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState(null); // 'match' | 'mismatch' | null
  const [copied, setCopied] = useState(false);
  const [learn, setLearn] = useState(false);

  useEffect(() => {
    if (!visible) { setScanning(false); setScanResult(null); setCopied(false); return undefined; }
    let alive = true;
    if (typeof load === 'function') {
      setLoading(true);
      Promise.resolve().then(load).then((r) => { if (alive) setData(r || null); })
        .catch(() => { if (alive) setData(null); })
        .finally(() => { if (alive) setLoading(false); });
    } else {
      setData({ digits: digitsProp, qr_payload: qrProp, verified: !!verifiedProp });
    }
    return () => { alive = false; };
  }, [visible, load, digitsProp, qrProp, verifiedProp]);

  const name = peerName || tx(t, 'e2ee5.common.contact', 'o contato');
  const groups = safetyDigitGroups(data && data.digits);
  const verified = !!(data && data.verified) || scanResult === 'match';
  const accent = colors.accent || colors.primary;

  const onScanned = useCallback(async (txt) => {
    setScanning(false);
    let ok = false;
    try { ok = !!(await onVerifyScanned(txt)); } catch { ok = false; }
    setScanResult(ok ? 'match' : 'mismatch');
    if (ok) setData((d) => (d ? { ...d, verified: true } : d));
  }, [onVerifyScanned]);

  const copy = useCallback(async () => {
    const s = safetyDigitsText(data && data.digits);
    if (!s) return;
    try { if (Clipboard && Clipboard.setStringAsync) await Clipboard.setStringAsync(s); else if (Platform.OS === 'web') await navigator.clipboard.writeText(s); setCopied(true); } catch {}
  }, [data]);

  const share = useCallback(() => {
    const s = safetyDigitsText(data && data.digits);
    if (!s) return;
    const msg = tx(t, 'e2ee5.safety.share_text', 'Nosso código de segurança do Chatyy:\n{code}', { code: s });
    try { Share.share({ message: msg }); } catch {}
  }, [data, t]);

  const markVerified = useCallback(async () => {
    try { await onMarkVerified(); setData((d) => (d ? { ...d, verified: true } : d)); } catch {}
  }, [onMarkVerified]);

  if (!visible || !isE2eeUiEnabled()) return null;
  const close = () => { try { onClose && onClose(); } catch {} };
  const canScan = !!onVerifyScanned && !!CameraView && !!useCameraPermissions;

  return (
    <Modal visible animationType="slide" presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : undefined} onRequestClose={close}>
      <View style={[st.screen, { backgroundColor: colors.background }]}>
        <View style={[st.header, { borderBottomColor: colors.divider || colors.border }]}>
          <Pressable onPress={close} hitSlop={12} accessibilityRole="button" accessibilityLabel={tx(t, 'e2ee5.common.close', 'Fechar')} style={st.headerBtn}>
            <Text style={[st.headerX, { color: colors.text }]}>{'×'}</Text>
          </Pressable>
          <Text style={[st.headerTitle, { color: colors.text }]} accessibilityRole="header" numberOfLines={1}>{tx(t, 'e2ee5.safety.title', 'Código de segurança')}</Text>
          <View style={st.headerBtn} />
        </View>
        <ScrollView contentContainerStyle={st.body}>
          {loading ? <ActivityIndicator style={{ marginTop: 60 }} /> : null}
          {!loading && !groups.length ? (
            <View style={st.empty}>
              <LockGlyph size={28} color={colors.textSecondary} filled={false} />
              <Text style={[st.explain, { color: colors.textSecondary, marginTop: 14 }]}>{tx(t, 'e2ee5.safety.unavailable', 'O código de segurança aparece depois que vocês trocarem mensagens com criptografia de ponta a ponta.')}</Text>
            </View>
          ) : null}
          {!loading && groups.length ? (
            <>
              {scanning && canScan ? (
                <Scanner onScanned={onScanned} onCancel={() => setScanning(false)} t={t} colors={colors} />
              ) : (
                <View style={[st.qrCard, { backgroundColor: '#FFFFFF', borderColor: isDark ? 'transparent' : (colors.border || '#eee') }]}>
                  {QRCode && data.qr_payload ? (
                    <QRCode value={String(data.qr_payload)} size={196} color="#111111" backgroundColor="#FFFFFF" ecl="M" />
                  ) : <View style={{ width: 196, height: 196 }} />}
                </View>
              )}
              <View style={st.grid} accessible accessibilityLabel={groups.join(' ')}>
                {[0, 1, 2].map((r) => (
                  <View key={r} style={st.gridRow}>
                    {groups.slice(r * 4, r * 4 + 4).map((g, i) => (
                      <Text key={i} style={[st.group, { color: colors.text }]} selectable>{g}</Text>
                    ))}
                  </View>
                ))}
              </View>
              {scanResult ? (
                <View style={[st.result, { backgroundColor: scanResult === 'match' ? (isDark ? 'rgba(52,199,89,0.16)' : '#E7F6EC') : (isDark ? 'rgba(255,69,58,0.16)' : '#FDECEC') }]}>
                  <ShieldGlyph size={16} check={scanResult === 'match'} color={scanResult === 'match' ? (isDark ? '#7EE2A0' : '#1E7B3C') : (isDark ? '#FF8A80' : '#B3261E')} />
                  <Text style={[st.resultText, { color: scanResult === 'match' ? (isDark ? '#7EE2A0' : '#1E7B3C') : (isDark ? '#FF8A80' : '#B3261E') }]}>
                    {scanResult === 'match'
                      ? tx(t, 'e2ee5.safety.match', 'Os códigos são iguais. A conversa com {name} está verificada.', { name })
                      : tx(t, 'e2ee5.safety.mismatch', 'Os códigos não correspondem. Confira se você leu o código no aparelho de {name}.', { name })}
                  </Text>
                </View>
              ) : null}
              {verified && scanResult !== 'match' ? (
                <View style={st.verifiedRow}>
                  <ShieldGlyph size={15} check color={colors.text} />
                  <Text style={[st.verifiedText, { color: colors.text }]}>{tx(t, 'e2ee5.safety.verified', 'Verificado')}</Text>
                </View>
              ) : null}
              <Text style={[st.explain, { color: colors.textSecondary }]}>
                {tx(t, 'e2ee5.safety.explain', 'Para confirmar que as mensagens com {name} são protegidas com criptografia de ponta a ponta, compare os números acima com os que aparecem no aparelho de {name}. Vocês também podem ler o código QR um do outro.', { name })}{' '}
                <Text style={{ color: accent, fontWeight: '600' }} onPress={() => setLearn(true)} accessibilityRole="link">{tx(t, 'e2ee5.msg.learn_more', 'Saiba mais')}</Text>
              </Text>
              <View style={st.actions}>
                {canScan && !scanning ? (
                  <Pressable onPress={() => { setScanResult(null); setScanning(true); }} style={[st.primaryBtn, { backgroundColor: accent }]} accessibilityRole="button">
                    <Text style={[st.primaryLabel, { color: colors.onAccent || colors.onPrimary || '#fff' }]}>{tx(t, 'e2ee5.safety.scan', 'Ler código')}</Text>
                  </Pressable>
                ) : null}
                {onMarkVerified && !verified ? (
                  <Pressable onPress={markVerified} style={st.textBtn} accessibilityRole="button">
                    <Text style={[st.textBtnLabel, { color: accent }]}>{tx(t, 'e2ee5.safety.mark_verified', 'Marcar como verificado')}</Text>
                  </Pressable>
                ) : null}
                <View style={st.rowBtns}>
                  <Pressable onPress={copy} style={st.textBtn} accessibilityRole="button">
                    <Text style={[st.textBtnLabel, { color: colors.text }]}>{copied ? tx(t, 'e2ee5.safety.copied', 'Código copiado') : tx(t, 'e2ee5.safety.copy', 'Copiar código')}</Text>
                  </Pressable>
                  <Pressable onPress={share} style={st.textBtn} accessibilityRole="button">
                    <Text style={[st.textBtnLabel, { color: colors.text }]}>{tx(t, 'e2ee5.safety.share', 'Compartilhar')}</Text>
                  </Pressable>
                </View>
              </View>
            </>
          ) : null}
        </ScrollView>
        {learn ? <E2eeInfoSheet visible mode="learn" onClose={() => setLearn(false)} /> : null}
      </View>
    </Modal>
  );
}

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, Menlo, Consolas, monospace' });
const st = StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingTop: Platform.OS === 'android' ? 12 : 10, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  headerBtn: { width: 44, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerX: { fontSize: 28, lineHeight: 30 },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600' },
  body: { alignItems: 'center', paddingHorizontal: 24, paddingTop: 24, paddingBottom: 40 },
  empty: { alignItems: 'center', marginTop: 60, paddingHorizontal: 12 },
  qrCard: { padding: 14, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth },
  scanBox: { alignItems: 'center', width: '100%' },
  camWrap: { width: 240, height: 240, borderRadius: 16, overflow: 'hidden', backgroundColor: '#000' },
  grid: { marginTop: 22, marginBottom: 8 },
  gridRow: { flexDirection: 'row', justifyContent: 'center' },
  group: { fontFamily: MONO, fontSize: 19, letterSpacing: 1, marginHorizontal: 8, marginVertical: 5 },
  result: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, marginTop: 10, maxWidth: 440 },
  resultText: { flex: 1, fontSize: 14, lineHeight: 19, marginLeft: 8 },
  verifiedRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  verifiedText: { fontSize: 14, fontWeight: '600', marginLeft: 6 },
  explain: { fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 14, maxWidth: 440 },
  actions: { alignItems: 'center', marginTop: 22, width: '100%' },
  primaryBtn: { borderRadius: 999, paddingHorizontal: 28, paddingVertical: 12, minWidth: 200, alignItems: 'center' },
  primaryLabel: { fontSize: 16, fontWeight: '600' },
  rowBtns: { flexDirection: 'row', justifyContent: 'center', marginTop: 6 },
  textBtn: { paddingHorizontal: 14, paddingVertical: 12 },
  textBtnLabel: { fontSize: 15, fontWeight: '500' },
});
