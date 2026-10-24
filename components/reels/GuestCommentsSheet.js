// [guest-reels 2026-10-22] Comentários do Reels SEM LOGIN — só leitura (reels_public_comments).
// Camada absoluta dentro do ReelsViewer (não é <Modal>): o "Entre para comentar…" abre a folha
// de conta por cima sem empilhar Modals no iOS. Mostra só @, nome público e avatar público.
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, Animated, Easing, Platform, FlatList, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import AvatarCircle from '../AvatarCircle';
import { guestReelComments } from '../../services/guestReels';
import { MentionText } from '../comments/mentions'; // [2026-10-24 coment-mencao] visitante: só destaque

const isWeb = Platform.OS === 'web';

function _ago(dateStr, t) {
  if (!dateStr) return '';
  const s = String(dateStr);
  const str = s.endsWith('Z') || s.includes('+') ? s : s.replace(' ', 'T') + 'Z';
  const then = new Date(str).getTime();
  if (!Number.isFinite(then)) return '';
  const mins = Math.max(0, Math.floor((Date.now() - then) / 60000));
  if (mins < 1) return t?.('time.now') || 'agora';
  if (mins < 60) return (t?.('time.min') || '{n}m').replace('{n}', mins);
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return (t?.('time.hours') || '{n}h').replace('{n}', hrs);
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  const d = new Date(str);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

export default function GuestCommentsSheet({ visible, reel, t, onClose, onRequireAuth }) {
  const insets = useSafeAreaInsets();
  const anim = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(!!visible);
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const reqRef = useRef(0);
  const tr = (k, fb) => { try { const v = t?.(k); return v && v !== k ? v : fb; } catch { return fb; } };

  const load = useCallback(async (more) => {
    if (!reel?.id) return;
    const my = ++reqRef.current;
    setLoading(true); setError(false);
    try {
      const r = await guestReelComments(reel.id, more ? cursor : null);
      if (my !== reqRef.current) return;
      if (!r || !r.success) { setError(true); return; }
      const d = r.data || {};
      setDisabled(!!d.disabled);
      const list = Array.isArray(d.comments) ? d.comments : [];
      setItems((prev) => (more ? prev.concat(list.filter((c) => !prev.some((p) => p.id === c.id))) : list));
      setCursor(d.next_cursor || null);
    } catch { if (my === reqRef.current) setError(true); }
    finally { if (my === reqRef.current) setLoading(false); }
  }, [reel?.id, cursor]);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      setItems([]); setCursor(null); setDisabled(reel?.allow_comments === false);
      if (reel?.allow_comments !== false) load(false);
      Animated.timing(anim, { toValue: 1, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: !isWeb }).start();
    } else if (mounted) {
      reqRef.current++;
      Animated.timing(anim, { toValue: 0, duration: 180, easing: Easing.in(Easing.quad), useNativeDriver: !isWeb }).start(({ finished }) => { if (finished) setMounted(false); });
    }
  }, [visible, reel?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!mounted) return null;
  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [520, 0] });
  const count = Number(reel?.comment_count ?? reel?.comments_count) || 0;
  const renderItem = ({ item }) => {
    const who = item.anon ? (item.anon_tag || tr('guestReels.anon', 'Anônimo')) : (item.name || (item.handle ? '@' + item.handle : 'Chatyy'));
    return (
      <View style={styles.row}>
        <AvatarCircle name={who} uri={item.avatar_url || undefined} size={34} />
        <View style={{ flex: 1, marginLeft: 10 }}>
          <Text style={styles.who} numberOfLines={1}>
            {who}{item.handle && !item.anon ? <Text style={styles.handle}>{'  @' + item.handle}</Text> : null}
            <Text style={styles.time}>{'  ' + _ago(item.created_at, t)}</Text>
          </Text>
          {item.text ? <Text style={styles.text}><MentionText text={item.text} linkable={false} mentionStyle={{ color: '#e0f1ff' }} /></Text> : null}
          {!item.text && item.has_media ? <Text style={styles.media}>{tr('guestReels.commentMedia', 'Comentário com mídia — abra no app')}</Text> : null}
          {item.reply_count > 0 ? (
            <Pressable onPress={() => onRequireAuth?.('comment')} hitSlop={6}>
              <Text style={styles.replies}>{tr('guestReels.replies', '{n} respostas').replace('{n}', String(item.reply_count))}</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  };
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={visible ? 'auto' : 'none'} accessibilityViewIsModal>
      <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, { opacity: anim }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel={tr('common.close', 'Fechar')} />
      </Animated.View>
      <Animated.View style={[styles.sheet, { transform: [{ translateY }] }]}>
        <View style={styles.header}>
          <View style={{ width: 36 }} />
          <Text style={styles.title} accessibilityRole="header">
            {tr('guestReels.comments', 'Comentários')}{count > 0 ? ` · ${count}` : ''}
          </Text>
          <Pressable onPress={onClose} hitSlop={10} style={styles.close} accessibilityRole="button" accessibilityLabel={tr('common.close', 'Fechar')}>
            <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.2} strokeLinecap="round"><Path d="M6 6l12 12M18 6L6 18" /></Svg>
          </Pressable>
        </View>
        <FlatList
          data={items}
          keyExtractor={(c) => String(c.id)}
          renderItem={renderItem}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 12, flexGrow: 1 }}
          onEndReached={() => { if (cursor && !loading) load(true); }}
          onEndReachedThreshold={0.4}
          ListEmptyComponent={
            <View style={styles.empty}>
              {loading ? <ActivityIndicator color="#fff" /> : (
                <>
                  <Text style={styles.emptyText}>
                    {disabled ? tr('guestReels.commentsDisabled', 'Os comentários estão desligados.')
                      : error ? tr('guestReels.commentsError', 'Não foi possível carregar os comentários.')
                      : tr('guestReels.commentsEmpty', 'Ainda não há comentários. Entre e seja o primeiro.')}
                  </Text>
                  {error ? (
                    <Pressable onPress={() => load(false)} style={styles.retry} accessibilityRole="button">
                      <Text style={styles.retryText}>{tr('reels.videoRetry', 'Tentar de novo')}</Text>
                    </Pressable>
                  ) : null}
                </>
              )}
            </View>
          }
          ListFooterComponent={items.length > 0 && loading ? <ActivityIndicator color="#fff" style={{ marginVertical: 12 }} /> : null}
        />
        {!disabled ? (
          <Pressable
            onPress={() => onRequireAuth?.('comment')}
            style={[styles.composer, { marginBottom: Math.max(insets.bottom, 10) }]}
            accessibilityRole="button"
          >
            <Text style={styles.composerText}>{tr('guestReels.commentPh', 'Entre para comentar…')}</Text>
          </Pressable>
        ) : <View style={{ height: Math.max(insets.bottom, 10) }} />}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0, height: '68%',
    backgroundColor: '#141414', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    alignSelf: 'center', width: '100%', maxWidth: 620,
    ...(isWeb ? { marginHorizontal: 'auto' } : null),
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.12)' },
  title: { color: '#fff', fontSize: 16, fontWeight: '700' },
  close: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 10 },
  who: { color: 'rgba(255,255,255,0.92)', fontSize: 13, fontWeight: '700' },
  handle: { color: 'rgba(255,255,255,0.5)', fontWeight: '500' },
  time: { color: 'rgba(255,255,255,0.42)', fontWeight: '500' },
  text: { color: '#fff', fontSize: 15, lineHeight: 20, marginTop: 2 },
  media: { color: 'rgba(255,255,255,0.55)', fontSize: 14, fontStyle: 'italic', marginTop: 2 },
  replies: { color: 'rgba(255,255,255,0.55)', fontSize: 13, fontWeight: '600', marginTop: 6 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 40, paddingHorizontal: 24 },
  emptyText: { color: 'rgba(255,255,255,0.6)', fontSize: 15, textAlign: 'center' },
  retry: { marginTop: 14, paddingHorizontal: 18, paddingVertical: 9, borderRadius: 18, borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)' },
  retryText: { color: '#fff', fontWeight: '700' },
  composer: { marginHorizontal: 12, marginTop: 6, minHeight: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.08)', justifyContent: 'center', paddingHorizontal: 16 },
  composerText: { color: 'rgba(255,255,255,0.55)', fontSize: 15 },
});
