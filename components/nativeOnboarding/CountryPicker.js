// [2026-10-15 native-onboarding] Seletor de país nativo: folha (pageSheet no
// iOS, deslizar p/ fechar), busca por nome localizado / nome em inglês / ISO /
// DDI, sem acento, bandeiras SVG (FlagIcon), sugeridos no topo.
import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import {
  Modal, View, Text, TextInput, FlatList, Pressable, StyleSheet, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COUNTRIES, countryDisplayName } from '../../constants/countries';
import { IconX, IconCheck, IconSearch } from '../Icons';
import FlagIcon from './FlagIcon';
// [2026-10-18 onboarding-native-picker] Lista em NATIVO (ChatyyResultList:
// UICollectionView / RecyclerView, destaque do termo sem acento) dentro da
// MESMA folha (pageSheet iOS). Seletor ÚNICO: app/signup-phone.js também usa
// este componente quando o nativo está ligado. Kill switch (OTA/console):
// globalThis.__chatyy_onboarding_native_picker = false → FlatList JS abaixo.
import NativeResultList, { useNativeResults } from '../native/NativeResultList';
import { gradientIndex } from '../chatlist/nativeAdapter';

export const ONBOARDING_PICKER_KILL = '__chatyy_onboarding_native_picker';
/** Seletor nativo disponível? (binário com ChatyyResultList + kill switch + sem falha na sessão). */
export function onboardingNativePickerOn() {
  if (Platform.OS === 'web') return false;
  try {
    if (globalThis[ONBOARDING_PICKER_KILL] === false) return false;
    return require('../native/NativeResultList').nativeResultsEnabled(ONBOARDING_PICKER_KILL);
  } catch { return false; }
}

const ROW_H = 56;

function _norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

export default function CountryPicker({ visible, onClose, onSelect, selected, suggested = [], colors, t, language, isDark }) {
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState('');
  const inputRef = useRef(null);
  useEffect(() => { if (!visible) setQ(''); }, [visible]);

  const all = useMemo(() => {
    const loc = language || 'pt-BR';
    const seen = new Set();
    const list = [];
    for (const c of COUNTRIES) {
      if (seen.has(c.code)) continue;
      seen.add(c.code);
      const label = countryDisplayName(c, loc, t);
      list.push({ ...c, label, _k: `${_norm(label)} ${_norm(c.name)} ${c.code.toLowerCase()} ${c.dial} ${c.dial.replace('+', '')}` });
    }
    try { list.sort((a, b) => a.label.localeCompare(b.label, loc)); } catch { list.sort((a, b) => (a.label > b.label ? 1 : -1)); }
    return list;
  }, [language, t]);

  const data = useMemo(() => {
    const nq = _norm(q).replace(/^\+/, '');
    if (nq) {
      const digits = /^\d+$/.test(nq);
      return all.filter((c) => (digits ? c.dial.replace('+', '').startsWith(nq) : c._k.includes(nq)));
    }
    const sug = [];
    const seen = new Set();
    for (const code of [selected, ...suggested]) {
      const c = code && all.find((x) => x.code === code);
      if (c && !seen.has(c.code)) { seen.add(c.code); sug.push(c); }
    }
    if (!sug.length) return all;
    return [
      { _header: true, key: 'h1', title: t('signupPhone.countrySuggested') || 'Sugerido' },
      ...sug.map((c) => ({ ...c, key: `s-${c.code}` })),
      { _header: true, key: 'h2', title: t('signupPhone.countryAll') || 'Todos os países' },
      ...all,
    ];
  }, [q, all, selected, suggested, t]);

  const pick = useCallback((c) => {
    try { require('../../services/haptics').selection?.(); } catch {}
    onSelect?.(c.code);
  }, [onSelect]);

  const renderItem = useCallback(({ item }) => {
    if (item._header) {
      return (
        <Text style={[st.header, { color: colors.textSecondary }]} accessibilityRole="header">{item.title}</Text>
      );
    }
    const on = item.code === selected;
    return (
      <Pressable
        onPress={() => pick(item)}
        style={({ pressed }) => [st.row, { backgroundColor: pressed ? colors.surfaceVariant : 'transparent' }]}
        accessibilityRole="button"
        accessibilityState={{ selected: on }}
        accessibilityLabel={`${item.label}, ${item.dial}`}
      >
        <FlagIcon code={item.code} width={30} borderColor={colors.border} textColor={colors.text} />
        <Text style={[st.name, { color: colors.text }]} numberOfLines={1} maxFontSizeMultiplier={1.4}>{item.label}</Text>
        <Text style={[st.dial, { color: colors.textSecondary }]} maxFontSizeMultiplier={1.4}>{item.dial}</Text>
        <View style={st.check}>{on ? <IconCheck size={18} color={colors.text} strokeWidth={2.6} /> : null}</View>
      </Pressable>
    );
  }, [colors, selected, pick]);

  const keyExtractor = useCallback((item) => item.key || item.code, []);

  // ── Nativo ────────────────────────────────────────────────────────────────
  const [nativeOn, onNativeFailure] = useNativeResults(ONBOARDING_PICKER_KILL);
  const useNative = nativeOn && Platform.OS !== 'web';
  const byId = useRef(new Map());
  const nativeRows = useMemo(() => {
    if (!useNative) return [];
    const out = [];
    const map = new Map();
    const selLabel = t('nob.countrySelected') || 'Selecionado';
    for (const item of data) {
      if (item._header) { out.push({ id: `s:${item.key}`, k: 's', t: String(item.title || '') }); continue; }
      const id = `c:${item.key || item.code}`;
      const on = item.code === selected;
      const row = {
        id, k: 'r', t: item.label, tm: item.dial, hl: 1,
        tiles: [{ u: '', i: String(item.code || '').toUpperCase(), g: gradientIndex(item.code || '') }],
        a11y: `${item.label}, ${item.dial}${on ? `, ${selLabel}` : ''}`,
      };
      if (on) row.sb = selLabel;
      out.push(row);
      map.set(id, item);
    }
    if (!out.length) out.push({ id: 'n:empty', k: 'n', t: t('nob.noCountry') || 'Nenhum país encontrado', gl: 'search', tap: 0 });
    byId.current = map;
    return out;
  }, [useNative, data, selected, t]);
  const onNativePress = useCallback((id) => { const c = byId.current.get(id); if (c) pick(c); }, [pick]);

  return (
    <Modal
      visible={!!visible}
      animationType="slide"
      presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : undefined} allowSwipeDismissal /* [2026-10-17 drag-dismiss] RN 0.83: sem isso o pageSheet NÃO desce interativo (modalInPresentation=YES) */
      transparent={false}
      onRequestClose={onClose}
      statusBarTranslucent={Platform.OS === 'android'}
    >
      <View style={[st.root, { backgroundColor: colors.background, paddingTop: Platform.OS === 'ios' ? 8 : insets.top + 4 }]}>
        <View style={st.topBar}>
          <Pressable onPress={onClose} hitSlop={10} style={st.close} accessibilityRole="button" accessibilityLabel={t('common.close') || 'Fechar'}>
            <IconX size={22} color={colors.text} />
          </Pressable>
          <Text style={[st.title, { color: colors.text }]} accessibilityRole="header" maxFontSizeMultiplier={1.3}>
            {t('login.selectCountry') || 'Selecionar país'}
          </Text>
          <View style={st.close} />
        </View>
        <View style={[st.search, { backgroundColor: colors.surfaceVariant }]}>
          <IconSearch size={17} color={colors.textTertiary} />
          <TextInput
            ref={inputRef}
            value={q}
            onChangeText={setQ}
            placeholder={t('login.searchCountry') || 'Buscar país...'}
            placeholderTextColor={colors.textTertiary}
            style={[st.searchInput, { color: colors.text }, Platform.OS === 'web' ? { outlineStyle: 'none' } : null]}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            clearButtonMode="while-editing"
            accessibilityLabel={t('login.searchCountry') || 'Buscar país'}
            testID="nob-country-search"
          />
        </View>
        {useNative ? (
          <NativeResultList
            rows={nativeRows}
            highlight={_norm(q).replace(/^\+/, '')}
            colors={colors}
            isDark={isDark != null ? !!isDark : !!colors.isDark}
            separators
            swipeEnabled={false}
            bottomInset={insets.bottom + 24}
            onPress={onNativePress}
            onFailure={onNativeFailure}
          />
        ) : (
        <FlatList
          data={data}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          initialNumToRender={18}
          windowSize={9}
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
          ListEmptyComponent={(
            <Text style={[st.empty, { color: colors.textSecondary }]}>{t('nob.noCountry') || 'Nenhum país encontrado'}</Text>
          )}
        />
        )}
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  root: { flex: 1 },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, height: 52 },
  close: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700' },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginBottom: 6, paddingHorizontal: 12, height: 42, borderRadius: 12 },
  searchInput: { flex: 1, fontSize: 16, paddingVertical: 0 },
  header: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: ROW_H, paddingHorizontal: 20, gap: 14 },
  name: { flex: 1, fontSize: 16 },
  dial: { fontSize: 15, fontVariant: ['tabular-nums'] },
  check: { width: 22, alignItems: 'flex-end' },
  empty: { textAlign: 'center', marginTop: 40, fontSize: 15 },
});
