// /linked-devices — "Aparelhos conectados".
//
// [2026-10-21 devices-wa] Founder: "mais bonita e completa, nível WhatsApp".
// Topo = ilustração + "Conectar um aparelho" (abre a câmera: QR do Chatyy Web
// — chatyy://qr/<64 hex>, mesmo chat_qr_login_approve do scanner da caixa — ou
// QR de outro celular — chatyy://companion?token=<32 hex>) + "Vincular outro
// celular" (/companion-qr). Cartão do APARELHO ATUAL em destaque (ícone do
// tipo, nome, app + versão, SO, "Este aparelho", "Ativo agora"). Depois os
// OUTROS (ícone, nome, app/SO, IP público quando o servidor manda, "Ativo
// agora"/"Visto há X") com "Desconectar" (confirmação + Face ID), "Desconectar
// todos os outros" e um cartão curto sobre as chaves por aparelho.
// Endpoints inalterados: sessions_list / revoke_session / revoke_all_sessions /
// chat_qr_login_approve. Sem dado de local no servidor → não mostra local.
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Pressable, StyleSheet, ActivityIndicator, Alert, Platform, Modal } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { USE_NATIVE_HEADER, nativeHeaderOptions } from '../components/nativeHeader'; // [2026-10-09 native-sheets-headers]
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { IconArrowLeft, IconMonitor, IconSmartphone, IconCamera, IconUserPlus, IconX, IconRefresh, IconLock, IconKey, IconWifiOff, IconGlobe, IconLogOut, IconShield } from '../components/Icons';
import * as api from '../services/api';
import * as settingsCache from '../services/settingsCache'; // [2026-10-13 settings-instant]
import { loadDeviceRegistry, installAppStateHook } from '../services/deviceRegistry';
import FadeSlideIn from '../components/FadeSlideIn';
import UIRefreshControl from '../components/ui/RefreshControl';
import { a11yLabel } from '../utils/a11yLabel'; // [2026-10-20 a11y] rótulos dos botões só-ícone
import { detailColor } from '../constants/theme';
import { useGroupedColors, SettingsGroup, SettingsRow, SettingsIconTile, SettingsValueText, grafiteTileStyle } from '../components/settings/SettingsKit'; // [2026-10-10 settings-polish] [2026-10-17 settings-wa] listas agrupadas

// Lazy-load expo-camera so web doesn't crash if it's not bundled. Same
// pattern as profile-qr.js / chat-new.js.
let CameraView = null;
let useCameraPermissions = null;
try {
  const cam = require('expo-camera');
  CameraView = cam.CameraView;
  useCameraPermissions = cam.useCameraPermissions;
} catch {}

function _appVersion() {
  try { return String(require('expo-constants').default?.expoConfig?.version || ''); } catch { return ''; }
}

// Tipo do aparelho a partir do que o servidor manda (os / app_name / UA crua).
function deviceKind(item) {
  const os = String(item?.os || '');
  const blob = `${item?.app_name || ''} ${item?.user_agent || ''} ${item?.user_agent_raw || ''} ${item?.device_name || ''}`;
  if (/iPad/i.test(blob)) return 'tablet';
  if (/^iOS|^iPadOS/i.test(os) || /Chatyy iOS|iPhone|CFNetwork|Darwin/i.test(blob)) return /Mozilla/i.test(blob) && !/Chatyy/i.test(blob) ? 'mobile_web' : 'phone';
  if (/^Android/i.test(os) || /Chatyy Android|Android|okhttp/i.test(blob)) return /Mozilla/i.test(blob) && !/Chatyy/i.test(blob) ? 'mobile_web' : 'phone';
  if (/Windows|macOS|Linux|ChromeOS/i.test(os) || /Mozilla/i.test(blob)) return 'computer';
  return 'unknown';
}
function kindIcon(kind) {
  if (kind === 'phone' || kind === 'tablet') return IconSmartphone;
  if (kind === 'mobile_web') return IconGlobe;
  return IconMonitor;
}

// Rótulos de exibição a partir dos campos do sessions_list (device_name, os,
// app_name, ip, last_active). Nada inventado: campo ausente = linha some.
function describe(item, t) {
  const name = String(item?.device_name || '').trim() || String(item?.device_label || '').trim() || t('devices.unknownDevice', 'Dispositivo desconhecido');
  const app = String(item?.app_name || '').trim();
  const os = String(item?.os || '').trim();
  const meta = [app && name.indexOf(app) < 0 ? app : null, os && name.indexOf(os) < 0 && app.indexOf(os) < 0 ? os : null].filter(Boolean).join(' · ');
  const ip = String(item?.ip || '').trim();
  return { name, meta, ip, kind: deviceKind(item) };
}

// "Ativo agora" / "Visto há X" (ts em SEGUNDOS). last_active do servidor é
// grosso (índice de 5 min) → até 5 min conta como agora.
function seenLabel(ts, t) {
  const n = Number(ts) || 0;
  if (n <= 0) return '';
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - n));
  if (diff < 300) return t('devices.activeNowCap', 'Ativo agora');
  if (diff < 3600) return t('devices.seenMin', { n: Math.floor(diff / 60), defaultValue: `Visto há ${Math.floor(diff / 60)} min` });
  if (diff < 86400) return t('devices.seenHr', { n: Math.floor(diff / 3600), defaultValue: `Visto há ${Math.floor(diff / 3600)} h` });
  if (diff < 7 * 86400) return t('devices.seenDays', { n: Math.floor(diff / 86400), defaultValue: `Visto há ${Math.floor(diff / 86400)} d` });
  let d = '';
  try { d = new Date(n * 1000).toLocaleDateString(); } catch { d = ''; }
  return d ? t('devices.seenOn', { date: d, defaultValue: `Visto em ${d}` }) : '';
}

export default function LinkedDevicesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const g = useGroupedColors();
  const accent = detailColor(isDark) || g.ink;
  const { t } = useLanguage();
  const { user } = useAuth();

  // [2026-10-13 settings-instant] última lista de sessões salva no aparelho
  // (por conta) → abre na hora; esqueleto só na 1ª vez na vida.
  const [sessions, setSessions] = useState(() => { const c = settingsCache.peek('sessions'); return Array.isArray(c) ? c : []; });
  const [loading, setLoading] = useState(() => settingsCache.peek('sessions') == null);
  // [2026-10-21] falha de rede sem cache ≠ "Apenas este dispositivo".
  const [loadFailed, setLoadFailed] = useState(false);
  const [revoking, setRevoking] = useState(null);
  const [revokingAll, setRevokingAll] = useState(false);
  // Scanner (QR do Chatyy Web ou de outro celular).
  const [scanOpen, setScanOpen] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const _useCamPerm = useCameraPermissions || (() => [null, () => {}]);
  const [permission, requestPermission] = _useCamPerm();

  const load = useCallback(async () => {
    if (settingsCache.peek('sessions') == null) setLoading(true);
    setLoadFailed(false);
    let _ok = false;
    // sessions_list requires auth; on a cold mount the auth can lag a tick
    // behind the screen. Web authenticates via cookie (no bearer) → ready
    // once the AuthContext user is hydrated. Never fire an unauthed request.
    const _authReady = () => (typeof api.getAuthToken === 'function' && api.getAuthToken()) || !!user?.email;
    for (let w = 0; w < 20 && !_authReady(); w++) {
      await new Promise((res) => setTimeout(res, 100));
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (!_authReady()) { await new Promise((res) => setTimeout(res, 400 * (attempt + 1))); continue; }
        const r = await api.apiCall('sessions_list');
        if (r?.success && r.data) {
          const list = Array.isArray(r.data) ? r.data : (r.data.sessions || []);
          setSessions(list);
          try { settingsCache.put('sessions', list); } catch {}
          _ok = true;
          break;
        }
        if (r && r.success === false && attempt < 2) {
          await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
          continue;
        }
        break;
      } catch (e) {
        if (attempt < 2) { await new Promise((res) => setTimeout(res, 400 * (attempt + 1))); continue; }
        console.warn('[devices] load:', e);
      }
    }
    setLoadFailed(!_ok && settingsCache.peek('sessions') == null);
    setLoading(false);
  }, [user?.email]);

  useEffect(() => { load(); }, [load]);

  // Registro de chaves por aparelho (SQLite-first): aquece na montagem +
  // gancho AppState=active idempotente.
  useEffect(() => {
    installAppStateHook();
    loadDeviceRegistry({ force: true }).catch(() => {});
  }, []);

  const _notify = (title, body) => {
    if (Platform.OS === 'web') { try { window.alert(body ? `${title}\n\n${body}` : title); } catch {} return; }
    try { Alert.alert(title, body || undefined); } catch {}
  };

  // QR lido: Chatyy Web (chatyy://qr/<64 hex> | https://chatyy.com.br/qr/<64 hex>)
  // → chat_qr_login_approve (mesmo do scanner da caixa); outro celular
  // (chatyy://companion?token=<32 hex>) → approve com device_kind 'mobile'.
  const handleScanned = ({ data }) => {
    if (scanned || scanBusy || typeof data !== 'string') return;
    const raw = data.trim();
    const webM = raw.match(/^(?:chatyy:\/\/qr\/|https?:\/\/(?:www\.)?chatyy\.com\.br\/qr\/)([a-f0-9]{64})\b/i);
    const isCompanion = raw.startsWith('chatyy://companion');
    if (!webM && !isCompanion) return; // QR de contato etc.: ignora em silêncio
    setScanned(true);
    setScanBusy(true);
    (async () => {
      try {
        if (webM) {
          const r = await api.qrConfirm(webM[1]);
          if (!r?.success) throw new Error(r?.message || 'approve_failed');
          setScanOpen(false);
          _notify(t('devices.webLinkedTitle', 'Aparelho conectado'), t('devices.webLinkedBody', 'O Chatyy Web já está aberto no outro aparelho.'));
        } else {
          const q = raw.split('?')[1] || '';
          const token = new URLSearchParams(q).get('token') || '';
          if (!token || !/^[a-f0-9]{32}$/.test(token)) throw new Error('invalid token');
          const r = await api.chatQrLoginApprove(token, 'mobile');
          if (!r?.success) throw new Error(r?.message || 'approve_failed');
          setScanOpen(false);
          _notify(t('devices.companionLinkedTitle', 'Celular vinculado'), t('devices.companionLinkedBody', 'O outro celular já está conectado.'));
        }
        load();
      } catch (e) {
        // [2026-10-21] nunca mostrar código interno ('invalid token'/'approve_failed'/'offline').
        const _m = String(e?.message || '');
        const errBody = /invalid token/i.test(_m)
          ? t('devices.scanInvalid', 'Este QR não é de vincular celular. Gere um novo no outro aparelho.')
          : (!_m || /approve_failed|offline|network|fetch|timeout|expired|invalid|^failed$/i.test(_m))
            ? t('devices.scanFailed', 'Não foi possível vincular. Tente de novo.')
            : _m;
        _notify(t('common.error', 'Erro'), errBody);
      } finally {
        setScanBusy(false);
        setTimeout(() => setScanned(false), 800);
      }
    })();
  };

  const openScanner = async () => {
    if (Platform.OS === 'web' || !CameraView) {
      _notify(t('common.notice', 'Aviso'), t('profile.qrScanWebUnavailable', 'Use o aplicativo móvel pra escanear'));
      return;
    }
    if (!permission?.granted) {
      const r = await requestPermission?.();
      if (!r?.granted) return;
    }
    setScanned(false);
    setScanOpen(true);
  };

  function _revokeFailed(e) {
    const msg = (e && e.message) || t('devices.revokeFailed', 'Não foi possível desconectar. Tente de novo.');
    _notify(t('common.error', 'Erro'), msg);
  }

  const _confirm = (title, body, okLabel, cb) => {
    if (Platform.OS === 'web') { try { if (window.confirm(`${title}\n\n${body}`)) cb(); } catch {} return; }
    Alert.alert(title, body, [
      { text: t('common.cancel', 'Cancelar'), style: 'cancel' },
      { text: okLabel, style: 'destructive', onPress: cb },
    ]);
  };

  const revoke = (session, name) => {
    _confirm(
      t('devices.disconnectTitle', { name, defaultValue: `Desconectar ${name}?` }),
      t('devices.disconnectBody', 'Esse aparelho sai da sua conta na hora. Para usar de novo, será preciso entrar outra vez.'),
      t('devices.disconnect', 'Desconectar'),
      async () => {
        // Face ID / código antes de algo destrutivo (celular desbloqueado na mão errada).
        try {
          const { confirmWithBiometric } = require('../services/biometricGate');
          const ok = await confirmWithBiometric({ reason: t('devices.disconnect', 'Desconectar') });
          if (!ok) return;
        } catch {}
        setRevoking(session.id || session.token_hash);
        try {
          const r = await api.apiCall('revoke_session', { session_id: session.id || session.token_hash }, 'POST');
          // [2026-10-18 wa-parity] falha (success:false) era muda.
          if (r && r.success === false) throw new Error(r.message || r.error || '');
          await load();
        } catch (e) {
          console.warn('[devices] revoke:', e);
          _revokeFailed(e);
        }
        setRevoking(null);
      },
    );
  };

  const revokeAll = () => {
    _confirm(
      t('devices.disconnectAllTitle', 'Desconectar todos os outros?'),
      t('devices.disconnectAllBody', 'Todos os aparelhos, menos este, saem da sua conta na hora.'),
      t('devices.disconnectAllShort', 'Desconectar todos'),
      async () => {
        try {
          const { confirmWithBiometric } = require('../services/biometricGate');
          const ok = await confirmWithBiometric({ reason: t('devices.disconnectAll', 'Desconectar todos os outros') });
          if (!ok) return;
        } catch {}
        setRevokingAll(true);
        try {
          const r = await api.apiCall('revoke_all_sessions', {}, 'POST');
          if (r && r.success === false) throw new Error(r.message || r.error || '');
          await load();
        } catch (e) { console.warn('[devices] revokeAll:', e); _revokeFailed(e); }
        setRevokingAll(false);
      },
    );
  };

  const [pulling, setPulling] = useState(false);
  const onPull = () => { setPulling(true); Promise.resolve(load()).finally(() => setPulling(false)); };

  const current = sessions.find((s) => s && s.is_current) || null;
  const others = sessions.filter((s) => s && !s.is_current);
  // Web (cookie, sem bearer) nunca vem como is_current → cartão local.
  const localCurrent = (() => {
    const v = _appVersion();
    if (Platform.OS === 'ios') return { name: 'iPhone', meta: [`Chatyy iOS${v ? ' ' + v : ''}`, `iOS ${String(Platform.Version || '')}`.trim()].join(' · '), kind: 'phone', ip: '' };
    if (Platform.OS === 'android') return { name: 'Android', meta: [`Chatyy Android${v ? ' ' + v : ''}`, `Android ${String(Platform.Version || '')}`.trim()].join(' · '), kind: 'phone', ip: '' };
    return { name: t('devices.webBrowser', 'Navegador'), meta: 'Chatyy Web', kind: 'computer', ip: '' };
  })();
  const curBase = current ? describe(current, t) : localCurrent;
  // Versão do app do aparelho atual: completa com a local quando o servidor
  // (push_tokens) não manda nenhuma.
  const _lv = current && Platform.OS !== 'web' && !/\d/.test(curBase.meta) ? _appVersion() : '';
  const cur = _lv ? { ...curBase, meta: curBase.meta ? `${curBase.meta} · ${_lv}` : _lv } : curBase;

  const otherRow = (item, idx) => {
    const d = describe(item, t);
    const sid = item.id || item.token_hash;
    const busy = revoking === sid;
    const seen = seenLabel(item.last_active || item.last_seen_at || item.created_at, t);
    const activeNow = seen === t('devices.activeNowCap', 'Ativo agora');
    return (
      <Pressable
        key={String(sid || idx)}
        onPress={busy || revokingAll ? undefined : () => revoke(item, d.name)}
        accessibilityRole="button"
        accessibilityLabel={`${d.name}${d.meta ? ', ' + d.meta : ''}${seen ? ', ' + seen : ''}. ${t('devices.disconnect', 'Desconectar')}`}
        style={({ pressed }) => [st.devRow, pressed && { backgroundColor: g.fill }]}
        testID={`devices-row-${idx}`}
      >
        <SettingsIconTile Icon={kindIcon(d.kind)} size={40} />
        <View style={st.devText}>
          <Text style={[st.devName, { color: g.text }]} numberOfLines={1}>{d.name}</Text>
          {!!d.meta && <Text style={[st.devMeta, { color: g.secondary }]} numberOfLines={1}>{d.meta}</Text>}
          <View style={st.seenRow}>
            {activeNow ? <View style={[st.dot, { backgroundColor: accent }]} /> : null}
            {!!seen && <Text style={[st.devMeta, { color: activeNow ? g.text : g.secondary }]} numberOfLines={1}>{seen}</Text>}
            {!!d.ip && <Text style={[st.devMeta, { color: g.tertiary }]} numberOfLines={1}>{`${seen ? '  ·  ' : ''}IP ${d.ip}`}</Text>}
          </View>
        </View>
        {busy
          ? <ActivityIndicator color={g.secondary} size="small" />
          : <SettingsValueText color={g.destructive}>{t('devices.disconnect', 'Desconectar')}</SettingsValueText>}
      </Pressable>
    );
  };

  const skeleton = (
    <SettingsGroup header={t('devices.othersHeader', 'Outros aparelhos')}>
      {[0, 1].map((i) => (
        <View key={i} style={st.devRow} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <View style={[st.skelTile, { backgroundColor: g.fill }]} />
          <View style={st.devText}>
            <View style={[st.skelLine, { width: '55%', backgroundColor: g.fill }]} />
            <View style={[st.skelLine, { width: '35%', marginTop: 8, backgroundColor: g.fill }]} />
          </View>
        </View>
      ))}
    </SettingsGroup>
  );

  return (
    <View style={[st.container, { backgroundColor: g.pageBg, paddingTop: USE_NATIVE_HEADER ? 0 : insets.top }]}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({
          colors, isDark, title: t('devices.title'),
          headerStyle: { backgroundColor: g.pageBg },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: g.pageBg },
        })} />
      ) : (
        <View style={[st.header, { backgroundColor: g.pageBg, paddingTop: 10, borderBottomColor: g.separator }]}>
          <TouchableOpacity onPress={() => router.back()} style={st.backBtn} accessibilityRole="button" accessibilityLabel={t('common.back') || 'Voltar'}>
            <IconArrowLeft size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={[st.title, { color: colors.text }]} numberOfLines={1}>{t('devices.title') || 'Linked devices'}</Text>
        </View>
      )}

      <ScrollView
        style={st.flex1}
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={[st.scroll, { paddingBottom: 32 + insets.bottom }]}
        refreshControl={Platform.OS === 'web' ? undefined : <UIRefreshControl refreshing={pulling} onRefresh={onPull} tintColor={g.secondary} />}
      >
        <FadeSlideIn>
          {/* Topo: ilustração + Conectar um aparelho */}
          <View style={[st.heroCard, { backgroundColor: g.cardBg }, g.cardShadow]}>
            <View style={st.heroArt} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <View style={[st.heroArtBack, grafiteTileStyle(isDark, 64), { borderRadius: 18, backgroundColor: isDark ? '#3A3A3C' : '#2C2C2E' }]}>
                <IconMonitor size={34} color="#FFFFFF" />
              </View>
              <View style={[st.heroArtFront, grafiteTileStyle(isDark, 48), { borderRadius: 14, backgroundColor: isDark ? '#48484A' : '#3A3A3C', borderColor: g.cardBg }]}>
                <IconSmartphone size={24} color="#FFFFFF" />
              </View>
            </View>
            <Text style={[st.heroTitle, { color: g.text }]} accessibilityRole="header">
              {t('devices.connectHeroTitle', 'Use o Chatyy em outros aparelhos')}
            </Text>
            <Text style={[st.heroSub, { color: g.secondary }]}>
              {t('devices.connectHeroSub', 'Abra o Chatyy Web no computador e escaneie o QR, ou vincule outro celular à sua conta.')}
            </Text>
            <Pressable
              onPress={openScanner}
              accessibilityRole="button"
              testID="devices-scan"
              style={({ pressed }) => [st.cta, { backgroundColor: g.ink, opacity: pressed ? 0.85 : 1 }]}
            >
              <IconCamera size={18} color={g.onInk} />
              <Text style={[st.ctaText, { color: g.onInk }]}>{t('devices.connectDevice', 'Conectar um aparelho')}</Text>
            </Pressable>
            <Pressable
              onPress={() => router.push('/companion-qr')}
              accessibilityRole="button"
              testID="devices-link-phone"
              hitSlop={6}
              style={({ pressed }) => [st.ctaGhost, { opacity: pressed ? 0.6 : 1 }]}
            >
              <IconUserPlus size={16} color={g.text} />
              <Text style={[st.ctaGhostText, { color: g.text }]}>{t('devices.linkAnotherPhone', 'Vincular outro celular')}</Text>
            </Pressable>
          </View>

          {/* Este aparelho */}
          <SettingsGroup header={t('devices.thisDevice', 'Este dispositivo')}>
            <View style={st.curRow} accessible accessibilityLabel={`${cur.name}${cur.meta ? ', ' + cur.meta : ''}, ${t('devices.thisDevice', 'Este dispositivo')}`}>
              <SettingsIconTile Icon={kindIcon(cur.kind)} size={48} />
              <View style={st.devText}>
                <Text style={[st.curName, { color: g.text }]} numberOfLines={1}>{cur.name}</Text>
                {!!cur.meta && <Text style={[st.devMeta, { color: g.secondary }]} numberOfLines={2}>{cur.meta}</Text>}
                <View style={st.pillRow}>
                  <View style={[st.pill, { borderColor: accent }]}>
                    <View style={[st.dot, { backgroundColor: accent, marginRight: 6 }]} />
                    <Text style={[st.pillText, { color: g.text }]}>{t('devices.activeNowCap', 'Ativo agora')}</Text>
                  </View>
                  {!!cur.ip && <Text style={[st.devMeta, { color: g.tertiary, marginLeft: 10 }]} numberOfLines={1}>{`IP ${cur.ip}`}</Text>}
                </View>
              </View>
            </View>
          </SettingsGroup>

          {/* Outros aparelhos */}
          {loading ? skeleton : (loadFailed && sessions.length === 0) ? (
            <View style={[st.stateCard, { backgroundColor: g.cardBg }, g.cardShadow]}>
              <SettingsIconTile Icon={IconWifiOff} size={48} muted />
              <Text style={[st.stateTitle, { color: g.text }]}>{t('devices.loadFailedTitle', 'Sem conexão')}</Text>
              <Text style={[st.stateText, { color: g.secondary }]}>{t('devices.loadFailed', 'Não foi possível carregar os aparelhos. Verifique a conexão.')}</Text>
              <Pressable onPress={load} accessibilityRole="button" testID="devices-retry" style={({ pressed }) => [st.retryBtn, { backgroundColor: g.fill, opacity: pressed ? 0.7 : 1 }]}>
                <IconRefresh size={16} color={g.text} />
                <Text style={[st.retryText, { color: g.text }]}>{t('common.tryAgain', 'Tentar de novo')}</Text>
              </Pressable>
            </View>
          ) : others.length === 0 ? (
            <View style={[st.stateCard, { backgroundColor: g.cardBg }, g.cardShadow]}>
              <SettingsIconTile Icon={IconShield} size={48} muted />
              <Text style={[st.stateTitle, { color: g.text }]}>{t('devices.noOthersTitle', 'Nenhum outro aparelho')}</Text>
              <Text style={[st.stateText, { color: g.secondary }]}>{t('devices.noOthersText', 'Sua conta só está aberta neste aparelho. Quando você conectar outro, ele aparece aqui.')}</Text>
            </View>
          ) : (
            <SettingsGroup header={t('devices.othersHeader', 'Outros aparelhos')} footer={t('devices.othersFooter', 'Toque num aparelho para desconectá-lo. Não reconhece algum? Desconecte e troque sua senha.')} inset={70}>
              {others.map(otherRow)}
            </SettingsGroup>
          )}
          {!loading && others.length > 0 && (
            <SettingsGroup>
              <SettingsRow
                icon={IconLogOut}
                title={t('devices.disconnectAll', 'Desconectar todos os outros')}
                destructive
                onPress={revokingAll ? undefined : revokeAll}
                right={revokingAll ? <ActivityIndicator color={g.secondary} size="small" /> : undefined}
                testID="devices-signout-all"
              />
            </SettingsGroup>
          )}

          {/* Criptografia: chaves por aparelho (texto curto, sem prometer o que não está ligado) */}
          <SettingsGroup header={t('devices.keysHeader', 'Criptografia')} inset={62}>
            <View style={st.infoRow}>
              <SettingsIconTile Icon={IconKey} size={32} />
              <View style={st.infoText}>
                <Text style={[st.infoTitle, { color: g.text }]}>{t('devices.keysTitle', 'Cada aparelho tem as próprias chaves')}</Text>
                <Text style={[st.infoBody, { color: g.secondary }]}>{t('devices.keysBody', 'Nas conversas com criptografia de ponta a ponta, as mensagens são cifradas para cada aparelho conectado. Um aparelho desconectado deixa de receber as mensagens novas.')}</Text>
              </View>
            </View>
            <View style={st.infoRow}>
              <SettingsIconTile Icon={IconLock} size={32} />
              <View style={st.infoText}>
                <Text style={[st.infoTitle, { color: g.text }]}>{t('devices.keysSafeTitle', 'Só você conecta aparelhos')}</Text>
                <Text style={[st.infoBody, { color: g.secondary }]}>{t('devices.keysSafeBody', 'Um aparelho novo só entra quando você escaneia o QR dele com este celular.')}</Text>
              </View>
            </View>
          </SettingsGroup>
        </FadeSlideIn>
      </ScrollView>

      {/* Câmera do "Conectar um aparelho" (rota em cartão → Modal único, nunca sobre outro). */}
      <Modal visible={scanOpen} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setScanOpen(false)}>
        <View style={st.scanRoot}>
          <View style={[st.scanHeader, { paddingTop: Math.max(insets.top, 20) + 10 }]}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={a11yLabel('common.close', 'Fechar')} onPress={() => setScanOpen(false)} style={st.backBtn}>
              <IconX size={24} color="#fff" />
            </TouchableOpacity>
            <Text style={st.scanTitle}>{t('devices.connectDevice', 'Conectar um aparelho')}</Text>
          </View>
          {Platform.OS !== 'web' && CameraView && permission?.granted ? (
            <View style={st.cameraBox}>
              <CameraView
                style={StyleSheet.absoluteFill}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={scanned ? undefined : handleScanned}
              />
              <View style={st.scanFrame} />
              {scanBusy && (
                <View style={st.scanBusy}>
                  <ActivityIndicator color="#fff" size="large" />
                </View>
              )}
            </View>
          ) : (
            <View style={st.scanFallback}>
              <IconCamera size={48} color="#fff" />
              <Text style={st.scanFallbackText}>{t('profile.qrCameraNeeded', 'Permissão de câmera necessária')}</Text>
            </View>
          )}
          <Text style={[st.scanHint, { paddingBottom: 16 + insets.bottom }]}>
            {t('devices.scanHintAny', 'Aponte para o QR do Chatyy Web no computador ou do outro celular.')}
          </Text>
        </View>
      </Modal>
    </View>
  );
}

const st = StyleSheet.create({
  container: { flex: 1 },
  flex1: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, fontSize: 20, fontWeight: '700', marginLeft: 8 },
  scroll: { paddingHorizontal: 16, paddingTop: 8, width: '100%', maxWidth: 720, alignSelf: 'center' },
  heroCard: { borderRadius: 22, paddingTop: 24, paddingBottom: 16, paddingHorizontal: 20, marginBottom: 24, alignItems: 'center' },
  heroArt: { width: 104, height: 80, marginBottom: 14 },
  heroArtBack: { position: 'absolute', left: 8, top: 0, width: 64, height: 64, alignItems: 'center', justifyContent: 'center' },
  heroArtFront: { position: 'absolute', right: 6, bottom: 0, width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderWidth: 3 },
  heroTitle: { fontSize: 20, fontWeight: '700', letterSpacing: -0.4, textAlign: 'center' },
  heroSub: { fontSize: 14.5, lineHeight: 20, textAlign: 'center', marginTop: 6, maxWidth: 380 },
  cta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, alignSelf: 'stretch', minHeight: 48, borderRadius: 14, marginTop: 18 },
  ctaText: { fontSize: 16, fontWeight: '600', letterSpacing: -0.2 },
  ctaGhost: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 40, marginTop: 6, paddingHorizontal: 12 },
  ctaGhostText: { fontSize: 15, fontWeight: '600' },
  curRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14 },
  curName: { fontSize: 17, fontWeight: '600', letterSpacing: -0.3 },
  devRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, minHeight: 64 },
  devText: { flex: 1, minWidth: 0, marginLeft: 14, marginRight: 10 },
  devName: { fontSize: 16, fontWeight: '500', letterSpacing: -0.2 },
  devMeta: { fontSize: 13.5, lineHeight: 18, marginTop: 1 },
  seenRow: { flexDirection: 'row', alignItems: 'center', marginTop: 1, flexWrap: 'nowrap' },
  dot: { width: 7, height: 7, borderRadius: 4, marginRight: 5 },
  pillRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  pill: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999, borderWidth: 1 },
  pillText: { fontSize: 13, fontWeight: '600' },
  skelTile: { width: 40, height: 40, borderRadius: 10 },
  skelLine: { height: 11, borderRadius: 6 },
  stateCard: { borderRadius: 22, alignItems: 'center', paddingVertical: 24, paddingHorizontal: 24, marginBottom: 24 },
  stateTitle: { fontSize: 16.5, fontWeight: '600', textAlign: 'center', marginTop: 12 },
  stateText: { fontSize: 14, lineHeight: 19, textAlign: 'center', marginTop: 4, maxWidth: 340 },
  retryBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, minHeight: 40, borderRadius: 12, marginTop: 14 },
  retryText: { fontSize: 15, fontWeight: '600' },
  infoRow: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 16, paddingVertical: 13 },
  infoText: { flex: 1, minWidth: 0, marginLeft: 14 },
  infoTitle: { fontSize: 15.5, fontWeight: '600', letterSpacing: -0.2 },
  infoBody: { fontSize: 13.5, lineHeight: 19, marginTop: 2 },
  scanRoot: { flex: 1, backgroundColor: '#000' },
  scanHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 50, paddingBottom: 14 },
  scanTitle: { color: '#fff', fontSize: 18, fontWeight: '700', marginLeft: 8 },
  cameraBox: { flex: 1, backgroundColor: '#000' },
  scanFrame: { position: 'absolute', top: '20%', left: '15%', right: '15%', bottom: '20%', borderRadius: 18, borderWidth: 2, borderColor: '#fff' },
  scanBusy: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center' },
  scanFallback: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 },
  scanFallbackText: { color: '#fff', fontSize: 14, paddingHorizontal: 32, textAlign: 'center' },
  scanHint: { color: '#fff', textAlign: 'center', fontSize: 13, padding: 16 },
});
