/**
 * /locked-chats — "Conversas bloqueadas" (WhatsApp-style hidden folder).
 *
 * The hidden folder for Chat-Lock conversations. Opened from the ChatListTab
 * "Conversas trancadas" row. On mount it demands a biometric / device-passcode
 * authentication (expo-local-authentication via services/biometricGate) BEFORE
 * any conversation is fetched or rendered — so a shoulder-surfer never sees the
 * list, previews, or even the count without authenticating.
 *
 * Data: api.chatLockedConversations() → chat_list?filter=locked, which returns
 * ONLY this user's locked conversations WITH their real last-message preview
 * (the normal feed masks that preview on the wire). The lock flag is per-user.
 *
 * Unlock: the trailing lock button opens ChatLockSheet, which removes the lock
 * behind a second biometric confirm and drops the row from this screen.
 *
 * No emoji — SVG icons only. Themed via useTheme().
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconArrowLeft, IconLock, IconShield } from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';
import PressableScale from '../components/PressableScale';
import ChatLockSheet from '../components/ChatLockSheet';
import * as api from '../services/api';
import { emailToDisplayName } from '../services/api';
import { confirmWithBiometric } from '../services/biometricGate';

function previewText(conv, t) {
  const lm = conv?.last_message;
  if (!lm) return t('chat.noMessages') || 'Sem mensagens';
  if (typeof lm === 'string') return lm;
  const type = lm.type || 'text';
  if (type !== 'text') {
    const map = {
      image: t('chat.photo') || 'Foto',
      video: t('chat.video') || 'Vídeo',
      audio: t('chat.audio') || 'Áudio',
      file: lm.file_name || (t('chat.file') || 'Arquivo'),
      sticker: t('chat.sticker') || 'Figurinha',
      gif: 'GIF',
      location: t('chat.location') || 'Localização',
      contact: t('chat.contact') || 'Contato',
    };
    return map[type] || (t('chat.message') || 'Mensagem');
  }
  return String(lm.content || '');
}

export default function LockedChatsScreen() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // 'auth' → authenticating, 'ok' → unlocked (show list), 'denied' → failed
  const [phase, setPhase] = useState('auth');
  const [loading, setLoading] = useState(false);
  const [convs, setConvs] = useState([]);
  const [sheetConv, setSheetConv] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.chatLockedConversations();
      const list = Array.isArray(r?.data) ? r.data : (r?.data?.conversations || []);
      setConvs(list);
    } catch {
      setConvs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const authenticate = useCallback(async () => {
    setPhase('auth');
    let ok = false;
    try {
      ok = await confirmWithBiometric({
        reason: t('chat.hiddenSection') || 'Conversas bloqueadas',
        fallback: t('chat.usePasscode') || 'Usar código do aparelho',
        cancel: t('common.cancel') || 'Cancelar',
      });
    } catch { ok = false; }
    if (ok) {
      setPhase('ok');
      load();
    } else {
      setPhase('denied');
    }
  }, [t, load]);

  useEffect(() => { authenticate(); }, [authenticate]);

  const openConversation = useCallback((conv) => {
    const name = conv.name || conv.display_name || conv.other_email || '';
    router.push(`/chat-conversation?id=${conv.id}&name=${encodeURIComponent(emailToDisplayName(name) || name || '')}&type=${conv.type || 'direct'}`);
  }, [router]);

  const onUnlocked = useCallback((lockedNow) => {
    if (!lockedNow && sheetConv) {
      setConvs(prev => prev.filter(c => c.id !== sheetConv.id));
    }
  }, [sheetConv]);

  const renderRow = ({ item }) => {
    const name = emailToDisplayName(item.name || item.display_name || item.other_email || '') || item.name || '—';
    return (
      <PressableScale onPress={() => openConversation(item)} style={styles.row}>
        <AvatarCircle name={name} email={item.other_email || item.contact_email} uri={item.avatar} size={48} />
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={[styles.rowName, { color: colors.text }]} numberOfLines={1}>{name}</Text>
          <Text style={[styles.rowPreview, { color: colors.textTertiary || colors.textSecondary || '#888' }]} numberOfLines={1}>
            {previewText(item, t)}
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => setSheetConv(item)}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          style={[styles.lockBtn, { backgroundColor: isDark ? '#2c2c2e' : '#eceef3' }]}
        >
          <IconLock size={16} color={colors.text} />
        </TouchableOpacity>
      </PressableScale>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: isDark ? '#2c2c2e' : '#e5e6ea' }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <IconArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>
          {t('chat.hiddenSection') || 'Conversas bloqueadas'}
        </Text>
        <View style={{ width: 24 }} />
      </View>

      {phase === 'auth' && (
        <View style={styles.center}>
          <View style={[styles.bigBadge, { backgroundColor: isDark ? '#2c2c2e' : '#eceef3' }]}>
            <IconShield size={34} color={colors.text} />
          </View>
          <Text style={[styles.centerText, { color: colors.textTertiary || '#888' }]}>
            {t('chat.authenticating') || 'Autenticando…'}
          </Text>
        </View>
      )}

      {phase === 'denied' && (
        <View style={styles.center}>
          <View style={[styles.bigBadge, { backgroundColor: isDark ? '#2c2c2e' : '#eceef3' }]}>
            <IconLock size={34} color={colors.text} />
          </View>
          <Text style={[styles.centerTitle, { color: colors.text }]}>
            {t('chat.authRequired') || 'Autenticação necessária'}
          </Text>
          <Text style={[styles.centerText, { color: colors.textTertiary || '#888' }]}>
            {t('chat.authRequiredDesc') || 'Autentique-se para ver suas conversas bloqueadas.'}
          </Text>
          <PressableScale onPress={authenticate} style={[styles.retryBtn, { backgroundColor: '#2563eb' }]}>
            <Text style={styles.retryText}>{t('chat.tryAgain') || 'Tentar de novo'}</Text>
          </PressableScale>
        </View>
      )}

      {phase === 'ok' && (
        loading ? (
          <View style={styles.center}><ActivityIndicator color={colors.text} /></View>
        ) : convs.length === 0 ? (
          <View style={styles.center}>
            <View style={[styles.bigBadge, { backgroundColor: isDark ? '#2c2c2e' : '#eceef3' }]}>
              <IconLock size={34} color={colors.text} />
            </View>
            <Text style={[styles.centerTitle, { color: colors.text }]}>
              {t('chat.noLockedChats') || 'Nenhuma conversa bloqueada'}
            </Text>
            <Text style={[styles.centerText, { color: colors.textTertiary || '#888' }]}>
              {t('chat.noLockedChatsDesc') || 'Mantenha pressionada uma conversa e escolha "Bloquear conversa".'}
            </Text>
          </View>
        ) : (
          <FlatList
            data={convs}
            keyExtractor={(c) => String(c.id)}
            renderItem={renderRow}
            contentContainerStyle={{ paddingVertical: 6, paddingBottom: insets.bottom + 20 }}
          />
        )
      )}

      <ChatLockSheet
        visible={!!sheetConv}
        conversation={sheetConv}
        locked
        onClose={() => setSheetConv(null)}
        onChanged={onUnlocked}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { fontSize: 17, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10 },
  rowName: { fontSize: 16, fontWeight: '600' },
  rowPreview: { fontSize: 13, marginTop: 2 },
  lockBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', marginLeft: 8 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40 },
  bigBadge: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  centerTitle: { fontSize: 17, fontWeight: '700', textAlign: 'center', marginBottom: 6 },
  centerText: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  retryBtn: { marginTop: 22, paddingVertical: 12, paddingHorizontal: 28, borderRadius: 12 },
  retryText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
