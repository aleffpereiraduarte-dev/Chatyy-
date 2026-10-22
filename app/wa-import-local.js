/**
 * /wa-import-local?id=<id local> — conversa importada do WhatsApp SÓ NESTE APARELHO [wa-import-local 2026-10-22]
 *
 * Só leitura, lida do store local (chatyy.db) — nada vem do servidor nem vai para ele.
 * Mídia = arquivo local (documentDirectory/wa-import-local/<slot>/); tocar abre/compartilha o arquivo.
 * Apagar remove mensagens + registro + arquivos deste aparelho (confirmação única, sem Modal sobre Modal).
 */
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, FlatList, Image, ActivityIndicator, Platform } from 'react-native';
import { useRouter, useLocalSearchParams, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { USE_NATIVE_HEADER, nativeHeaderOptions } from '../components/nativeHeader';
import ModalHeader from '../components/ModalHeader';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useConfirm } from '../components/ConfirmModal';
import { IconChevronLeft, IconTrash, IconLock, IconImage, IconVideo, IconMic, IconMusic, IconFile, IconAlertTriangle } from '../components/Icons';
import { getLocalImport, getLocalMessages, deleteLocalImport } from '../services/waImport/localImport';

const PAGE = 120;

function fmtTime(iso, lang) {
  try { return new Date(iso).toLocaleTimeString(lang || undefined, { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}
function fmtDay(iso, lang) {
  try { return new Date(iso).toLocaleDateString(lang || undefined, { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return String(iso || '').slice(0, 10); }
}
function dayKey(iso) { try { const d = new Date(iso); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; } catch { return ''; } }

export default function WaImportLocalScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const id = String(params.id || '');
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t, language } = useLanguage();
  const confirm = useConfirm();
  const [conv, setConv] = useState(null);
  const [msgs, setMsgs] = useState([]); // antiga → nova
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [toast, setToast] = useState('');
  const moreRef = useRef(true);
  const busyRef = useRef(false);

  const ink = colors.text;
  const sub = colors.textSecondary || colors.text;
  const line = colors.border || 'rgba(127,127,127,0.25)';
  const bubbleOther = isDark ? '#1f1f22' : '#efeff2';
  const bubbleMine = isDark ? '#1d3b2f' : '#dcf3e4';

  const goBack = useCallback(() => {
    try { if (router.canGoBack && router.canGoBack()) { router.back(); return; } } catch {}
    try { router.replace('/import-whatsapp'); } catch {}
  }, [router]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const c = await getLocalImport(id);
      if (!alive) return;
      if (!c) { setMissing(true); setLoading(false); return; }
      setConv(c);
      const first = await getLocalMessages(id, PAGE, null);
      if (!alive) return;
      setMsgs(first);
      moreRef.current = first.length >= PAGE;
      setLoading(false);
    })().catch(() => { if (alive) { setMissing(true); setLoading(false); } });
    return () => { alive = false; };
  }, [id]);

  const loadOlder = useCallback(async () => {
    if (busyRef.current || !moreRef.current || !msgs.length) return;
    busyRef.current = true;
    try {
      const older = await getLocalMessages(id, PAGE, msgs[0].id);
      moreRef.current = older.length >= PAGE;
      if (older.length) setMsgs((cur) => [...older, ...cur]);
    } finally { busyRef.current = false; }
  }, [id, msgs]);

  const openFile = useCallback(async (m) => {
    if (!m?.local_path) return;
    try {
      const Sharing = require('expo-sharing');
      if (await Sharing.isAvailableAsync()) { await Sharing.shareAsync(m.local_path, m.mime ? { mimeType: m.mime } : undefined); return; }
    } catch {}
    setToast(t('waImport.localOpenFail'));
    setTimeout(() => setToast(''), 2500);
  }, [t]);

  const onDelete = useCallback(async () => {
    const msg = t('waImport.localDeleteConfirm');
    const ok = Platform.OS === 'web'
      ? (typeof window !== 'undefined' && window.confirm(msg))
      : await confirm({ title: t('waImport.delete'), message: msg, confirmLabel: t('waImport.delete'), destructive: true });
    if (!ok) return;
    await deleteLocalImport(id).catch(() => false);
    goBack();
  }, [confirm, t, id, goBack]);

  const isGroup = conv?.type === 'group';
  const data = msgs.slice().reverse(); // FlatList invertida: nova → antiga

  const MediaLine = ({ m, color }) => {
    const Ico = m.type === 'video' ? IconVideo : m.type === 'voice' ? IconMic : m.type === 'audio' ? IconMusic : m.type === 'image' || m.type === 'sticker' ? IconImage : IconFile;
    return (
      <View style={s.mediaRow}>
        <Ico size={18} color={color} />
        <Text style={{ color, fontSize: 14, marginLeft: 8, flexShrink: 1 }} numberOfLines={2}>
          {m.file_name || ''}{m.media_missing ? ` · ${t('waImport.localMediaMissing')}` : ''}
        </Text>
      </View>
    );
  };

  const renderItem = ({ item: m, index }) => {
    const older = data[index + 1];
    const showDay = !older || dayKey(older.created_at) !== dayKey(m.created_at);
    const dayChip = showDay ? (
      <View style={s.dayWrap}><Text style={[s.dayChip, { color: sub, borderColor: line }]}>{fmtDay(m.created_at, language)}</Text></View>
    ) : null;
    if (m.type === 'system') {
      return (<View>{dayChip}<Text style={[s.system, { color: sub }]}>{m.content}</Text></View>);
    }
    const mine = !!m.is_mine;
    const showName = isGroup && !mine && m.sender_name && (!older || older.sender_name !== m.sender_name || showDay);
    const hasImg = (m.type === 'image' || m.type === 'sticker') && !!m.local_path;
    return (
      <View>
        {dayChip}
        <View style={[s.row, mine ? s.rowMine : s.rowOther]}>
          <View style={[s.bubble, { backgroundColor: mine ? bubbleMine : bubbleOther }]}>
            {showName ? <Text style={[s.name, { color: ink }]} numberOfLines={1}>{m.sender_name}</Text> : null}
            {m.deleted ? (
              <Text style={[s.text, { color: sub, fontStyle: 'italic' }]}>{t('waImport.localDeletedMsg')}</Text>
            ) : (
              <>
                {hasImg ? (
                  <TouchableOpacity onPress={() => openFile(m)} accessibilityRole="imagebutton" accessibilityLabel={m.file_name || ''}>
                    <Image source={{ uri: m.local_path }} style={m.type === 'sticker' ? s.sticker : s.image} resizeMode={m.type === 'sticker' ? 'contain' : 'cover'} />
                  </TouchableOpacity>
                ) : m.file_name ? (
                  <TouchableOpacity onPress={() => openFile(m)} disabled={!m.local_path} accessibilityRole="button">
                    <MediaLine m={m} color={ink} />
                  </TouchableOpacity>
                ) : null}
                {m.media_omitted ? <MediaLine m={{ type: 'file', file_name: t('waImport.localMediaOmitted') }} color={sub} /> : null}
                {m.content && !m.media_omitted ? <Text style={[s.text, { color: ink }]} selectable>{m.content}</Text> : null}
              </>
            )}
            <Text style={[s.time, { color: sub }]}>{m.edited ? `${t('waImport.localEdited')} · ` : ''}{fmtTime(m.created_at, language)}</Text>
          </View>
        </View>
      </View>
    );
  };

  const title = conv?.name || t('waImport.title');
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({ colors, isDark, title, headerLeft: () => (
          <TouchableOpacity onPress={goBack} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('common.back') || 'Voltar'} style={{ paddingRight: 8 }}>
            <IconChevronLeft size={26} color={colors.text} />
          </TouchableOpacity>
        ), headerRight: conv ? () => (
          <TouchableOpacity onPress={onDelete} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('waImport.delete')}>
            <IconTrash size={20} color={colors.text} />
          </TouchableOpacity>
        ) : undefined })} />
      ) : (
        <ModalHeader title={title} onClose={goBack} />
      )}
      <View style={[s.banner, { borderColor: line }]}>
        <IconLock size={14} color={sub} />
        <Text style={{ color: sub, fontSize: 12, marginLeft: 6, flex: 1 }} numberOfLines={2}>
          {t('waImport.localSub')}{conv ? ` · ${t('waImport.localCount', { n: Number(conv.message_count || msgs.length).toLocaleString(language || undefined) })}` : ''}
        </Text>
        {!USE_NATIVE_HEADER && conv ? (
          <TouchableOpacity onPress={onDelete} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('waImport.delete')} style={{ paddingLeft: 8 }}>
            <IconTrash size={18} color={sub} />
          </TouchableOpacity>
        ) : null}
      </View>
      {loading ? (
        <View style={s.center}><ActivityIndicator color={ink} /></View>
      ) : missing ? (
        <View style={s.center}>
          <IconAlertTriangle size={36} color={ink} />
          <Text style={{ color: ink, marginTop: 12, textAlign: 'center' }}>{t('waImport.localNotFound')}</Text>
        </View>
      ) : (
        <FlatList
          inverted
          data={data}
          keyExtractor={(m) => String(m.id)}
          renderItem={renderItem}
          onEndReached={loadOlder}
          onEndReachedThreshold={0.4}
          initialNumToRender={24}
          windowSize={11}
          contentContainerStyle={{ paddingHorizontal: 10, paddingTop: 8 + insets.bottom, paddingBottom: 8 }}
          ListEmptyComponent={<Text style={{ color: sub, textAlign: 'center', marginTop: 32 }}>{t('waImport.localEmpty')}</Text>}
        />
      )}
      {toast ? <View style={[s.toast, { backgroundColor: ink }]}><Text style={{ color: colors.background, fontSize: 13 }}>{toast}</Text></View> : null}
    </View>
  );
}

const s = StyleSheet.create({
  banner: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  row: { flexDirection: 'row', marginVertical: 2 },
  rowMine: { justifyContent: 'flex-end' },
  rowOther: { justifyContent: 'flex-start' },
  bubble: { maxWidth: '82%', borderRadius: 14, paddingHorizontal: 10, paddingTop: 6, paddingBottom: 4 },
  name: { fontSize: 12, fontWeight: '700', marginBottom: 2 },
  text: { fontSize: 15, lineHeight: 20 },
  time: { fontSize: 11, alignSelf: 'flex-end', marginTop: 2 },
  system: { fontSize: 12, textAlign: 'center', marginVertical: 6, paddingHorizontal: 24, lineHeight: 16 },
  dayWrap: { alignItems: 'center', marginVertical: 8 },
  dayChip: { fontSize: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 3, overflow: 'hidden' },
  mediaRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
  image: { width: 220, height: 220, borderRadius: 10, marginBottom: 4 },
  sticker: { width: 140, height: 140, marginBottom: 4 },
  toast: { position: 'absolute', bottom: 40, alignSelf: 'center', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8 },
});
