// [2026-10-20 plano-premium] Tela do plano (Configurações > Chatyy Plus/Pro,
// /settings-one e /storage) no nível iCloud+ / Google One / Telegram Premium,
// em preto e branco:
//   1. Cabeçalho com selo do plano, status e renovação; uso em número grande +
//      barra segmentada por tipo (rampa de cinzas) + legenda; aviso perto do limite.
//   2. Grátis → paywall (Plus) com preço da loja.
//   3. Comparação Grátis / Plus / Pro em cartões que rolam na horizontal,
//      Mensal/Anual com a economia do anual (preço da LOJA — StoreKit / Play —
//      ou referência do catálogo do servidor quando a loja não tem o produto).
//   4. Incluído no seu plano: armazenamento, envio de arquivos, backup, família
//      (plans.php plan_family_*: gerenciar/adicionar de verdade) e o que é
//      realmente exclusivo de quem assina (reagir com figurinhas: chat.php 402).
//   5. Gerenciar armazenamento com estimativa de quanto dá para liberar.
//   6. Assinatura: plano, preço, renovação DD/MM/AAAA, Gerenciar (Apple/Google/
//      cartão antigo), Restaurar compras, Histórico de compras, termos/privacidade.
//   Estados: skeleton, offline/erro com Tentar de novo.
// Compra só pelas lojas (services/planOffers → services/iap). Nada de Stripe novo.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, Pressable, ScrollView, ActivityIndicator, Alert, Platform, StyleSheet,
  Animated, Easing, useWindowDimensions, Linking,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import Svg, { Path, Circle } from 'react-native-svg';
import * as api from '../../services/api';
import * as settingsCache from '../../services/settingsCache';
import * as kv from '../../services/mmkv';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { SettingsGroup, SettingsRow, useGroupedColors } from '../settings/SettingsKit';
import {
  IconCloud, IconFile, IconClock, IconUsers, IconTrash, IconCreditCard, IconRefresh,
  IconReceipt, IconCheck, IconWifiOff, IconAlertCircle, IconAlertTriangle, IconSmile, IconDatabase,
} from '../Icons';
import { buildSegments, meterFromPlan, saveDriveSplit } from '../storage/StorageMeter';
import { normalizePlanState, planDisplayName, formatGb, invalidatePlanState, GB } from '../../services/planState';
import { formatStorage } from '../../services/format';
import { openStripePortal } from '../../services/stripeCheckout';
import { openInApp } from '../../utils/inAppBrowser';
import { MONETIZATION_ENABLED } from '../../constants/featureFlags';
import {
  ensureStore, storePrice, planPrice, annualSavingsPct, hasAnnual, purchasePlan, restore,
  openStoreSubscriptions, purchaseHistoryUrl, termsUrl, PRIVACY_URL, SUPPORT_URL, fmtDMY, PLAN_RANK,
} from '../../services/planOffers';
import PlanFamilySheet from './PlanFamilySheet';

// RN-web: Alert.alert não faz nada → confirm/alert do navegador.
function showAlert(title, message, buttons) {
  if (Platform.OS === 'web') {
    try {
      const ok = (buttons || []).find((b) => b && b.style !== 'cancel');
      const cancel = (buttons || []).find((b) => b && b.style === 'cancel');
      if (ok && ok.onPress) { if (window.confirm(`${title}\n\n${message || ''}`)) ok.onPress(); else if (cancel && cancel.onPress) cancel.onPress(); }
      else window.alert(`${title}\n\n${message || ''}`);
    } catch {}
    return;
  }
  Alert.alert(title, message, buttons);
}

const NATIVE = Platform.OS === 'ios' || Platform.OS === 'android';
const TAB = { fontVariant: ['tabular-nums'] };
const PLANS = ['free', 'plus', 'pro'];
const BIG_MIN = 5 * 1024 * 1024;

// ── Selo do plano (roseta SVG; glifo por plano) ───────────────────────────
function rosettePath(cx, cy, R, r, n) {
  let d = '';
  for (let i = 0; i < n * 2; i++) {
    const rad = i % 2 === 0 ? R : r;
    const a = (Math.PI * i) / n - Math.PI / 2;
    const x = cx + rad * Math.cos(a); const y = cy + rad * Math.sin(a);
    d += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2) + ' ';
  }
  return d + 'Z';
}
const ROSETTE = rosettePath(32, 32, 30, 26.5, 16);
export function PlanSeal({ planId = 'free', size = 56, ink, onInk }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Path d={ROSETTE} fill={ink} stroke={ink} strokeWidth={2} strokeLinejoin="round" />
      {planId === 'pro' ? <Circle cx="32" cy="32" r="20.5" fill="none" stroke={onInk} strokeOpacity={0.35} strokeWidth={1.2} /> : null}
      {planId === 'free' ? (
        <Path d="M24.5 39h15a6 6 0 0 0 .9-11.93A8.5 8.5 0 0 0 24 29.2 5 5 0 0 0 24.5 39z" fill="none" stroke={onInk} strokeWidth={2.4} strokeLinejoin="round" strokeLinecap="round" />
      ) : planId === 'plus' ? (
        <Path d="M32 23v18M23 32h18" stroke={onInk} strokeWidth={3.4} strokeLinecap="round" />
      ) : (
        <Path d="M24 36.5l8-7 8 7M24 29l8-7 8 7" fill="none" stroke={onInk} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
      )}
    </Svg>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────
function Skeleton({ g }) {
  const a = useRef(new Animated.Value(0.55)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(a, { toValue: 1, duration: 650, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
      Animated.timing(a, { toValue: 0.55, duration: 650, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [a]);
  const B = ({ w, h, r = 8, mt = 0 }) => <View style={{ width: w, height: h, borderRadius: r, marginTop: mt, backgroundColor: g.fill }} />;
  return (
    <Animated.View style={{ opacity: a }} testID="plan-skeleton" accessibilityLabel="…">
      <View style={[st.hero, { backgroundColor: g.cardBg }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <B w={56} h={56} r={28} />
          <View style={{ flex: 1 }}><B w={90} h={12} /><B w={170} h={22} mt={8} /></View>
        </View>
        <B w={150} h={38} mt={26} />
        <B w="100%" h={12} r={6} mt={14} />
        <View style={{ flexDirection: 'row', gap: 12, marginTop: 16 }}><B w="45%" h={14} /><B w="45%" h={14} /></View>
      </View>
      <B w={120} h={12} mt={8} />
      <View style={{ flexDirection: 'row', gap: 12, marginTop: 10 }}>
        <View style={[st.planCard, { width: 250, height: 300, backgroundColor: g.cardBg }]} />
        <View style={[st.planCard, { width: 250, height: 300, backgroundColor: g.cardBg }]} />
      </View>
    </Animated.View>
  );
}

// ── Botões ────────────────────────────────────────────────────────────────
function Btn({ label, onPress, kind = 'solid', g, busy, disabled, testID, style, inverse }) {
  const ink = inverse ? g.onInk : g.ink;
  const onInk = inverse ? g.ink : g.onInk;
  const solid = kind === 'solid';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!(disabled || busy), busy: !!busy }}
      testID={testID}
      style={({ pressed }) => [
        st.btn,
        solid ? { backgroundColor: ink } : { borderWidth: 1.2, borderColor: kind === 'ghost' ? 'transparent' : (inverse ? 'rgba(255,255,255,0.35)' : g.ring) },
        { opacity: disabled ? 0.5 : pressed ? 0.75 : 1 },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={solid ? onInk : ink} /> : <Text style={[st.btnTxt, { color: solid ? onInk : ink }]} numberOfLines={1}>{label}</Text>}
    </Pressable>
  );
}

function splitNum(txt) {
  const m = String(txt || '').match(/^([\d.,]+)\s*(.*)$/);
  return m ? [m[1], m[2]] : [String(txt || ''), ''];
}

// ── estimativa "quanto dá para liberar" (itens grandes do Drive) ─────────
function _estKey() {
  let e = ''; try { e = String(api.getSavedEmail?.() || '').toLowerCase(); } catch {}
  return 'plan_freeable_v1:' + (e || '_');
}
function useFreeableEstimate(enabled) {
  const [est, setEst] = useState(() => { try { return kv.getJSON(_estKey()) || null; } catch { return null; } });
  useEffect(() => {
    if (!enabled) return undefined;
    if (est && Date.now() - (Number(est.at) || 0) < 15 * 60 * 1000) return undefined;
    let alive = true;
    const tm = setTimeout(async () => {
      try {
        const r = await api.fileListAll();
        const list = Array.isArray(r?.data?.files) ? r.data.files : (Array.isArray(r?.files) ? r.files : null);
        if (!list || !alive) return;
        let n = 0; let bytes = 0; const split = { photos: 0, videos: 0, files: 0 };
        for (const f of list) {
          if (!f || f.is_folder || f.is_trashed) continue;
          const size = Number(f.size) || 0;
          if (size <= 0) continue;
          const mime = String(f.mime_type || f.mimetype || f.type || '').toLowerCase();
          const name = String(f.name || '').toLowerCase();
          const isVid = mime.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/.test(name);
          const isImg = !isVid && (mime.startsWith('image/') || /\.(jpe?g|png|heic|heif|gif|webp|bmp|tiff?)$/.test(name));
          if (isVid) split.videos += size; else if (isImg) split.photos += size; else split.files += size;
          if (size >= BIG_MIN) { n += 1; bytes += size; }
        }
        try { saveDriveSplit(split); } catch {}
        const v = { at: Date.now(), n, bytes };
        try { kv.setJSON(_estKey(), v); } catch {}
        if (alive) setEst(v);
      } catch {}
    }, 700);
    return () => { alive = false; clearTimeout(tm); };
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return est;
}

export default function PlanHub() {
  const { t, language } = useLanguage();
  const g = useGroupedColors();
  const { colors, isDark } = useTheme() || {};
  const router = useRouter();
  const { width: winW } = useWindowDimensions();
  const { data: planSnap, refresh } = settingsCache.useSettingsSection('plan');
  const info = planSnap?.plan || null;
  const usage = planSnap?.usage || null;

  // carregamento / erro / offline
  const [failed, setFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [offline, setOffline] = useState(false);
  const firstTry = useRef(false);
  useEffect(() => {
    if (planSnap || firstTry.current) return;
    firstTry.current = true;
    refresh().catch(() => {}).finally(() => { if (!settingsCache.peek('plan')) setFailed(true); });
  }, [planSnap, refresh]);
  useEffect(() => {
    let off = null;
    try {
      const NetInfo = require('@react-native-community/netinfo').default;
      off = NetInfo.addEventListener((s) => setOffline(s && s.isConnected === false));
    } catch {}
    return () => { try { off && off(); } catch {} };
  }, []);
  const retry = async () => {
    setRetrying(true);
    try { await refresh(); } catch {}
    setRetrying(false);
    setFailed(!settingsCache.peek('plan'));
  };

  // loja (preços localizados)
  const [, setStoreTick] = useState(0);
  useEffect(() => {
    let alive = true;
    ensureStore().then(() => { if (alive) setStoreTick((x) => x + 1); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const plan = useMemo(() => (planSnap ? normalizePlanState(info, usage) : null), [planSnap, info, usage]);
  const planId = plan?.planId || 'free';
  const isPaid = !!plan && planId !== 'free';
  const isFamilyMember = !!(plan && plan.familyAdmin);
  const catalog = plan?.catalog || null;
  const curPeriod = plan && (plan.billingPeriod === 'annual' || plan.billingPeriod === 'yearly') ? 'annual' : 'monthly';
  const [period, setPeriod] = useState(null);
  const per = period || curPeriod;
  const annualOk = hasAnnual(catalog);

  // assinatura Apple (renovação automática / produto) — leitura, best-effort
  const [appleSub, setAppleSub] = useState(null);
  useEffect(() => {
    if (!isPaid || isFamilyMember) { setAppleSub(null); return undefined; }
    let alive = true;
    api.iapSubscriptionInfo?.().then((r) => { if (alive && r?.success && r.data) setAppleSub(r.data); }).catch(() => {});
    return () => { alive = false; };
  }, [isPaid, isFamilyMember]);

  const source = !isPaid ? null
    : isFamilyMember ? 'family'
    : plan.hasStripeBilling ? 'stripe'
    : appleSub?.has_subscription ? 'apple'
    : Platform.OS === 'android' ? 'google' : Platform.OS === 'ios' ? 'apple' : 'store';

  const est = useFreeableEstimate(!!planSnap);
  const segments = useMemo(() => (plan ? buildSegments(meterFromPlan(plan), t, isDark) : []), [plan, t, isDark, est]); // eslint-disable-line react-hooks/exhaustive-deps

  // loja de armazenamento (existente) + ?offer=<tier>
  const [shop, setShop] = useState(false);
  const [shopTier, setShopTier] = useState(null);
  const routeParams = useLocalSearchParams();
  const offerParam = typeof routeParams?.offer === 'string' ? routeParams.offer : '';
  const offerDone = useRef('');
  useEffect(() => {
    if (!offerParam || offerDone.current === offerParam || !MONETIZATION_ENABLED) return undefined;
    offerDone.current = offerParam;
    const tm = setTimeout(() => { setShopTier(offerParam); setShop(true); }, 350);
    return () => clearTimeout(tm);
  }, [offerParam]);
  let ShopSheet = null;
  if (MONETIZATION_ENABLED) { try { ShopSheet = require('../StorageShopSheet').default; } catch {} }

  const [busy, setBusy] = useState(null);
  const cardsRef = useRef(null);
  const cardsPositioned = useRef(false);
  const [familyOpen, setFamilyOpen] = useState(false);
  const open = (url) => { if (!url) return; try { openInApp(url, { colors, isDark }); } catch { Linking.openURL(url).catch(() => {}); } };
  const storeName = source === 'google' || (source !== 'apple' && Platform.OS === 'android') ? t('planHub.storeGoogle') : t('planHub.storeApple');

  const afterPurchase = () => {
    invalidatePlanState();
    setTimeout(() => { refresh().catch(() => {}); }, 2500);
    setTimeout(() => { refresh().catch(() => {}); }, 8000);
  };

  const manage = async () => {
    if (busy) return;
    if (source === 'stripe') {
      setBusy('manage');
      try { const r = await openStripePortal(); if (!r?.success) showAlert(t('common.error'), t('storeOnly.manageStripeFailed')); } finally { setBusy(null); }
      return;
    }
    if (!NATIVE) { showAlert(t('planHub.manageTitle'), t('planHub.manageWebBody')); return; }
    if ((source === 'apple' && Platform.OS === 'android') || (source === 'google' && Platform.OS === 'ios')) {
      showAlert(t('planHub.manageTitle'), t('planHub.manageOtherDevice', { store: storeName }));
      return;
    }
    await openStoreSubscriptions(planId);
  };

  const buy = async (target, p) => {
    if (busy) return;
    if (!NATIVE) { showAlert(t('storeOnly.title'), t('storeOnly.body')); return; }
    if (isPaid && source === 'stripe') {
      showAlert(t('planHub.stripeTitle'), t('planHub.stripeBody'), [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('planHub.manage'), onPress: manage },
      ]);
      return;
    }
    if (isPaid && Platform.OS === 'android') {
      // Play: trocar de produto exige substituir a assinatura atual → pela própria loja.
      showAlert(t('planHub.androidSwitchTitle'), t('planHub.androidSwitchBody', { plan: planDisplayName(target, t) }), [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('planHub.openPlay'), onPress: () => openStoreSubscriptions(planId) },
      ]);
      return;
    }
    setBusy('buy:' + target + ':' + p);
    try {
      await ensureStore();
      const sp = storePrice(target, p);
      if (!sp) { showAlert(t('storeOnly.unavailableTitle'), t('storeOnly.unavailableBody')); return; }
      if (sp.trial && !isPaid) {
        const ok = await new Promise((resolve) => showAlert(t('planHub.trialTitle'), t('planHub.trialBody', { price: sp.display || '' , per: p === 'annual' ? t('planHub.perYear') : t('planHub.perMonth') }), [
          { text: t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
          { text: t('planHub.continue'), onPress: () => resolve(true) },
        ]));
        if (!ok) return;
      }
      const r = await purchasePlan(target, p);
      if (r?.deferred) showAlert(t('planHub.deferredTitle'), t('planHub.deferredBody'));
      else if (r && r.success === false) showAlert(t('storeOnly.unavailableTitle'), t('storeOnly.unavailableBody'));
      else { showAlert(t('planHub.processingTitle'), t('planHub.processingBody', { plan: planDisplayName(target, t) })); afterPurchase(); }
    } catch (e) {
      const m = e?.message || '';
      if (m !== 'CANCELLED' && m !== 'ios_iap_unavailable') showAlert(t('storeOnly.unavailableTitle'), t('storeOnly.unavailableBody'));
    } finally { setBusy(null); }
  };

  const toFree = () => {
    const until = fmtDMY(appleSub?.expires_date || plan?.expiresAt);
    showAlert(t('planHub.toFreeTitle'), until ? t('planHub.toFreeBodyDate', { store: storeName, plan: planDisplayName(planId, t), date: until }) : t('planHub.toFreeBody', { store: storeName }), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('planHub.manage'), onPress: manage },
    ]);
  };

  const doRestore = async () => {
    if (busy) return;
    setBusy('restore');
    try {
      const r = await restore();
      if (r?.success) { showAlert(t('planHub.restoredTitle'), t('planHub.restoredBody')); afterPurchase(); }
      else showAlert(t('planHub.restoreNoneTitle'), t('planHub.restoreNoneBody', { store: storeName }));
    } catch { showAlert(t('common.error'), t('planHub.restoreNoneBody', { store: storeName })); }
    finally { setBusy(null); }
  };

  // ── estados sem dados ──
  if (!planSnap) {
    if (!failed) return <Skeleton g={g} />;
    return (
      <View style={[st.hero, { backgroundColor: g.cardBg, alignItems: 'center', paddingVertical: 32 }]} testID="plan-error">
        <View style={[st.stateIcon, { backgroundColor: g.fill }]}>
          {offline ? <IconWifiOff size={26} color={g.text} /> : <IconAlertCircle size={26} color={g.text} />}
        </View>
        <Text style={[st.stateTitle, { color: g.text }]}>{offline ? t('planHub.offlineTitle') : t('planHub.errorTitle')}</Text>
        <Text style={[st.stateBody, { color: g.secondary }]}>{offline ? t('planHub.offlineBody') : t('planHub.errorBody')}</Text>
        <Btn g={g} label={t('planHub.retry')} onPress={retry} busy={retrying} style={{ marginTop: 18, alignSelf: 'stretch' }} testID="plan-retry" />
      </View>
    );
  }

  // ── números ──
  const used = plan.usedBytes;
  const limit = plan.limitBytes;
  const hasUsage = used != null && limit > 0;
  const pct = hasUsage ? Math.min(100, Math.max(0, (used / limit) * 100)) : 0;
  const near = hasUsage && pct >= 80;
  const [bigNum, bigUnit] = splitNum(hasUsage ? formatStorage(used) : '—');
  const limitTxt = formatStorage(limit);
  const name = planDisplayName(planId, t);
  const renewIso = appleSub?.expires_date || plan.expiresAt;
  const renewTxt = fmtDMY(renewIso);
  const autoRenewOff = appleSub && appleSub.has_subscription && appleSub.auto_renew === false;
  const statusLine = !isPaid ? t('planHub.statusFree')
    : isFamilyMember ? t('planHub.statusFamily', { email: plan.familyAdmin })
    : plan.expiryNotice?.kind === 'grace' ? t('planExpiry.grace', { date: plan.expiryNotice.date })
    : renewTxt ? (autoRenewOff ? t('planHub.endsOn', { date: renewTxt }) : t('planHub.renewsOn', { date: renewTxt }))
    : t('planHub.statusActiveLine');
  const track = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(118,118,128,0.14)';
  const nextPlan = planId === 'free' ? 'plus' : planId === 'plus' ? 'pro' : null;
  const cat = (id) => (catalog && catalog[id]) || {};
  const sizeOf = (id) => formatGb(Number(cat(id).storage_gb) || 0);
  const fileOf = (id) => formatStorage(Number(cat(id).max_file_size) || (Number(cat(id).max_file_gb) || 0) * GB);
  const backupOf = (id) => Number(cat(id).backup_retention_days) || 0;
  const membersOf = (id) => Number(cat(id).max_members) || 1;
  const perTxt = (p) => (p === 'annual' ? t('planHub.perYear') : t('planHub.perMonth'));
  const savePlus = annualSavingsPct('plus', catalog, language);
  const savePro = annualSavingsPct('pro', catalog, language);
  const saveMax = Math.max(savePlus || 0, savePro || 0) || null;
  const anyStore = NATIVE && (!!storePrice('plus', 'monthly') || !!storePrice('pro', 'monthly'));
  const cardW = Math.min(300, Math.max(240, Math.round((Math.min(winW, 720) - 32) * 0.78)));
  const startX = Math.max(0, PLANS.indexOf(isPaid ? planId : 'plus') * (cardW + 12));

  // ── cabeçalho ──
  const hero = (
    <View style={[st.hero, { backgroundColor: g.cardBg }]} testID="plan-hero">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <PlanSeal planId={planId} size={58} ink={g.ink} onInk={g.onInk} />
        <View style={{ flex: 1, minWidth: 0 }} accessible accessibilityLabel={`${t('planHub.yourPlan')}: ${name}, ${limitTxt}. ${statusLine}`}>
          <Text style={[st.eyebrow, { color: g.secondary }]}>{t('planHub.yourPlan').toUpperCase()}</Text>
          <Text style={[st.heroName, { color: g.text }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>{name}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
            <View style={[st.pill, { backgroundColor: isPaid ? g.ink : g.fill }]}>
              <Text style={[st.pillTxt, { color: isPaid ? g.onInk : g.text }]}>{isPaid ? `${limitTxt} · ${t('planHub.active')}` : limitTxt}</Text>
            </View>
            <Text style={{ fontSize: 13, color: g.secondary, flexShrink: 1 }} numberOfLines={2}>{statusLine}</Text>
          </View>
        </View>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'flex-end', marginTop: 24 }} accessible accessibilityLabel={hasUsage ? t('planHub.usedA11y', { used: formatStorage(used), total: limitTxt, pct: Math.round(pct) }) : undefined}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: g.text }} numberOfLines={1}>
            <Text style={[st.bigNum, TAB]}>{bigNum}</Text>
            <Text style={st.bigUnit}>{bigUnit ? ' ' + bigUnit : ''}</Text>
          </Text>
          <Text style={{ fontSize: 14, color: g.secondary, marginTop: 2 }}>{t('planHub.usedOf', { total: limitTxt })}</Text>
        </View>
        {hasUsage ? <Text style={[st.pct, TAB, { color: pct >= 95 ? g.destructive : g.text }]}>{Math.round(pct)}%</Text> : null}
      </View>

      <View style={[st.bar, { backgroundColor: track }]}>
        {hasUsage && segments.length ? segments.map((sg, i) => (
          <View key={sg.key} style={{ width: `${Math.min(100, Math.max(0.8, (sg.bytes / limit) * 100))}%`, height: '100%', backgroundColor: sg.color, marginLeft: i ? 2 : 0, borderRadius: 2 }} />
        )) : (hasUsage ? <View style={{ width: `${Math.max(pct, 0.8)}%`, height: '100%', backgroundColor: g.ink }} /> : null)}
      </View>

      {segments.length ? (
        <View style={st.legend}>
          {segments.concat(hasUsage ? [{ key: '_free', label: t('storageMeter.free') || t('planHub.free'), bytes: Math.max(0, limit - used), color: track }] : []).map((sg) => (
            <View key={sg.key} style={st.legendItem} accessible accessibilityLabel={`${sg.label}: ${formatStorage(sg.bytes)}`}>
              <View style={[st.dot, { backgroundColor: sg.color, borderColor: g.ring }]} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ fontSize: 12.5, color: g.secondary }} numberOfLines={1}>{sg.label}</Text>
                <Text style={[{ fontSize: 15, fontWeight: '600', color: g.text }, TAB]} numberOfLines={1}>{formatStorage(sg.bytes)}</Text>
              </View>
            </View>
          ))}
        </View>
      ) : null}

      {near ? (
        <View style={[st.nearBox, { borderColor: pct >= 95 ? g.destructive : g.ring }]} testID="plan-near">
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
            <IconAlertTriangle size={18} color={pct >= 95 ? g.destructive : g.text} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 15, fontWeight: '700', color: g.text }}>{pct >= 100 ? t('storageOffer.fullTitle') : t('storageOffer.nearTitle')}</Text>
              <Text style={{ fontSize: 13, lineHeight: 18, color: g.secondary, marginTop: 2 }}>
                {nextPlan ? t('planHub.nearBodyNext', { plan: planDisplayName(nextPlan, t), size: sizeOf(nextPlan) }) : t('planHub.nearBodyMore')}
              </Text>
            </View>
          </View>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
            {nextPlan ? (
              <Btn g={g} label={t('storageOffer.getSize', { size: sizeOf(nextPlan) })} onPress={() => buy(nextPlan, per)} busy={busy === 'buy:' + nextPlan + ':' + per} style={{ flex: 1 }} testID="plan-near-upgrade" />
            ) : (MONETIZATION_ENABLED && ShopSheet ? (
              <Btn g={g} label={t('planHub.moreStorage')} onPress={() => { try { const r = require('../../services/storageOffers').recommendTier(plan); setShopTier(r?.tier?.id || null); } catch {} setShop(true); }} style={{ flex: 1 }} testID="plan-near-more" />
            ) : null)}
            <Btn g={g} kind="outline" label={t('storageOffer.freeSpace')} onPress={() => router.push('/manage-storage')} style={{ flex: 1 }} testID="plan-near-free" />
          </View>
        </View>
      ) : null}
    </View>
  );

  // ── paywall (Grátis) ──
  const plusPrice = planPrice('plus', 'monthly', catalog, language);
  const paywall = !isPaid ? (
    <View style={[st.paywall, { backgroundColor: g.ink }]} testID="plan-paywall">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <PlanSeal planId="plus" size={34} ink={g.onInk} onInk={g.ink} />
        <Text style={[st.eyebrow, { color: g.onInk, opacity: 0.7 }]}>{planDisplayName('plus', t).toUpperCase()}</Text>
      </View>
      <Text style={[st.payTitle, { color: g.onInk }]}>{t('planHub.paywallTitle')}</Text>
      {[
        t('planHub.pwStorage', { size: sizeOf('plus') }),
        t('planHub.pwStickers'),
        t('planHub.pwPro', { size: sizeOf('pro'), file: fileOf('pro'), days: backupOf('pro'), n: membersOf('pro') }),
      ].map((line, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 10, marginTop: i ? 10 : 14, alignItems: 'flex-start' }}>
          <View style={[st.chk, { backgroundColor: 'rgba(127,127,127,0.25)' }]}><IconCheck size={12} color={g.onInk} strokeWidth={3} /></View>
          <Text style={{ flex: 1, fontSize: 15, lineHeight: 20, color: g.onInk }}>{line}</Text>
        </View>
      ))}
      {plusPrice ? (
        <Text style={{ fontSize: 14, color: g.onInk, opacity: 0.75, marginTop: 18 }}>
          {t('planHub.fromPrice', { price: plusPrice.label, per: t('planHub.perMonth') })}
        </Text>
      ) : null}
      <Btn g={g} inverse label={t('planHub.subscribe', { plan: planDisplayName('plus', t) })} onPress={() => buy('plus', per)} busy={busy === 'buy:plus:' + per} style={{ marginTop: 12 }} testID="plan-paywall-cta" />
      <Text style={{ fontSize: 12, color: g.onInk, opacity: 0.6, marginTop: 10, textAlign: 'center' }}>
        {NATIVE ? t('planHub.cancelAnytime', { store: storeName }) : t('planHub.webStoreOnly')}
      </Text>
    </View>
  ) : null;

  // ── comparação ──
  const feat = (id) => [
    { ok: true, txt: t('planHub.fStorage', { size: sizeOf(id) }) },
    { ok: true, txt: t('planHub.fFile', { size: fileOf(id) }) },
    { ok: true, txt: t('planHub.fBackup', { n: backupOf(id) }) },
    membersOf(id) > 1 ? { ok: true, txt: t('planHub.fFamily', { n: membersOf(id) }) } : { ok: false, txt: t('planHub.fFamilyNo') },
    { ok: id !== 'free', txt: t('planHub.fStickers') },
  ];
  const cta = (id) => {
    const curRank = PLAN_RANK[planId] || 0; const r = PLAN_RANK[id] || 0;
    if (isFamilyMember) return { label: id === planId ? t('planHub.currentPlan') : t('planHub.familyManaged'), kind: 'outline', disabled: true };
    if (id === planId) {
      if (isPaid && NATIVE && annualOk && per !== curPeriod && source !== 'stripe') {
        return { label: per === 'annual' ? t('planHub.switchAnnual') : t('planHub.switchMonthly'), kind: 'solid', onPress: () => buy(id, per) };
      }
      return { label: t('planHub.currentPlan'), kind: 'outline', disabled: true };
    }
    if (id === 'free') return { label: t('planHub.toFree'), kind: 'outline', onPress: toFree };
    if (r > curRank) return { label: isPaid ? t('planHub.upgradeTo', { plan: planDisplayName(id, t) }) : t('planHub.subscribe', { plan: planDisplayName(id, t) }), kind: 'solid', onPress: () => buy(id, per) };
    return { label: t('planHub.switchTo', { plan: planDisplayName(id, t) }), kind: 'outline', onPress: () => buy(id, per) };
  };

  const compare = (
    <View style={{ marginBottom: 26 }} testID="plan-compare">
      <View style={st.secHead}>
        <Text style={[st.secTitle, { color: g.text }]} accessibilityRole="header">{isPaid ? t('planHub.comparePaid') : t('planHub.compareFree')}</Text>
      </View>
      {annualOk ? (
        <View style={[st.seg, { backgroundColor: g.fill }]} accessibilityRole="tablist">
          {['monthly', 'annual'].map((p) => {
            const on = per === p;
            return (
              <Pressable key={p} onPress={() => setPeriod(p)} accessibilityRole="tab" accessibilityState={{ selected: on }} style={[st.segItem, on && { backgroundColor: g.cardBg }]} testID={'plan-period-' + p}>
                <Text style={{ fontSize: 14, fontWeight: on ? '700' : '500', color: g.text }}>{p === 'annual' ? t('planHub.annual') : t('planHub.monthly')}</Text>
                {p === 'annual' && saveMax ? (
                  <View style={[st.saveTag, { backgroundColor: g.ink }]}><Text style={{ fontSize: 11, fontWeight: '800', color: g.onInk }}>{`-${saveMax}%`}</Text></View>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={cardW + 12}
        decelerationRate="fast"
        style={{ marginHorizontal: -16 }}
        contentContainerStyle={{ paddingHorizontal: 16, gap: 12, paddingVertical: 4 }}
        ref={cardsRef}
        contentOffset={{ x: startX, y: 0 }}
        onLayout={() => {
          // web/Android ignoram contentOffset → posiciona 1× no plano atual (ou no Plus)
          if (cardsPositioned.current || !startX) return;
          cardsPositioned.current = true;
          try { cardsRef.current && cardsRef.current.scrollTo({ x: startX, animated: false }); } catch {}
        }}
      >
        {PLANS.map((id) => {
          const current = id === planId;
          const pr = planPrice(id, per, catalog, language);
          const save = id === 'plus' ? savePlus : id === 'pro' ? savePro : null;
          const c = cta(id);
          return (
            <View
              key={id}
              style={[st.planCard, { width: cardW, backgroundColor: g.cardBg, borderColor: current ? g.ink : 'transparent' }]}
              testID={'plan-card-' + id}
              accessibilityLabel={`${planDisplayName(id, t)}${current ? ', ' + t('planHub.currentPlan') : ''}`}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <PlanSeal planId={id} size={30} ink={g.ink} onInk={g.onInk} />
                <Text style={{ flex: 1, fontSize: 16, fontWeight: '700', color: g.text }} numberOfLines={1}>{planDisplayName(id, t)}</Text>
                {current ? (
                  <View style={[st.tag, { backgroundColor: g.ink }]}><Text style={[st.tagTxt, { color: g.onInk }]}>{t('planHub.yourPlanTag').toUpperCase()}</Text></View>
                ) : null}
              </View>
              <Text style={[st.cardSize, TAB, { color: g.text }]} numberOfLines={1}>{sizeOf(id)}</Text>
              <View style={{ minHeight: 44 }}>
                {id === 'free' ? (
                  <Text style={[st.cardPrice, { color: g.text }]}>{t('planHub.freePrice')}</Text>
                ) : pr ? (
                  <>
                    <Text style={{ color: g.text }} numberOfLines={1}>
                      <Text style={[st.cardPrice, TAB]}>{pr.label}</Text>
                      <Text style={{ fontSize: 14, color: g.secondary }}>{perTxt(per)}</Text>
                    </Text>
                    {per === 'annual' && (pr.perMonthLabel || save) ? (
                      <Text style={{ fontSize: 12.5, color: g.secondary, marginTop: 2 }} numberOfLines={1}>
                        {[pr.perMonthLabel ? t('planHub.equivMonth', { price: pr.perMonthLabel }) : null, save ? t('planHub.saveN', { n: save }) : null].filter(Boolean).join(' · ')}
                      </Text>
                    ) : null}
                  </>
                ) : (
                  <Text style={{ fontSize: 13, color: g.secondary }}>{t('planHub.priceInStore')}</Text>
                )}
              </View>
              <View style={[st.hr, { backgroundColor: g.separator }]} />
              {feat(id).map((f, i) => (
                <View key={i} style={st.featRow}>
                  {f.ok ? <IconCheck size={15} color={g.text} strokeWidth={2.6} /> : <View style={{ width: 15, alignItems: 'center' }}><View style={{ width: 9, height: 1.6, backgroundColor: g.tertiary, borderRadius: 1 }} /></View>}
                  <Text style={{ flex: 1, fontSize: 14, lineHeight: 19, color: f.ok ? g.text : g.secondary }}>{f.txt}</Text>
                </View>
              ))}
              <View style={{ flex: 1 }} />
              <Btn g={g} label={c.label} kind={c.kind} onPress={c.onPress} disabled={c.disabled} busy={busy === 'buy:' + id + ':' + per} style={{ marginTop: 14 }} testID={'plan-cta-' + id} />
            </View>
          );
        })}
      </ScrollView>
      <Text style={[st.note, { color: g.header }]}>
        {!NATIVE ? t('planHub.webStoreOnly') : anyStore ? t('planHub.storeNote', { store: storeName }) : t('planHub.refPriceNote')}
      </Text>
    </View>
  );

  // ── incluído ──
  const famMax = plan.maxMembers;
  const famCount = Number(info?.family_member_count) || 0;
  const included = (
    <SettingsGroup header={t('chatyyOne.includedHeader', 'Incluído no seu plano')}>
      <SettingsRow icon={IconCloud} title={t('planHub.iStorage')} subtitle={t('chatyyOne.benefitStorageSub')} value={formatGb(Math.round(limit / GB))} />
      <SettingsRow icon={IconFile} title={t('planHub.iFile', { size: formatStorage(plan.maxFileBytes) })} subtitle={t('planHub.iFileSub')} />
      <SettingsRow icon={IconClock} title={t('planHub.iBackup')} subtitle={t('planHub.iBackupSub')} value={t('chatyyOne.benefitBackupDays', { n: plan.backupRetentionDays })} />
      {famMax > 1 && !isFamilyMember ? (
        <SettingsRow
          icon={IconUsers}
          title={t('planHub.iFamily')}
          subtitle={t('planHub.iFamilySub', { n: famCount + 1, max: famMax })}
          onPress={() => setFamilyOpen(true)}
          testID="plan-family"
        />
      ) : null}
      {isFamilyMember ? (
        <SettingsRow icon={IconUsers} title={t('planHub.iFamilyMember')} subtitle={plan.familyAdmin} />
      ) : null}
      {isPaid ? <SettingsRow icon={IconSmile} title={t('planHub.iStickers')} subtitle={t('planHub.iStickersSub')} value={t('planHub.included')} /> : null}
    </SettingsGroup>
  );

  // ── armazenamento ──
  const estSub = est && est.n > 0 ? t('planHub.freeableSub', { n: est.n, size: formatStorage(est.bytes) }) : t('manageStorage.rowSub');
  const storage = (
    <SettingsGroup header={t('planHub.storageHeader')}>
      <SettingsRow icon={IconTrash} title={t('manageStorage.title') || 'Gerenciar armazenamento'} subtitle={estSub} onPress={() => { try { router.push('/manage-storage'); } catch {} }} testID="one-free-space" />
      {MONETIZATION_ENABLED && ShopSheet && !isFamilyMember ? (
        <SettingsRow icon={IconDatabase} title={t('planHub.moreStorage')} subtitle={t('planHub.moreStorageSub')} onPress={() => { setShopTier(null); setShop(true); }} testID="plan-more-storage" />
      ) : null}
    </SettingsGroup>
  );

  // ── assinatura ──
  const curPrice = isPaid && !isFamilyMember ? planPrice(planId, curPeriod, catalog, language) : null;
  const histUrl = source === 'stripe' ? null : purchaseHistoryUrl();
  const sourceLabel = source === 'stripe' ? t('planHub.viaCard') : source === 'apple' ? t('planHub.storeApple') : source === 'google' ? t('planHub.storeGoogle') : null;
  const subscription = (
    <SettingsGroup
      header={isPaid ? t('chatyyOne.subscription') : t('planHub.purchasesHeader')}
      footer={NATIVE && !isFamilyMember ? t('planHub.autoRenewNote', { store: storeName }) : undefined}
      testID="plan-subscription"
    >
      {isPaid ? <SettingsRow title={t('planHub.sPlan')} value={isFamilyMember ? name : `${name} · ${curPeriod === 'annual' ? t('planHub.annual') : t('planHub.monthly')}`} /> : null}
      {curPrice ? <SettingsRow title={t('planHub.sPrice')} value={`${curPrice.label}${perTxt(curPeriod)}`} /> : null}
      {isPaid && !isFamilyMember && renewTxt ? <SettingsRow title={autoRenewOff ? t('planHub.sEnds') : t('planHub.sRenews')} value={renewTxt} /> : null}
      {isPaid && sourceLabel ? <SettingsRow title={t('planHub.sBilledBy')} value={sourceLabel} /> : null}
      {isPaid && !isFamilyMember ? (
        <SettingsRow icon={IconCreditCard} title={t('planHub.manage')} subtitle={source === 'apple' || source === 'google' ? storeName : undefined} onPress={manage} right={busy === 'manage' ? <ActivityIndicator size="small" color={g.secondary} /> : undefined} testID="plan-manage" />
      ) : null}
      {NATIVE ? (
        <SettingsRow icon={IconRefresh} title={t('planHub.restore')} onPress={doRestore} right={busy === 'restore' ? <ActivityIndicator size="small" color={g.secondary} /> : undefined} testID="plan-restore" />
      ) : null}
      {isPaid && !isFamilyMember && (histUrl || source === 'stripe') ? (
        <SettingsRow icon={IconReceipt} title={t('planHub.history')} subtitle={source === 'stripe' ? t('planHub.viaCard') : (source === 'apple' || source === 'google' ? storeName : undefined)} onPress={() => (source === 'stripe' ? manage() : Linking.openURL(histUrl).catch(() => {}))} testID="plan-history" />
      ) : null}
    </SettingsGroup>
  );
  const legal = (
    <View style={st.legal}>
      {[
        [t('planHub.terms'), termsUrl()],
        [t('planHub.privacy'), PRIVACY_URL],
        [t('planHub.help'), SUPPORT_URL],
      ].map(([label, url], i) => (
        <React.Fragment key={label}>
          {i ? <Text style={{ color: g.tertiary, fontSize: 13 }}>·</Text> : null}
          <Pressable onPress={() => open(url)} accessibilityRole="link" hitSlop={6}>
            <Text style={{ fontSize: 13, color: g.secondary, textDecorationLine: 'underline' }}>{label}</Text>
          </Pressable>
        </React.Fragment>
      ))}
    </View>
  );

  return (
    <>
      {offline ? (
        <View style={[st.offline, { backgroundColor: g.fill }]} testID="plan-offline">
          <IconWifiOff size={15} color={g.text} />
          <Text style={{ flex: 1, fontSize: 13, color: g.text }}>{t('planHub.offlineCached')}</Text>
        </View>
      ) : null}
      {hero}
      {paywall}
      {included}
      {MONETIZATION_ENABLED ? compare : null}
      {storage}
      {isPaid || NATIVE ? subscription : null}
      {legal}
      {MONETIZATION_ENABLED && ShopSheet ? (
        <ShopSheet
          visible={shop}
          onClose={() => { setShop(false); setShopTier(null); refresh().catch(() => {}); }}
          initialTier={shopTier}
          currentTier={String(usage?.tier || 'free')}
          usedBytes={hasUsage ? used : undefined}
          limitBytes={limit}
        />
      ) : null}
      {famMax > 1 && !isFamilyMember ? (
        <PlanFamilySheet
          visible={familyOpen}
          onClose={() => setFamilyOpen(false)}
          planName={name}
          maxMembers={famMax}
          onChanged={() => { refresh().catch(() => {}); }}
        />
      ) : null}
    </>
  );
}

const st = StyleSheet.create({
  hero: { borderRadius: 22, padding: 18, marginBottom: 20 },
  eyebrow: { fontSize: 11.5, fontWeight: '700', letterSpacing: 0.8 },
  heroName: { fontSize: 26, fontWeight: '800', letterSpacing: -0.6, marginTop: 1 },
  pill: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 10 },
  pillTxt: { fontSize: 12, fontWeight: '700' },
  bigNum: { fontSize: 42, fontWeight: '800', letterSpacing: -1.2 },
  bigUnit: { fontSize: 22, fontWeight: '700', letterSpacing: -0.3 },
  pct: { fontSize: 20, fontWeight: '700', marginBottom: 4 },
  bar: { height: 12, borderRadius: 6, overflow: 'hidden', flexDirection: 'row', marginTop: 14 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 14, rowGap: 12 },
  legendItem: { width: '50%', flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingRight: 8 },
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: 3, borderWidth: StyleSheet.hairlineWidth },
  nearBox: { marginTop: 16, borderRadius: 14, borderWidth: 1, padding: 14 },
  paywall: { borderRadius: 22, padding: 20, marginBottom: 24 },
  payTitle: { fontSize: 24, fontWeight: '800', letterSpacing: -0.5, marginTop: 14, lineHeight: 29 },
  chk: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginTop: 0 },
  btn: { minHeight: 46, borderRadius: 23, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  btnTxt: { fontSize: 15, fontWeight: '700' },
  secHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, paddingHorizontal: 2 },
  secTitle: { fontSize: 22, fontWeight: '800', letterSpacing: -0.4 },
  seg: { flexDirection: 'row', borderRadius: 12, padding: 3, marginBottom: 12 },
  segItem: { flex: 1, minHeight: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 },
  saveTag: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 7 },
  planCard: { borderRadius: 20, padding: 16, borderWidth: 1.5 },
  tag: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  tagTxt: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.5 },
  cardSize: { fontSize: 34, fontWeight: '800', letterSpacing: -1, marginTop: 14 },
  cardPrice: { fontSize: 19, fontWeight: '700' },
  hr: { height: StyleSheet.hairlineWidth, marginVertical: 12 },
  featRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, marginBottom: 8 },
  note: { fontSize: 12.5, lineHeight: 17, marginTop: 10, paddingHorizontal: 4 },
  legal: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: -8, marginBottom: 24 },
  offline: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, marginBottom: 12 },
  stateIcon: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  stateTitle: { fontSize: 18, fontWeight: '700', marginTop: 14 },
  stateBody: { fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 6, maxWidth: 320 },
});
