// [email-global 2026-10-24] Folha "Seu e-mail ficou global" — mostrada UMA vez
// para quem tem @chatyy.com.br quando o servidor diz que o alias @chatyy.app
// está ativo (services/emailGlobalNotice). Prévia aprovada:
// /var/www/mail/preview-2026/email-novo.html.
//
// Sheet do SISTEMA (NativeSheetDialog → UISheetPresentationController /
// BottomSheet); Modal só na web. Nunca abre por cima de outra folha/Modal no
// iOS: espera app ativo e nada aberto (mesma regra do StorageOfferHost).
// Flag: globalThis.__chatyy_email_global_notice = true (padrão desligado).
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, AppState, Platform } from 'react-native';
import NativeSheetDialog from './NativeSheetDialog';
import { nativeSheetsOpenCount, nativeSheetRecentlyClosed } from './NativeSheet';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconMail, IconCheck, IconCopy, IconChevronUp } from './Icons';
import { subscribeEmailGlobalNotice, markEmailGlobalNoticeSeen } from '../services/emailGlobalNotice';

async function _copy(text) {
  try {
    if (Platform.OS === 'web') {
      if (typeof navigator !== 'undefined' && navigator.clipboard) { await navigator.clipboard.writeText(text); return true; }
      return false;
    }
    await require('expo-clipboard').setStringAsync(text);
    return true;
  } catch { return false; }
}

export default function EmailGlobalNoticeHost() {
  const { colors = {}, isDark, accentHex } = useTheme() || {};
  const { t } = useLanguage();
  const [ev, setEv] = useState(null);
  const [copied, setCopied] = useState(false);
  const evRef = useRef(null);
  evRef.current = ev;

  useEffect(() => {
    let timer = null;
    let pending = null;
    const busy = () => {
      if (evRef.current) return true;
      try { if (AppState.currentState && AppState.currentState !== 'active') return true; } catch {}
      try { if (nativeSheetsOpenCount() > 0 || nativeSheetRecentlyClosed()) return true; } catch {}
      if (Platform.OS === 'ios') {
        try { if (require('../services/modalGuardIOS').getOpenModals().length > 0) return true; } catch {}
      }
      return false;
    };
    const show = (e) => {
      setCopied(false);
      setEv(e);
      markEmailGlobalNoticeSeen(e.old); // visto ao abrir: nunca repete
    };
    const flush = () => {
      timer = null;
      if (!pending) return;
      if (busy()) { timer = setTimeout(flush, 2000); return; }
      const p = pending; pending = null;
      show(p);
    };
    const unsub = subscribeEmailGlobalNotice((e) => {
      if (evRef.current) return;
      pending = e;
      if (!timer) timer = setTimeout(flush, busy() ? 2000 : 600);
    });
    let appSub = null;
    try {
      appSub = AppState.addEventListener('change', (s) => {
        if (s === 'active' && pending) { if (timer) clearTimeout(timer); timer = setTimeout(flush, 900); }
      });
    } catch {}
    return () => {
      try { unsub && unsub(); } catch {}
      try { appSub && appSub.remove(); } catch {}
      if (timer) clearTimeout(timer);
    };
  }, []);

  const close = () => setEv(null);
  const visible = !!ev;
  const text = colors.text || (isDark ? '#F5F5F7' : '#111111');
  const sub = colors.textSecondary || (isDark ? '#8E8E93' : '#6B6B70');
  const bg = isDark ? '#1C1C1E' : '#FFFFFF';
  const s2 = isDark ? '#2C2C2E' : '#F1F1EE';
  const accent = accentHex || text;
  const onAccent = accentHex ? '#FFFFFF' : (isDark ? '#000000' : '#FFFFFF');
  const ok = isDark ? '#3CC47C' : '#1E9E5A';

  const onCopy = async () => {
    if (!ev) return;
    const done = await _copy(ev.next);
    if (done) {
      setCopied(true);
      try { require('../constants/theme').haptic.success(); } catch {}
    }
  };

  return (
    <NativeSheetDialog
      visible={visible}
      onClose={close}
      panelStyle={[st.panel, { backgroundColor: bg }]}
      overlayStyle={st.overlay}
      animationType="slide"
    >
      {visible ? (
        <View testID="email-global-notice">
          <View style={[st.icon, { backgroundColor: isDark ? 'rgba(78,168,255,0.16)' : 'rgba(30,134,230,0.12)' }]}>
            <IconMail size={28} color={accentHex || (isDark ? '#4EA8FF' : '#1E86E6')} />
          </View>
          <Text style={[st.title, { color: text }]} accessibilityRole="header">{t('emailGlobal.title')}</Text>
          <Text style={[st.body, { color: sub }]}>{t('emailGlobal.body')}</Text>

          <View style={[st.addr, { backgroundColor: s2, marginTop: 16 }]}>
            <Text style={[st.addrLabel, { color: sub }]}>{t('emailGlobal.newLabel')}</Text>
            <Text style={[st.addrValue, { color: text }]} selectable>{ev.next}</Text>
          </View>
          <View style={st.arrow}><IconChevronUp size={18} color={sub} /></View>
          <View style={[st.addr, { backgroundColor: s2 }]}>
            <Text style={[st.addrLabel, { color: sub }]}>{t('emailGlobal.oldLabel')}</Text>
            <Text style={[st.addrValue, { color: sub, fontWeight: '600' }]} selectable>{ev.old}</Text>
          </View>

          <View style={st.okRow}>
            <IconCheck size={18} color={ok} strokeWidth={2.4} />
            <Text style={[st.okTxt, { color: text }]}>{t('emailGlobal.reassure')}</Text>
          </View>

          <Pressable onPress={close} style={[st.btn, { backgroundColor: accent }]} accessibilityRole="button" testID="email-global-ok">
            <Text style={[st.btnTxt, { color: onAccent }]}>{t('emailGlobal.ok')}</Text>
          </Pressable>
          <Pressable onPress={onCopy} style={st.link} accessibilityRole="button" testID="email-global-copy"
            accessibilityLabel={copied ? t('emailGlobal.copied') : t('emailGlobal.copy')}>
            <View style={st.linkRow}>
              {copied ? <IconCheck size={17} color={accent} strokeWidth={2.4} /> : <IconCopy size={17} color={accent} />}
              <Text style={[st.linkTxt, { color: accent }]}>{copied ? t('emailGlobal.copied') : t('emailGlobal.copy')}</Text>
            </View>
          </Pressable>
        </View>
      ) : null}
    </NativeSheetDialog>
  );
}

const st = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end', alignItems: 'stretch' },
  panel: { width: '100%', maxWidth: 520, alignSelf: 'center', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 20, paddingTop: 24, paddingBottom: 24 },
  icon: { width: 56, height: 56, borderRadius: 18, alignItems: 'center', justifyContent: 'center', alignSelf: 'center', marginBottom: 12 },
  title: { fontSize: 21, fontWeight: '800', lineHeight: 26, textAlign: 'center' },
  body: { fontSize: 14.5, lineHeight: 21, marginTop: 8, textAlign: 'center' },
  addr: { borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12 },
  addrLabel: { fontSize: 11.5, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3 },
  addrValue: { fontSize: 16, fontWeight: '700', marginTop: 2 },
  arrow: { alignItems: 'center', marginVertical: 2 },
  okRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 12 },
  okTxt: { flex: 1, fontSize: 13.5, lineHeight: 19 },
  btn: { minHeight: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 16 },
  btnTxt: { fontSize: 16, fontWeight: '700' },
  link: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  linkTxt: { fontSize: 15.5, fontWeight: '600' },
});
