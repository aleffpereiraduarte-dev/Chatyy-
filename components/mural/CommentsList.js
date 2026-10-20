// [mural 2026-10-20] Lista de comentários (tela 3 e tela 6 do mockup) + barra de
// comentar. Respostas indentadas (1 nível), curtir comentário, "Responder",
// otimista com "Tentar de novo", apagar o próprio (ou qualquer um, se o post é meu).
import React, { useCallback, useMemo, useRef, useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import { View, Text, Pressable, TextInput, ActivityIndicator, Platform, ScrollView, Keyboard } from 'react-native';
import { useLanguage } from '../../context/LanguageContext';
import { useAuth } from '../../context/AuthContext';
import MIcon from './MuralIcons';
import { LIKE } from './muralTheme';
import { Avatar, AnimatedHeart, shortAgo, count } from './parts';
import * as store from '../../services/muralStore';

function _menu(opts) {
  try { require('../../services/profilePostComposer').showActionMenu(opts); } catch {}
}
function _copy(text) {
  try {
    if (Platform.OS === 'web') { navigator?.clipboard?.writeText?.(text); return; }
    const C = require('expo-clipboard');
    C.setStringAsync(String(text || ''));
  } catch {}
}

export function CommentRow({ c, reply, postId, isPostOwner, me, th, onReply, onReport }) {
  const { t } = useLanguage();
  const mine = c.is_mine === true || (me && c.email && String(c.email).toLowerCase() === String(me).toLowerCase());
  const canDelete = c.can_delete === true || mine || isPostOwner || c.failed;
  const name = c.name || (c.email ? String(c.email).split('@')[0] : t('mural.anon', 'Anônimo'));
  const openMenu = useCallback(() => {
    const opts = [];
    if (!c.failed && !c.pending) opts.push({ label: t('mural.reply', 'Responder'), onPress: () => onReply?.(c) });
    opts.push({ label: t('mural.copy', 'Copiar'), onPress: () => _copy(c.content) });
    if (canDelete) opts.push({ label: t('mural.deleteComment', 'Apagar comentário'), destructive: true, onPress: () => store.deleteComment(postId, c) });
    if (!mine && !c.pending && !c.failed && onReport) opts.push({ label: t('mural.report', 'Denunciar'), destructive: true, onPress: () => onReport(c) });
    _menu({ options: opts, cancelLabel: t('common.cancel', 'Cancelar') });
  }, [c, canDelete, mine, postId, onReply, onReport, t]);
  const av = reply ? 26 : 34;
  return (
    <Pressable onLongPress={openMenu} delayLongPress={350}
      style={{ flexDirection: 'row', gap: 10, paddingVertical: 9, paddingRight: 10, paddingLeft: reply ? 60 : 16, opacity: c.pending ? 0.6 : 1 }}>
      <Avatar email={c.email} name={name} uri={c.avatar} size={av} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ color: th.text, fontSize: 14.5, lineHeight: 20 }}>
          <Text style={{ fontWeight: '700', fontSize: 14 }}>{name}</Text>
          {'  '}{c.content}
        </Text>
        <View style={{ flexDirection: 'row', gap: 14, marginTop: 4, alignItems: 'center' }}>
          {c.failed ? (
            <Pressable onPress={() => store.retryComment(postId, c)} hitSlop={6} accessibilityRole="button">
              <Text style={{ color: th.danger, fontSize: 12.5, fontWeight: '600' }}>{t('mural.notSent', 'Não enviado · Tentar de novo')}</Text>
            </Pressable>
          ) : c.pending ? (
            <Text style={{ color: th.muted, fontSize: 12.5, fontWeight: '500' }}>{t('mural.sending', 'Enviando…')}</Text>
          ) : (
            <>
              <Text style={{ color: th.muted, fontSize: 12.5, fontWeight: '500' }}>{shortAgo(c.created_at, t)}</Text>
              {c.likes > 0 ? <Text style={{ color: th.muted, fontSize: 12.5, fontWeight: '500' }}>{c.likes === 1 ? t('mural.oneLike', '1 curtida') : t('mural.nLikes', { n: count(c.likes, t), defaultValue: `${count(c.likes, t)} curtidas` })}</Text> : null}
              <Pressable onPress={() => onReply?.(c)} hitSlop={8} accessibilityRole="button">
                <Text style={{ color: th.muted, fontSize: 12.5, fontWeight: '600' }}>{t('mural.reply', 'Responder')}</Text>
              </Pressable>
              {canDelete ? (
                <Pressable onPress={openMenu} hitSlop={8} accessibilityLabel={t('mural.more', 'Mais opções')}>
                  <MIcon name="more" size={16} color={th.muted} />
                </Pressable>
              ) : null}
            </>
          )}
        </View>
      </View>
      {!c.pending && !c.failed ? (
        <Pressable onPress={() => store.toggleCommentLike(postId, c)} hitSlop={8} style={{ alignSelf: 'flex-start', padding: 4, alignItems: 'center' }}
          accessibilityRole="button" accessibilityLabel={c.liked ? t('mural.unlike', 'Descurtir') : t('mural.like', 'Curtir')}>
          <AnimatedHeart liked={c.liked} size={16} color={th.muted} />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

/** Corpo da lista (sem ScrollView próprio: quem usa decide a rolagem). */
export function CommentsBody({ postId, th, me, isPostOwner, onReply, onReport, emptyHint = true }) {
  const { t } = useLanguage();
  const st = store.useComments(postId);
  const items = st?.items || [];
  if (!st || (!st.loaded && st.loading)) {
    return <View style={{ paddingVertical: 28, alignItems: 'center' }}><ActivityIndicator color={th.muted} /></View>;
  }
  if (st.error && !st.loaded) {
    return (
      <Pressable onPress={() => store.loadComments(postId)} style={{ paddingVertical: 26, alignItems: 'center' }}>
        <Text style={{ color: th.muted, fontSize: 14 }}>{t('mural.loadFail', 'Não foi possível carregar. Toque para tentar de novo.')}</Text>
      </Pressable>
    );
  }
  if (!items.length) {
    if (!emptyHint) return null;
    return (
      <View style={{ paddingVertical: 34, alignItems: 'center', gap: 6, paddingHorizontal: 24 }}>
        <Text style={{ color: th.text, fontSize: 16, fontWeight: '700' }}>{t('mural.noComments', 'Ainda sem comentários')}</Text>
        <Text style={{ color: th.muted, fontSize: 14, textAlign: 'center' }}>{t('mural.beFirst', 'Seja a primeira pessoa a comentar.')}</Text>
      </View>
    );
  }
  return (
    <View style={{ paddingTop: 6 }}>
      {items.map((c) => {
        const hidden = Math.max(0, (c.reply_count || 0) - (c.replies || []).filter((r) => !r.pending && !r.failed).length);
        return (
          <View key={String(c.id)}>
            <CommentRow c={c} postId={postId} th={th} me={me} isPostOwner={isPostOwner} onReply={onReply} onReport={onReport} />
            {(c.replies || []).map((r) => (
              <CommentRow key={String(r.id)} c={r} reply postId={postId} th={th} me={me} isPostOwner={isPostOwner} onReply={onReply} onReport={onReport} />
            ))}
            {hidden > 0 || c._rmore ? (
              <Pressable onPress={() => store.loadReplies(postId, c)} hitSlop={6} style={{ paddingLeft: 60, paddingVertical: 6, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View style={{ width: 24, height: 1, backgroundColor: th.muted, opacity: 0.5 }} />
                <Text style={{ color: th.muted, fontSize: 13, fontWeight: '600' }}>
                  {hidden === 1 ? t('mural.moreReply', 'Ver mais 1 resposta') : t('mural.moreReplies', { n: hidden || '', defaultValue: `Ver mais ${hidden || ''} respostas` })}
                </Text>
              </Pressable>
            ) : null}
          </View>
        );
      })}
      {st.hasMore ? (
        <Pressable onPress={() => store.loadComments(postId, { more: true })} style={{ paddingVertical: 14, alignItems: 'center' }}>
          {st.loading ? <ActivityIndicator color={th.muted} /> : <Text style={{ color: th.muted, fontSize: 14, fontWeight: '600' }}>{t('mural.loadMoreComments', 'Ver mais comentários')}</Text>}
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * Campo de comentar fixo (avatar + pílula + enviar). `quick` = chips de resposta
 * rápida acima. ref.focus() / ref.replyTo(comment).
 */
export const CommentBar = forwardRef(function CommentBar({ postId, th, quick, placeholder, style, disabled, bottomPad = 0, onSent, variant = 'light' }, ref) {
  const { t } = useLanguage();
  const { user } = useAuth() || {};
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const inputRef = useRef(null);
  const me = useMemo(() => ({ email: user?.email || '', name: user?.name || user?.display_name || '', avatar: user?.avatar_url || '' }), [user?.email, user?.name, user?.display_name, user?.avatar_url]);
  useImperativeHandle(ref, () => ({
    focus: () => { try { inputRef.current?.focus(); } catch {} },
    replyTo: (c) => {
      setReplyTo(c || null);
      if (c && c.name) {
        const tag = `@${c.username || String(c.email || '').split('@')[0] || c.name} `;
        setText((cur) => (cur.startsWith('@') ? cur : tag + cur));
      }
      setTimeout(() => { try { inputRef.current?.focus(); } catch {} }, 30);
    },
  }), []);
  const send = useCallback((override) => {
    const v = String(override != null ? override : text).trim();
    if (!v || disabled) return;
    store.addComment(postId, v, { replyTo, me }).then((r) => { if (r && r.ok === false && r.error && /comments_disabled/i.test(r.error)) { try { require('../ui/Toast').showToast({ message: t('mural.commentsOff', 'Comentários desativados neste post'), kind: 'error' }); } catch {} } });
    setText('');
    setReplyTo(null);
    onSent?.();
  }, [text, disabled, postId, replyTo, me, onSent, t]);
  const dark = variant === 'dark';
  const fieldBg = dark ? 'transparent' : th.bg;
  const fieldBorder = dark ? '#3a3a3c' : th.line;
  const fg = dark ? '#fff' : th.text;
  const muted = dark ? '#8e8e93' : th.muted;
  const firstName = (me.name || '').split(' ')[0];
  return (
    <View style={style}>
      {quick && quick.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={{ gap: 6, paddingHorizontal: 12, paddingTop: 8 }}>
          {quick.map((q) => (
            <Pressable key={q} onPress={() => send(q)} disabled={disabled} style={({ pressed }) => ({ paddingHorizontal: 11, paddingVertical: 5, borderRadius: 999, backgroundColor: th.chip, opacity: pressed ? 0.6 : 1 })}>
              <Text style={{ color: th.text, fontSize: 13 }}>{q}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      {replyTo ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 8, gap: 8 }}>
          <Text style={{ flex: 1, color: muted, fontSize: 12.5 }} numberOfLines={1}>{t('mural.replyingTo', { name: replyTo.name || '', defaultValue: `Respondendo a ${replyTo.name || ''}` })}</Text>
          <Pressable onPress={() => { setReplyTo(null); setText((cur) => cur.replace(/^@\S+\s/, '')); }} hitSlop={8} accessibilityLabel={t('common.cancel', 'Cancelar')}>
            <MIcon name="x" size={14} color={muted} />
          </Pressable>
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 10 + bottomPad }}>
        <Avatar email={me.email} name={me.name || me.email} uri={me.avatar} size={32} />
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: fieldBorder, backgroundColor: fieldBg, borderRadius: 20, paddingLeft: 14, paddingRight: 4, minHeight: 38 }}>
          <TextInput
            ref={inputRef}
            value={text}
            onChangeText={(v) => setText(v.slice(0, 1000))}
            placeholder={disabled ? t('mural.commentsOff', 'Comentários desativados neste post') : (placeholder || (firstName ? t('mural.commentAs', { name: firstName, defaultValue: `Comentar como ${firstName}...` }) : t('mural.addComment', 'Adicione um comentário...')))}
            placeholderTextColor={muted}
            editable={!disabled}
            multiline
            style={{ flex: 1, color: fg, fontSize: 14.5, paddingVertical: Platform.OS === 'ios' ? 9 : 6, maxHeight: 110 }}
            onSubmitEditing={Platform.OS === 'web' ? () => send() : undefined}
            blurOnSubmit={false}
            accessibilityLabel={t('mural.addComment', 'Adicione um comentário...')}
          />
          {text.trim() ? (
            <Pressable onPress={() => send()} hitSlop={6} accessibilityRole="button" accessibilityLabel={t('mural.send', 'Enviar')}
              style={({ pressed }) => ({ width: 30, height: 30, borderRadius: 15, backgroundColor: dark ? '#fff' : th.accent, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}>
              <MIcon name="up" size={17} color={dark ? '#000' : th.accentInk} strokeWidth={2.2} />
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
});

export function quickReplies(kind, t) {
  const raw = kind === 'photo' ? t('mural.quickPhoto', 'Que lindo|Amei|Onde é?|Saudade') : t('mural.quickText', 'Concordo|Boa!|Verdade|Amei');
  return String(raw).split('|').map((s) => s.trim()).filter(Boolean).slice(0, 6);
}

/** Abre a denúncia de um comentário/post (ReportSheet nativo). Devolve setter. */
export function useReport({ native = true } = {}) {
  const [target, setTarget] = useState(null);
  const ReportSheet = useMemo(() => { try { return require('../ReportSheet').default; } catch { return null; } }, []);
  const node = ReportSheet && target ? (
    <ReportSheet visible={!!target} onClose={() => setTarget(null)} target={target} native={native} fromModal={false} />
  ) : null;
  return { report: setTarget, reportNode: node };
}

export default CommentsBody;
