// app/chat-info/[id].js — [2026-10-18 chat-info-push] "Dados do contato / do
// grupo" EMPURRADO na pilha nativa (swipe-back em tela cheia, seta de voltar
// nativa do ChatyyChatInfo). Não busca nada: lê os descritores que a conversa
// publica em services/chatInfoRoute (mesmos handlers da folha antiga).
// Sem entrada (deep link, reload com a pilha restaurada) → a rota se remove.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, StatusBar, StyleSheet, Platform } from 'react-native';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { StackActions, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import NativeChatInfo from '../../components/chat/NativeChatInfo';
import { ProfilePhotoGalleryHost } from '../../components/profile/ProfilePhotoGallery'; // [perfil-fotos 2026-10-19] galeria JS de reserva
import { useGroupedColors } from '../../components/settings/SettingsKit';
import { useLanguage } from '../../context/LanguageContext';
import { getInfo, subscribeInfo, screenMounted, screenGone } from '../../services/chatInfoRoute';
import ChatyySecureView from '../../components/chat/ChatyySecureView'; // [2026-10-19 secure-view]
import { useCaptureScope, secureViewAvailable } from '../../services/captureBlock';
import { acquireCaptureProtection, addScreenshotListener, sendScreenshotNotice } from '../../services/chatPrivacy';

// [2026-10-19 secure-view] Aberto por cima de uma conversa protegida
// (privacidade avançada / modo temporário / "Bloquear capturas de tela nas
// conversas") → mesma proteção: iOS print = "Captura de tela bloqueada" + aviso
// na conversa; Android FLAG_SECURE.
function useInfoCaptureProtect(t) {
  const scope = useCaptureScope();
  const cid = scope ? scope.cid : '';
  const notify = !!scope && scope.reasons.some((r) => r === 'adv' || r === 'vanish' || r === 'global');
  useEffect(() => {
    if (!cid) return undefined;
    const release = acquireCaptureProtection(`chatyy-chatinfo-protected-${cid}`, {
      labels: { title: (t && t('advPriv.protectedTitle')) || 'Conteúdo protegido', subtitle: '' },
      secureView: true,
    });
    let sub = null;
    if (Platform.OS === 'ios' && notify) {
      const sc = scope.reasons.includes('adv') ? 'adv' : (scope.reasons.includes('vanish') ? 'vanish' : 'global');
      sub = addScreenshotListener(() => sendScreenshotNotice(cid, { kind: 'screenshot', blocked: secureViewAvailable(), scope: sc }));
    }
    return () => { try { release(); } catch {} try { sub && sub.remove(); } catch {} };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, notify]);
  return !!cid;
}

export default function ChatInfoRouteScreen() {
  const params = useLocalSearchParams();
  const key = String((Array.isArray(params?.id) ? params.id[0] : params?.id) || '');
  const navigation = useNavigation();
  const route = useRoute();
  const insets = useSafeAreaInsets();
  const gc = useGroupedColors();
  const { t } = useLanguage();
  const [props, setProps] = useState(() => (getInfo(key) && getInfo(key).props) || null);
  const routeKeyRef = useRef(route?.key);
  routeKeyRef.current = route?.key;
  const poppedRef = useRef(false);
  const _capProt = useInfoCaptureProtect(t);

  // Remove SÓ esta rota (pop com source = não mexe no que estiver por cima);
  // withBelow = também a conversa logo abaixo (sair/apagar grupo).
  const popSelf = useCallback((withBelow) => {
    if (poppedRef.current) return;
    poppedRef.current = true;
    try {
      const state = navigation.getState?.();
      const myKey = routeKeyRef.current;
      if (!state || !myKey || !Array.isArray(state.routes)) return;
      const idx = state.routes.findIndex((r) => r && r.key === myKey);
      if (idx < 0) return;
      const below = idx > 0 ? state.routes[idx - 1] : null;
      const count = withBelow && below && below.name === 'chat-conversation' && idx > 1 ? 2 : 1;
      navigation.dispatch({ ...StackActions.pop(count), source: myKey, target: state.key });
    } catch {}
  }, [navigation]);

  useEffect(() => {
    if (!screenMounted(key)) { popSelf(false); return undefined; }
    const onEntry = (e) => {
      if (e.closing) { popSelf(e.cmd === 'back'); return; }
      if (e.props) setProps(e.props);
    };
    const unsub = subscribeInfo(key, onEntry);
    const e0 = getInfo(key);
    if (e0) onEntry(e0);
    return () => { unsub(); screenGone(key); };
  }, [key, popSelf]);

  const onClose = useCallback(() => {
    try { if (navigation.canGoBack?.()) { navigation.goBack(); return; } } catch {}
    popSelf(false);
  }, [navigation, popSelf]);

  if (!props) return <View style={[styles.fill, { backgroundColor: gc.pageBg }]} />;
  const hero = { ...(props.hero || {}), back: true };
  return (
    <ChatyySecureView enabled={_capProt} dark={!!gc.isDark} coverColor={gc.pageBg} t={t}>
    <View style={[styles.fill, { backgroundColor: gc.pageBg, paddingTop: insets.top || 0 }]}>
      <StatusBar barStyle={gc.isDark ? 'light-content' : 'dark-content'} />
      <NativeChatInfo
        {...props}
        overlay={undefined}
        hero={hero}
        bottomInset={props.bottomInset != null ? props.bottomInset : (insets.bottom || 0) + 16}
        onClose={onClose}
        closeLabel={(t && t('common.back')) || 'Voltar'}
      />
      {props.overlay || null}
      <ProfilePhotoGalleryHost t={t} />
    </View>
    </ChatyySecureView>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
