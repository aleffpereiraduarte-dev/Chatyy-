// components/chat/CallLinkCard.js — [call-link 2026-10-19] cartão do link de chamada
// no balão (lista JS / web). A lista NATIVA desenha o mesmo cartão em
// components/chat/nativeRowCards.js (kind 'clink').
//
// A mensagem é texto com a URL (clientes antigos veem o link clicável):
//   "Chamada de vídeo do Chatyy: Reunião\nhttps://chatyy.com.br/c/xxxx-xxxx-xxxx"
// Aqui: ícone, título, "Chamada de vídeo do Chatyy" e o botão Entrar → lobby.
import React, { memo, useCallback } from 'react';
import { Pressable, Text, View } from 'react-native';
import { IconPhone, IconVideo } from '../Icons';
import { useLanguage } from '../../context/LanguageContext';
import { callLinkCodeFromText, callLinkRoute, parseCallLinkMessage } from '../calls/callLinkUtil';

function _tr(t, k, fb) {
  try { const v = t ? t(k) : ''; return v && v !== k ? v : fb; } catch { return fb; }
}

function CallLinkCard({ url, msg, ink, sub, colors, isDark }) {
  const { t } = useLanguage() || {};
  const parsed = parseCallLinkMessage(msg && msg.content) || null;
  const code = (parsed && parsed.code) || callLinkCodeFromText(String(url || ''));
  const isVideo = parsed ? parsed.isVideo : true;
  const kind = isVideo ? _tr(t, 'callLink.kindVideo', 'Chamada de vídeo do Chatyy') : _tr(t, 'callLink.kindVoice', 'Chamada de voz do Chatyy');
  const title = (parsed && parsed.title) || _tr(t, 'callLink.cardTitle', 'Link de chamada');
  const fg = ink || colors?.text || '#111111';
  const mt = sub || colors?.textSecondary || '#8e8e93';
  const dark = isDark != null ? isDark : /^#?f/i.test(String(fg)); // tinta clara → fundo escuro
  const soft = dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.06)';
  const onJoin = useCallback(() => {
    if (!code) return;
    try { require('expo-router').router.push(callLinkRoute(code)); } catch {}
  }, [code]);
  if (!code) return null;
  const Icon = isVideo ? IconVideo : IconPhone;
  return (
    <View style={{ marginTop: 6, width: 260, maxWidth: '100%', borderRadius: 12, padding: 12, backgroundColor: soft, gap: 10 }} testID="call-link-card">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: dark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.08)' }}>
          <Icon size={20} color={fg} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: fg }}>{title}</Text>
          <Text numberOfLines={1} style={{ fontSize: 13, color: mt, marginTop: 1 }}>{kind}</Text>
        </View>
      </View>
      <Pressable
        onPress={onJoin}
        accessibilityRole="button"
        accessibilityLabel={_tr(t, 'callLink.join', 'Entrar')}
        style={({ pressed }) => ({ height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.08)', opacity: pressed ? 0.7 : 1 })}
      >
        <Text style={{ fontSize: 15, fontWeight: '600', color: fg }}>{_tr(t, 'callLink.join', 'Entrar')}</Text>
      </Pressable>
    </View>
  );
}

export default memo(CallLinkCard);
