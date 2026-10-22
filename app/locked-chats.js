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
  Modal, TextInput, Platform,
} from 'react-native';
import SheetKeyboardAvoider from '../components/chat/SheetKeyboardAvoider'; // [2026-10-22 kb-uniforme] Android: teclado não cobre campos (edge-to-edge)
import { useRouter, Stack, useFocusEffect } from 'expo-router';
import { USE_NATIVE_HEADER, nativeHeaderOptions } from '../components/nativeHeader'; // [2026-10-09 more-native]
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconArrowLeft, IconLock, IconShield, IconKey, IconChevronRight } from '../components/Icons';
import { useAuth } from '../context/AuthContext';
import { getSecretCode, setSecretCode as saveSecretCode } from '../services/lockedSecretCode';
import AvatarCircle from '../components/AvatarCircle';
import PressableScale from '../components/PressableScale';
import ChatLockSheet from '../components/ChatLockSheet';
import * as api from '../services/api';
import { emailToDisplayName } from '../services/api';
import { confirmWithBiometric } from '../services/biometricGate';
import { regionalLocale } from '../utils/dateFormat';

import { a11yLabel } from '../utils/a11yLabel'; // [2026-10-20 a11y] rótulos dos botões só-ícone
function previewText(conv, t) {
  const lm = conv?.last_message;
  if (!lm) return t('chat.noMessages') || 'Sem mensagens';
  if (typeof lm === 'string') return lm;
  // [2026-10-12 chatlist-wa] tombstone / calls / polls / raw JSON envelopes
  // used to leak through as "{...}" or as the deleted text.
  if (lm.deleted || lm.deleted_at) return t('chatConv.deletedMessage') || 'Esta mensagem foi apagada';
  const type = lm.type || 'text';
  if (type === 'call_card') return t('chat.voiceCall') || 'Chamada';
  if (type === 'poll') return t('chat.poll') || 'Enquete';
  if (type === 'voice') return t('chat.audio') || 'Áudio';
  if (type === 'system') return '';
  if (type === 'text' && /^\s*\{/.test(String(lm.content || ''))) {
    try { const p = JSON.parse(lm.content); const v = p.text || p.body || p.caption || p.content; if (typeof v === 'string') return v; } catch {}
    return t('chat.message') || 'Mensagem';
  }
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

// Same calendar-day rule as the chat list rows: HH:MM today, "Ontem",
// weekday within a week, dd/mm/aa otherwise.
function _fmtWhen(iso, t, locale) {
  if (!iso) return '';
  const d = new Date(String(iso).replace(' ', 'T'));
  if (isNaN(d.getTime())) return '';
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(d)) / 86400000);
  const loc = locale || undefined;
  try {
    if (diff <= 0) return d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
    if (diff === 1) return t('time.yesterday') || 'Ontem';
    if (diff < 7) { const w = d.toLocaleDateString(loc, { weekday: 'long' }); return w.charAt(0).toUpperCase() + w.slice(1); }
    return d.toLocaleDateString(loc, { day: '2-digit', month: '2-digit', year: '2-digit' });
  } catch { return ''; }
}

export default function LockedChatsScreen() {
  const { colors, isDark } = useTheme();
  const { t, language } = useLanguage();
  const _loc = (() => { try { return regionalLocale(language); } catch { return language; } })();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // 'auth' → authenticating, 'ok' → unlocked (show list), 'denied' → failed
  const [phase, setPhase] = useState('auth');
  const [loading, setLoading] = useState(false);
  const [convs, setConvs] = useState([]);
  const [sheetConv, setSheetConv] = useState(null);
  // [2026-10-18 wa-parity lock-code] Código secreto (WhatsApp): definido AQUI, dentro da pasta
  // já autenticada. Com código, a entrada "Conversas trancadas" some da lista e só volta
  // quando o código exato é digitado na busca (ChatListTab.renderLockedHeader).
  const { user } = useAuth() || {};
  const [secretCode, setSecretCodeState] = useState('');
  const [codeModal, setCodeModal] = useState(false);
  const [codeInput, setCodeInput] = useState('');
  useEffect(() => {
    let alive = true;
    getSecretCode(user?.email).then((c) => { if (alive) setSecretCodeState(c || ''); });
    return () => { alive = false; };
  }, [user?.email]);
  const persistCode = useCallback(async (c) => {
    const v = await saveSecretCode(user?.email, c);
    setSecretCodeState(v);
    setCodeModal(false);
  }, [user?.email]);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const r = await api.chatLockedConversations();
      const list = Array.isArray(r?.data) ? r.data : (r?.data?.conversations || []);
      // most recent first (WhatsApp) — server order was by id
      const _k = (c) => Date.parse(String(c?.last_message_at || c?.last_message?.created_at || c?.updated_at || '')) || 0;
      setConvs(list.slice().sort((a, b) => _k(b) - _k(a)));
    } catch {
      if (!silent) setConvs([]);
    } finally {
      setLoading(false);
    }
  }, []);
  // Back from a locked chat → refresh unread/preview silently (no spinner).
  const phaseRef = React.useRef(phase);
  phaseRef.current = phase;
  useFocusEffect(useCallback(() => {
    if (phaseRef.current === 'ok') load(true);
  }, [load]));

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
    const peer = conv.type === 'direct' ? (conv.other_email || conv.contact_email || '') : '';
    require('../services/openConversation').openConversation(`/chat-conversation?id=${conv.id}&name=${encodeURIComponent(emailToDisplayName(name) || name || '')}&type=${conv.type || 'direct'}${peer ? `&email=${encodeURIComponent(peer)}` : ''}`);
  }, [router]);

  const onUnlocked = useCallback((lockedNow) => {
    if (!lockedNow && sheetConv) {
      setConvs(prev => prev.filter(c => c.id !== sheetConv.id));
    }
  }, [sheetConv]);

  const secretCodeRow = (
    <TouchableOpacity
      onPress={() => { setCodeInput(''); setCodeModal(true); }}
      activeOpacity={0.7}
      accessibilityRole="button"
      style={[styles.codeRow, { borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)' }]}
    >
      <View style={[styles.lockBtn, { marginLeft: 0, backgroundColor: isDark ? '#2c2c2e' : '#eceef3' }]}>
        <IconKey size={16} color={colors.text} />
      </View>
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text style={[styles.rowName, { color: colors.text }]}>{t('chat.secretCode') || 'Código secreto'}</Text>
        <Text style={[styles.rowPreview, { color: colors.textTertiary || '#888' }]} numberOfLines={2}>
          {secretCode
            ? (t('chat.secretCodeOn') || 'Ativado — busque pelo código para ver')
            : (t('chat.secretCodeOff') || 'Defina um código para ocultar esta pasta')}
        </Text>
      </View>
      <IconChevronRight size={18} color={colors.textTertiary || '#888'} />
    </TouchableOpacity>
  );

  const renderRow = ({ item }) => {
    const name = emailToDisplayName(item.name || item.display_name || item.other_email || '') || item.name || '—';
    const unread = (item.unread_count || 0) > 0;
    const when = _fmtWhen(item.last_message?.created_at || item.last_message_at, t, _loc);
    return (
      <PressableScale onPress={() => openConversation(item)} style={styles.row}>
        <AvatarCircle name={name} email={item.other_email || item.contact_email} uri={item.avatar} size={48} />
        <View style={{ flex: 1, marginLeft: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={[styles.rowName, { color: colors.text, flex: 1 }]} numberOfLines={1}>{name}</Text>
            {when ? <Text style={{ fontSize: 12, marginLeft: 8, color: unread ? colors.text : (colors.textTertiary || '#888'), fontWeight: unread ? '700' : '400' }}>{when}</Text> : null}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={[styles.rowPreview, { flex: 1, color: unread ? colors.text : (colors.textTertiary || colors.textSecondary || '#888'), fontWeight: unread ? '600' : '400' }]} numberOfLines={1}>
              {previewText(item, t)}
            </Text>
            {unread ? (
              <View style={{ minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, marginLeft: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.text }}>
                <Text style={{ fontSize: 12, fontWeight: '700', color: colors.background }}>{item.unread_count > 99 ? '99+' : item.unread_count}</Text>
              </View>
            ) : null}
          </View>
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
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: USE_NATIVE_HEADER ? 0 : insets.top }]}>
      {/* [2026-10-09 more-native] Header nativo (UINavigationBar / Toolbar Material); web = custom. */}
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({ colors, isDark, title: t('chat.hiddenSection') })} />
      ) : (
      <View style={[styles.header, { borderBottomColor: isDark ? '#2c2c2e' : '#e5e6ea' }]}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={a11yLabel('common.back', 'Voltar')} onPress={() => router.back()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <IconArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>
          {t('chat.hiddenSection') || 'Conversas bloqueadas'}
        </Text>
        <View style={{ width: 24 }} />
      </View>
      )}

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
          <PressableScale onPress={authenticate} style={[styles.retryBtn, { backgroundColor: colors.text }]}>
            <Text style={[styles.retryText, { color: colors.background }]}>{t('chat.tryAgain') || 'Tentar de novo'}</Text>
          </PressableScale>
        </View>
      )}

      {phase === 'ok' && !loading && convs.length === 0 ? secretCodeRow : null}
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
            ListHeaderComponent={secretCodeRow}
            contentContainerStyle={{ paddingVertical: 6, paddingBottom: insets.bottom + 20 }}
          />
        )
      )}

      {codeModal && (
        <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={() => setCodeModal(false)}>
          <SheetKeyboardAvoider style={styles.modalDim}>
            <View style={[styles.modalCard, { backgroundColor: colors.surface || (isDark ? '#1c1c1e' : '#fff') }]}>
              <Text style={{ color: colors.text, fontSize: 17, fontWeight: '700', marginBottom: 6 }}>
                {t('chat.secretCode') || 'Código secreto'}
              </Text>
              <Text style={{ color: colors.textTertiary || '#888', fontSize: 13, marginBottom: 16, lineHeight: 18 }}>
                {t('chat.secretCodeHelp') || 'Com um código definido, a pasta de conversas trancadas fica oculta e só aparece quando você digita o código na busca.'}
              </Text>
              <TextInput
                value={codeInput}
                onChangeText={setCodeInput}
                placeholder={t('chat.secretCodePlaceholder') || 'Digite um código'}
                placeholderTextColor={colors.textTertiary || '#888'}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                secureTextEntry
                style={{
                  color: colors.text, fontSize: 15, height: 43, paddingHorizontal: 14, borderRadius: 10,
                  backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)',
                  ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
                }}
              />
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
                {!!secretCode && (
                  <TouchableOpacity onPress={() => persistCode('')} style={[styles.mBtn, { backgroundColor: 'rgba(220,38,38,0.12)' }]}>
                    <Text style={{ color: colors.error || '#dc2626', fontSize: 14, fontWeight: '700' }}>{t('common.remove') || 'Remover'}</Text>
                  </TouchableOpacity>
                )}
                <View style={{ flex: 1 }} />
                <TouchableOpacity onPress={() => setCodeModal(false)} style={[styles.mBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)' }]}>
                  <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }}>{t('common.cancel') || 'Cancelar'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  disabled={!codeInput.trim()}
                  onPress={() => persistCode(codeInput)}
                  style={[styles.mBtn, { backgroundColor: colors.text, opacity: codeInput.trim() ? 1 : 0.4 }]}
                >
                  <Text style={{ color: colors.background, fontSize: 14, fontWeight: '700' }}>{t('common.save') || 'Salvar'}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </SheetKeyboardAvoider>
        </Modal>
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
  codeRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  modalDim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 },
  modalCard: { width: '100%', maxWidth: 380, borderRadius: 18, padding: 22 },
  mBtn: { paddingVertical: 11, paddingHorizontal: 16, borderRadius: 10 },
});
