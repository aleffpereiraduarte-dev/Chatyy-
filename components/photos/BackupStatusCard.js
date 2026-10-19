// components/photos/BackupStatusCard.js — [2026-10-19 fotos-backup]
//
// Card "Backup de fotos" da aba Backup (Fotos), preto e branco, estilo
// Google Fotos / iCloud: anel de progresso + três números com hierarquia
// clara (Na nuvem / Neste aparelho / Faltam) + estado acionável (desligado,
// pausado, enviando, tudo salvo). Números vêm de services/photosBackupSummary
// (servidor + comparação aparelho × nuvem), nunca de um escalar local.
import React from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

function fmtInt(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  try { return v.toLocaleString('pt-BR'); } catch {}
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function fmtBytes(b) {
  const n = Number(b) || 0;
  if (n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1).replace('.', ',')} ${u[i]}`;
}

function Ring({ pct, size = 92, stroke = 7, track, fill, children }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, pct || 0));
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={track} strokeWidth={stroke} fill="none" />
        {p > 0 ? (
          <Circle
            cx={size / 2} cy={size / 2} r={r}
            stroke={fill} strokeWidth={stroke} fill="none" strokeLinecap="round"
            strokeDasharray={`${c} ${c}`} strokeDashoffset={c * (1 - p)}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        ) : null}
      </Svg>
      {children}
    </View>
  );
}

function StateIcon({ kind, color, size = 16 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 8.5H7z" />
      {kind === 'done' ? <Path d="M9 13.5l2 2 4-4" /> : null}
      {kind === 'uploading' || kind === 'pending' ? <Path d="M12 16v-5M9.8 13l2.2-2.2 2.2 2.2" /> : null}
      {kind === 'paused' ? <Path d="M10.5 11v4M13.5 11v4" /> : null}
      {kind === 'off' ? <Path d="M4 4l16 16" /> : null}
    </Svg>
  );
}

function RefreshIcon({ color, size = 14 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
      <Path d="M21 3v5h-5" />
    </Svg>
  );
}

/**
 * props:
 *  cloud: { total, photos, videos, missing, size, lastBackupAt } | null
 *  recon: { deviceTotal, matched, pending, missing, at, partial } | null
 *  reconProgress: { phase, done, total } | null  (verificação em andamento)
 *  deviceTotal: number (MediaLibrary)
 *  backupEnabled, backupStatus ('backing_up'|'paused'|'complete'|...)
 *  liveDone: number (contador durante o envio)
 *  onEnable, onBackupNow, onResume, onRepair, onRecheck
 */
export default function BackupStatusCard({
  colors = {}, isDark, t, cloud, recon, reconProgress, deviceTotal = 0,
  backupEnabled, backupStatus, liveDone = 0, sizeFallback = null,
  onEnable, onBackupNow, onResume, onRepair, onRecheck, style,
}) {
  const tr = (k, fb, vars) => {
    let v = fb;
    try { const x = typeof t === 'function' ? t(k, vars) : null; if (x && x !== k) v = x; } catch {}
    if (vars) for (const [a, b] of Object.entries(vars)) v = String(v).split(`{${a}}`).join(String(b));
    return v;
  };

  const text = colors.text || (isDark ? '#fff' : '#000');
  const sub = colors.textSecondary || (isDark ? '#A1A1A6' : '#6B7280');
  const faint = colors.textTertiary || (isDark ? '#6C6C70' : '#8E8E93');
  const line = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)';
  const track = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)';
  const surface = colors.surface || (isDark ? '#1C1C1E' : '#fff');
  const chipBg = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)';

  const device = Math.max(0, Number(recon?.deviceTotal || 0), Number(deviceTotal || 0));
  const cloudTotal = cloud ? Math.max(0, Number(cloud.total || 0)) : null;
  const checking = !!reconProgress;
  const hasRecon = !!recon && !checking;
  const uploading = backupStatus === 'backing_up';

  // "Feito neste aparelho" = itens DESTE rolo confirmados no servidor.
  let matched = hasRecon ? Math.min(recon.matched || 0, device || recon.matched || 0) : null;
  if (uploading && matched != null && liveDone > 0) matched = Math.max(matched, Math.min(liveDone, device));
  let left;
  let leftIsEstimate = false;
  if (hasRecon) {
    left = Math.max(0, device - (matched || 0));
  } else if (cloudTotal != null && device > 0) {
    left = Math.max(0, device - cloudTotal);
    leftIsEstimate = true;
  } else {
    left = null;
  }
  const doneForRing = matched != null ? matched : (cloudTotal != null ? Math.min(cloudTotal, device) : 0);
  const pct = device > 0 ? Math.min(1, doneForRing / device) : (cloudTotal > 0 ? 1 : 0);
  const pctLabel = device > 0
    ? (pct >= 1 || left === 0 ? '100%' : `${Math.min(99, Math.floor(pct * 100))}%`)
    : '—';

  let kind;
  if (uploading) kind = 'uploading';
  else if (backupStatus === 'paused') kind = 'paused';
  else if (left === 0 && !leftIsEstimate) kind = 'done';
  else if (!backupEnabled) kind = 'off';
  else kind = 'pending';

  const headline = ({
    uploading: tr('photos.bk.stateUploading', 'Enviando para a nuvem'),
    paused: tr('photos.bk.statePaused', 'Backup pausado'),
    done: tr('photos.bk.stateDone', 'Tudo salvo na nuvem'),
    off: tr('photos.bk.stateOff', 'Backup automático desligado'),
    pending: tr('photos.bk.statePending', 'Backup ligado'),
  })[kind];

  let detail = '';
  if (checking) {
    const p = reconProgress;
    detail = p.phase === 'match'
      ? tr('photos.bk.checkingMatch', 'Comparando com a nuvem… {done} de {total}', { done: fmtInt(p.done), total: fmtInt(p.total) })
      : tr('photos.bk.checkingScan', 'Lendo a galeria… {done}', { done: fmtInt(p.done) });
  } else if (kind === 'uploading') {
    detail = left != null ? tr('photos.bk.detailUploading', 'Faltam {n} itens', { n: fmtInt(left) }) : '';
  } else if (kind === 'paused') {
    detail = tr('photos.bk.detailPaused', 'Sem progresso há alguns minutos. Toque em Continuar.');
  } else if (kind === 'done') {
    detail = tr('photos.bk.detailDone', 'As {n} fotos e vídeos deste aparelho estão protegidos.', { n: fmtInt(device) });
  } else if (left != null && left > 0) {
    detail = kind === 'off'
      ? tr('photos.bk.detailOffLeft', '{n} itens deste aparelho ainda não estão na nuvem.', { n: fmtInt(left) })
      : tr('photos.bk.detailPendingLeft', '{n} itens aguardando envio.', { n: fmtInt(left) });
  } else if (kind === 'off') {
    detail = tr('photos.bk.detailOff', 'Ative para proteger as novas fotos automaticamente.');
  }

  const cloudSub = cloud && cloud.photos != null
    ? tr('photos.bk.cloudSplit', '{p} fotos · {v} vídeos', { p: fmtInt(cloud.photos), v: fmtInt(cloud.videos || 0) })
    : tr('photos.bk.cloudSub', 'fotos e vídeos');
  const leftSub = checking
    ? tr('photos.bk.checking', 'verificando…')
    : (leftIsEstimate ? tr('photos.bk.estimate', 'estimativa') : tr('photos.bk.leftSub', 'para enviar'));

  const size = cloud && cloud.size != null ? cloud.size : sizeFallback;
  let lastStr = '';
  if (cloud && cloud.lastBackupAt) {
    try {
      const d = new Date(cloud.lastBackupAt);
      if (!isNaN(d.getTime())) {
        const today = new Date();
        const sameDay = d.toDateString() === today.toDateString();
        const y = new Date(today.getTime() - 86400000);
        const hh = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        lastStr = sameDay
          ? tr('photos.bk.lastToday', 'hoje, {time}', { time: hh })
          : d.toDateString() === y.toDateString()
            ? tr('photos.bk.lastYesterday', 'ontem, {time}', { time: hh })
            : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
      }
    } catch {}
  }

  // Ação principal + secundária conforme o estado
  let primary = null;
  let secondary = null;
  if (kind === 'off') {
    primary = { label: tr('photos.bk.enable', 'Ativar backup automático'), onPress: onEnable };
    if (left > 0) secondary = { label: tr('photos.bk.sendNow', 'Enviar agora'), onPress: onBackupNow };
  } else if (kind === 'paused') {
    primary = { label: tr('photos.bk.resume', 'Continuar backup'), onPress: onResume };
    secondary = { label: tr('photos.bk.repair', 'Reparar'), onPress: onRepair };
  } else if (kind === 'pending' && left > 0) {
    primary = { label: tr('photos.bk.backupNow', 'Fazer backup agora'), onPress: onBackupNow };
  } else if (kind === 'done' && !backupEnabled) {
    secondary = { label: tr('photos.bk.enable', 'Ativar backup automático'), onPress: onEnable };
  }

  const Stat = ({ value, label, subLabel, testID }) => (
    <View style={styles.stat} testID={testID}>
      <Text style={[styles.statValue, { color: text }]} numberOfLines={1} adjustsFontSizeToFit>
        {value == null ? '—' : fmtInt(value)}
      </Text>
      <Text style={[styles.statLabel, { color: sub }]} numberOfLines={1}>{label}</Text>
      {subLabel ? <Text style={[styles.statSub, { color: faint }]} numberOfLines={1}>{subLabel}</Text> : null}
    </View>
  );

  return (
    <View style={[styles.card, { backgroundColor: surface, borderColor: line }, style]} testID="photos-backup-status-card">
      <View style={styles.top}>
        <Ring pct={pct} track={track} fill={text}>
          {uploading || checking ? (
            <ActivityIndicator size="small" color={text} />
          ) : (
            <Text style={[styles.pct, { color: text }]}>{pctLabel}</Text>
          )}
        </Ring>
        <View style={styles.topText}>
          <View style={[styles.chip, { backgroundColor: chipBg }]}>
            <StateIcon kind={kind} color={text} size={14} />
            <Text style={[styles.chipText, { color: text }]} numberOfLines={1}>{headline}</Text>
          </View>
          {detail ? <Text style={[styles.detail, { color: sub }]} numberOfLines={3}>{detail}</Text> : null}
        </View>
      </View>

      <View style={[styles.stats, { borderTopColor: line, borderBottomColor: line }]}>
        <Stat value={cloudTotal} label={tr('photos.bk.inCloud', 'Na nuvem')} subLabel={cloudSub} testID="bk-stat-cloud" />
        <View style={[styles.vsep, { backgroundColor: line }]} />
        <Stat value={device || null} label={tr('photos.bk.onDevice', 'Neste aparelho')} subLabel={tr('photos.bk.deviceSub', 'fotos e vídeos')} testID="bk-stat-device" />
        <View style={[styles.vsep, { backgroundColor: line }]} />
        <Stat value={left} label={tr('photos.bk.left', 'Faltam')} subLabel={leftSub} testID="bk-stat-left" />
      </View>

      {hasRecon && recon.missing > 0 ? (
        <Text style={[styles.note, { color: sub }]}>
          {tr('photos.bk.missingNote', '{n} itens perderam a cópia na nuvem e serão reenviados deste aparelho.', { n: fmtInt(recon.missing) })}
        </Text>
      ) : null}

      <View style={styles.meta}>
        <Text style={[styles.metaText, { color: sub }]} numberOfLines={1}>
          {size != null ? tr('photos.bk.usedInCloud', '{size} na nuvem', { size: fmtBytes(size) }) : ''}
          {size != null && lastStr ? '  ·  ' : ''}
          {lastStr ? tr('photos.bk.lastBackup', 'Último backup {when}', { when: lastStr }) : ''}
        </Text>
        {onRecheck ? (
          <TouchableOpacity
            onPress={onRecheck}
            disabled={checking}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={[styles.recheck, { opacity: checking ? 0.4 : 1 }]}
            accessibilityRole="button"
            accessibilityLabel={tr('photos.bk.recheck', 'Verificar')}
          >
            <RefreshIcon color={text} />
            <Text style={[styles.recheckText, { color: text }]}>{tr('photos.bk.recheck', 'Verificar')}</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {primary || secondary ? (
        <View style={styles.actions}>
          {primary ? (
            <TouchableOpacity
              onPress={primary.onPress}
              style={[styles.btnPrimary, { backgroundColor: text }]}
              accessibilityRole="button"
              accessibilityLabel={primary.label}
              testID="bk-primary"
            >
              <Text style={[styles.btnPrimaryText, { color: surface }]} numberOfLines={1}>{primary.label}</Text>
            </TouchableOpacity>
          ) : null}
          {secondary ? (
            <TouchableOpacity
              onPress={secondary.onPress}
              style={[styles.btnSecondary, { borderColor: isDark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.16)' }]}
              accessibilityRole="button"
              accessibilityLabel={secondary.label}
              testID="bk-secondary"
            >
              <Text style={[styles.btnSecondaryText, { color: text }]} numberOfLines={1}>{secondary.label}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 18, paddingTop: 18, paddingBottom: 16 },
  top: { flexDirection: 'row', alignItems: 'center' },
  topText: { flex: 1, marginLeft: 16 },
  pct: { fontSize: 20, fontWeight: '700', letterSpacing: -0.5 },
  chip: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, maxWidth: '100%' },
  chipText: { fontSize: 13, fontWeight: '600' },
  detail: { fontSize: 13, lineHeight: 18, marginTop: 8 },
  stats: { flexDirection: 'row', alignItems: 'stretch', marginTop: 18, paddingVertical: 14, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
  stat: { flex: 1, alignItems: 'center', paddingHorizontal: 4 },
  vsep: { width: StyleSheet.hairlineWidth },
  statValue: { fontSize: 22, fontWeight: '700', letterSpacing: -0.6 },
  statLabel: { fontSize: 12, fontWeight: '600', marginTop: 2 },
  statSub: { fontSize: 11, marginTop: 2 },
  note: { fontSize: 12, lineHeight: 17, marginTop: 12 },
  meta: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  metaText: { flex: 1, fontSize: 12 },
  recheck: { flexDirection: 'row', alignItems: 'center', gap: 5, marginLeft: 8 },
  recheckText: { fontSize: 13, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 10, marginTop: 16 },
  btnPrimary: { flex: 1, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
  btnPrimaryText: { fontSize: 15, fontWeight: '700' },
  btnSecondary: { height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18, borderWidth: 1 },
  btnSecondaryText: { fontSize: 15, fontWeight: '600' },
});
