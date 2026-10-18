// [2026-10-18 bg-sync] Faixa DISCRETA no topo da lista de conversas enquanto o
// aparelho novo baixa as mensagens recentes de cada conversa
// (services/fullHistorySync, passada A) ou restaura um backup em 2º plano
// (services/ownBackup.restoreInBackground). Nunca bloqueia: a lista já está na
// tela, dá p/ abrir conversas e enviar enquanto isso. Mesmo visual da faixa de
// importação do WhatsApp (WaImportBanner global): spinner pequeno + texto 12 pt
// + trilho de 3 pt.
//   • só aparece se o trabalho durar > SHOW_DELAY_MS (nada de piscar);
//   • passada A com < MIN_CONVS conversas não mostra nada (conta nova/pequena);
//   • some sozinha ao terminar (fase done/error do backup = some).
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';

const SHOW_DELAY_MS = 1200;
const MIN_CONVS = 3;

function _recentSrc() {
  try { return require('../services/fullHistorySync'); } catch { return null; }
}
function _backupSrc() {
  try { return require('../services/ownBackup'); } catch { return null; }
}

function _derive(recent, bk, bkRunning) {
  // Restauração de backup tem prioridade (é a que o usuário pediu).
  if (bkRunning && bk && bk.phase === 'restore') {
    const pct = bk.total ? Math.max(0, Math.min(99, Math.floor(((bk.done || 0) / bk.total) * 100))) : 0;
    return { kind: 'restore', pct };
  }
  if (recent && recent.running && (recent.total || 0) >= MIN_CONVS) {
    const pct = Math.max(0, Math.min(99, Math.floor(((recent.done || 0) / recent.total) * 100)));
    return { kind: 'recent', pct };
  }
  return null;
}

function BackgroundSyncPill() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const [state, setState] = useState(null);
  const [visible, setVisible] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    const rs = _recentSrc();
    const bs = _backupSrc();
    let recent = rs?.getRecentSyncProgress?.() || null;
    let bk = bs?.getProgress?.() || null;
    const recompute = () => {
      let running = false;
      try { running = !!bs?.isRunning?.(); } catch {}
      setState(_derive(recent, bk, running));
    };
    const u1 = rs?.subscribeRecentSync?.((p) => { recent = p; recompute(); }) || null;
    const u2 = bs?.subscribe?.((p) => { bk = p; recompute(); }) || null;
    recompute();
    return () => { try { u1?.(); } catch {} try { u2?.(); } catch {} };
  }, []);

  const active = !!state;
  useEffect(() => {
    if (active) {
      if (!visible && !timerRef.current) {
        timerRef.current = setTimeout(() => { timerRef.current = null; setVisible(true); }, SHOW_DELAY_MS);
      }
    } else {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      if (visible) setVisible(false);
    }
  }, [active, visible]);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  if (!visible || !state) return null;
  const pct = state.pct || 0;
  const tr = (k, fb) => {
    try { const v = t(k, { pct }); if (v && v !== k) return String(v).replace('{pct}', String(pct)); } catch {}
    return fb;
  };
  const label = state.kind === 'restore'
    ? tr('bgSync.restoring', `Restaurando backup… ${pct}%`)
    : tr('bgSync.syncing', `Sincronizando mensagens… ${pct}%`);
  const bg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
  const sub = colors.textSecondary;

  return (
    <View
      style={[s.row, { backgroundColor: bg }]}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: pct }}
      testID="bg-sync-pill"
    >
      <ActivityIndicator size="small" color={sub} style={{ transform: [{ scale: 0.75 }] }} />
      <Text style={[s.text, { color: sub }]} numberOfLines={1}>{label}</Text>
      <View style={[s.track, { backgroundColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)' }]}>
        <View style={{ width: `${Math.max(3, pct)}%`, height: '100%', backgroundColor: colors.text }} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 14, gap: 8 },
  text: { flex: 1, fontSize: 12, fontWeight: '500' },
  track: { width: 56, height: 3, borderRadius: 2, overflow: 'hidden' },
});

export default React.memo(BackgroundSyncPill);
