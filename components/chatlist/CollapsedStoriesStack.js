// components/chatlist/CollapsedStoriesStack.js — [2026-10-18 tg-list]
//
// Telegram: quando a lista rola e o título grande vira o compacto, a fileira
// de status (stories) "entra" no header como uma pilha de até 3 avatares ao
// lado do título. Toque → abre o status do primeiro (o mesmo opener que a
// linha/fileira usam, registrado pelo ChatListTab).
//
// Fonte: o mapa de anéis do statusRingStore (quem tem status ativo e se já
// vi tudo) — leitura + assinatura, sem mexer no store. Só quem tem status NÃO
// visto entra na pilha; sem nenhum → não desenha nada (o título fica sozinho).
import React, { useEffect, useState } from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import AvatarCircle from '../AvatarCircle';

const MAX = 3;
const SIZE = 22;

function _store() {
  try { return require('../status/statusRingStore'); } catch { return null; }
}

function _fresh() {
  const m = globalThis.__chatyyStatusRings;
  if (!(m instanceof Map)) return [];
  const out = [];
  for (const [email, v] of m) {
    if (!email || !v || !(v.count > 0) || v.allViewed) continue;
    out.push(email);
    if (out.length >= MAX) break;
  }
  return out;
}

function _same(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export default function CollapsedStoriesStack({ isDark, ringColor, bgColor, label }) {
  const [emails, setEmails] = useState(_fresh);
  useEffect(() => {
    const st = _store();
    const sync = () => { const n = _fresh(); setEmails(prev => (_same(prev, n) ? prev : n)); };
    sync();
    if (!st || typeof st.subscribeStatusRings !== 'function') return undefined;
    return st.subscribeStatusRings(sync);
  }, []);
  if (!emails.length) return null;
  const ring = ringColor || (isDark ? '#f5f5f5' : '#0b0b0b');
  const bg = bgColor || (isDark ? '#0b0b0b' : '#ffffff');
  return (
    <TouchableOpacity
      onPress={() => { try { _store()?.openStatusFor?.(emails[0]); } catch {} }}
      activeOpacity={0.7}
      hitSlop={{ top: 10, bottom: 10, left: 8, right: 4 }}
      accessibilityRole="button"
      accessibilityLabel={label || 'Status'}
      style={[st.wrap, { width: SIZE + 4 + (emails.length - 1) * (SIZE - 8) }]}
      testID="home-collapsed-stories"
    >
      {emails.map((em, i) => (
        <View
          key={em}
          style={[st.ring, {
            left: i * (SIZE - 8),
            zIndex: MAX - i,
            borderColor: ring,
            backgroundColor: bg,
          }]}
        >
          <AvatarCircle email={em} name={em} size={SIZE - 4} />
        </View>
      ))}
    </TouchableOpacity>
  );
}

const st = StyleSheet.create({
  wrap: { height: SIZE + 4, marginRight: 8 },
  ring: {
    position: 'absolute',
    top: 0,
    width: SIZE + 4,
    height: SIZE + 4,
    borderRadius: (SIZE + 4) / 2,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
});
