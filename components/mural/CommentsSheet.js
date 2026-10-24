// [mural 2026-10-20] Tela 6 do mockup: folha de comentários sobre o post.
// Painel JS em tela cheia (iOS/Android/web) com arrastar para fechar; a folha do
// sistema (NativeSheet) fica atrás do kill switch __chatyy_mural_native_comments.
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
import useKeyboardSpacer from './useKeyboardSpacer';
import useDragToDismiss, { DragSheetRoot, DragPanel } from '../ui/useDragToDismiss';
import { useMentionCloser } from '../comments/mentions'; // [2026-10-24 coment-mencao]

// [kb-fix v2 20/10] Padrão = painel JS em tela cheia (RN Modal sobre a ROTA — nunca
// Modal sobre Modal): fundo do painel = fundo da tela, então o espaço do teclado é
// só a altura que o sistema informa (useKeyboardSpacer) e o campo fica SEMPRE
// colado no teclado; com teclado o painel cresce até o topo (detent "grande") e a
// lista encolhe rolável. A folha nativa (formSheet) cortava o conteúdo na altura
// do detent médio quando o sistema a subia → campo atrás do teclado (build 752).
// Kill switch: globalThis.__chatyy_mural_native_comments = true → folha nativa antiga.
function nativeCommentsOn() {
  try { return USE_NATIVE_SHEETS && globalThis.__chatyy_mural_native_comments === true; } catch { return false; }
}

function SheetBody({ postId, onClose, native, focus, kbPad = 0 }) {
  const th = useMuralTheme();
  const { t } = useLanguage();
  const { user } = useAuth() || {};
  const insets = useSafeAreaInsets();
  const post = store.usePost(postId);
  const barRef = useRef(null);
  const scrollRef = useRef(null);
  const { report, reportNode } = useReport({ native: !!native });
  useMentionCloser(true, onClose); // [2026-10-24 coment-mencao] tocar @ fecha a folha e abre o perfil
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
          bottomPad={kbPad > 0 ? 0 : (native ? nativeSheetBottomPad(insets, 0) : insets.bottom)}
          onSent={() => setTimeout(() => { try { scrollRef.current?.scrollToEnd({ animated: true }); } catch {} }, 120)} />
      </View>
      {kbPad > 0 ? <View style={{ height: kbPad, backgroundColor: th.card }} /> : null}
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
  if (nativeCommentsOn()) {
    return (
      <NativeSheet visible={!!visible && !!postId} onClose={onClose} detents={[0.72, 1]} initialDetent={focus ? 1 : 0} backgroundColor={th.card}>
        <SheetBody postId={postId} onClose={onClose} native focus={focus} />
      </NativeSheet>
    );
  }
  if (!visible || !postId) return null;
  return <PanelSheet onClose={onClose} th={th} postId={postId} focus={focus} />;
}

function PanelSheet({ onClose, th, postId, focus }) {
  const insets = useSafeAreaInsets();
  const drag = useDragToDismiss({ onDismiss: () => { if (typeof onClose === 'function') onClose(); } });
  const { pad, kb, onLayout } = useKeyboardSpacer();
  const [rootH, setRootH] = useState(0);
  const layout = useCallback((e) => { onLayout(e); const h = e?.nativeEvent?.layout?.height || 0; if (h) setRootH(h); }, [onLayout]);
  // sem teclado: 72% (detent médio); com teclado: até o topo (detent grande)
  const full = rootH ? Math.max(200, rootH - insets.top - 8) : null;
  const height = rootH ? (kb > 0 ? full : Math.min(full, Math.round(rootH * 0.72))) : '72%';
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <DragSheetRoot style={{ flex: 1 }}>
        <View style={{ flex: 1, justifyContent: 'flex-end' }} onLayout={layout}>
          <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.4)' }]} onPress={onClose} accessibilityLabel={'close'} />
          <DragPanel drag={drag} onStartShouldSetResponder={() => true} style={{ height, backgroundColor: th.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow: 'hidden', maxWidth: 640, width: '100%', alignSelf: 'center' }}>
            <View style={{ width: 38, height: 5, borderRadius: 3, backgroundColor: th.chip, alignSelf: 'center', marginTop: 8 }} />
            <SheetBody postId={postId} onClose={onClose} focus={focus} kbPad={pad} />
          </DragPanel>
        </View>
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
