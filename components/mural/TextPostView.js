// [mural 2026-10-20] Tela 3 do mockup: post de TEXTO aberto.
// Cartão grande estilo X/Facebook (texto maior quando é curto), pilha de avatares
// de quem curtiu, contadores, Curtir | Comentar | Compartilhar e os comentários
// na MESMA tela, com o campo de comentar fixo acima do teclado.
import React, { useCallback, useRef, useState, useEffect } from 'react';
import { View, Text, Pressable, ScrollView, Platform, StatusBar, StyleSheet, Keyboard } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLanguage } from '../../context/LanguageContext';
import { useAuth } from '../../context/AuthContext';
import MIcon from './MuralIcons';
import { useMuralTheme, LIKE } from './muralTheme';
import { Avatar, AnimatedHeart, LikersStack, fullWhen, audienceIcon, count, displayName, handle, sharePost } from './parts';
import { CommentsBody, CommentBar, quickReplies } from './CommentsList';
import { usePostMenu } from './PostViewer';
import useKeyboardSpacer from './useKeyboardSpacer';
import * as store from '../../services/muralStore';

export default function TextPostView({ postId, onBack, onEdit, onReport, onDeleted, onOpenLikers, focusComment = false }) {
  const th = useMuralTheme();
  const { t } = useLanguage();
  const { user } = useAuth() || {};
  const insets = useSafeAreaInsets();
  const post = store.usePost(postId);
  const barRef = useRef(null);
  // [kb-fix v2 20/10] campo grudado no teclado: espaço = altura do teclado (a tela vai até o fundo)
  const { pad: kbPad, onLayout: kbLayout } = useKeyboardSpacer();
  const scrollRef = useRef(null);
  const { openMenu, mine } = usePostMenu(post, { onEdit, onDeleted, onReport });
  const onReply = useCallback((c) => barRef.current?.replyTo(c), []);
  const onReportComment = useCallback((c) => onReport?.({ content_type: 'comment', content_id: c.id }), [onReport]);
  const [kb, setKb] = useState(false);
  useEffect(() => {
    const a = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setKb(true));
    const b = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKb(false));
    return () => { a.remove(); b.remove(); };
  }, []);
  useEffect(() => {
    if (!focusComment) return undefined;
    const id = setTimeout(() => barRef.current?.focus(), 420);
    return () => clearTimeout(id);
  }, [focusComment]);
  if (!post) return null;
  const text = post.caption || '';
  const big = text.length < 90;
  const name = displayName(post);
  const commentsLine = [
    post.comments === 1 ? t('mural.oneComment', '1 comentário') : t('mural.nComments', { n: count(post.comments || 0, t), defaultValue: `${count(post.comments || 0, t)} comentários` }),
    post.shares > 0 ? (post.shares === 1 ? t('mural.oneShare', '1 envio') : t('mural.nShares', { n: count(post.shares, t), defaultValue: `${count(post.shares, t)} envios` })) : null,
  ].filter(Boolean).join(' · ');
  const tact = (on) => ({ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 10, borderRadius: 10, backgroundColor: on ? th.chip : 'transparent' });
  return (
    <View style={{ flex: 1, backgroundColor: th.bg }} onLayout={kbLayout}>
      <StatusBar barStyle={th.isDark ? 'light-content' : 'dark-content'} />
      <View style={{ paddingTop: insets.top, height: insets.top + 50, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', backgroundColor: th.bg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: th.line, zIndex: 5 }}>
        <Pressable onPress={onBack} hitSlop={8} style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel={t('common.back', 'Voltar')}>
          <MIcon name="back" size={24} color={th.text} />
        </Pressable>
        <Text style={{ flex: 1, textAlign: 'center', color: th.text, fontSize: 16, fontWeight: '700' }}>{t('mural.post', 'Publicação')}</Text>
        <Pressable onPress={openMenu} hitSlop={8} style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel={t('mural.more', 'Mais opções')}>
          <MIcon name="more" size={24} color={th.text} />
        </Pressable>
      </View>
      <View style={{ flex: 1 }}>
        <ScrollView ref={scrollRef} style={{ flex: 1 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" contentContainerStyle={{ paddingBottom: 16, maxWidth: 680, width: '100%', alignSelf: 'center' }}>
          <View style={{ backgroundColor: th.card, marginTop: 12, marginHorizontal: 12, borderRadius: 22, paddingTop: 18, paddingHorizontal: 18, paddingBottom: 8, ...(th.isDark ? {} : { shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 1 }) }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Avatar email={post.author_email} name={name} uri={post.author_avatar} size={40} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: th.text, fontSize: 15, fontWeight: '700' }} numberOfLines={1}>{name}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Text style={{ color: th.muted, fontSize: 13, flexShrink: 1 }} numberOfLines={1}>{`@${handle(post)} · ${fullWhen(post.created_at, t)} ·`}</Text>
                  <MIcon name={audienceIcon(post.audience)} size={14} color={th.muted} />
                </View>
              </View>
            </View>
            <Text selectable style={{ color: th.text, marginTop: 14, fontSize: big ? 26 : 19, lineHeight: big ? 34 : 27, fontWeight: big ? '600' : '400', letterSpacing: big ? -0.4 : 0 }}>{text}</Text>
            {post.edited_at ? <Text style={{ color: th.muted, fontSize: 12, marginTop: 6 }}>{t('mural.edited', 'editado')}</Text> : null}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, paddingTop: 14, paddingBottom: 10, marginTop: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: th.line }}>
              <Pressable onPress={() => post.likes > 0 && onOpenLikers?.()} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }} disabled={!post.likes}>
                <LikersStack likers={post.likers} border={th.card} />
                <Text style={{ color: th.muted, fontSize: 13.5 }} numberOfLines={1}>
                  {post.likes === 1 ? t('mural.oneLike', '1 curtida') : t('mural.nLikes', { n: count(post.likes || 0, t), defaultValue: `${count(post.likes || 0, t)} curtidas` })}
                </Text>
              </Pressable>
              <Text style={{ color: th.muted, fontSize: 13.5 }} numberOfLines={1}>{commentsLine}</Text>
            </View>
            <View style={{ flexDirection: 'row', paddingVertical: 4 }}>
              <Pressable onPress={() => store.toggleLike(postId)} style={({ pressed }) => [tact(pressed), { flex: 1 }]} accessibilityRole="button" accessibilityState={{ selected: !!post.liked }}>
                <AnimatedHeart liked={post.liked} size={22} color={th.muted} />
                <Text style={{ color: post.liked ? LIKE : th.muted, fontWeight: '600', fontSize: 13.5 }}>{t('mural.like', 'Curtir')}</Text>
              </Pressable>
              <Pressable onPress={() => barRef.current?.focus()} disabled={post.allow_comments === false} style={({ pressed }) => [tact(pressed), { flex: 1.1 }]} accessibilityRole="button">
                <MIcon name="comment" size={22} color={th.muted} />
                <Text style={{ color: th.muted, fontWeight: '600', fontSize: 13.5 }}>{t('mural.comment', 'Comentar')}</Text>
              </Pressable>
              <Pressable onPress={() => sharePost(post, t)} style={({ pressed }) => [tact(pressed), { flex: 1.3 }]} accessibilityRole="button">
                <MIcon name="share" size={22} color={th.muted} />
                <Text style={{ color: th.muted, fontWeight: '600', fontSize: 13.5 }}>{t('mural.share', 'Compartilhar')}</Text>
              </Pressable>
            </View>
          </View>
          <Text style={{ color: th.text, paddingTop: 16, paddingHorizontal: 16, paddingBottom: 4, fontWeight: '700', fontSize: 16 }}>{t('mural.comments', 'Comentários')}</Text>
          <CommentsBody postId={postId} th={th} me={user?.email} isPostOwner={mine} onReply={onReply} onReport={onReportComment} />
        </ScrollView>
        <View style={{ backgroundColor: th.card, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: th.line }}>
          <CommentBar ref={barRef} postId={postId} th={th} disabled={post.allow_comments === false}
            quick={post.allow_comments !== false && !(post.comments > 0) ? quickReplies('text', t) : null}
            placeholder={t('mural.writeComment', 'Escreva um comentário...')}
            bottomPad={kb || kbPad > 0 ? 0 : Math.max(insets.bottom, 8)}
            onSent={() => setTimeout(() => { try { scrollRef.current?.scrollToEnd({ animated: true }); } catch {} }, 150)} />
        </View>
        {kbPad > 0 ? <View style={{ height: kbPad, backgroundColor: th.card }} /> : null}
      </View>
    </View>
  );
}
