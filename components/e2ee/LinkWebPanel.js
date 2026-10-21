// [e2ee5 WP-12 2026-10-21] Web: "Use o Chatyy no computador" — QR do vínculo E2EE (CONTRATO §6.7).
//
// O QR é desenhado AQUI (react-native-qrcode-svg), nunca por serviço externo: ele carrega a chave
// pública efêmera da web e um segredo de 32 B (não carrega bearer). O celular lê, emite o acesso
// deste navegador e manda as chaves das conversas pelo canal cifrado; quando termina, `onLinked`
// recebe `{bearer, uid, imported}` e quem montou o painel faz o login com esse bearer.
//
// Props: onLinked({bearer, uid, imported}) (obrigatória), compact (sem título), style.
// Só desenha com o caminho E2EE v5 ligado (`services/e2ee/link.webLinkUiOn()` decide quem monta).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { LockGlyph, tx } from './e2eeUi';
import * as link from '../../services/e2ee/link';

let QRCode = null;
try { QRCode = require('react-native-qrcode-svg').default; } catch {}

const QR_SIZE = 216;
const FRAME = 248;

function Step({ n, text, colors, isDark }) {
  return (
    <View style={st.stepRow}>
      <View style={[st.stepNum, { backgroundColor: colors.primary + (isDark ? '2E' : '1A') }]}>
        <Text style={[st.stepNumText, { color: colors.primary }]}>{n}</Text>
      </View>
      <Text style={[st.stepText, { color: colors.text }]}>{text}</Text>
    </View>
  );
}

function errorText(t, code) {
  switch (code) {
    case 'unsupported': return tx(t, 'e2ee5.link.err_browser', 'Este navegador não consegue guardar as chaves de criptografia. Use o Chrome, o Safari ou o Firefox atualizados, fora da janela anônima.');
    case 'storage': return tx(t, 'e2ee5.link.err_storage', 'O navegador está bloqueando o armazenamento deste site (janela anônima ou dados bloqueados). Abra numa janela normal para conectar.');
    case 'expired': return tx(t, 'e2ee5.link.err_expired', 'O QR expirou. Gere um novo para conectar.');
    case 'device_limit': return tx(t, 'e2ee5.link.err_limit', 'Sua conta já tem o máximo de aparelhos conectados. Desconecte um no celular e tente de novo.');
    case 'bad_qr': return tx(t, 'e2ee5.link.err_mismatch', 'A conexão não pôde ser confirmada. Gere um novo QR e leia de novo com o celular.');
    case 'network': return tx(t, 'e2ee5.link.err_network', 'Sem conexão. Verifique a internet e tente de novo.');
    default: return tx(t, 'e2ee5.link.err_failed', 'Não foi possível conectar. Gere um novo QR e tente de novo.');
  }
}

export default function LinkWebPanel({ onLinked, compact = false, style }) {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const [state, setState] = useState({ phase: 'preparing' });
  const [errCode, setErrCode] = useState(null);
  const [runId, setRunId] = useState(0);
  const ctlRef = useRef(null);
  const doneRef = useRef(false);
  const onLinkedRef = useRef(onLinked);
  onLinkedRef.current = onLinked;

  useEffect(() => {
    let alive = true;
    doneRef.current = false;
    setErrCode(null);
    setState({ phase: 'preparing' });
    const ctl = link.startWebLink({ onState: (s) => { if (alive) setState(s); } });
    ctlRef.current = ctl;
    ctl.promise.then((r) => {
      if (!alive) return;
      doneRef.current = true;
      try { onLinkedRef.current && onLinkedRef.current(r); } catch {}
    }).catch((e) => {
      if (!alive) return;
      if (e && e.code === 'cancelled') return;
      setErrCode((e && e.code) || 'failed');
    });
    return () => { alive = false; if (!doneRef.current) { try { ctl.cancel(); } catch {} } };
  }, [runId]);

  const retry = useCallback(() => setRunId((n) => n + 1), []);

  const phase = errCode ? 'error' : state.phase;
  const frameBorder = { borderColor: colors.border, backgroundColor: phase === 'qr' ? '#FFFFFF' : colors.background };

  let body = null;
  if (phase === 'qr' && QRCode && state.qrPayload) {
    body = (
      <View accessible accessibilityRole="image" accessibilityLabel={tx(t, 'e2ee5.link.qr_a11y', 'QR para conectar este computador ao Chatyy do seu celular')}>
        <QRCode value={String(state.qrPayload)} size={QR_SIZE} color="#111111" backgroundColor="#FFFFFF" ecl="M" />
      </View>
    );
  } else if (phase === 'error') {
    body = (
      <Pressable onPress={retry} accessibilityRole="button" style={st.center} testID="e2ee5-link-retry">
        <Text style={[st.errText, { color: colors.text }]}>{errorText(t, errCode)}</Text>
        <Text style={[st.retryText, { color: colors.primary }]}>{tx(t, 'e2ee5.link.new_qr', 'Gerar novo QR')}</Text>
      </Pressable>
    );
  } else if (phase === 'connecting') {
    body = (
      <View style={st.center}>
        <ActivityIndicator color={colors.primary} />
        <Text style={[st.midText, { color: colors.text }]}>{tx(t, 'e2ee5.link.connecting', 'Conectando ao seu celular…')}</Text>
        {!!state.checkCode && (
          <Text style={[st.codeText, { color: colors.textSecondary }]} accessibilityLabel={tx(t, 'e2ee5.link.code', 'Código de conferência: {code}', { code: state.checkCode })}>
            {tx(t, 'e2ee5.link.code', 'Código de conferência: {code}', { code: state.checkCode })}
          </Text>
        )}
      </View>
    );
  } else if (phase === 'importing') {
    const total = Number(state.total) || 0;
    const rec = Number(state.received) || 0;
    const pct = total > 0 ? Math.min(1, rec / total) : 0;
    body = (
      <View style={st.center}>
        <Text style={[st.midText, { color: colors.text }]}>{tx(t, 'e2ee5.link.importing', 'Carregando as conversas protegidas…')}</Text>
        <View style={[st.barBg, { backgroundColor: colors.border }]} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: total || 1, now: rec }}>
          <View style={[st.barFg, { backgroundColor: colors.primary, width: `${Math.round((total ? pct : 0.15) * 100)}%` }]} />
        </View>
        {total > 0 && <Text style={[st.codeText, { color: colors.textSecondary }]}>{tx(t, 'e2ee5.link.importing_n', '{n} de {total}', { n: rec, total })}</Text>}
      </View>
    );
  } else if (phase === 'done') {
    body = (
      <View style={st.center}>
        <ActivityIndicator color={colors.primary} />
        <Text style={[st.midText, { color: colors.text }]}>{tx(t, 'e2ee5.link.done', 'Pronto. Abrindo suas conversas…')}</Text>
      </View>
    );
  } else {
    body = <ActivityIndicator size="large" color={colors.primary} />;
  }

  return (
    <View style={[st.root, style]} testID="e2ee5-link-web">
      {!compact && (
        <Text style={[st.title, { color: colors.text }]} accessibilityRole="header">
          {tx(t, 'e2ee5.link.scan_title', 'Use o Chatyy no computador')}
        </Text>
      )}
      <View style={[st.frame, frameBorder, Platform.OS === 'web' && phase === 'qr' ? { boxShadow: isDark ? '0 6px 18px rgba(0,0,0,0.35)' : '0 6px 18px rgba(60,64,67,0.08)' } : null]}>
        {body}
      </View>
      {phase === 'qr' || phase === 'preparing' || phase === 'error' ? (
        <View style={st.steps}>
          <Step n={1} colors={colors} isDark={isDark} text={tx(t, 'e2ee5.link.step1', 'Abra o Chatyy no seu celular.')} />
          <Step n={2} colors={colors} isDark={isDark} text={tx(t, 'e2ee5.link.step2', 'Toque em Você, depois em Dispositivos conectados e em Conectar um aparelho.')} />
          <Step n={3} colors={colors} isDark={isDark} text={tx(t, 'e2ee5.link.step3', 'Aponte o celular para esta tela para ler o QR.')} />
        </View>
      ) : null}
      <View style={st.lockRow}>
        <LockGlyph size={12} color={colors.textSecondary} />
        <Text style={[st.lockText, { color: colors.textSecondary }]}>
          {tx(t, 'e2ee5.link.e2e_note', 'Suas mensagens pessoais são protegidas com a criptografia de ponta a ponta. As chaves vêm do seu celular, cifradas.')}
        </Text>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  root: { alignItems: 'center', width: '100%' },
  title: { fontSize: 20, fontWeight: '700', letterSpacing: -0.3, marginBottom: 16, textAlign: 'center' },
  frame: { width: FRAME, height: FRAME, borderRadius: 20, borderWidth: 1, alignItems: 'center', justifyContent: 'center', marginBottom: 20, padding: 14 },
  center: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 },
  midText: { fontSize: 14.5, fontWeight: '600', textAlign: 'center', marginTop: 12 },
  codeText: { fontSize: 13, textAlign: 'center', marginTop: 8 },
  errText: { fontSize: 13.5, lineHeight: 19, textAlign: 'center' },
  retryText: { fontSize: 14.5, fontWeight: '700', marginTop: 12 },
  barBg: { width: 180, height: 6, borderRadius: 3, marginTop: 14, overflow: 'hidden' },
  barFg: { height: 6, borderRadius: 3 },
  steps: { alignSelf: 'center', gap: 12, marginBottom: 16, maxWidth: 380, width: '100%' },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  stepNum: { width: 24, height: 24, borderRadius: 12, marginTop: 1, alignItems: 'center', justifyContent: 'center' },
  stepNumText: { fontSize: 12, fontWeight: '700' },
  stepText: { flex: 1, fontSize: 14, lineHeight: 21 },
  lockRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, maxWidth: 380, paddingHorizontal: 4 },
  lockText: { flex: 1, fontSize: 12.5, lineHeight: 17 },
});
