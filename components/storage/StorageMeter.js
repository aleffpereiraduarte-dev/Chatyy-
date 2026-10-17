// [2026-10-17 smart-storage] Medidor de armazenamento ÚNICO (Configurações >
// Armazenamento, Drive, Arquivos, Fotos, Backup) + cartão de aviso "quase cheio".
//
// Barra segmentada por tipo, em rampa de cinzas (P&B premium, dark/light):
//   Fotos · Vídeos · Arquivos  (quando a tela Gerenciar armazenamento já mediu
//                               o Drive por tipo — fração guardada por conta)
//   ou "Fotos e arquivos"      (só o total do Drive, que é o que a API dá)
//   E-mail · Chat · Feed · Backup (backup/cofre = backup_used ou o resto do total)
import React, { useEffect, useMemo } from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { IconX, IconCloud } from '../Icons';
import * as kv from '../../services/mmkv';
import * as api from '../../services/api';
import { usePlanState } from '../../services/planState';
import { MONETIZATION_ENABLED } from '../../constants/featureFlags';
import {
  nudgeLevel, recommendTier, canShowOffer, markOfferShown, dismissOffer,
  recordUsageSample, formatGbShort, offerHref,
} from '../../services/storageOffers';

const TAB = { fontVariant: ['tabular-nums'] };
const RED = '#ef4444';

// ── divisão do Drive por tipo (medida em Gerenciar armazenamento) ─────────
function _splitKey() {
  let e = ''; try { e = String(api.getSavedEmail?.() || '').toLowerCase(); } catch {}
  return 'storage_split_v1:' + (e || '_');
}
/** bytes por tipo do Drive (photos/videos/files) → guarda as FRAÇÕES (30 dias). */
export function saveDriveSplit({ photos = 0, videos = 0, files = 0 } = {}) {
  const tot = photos + videos + files;
  if (!(tot > 0)) return;
  try { kv.setJSON(_splitKey(), { at: Date.now(), p: photos / tot, v: videos / tot, f: files / tot }); } catch {}
}
function _driveSplit() {
  try {
    const s = kv.getJSON(_splitKey());
    if (s && Date.now() - (Number(s.at) || 0) < 30 * 86400000) return s;
  } catch {}
  return null;
}

// ── normalização das 2 formas que as telas têm ─────────────────────────────
/** planState normalizado (services/planState) → medidor. */
export function meterFromPlan(plan) {
  if (!plan) return null;
  const b = plan.breakdown || {};
  return {
    usedBytes: plan.usedBytes, limitBytes: plan.limitBytes,
    parts: { drive: +b.drive || 0, email: +b.email || 0, chat: +b.chat || 0, feed: +b.feed || 0 },
  };
}
/** drive_storage_info / drive_list.storage → medidor. */
export function meterFromDriveInfo(info) {
  if (!info) return null;
  const used = Number(info.total_used ?? info.used_bytes);
  return {
    usedBytes: Number.isFinite(used) ? used : null,
    limitBytes: Number(info.quota || info.plan_quota) || 0,
    parts: {
      drive: +info.drive_used || 0, email: +info.email_used || 0, chat: +info.chat_used || 0,
      feed: +info.feed_used || 0, backup: +info.backup_used || 0,
    },
  };
}

function ramp(isDark) {
  return isDark
    ? ['#F5F5F7', '#C7C7CC', '#9A9AA0', '#76767C', '#5A5A60', '#45454A', '#36363A']
    : ['#111111', '#3A3A3C', '#5E5E63', '#86868B', '#A9A9AE', '#C3C3C8', '#D6D6DA'];
}

export function fmtBytes(b) {
  const v = Math.max(0, Number(b) || 0);
  if (v >= 1024 ** 4) return (v / 1024 ** 4).toFixed(2) + ' TB';
  if (v >= 1024 ** 3) return (v / 1024 ** 3).toFixed(v >= 100 * 1024 ** 3 ? 0 : 1) + ' GB';
  if (v >= 1024 ** 2) return Math.round(v / 1024 ** 2) + ' MB';
  if (v >= 1024) return Math.round(v / 1024) + ' KB';
  return v + ' B';
}

export function buildSegments(meter, t, isDark) {
  if (!meter || meter.usedBytes == null) return [];
  const p = meter.parts || {};
  const split = _driveSplit();
  const L = (k, fb) => { const s = t(k); return s && s !== k ? s : fb; };
  const out = [];
  if (p.drive > 0) {
    if (split) {
      out.push({ key: 'photos', label: L('storageMeter.photos', 'Fotos'), bytes: p.drive * (split.p || 0) });
      out.push({ key: 'videos', label: L('storageMeter.videos', 'Vídeos'), bytes: p.drive * (split.v || 0) });
      out.push({ key: 'files', label: L('storageMeter.files', 'Arquivos'), bytes: p.drive * (split.f || 0) });
    } else {
      out.push({ key: 'drive', label: L('storageMeter.driveAll', 'Fotos e arquivos'), bytes: p.drive });
    }
  }
  out.push({ key: 'email', label: L('storageMeter.email', 'E-mail'), bytes: p.email || 0 });
  out.push({ key: 'chat', label: L('storageMeter.chat', 'Conversas'), bytes: p.chat || 0 });
  out.push({ key: 'feed', label: L('storageMeter.feed', 'Feed'), bytes: p.feed || 0 });
  const known = (p.drive || 0) + (p.email || 0) + (p.chat || 0) + (p.feed || 0);
  // backup/cofre: valor explícito OU o que sobra do total (o total soma backups E2E + cofre).
  const rest = Math.max(Number(p.backup) || 0, (Number(meter.usedBytes) || 0) - known);
  out.push({ key: 'backup', label: L('storageMeter.backup', 'Backup'), bytes: rest > (meter.usedBytes || 0) * 0.005 ? rest : 0 });
  const colors = ramp(isDark);
  return out.filter((s) => s.bytes > 0).map((s, i) => ({ ...s, color: colors[Math.min(i, colors.length - 1)] }));
}

/**
 * <StorageMeter meter={meterFromPlan(plan)} legend="dots"|"rows"|"none" />
 * Sem `meter` → lê sozinho do planState (plan_info + chat_storage_usage).
 */
export default function StorageMeter({ meter: meterProp, legend = 'dots', showHeader = true, style, onPress, testID }) {
  const { colors = {}, isDark } = useTheme() || {};
  const { t } = useLanguage();
  const { plan } = usePlanState();
  const meter = meterProp || meterFromPlan(plan);
  const segments = useMemo(() => buildSegments(meter, t, isDark), [meter, t, isDark]);
  if (!meter) return null;
  const used = meter.usedBytes;
  const limit = meter.limitBytes || 0;
  const hasUsage = used != null && limit > 0;
  const pct = hasUsage ? Math.min(100, Math.max(0, (used / limit) * 100)) : 0;
  const text = colors.text || (isDark ? '#F5F5F7' : '#111111');
  const sub = colors.textSecondary || (isDark ? '#8E8E93' : '#6B6B70');
  const track = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(118,118,128,0.14)';
  const sep = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(60,60,67,0.16)';
  const ofTxt = t('chatyyOne.of') || 'de';
  const a11y = hasUsage ? `${fmtBytes(used)} ${ofTxt} ${fmtBytes(limit)}, ${Math.round(pct)}%` : undefined;

  const body = (
    <View style={style} testID={testID} accessible={!onPress} accessibilityLabel={a11y}>
      {showHeader ? (
        <View style={st.head}>
          <Text style={[st.used, { color: text }]} numberOfLines={1}>
            {hasUsage ? fmtBytes(used) : '—'}
            <Text style={{ fontWeight: '400', color: sub }}>{` ${ofTxt} ${limit ? fmtBytes(limit) : '—'}`}</Text>
          </Text>
          {hasUsage ? <Text style={[st.pct, TAB, { color: pct >= 95 ? RED : sub }]}>{Math.round(pct)}%</Text> : null}
        </View>
      ) : null}
      <View style={[st.track, { backgroundColor: track }]}>
        {hasUsage && segments.length ? segments.map((s, i) => {
          const w = Math.max(0.6, (s.bytes / limit) * 100);
          return <View key={s.key} style={{ width: `${Math.min(w, 100)}%`, height: '100%', backgroundColor: s.color, marginLeft: i ? 1 : 0 }} />;
        }) : (hasUsage ? <View style={{ width: `${Math.max(pct, 0.6)}%`, height: '100%', backgroundColor: text }} /> : null)}
      </View>
      {legend === 'dots' && segments.length ? (
        <View style={st.dots}>
          {segments.map((s) => (
            <View key={s.key} style={st.dotItem}>
              <View style={[st.dot, { backgroundColor: s.color, borderColor: sep }]} />
              <Text style={[st.dotTxt, TAB, { color: sub }]} numberOfLines={1}>{`${s.label} ${fmtBytes(s.bytes)}`}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {legend === 'rows' && segments.length ? (
        <View style={{ marginTop: 10 }}>
          {segments.map((s, i) => (
            <View key={s.key} style={[st.row, { borderTopWidth: i ? StyleSheet.hairlineWidth : 0, borderTopColor: sep }]}>
              <View style={[st.dot, { backgroundColor: s.color, borderColor: sep, marginRight: 10 }]} />
              <Text style={{ flex: 1, fontSize: 15, color: sub }} numberOfLines={1}>{s.label}</Text>
              <Text style={[{ fontSize: 15, fontWeight: '500', color: text }, TAB]}>{fmtBytes(s.bytes)}</Text>
            </View>
          ))}
          {hasUsage ? (
            <View style={[st.row, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: sep }]}>
              <View style={[st.dot, { backgroundColor: track, borderColor: sep, marginRight: 10 }]} />
              <Text style={{ flex: 1, fontSize: 15, color: sub }}>{t('storageMeter.free') || 'Livre'}</Text>
              <Text style={[{ fontSize: 15, fontWeight: '500', color: text }, TAB]}>{fmtBytes(Math.max(0, limit - used))}</Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
  if (!onPress) return body;
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={a11y}>{body}</Pressable>;
}

/**
 * Cartão compacto "Seu armazenamento está quase cheio" (80% / 95%) com o
 * plano certo + preço (do servidor/loja) e "Liberar espaço".
 *  - padrão: respeita o teto (80% → 1×/14 dias, 95% → 1×/3 dias; continua
 *    visível no resto da sessão em que apareceu; X dispensa).
 *  - always: na própria tela do plano (sem teto, sem X).
 *  - onUpgrade(tierId): abre a loja no lugar (tela do plano); sem ele navega
 *    para /settings-one?offer=<tier> (a loja abre lá — nunca Modal sobre Modal).
 */
export function StorageNudgeCard({ plan: planProp, always = false, onUpgrade, onFreeSpace, style, testID = 'storage-nudge' }) {
  const { colors = {}, isDark } = useTheme() || {};
  const { t } = useLanguage();
  const router = useRouter();
  const { plan: planHook } = usePlanState();
  const plan = planProp || planHook;
  const level = nudgeLevel(plan);
  const allowed = !!level && (always || canShowOffer(level));
  const [hidden, setHidden] = React.useState(false);
  useEffect(() => { if (plan?.usedBytes != null) recordUsageSample(plan.usedBytes); }, [plan?.usedBytes]);
  useEffect(() => { if (allowed && !always && level) markOfferShown(level); }, [allowed, always, level]);
  if (!allowed || hidden) return null;

  const rec = MONETIZATION_ENABLED ? recommendTier(plan) : null;
  const pct = plan.limitBytes > 0 ? (plan.usedBytes / plan.limitBytes) * 100 : 0;
  const text = colors.text || (isDark ? '#F5F5F7' : '#111111');
  const sub = colors.textSecondary || (isDark ? '#8E8E93' : '#6B6B70');
  const bg = isDark ? '#1C1C1E' : '#FFFFFF';
  const border = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(60,60,67,0.16)';
  const onInk = isDark ? '#000000' : '#FFFFFF';
  const title = pct >= 100 ? t('storageOffer.fullTitle') : t('storageOffer.nearTitle');
  const usedLine = t('storageOffer.usedLine', { used: fmtBytes(plan.usedBytes), total: fmtBytes(plan.limitBytes) });
  const recLine = rec ? (rec.tier.priceLabel
    ? t('storageOffer.recWithPrice', { size: formatGbShort(rec.tier.bytes), price: rec.tier.priceLabel })
    : t('storageOffer.recNoPrice', { size: formatGbShort(rec.tier.bytes) })) : '';
  const upgrade = () => {
    if (!rec) return;
    if (onUpgrade) { onUpgrade(rec.tier.id); return; }
    try { router.push(offerHref(rec.tier.id)); } catch {}
  };
  const freeSpace = () => {
    if (onFreeSpace) { onFreeSpace(); return; }
    try { router.push('/manage-storage'); } catch {}
  };

  return (
    <View style={[st.card, { backgroundColor: bg, borderColor: border }, style]} testID={testID}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <View style={[st.badge, { backgroundColor: text }]}><IconCloud size={18} color={onInk} /></View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[st.cardTitle, { color: text }]}>{title}</Text>
          <Text style={[st.cardBody, { color: sub }]}>{usedLine}{recLine ? ` ${recLine}` : ''}</Text>
        </View>
        {!always ? (
          <Pressable
            onPress={() => { dismissOffer(level); setHidden(true); }}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t('storageOffer.dismiss') || 'Agora não'}
            testID={testID + '-dismiss'}
          >
            <IconX size={18} color={sub} />
          </Pressable>
        ) : null}
      </View>
      <View style={st.actions}>
        {rec ? (
          <Pressable onPress={upgrade} style={[st.btn, { backgroundColor: text }]} accessibilityRole="button" testID={testID + '-upgrade'}>
            <Text style={[st.btnTxt, { color: onInk }]} numberOfLines={1}>{t('storageOffer.getSize', { size: formatGbShort(rec.tier.bytes) })}</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={freeSpace} style={[st.btn, { borderWidth: StyleSheet.hairlineWidth * 2, borderColor: border }]} accessibilityRole="button" testID={testID + '-free'}>
          <Text style={[st.btnTxt, { color: text }]} numberOfLines={1}>{t('storageOffer.freeSpace')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8, gap: 8 },
  used: { fontSize: 15, fontWeight: '600', flexShrink: 1 },
  pct: { fontSize: 12.5, fontWeight: '600' },
  track: { height: 8, borderRadius: 4, overflow: 'hidden', flexDirection: 'row' },
  dots: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 8, columnGap: 12, rowGap: 4 },
  dotItem: { flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: '100%' },
  dot: { width: 8, height: 8, borderRadius: 4, borderWidth: StyleSheet.hairlineWidth },
  dotTxt: { fontSize: 11.5 },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 40 },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14, ...(Platform.OS === 'web' ? {} : {}) },
  badge: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  cardTitle: { fontSize: 15, fontWeight: '700' },
  cardBody: { fontSize: 13, lineHeight: 18, marginTop: 3 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' },
  btn: { minHeight: 36, paddingHorizontal: 14, borderRadius: 18, alignItems: 'center', justifyContent: 'center', flexGrow: 1 },
  btnTxt: { fontSize: 14, fontWeight: '600' },
});
