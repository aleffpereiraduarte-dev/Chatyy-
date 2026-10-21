// components/chat/ChatEmojiPicker.js — [2026-10-21 tg4] seletor de emoji COMPLETO da conversa
// (paridade Telegram): todas as categorias Unicode até Emoji 15.0 (emojiFullData.js, ordem CLDR),
// busca por palavra em pt e en (sem acento), recentes (MMKV) e tom de pele.
// Emojis são CONTEÚDO do usuário (reação/texto) — os controles de UI (limpar busca) são SVG/texto.
// Renderiza só a categoria escolhida (≤ ~360 itens) ou os resultados da busca → leve sem FlatList,
// e funciona dentro do ScrollView do sheet que já existe.
import React, { useMemo, useState, useCallback } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, Platform } from 'react-native';
import { IconX } from '../Icons';
import { EMOJI_FULL_CATS, EMOJI_TONE_BASES } from './emojiFullData';

const RECENT_KEY = 'emoji_picker_recent_v1';
const TONES = ['', '\u{1F3FB}', '\u{1F3FC}', '\u{1F3FD}', '\u{1F3FE}', '\u{1F3FF}'];
const TONE_KEY = 'emoji_picker_tone_v1';
// amostra de cor (UI sem emoji): padrão amarelo + 5 tons Fitzpatrick
const TONE_SWATCH = ['#FFC83D', '#F7DECE', '#F3D2A2', '#D5AB88', '#AF7E57', '#7C533E'];

function _fold(s) {
  try { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); } catch { return String(s || '').toLowerCase(); }
}
const _strip = (s) => String(s || '').replace(/️/g, '');

let _parsed = null;
let _toneSet = null;
function _data() {
  if (!_parsed) {
    _parsed = EMOJI_FULL_CATS.map((c) => {
      const e = []; const k = [];
      for (const s of c.list) {
        const sp = s.indexOf(' ');
        e.push(sp > 0 ? s.slice(0, sp) : s);
        k.push(sp > 0 ? s.slice(sp + 1) : '');
      }
      return { tk: c.tk, fb: c.fb, e, k };
    });
    _toneSet = new Set(String(EMOJI_TONE_BASES || '').split('|'));
  }
  return _parsed;
}

/** Aplica o tom de pele (modificador logo após o 1º code point) se o emoji aceita. */
export function applySkinTone(em, tone) {
  if (!tone || !em) return em;
  _data();
  if (!_toneSet.has(_strip(em))) return em;
  const cps = Array.from(_strip(em));
  if (!cps.length) return em;
  return cps[0] + tone + cps.slice(1).join('');
}

function _mmkv() { try { return require('../../services/mmkv'); } catch { return null; } }

export function getPickerRecents() {
  const out = [];
  const seen = new Set();
  const push = (em) => { if (em && !seen.has(em) && out.length < 32) { seen.add(em); out.push(em); } };
  try { const l = _mmkv()?.getJSON(RECENT_KEY); if (Array.isArray(l)) l.forEach(push); } catch {}
  try { require('./nativeContextMenu').recentEmojis().forEach(push); } catch {}
  return out;
}

export function notePickerRecent(em) {
  if (!em) return;
  try {
    const m = _mmkv(); if (!m) return;
    const l = m.getJSON(RECENT_KEY);
    const arr = (Array.isArray(l) ? l : []).filter((x) => x !== em);
    arr.unshift(em);
    m.setJSON(RECENT_KEY, arr.slice(0, 32));
  } catch {}
}

/**
 * Props: colors, t, onPick(emoji), cell (px, opcional), mine (emoji atual p/ destacar).
 */
export default function ChatEmojiPicker({ colors = {}, t, onPick, mine = '' }) {
  const tt = (k, fb) => { try { const v = t?.(k); return v && v !== k ? v : fb; } catch { return fb; } };
  const cats = _data();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState(-1); // -1 = recentes
  const [tone, setToneState] = useState(() => { try { const v = _mmkv()?.getString(TONE_KEY); return TONES.includes(v || '') ? (v || '') : ''; } catch { return ''; } });
  const [recents, setRecents] = useState(() => getPickerRecents());
  const setTone = (v) => { setToneState(v); try { _mmkv()?.setString(TONE_KEY, v); } catch {} };

  const effCat = cat === -1 && recents.length === 0 ? 0 : cat;

  const list = useMemo(() => {
    const f = _fold(q.trim());
    if (f) {
      const words = f.split(/\s+/).filter(Boolean);
      const seen = new Set(); const out = [];
      for (const c of cats) {
        c.e.forEach((em, i) => {
          if (seen.has(em) || out.length >= 240) return;
          const kw = c.k[i];
          if (em === q.trim() || words.every((w) => kw.includes(w))) { seen.add(em); out.push(em); }
        });
      }
      return out;
    }
    if (effCat === -1) return recents;
    return cats[effCat]?.e || [];
  }, [q, effCat, recents, cats]);

  const pick = useCallback((em) => {
    const out = applySkinTone(em, tone);
    notePickerRecent(out);
    setRecents(getPickerRecents());
    onPick?.(out);
  }, [tone, onPick]);

  const chip = (key, label, active, onPress) => (
    <Pressable
      key={key}
      onPress={onPress}
      style={[st.chip, { backgroundColor: active ? (colors.primary || '#007AFF') + '22' : 'transparent' }]}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
    >
      <Text style={{ color: active ? (colors.primary || '#007AFF') : (colors.textSecondary || '#888'), fontWeight: '600', fontSize: 13 }} numberOfLines={1}>{label}</Text>
    </Pressable>
  );

  return (
    <View>
      <View style={[st.searchRow, { backgroundColor: colors.inputBackground || colors.background || 'rgba(127,127,127,0.12)', borderColor: colors.border || 'transparent' }]}>
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder={tt('chatConv.emojiSearch', 'Buscar emoji')}
          placeholderTextColor={colors.textTertiary || colors.textSecondary || '#999'}
          style={[st.search, { color: colors.text || '#000' }, Platform.OS === 'web' ? { outlineStyle: 'none' } : null]}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          accessibilityLabel={tt('chatConv.emojiSearch', 'Buscar emoji')}
        />
        {q ? (
          <Pressable onPress={() => setQ('')} hitSlop={8} accessibilityRole="button" accessibilityLabel={tt('common.clear', 'Limpar')}>
            <IconX size={16} color={colors.textSecondary || '#888'} />
          </Pressable>
        ) : null}
      </View>
      {!q ? (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 6, paddingHorizontal: 2, paddingBottom: 6 }}>
            {recents.length ? chip('rec', tt('chatConv.emojiRecent', 'Recentes'), effCat === -1, () => setCat(-1)) : null}
            {cats.map((c, i) => chip(c.tk, tt(c.tk, c.fb), effCat === i, () => setCat(i)))}
          </ScrollView>
          <View style={st.toneRow}>
            <Text style={{ color: colors.textSecondary || '#888', fontSize: 12, marginRight: 6 }}>{tt('chatConv.emojiSkinTone', 'Tom de pele')}</Text>
            {TONES.map((tn) => (
              <Pressable
                key={tn || 'none'}
                onPress={() => setTone(tn)}
                style={[st.toneBtn, tone === tn && { backgroundColor: (colors.primary || '#007AFF') + '22' }]}
                accessibilityRole="button"
                accessibilityState={{ selected: tone === tn }}
                accessibilityLabel={tt('chatConv.emojiSkinTone', 'Tom de pele') + ' ' + (TONES.indexOf(tn) + 1)}
              >
                <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: TONE_SWATCH[TONES.indexOf(tn)] }} />
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
      {list.length === 0 ? (
        <Text style={{ color: colors.textSecondary || '#888', textAlign: 'center', paddingVertical: 24, fontSize: 14 }}>
          {tt('chatConv.emojiNoResults', 'Nenhum emoji encontrado')}
        </Text>
      ) : (
        <View style={st.grid}>
          {list.map((em) => {
            const shown = applySkinTone(em, tone);
            return (
              <Pressable
                key={em}
                onPress={() => pick(em)}
                style={({ pressed }) => [st.cell, (shown === mine) && { backgroundColor: (colors.primary || '#007AFF') + '22' }, pressed && { transform: [{ scale: 1.2 }] }]}
                accessibilityRole="button"
                accessibilityLabel={shown}
              >
                <Text style={st.emoji} allowFontScaling={false}>{shown}</Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  searchRow: { flexDirection: 'row', alignItems: 'center', borderRadius: 10, paddingHorizontal: 12, marginBottom: 8, height: 38, borderWidth: StyleSheet.hairlineWidth },
  search: { flex: 1, fontSize: 15, paddingVertical: 0 },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14 },
  toneRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, paddingBottom: 4 },
  toneBtn: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: '12.5%', aspectRatio: 1, justifyContent: 'center', alignItems: 'center', borderRadius: 10 },
  emoji: { fontSize: 26 },
});
