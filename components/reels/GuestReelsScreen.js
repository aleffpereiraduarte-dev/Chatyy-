// [guest-reels 2026-10-22] Tela de Reels que abre SEM LOGIN (como o TikTok): /reels e /r/<id>.
//
// Sem conta → ReelsViewer em modo convidado: assistir, rolar, compartilhar (link /r/<id>) e ler
// comentários. Curtir/comentar/seguir/salvar/enviar → "Entre ou crie sua conta" (camada própria,
// nunca Modal sobre Modal). "Entrar" vai ao /login?next=/r/<id> → depois do login volta ao MESMO
// reel (já com a conta: esta mesma tela troca para o viewer normal começando nele).
// Web sem conta: faixa "Baixe o app" (/baixar).
// Kill: globalThis.__chatyy_guest_reels = false (app) · data/.guest-reels-off (servidor).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Platform, BackHandler } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Svg, { Path, Rect } from 'react-native-svg';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { isGuestReelsEnabled } from '../../services/guestReels';
import GuestAuthSheet from './GuestAuthSheet';
import GuestCommentsSheet from './GuestCommentsSheet';

const ReelsViewer = React.lazy(() => import('../ReelsViewer'));
const isWeb = Platform.OS === 'web';

function BackGlyph() {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M15 5l-7 7 7 7" />
    </Svg>
  );
}
function PhoneGlyph() {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="6" y="2.5" width="12" height="19" rx="2.5" />
      <Path d="M11 18h2" />
    </Svg>
  );
}

export default function GuestReelsScreen({ startId = null }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user, loading } = useAuth();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const tr = useCallback((k, fb) => { try { const v = t?.(k); return v && v !== k ? v : fb; } catch { return fb; } }, [t]);
  const isGuest = !user;
  const enabled = isGuestReelsEnabled();
  const curRef = useRef(null);
  const [authKind, setAuthKind] = useState(null);
  const [commentsReel, setCommentsReel] = useState(null);
  const startNum = Number(startId) > 0 ? String(Number(startId)) : null;

  const returnPath = useCallback(() => {
    const id = curRef.current?.id ?? startNum;
    return id ? `/r/${id}` : '/reels';
  }, [startNum]);

  const goLogin = useCallback(() => {
    setAuthKind(null); setCommentsReel(null);
    try { AsyncStorage.setItem('chatyy_intro_seen', '1').catch(() => {}); } catch {} // já viu o app: direto no formulário
    try { router.replace(`/login?next=${encodeURIComponent(returnPath())}`); } catch {}
  }, [router, returnPath]);
  const goSignup = useCallback(() => {
    setAuthKind(null); setCommentsReel(null);
    try { AsyncStorage.setItem('chatyy_intro_seen', '1').catch(() => {}); } catch {}
    try { router.push('/signup-phone'); } catch {}
  }, [router]);
  const goBack = useCallback(() => {
    try { if (router.canGoBack?.()) { router.back(); return; } } catch {}
    try { router.replace(user ? '/chat' : '/login'); } catch {}
  }, [router, user]);

  // Android: voltar fecha a folha antes de sair da tela
  useEffect(() => {
    if (isWeb) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (authKind) { setAuthKind(null); return true; }
      if (commentsReel) { setCommentsReel(null); return true; }
      return false;
    });
    return () => { try { sub.remove(); } catch {} };
  }, [authKind, commentsReel]);

  // Web: título da aba
  useEffect(() => {
    if (!isWeb || typeof document === 'undefined') return;
    try { document.title = 'Reels · Chatyy'; } catch {}
  }, []);

  if (loading) return <View style={styles.root} />;

  if (isGuest && !enabled) {
    return (
      <View style={[styles.root, styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.offText}>{tr('guestReels.unavailable', 'Os Reels sem conta estão indisponíveis agora.')}</Text>
        <Pressable onPress={goLogin} style={styles.offBtn} accessibilityRole="button">
          <Text style={styles.offBtnText}>{tr('guestReels.login', 'Entrar')}</Text>
        </Pressable>
      </View>
    );
  }

  const top = insets.top + (Platform.OS === 'android' ? 4 : 0);
  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      {isGuest && isWeb ? (
        <View style={styles.banner}>
          <PhoneGlyph />
          <View style={{ flex: 1, marginLeft: 10 }}>
            <Text style={styles.bannerTitle} numberOfLines={1}>{tr('guestReels.downloadTitle', 'Baixe o app Chatyy')}</Text>
            <Text style={styles.bannerSub} numberOfLines={1}>{tr('guestReels.downloadSub', 'Mais rápido, com curtidas, comentários e chat.')}</Text>
          </View>
          <Pressable
            onPress={() => { try { window.location.href = '/baixar'; } catch {} }}
            style={({ pressed }) => [styles.bannerBtn, { opacity: pressed ? 0.85 : 1 }]}
            accessibilityRole="link"
            href="/baixar"
          >
            <Text style={styles.bannerBtnText}>{tr('guestReels.download', 'Baixar')}</Text>
          </Pressable>
        </View>
      ) : null}
      <View style={{ flex: 1 }}>
        <React.Suspense fallback={<View style={styles.root} />}>
          <ReelsViewer
            key={isGuest ? 'guest' : 'user'}
            colors={colors}
            isDark={isDark}
            t={t}
            user={user || null}
            router={router}
            parentActive
            recommended
            guest={isGuest}
            initialReelId={startNum}
            onCurrentReel={(r) => { curRef.current = r; }}
            onGuestAuth={(kind) => setAuthKind(kind || 'generic')}
            onGuestComments={(r) => setCommentsReel(r)}
            externalOverlayOpen={!!authKind || !!commentsReel}
          />
        </React.Suspense>
        <View pointerEvents="box-none" style={[styles.topBar, { top: isGuest && isWeb ? 8 : top + 6 }]}>
          <Pressable onPress={goBack} hitSlop={10} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel={tr('common.back', 'Voltar')}>
            <BackGlyph />
          </Pressable>
          {isGuest ? (
            <>
              <Text style={styles.title} accessibilityRole="header">{tr('feed.forYou', 'Para você')}</Text>
              <Pressable onPress={goLogin} style={({ pressed }) => [styles.loginPill, { opacity: pressed ? 0.85 : 1 }]} accessibilityRole="button">
                <Text style={styles.loginPillText}>{tr('guestReels.login', 'Entrar')}</Text>
              </Pressable>
            </>
          ) : <View style={{ flex: 1 }} />}
        </View>
        {isGuest ? (
          <>
            <GuestCommentsSheet
              visible={!!commentsReel}
              reel={commentsReel}
              t={t}
              onClose={() => setCommentsReel(null)}
              onRequireAuth={(k) => setAuthKind(k || 'comment')}
            />
            <GuestAuthSheet
              visible={!!authKind}
              kind={authKind || 'generic'}
              t={t}
              onLogin={goLogin}
              onSignup={goSignup}
              onClose={() => setAuthKind(null)}
            />
          </>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  offText: { color: 'rgba(255,255,255,0.75)', fontSize: 16, textAlign: 'center', lineHeight: 22 },
  offBtn: { marginTop: 18, minHeight: 46, paddingHorizontal: 28, borderRadius: 23, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  offBtnText: { color: '#000', fontSize: 16, fontWeight: '700' },
  banner: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, backgroundColor: '#151515', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.12)' },
  bannerTitle: { color: '#fff', fontSize: 14, fontWeight: '700' },
  bannerSub: { color: 'rgba(255,255,255,0.6)', fontSize: 12, marginTop: 1 },
  bannerBtn: { minHeight: 34, paddingHorizontal: 16, borderRadius: 17, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', marginLeft: 10 },
  bannerBtnText: { color: '#000', fontSize: 14, fontWeight: '700' },
  topBar: { position: 'absolute', left: 0, right: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 10, zIndex: 30 },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.28)' },
  title: { color: '#fff', fontSize: 17, fontWeight: '700', textShadowColor: 'rgba(0,0,0,0.5)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3 },
  loginPill: { minHeight: 34, paddingHorizontal: 16, borderRadius: 17, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  loginPillText: { color: '#000', fontSize: 14, fontWeight: '700' },
});
