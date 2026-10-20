// [mural 2026-10-20] Tela 6 do mockup: folha de comentários sobre o post.
// iOS/Android: folha DO SISTEMA (components/NativeSheet → rota formSheet), nunca
// <Modal> sobre <Modal>. Web: Modal com arrastar para fechar.
// Respostas indentadas, curtir comentário, "Responder", chips de resposta rápida
// e campo fixo acima do teclado; tudo otimista (services/muralStore).
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { View, Text, Pressable, ScrollView, Modal, Platform, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLanguage } from '../../context/LanguageContext';
import { useAuth } from '../../context/AuthContext';
import { USE_NATIVE_SHEETS, NativeSheet, NativeSheetKeyboardView, nativeSheetBottomPad } from '../NativeSheet';
import MIcon from './MuralIcons';
import { useMuralTheme } from './muralTheme';
import { count } from './parts';
import { CommentsBody, CommentBar, quickReplies, useReport } from './CommentsList';
import * as store from '../../services/muralStore';
import { registerCommentsHost } from '../../services/muralNav';
import useDragToDismiss, { DragSheetRoot, DragPanel } from '../ui/useDragToDismiss';

function SheetBody({ postId, onClose, native, focus }) {
  const th = useMuralTheme();
  const { t } = useLanguage();
  const { user } = useAuth() || {};
  const insets = useSafeAreaInsets();
  const post = store.usePost(postId);
  const barRef = useRef(null);
  const scrollRef = useRef(null);
  const { report, reportNode } = useReport();
  const me = user?.email || '';
  const isOwner = !!(post && (post.is_mine || (me && String(post.author_email).toLowerCase() === me.toLowerCase())));
  useEffect(() => {
    if (focus) { const id = setTimeout(() => barRef.current?.focus(), Platform.OS === 'ios' ? 450 : 250); return () => clearTimeout(id); }
    return undefined;
  }, [focus]);
  const n = post ? post.comments : (store.getComments(postId)?.total || 0);
  const onReply = useCallback((c) => barRef.current?.replyTo(c), []);
  const onReport = useCallback((c) => report({ content_type: 'comment', content_id: c.id }), [report]);
  const header = (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 10, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: th.line }}>
      <Text style={{ color: th.text, fontWeight: '700', fontSize: 16 }}>
        {n > 0 ? t('mural.commentsN', { n: count(n, t), defaultValue: `Comentários · ${count(n, t)}` }) : t('mural.comments', 'Comentários')}
      </Text>
      <Pressable onPress={onClose} hitSlop={10} style={{ position: 'absolute', right: 8, top: 2, width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel={t('common.close', 'Fechar')}>
        <MIcon name="x" size={18} color={th.text} />
      </Pressable>
    </View>
  );
  const body = (
    <>
      {header}
      <ScrollView ref={scrollRef} style={{ flex: 1 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" contentContainerStyle={{ paddingBottom: 8 }}>
        <CommentsBody postId={postId} th={th} me={me} isPostOwner={isOwner} onReply={onReply} onReport={onReport} />
      </ScrollView>
      <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: th.line, backgroundColor: th.card }}>
        <CommentBar ref={barRef} postId={postId} th={th} quick={post && post.allow_comments !== false ? quickReplies(post?.kind, t) : null}
          disabled={post ? post.allow_comments === false : false}
          bottomPad={native ? nativeSheetBottomPad(insets, 0) : insets.bottom}
          onSent={() => setTimeout(() => { try { scrollRef.current?.scrollToEnd({ animated: true }); } catch {} }, 120)} />
      </View>
      {reportNode}
    </>
  );
  if (native) {
    return <NativeSheetKeyboardView style={{ flex: 1, backgroundColor: th.card, paddingTop: 8 }}>{body}</NativeSheetKeyboardView>;
  }
  return body;
}

/**
 * <CommentsSheet visible postId onClose focus />
 * Monte numa TELA (rota), nunca dentro de um <Modal> aberto.
 */
export default function CommentsSheet({ visible, postId, onClose, focus = false }) {
  const th = useMuralTheme();
  useEffect(() => {
    if (!visible || !postId) return undefined;
    store.loadComments(postId);
    const un = store.watchPost(postId);
    return un;
  }, [visible, postId]);
  if (USE_NATIVE_SHEETS) {
    return (
      <NativeSheet visible={!!visible && !!postId} onClose={onClose} detents={[0.72, 1]} backgroundColor={th.card}>
        <SheetBody postId={postId} onClose={onClose} native focus={focus} />
      </NativeSheet>
    );
  }
  return <WebSheet visible={!!visible && !!postId} onClose={onClose} th={th}><SheetBody postId={postId} onClose={onClose} focus={focus} /></WebSheet>;
}

function WebSheet({ visible, onClose, th, children }) {
  const drag = useDragToDismiss({ onDismiss: () => { if (typeof onClose === 'function') onClose(); } });
  if (!visible) return null;
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <DragSheetRoot style={{ flex: 1 }}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' }} onPress={onClose}>
          <DragPanel drag={drag} onStartShouldSetResponder={() => true} style={{ height: '72%', backgroundColor: th.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow: 'hidden', maxWidth: 640, width: '100%', alignSelf: 'center' }}>
            <View style={{ width: 38, height: 5, borderRadius: 3, backgroundColor: th.chip, alignSelf: 'center', marginTop: 8 }} />
            {children}
          </DragPanel>
        </Pressable>
      </DragSheetRoot>
    </Modal>
  );
}

/**
 * Host para services/muralNav.openComments(): monte uma vez numa tela (perfil,
 * post) e a folha sobe ali mesmo. Só a tela EM FOCO recebe (o último montado).
 */
export function MuralCommentsHost({ enabled = true }) {
  const [state, setState] = useState(null); // { id, focus }
  useEffect(() => {
    if (!enabled) return undefined;
    return registerCommentsHost((id, opts) => { setState({ id: String(id), focus: !!(opts && opts.focus) }); return true; });
  }, [enabled]);
  return <CommentsSheet visible={!!state} postId={state?.id} focus={state?.focus} onClose={() => setState(null)} />;
}
