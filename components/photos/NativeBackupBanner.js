// components/photos/NativeBackupBanner.js — [2026-10-15 photos-native]
// Faixa de status do backup NATIVO (modules/expo-photos-backup) no topo da
// grade de Fotos: progresso real da fila durável (não estimativa), motivo de
// espera (Wi-Fi / carregador / bateria / permissão / login / cota), pausar,
// retomar e tentar de novo. Lê getStatus() + eventos onProgress/onState.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';

function CloudIcon({ color, kind }) {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 8.5H7z" />
      {kind === 'done' ? <Path d="M9 13.5l2 2 4-4" /> : null}
      {kind === 'up' ? <Path d="M12 16v-5M9.8 13l2.2-2.2 2.2 2.2" /> : null}
      {kind === 'wait' ? <Path d="M12 11v2.5l1.6 1" /> : null}
      {kind === 'warn' ? <Path d="M12 10.5v3M12 15.8v.01" /> : null}
    </Svg>
  );
}

function PauseIcon({ color }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill={color}>
      <Rect x={6} y={5} width={4} height={14} rx={1} />
      <Rect x={14} y={5} width={4} height={14} rx={1} />
    </Svg>
  );
}

function PlayIcon({ color }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill={color}>
      <Path d="M8 5.5v13l10-6.5z" />
    </Svg>
  );
}

export default function NativeBackupBanner({ colors = {}, isDark, t, onPressSettings }) {
  const [st, setSt] = useState(null);
  const timer = useRef(null);
  const pbn = useRef(null);
  if (pbn.current === null) {
    try { pbn.current = require('../../services/photosBackupNative'); } catch { pbn.current = false; }
  }

  const tr = useCallback((k, fb, vars) => {
    let v = fb;
    try { const x = typeof t === 'function' ? t(k, vars) : null; if (x && x !== k) v = x; } catch {}
    if (vars) for (const [a, b] of Object.entries(vars)) v = String(v).replace(`{${a}}`, String(b));
    return v;
  }, [t]);

  const refresh = useCallback(async () => {
    const m = pbn.current;
    if (!m) return;
    const s = await m.getNativeStatus();
    if (s) setSt(s);
  }, []);

  useEffect(() => {
    const m = pbn.current;
    if (!m || !m.nativeBackupOwns()) return undefined;
    refresh();
    const unsub = m.subscribeNative((ev) => {
      if (ev === 'onItem') return; // onProgress já agrega
      if (timer.current) return;
      timer.current = setTimeout(() => { timer.current = null; refresh(); }, 700);
    });
    const iv = setInterval(refresh, 20000);
    return () => { unsub(); clearInterval(iv); if (timer.current) clearTimeout(timer.current); };
  }, [refresh]);

  if (!st || !st.enabled) return null;

  const covered = Math.max(0, (st.total || 0) - (st.skipped || 0));
  const left = (st.pending || 0) + (st.uploading || 0);
  let kind = 'up';
  let title;
  let sub = '';
  const blocked = st.blockedBy && st.blockedBy !== 'disabled' ? st.blockedBy : null;
  if (st.paused) {
    kind = 'wait';
    title = tr('photosNative.paused', 'Backup pausado');
  } else if (blocked && left > 0) {
    kind = blocked === 'auth' || blocked === 'quota' || blocked === 'permission' ? 'warn' : 'wait';
    title = ({
      wifi: tr('photosNative.waitingWifi', 'Aguardando Wi-Fi'),
      charging: tr('photosNative.waitingCharger', 'Aguardando carregador'),
      battery: tr('photosNative.waitingBattery', 'Aguardando bateria'),
      network: tr('photosNative.waitingNetwork', 'Sem conexão'),
      permission: tr('photosNative.permission', 'Permita o acesso às fotos'),
      auth: tr('photosNative.authError', 'Entre de novo para continuar o backup'),
      quota: tr('photosNative.quota', 'Armazenamento cheio'),
    })[blocked] || tr('photosNative.waitingNetwork', 'Sem conexão');
  } else if (left === 0) {
    kind = 'done';
    title = tr('photosNative.complete', 'Tudo salvo na nuvem');
  } else {
    title = tr('photosNative.uploadingNow', 'Salvando {n}…', { n: left });
  }
  sub = tr('photosNative.savedOfTotal', '{done} de {total} salvos', { done: st.done || 0, total: covered });
  if ((st.failed || 0) > 0) sub += ' · ' + tr('photosNative.failedN', '{n} com erro', { n: st.failed });
  const pct = covered > 0 ? Math.min(1, (st.done || 0) / covered) : 0;
  const accent = kind === 'done' ? (colors.success || '#16a34a') : kind === 'warn' ? '#ef4444' : (colors.primary || '#2563EB');

  const m = pbn.current;
  return (
    <View style={[styles.wrap, { backgroundColor: isDark ? '#141416' : '#F4F5F7', borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]}>
      <TouchableOpacity style={styles.left} onPress={onPressSettings} activeOpacity={0.7} accessibilityRole="button">
        <CloudIcon color={accent} kind={kind} />
        <View style={styles.texts}>
          <Text style={[styles.title, { color: colors.text || '#111' }]} numberOfLines={1}>{title}</Text>
          <Text style={[styles.sub, { color: colors.textSecondary || '#6B7280' }]} numberOfLines={1}>{sub}</Text>
          {kind !== 'done' ? (
            <View style={[styles.track, { backgroundColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)' }]}>
              <View style={[styles.fill, { width: `${Math.round(pct * 1000) / 10}%`, backgroundColor: accent }]} />
            </View>
          ) : null}
        </View>
      </TouchableOpacity>
      {(st.failed || 0) > 0 && !st.paused ? (
        <TouchableOpacity onPress={() => { m && m.runNowNative().then(refresh); }} style={styles.btn} accessibilityLabel={tr('photosNative.retry', 'Tentar de novo')}>
          <Text style={[styles.btnText, { color: colors.primary || '#2563EB' }]}>{tr('photosNative.retry', 'Tentar de novo')}</Text>
        </TouchableOpacity>
      ) : null}
      {kind !== 'done' || st.paused ? (
        <TouchableOpacity
          onPress={() => { if (!m) return; (st.paused ? m.resumeNative() : m.pauseNative()).then(() => setTimeout(refresh, 300)); }}
          style={styles.iconBtn}
          accessibilityLabel={st.paused ? tr('photosNative.resume', 'Retomar') : tr('photosNative.pause', 'Pausar')}
        >
          {st.paused ? <PlayIcon color={colors.primary || '#2563EB'} /> : <PauseIcon color={colors.textSecondary || '#6B7280'} />}
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 12, marginTop: 8, marginBottom: 6, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  left: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  texts: { flex: 1, marginLeft: 10 },
  title: { fontSize: 14, fontWeight: '600' },
  sub: { fontSize: 12, marginTop: 1 },
  track: { height: 3, borderRadius: 2, marginTop: 6, overflow: 'hidden' },
  fill: { height: 3, borderRadius: 2 },
  btn: { paddingHorizontal: 8, paddingVertical: 6 },
  btnText: { fontSize: 13, fontWeight: '600' },
  iconBtn: { padding: 8, marginLeft: 2 },
});
