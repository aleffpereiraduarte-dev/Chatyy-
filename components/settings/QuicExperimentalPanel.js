// [quic-proto 2026-10-23] Interruptor ESCONDIDO do transporte experimental (QUIC+Noise).
// Aparece no "Sobre o Chatyy" depois de 7 toques na versão, e só para contas da allowlist do
// client-lb (transport.acc). Liga/desliga a flag LOCAL do aparelho (o servidor também precisa
// liberar a conta) e mostra o estado do nativo. Sem emoji: ícone SVG (Icons).
import { useState, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, Platform } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { IconZap } from '../Icons';
import NativeSwitch from '../NativeSwitch';

function _q() { return require('../../services/quicProto'); }

export function quicPanelAllowed(email) {
  try {
    if (Platform.OS === 'web') return false;
    return require('../../services/clientLb').quicAllowedFor(email) && !!_q().quicKind();
  } catch { return false; }
}

function _statusLines(t, email) {
  const Q = _q();
  const kind = Q.quicKind();
  const s = Q.nativeStatus() || {};
  const lines = [];
  lines.push((t('settings.quic.wire') || 'Conexão atual: {wire}').replace('{wire}', Q.currentWire()));
  if (kind === 'ios') {
    const bl = s.blocked && typeof s.blocked === 'object' ? Object.keys(s.blocked) : [];
    lines.push('ios v' + (s.v || 0) + (s.kill ? ' kill' : '') + (bl.length ? ' bloq=' + bl.map((r) => r + ':' + ((s.blocked[r] || {}).why || '')).join(',') : ''));
    const st = s.stats || {};
    const n = (k) => Number(st[k] || 0);
    lines.push('quic ok=' + n('quicAuthed') + ' fb=' + n('quicFallbacks') + ' mig=' + n('quicMigrationsKept') + ' drop=' + n('quicDrops'));
  } else if (kind === 'android') {
    lines.push('android lib=' + (s.lib ? 1 : 0) + (s.libVersion ? ' v' + s.libVersion : '') + (s.lastWhy ? ' why=' + s.lastWhy : '') + (s.udpBlocked ? ' udp_bloq' : ''));
  }
  const pub = Q.devicePub();
  if (pub) lines.push('noise ' + pub.slice(0, 12) + '…');
  const r = Q.lastReg();
  lines.push((t('settings.quic.reg') || 'Chave do aparelho: {state}').replace('{state}', r.state + (r.why ? ' (' + r.why + ')' : '')));
  return lines;
}

export default function QuicExperimentalPanel({ email }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [on, setOn] = useState(() => { try { return _q().isLocalOn(); } catch { return false; } });
  const [lines, setLines] = useState(() => { try { return _statusLines(t, email); } catch { return []; } });
  const refresh = useCallback(() => {
    try { setOn(_q().isLocalOn()); setLines(_statusLines(t, email)); } catch {}
  }, [t, email]);
  useEffect(() => {
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [refresh]);
  const toggle = (v) => {
    try { _q().setLocal(v, email); } catch {}
    setOn(v);
    setTimeout(refresh, 300);
    if (v) setTimeout(() => { try { _q().maybeRegisterNoiseKey(email, 'panel').then(refresh, refresh); } catch {} }, 600);
  };
  const title = t('settings.quic.title') || 'Transporte experimental (QUIC)';
  return (
    <View style={{ marginTop: 6, marginBottom: 6, padding: 12, borderRadius: 14, borderCurve: 'continuous', backgroundColor: colors.surfaceSecondary || colors.background }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <IconZap size={18} color={colors.primary} />
        <Text style={{ flex: 1, marginLeft: 8, color: colors.text, fontSize: 15, fontWeight: '700' }} numberOfLines={2}>{title}</Text>
        <NativeSwitch value={on} onValueChange={toggle} accessibilityLabel={title} />
      </View>
      <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 6 }}>
        {t('settings.quic.desc') || 'Conexão mais rápida em teste. Se falhar, volta sozinha para a conexão normal.'}
      </Text>
      {lines.map((l, i) => (
        <Text key={i} style={{ color: colors.textSecondary, fontSize: 11, marginTop: 3, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }} numberOfLines={2}>{l}</Text>
      ))}
      <TouchableOpacity onPress={refresh} style={{ alignSelf: 'flex-start', marginTop: 6, paddingVertical: 4 }}>
        <Text style={{ color: colors.primary, fontSize: 13, fontWeight: '600' }}>{t('settings.quic.refresh') || 'Atualizar'}</Text>
      </TouchableOpacity>
    </View>
  );
}
