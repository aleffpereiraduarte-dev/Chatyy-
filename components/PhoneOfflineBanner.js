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
import { Platform, View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { IconX, IconWifiOff } from './Icons';
import { useLanguage } from '../context/LanguageContext';

const POLL_MS = 1000;

export default function PhoneOfflineBanner() {
  // Hooks must be called unconditionally — running them on native is a
  // cheap no-op since the effect early-returns. The render path below
  // returns null for native.
  const [visible, setVisible] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const { t } = useLanguage();

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
        {t?.('offline.phoneOffline') || 'Celular offline — mostrando dados em cache. Conecte o celular pra ver as conversas mais recentes.'}
      </Text>
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
  closeBtn: {
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
});
