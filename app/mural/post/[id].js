// /mural/post/<id> — [mural 2026-10-20] post aberto do "Perfil com Mural".
// Foto → components/mural/PostViewer (tela 2); texto → TextPostView (tela 3).
// Comentários = folha do sistema (CommentsSheet, tela 6) sobre esta ROTA (nunca
// <Modal> sobre <Modal>). Abre via services/muralNav.openPost(post | id).
// Params: id, comments=1 (já abre os comentários), index (foto inicial).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, StatusBar } from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../../context/ThemeContext';
import { useLanguage } from '../../../context/LanguageContext';
import PostViewer from '../../../components/mural/PostViewer';
import TextPostView from '../../../components/mural/TextPostView';
import CommentsSheet from '../../../components/mural/CommentsSheet';
import { useReport } from '../../../components/mural/CommentsList';
import MIcon from '../../../components/mural/MuralIcons';
import { useMuralTheme } from '../../../components/mural/muralTheme';
import { registerCommentsHost } from '../../../services/muralNav';
import * as store from '../../../services/muralStore';

let _LikersSheet = null;
function _likers() { if (_LikersSheet === null) { try { _LikersSheet = require('../../../components/LikersSheet').default || false; } catch { _LikersSheet = false; } } return _LikersSheet; }

export default function MuralPostScreen() {
  const params = useLocalSearchParams();
  const id = String(params?.id || '');
  const router = useRouter();
  const { t } = useLanguage();
  const { colors, isDark } = useTheme();
  const th = useMuralTheme();
  const insets = useSafeAreaInsets();
  const post = store.usePost(id);
  const [sheet, setSheet] = useState(() => (params?.comments === '1' ? { focus: false } : null));
  const [likers, setLikers] = useState(false);
  const { report, reportNode } = useReport();
  const firstFocus = useRef(true);

  const back = useCallback(() => {
    try { if (router.canGoBack()) router.back(); else router.replace('/chat'); } catch {}
  }, [router]);

  // dados: cópia já pintada (primePost) + post_get a cada foco (contadores frescos)
  useFocusEffect(useCallback(() => {
    if (!id) return undefined;
    if (firstFocus.current) { firstFocus.current = false; store.loadPost(id); } else { store.loadPost(id); store.getComments(id) && store.loadComments(id); }
    return undefined;
  }, [id]));
  useEffect(() => {
    if (!id) return undefined;
    store.markViewed(id);
    store.loadComments(id);
    return store.watchPost(id);
  }, [id]);
  // openComments(id) vindo de outro lugar com ESTA tela em foco → folha aqui
  useEffect(() => registerCommentsHost((pid, opts) => {
    if (String(pid) !== id) return false;
    setSheet({ focus: !!(opts && opts.focus) });
    return true;
  }), [id]);

  const onEdit = useCallback((p) => { router.push(`/photo-new?mural=1&edit=${encodeURIComponent(String(p.id))}`); }, [router]);
  const onDeleted = useCallback(() => back(), [back]);
  const isPhoto = post ? post.kind === 'photo' : null;

  if (!post || post.deleted) {
    const dark = isPhoto !== false;
    return (
      <View style={{ flex: 1, backgroundColor: post?.deleted ? th.bg : (dark ? '#000' : th.bg), paddingTop: insets.top }}>
        <StatusBar barStyle={post?.deleted ? (isDark ? 'light-content' : 'dark-content') : 'light-content'} />
        <Pressable onPress={back} hitSlop={8} style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel={t('common.back', 'Voltar')}>
          <MIcon name="back" size={24} color={post?.deleted ? th.text : '#fff'} />
        </Pressable>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 8 }}>
          {post?.deleted ? (
            <>
              <Text style={{ color: th.text, fontSize: 17, fontWeight: '700', textAlign: 'center' }}>{t('mural.unavailable', 'Publicação indisponível')}</Text>
              <Text style={{ color: th.muted, fontSize: 14, textAlign: 'center' }}>{t('mural.unavailableSub', 'Ela foi apagada ou você não tem acesso.')}</Text>
            </>
          ) : <ActivityIndicator color="#8e8e93" />}
        </View>
      </View>
    );
  }

  const Likers = _likers();
  return (
    <View style={{ flex: 1, backgroundColor: isPhoto ? '#000' : th.bg }}>
      {isPhoto ? (
        <PostViewer postId={id} onBack={back} onEdit={onEdit} onDeleted={onDeleted} onReport={report}
          initialIndex={Number(params?.index) || 0}
          onOpenComments={(focus) => setSheet({ focus: !!focus })} onOpenLikers={() => setLikers(true)} />
      ) : (
        <TextPostView postId={id} onBack={back} onEdit={onEdit} onDeleted={onDeleted} onReport={report}
          focusComment={params?.comments === '1'} onOpenLikers={() => setLikers(true)} />
      )}
      {isPhoto ? <CommentsSheet visible={!!sheet} postId={id} focus={!!sheet?.focus} onClose={() => setSheet(null)} /> : null}
      {Likers && likers ? (
        <Likers visible={likers} postId={Number(id)} totalCount={post.likes} colors={colors} isDark={isDark} t={t} router={router} onClose={() => setLikers(false)} />
      ) : null}
      {reportNode}
    </View>
  );
}
