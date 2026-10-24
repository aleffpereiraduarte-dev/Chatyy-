// [2026-10-24 reels-marcar] "Marcar pessoas" da tela de publicar do estúdio (nível Instagram).
// Busca (studioApi.tagSearch: seguidos/seguidores/conversas primeiro; servidor tira bloqueados
// e quem desligou "me encontrar"), até TAG_MAX (20) pessoas, chips com remover, "Pronto".
// Sem campo vazio: abre com sugestões. Nada de emoji (ícones SVG).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, StyleSheet, TouchableOpacity, FlatList, ActivityIndicator, ScrollView } from 'react-native';
import AvatarCircle from '../AvatarCircle';
import { IconSearch, IconCheck, IconX } from '../Icons';
import { C, StudioSheet } from './ui';
import { tagSearch, TAG_MAX } from '../../services/videoStudio/studioApi';

export default function TagPeopleSheet({ visible, onClose, tagged, onChange, t }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(false);
  const [limitHit, setLimitHit] = useState(false);
  const reqRef = useRef(0);
  const list = Array.isArray(tagged) ? tagged : [];

  const run = useCallback((text) => {
    const id = ++reqRef.current;
    setLoading(true); setErr(false);
    tagSearch(text).then((r) => {
      if (id !== reqRef.current) return;
      setItems(r.ok ? r.users : []);
      setErr(!r.ok);
    }).catch(() => { if (id === reqRef.current) { setItems([]); setErr(true); } })
      .finally(() => { if (id === reqRef.current) setLoading(false); });
  }, []);

  useEffect(() => {
    if (!visible) return undefined;
    const tm = setTimeout(() => run(q), q ? 250 : 0);
    return () => clearTimeout(tm);
  }, [q, visible, run]);
  useEffect(() => { if (!visible) { setQ(''); setLimitHit(false); } }, [visible]);

  const isOn = (email) => list.some((p) => p.email === email);
  const toggle = (u) => {
    if (isOn(u.email)) { onChange(list.filter((p) => p.email !== u.email)); setLimitHit(false); return; }
    if (list.length >= TAG_MAX) { setLimitHit(true); return; }
    onChange([...list, { email: u.email, name: u.name, username: u.username || null }]);
  };

  const label = (p) => (p.username ? `@${p.username}` : (p.name || p.email.split('@')[0]));

  return (
    <StudioSheet
      visible={visible}
      onClose={onClose}
      full
      avoidKeyboard
      title={t('studio.tag.title')}
      right={(
        <TouchableOpacity onPress={onClose} hitSlop={10} accessibilityRole="button">
          <Text style={styles.done}>{t('studio.tag.done')}</Text>
        </TouchableOpacity>
      )}
    >
      <View style={styles.searchRow}>
        <IconSearch size={16} color={C.fg2} />
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder={t('studio.tag.search')}
          placeholderTextColor={C.fg3}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel={t('studio.tag.search')}
        />
        {!!q && (
          <TouchableOpacity onPress={() => setQ('')} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common.clear')}>
            <IconX size={16} color={C.fg2} />
          </TouchableOpacity>
        )}
      </View>
      <Text style={[styles.count, limitHit && { color: '#FF6B6B' }]}>
        {limitHit ? t('studio.tag.limit').replace('{n}', String(TAG_MAX)) : t('studio.tag.count').replace('{n}', String(list.length)).replace('{max}', String(TAG_MAX))}
      </Text>
      {list.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={styles.chips} keyboardShouldPersistTaps="handled">
          {list.map((p) => (
            <TouchableOpacity key={p.email} onPress={() => toggle(p)} style={styles.chip} accessibilityRole="button" accessibilityLabel={`${t('studio.tag.remove')} ${label(p)}`}>
              <Text style={styles.chipTxt} numberOfLines={1}>{label(p)}</Text>
              <IconX size={13} color="#000" />
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
      {!q && items.length > 0 && <Text style={styles.section}>{t('studio.tag.suggested')}</Text>}
      <FlatList
        data={items}
        keyExtractor={(u) => u.email}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 24 }}
        ListEmptyComponent={loading ? <ActivityIndicator color="#fff" style={{ marginTop: 24 }} /> : (
          <Text style={styles.empty}>{err ? t('studio.tag.error') : (q ? t('studio.tag.none') : t('studio.tag.hint'))}</Text>
        )}
        renderItem={({ item }) => {
          const on = isOn(item.email);
          return (
            <TouchableOpacity onPress={() => toggle(item)} style={styles.row} accessibilityRole="checkbox" accessibilityState={{ checked: on }}>
              <AvatarCircle email={item.email} name={item.name} size={42} />
              <View style={{ flex: 1 }}>
                <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                <Text style={styles.sub} numberOfLines={1}>
                  {[item.username ? `@${item.username}` : null, item.rel === 'following' ? t('studio.tag.relFollowing') : item.rel === 'follower' ? t('studio.tag.relFollower') : null].filter(Boolean).join(' · ')}
                </Text>
              </View>
              <View style={[styles.check, on && styles.checkOn]}>{on ? <IconCheck size={14} color="#000" /> : null}</View>
            </TouchableOpacity>
          );
        }}
      />
    </StudioSheet>
  );
}

const styles = StyleSheet.create({
  done: { color: '#fff', fontSize: 15, fontWeight: '800' },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginTop: 4, height: 40, borderRadius: 12, backgroundColor: C.card, paddingHorizontal: 12 },
  input: { flex: 1, color: '#fff', fontSize: 15, paddingVertical: 0 },
  count: { color: C.fg3, fontSize: 12, marginHorizontal: 16, marginTop: 8 },
  chips: { gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 30, paddingHorizontal: 12, borderRadius: 15, backgroundColor: '#fff', maxWidth: 200 },
  chipTxt: { color: '#000', fontSize: 13, fontWeight: '700', flexShrink: 1 },
  section: { color: C.fg2, fontSize: 12, fontWeight: '700', marginHorizontal: 16, marginTop: 8, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  name: { color: '#fff', fontSize: 15, fontWeight: '700' },
  sub: { color: C.fg2, fontSize: 12, marginTop: 1 },
  check: { width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.4)', alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: '#fff', borderColor: '#fff' },
  empty: { color: C.fg2, fontSize: 13, textAlign: 'center', marginTop: 28, paddingHorizontal: 32, lineHeight: 19 },
});
