// [e2ee5 WP-12 2026-10-21] Celular: confirmar e conduzir o vínculo do Chatyy Web lido pelo QR.
//
// Fluxo (nível WhatsApp): "Conectar este computador?" + escolha do histórico (D5: todo por padrão,
// opção "últimos 3 meses") → Face ID/código → canal cifrado com a web (services/e2ee/link) → progresso
// → "Aparelho conectado". O código de conferência de 2 dígitos aparece nos dois lados (opcional).
//
// Props: visible, qr (texto lido), onClose(result|null), onDone({deviceId}).
import React, { useEffect, useRef, useState } from 'react';
import { Modal, View, Text, Pressable, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLanguage } from '../../context/LanguageContext';
import { useGroupedColors } from '../settings/SettingsKit';
import { IconMonitor, IconCheck, IconAlertCircle } from '../Icons';
import { LockGlyph, tx } from './e2eeUi';
import * as link from '../../services/e2ee/link';

function errText(t, code) {
  switch (code) {
    case 'not_primary': return tx(t, 'e2ee5.link.err_not_primary', 'Só o celular principal da conta conecta outros aparelhos.');
    case 'disabled': return tx(t, 'e2ee5.link.err_disabled', 'A conexão com criptografia de ponta a ponta ainda não está disponível na sua conta.');
    case 'expired': return tx(t, 'e2ee5.link.err_expired', 'O QR expirou. Gere um novo para conectar.');
    case 'device_limit': return tx(t, 'e2ee5.link.err_limit', 'Sua conta já tem o máximo de aparelhos conectados. Desconecte um no celular e tente de novo.');
    case 'bad_qr': return tx(t, 'e2ee5.link.err_bad_qr', 'Este QR não é de conexão do Chatyy. Gere um novo no computador.');
    case 'network': return tx(t, 'e2ee5.link.err_network', 'Sem conexão. Verifique a internet e tente de novo.');
    case 'timeout': return tx(t, 'e2ee5.link.err_timeout', 'O computador não respondeu a tempo. Gere um novo QR e tente de novo.');
    case 'forbidden': return tx(t, 'e2ee5.link.err_forbidden', 'Este QR já foi usado por outra conta. Gere um novo no computador.');
    default: return tx(t, 'e2ee5.link.err_failed', 'Não foi possível conectar. Gere um novo QR e tente de novo.');
  }
}

function Choice({ selected, title, sub, onPress, g, testID }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="radio" accessibilityState={{ selected }} testID={testID}
      style={({ pressed }) => [st.choice, { borderColor: selected ? g.ink : g.separator, opacity: pressed ? 0.8 : 1 }]}>
      <View style={[st.radio, { borderColor: selected ? g.ink : g.tertiary }]}>{selected ? <View style={[st.radioDot, { backgroundColor: g.ink }]} /> : null}</View>
      <View style={st.choiceText}>
        <Text style={[st.choiceTitle, { color: g.text }]}>{title}</Text>
        {!!sub && <Text style={[st.choiceSub, { color: g.secondary }]}>{sub}</Text>}
      </View>
    </Pressable>
  );
}

export default function LinkPhoneSheet({ visible, qr, onClose, onDone }) {
  const { t } = useLanguage();
  const g = useGroupedColors();
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState('confirm'); // confirm | running | done | error
  const [history, setHistory] = useState('all');
  const [prog, setProg] = useState({});
  const [err, setErr] = useState(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    if (visible) { setPhase('confirm'); setHistory('all'); setProg({}); setErr(null); }
    return () => { aliveRef.current = false; };
  }, [visible, qr]);

  const close = (res) => {
    if (phase === 'running') link.cancelPhoneLink();
    onClose && onClose(res || null);
  };

  const start = async () => {
    try {
      const { confirmWithBiometric } = require('../../services/biometricGate');
      const ok = await confirmWithBiometric({ reason: tx(t, 'e2ee5.link.confirm_btn', 'Conectar') });
      if (!ok) return;
    } catch {}
    setPhase('running');
    setProg({ phase: 'connecting' });
    try {
      const r = await link.acceptLinkQr(qr, { history, onState: (s) => { if (aliveRef.current) setProg(s); } });
      if (!aliveRef.current) return;
      setPhase('done');
      onDone && onDone(r);
    } catch (e) {
      if (!aliveRef.current || (e && e.code === 'cancelled')) return;
      setErr((e && e.code) || 'failed');
      setPhase('error');
    }
  };

  const stepLabel = (() => {
    switch (prog.phase) {
      case 'waiting_device': return tx(t, 'e2ee5.link.p_waiting', 'Esperando o computador…');
      case 'waiting_upload': return tx(t, 'e2ee5.link.p_upload', 'Conferindo o aparelho…');
      case 'sending': return tx(t, 'e2ee5.link.p_sending', 'Enviando as chaves das conversas…');
      default: return tx(t, 'e2ee5.link.p_connecting', 'Conectando…');
    }
  })();

  return (
    <Modal visible={!!visible} transparent animationType="slide" onRequestClose={() => close(null)}>
      <Pressable style={st.backdrop} onPress={phase === 'running' ? undefined : () => close(null)} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
      <View style={[st.sheet, { backgroundColor: g.cardBg, paddingBottom: 18 + insets.bottom }]} testID="e2ee5-link-phone">
        <View style={[st.grabber, { backgroundColor: g.tertiary }]} />
        <View style={[st.iconWrap, { backgroundColor: g.fill }]}>
          {phase === 'done' ? <IconCheck size={28} color={g.text} /> : phase === 'error' ? <IconAlertCircle size={28} color={g.text} /> : <IconMonitor size={28} color={g.text} />}
        </View>

        {phase === 'confirm' && (
          <>
            <Text style={[st.title, { color: g.text }]} accessibilityRole="header">{tx(t, 'e2ee5.link.confirm', 'Conectar este computador?')}</Text>
            <Text style={[st.body, { color: g.secondary }]}>
              {tx(t, 'e2ee5.link.confirm_body', 'O Chatyy Web vai poder ler e enviar suas mensagens. Este celular manda para ele, cifradas, as chaves das suas conversas protegidas.')}
            </Text>
            <Text style={[st.section, { color: g.secondary }]}>{tx(t, 'e2ee5.link.history', 'Histórico das conversas protegidas')}</Text>
            <Choice g={g} selected={history === 'all'} onPress={() => setHistory('all')} testID="e2ee5-link-hist-all"
              title={tx(t, 'e2ee5.link.history_all', 'Todo o histórico')} sub={tx(t, 'e2ee5.link.history_all_sub', 'Recomendado. Pode levar um pouco mais.')} />
            <Choice g={g} selected={history === '3m'} onPress={() => setHistory('3m')} testID="e2ee5-link-hist-3m"
              title={tx(t, 'e2ee5.link.history_3m', 'Últimos 3 meses')} sub={tx(t, 'e2ee5.link.history_3m_sub', 'Mais rápido. As mensagens mais antigas ficam só no celular.')} />
            <Pressable onPress={start} accessibilityRole="button" testID="e2ee5-link-confirm"
              style={({ pressed }) => [st.cta, { backgroundColor: g.ink, opacity: pressed ? 0.85 : 1 }]}>
              <Text style={[st.ctaText, { color: g.onInk }]}>{tx(t, 'e2ee5.link.confirm_btn', 'Conectar')}</Text>
            </Pressable>
            <Pressable onPress={() => close(null)} accessibilityRole="button" style={st.ghost}>
              <Text style={[st.ghostText, { color: g.text }]}>{tx(t, 'common.cancel', 'Cancelar')}</Text>
            </Pressable>
          </>
        )}

        {phase === 'running' && (
          <>
            <Text style={[st.title, { color: g.text }]} accessibilityRole="header" accessibilityLiveRegion="polite">{stepLabel}</Text>
            <ActivityIndicator color={g.secondary} style={{ marginVertical: 14 }} />
            {!!prog.checkCode && (
              <Text style={[st.body, { color: g.secondary }]}>
                {tx(t, 'e2ee5.link.code_phone', 'O computador mostra o código {code}.', { code: prog.checkCode })}
              </Text>
            )}
            <Pressable onPress={() => { link.cancelPhoneLink(); close(null); }} accessibilityRole="button" style={st.ghost}>
              <Text style={[st.ghostText, { color: g.text }]}>{tx(t, 'common.cancel', 'Cancelar')}</Text>
            </Pressable>
          </>
        )}

        {phase === 'done' && (
          <>
            <Text style={[st.title, { color: g.text }]} accessibilityRole="header">{tx(t, 'e2ee5.link.linked', 'Computador conectado')}</Text>
            <Text style={[st.body, { color: g.secondary }]}>
              {tx(t, 'e2ee5.link.linked_body', 'O Chatyy Web já está aberto. Se ele ficar 30 dias sem uso, sai da sua conta sozinho.')}
            </Text>
            <Pressable onPress={() => close({ ok: true })} accessibilityRole="button" testID="e2ee5-link-ok"
              style={({ pressed }) => [st.cta, { backgroundColor: g.ink, opacity: pressed ? 0.85 : 1 }]}>
              <Text style={[st.ctaText, { color: g.onInk }]}>{tx(t, 'common.ok', 'OK')}</Text>
            </Pressable>
          </>
        )}

        {phase === 'error' && (
          <>
            <Text style={[st.title, { color: g.text }]} accessibilityRole="header">{tx(t, 'e2ee5.link.err_title', 'Não deu para conectar')}</Text>
            <Text style={[st.body, { color: g.secondary }]}>{errText(t, err)}</Text>
            <Pressable onPress={() => close(null)} accessibilityRole="button"
              style={({ pressed }) => [st.cta, { backgroundColor: g.ink, opacity: pressed ? 0.85 : 1 }]}>
              <Text style={[st.ctaText, { color: g.onInk }]}>{tx(t, 'common.ok', 'OK')}</Text>
            </Pressable>
          </>
        )}

        <View style={st.lockRow}>
          <LockGlyph size={11} color={g.secondary} />
          <Text style={[st.lockText, { color: g.secondary }]}>{tx(t, 'e2ee5.link.e2e_short', 'Protegido com criptografia de ponta a ponta')}</Text>
        </View>
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingHorizontal: 20, paddingTop: 8, alignItems: 'center', ...(Platform.OS === 'web' ? { maxWidth: 520, alignSelf: 'center', marginHorizontal: 'auto' } : null) },
  grabber: { width: 38, height: 5, borderRadius: 3, marginBottom: 14, opacity: 0.6 },
  iconWrap: { width: 56, height: 56, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  title: { fontSize: 19, fontWeight: '700', letterSpacing: -0.3, textAlign: 'center' },
  body: { fontSize: 14.5, lineHeight: 20, textAlign: 'center', marginTop: 8, maxWidth: 420 },
  section: { alignSelf: 'stretch', fontSize: 13, fontWeight: '600', marginTop: 18, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.3 },
  choice: { alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', borderWidth: 1.5, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 8 },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
  choiceText: { flex: 1, marginLeft: 12 },
  choiceTitle: { fontSize: 15.5, fontWeight: '600' },
  choiceSub: { fontSize: 13, lineHeight: 18, marginTop: 1 },
  cta: { alignSelf: 'stretch', minHeight: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 16 },
  ctaText: { fontSize: 16, fontWeight: '600' },
  ghost: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 4, paddingHorizontal: 16 },
  ghostText: { fontSize: 15.5, fontWeight: '600' },
  lockRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12 },
  lockText: { fontSize: 12 },
});
