// [2026-10-11 settings-unify] Painéis compartilhados do hub de Configurações.
//
// Antes, estas telas existiam DUPLICADAS: no /settings e no
// ProfileSettingsSheet (engrenagem do perfil) — e algumas só no
// ChatProfileTab (aba morta, nunca renderizada). Agora vivem AQUI, uma vez,
// no visual de listas agrupadas (SettingsKit), e são usadas pelo hub
// (app/settings.js) e pelas sub-rotas app/settings-*.js.
//
// Mesmas chaves/APIs de antes (nenhuma migração de dados):
//   - chatyy_strip_exif / chatyy_sealed_sender / push_enabled → AsyncStorage
//     por conta (`base:email`) + espelho global legado (lido pelo envio).
//   - cloud_chats_default → chat_privacy_set.
//   - wallpaper global → chat_update_settings { wallpaper }.
//   - bloqueados → chat_blocked_list / chat_unblock_user.
//   - exportação → account_data_export. Plano → plan_info + chat_storage_usage.
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, Alert, Linking, Platform, Pressable } from 'react-native';
import * as api from '../../services/api';
import * as settingsCache from '../../services/settingsCache'; // [2026-10-13 settings-instant]
import { useTheme, ACCENT_PRESETS } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { SettingsGroup, SettingsRow, SettingsSwitchRow, SettingsCardContent, useGroupedColors } from './SettingsKit';
import AvatarCircle from '../AvatarCircle';
import PressableRow from '../PressableRow';
import Svg, { Rect as SvgRect, Path as SvgPath } from 'react-native-svg';
import { IconCheck, IconCloud, IconZap } from '../Icons';
import { normalizePlanState, planDisplayName, formatQuotaBytes } from '../../services/planState';
import { openStripePortal, isStripeCardAvailable } from '../../services/stripeCheckout';
import { MONETIZATION_ENABLED } from '../../constants/featureFlags';

// ─── Storage helpers (per-account, same contract as the old sheet) ────────
function _activeEmail() {
  try { return (typeof api.getActiveAccountEmail === 'function' ? api.getActiveAccountEmail() : '') || ''; } catch { return ''; }
}
function _acctKey(base) {
  const email = _activeEmail();
  return email ? `${base}:${email}` : base;
}
async function _store() {
  if (Platform.OS === 'web') {
    return {
      getItem: async (k) => { try { return localStorage.getItem(k); } catch { return null; } },
      setItem: async (k, v) => { try { localStorage.setItem(k, v); } catch {} },
    };
  }
  return (await import('@react-native-async-storage/async-storage')).default;
}
// [2026-10-13 settings-instant] Espelho síncrono (settingsCache, por conta)
// das flags locais → o switch já nasce no valor salvo (sem piscar pelo
// getItem assíncrono do AsyncStorage).
function peekAcctFlag(base) {
  try { const c = settingsCache.peek('local_flags'); return c && typeof c === 'object' && base in c ? c[base] : null; } catch { return null; }
}
function _mirrorFlag(base, value) {
  try { settingsCache.patch('local_flags', { [base]: value }); } catch {}
}
// Per-account read with one-time fallback to the legacy global key.
async function readAcctFlag(base) {
  const s = await _store();
  const nk = _acctKey(base);
  let v = null;
  try { v = await s.getItem(nk); } catch {}
  if (v == null && nk !== base) { try { v = await s.getItem(base); } catch {} }
  if (v != null && peekAcctFlag(base) !== v) _mirrorFlag(base, v);
  return v;
}
// Dual-write: per-account key + legacy global key (chat send pipeline reads it).
async function writeAcctFlag(base, value, { mirrorGlobal = true } = {}) {
  if (peekAcctFlag(base) !== value) _mirrorFlag(base, value);
  const s = await _store();
  try { await s.setItem(_acctKey(base), value); } catch {}
  if (mirrorGlobal) { try { await s.setItem(base, value); } catch {} }
}

function fmtBytes(b) {
  const v = Number(b) || 0;
  if (v >= 1024 ** 4) return (v / 1024 ** 4).toFixed(2) + ' TB';
  if (v >= 1024 ** 3) return (v / 1024 ** 3).toFixed(1) + ' GB';
  if (v >= 1024 ** 2) return Math.round(v / 1024 ** 2) + ' MB';
  return Math.round(v / 1024) + ' KB';
}

// ─── Privacidade › Mídia e mensagens (EXIF, sealed sender, nuvem) ─────────
export function PrivacyExtrasGroup({ cloudChats, onCloudChatsChange }) {
  const { t } = useLanguage();
  const [stripExif, setStripExif] = useState(() => peekAcctFlag('chatyy_strip_exif') !== 'false');
  const [sealed, setSealed] = useState(() => peekAcctFlag('chatyy_sealed_sender') === 'true');
  useEffect(() => {
    let alive = true;
    (async () => {
      const ex = await readAcctFlag('chatyy_strip_exif');
      const ss = await readAcctFlag('chatyy_sealed_sender');
      if (!alive) return;
      const exV = ex !== 'false';
      const ssV = ss === 'true';
      setStripExif(exV);
      setSealed(ssV);
      // Re-assert the ACTIVE account's values onto the global keys the send
      // pipeline reads (prevents cross-account leak after a switch).
      writeAcctFlag('chatyy_strip_exif', exV ? 'true' : 'false');
      writeAcctFlag('chatyy_sealed_sender', ssV ? 'true' : 'false');
    })();
    return () => { alive = false; };
  }, []);
  return (
    <SettingsGroup header={t('settings.rd2.mediaPrivacy')} footer={t('privacy.cloudChatsDesc')}>
      <SettingsSwitchRow
        title={t('privacy.stripExif')}
        subtitle={t('privacy.stripExifDesc')}
        value={stripExif}
        onValueChange={(v) => { setStripExif(!!v); writeAcctFlag('chatyy_strip_exif', v ? 'true' : 'false'); }}
      />
      <SettingsSwitchRow
        title={t('privacy.sealedSender')}
        subtitle={t('privacy.sealedSenderDesc')}
        value={sealed}
        onValueChange={(v) => { setSealed(!!v); writeAcctFlag('chatyy_sealed_sender', v ? 'true' : 'false'); }}
      />
      <SettingsSwitchRow
        title={t('privacy.cloudChats')}
        value={cloudChats !== false}
        onValueChange={(v) => onCloudChatsChange?.(!!v)}
      />
    </SettingsGroup>
  );
}

// ─── Notificações › chave geral de push (por aparelho) ─────────────────────
export function PushMasterSwitchRow() {
  const { t } = useLanguage();
  const [enabled, setEnabled] = useState(() => peekAcctFlag('push_enabled') !== 'false');
  useEffect(() => {
    let alive = true;
    (async () => {
      const v = await readAcctFlag('push_enabled');
      if (!alive) return;
      const on = v !== 'false';
      setEnabled(on);
      try { const push = await import('../../services/pushNotifications'); push.setPushMasterEnabled?.(on); } catch {}
    })();
    return () => { alive = false; };
  }, []);
  const onChange = async (v) => {
    const on = !!v;
    setEnabled(on);
    // Per-account only (no external reader of the global key).
    await writeAcctFlag('push_enabled', on ? 'true' : 'false', { mirrorGlobal: false });
    try {
      const push = await import('../../services/pushNotifications');
      push.setPushMasterEnabled?.(on);
      if (on) push.ensurePushTokenFresh?.({ force: true, ignoreMaster: true })?.catch?.(() => {});
      else push.removeTokenFromBackend?.()?.catch?.(() => {});
    } catch {}
    try { await api.updateSettings?.({ push_enabled: on }); } catch {}
  };
  return (
    <SettingsSwitchRow title={t('notif.push')} subtitle={t('notif.pushDesc')} value={enabled} onValueChange={onChange} />
  );
}

// ─── Conversas › cor de destaque ───────────────────────────────────────────
export function AccentColorGroup() {
  const { t } = useLanguage();
  const { accentColor, setAccentColor } = useTheme();
  const g = useGroupedColors();
  if (!Array.isArray(ACCENT_PRESETS) || !setAccentColor) return null;
  return (
    <SettingsGroup header={t('settings.accentColor')}>
      <SettingsCardContent>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
          {ACCENT_PRESETS.map(p => {
            const selected = accentColor === p.hex;
            return (
              <Pressable
                key={p.key}
                onPress={() => setAccentColor(p.hex)}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                accessibilityLabel={p.key}
                style={{
                  width: 32, height: 32, borderRadius: 16, backgroundColor: p.hex,
                  borderWidth: selected ? 3 : 1, borderColor: selected ? g.ink : g.separator,
                  alignItems: 'center', justifyContent: 'center',
                }}
              >
                {selected ? <IconCheck size={14} color="#FFFFFF" strokeWidth={3} /> : null}
              </Pressable>
            );
          })}
        </View>
      </SettingsCardContent>
    </SettingsGroup>
  );
}

// ─── Conversas › papel de parede padrão (todas as conversas) ──────────────
// Was reachable only from the dead ChatProfileTab. Same storage:
// chat_get_settings.wallpaper / chat_update_settings({ wallpaper }).
export function WallpaperRow() {
  const { t } = useLanguage();
  const { colors, isDark } = useTheme();
  const [open, setOpen] = useState(false);
  // [2026-10-13 settings-instant] snapshot 'chat_settings' (por conta) + revalidação.
  const { data: chatSettings } = settingsCache.useSettingsSection('chat_settings');
  const [current, setCurrent] = useState(() => (chatSettings && typeof chatSettings.wallpaper === 'string' && chatSettings.wallpaper) || 'none');
  const [Picker, setPicker] = useState(null);
  useEffect(() => {
    if (chatSettings && typeof chatSettings.wallpaper === 'string') setCurrent(chatSettings.wallpaper || 'none');
  }, [chatSettings]);
  const openPicker = () => {
    if (!Picker) { try { setPicker(() => require('../WallpaperPicker').default); } catch {} }
    setOpen(true);
  };
  const swatch = current && current.startsWith('#') ? current : null;
  return (
    <>
      <SettingsRow
        title={t('config.wallpaper')}
        onPress={openPicker}
        right={swatch ? <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: swatch }} /> : undefined}
        chevron
      />
      {open && Picker ? (
        <Picker
          visible
          onClose={() => setOpen(false)}
          colors={colors}
          isDark={isDark}
          t={t}
          conversationId={null}
          currentValue={current || 'none'}
          defaultScope="all"
          onApply={(value) => {
            setCurrent(value);
            try { globalThis.__chatyy_chat_settings_rev = (Number(globalThis.__chatyy_chat_settings_rev) || 0) + 1; } catch {} // = api.chatUpdateSettings
            settingsCache.commit('chat_settings', { patch: { wallpaper: value }, action: 'chat_update_settings', params: { wallpaper: value } })
              .then((res) => { if (res && res.ok === false) settingsCache.notifySaveFailed(t); }).catch(() => {});
          }}
        />
      ) : null}
    </>
  );
}

// ─── Conta › Baixar meus dados ─────────────────────────────────────────────
export function ExportDataPanel() {
  const { t } = useLanguage();
  const g = useGroupedColors();
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const requestExport = async () => {
    setWorking(true); setError(''); setResult(null);
    try {
      const r = await api.accountDataExport?.();
      if (r?.success && r.data) setResult(r.data);
      else setError(r?.message || t('common.error'));
    } catch (e) { setError(e?.message || t('common.error')); }
    finally { setWorking(false); }
  };
  const items = ['exportItemProfile', 'exportItemChats', 'exportItemEmail', 'exportItemPosts', 'exportItemNotifs'];
  return (
    <>
      <SettingsGroup footer={t('settings.exportHeroSub')}>
        <SettingsRow title={t('settings.exportHeroTitle')} />
      </SettingsGroup>
      <SettingsGroup header={t('settings.exportIncludes')} footer={t('settings.exportLimitNote')}>
        {items.map(k => (
          <SettingsRow key={k} title={t('settings.' + k)} right={<IconCheck size={18} color={g.ink} />} />
        ))}
      </SettingsGroup>
      {result?.url ? (
        <SettingsGroup header={t('settings.exportReady')}>
          <SettingsRow title={String(result.url)} numberOfLines={2} onPress={() => { Linking.openURL(result.url).catch(() => {}); }} />
        </SettingsGroup>
      ) : null}
      {!!error && (
        <SettingsGroup>
          <SettingsRow title={error} titleStyle={{ color: g.destructive, fontSize: 14 }} numberOfLines={3} />
        </SettingsGroup>
      )}
      <SettingsGroup>
        <SettingsRow
          center
          title={result?.url ? t('settings.exportRedo') : t('settings.exportData')}
          titleStyle={{ fontWeight: '600' }}
          onPress={working ? undefined : requestExport}
          chevron={false}
          right={working ? <ActivityIndicator size="small" color={g.secondary} /> : undefined}
        />
      </SettingsGroup>
    </>
  );
}

// ─── Privacidade › Contatos bloqueados ─────────────────────────────────────
// Before: only inside the dead ChatProfileTab → unreachable in the app.
export function BlockedContactsPanel() {
  const { t } = useLanguage();
  const g = useGroupedColors();
  // [2026-10-13 settings-instant] lista salva no aparelho → abre na hora;
  // revalida em 2º plano. Spinner só na 1ª vez na vida (sem cache).
  const { data: cached, revalidating } = settingsCache.useSettingsSection('blocked');
  const list = Array.isArray(cached) ? cached : (revalidating ? null : []);
  const unblock = (email) => {
    const doIt = async () => {
      // Otimista: some da lista na hora; volta se o servidor recusar.
      settingsCache.patch('blocked', (prev) => (Array.isArray(prev) ? prev : []).filter(b => b.blocked_email !== email));
      try {
        const r = await api.chatUnblockUser(email);
        if (r && r.success === false) { settingsCache.revalidate('blocked', { force: true }).catch(() => {}); settingsCache.notifySaveFailed(t); }
        else { try { api.swrInvalidate?.('chat_blocked_list'); } catch {} }
      } catch { settingsCache.revalidate('blocked', { force: true }).catch(() => {}); }
    };
    const title = t('config.unblock');
    const msg = String(t('config.unblockConfirm') || '').replace('{email}', email);
    if (Platform.OS === 'web') {
      let ok = false;
      try { ok = typeof window !== 'undefined' && window.confirm(`${title}\n\n${msg}`); } catch {}
      if (ok) doIt();
      return;
    }
    Alert.alert(title, msg, [
      { text: t('common.cancel'), style: 'cancel' },
      { text: title, style: 'destructive', onPress: doIt },
    ]);
  };
  if (list === null) {
    // 1ª abertura sem cache: indicador discreto numa linha (não tela cheia).
    return (
      <SettingsGroup footer={t('settings.blockedFooter')}>
        <SettingsRow title=" " chevron={false} right={<ActivityIndicator size="small" color={g.secondary} />} />
      </SettingsGroup>
    );
  }
  return (
    <SettingsGroup footer={t('settings.blockedFooter')}>
      {list.length === 0 ? (
        <SettingsRow title={t('config.noBlocked')} titleStyle={{ color: g.secondary }} />
      ) : list.map(b => (
        <SettingsRow
          key={b.blocked_email}
          title={b.blocked_name || b.name || b.blocked_email}
          subtitle={(b.blocked_name || b.name) ? b.blocked_email : undefined}
          onPress={() => unblock(b.blocked_email)}
          chevron={false}
          right={<Text style={{ color: g.destructive, fontSize: 15 }}>{t('config.unblock')}</Text>}
        />
      ))}
    </SettingsGroup>
  );
}

// ─── Conta › Chatyy One (plano, uso e pagamento) ───────────────────────────
export function ChatyyOnePanel() {
  const { t, language } = useLanguage();
  const g = useGroupedColors();
  // [2026-10-13 settings-instant] plano + uso salvos no aparelho (seção
  // 'plan' = plan_info ‖ chat_storage_usage em paralelo) → abre na hora.
  const { data: planSnap, revalidating, refresh: load } = settingsCache.useSettingsSection('plan');
  const plan = planSnap?.plan || null;
  const usage = planSnap?.usage || null;
  const loading = !planSnap && revalidating;
  const [busy, setBusy] = useState(false);
  const [shop, setShop] = useState(false);
  if (loading) return <View style={{ paddingVertical: 40, alignItems: 'center' }}><ActivityIndicator color={g.secondary} /></View>;

  const planNorm = normalizePlanState(plan, usage);
  const isPaid = planNorm.isPaid;
  const used = Number(usage?.used_bytes ?? plan?.storage_used);
  const limit = planNorm.limitBytes;
  const hasUsage = Number.isFinite(used) && limit > 0;
  const pct = hasUsage ? Math.min(100, Math.max(0, (used / limit) * 100)) : 0;
  const isIOS = Platform.OS === 'ios';
  const stripeOk = isStripeCardAvailable();
  const gbTxt = formatQuotaBytes(limit);
  const fmtDate = (iso) => {
    if (!iso) return null;
    const d = new Date(String(iso).replace(' ', 'T'));
    if (isNaN(d.getTime())) return null;
    try { return d.toLocaleDateString(language || undefined, { day: '2-digit', month: 'long', year: 'numeric' }); } catch { return d.toISOString().slice(0, 10); }
  };
  const renews = fmtDate(plan?.expires_at);
  const period = plan?.billing_period === 'annual' || plan?.billing_period === 'yearly' ? t('chatyyOne.annual') : t('chatyyOne.monthly');
  const manage = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await openStripePortal();
      if (!r?.success) Alert.alert(t('common.error'), t('storage.portalFailed'));
      else load();
    } finally { setBusy(false); }
  };
  let ShopSheet = null;
  if (MONETIZATION_ENABLED) { try { ShopSheet = require('../StorageShopSheet').default; } catch {} }
  return (
    <>
      <SettingsGroup>
        <SettingsCardContent style={{ paddingVertical: 16 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: g.tileBg, alignItems: 'center', justifyContent: 'center' }}>
              <IconCloud size={22} color={g.tileFg} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ fontSize: 19, fontWeight: '700', color: g.text }}>{planDisplayName(planNorm.planId, t)}</Text>
              <Text style={{ fontSize: 13, color: g.secondary, marginTop: 2 }}>{`${gbTxt} ${t('chatyyOne.included')}`}</Text>
            </View>
            <Text style={{ fontSize: 12, fontWeight: '700', color: isPaid ? g.ink : g.secondary }}>
              {isPaid ? t('chatyyOne.statusActive') : t('chatyyOne.statusFree')}
            </Text>
          </View>
          <View style={{ marginTop: 16 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
              <Text style={{ fontSize: 15, fontWeight: '600', color: g.text }}>
                {hasUsage ? fmtBytes(used) : '—'}
                <Text style={{ fontWeight: '400', color: g.secondary }}>{` ${t('chatyyOne.of')} ${gbTxt}`}</Text>
              </Text>
              {hasUsage ? <Text style={{ fontSize: 12.5, color: g.secondary }}>{Math.round(pct)}%</Text> : null}
            </View>
            <View style={{ height: 8, borderRadius: 4, backgroundColor: g.fill, overflow: 'hidden' }}>
              <View style={{ width: pct + '%', height: '100%', borderRadius: 4, backgroundColor: pct >= 95 ? '#ef4444' : pct >= 80 ? '#f59e0b' : g.ink }} />
            </View>
            {pct >= 80 ? <Text style={{ fontSize: 12.5, color: pct >= 95 ? '#ef4444' : '#b45309', marginTop: 8 }}>{t('chatyyOne.nearFull')}</Text> : null}
          </View>
        </SettingsCardContent>
        {MONETIZATION_ENABLED && ShopSheet ? (
          <SettingsRow
            icon={IconZap}
            title={isPaid ? t('chatyyOne.changePlan') : t('chatyyOne.upgrade')}
            onPress={() => setShop(true)}
          />
        ) : null}
      </SettingsGroup>
      {isPaid ? (
        <SettingsGroup header={t('chatyyOne.subscription')}>
          <SettingsRow title={t('chatyyOne.status')} value={t('chatyyOne.statusActive')} />
          <SettingsRow title={t('chatyyOne.billing')} value={period} />
          {renews ? <SettingsRow title={t('chatyyOne.renewal')} value={renews} /> : null}
        </SettingsGroup>
      ) : null}
      <SettingsGroup header={t('chatyyOne.payment')} footer={isIOS ? t('chatyyOne.iosFootnote') : t('chatyyOne.footnote')}>
        {isIOS ? (
          <SettingsRow title={t('chatyyOne.manageOnWeb')} subtitle={t('chatyyOne.iosNote')} onPress={() => { Linking.openURL('https://chatyy.com.br').catch(() => {}); }} />
        ) : (
          <>
            <SettingsRow title={t('chatyyOne.method')} subtitle={isPaid ? t('chatyyOne.methodCard') : t('chatyyOne.methodNone')} />
            {stripeOk ? (
              <SettingsRow
                title={isPaid ? t('chatyyOne.managePayment') : t('chatyyOne.managePaymentFree')}
                onPress={manage}
                right={busy ? <ActivityIndicator size="small" color={g.secondary} /> : undefined}
              />
            ) : null}
          </>
        )}
      </SettingsGroup>
      {MONETIZATION_ENABLED && ShopSheet ? (
        <ShopSheet
          visible={shop}
          onClose={() => { setShop(false); load(); }}
          currentTier={String(usage?.tier || 'free')}
          usedBytes={hasUsage ? used : undefined}
          limitBytes={limit}
        />
      ) : null}
    </>
  );
}

// ─── Cabeçalho do hub (foto, nome, recado/@, QR) ───────────────────────────
// Tap → /edit-profile (a ÚNICA tela de edição). Ícone QR → /profile-qr.
function QrGlyph({ size = 18, color = '#111' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <SvgRect x="3" y="3" width="7" height="7" rx="1.2" />
      <SvgRect x="14" y="3" width="7" height="7" rx="1.2" />
      <SvgRect x="3" y="14" width="7" height="7" rx="1.2" />
      <SvgPath d="M14 14h3v3M21 14v.01M14 21h3M21 18v3M17.5 17.5v.01" />
    </Svg>
  );
}
export function ProfileHeaderCard({ user, profile, onPress, onPressQr, avatarKey }) {
  const g = useGroupedColors();
  const { t } = useLanguage();
  const name = (profile?.name || user?.name || user?.display_name || '').trim()
    || (user?.email ? user.email.split('@')[0] : '');
  const about = (profile?.about || profile?.recado || '').trim();
  const handle = (profile?.username || '').trim();
  const sub = about || (handle ? '@' + handle : (user?.email || ''));
  return (
    <SettingsGroup>
      <PressableRow
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${t('settings.editProfile')}: ${name}`}
        testID="settings-profile-card"
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 }}>
          <AvatarCircle key={avatarKey} email={user?.email} name={name || user?.email} size={58} />
          <View style={{ flex: 1, minWidth: 0, marginHorizontal: 14 }}>
            <Text style={{ fontSize: 20, fontWeight: '600', color: g.text }} numberOfLines={1}>{name}</Text>
            {!!sub && <Text style={{ fontSize: 14, color: g.secondary, marginTop: 2 }} numberOfLines={1}>{sub}</Text>}
          </View>
          {onPressQr ? (
            <Pressable
              onPress={onPressQr}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={t('profile.qrCode')}
              testID="settings-profile-qr"
              style={{ width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: g.fill }}
            >
              <QrGlyph size={19} color={g.ink} />
            </Pressable>
          ) : null}
        </View>
      </PressableRow>
    </SettingsGroup>
  );
}
