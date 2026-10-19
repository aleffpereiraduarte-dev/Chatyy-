// components/chat/ChatyySecureView.js — [2026-10-19 secure-view]
//   <ChatyySecureView enabled dark coverColor style>{children}</ChatyySecureView>
// iOS (binário com expo-chat-privacy apiVersion ≥ 3): os filhos ficam na camada
// segura — print/gravação/espelhamento saem com "Captura de tela bloqueada"
// (ícone, texto e a marca Chatyy) em vez do conteúdo. Android/web/binário
// antigo/kill switch (globalThis.__chatyy_secure_view = false): uma <View>
// comum (Android já tem FLAG_SECURE; ver services/chatPrivacy.js).
// O tipo do elemento não muda com `enabled` (sem remontar a conversa).
import React from 'react';
import { View } from 'react-native';
import { getNativeSecureView } from '../../services/captureBlock';

function _tt(t, key, fb) {
  try {
    const v = typeof t === 'function' ? t(key) : '';
    return typeof v === 'string' && v && v !== key ? v : fb;
  } catch { return fb; }
}

export function secureViewLabels(t) {
  return {
    title: _tt(t, 'captureBlock.title', 'Captura de tela bloqueada'),
    message: _tt(t, 'captureBlock.message', 'Para proteger a privacidade de todos no Chatyy, esta captura de tela foi bloqueada.'),
    brand: 'Chatyy',
  };
}

export default function ChatyySecureView({ enabled, dark, coverColor, labels, t, style, children, ...rest }) {
  const Native = getNativeSecureView();
  if (!Native) return <View style={style || { flex: 1 }} {...rest}>{children}</View>;
  return (
    <Native
      style={style || { flex: 1 }}
      enabled={!!enabled}
      dark={!!dark}
      coverColor={coverColor || (dark ? '#000000' : '#FFFFFF')}
      labels={labels || secureViewLabels(t)}
      {...rest}
    >
      {children}
    </Native>
  );
}
