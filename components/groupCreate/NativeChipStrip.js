// components/groupCreate/NativeChipStrip.js — [2026-10-15 native-group-create]
//
// Fileira NATIVA de membros selecionados (view ChatyyChipStrip do pacote
// modules/expo-chat-conversation-list): avatar + "x" + primeiro nome, entra
// com mola, sai encolhendo, rola até o último. Toque = onRemove(email).
// A ALTURA abre/fecha em JS (LayoutAnimation) — vazio = 0.
// Erro de render/nativo → onFailure() (a tela volta à fileira JS).
import React, { useEffect, useMemo, useRef } from 'react';
import { LayoutAnimation, Platform, StyleSheet, View } from 'react-native';
import { getNativeChipStripView } from '../../modules/expo-chat-conversation-list';
import { contactTile, nativeColors } from '../contacts/contactListAdapter';

export const CHIP_STRIP_HEIGHT = 92;

class Boundary extends React.Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e) { try { this.props.onFailure?.(String(e?.message || e)); } catch {} }
  render() { return this.state.failed ? null : this.props.children; }
}

function displayName(m) {
  const n = String(m?.name || '').trim();
  if (n && !n.includes('@')) return n;
  return String(m?.email || n || '').split('@')[0];
}

function Inner({ members, colors, isDark, removeLabel, onRemove, onFailure, borderColor }) {
  const Native = getNativeChipStripView();
  const count = Array.isArray(members) ? members.length : 0;
  const open = count > 0;
  const prevOpen = useRef(open);
  if (prevOpen.current !== open) {
    prevOpen.current = open;
    try { LayoutAnimation.configureNext(LayoutAnimation.create(220, 'easeInEaseOut', 'opacity')); } catch {}
  }
  // [2026-10-18 fwd-native] `id`/`tiles` opcionais (encaminhar: chip = conversa).
  const items = useMemo(() => (members || []).map(m => ({
    id: String(m.id != null ? m.id : m.email),
    t: displayName(m),
    tiles: Array.isArray(m.tiles) ? m.tiles : contactTile(m.email, displayName(m)),
  })), [members]);
  const nColors = useMemo(() => ({
    ...nativeColors({
      bg: colors.background,
      text: colors.text,
      badgeBg: isDark ? '#636366' : '#8E8E93',
      badgeFg: '#FFFFFF',
    }),
    removeLabel: removeLabel || '',
  }), [colors.background, colors.text, isDark, removeLabel]);
  const onPressRef = useRef(onRemove);
  onPressRef.current = onRemove;
  const handlers = useMemo(() => ({
    onChipPress: (e) => {
      const id = String((e?.nativeEvent ?? e)?.id || '');
      if (id) { try { onPressRef.current?.(id); } catch {} }
    },
    onNativeError: (e) => { try { onFailure?.(String((e?.nativeEvent ?? e)?.message || 'native error')); } catch {} },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);
  useEffect(() => { if (!Native) { try { onFailure?.('no ChatyyChipStrip'); } catch {} } }, [Native, onFailure]);
  if (!Native) return null;
  return (
    <View style={[styles.wrap, { height: open ? CHIP_STRIP_HEIGHT : 0, borderBottomColor: open ? borderColor : 'transparent' }]}>
      {/* Sempre montada (só a altura muda) → a última saída anima no nativo. */}
      <Native style={styles.native} items={items} colors={nColors} dark={!!isDark} {...handlers} />
    </View>
  );
}

export default function NativeChipStrip(props) {
  return (
    <Boundary onFailure={props.onFailure}>
      <Inner {...props} />
    </Boundary>
  );
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden', borderBottomWidth: Platform.OS === 'ios' ? StyleSheet.hairlineWidth : 1 },
  // Altura fixa (nunca 0): a UICollectionView não fica menor que o item.
  native: { height: CHIP_STRIP_HEIGHT - 1 },
});
