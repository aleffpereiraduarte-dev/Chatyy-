// [2026-10-09 system-integration] Landing route for OS assistant actions:
//   Android App Actions (Google Assistant CREATE_MESSAGE / CREATE_CALL —
//     plugins/with-app-shortcuts.js):  onemundomail://assistant-action/message?name=Ana&text=Oi
//   iOS Phone app Recents "call back" (INStartCallIntent → AppShortcutsAppDelegateSubscriber):
//     onemundomail://assistant-action/call?email=ana@x&name=Ana
// Resolves the conversation from the local cache (locked/archived excluded)
// and replaces itself with the chat (prefilled text, or ?autocall= which runs
// the normal in-chat call pipeline). Not found → small fallback screen.
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { IconMessageSquare } from '../../components/Icons';

const WAIT_MS = 4000;
const STEP_MS = 250;

function str(v) {
  if (Array.isArray(v)) return String(v[0] || '');
  return v == null ? '' : String(v);
}

export default function AssistantActionScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [notFound, setNotFound] = useState(false);
  const doneRef = useRef(false);

  const kind = str(params.kind).toLowerCase();
  const name = str(params.name);
  const email = str(params.email);
  const id = str(params.id);
  const text = str(params.text);

  useEffect(() => {
    if (doneRef.current) return undefined;
    let cancelled = false;
    let timer = null;
    const started = Date.now();
    const attempt = () => {
      if (cancelled || doneRef.current) return;
      let res = { href: null };
      try {
        res = require('../../services/systemIntegration').resolveAssistantAction({ kind, id, email, name, text });
      } catch {}
      if (res && res.href) {
        doneRef.current = true;
        try { router.replace(res.href); } catch {}
        return;
      }
      // Cold start: the conversation cache may still be hydrating.
      if (Date.now() - started < WAIT_MS) {
        timer = setTimeout(attempt, STEP_MS);
      } else {
        setNotFound(true);
      }
    };
    attempt();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [kind, id, email, name, text, router]);

  const bg = colors?.background || '#ffffff';
  const fg = colors?.text || '#111111';
  const sub = colors?.textSecondary || '#667781';

  if (!notFound) {
    return (
      <View style={[styles.root, { backgroundColor: bg }]}>
        <ActivityIndicator color={fg} />
      </View>
    );
  }

  const who = name || email;
  return (
    <View style={[styles.root, { backgroundColor: bg }]}>
      <IconMessageSquare size={40} color={fg} />
      <Text style={[styles.title, { color: fg }]}>{t('assistant.notFoundTitle')}</Text>
      <Text style={[styles.body, { color: sub }]}>
        {who ? t('assistant.notFoundBody', { name: who }) : t('assistant.notFoundGeneric')}
      </Text>
      <TouchableOpacity
        accessibilityRole="button"
        style={[styles.primary, { backgroundColor: fg }]}
        onPress={() => { try { router.replace('/chat-new'); } catch {} }}
      >
        <Text style={[styles.primaryText, { color: bg }]}>{t('assistant.newChat')}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        accessibilityRole="button"
        style={styles.secondary}
        onPress={() => { try { router.replace('/chat'); } catch {} }}
      >
        <Text style={[styles.secondaryText, { color: fg }]}>{t('assistant.openChats')}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  title: { fontSize: 18, fontWeight: '700', marginTop: 16, textAlign: 'center' },
  body: { fontSize: 15, marginTop: 8, textAlign: 'center', lineHeight: 21 },
  primary: { marginTop: 24, paddingVertical: 12, paddingHorizontal: 28, borderRadius: 24 },
  primaryText: { fontSize: 15, fontWeight: '600' },
  secondary: { marginTop: 12, paddingVertical: 10, paddingHorizontal: 20 },
  secondaryText: { fontSize: 15, fontWeight: '500' },
});
