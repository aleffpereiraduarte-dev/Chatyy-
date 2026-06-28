/**
 * PWAPrompts — web-only install banner + update available banner.
 *
 * Two flows:
 * 1) Install: browser fires `beforeinstallprompt`, we save the event and
 *    show a "Instalar Chatyy" toast. Tap → trigger native install dialog.
 * 2) Update: ServiceWorker registration fires `updatefound`. When the new
 *    SW reaches `installed` state and there's already a controller (= old
 *    SW running), show "Atualização disponível, toque para aplicar".
 *    Tap → postMessage SKIP_WAITING + reload.
 *
 * Tracks dismissals in localStorage so we don't nag.
 */
import React, { useEffect, useState, useRef } from 'react';
import { View, Text, TouchableOpacity, Animated, Platform, StyleSheet, Pressable } from 'react-native';

const INSTALL_DISMISS_COOLDOWN = 7 * 24 * 3600 * 1000; // 7 days

// These flags used to be global, so User A dismissing the install banner (or
// the browser marking "already installed") suppressed it for User B on the
// same browser after an account switch. Scope them to the active account email
// (localStorage `mail_active_account`, the same key services/api.js uses) so
// each user gets their own dismissal state. `appinstalled` is genuinely a
// per-browser/per-device fact, so we ALSO keep a device-global copy of the
// installed flag — once the PWA is installed nobody should see the install
// banner regardless of which account is active.
const PWA_KEY_PREFIX = 'pwa_';
function _activeEmail() {
  try {
    if (typeof localStorage === 'undefined') return '';
    return localStorage.getItem('mail_active_account') || '';
  } catch { return ''; }
}
function installDismissKey() {
  const e = _activeEmail();
  return e ? `${PWA_KEY_PREFIX}install_dismissed_at:${e}` : `${PWA_KEY_PREFIX}install_dismissed_at`;
}
function alreadyInstalledKey() {
  const e = _activeEmail();
  return e ? `${PWA_KEY_PREFIX}already_installed:${e}` : `${PWA_KEY_PREFIX}already_installed`;
}
// Device-global installed flag (not per-user): once installed, the install
// banner is moot for everyone on this browser.
const DEVICE_INSTALLED_KEY = `${PWA_KEY_PREFIX}device_installed`;

export default function PWAPrompts({ colors, isDark, t }) {
  const [installPromptEvent, setInstallPromptEvent] = useState(null);
  const [showUpdate, setShowUpdate] = useState(false);
  const updateRegRef = useRef(null);
  const slideAnim = useRef(new Animated.Value(0)).current;

  // Web-only: register handlers for install + update events.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;

    // ── Install flow ──
    const onBeforeInstall = (e) => {
      try { e.preventDefault(); } catch {}
      // Skip if this device already has it installed, or THIS user recently
      // dismissed / already installed for their account.
      try {
        if (localStorage.getItem(DEVICE_INSTALLED_KEY) === '1') return;
        if (localStorage.getItem(alreadyInstalledKey()) === '1') return;
        const last = parseInt(localStorage.getItem(installDismissKey()) || '0', 10);
        if (last && Date.now() - last < INSTALL_DISMISS_COOLDOWN) return;
      } catch {}
      setInstallPromptEvent(e);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);

    const onInstalled = () => {
      // Real install event = device-global fact (and per-user, for symmetry).
      try { localStorage.setItem(DEVICE_INSTALLED_KEY, '1'); } catch {}
      try { localStorage.setItem(alreadyInstalledKey(), '1'); } catch {}
      setInstallPromptEvent(null);
    };
    window.addEventListener('appinstalled', onInstalled);

    // ── Update flow ──
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistration().then((reg) => {
        if (!reg) return;
        updateRegRef.current = reg;
        // If a waiting worker already exists at boot, show prompt immediately.
        if (reg.waiting && navigator.serviceWorker.controller) {
          setShowUpdate(true);
        }
        reg.addEventListener('updatefound', () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              setShowUpdate(true);
            }
          });
        });
      }).catch(() => {});
      // Reload page automatically after a NEW SW takes control of an
      // already-controlled page (a real update). On the very first install
      // there is no prior controller, so controllerchange fires once during
      // initial activation — reloading there causes a spurious full-page
      // refresh on the user's first visit. Capture whether a controller
      // already existed BEFORE the change and only reload if so.
      const hadController = !!navigator.serviceWorker.controller;
      let _reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController) return;
        if (_reloading) return;
        _reloading = true;
        try { window.location.reload(); } catch {}
      });
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  // Animate in/out
  useEffect(() => {
    const visible = !!installPromptEvent || showUpdate;
    Animated.spring(slideAnim, {
      toValue: visible ? 1 : 0,
      tension: 80, friction: 14,
      useNativeDriver: true,
    }).start();
  }, [installPromptEvent, showUpdate, slideAnim]);

  if (Platform.OS !== 'web') return null;
  if (!installPromptEvent && !showUpdate) return null;

  const dismissInstall = () => {
    try { localStorage.setItem(installDismissKey(), String(Date.now())); } catch {}
    setInstallPromptEvent(null);
  };
  const acceptInstall = async () => {
    const e = installPromptEvent;
    setInstallPromptEvent(null);
    try {
      e.prompt();
      const choice = await e.userChoice;
      if (choice?.outcome === 'accepted') {
        try { localStorage.setItem(alreadyInstalledKey(), '1'); } catch {}
        try { localStorage.setItem(DEVICE_INSTALLED_KEY, '1'); } catch {}
      }
    } catch {}
  };

  const acceptUpdate = () => {
    setShowUpdate(false);
    const reg = updateRegRef.current;
    if (reg?.waiting) {
      try { reg.waiting.postMessage({ type: 'SKIP_WAITING' }); } catch {}
    }
    // Reload regardless — the controllerchange handler will also reload, but
    // covers the case where SKIP_WAITING raced with our postMessage.
    setTimeout(() => { try { window.location.reload(); } catch {} }, 600);
  };
  const dismissUpdate = () => setShowUpdate(false);

  // Update banner takes precedence (it's more important than install).
  const isUpdate = showUpdate;
  const title = isUpdate
    ? (t?.('pwa.updateTitle') || 'Atualização disponível')
    : (t?.('pwa.installTitle') || 'Instalar Chatyy no celular');
  const body = isUpdate
    ? (t?.('pwa.updateBody') || 'Toque para aplicar a nova versão.')
    : (t?.('pwa.installBody') || 'Acesso rápido pelo ícone do celular, igual app nativo.');
  const cta = isUpdate
    ? (t?.('pwa.updateCta') || 'Atualizar')
    : (t?.('pwa.installCta') || 'Instalar');
  const onAccept = isUpdate ? acceptUpdate : acceptInstall;
  const onDismiss = isUpdate ? dismissUpdate : dismissInstall;
  const accent = isUpdate ? '#10b981' : '#7C3AED';

  const translateY = slideAnim.interpolate({ inputRange: [0, 1], outputRange: [80, 0] });

  return (
    <Animated.View
      style={[
        styles.wrap,
        {
          backgroundColor: isDark ? 'rgba(30,30,32,0.96)' : 'rgba(255,255,255,0.97)',
          transform: [{ translateY }],
          opacity: slideAnim,
        },
      ]}
      pointerEvents="auto"
    >
      <Pressable onPress={onAccept} style={styles.row}>
        <View style={[styles.dot, { backgroundColor: accent }]} />
        <View style={{ flex: 1, marginHorizontal: 10 }}>
          <Text style={{ color: colors?.text || '#000', fontSize: 14, fontWeight: '700' }} numberOfLines={1}>{title}</Text>
          <Text style={{ color: colors?.textSecondary || '#666', fontSize: 12, marginTop: 1 }} numberOfLines={1}>{body}</Text>
        </View>
        <TouchableOpacity onPress={onAccept} style={[styles.cta, { backgroundColor: accent }]}>
          <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>{cta}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onDismiss} style={styles.dismiss}>
          <Text style={{ color: colors?.textTertiary || '#999', fontSize: 18, lineHeight: 18 }}>×</Text>
        </TouchableOpacity>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'fixed',
    left: 12, right: 12, bottom: 12,
    borderRadius: 14,
    paddingVertical: 10, paddingHorizontal: 12,
    zIndex: 9999,
    boxShadow: '0 8px 28px rgba(0,0,0,0.14)',
  },
  row: { flexDirection: 'row', alignItems: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  cta: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 10, marginLeft: 6 },
  dismiss: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', marginLeft: 4, opacity: 0.6 },
});
