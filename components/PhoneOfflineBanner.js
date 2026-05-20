/**
 * Stage 6 — "Phone offline" banner.
 *
 * Shown at the top of the web layout when relayClient surfaced a
 * phone_offline / relay_timeout / no_paired_device error from the WS relay
 * path, meaning the data on screen is being served from IndexedDB cache
 * (services/localDb.web.js) instead of the phone's live SQLite.
 *
 * The flag itself lives at globalThis.__chatyy_phone_offline, set inside
 * services/api.js wherever a relay request fails. This component polls the
 * flag once per second — cheap, and avoids wiring a full event emitter for
 * what is effectively a single boolean shared between api.js and the UI.
 *
 * Web-only. On native this returns null because the phone IS the source of
 * truth — there's no "phone offline" state distinct from "we're offline".
 */
import React, { useEffect, useState } from 'react';
import { Platform, View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { IconX, IconWifiOff } from './Icons';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';

const POLL_MS = 1000;

export default function PhoneOfflineBanner() {
  // Hooks must be called unconditionally — running them on native is a
  // cheap no-op since the effect early-returns. The render path below
  // returns null for native.
  const [visible, setVisible] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState(null);
  const { t } = useLanguage();

  // [STAGE-D 2026-05-20] "Sincronizar agora" handler.
  // 1) POST chat_wake_my_phone → backend sends silent FCM/APNs to user's
  //    paired devices, waking the phone briefly so the WS relay finds it.
  // 2) Clear the phone_offline flag locally + reload window so the next
  //    chatConversations() call tries the relay fresh.
  const handleSync = React.useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncStatus(null);
    try {
      const r = await api.apiCall('chat_wake_my_phone', {});
      const sent = Number(r?.data?.sent || 0);
      if (sent > 0) {
        setSyncStatus(t?.('sync.phoneWakeSent') || 'Acordando celular…');
        // Give the phone ~3s to wake + respond on WS, then clear flag and
        // let the next data fetch try relay again. UI is reactive to
        // __chatyy_phone_offline via the 1s poll above.
        setTimeout(() => {
          try { globalThis.__chatyy_phone_offline = false; } catch {}
          setSyncStatus(null);
          setSyncing(false);
        }, 3000);
      } else {
        const reason = r?.data?.reason || '';
        if (reason === 'throttled') {
          setSyncStatus(t?.('sync.throttled') || 'Aguarde uns segundos pra tentar de novo');
        } else if (reason === 'no_tokens') {
          setSyncStatus(t?.('sync.noPairedPhone') || 'Nenhum celular pareado');
        } else {
          setSyncStatus(t?.('sync.couldNotWake') || 'Não foi possível acordar o celular');
        }
        setTimeout(() => { setSyncStatus(null); setSyncing(false); }, 3000);
      }
    } catch (e) {
      setSyncStatus(t?.('sync.couldNotWake') || 'Não foi possível acordar o celular');
      setTimeout(() => { setSyncStatus(null); setSyncing(false); }, 3000);
    }
  }, [syncing, t]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    let mounted = true;
    const tick = () => {
      if (!mounted) return;
      let flag = false;
      try { flag = !!globalThis.__chatyy_phone_offline; } catch {}
      // Banner dedup: if the BROWSER itself is offline, the root-level
      // <OfflineNotice/> already paints a yellow "Sem conexão · Tentar"
      // bar. Painting "Celular offline" on top of that stacks two yellow
      // banners on the same line — looks broken and the user has no idea
      // which is which. Suppress this one when the browser is offline;
      // OfflineNotice's message is the higher-priority signal in that case.
      try {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          flag = false;
        }
      } catch {}
      setVisible(flag);
      // Auto-clear dismissed state once the flag flips back to false so a
      // subsequent re-occurrence shows the banner again.
      if (!flag) setDismissed(false);
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    // Also re-evaluate on the browser online/offline events so the dedup
    // reacts instantly instead of waiting for the 1s poll tick.
    let onOnline = null;
    let onOffline = null;
    try {
      onOnline = () => tick();
      onOffline = () => tick();
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
    } catch {}
    return () => {
      mounted = false;
      clearInterval(id);
      try {
        if (onOnline) window.removeEventListener('online', onOnline);
        if (onOffline) window.removeEventListener('offline', onOffline);
      } catch {}
    };
  }, []);

  if (Platform.OS !== 'web') return null;
  if (!visible || dismissed) return null;

  return (
    <View style={s.bar} accessibilityLiveRegion="polite" accessibilityRole="alert">
      {IconWifiOff ? <IconWifiOff size={16} color="#7c5e00" /> : null}
      <Text style={s.text} numberOfLines={2}>
        {syncStatus || (t?.('offline.phoneOffline') || 'Celular offline — mostrando dados em cache. Conecte o celular pra ver as conversas mais recentes.')}
      </Text>
      <TouchableOpacity
        onPress={handleSync}
        disabled={syncing}
        style={[s.syncBtn, syncing && { opacity: 0.6 }]}
        accessibilityLabel={t?.('sync.syncNow') || 'Sincronizar agora'}
        accessibilityRole="button"
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        {syncing
          ? <ActivityIndicator size="small" color="#5a4500" />
          : <Text style={s.syncBtnText}>{t?.('sync.syncNow') || 'Sincronizar agora'}</Text>}
      </TouchableOpacity>
      <TouchableOpacity
        onPress={() => setDismissed(true)}
        style={s.closeBtn}
        accessibilityLabel={t?.('common.dismiss') || 'Fechar aviso'}
        accessibilityRole="button"
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        {IconX ? <IconX size={14} color="#7c5e00" /> : <Text style={{ color: '#7c5e00', fontSize: 14 }}>x</Text>}
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#fff4c2',
    borderBottomWidth: 1,
    borderBottomColor: '#e5d27a',
    paddingHorizontal: 14,
    paddingVertical: 8,
    width: '100%',
    zIndex: 9999,
  },
  text: {
    flex: 1,
    fontSize: 13,
    color: '#5a4500',
    fontWeight: '500',
  },
  syncBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: '#ffd966',
    borderWidth: 1,
    borderColor: '#d4b237',
    marginRight: 4,
  },
  syncBtnText: {
    color: '#5a4500',
    fontSize: 12,
    fontWeight: '600',
  },
  closeBtn: {
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
});
