/**
 * LiveQA — Perguntas & Respostas da live.
 *
 *  • LiveQASheet (viewer): enviar pergunta (200 chars) + lista com "+1".
 *  • LiveQASheet (host): fila ordenada (destacada → abertas por votos →
 *    respondidas); "Destacar" coloca a pergunta na tela de todos, "Dispensar"
 *    remove. Destacar outra marca a anterior como respondida.
 *  • LiveQAHighlightCard: cartão na tela (todos) com a pergunta destacada;
 *    host pode tirar do ar pelo X.
 * Backend: chat_live_qa_* (chat.php) + WS live_qa_new/update/highlight.
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Modal, Pressable, FlatList,
  KeyboardAvoidingView, Platform, Animated, ActivityIndicator,
} from 'react-native';
import { useLanguage } from '../../context/LanguageContext';
import AvatarCircle from '../AvatarCircle';
import { IconX, IconSend, IconThumbsUp, IconHelpCircle, IconTrash, IconPin } from '../Icons';
import {
  useEngageSelector, selSheet, selQuestions, selHighlighted,
} from './liveEngageStore';

const QRow = memo(function QRow({ q, isHost, onUpvote, onHighlight, onDismiss, t }) {
  const hl = q.status === 'highlighted';
  const answered = q.status === 'answered';
  return (
    <View style={[styles.qRow, hl && styles.qRowHl]}>
      <AvatarCircle name={q.asker_name} email={q.asker_email || ''} size={30} />
      <View style={{ flex: 1 }}>
        <View style={styles.qMeta}>
          <Text style={styles.qName} numberOfLines={1}>{q.asker_name || '?'}</Text>
          {hl ? <Text style={styles.qTag}>{t('liveEng.qaOnScreen')}</Text> : null}
          {answered ? <Text style={[styles.qTag, styles.qTagDim]}>{t('liveEng.qaAnswered')}</Text> : null}
        </View>
        <Text style={styles.qText}>{q.text}</Text>
        {isHost ? (
          <View style={styles.qActions}>
            <TouchableOpacity
              onPress={() => onHighlight(hl ? 0 : q.id)}
              style={[styles.qBtn, !hl && styles.qBtnPrimary]}
              accessibilityRole="button"
            >
              <IconPin size={13} color={hl ? '#fff' : '#000'} />
              <Text style={[styles.qBtnText, !hl && styles.qBtnTextPrimary]}>{hl ? t('liveEng.qaUnhighlight') : t('liveEng.qaHighlight')}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => onDismiss(q.id)} style={styles.qBtn} accessibilityRole="button" accessibilityLabel={t('liveEng.qaDismiss')}>
              <IconTrash size={13} color="#fff" />
              <Text style={styles.qBtnText}>{t('liveEng.qaDismiss')}</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>
      <TouchableOpacity
        onPress={() => !isHost && !q.voted && onUpvote(q.id)}
        disabled={isHost || q.voted}
        style={[styles.vote, q.voted && styles.voteOn]}
        accessibilityRole="button"
        accessibilityLabel={`${t('liveEng.qaUpvote')} ${q.upvotes || 0}`}
      >
        <IconThumbsUp size={15} color={q.voted ? '#000' : '#fff'} />
        <Text style={[styles.voteText, q.voted && styles.voteTextOn]}>{q.upvotes || 0}</Text>
      </TouchableOpacity>
    </View>
  );
});

export const LiveQASheet = memo(function LiveQASheet({ engage, isHost }) {
  const { t } = useLanguage();
  const sheet = useEngageSelector(engage, selSheet);
  const questions = useEngageSelector(engage, selQuestions);
  const visible = sheet === 'qa';
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => { if (!visible) setNotice(''); }, [visible]);

  const ordered = (questions || []).slice().sort((a, b) => {
    const rank = (s) => (s === 'highlighted' ? 0 : s === 'open' ? 1 : 2);
    return (rank(a.status) - rank(b.status)) || ((b.upvotes || 0) - (a.upvotes || 0)) || (a.id - b.id);
  });

  const ask = useCallback(async () => {
    const v = text.trim();
    if (!v || busy) return;
    setBusy(true); setNotice('');
    try {
      const r = await engage.qaAsk(v);
      if (r?.success) { setText(''); setNotice(t('liveEng.qaSent')); }
      else if (r?.data?.code === 'rate_limited') setNotice(t('liveEng.qaTooFast'));
      else if (r?.data?.code === 'filtered') setNotice(t('live.commentBlocked'));
      else setNotice(t('liveEng.qaFailed'));
    } catch { setNotice(t('liveEng.qaFailed')); }
    setBusy(false);
  }, [text, busy, engage, t]);

  const onUpvote = useCallback((id) => { engage.qaUpvote(id); }, [engage]);
  const onHighlight = useCallback(async (id) => {
    const r = await engage.qaHighlight(id).catch(() => null);
    if (!r?.success) setNotice(t('liveEng.qaFailed'));
  }, [engage, t]);
  const onDismiss = useCallback(async (id) => {
    const r = await engage.qaDismiss(id).catch(() => null);
    if (!r?.success) setNotice(t('liveEng.qaFailed'));
  }, [engage, t]);

  if (!visible) return null;
  const close = () => engage?.closeSheet();
  return (
    <Modal visible transparent animationType="slide" onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close} accessibilityRole="button" accessibilityLabel={t('common.close')} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <IconHelpCircle size={18} color="#fff" />
            <Text style={styles.title}>{t('liveEng.qaTitle')}</Text>
            <Text style={styles.count}>{ordered.length}</Text>
            <TouchableOpacity onPress={close} style={styles.close} accessibilityRole="button" accessibilityLabel={t('common.close')}>
              <IconX size={18} color="#fff" />
            </TouchableOpacity>
          </View>
          <Text style={styles.hint}>{isHost ? t('liveEng.qaHostHint') : t('liveEng.qaViewerHint')}</Text>

          {ordered.length ? (
            <FlatList
              data={ordered}
              keyExtractor={(q) => String(q.id)}
              renderItem={({ item }) => (
                <QRow q={item} isHost={isHost} onUpvote={onUpvote} onHighlight={onHighlight} onDismiss={onDismiss} t={t} />
              )}
              style={{ maxHeight: 380 }}
              keyboardShouldPersistTaps="handled"
              initialNumToRender={10}
              windowSize={5}
            />
          ) : (
            <Text style={styles.empty}>{t('liveEng.qaEmpty')}</Text>
          )}

          {notice ? <Text style={styles.notice}>{notice}</Text> : null}

          {!isHost ? (
            <View style={styles.askRow}>
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder={t('liveEng.qaPlaceholder')}
                placeholderTextColor="rgba(255,255,255,0.45)"
                style={styles.input}
                maxLength={200}
                returnKeyType="send"
                onSubmitEditing={ask}
                accessibilityLabel={t('liveEng.qaPlaceholder')}
              />
              <TouchableOpacity
                onPress={ask}
                disabled={!text.trim() || busy}
                style={[styles.send, (!text.trim() || busy) && { opacity: 0.4 }]}
                accessibilityRole="button"
                accessibilityLabel={t('liveEng.qaAsk')}
              >
                {busy ? <ActivityIndicator color="#000" size="small" /> : <IconSend size={17} color="#000" />}
              </TouchableOpacity>
            </View>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
});

export const LiveQAHighlightCard = memo(function LiveQAHighlightCard({ engage, isHost, top }) {
  const { t } = useLanguage();
  const q = useEngageSelector(engage, selHighlighted);
  const anim = useRef(new Animated.Value(0)).current;
  const [shown, setShown] = useState(q);

  useEffect(() => {
    if (q) {
      setShown(q);
      anim.setValue(0);
      Animated.spring(anim, { toValue: 1, friction: 7, tension: 90, useNativeDriver: true }).start();
    } else {
      Animated.timing(anim, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => setShown(null));
    }
  }, [q, anim]);

  if (!shown) return null;
  return (
    <Animated.View
      pointerEvents="box-none"
      style={[styles.card, { top }, {
        opacity: anim,
        transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-10, 0] }) }, { scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) }],
      }]}
    >
      <View style={styles.cardHead}>
        <IconHelpCircle size={13} color="#000" />
        <Text style={styles.cardLabel}>{t('liveEng.qaQuestion')}</Text>
        <Text style={styles.cardName} numberOfLines={1}>{shown.asker_name}</Text>
        {isHost ? (
          <TouchableOpacity
            onPress={() => engage?.qaHighlight(0)}
            style={styles.cardClose}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={t('liveEng.qaUnhighlight')}
          >
            <IconX size={14} color="#000" />
          </TouchableOpacity>
        ) : null}
      </View>
      <Text style={styles.cardText} numberOfLines={4}>{shown.text}</Text>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    backgroundColor: '#0b0b0b', borderTopLeftRadius: 22, borderTopRightRadius: 22,
    borderTopWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: Platform.OS === 'ios' ? 30 : 16,
  },
  handle: { alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.25)', marginBottom: 6 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { color: '#fff', fontSize: 16, fontWeight: '800' },
  count: { flex: 1, color: 'rgba(255,255,255,0.5)', fontSize: 13, fontWeight: '700' },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  hint: { color: 'rgba(255,255,255,0.55)', fontSize: 12, marginBottom: 8 },
  empty: { color: 'rgba(255,255,255,0.6)', fontSize: 13, textAlign: 'center', marginVertical: 26 },
  notice: { color: 'rgba(255,255,255,0.85)', fontSize: 12, textAlign: 'center', marginTop: 8 },
  qRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 10, paddingHorizontal: 8,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.08)', borderRadius: 12,
  },
  qRowHl: { backgroundColor: 'rgba(255,255,255,0.08)', borderBottomColor: 'transparent' },
  qMeta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  qName: { color: 'rgba(255,255,255,0.7)', fontSize: 12, fontWeight: '800', flexShrink: 1 },
  qTag: {
    color: '#000', backgroundColor: '#fff', fontSize: 9, fontWeight: '900', letterSpacing: 0.4,
    paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, overflow: 'hidden', textTransform: 'uppercase',
  },
  qTagDim: { backgroundColor: 'rgba(255,255,255,0.18)', color: '#fff' },
  qText: { color: '#fff', fontSize: 14, lineHeight: 19, marginTop: 2 },
  qActions: { flexDirection: 'row', gap: 8, marginTop: 8 },
  qBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5, height: 32, paddingHorizontal: 12, borderRadius: 16,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)',
  },
  qBtnPrimary: { backgroundColor: '#fff', borderColor: '#fff' },
  qBtnText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  qBtnTextPrimary: { color: '#000' },
  vote: {
    minWidth: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
  },
  voteOn: { backgroundColor: '#fff', borderColor: '#fff' },
  voteText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  voteTextOn: { color: '#000' },
  askRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  input: {
    flex: 1, height: 46, borderRadius: 23, paddingHorizontal: 16, color: '#fff', fontSize: 14,
    backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)',
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  send: { width: 46, height: 46, borderRadius: 23, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  card: {
    position: 'absolute', left: 12, right: 76, zIndex: 30,
    backgroundColor: 'rgba(255,255,255,0.94)', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 9,
    ...(Platform.OS === 'web' ? { boxShadow: '0 6px 20px rgba(0,0,0,0.35)' } : { elevation: 4 }),
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardLabel: { color: '#000', fontSize: 10, fontWeight: '900', letterSpacing: 0.6, textTransform: 'uppercase' },
  cardName: { flex: 1, color: 'rgba(0,0,0,0.6)', fontSize: 11, fontWeight: '700' },
  cardClose: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  cardText: { color: '#000', fontSize: 14, lineHeight: 19, fontWeight: '600', marginTop: 3 },
});
