// components/status/StoryEmojiPicker.js — [2026-10-17 status-reacoes]
//
// "+" da fileira de reações do status no fallback JS (o nativo tem
// SVEmojiSheet): grade completa de emojis do app (components/chat/
// nativeEmojiData.js — mesmo catálogo do menu de contexto) com busca por
// palavras. Emojis são CONTEÚDO (a reação); o fechar é ícone SVG.
import React, { useMemo, useState } from 'react';
import { Modal, View, Text, TextInput, Pressable, FlatList, StyleSheet, Platform, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconX } from '../Icons';
import { EMOJI_CATS } from '../chat/nativeEmojiData';
import { feedback } from '../../constants/motion';
import useDragToDismiss, { DragSheetRoot, DragPanel, DragScroll, DragFade } from '../ui/useDragToDismiss';

const CELL = 46;

function _fold(s) {
  try { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); } catch { return String(s || '').toLowerCase(); }
}

function _parse() {
  return EMOJI_CATS.map((c) => {
    const e = []; const k = [];
    for (const s of c.list) {
      const sp = s.indexOf(' ');
      e.push(sp > 0 ? s.slice(0, sp) : s);
      k.push(_fold(sp > 0 ? s.slice(sp + 1) : ''));
    }
    return { tk: c.tk, fb: c.fb, e, k };
  });
}
let _cats = null;

export default function StoryEmojiPicker({ visible, quick = [], mine = '', t, onPick, onClose }) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState('');
  const tt = (k, fb) => { try { const v = t?.(k); return v && v !== k ? v : fb; } catch { return fb; } };
  const cols = Math.max(5, Math.floor((width - 16) / CELL));

  const rows = useMemo(() => {
    if (!visible) return [];
    if (!_cats) _cats = _parse();
    const sections = [];
    const f = _fold(q.trim());
    if (f) {
      const seen = new Set(); const out = [];
      for (const c of _cats) c.e.forEach((em, i) => { if (!seen.has(em) && (em === q.trim() || c.k[i].includes(f))) { seen.add(em); out.push(em); } });
      if (out.length) sections.push({ title: '', list: out });
    } else {
      const qq = (quick || []).filter(Boolean);
      if (qq.length) sections.push({ title: '', list: qq });
      for (const c of _cats) sections.push({ title: tt(c.tk, c.fb), list: c.e });
    }
    const out = [];
    sections.forEach((s, si) => {
      if (s.title) out.push({ key: `h${si}`, header: s.title.toUpperCase() });
      for (let i = 0; i < s.list.length; i += cols) out.push({ key: `r${si}-${i}`, items: s.list.slice(i, i + cols) });
    });
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, q, cols, quick]);

  const close = () => { setQ(''); onClose?.(); };
  const drag = useDragToDismiss({ visible: !!visible, onDismiss: close }); // [2026-10-17 drag-dismiss]
  const pick = (em) => { feedback.light(); setQ(''); onPick?.(em); };

  return (
    <Modal visible={!!visible} transparent animationType="slide" onRequestClose={close} statusBarTranslucent>
      <DragSheetRoot>
      <DragFade drag={drag}><Pressable style={st.dim} onPress={close} accessibilityRole="button" accessibilityLabel={tt('common.close', 'Fechar')} /></DragFade>
      <DragPanel drag={drag} style={[st.panel, { height: Math.min(height * 0.62, 520 + insets.bottom), paddingBottom: insets.bottom }]}>
        <View style={st.handle} />
        <View style={st.header}>
          <Text style={st.title}>{tt('chatConv.moreReactions', 'Mais reações')}</Text>
          <Pressable onPress={close} hitSlop={10} accessibilityRole="button" accessibilityLabel={tt('common.close', 'Fechar')}>
            <IconX size={20} color="rgba(255,255,255,0.7)" />
          </Pressable>
        </View>
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder={tt('chatConv.emojiSearch', 'Buscar emoji')}
          placeholderTextColor="rgba(255,255,255,0.5)"
          style={[st.search, Platform.OS === 'web' ? { outlineStyle: 'none' } : null]}
          autoCorrect={false}
          returnKeyType="search"
          keyboardAppearance="dark"
        />
        {rows.length === 0 ? (
          <Text style={st.empty}>{tt('chatConv.emojiNoResults', 'Nenhum emoji encontrado')}</Text>
        ) : (
          <DragScroll drag={drag}><FlatList
            data={rows}
            keyExtractor={(r) => r.key}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            initialNumToRender={14}
            windowSize={7}
            contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 8 }}
            renderItem={({ item: r }) => (r.header ? (
              <Text style={st.cat}>{r.header}</Text>
            ) : (
              <View style={st.row}>
                {r.items.map((em) => (
                  <Pressable
                    key={em}
                    onPress={() => pick(em)}
                    style={({ pressed }) => [st.cell, { width: (width - 16) / cols }, em === mine && st.mine, pressed && { transform: [{ scale: 1.25 }] }]}
                    accessibilityRole="button"
                    accessibilityLabel={em}
                  >
                    <Text style={st.emoji} allowFontScaling={false}>{em}</Text>
                  </Pressable>
                ))}
              </View>
            ))}
          /></DragScroll>
        )}
      </DragPanel>
      </DragSheetRoot>
    </Modal>
  );
}

const st = StyleSheet.create({
  dim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  panel: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: '#1c1c1e', borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow: 'hidden' },
  handle: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.25)', marginTop: 8, marginBottom: 6 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingBottom: 10 },
  title: { color: '#fff', fontSize: 17, fontWeight: '700' },
  search: { marginHorizontal: 12, marginBottom: 6, height: 38, borderRadius: 10, paddingHorizontal: 14, color: '#fff', fontSize: 16, backgroundColor: 'rgba(255,255,255,0.1)' },
  empty: { color: 'rgba(255,255,255,0.55)', fontSize: 15, textAlign: 'center', marginTop: 24 },
  cat: { color: 'rgba(255,255,255,0.55)', fontSize: 13, fontWeight: '700', paddingHorizontal: 6, paddingTop: 10, paddingBottom: 6 },
  row: { flexDirection: 'row' },
  cell: { height: CELL, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  mine: { backgroundColor: 'rgba(255,255,255,0.16)' },
  emoji: { fontSize: 28 },
});
