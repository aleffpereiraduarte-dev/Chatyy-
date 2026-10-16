/**
 * /chat-folders — LISTAS de conversa (WhatsApp "Listas" / Telegram "Pastas").
 * [2026-10-16 wave12-B pastas]
 *
 *  /chat-folders            → suas listas: arrastar p/ reordenar (ordem = ordem
 *                             dos chips em Conversas), tocar p/ editar, criar.
 *  /chat-folders?new=1      → editor de lista nova (&preset=personal|work)
 *  /chat-folders?edit=<id>  → editor: nome, ícone SVG opcional, conversas
 *                             escolhidas (seletor com busca) + regras rápidas
 *                             (incluir não lidas/contatos/grupos/canais;
 *                             excluir arquivadas/silenciadas), apagar.
 *
 * Dados: components/chatlist/chatFoldersStore (useSyncExternalStore) — o
 * mesmo store dos chips do ChatListTab, então tudo reflete na hora. As regras
 * viajam no campo `icon` (o PHP não aceita filter_type no update; ver o store).
 * P&B premium, sem emoji (SVG).
 */
import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Pressable, TextInput, Modal, FlatList,
  ActivityIndicator, Animated, PanResponder, Platform, KeyboardAvoidingView,
} from 'react-native';
import { useRouter, Stack, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { USE_NATIVE_HEADER, nativeHeaderOptions, HeaderIconButton, nativeScrollInsetProps } from '../components/nativeHeader';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconArrowLeft, IconPlus, IconSearch, IconX, IconCheck, IconChevronRight, IconUsers, IconUser, IconMegaphone, IconMarkUnread, IconArchive, IconVolumeX, IconTrash } from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';
import FolderGlyph, { FolderIconByKey } from '../components/chatlist/FolderGlyph';
import {
  useChatFolders, loadFolders, createFolder, updateFolder, deleteFolder, reorderFolders,
  parseFolderIcon, folderIds, folderMatcher, getConversationsSnapshot, publishConversations,
  FOLDER_ICON_KEYS,
} from '../components/chatlist/chatFoldersStore';
import * as api from '../services/api';
import { emailToDisplayName } from '../services/api';
import { haptic } from '../constants/theme';

const ROW_H = 64;
const isWeb = Platform.OS === 'web';
const INCLUDE_RULES = [
  { k: 'u', label: 'ruleUnread', sub: 'ruleUnreadSub', Icon: IconMarkUnread },
  { k: 'c', label: 'ruleContacts', sub: 'ruleContactsSub', Icon: IconUser },
  { k: 'g', label: 'ruleGroups', sub: 'ruleGroupsSub', Icon: IconUsers },
  { k: 'h', label: 'ruleChannels', sub: 'ruleChannelsSub', Icon: IconMegaphone },
];
const EXCLUDE_RULES = [
  { k: 'a', label: 'ruleArchived', Icon: IconArchive },
  { k: 'm', label: 'ruleMuted', Icon: IconVolumeX },
];

function usePalette() {
  const { colors, isDark } = useTheme();
  return useMemo(() => ({
    isDark,
    colors,
    bg: isDark ? '#000000' : '#F2F2F7',
    card: isDark ? '#1C1C1E' : '#FFFFFF',
    text: isDark ? '#FFFFFF' : '#0A0A0A',
    sub: isDark ? 'rgba(255,255,255,0.56)' : 'rgba(0,0,0,0.5)',
    faint: isDark ? 'rgba(255,255,255,0.32)' : 'rgba(0,0,0,0.28)',
    hair: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
    chip: isDark ? '#2C2C2E' : '#EFEFF4',
    ink: isDark ? '#FFFFFF' : '#0A0A0A',      // preenchido (selecionado)
    onInk: isDark ? '#000000' : '#FFFFFF',
    danger: colors?.error || '#E5484D',
  }), [colors, isDark]);
}

function useTf() {
  const { t } = useLanguage();
  return useCallback((k, p) => t(`folders12b.${k}`, p), [t]);
}

function convName(c) {
  const raw = c?.display_name || c?.name || c?.other_email || c?.contact_email || '';
  return emailToDisplayName(raw) || raw || '—';
}
function convEmail(c) {
  return (c?.type === 'group' || c?.type === 'channel') ? undefined : (c?.other_email || c?.contact_email || c?.peer_email || undefined);
}
const _fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Conversas p/ o seletor/prévia: foto publicada pela lista; sem ela (web aberto
// direto na rota) busca uma vez no servidor.
function useConversations() {
  const [snap, setSnap] = useState(() => getConversationsSnapshot());
  const empty = !snap.active.length && !snap.archived.length;
  useEffect(() => {
    if (!empty) return;
    let alive = true;
    api.chatConversations('', true).then(r => {
      if (!alive || !r?.success) return;
      const all = Array.isArray(r.data) ? r.data : (r.data?.conversations || []);
      const ok = all.filter(c => c && !c.locked);
      const active = ok.filter(c => !c.archived);
      const archived = ok.filter(c => c.archived);
      publishConversations(active, archived);
      setSnap(getConversationsSnapshot());
    }).catch(() => {});
    return () => { alive = false; };
  }, [empty]);
  return snap;
}

function countLabel(tf, n) {
  return n === 1 ? tf('countOne') : tf('count', { n });
}

function folderSummary(tf, f) {
  const ids = folderIds(f);
  const { rules } = parseFolderIcon(f?.icon);
  const parts = [];
  if (ids.size) parts.push(countLabel(tf, ids.size));
  for (const r of INCLUDE_RULES) if (rules[r.k]) parts.push(tf(r.label));
  if (!parts.length) parts.push(countLabel(tf, 0));
  return parts.join(' · ');
}

// ───────────────────────── header (web custom / nativo) ─────────────────────────
function ScreenHeader({ title, right, onBack, P }) {
  const insets = useSafeAreaInsets();
  if (USE_NATIVE_HEADER) {
    return (
      <Stack.Screen options={nativeHeaderOptions({
        colors: { ...P.colors, background: P.bg }, isDark: P.isDark, title,
        headerRight: right ? () => right : undefined,
      })} />
    );
  }
  return (
    <View style={[st.webHeader, { paddingTop: insets.top + 10, backgroundColor: P.bg, borderBottomColor: P.hair }]}>
      <TouchableOpacity onPress={onBack} hitSlop={10} accessibilityRole="button" style={st.webHeaderSide}>
        <IconArrowLeft size={22} color={P.text} />
      </TouchableOpacity>
      <Text style={[st.webHeaderTitle, { color: P.text }]} numberOfLines={1}>{title}</Text>
      <View style={[st.webHeaderSide, { alignItems: 'flex-end' }]}>{right}</View>
    </View>
  );
}

// ───────────────────────── linha arrastável ─────────────────────────
function DragRow({ index, count, shift, dragging, dy, onStart, onMove, onEnd, children }) {
  const cbRef = useRef({ onStart, onMove, onEnd, index });
  useEffect(() => { cbRef.current = { onStart, onMove, onEnd, index }; });
  const [anim] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (dragging) return;
    if (shift == null) { anim.setValue(0); return; }
    Animated.timing(anim, { toValue: shift, duration: 160, useNativeDriver: !isWeb }).start();
  }, [shift, dragging, anim]);
  // Criado no effect (refs só fora do render — React Compiler).
  const [pr, setPr] = useState(null);
  useEffect(() => { setPr(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
    onPanResponderGrant: () => { const c = cbRef.current; c.onStart(c.index); },
    onPanResponderMove: (_e, g) => { const c = cbRef.current; c.onMove(c.index, g.dy); },
    onPanResponderRelease: (_e, g) => { const c = cbRef.current; c.onEnd(c.index, g.dy); },
    onPanResponderTerminate: (_e, g) => { const c = cbRef.current; c.onEnd(c.index, g.dy); },
  })); }, []);
  const style = dragging
    ? { transform: [{ translateY: dy }, { scale: 1.02 }], zIndex: 10, elevation: 8, shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } }
    : { transform: [{ translateY: anim }], zIndex: 1 };
  return (
    <Animated.View style={[{ height: ROW_H }, style]}>
      {children({ handleProps: pr ? pr.panHandlers : null, index, count })}
    </Animated.View>
  );
}

// ───────────────────────── tela: suas listas ─────────────────────────
function FoldersList() {
  const router = useRouter();
  const P = usePalette();
  const tf = useTf();
  const { items, loaded } = useChatFolders();
  const [drag, setDrag] = useState(null); // { from, to }
  const [dy] = useState(() => new Animated.Value(0));

  useEffect(() => { loadFolders(); }, []);

  const nItems = items.length;
  const clampTo = useCallback((from, d) => Math.max(0, Math.min(nItems - 1, from + Math.round(d / ROW_H))), [nItems]);
  const onStart = useCallback((i) => {
    dy.setValue(0);
    setDrag({ from: i, to: i });
    try { haptic.medium(); } catch {}
  }, [dy]);
  const onMove = useCallback((i, d) => {
    dy.setValue(d);
    const to = clampTo(i, d);
    setDrag(prev => {
      if (!prev || prev.to === to) return prev;
      try { haptic.select(); } catch {}
      return { ...prev, to };
    });
  }, [dy, clampTo]);
  const move = useCallback((from, to) => {
    if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return;
    const ids = items.map(f => f.id);
    const [x] = ids.splice(from, 1);
    ids.splice(to, 0, x);
    reorderFolders(ids);
  }, [items]);
  const onEnd = useCallback((i, d) => {
    const to = clampTo(i, d);
    setDrag(null);
    dy.setValue(0);
    if (to !== i) { try { haptic.light(); } catch {} move(i, to); }
  }, [dy, move, clampTo]);

  const shiftFor = (i) => {
    if (!drag || i === drag.from) return null;
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return -ROW_H;
    if (drag.from > drag.to && i < drag.from && i >= drag.to) return ROW_H;
    return 0;
  };

  const existingNames = new Set(items.map(f => _fold(f.name)));
  const suggestions = [
    { preset: 'personal', name: tf('sugPersonal'), sub: tf('sugPersonalSub'), iconKey: 'us' },
    { preset: 'work', name: tf('sugWork'), sub: tf('sugWorkSub'), iconKey: 'wk' },
  ].filter(s => !existingNames.has(_fold(s.name)));

  const back = () => (router.canGoBack() ? router.back() : router.replace('/chat'));

  return (
    <View style={{ flex: 1, backgroundColor: P.bg }}>
      <ScreenHeader
        P={P}
        title={tf('title')}
        onBack={back}
        right={(
          <HeaderIconButton onPress={() => router.push('/chat-folders?new=1')} accessibilityLabel={tf('create')} testID="folders-create-header">
            <IconPlus size={22} color={P.text} />
          </HeaderIconButton>
        )}
      />
      <ScrollView
        {...(nativeScrollInsetProps() || {})}
        scrollEnabled={!drag}
        contentContainerStyle={st.scrollPad}
      >
        <View style={st.hero}>
          <View style={[st.heroBadge, { backgroundColor: P.ink }]}>
            <FolderIconByKey iconKey="fd" size={26} color={P.onInk} />
          </View>
          <Text style={[st.heroText, { color: P.sub }]}>{tf('intro')}</Text>
        </View>

        {!loaded && !items.length ? (
          <View style={{ paddingVertical: 28 }}><ActivityIndicator color={P.text} /></View>
        ) : (
          <>
            <Text style={[st.sectionLabel, { color: P.sub }]}>{tf('yourLists').toUpperCase()}</Text>
            <View style={[st.card, { backgroundColor: P.card }]}>
              <Pressable
                onPress={() => router.push('/chat-folders?new=1')}
                style={({ pressed }) => [st.createRow, pressed && { opacity: 0.6 }]}
                accessibilityRole="button"
                testID="folders-create-row"
              >
                <View style={[st.glyph, { backgroundColor: P.chip }]}><IconPlus size={18} color={P.text} /></View>
                <Text style={[st.rowTitle, { color: P.text }]}>{tf('create')}</Text>
              </Pressable>
              {items.length ? <View style={[st.hairline, { backgroundColor: P.hair, marginLeft: 64 }]} /> : null}
              {items.length === 0 ? (
                <View style={st.emptyBox}>
                  <Text style={[st.emptyTitle, { color: P.text }]}>{tf('emptyTitle')}</Text>
                  <Text style={[st.emptySub, { color: P.sub }]}>{tf('emptySub')}</Text>
                </View>
              ) : (
                <View>
                  {items.map((f, i) => (
                    <DragRow
                      key={f.id}
                      index={i}
                      count={items.length}
                      shift={shiftFor(i)}
                      dragging={!!drag && drag.from === i}
                      dy={dy}
                      onStart={onStart}
                      onMove={onMove}
                      onEnd={onEnd}
                    >
                      {({ handleProps }) => (
                        <View style={[st.folderRow, { backgroundColor: P.card }]}>
                          <Pressable
                            onPress={() => router.push(`/chat-folders?edit=${f.id}`)}
                            style={({ pressed }) => [st.folderMain, pressed && { opacity: 0.6 }]}
                            accessibilityRole="button"
                            accessibilityLabel={`${f.name}, ${folderSummary(tf, f)}`}
                            accessibilityActions={[{ name: 'moveUp', label: tf('moveUp') }, { name: 'moveDown', label: tf('moveDown') }]}
                            onAccessibilityAction={(e) => {
                              if (e.nativeEvent.actionName === 'moveUp') move(i, i - 1);
                              else if (e.nativeEvent.actionName === 'moveDown') move(i, i + 1);
                            }}
                            testID={`folder-row-${f.id}`}
                          >
                            <View style={[st.glyph, { backgroundColor: P.chip }]}><FolderGlyph folder={f} size={18} color={P.text} /></View>
                            <View style={{ flex: 1, minWidth: 0 }}>
                              <Text style={[st.rowTitle, { color: P.text }]} numberOfLines={1}>{f.name}</Text>
                              <Text style={[st.rowSub, { color: P.sub }]} numberOfLines={1}>{folderSummary(tf, f)}</Text>
                            </View>
                          </Pressable>
                          <View
                            {...handleProps}
                            style={[st.handle, isWeb && { cursor: 'grab', touchAction: 'none' }]}
                            accessibilityLabel={tf('dragHandle')}
                            testID={`folder-handle-${f.id}`}
                          >
                            <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={P.faint} strokeWidth={2} strokeLinecap="round">
                              <Path d="M4 8h16M4 12h16M4 16h16" />
                            </Svg>
                          </View>
                          {i < items.length - 1 ? <View style={[st.hairline, st.rowHair, { backgroundColor: P.hair }]} /> : null}
                        </View>
                      )}
                    </DragRow>
                  ))}
                </View>
              )}
            </View>
            {items.length > 1 ? <Text style={[st.footnote, { color: P.sub }]}>{tf('reorderHint')}</Text> : null}

            {suggestions.length ? (
              <>
                <Text style={[st.sectionLabel, { color: P.sub, marginTop: 22 }]}>{tf('suggestions').toUpperCase()}</Text>
                <View style={[st.card, { backgroundColor: P.card }]}>
                  {suggestions.map((s, i) => (
                    <View key={s.preset}>
                      {i > 0 ? <View style={[st.hairline, { backgroundColor: P.hair, marginLeft: 64 }]} /> : null}
                      <View style={st.sugRow}>
                        <View style={[st.glyph, { backgroundColor: P.chip }]}><FolderIconByKey iconKey={s.iconKey} size={18} color={P.text} /></View>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={[st.rowTitle, { color: P.text }]} numberOfLines={1}>{s.name}</Text>
                          <Text style={[st.rowSub, { color: P.sub }]} numberOfLines={2}>{s.sub}</Text>
                        </View>
                        <Pressable
                          onPress={() => router.push(`/chat-folders?new=1&preset=${s.preset}`)}
                          style={({ pressed }) => [st.pillBtn, { backgroundColor: P.ink }, pressed && { opacity: 0.7 }]}
                          accessibilityRole="button"
                          testID={`folder-suggest-${s.preset}`}
                        >
                          <Text style={[st.pillBtnText, { color: P.onInk }]}>{tf('create')}</Text>
                        </Pressable>
                      </View>
                    </View>
                  ))}
                </View>
              </>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

// ───────────────────────── seletor de conversas ─────────────────────────
function ChatPicker({ visible, initial, convs, onCancel, onDone }) {
  const P = usePalette();
  const tf = useTf();
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(() => new Set(initial));
  // Reabre com as escolhidas do rascunho (só na transição fechado→aberto).
  const initialRef = useRef(initial);
  useEffect(() => { initialRef.current = initial; });
  useEffect(() => { if (visible) { setSel(new Set(initialRef.current)); setQ(''); } }, [visible]);
  const all = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const c of [...convs.active, ...convs.archived.map(c => ({ ...c, _arch: true }))]) {
      if (!c || seen.has(Number(c.id))) continue;
      seen.add(Number(c.id));
      out.push(c);
    }
    return out;
  }, [convs]);
  const data = useMemo(() => {
    const fq = _fold(q.trim());
    return fq ? all.filter(c => _fold(convName(c)).includes(fq) || _fold(c.other_email).includes(fq)) : all;
  }, [all, q]);
  const toggle = (id) => {
    try { haptic.select(); } catch {}
    setSel(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };
  const typeLabel = (c) => (c.type === 'group' ? tf('typeGroup') : c.type === 'channel' ? tf('typeChannel') : tf('typeContact'));
  return (
    <Modal visible={visible} animationType="slide" presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : undefined} onRequestClose={onCancel}>
      <View style={{ flex: 1, backgroundColor: P.bg, paddingTop: Platform.OS === 'ios' ? 0 : insets.top }}>
        <View style={[st.pickHeader, { borderBottomColor: P.hair }]}>
          <TouchableOpacity onPress={onCancel} hitSlop={10} style={st.pickSide} accessibilityRole="button">
            <Text style={[st.pickBtn, { color: P.text }]}>{tf('cancel')}</Text>
          </TouchableOpacity>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text style={[st.pickTitle, { color: P.text }]} numberOfLines={1}>{tf('pickTitle')}</Text>
            <Text style={[st.pickCount, { color: P.sub }]}>{tf('selectedN', { n: sel.size })}</Text>
          </View>
          <TouchableOpacity onPress={() => onDone(Array.from(sel))} hitSlop={10} style={[st.pickSide, { alignItems: 'flex-end' }]} accessibilityRole="button" testID="folder-picker-done">
            <Text style={[st.pickBtn, { color: P.text, fontWeight: '700' }]}>{tf('done')}</Text>
          </TouchableOpacity>
        </View>
        <View style={[st.searchBox, { backgroundColor: P.chip }]}>
          <IconSearch size={16} color={P.sub} />
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder={tf('search')}
            placeholderTextColor={P.faint}
            style={[st.searchInput, { color: P.text }, isWeb && { outlineStyle: 'none' }]}
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
            testID="folder-picker-search"
          />
          {q && Platform.OS !== 'ios' ? (
            <TouchableOpacity onPress={() => setQ('')} hitSlop={8}><IconX size={16} color={P.sub} /></TouchableOpacity>
          ) : null}
        </View>
        <FlatList
          data={data}
          keyExtractor={(c) => String(c.id)}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          initialNumToRender={16}
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
          ListEmptyComponent={<Text style={[st.emptySub, { color: P.sub, marginTop: 40 }]}>{tf('noResults')}</Text>}
          renderItem={({ item: c }) => {
            const on = sel.has(Number(c.id));
            const name = convName(c);
            return (
              <Pressable
                onPress={() => toggle(Number(c.id))}
                style={({ pressed }) => [st.pickRow, pressed && { backgroundColor: P.hair }]}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={name}
              >
                <AvatarCircle name={name} email={convEmail(c)} uri={c.avatar || c.avatar_url} size={42} members={c.members} />
                <View style={{ flex: 1, minWidth: 0, marginLeft: 12 }}>
                  <Text style={[st.rowTitle, { color: P.text }]} numberOfLines={1}>{name}</Text>
                  <Text style={[st.rowSub, { color: P.sub }]} numberOfLines={1}>
                    {typeLabel(c)}{c._arch ? ` · ${tf('archivedTag')}` : ''}
                  </Text>
                </View>
                <View style={[st.check, on ? { backgroundColor: P.ink, borderColor: P.ink } : { borderColor: P.faint }]}>
                  {on ? <IconCheck size={14} color={P.onInk} /> : null}
                </View>
              </Pressable>
            );
          }}
        />
      </View>
    </Modal>
  );
}

// ───────────────────────── editor ─────────────────────────
function FolderEditor({ editId, preset }) {
  const router = useRouter();
  const P = usePalette();
  const tf = useTf();
  const { items, loaded } = useChatFolders();
  const convs = useConversations();
  const isNew = !editId;
  const folder = isNew ? null : items.find(f => String(f.id) === String(editId)) || null;
  const [draft, setDraft] = useState(null);
  const [picker, setPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { loadFolders(); }, []);
  useEffect(() => {
    if (draft) return;
    if (isNew) {
      if (preset === 'personal') setDraft({ name: tf('sugPersonal'), iconKey: 'us', rules: { c: true, a: true }, ids: [] });
      else if (preset === 'work') setDraft({ name: tf('sugWork'), iconKey: 'wk', rules: {}, ids: [] });
      else setDraft({ name: '', iconKey: '', rules: {}, ids: [] });
    } else if (folder) {
      const p = parseFolderIcon(folder.icon);
      setDraft({ name: String(folder.name || ''), iconKey: p.iconKey, rules: { ...p.rules }, ids: Array.from(folderIds(folder)) });
    }
  }, [draft, isNew, folder, preset, tf]);

  const back = () => (router.canGoBack() ? router.back() : router.replace('/chat-folders'));

  const byId = useMemo(() => {
    const m = new Map();
    for (const c of convs.active) m.set(Number(c.id), c);
    for (const c of convs.archived) m.set(Number(c.id), { ...c, _arch: true });
    return m;
  }, [convs]);

  const previewN = useMemo(() => {
    if (!draft) return 0;
    const m = folderMatcher({ icon: `~.${Object.keys(draft.rules).filter(k => draft.rules[k]).join('')}`, conversation_ids: draft.ids });
    let n = 0;
    for (const c of convs.active) if (m(c, false)) n++;
    if (m.includesArchived) for (const c of convs.archived) if (m(c, true)) n++;
    return n;
  }, [draft, convs]);

  const save = async () => {
    if (!draft || saving) return;
    const name = draft.name.trim();
    if (!name) { setErr(tf('nameRequired')); try { haptic.warning(); } catch {} return; }
    const dup = items.some(f => _fold(f.name) === _fold(name) && String(f.id) !== String(editId || ''));
    if (dup) { setErr(tf('dupName')); try { haptic.warning(); } catch {} return; }
    setSaving(true); setErr('');
    const r = isNew
      ? await createFolder({ name, iconKey: draft.iconKey, rules: draft.rules, ids: draft.ids })
      : await updateFolder(editId, { name, iconKey: draft.iconKey, rules: draft.rules, ids: draft.ids });
    setSaving(false);
    if (!r.ok) { setErr(tf('saveError')); try { haptic.error(); } catch {} return; }
    try { haptic.success(); } catch {}
    back();
  };

  const remove = () => {
    if (!folder) return;
    require('../services/alerts').safeAlert(
      tf('delete'),
      tf('deleteConfirm', { name: folder.name }),
      [
        { text: tf('cancel'), style: 'cancel' },
        {
          text: tf('delete'),
          style: 'destructive',
          onPress: async () => {
            const r = await deleteFolder(folder.id);
            if (r.ok) { try { haptic.success(); } catch {} back(); }
            else setErr(tf('saveError'));
          },
        },
      ],
    );
  };

  const title = isNew ? tf('newTitle') : tf('edit');
  const canSave = !!draft && !!draft.name.trim() && !saving;
  const saveBtn = (
    <Pressable
      onPress={save}
      disabled={!canSave}
      hitSlop={10}
      accessibilityRole="button"
      testID="folder-save"
      style={({ pressed }) => [{ paddingHorizontal: 6, paddingVertical: 4, opacity: !canSave ? 0.35 : pressed ? 0.5 : 1 }]}
    >
      {saving ? <ActivityIndicator size="small" color={P.text} /> : <Text style={{ color: P.text, fontSize: 17, fontWeight: '700' }}>{tf('save')}</Text>}
    </Pressable>
  );

  if (!draft) {
    return (
      <View style={{ flex: 1, backgroundColor: P.bg }}>
        <ScreenHeader P={P} title={title} onBack={back} />
        <View style={st.center}>
          {!isNew && loaded && !folder
            ? <Text style={[st.emptyTitle, { color: P.text }]}>{tf('notFound')}</Text>
            : <ActivityIndicator color={P.text} />}
        </View>
      </View>
    );
  }

  const setRule = (k) => {
    try { haptic.select(); } catch {}
    setDraft(d => ({ ...d, rules: { ...d.rules, [k]: !d.rules[k] } }));
  };
  const chosen = draft.ids.map(id => byId.get(Number(id)) || { id, name: '', _missing: true });

  return (
    <View style={{ flex: 1, backgroundColor: P.bg }}>
      <ScreenHeader P={P} title={title} onBack={back} right={saveBtn} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView {...(nativeScrollInsetProps() || {})} keyboardShouldPersistTaps="handled" contentContainerStyle={st.scrollPad}>
          {/* nome + ícone */}
          <View style={st.nameWrap}>
            <View style={[st.bigGlyph, { backgroundColor: P.ink }]}>
              <FolderIconByKey iconKey={draft.iconKey || 'fd'} size={30} color={P.onInk} />
            </View>
            <View style={[st.nameField, { backgroundColor: P.card }]}>
              <TextInput
                value={draft.name}
                onChangeText={(v) => { setErr(''); setDraft(d => ({ ...d, name: v.slice(0, 40) })); }}
                placeholder={tf('namePh')}
                placeholderTextColor={P.faint}
                autoFocus={isNew && !preset}
                maxLength={40}
                returnKeyType="done"
                style={[st.nameInput, { color: P.text }, isWeb && { outlineStyle: 'none' }]}
                testID="folder-name-input"
              />
              <Text style={[st.nameCount, { color: P.faint }]}>{40 - draft.name.length}</Text>
            </View>
            {err ? <Text style={[st.err, { color: P.danger }]}>{err}</Text> : null}
          </View>

          <Text style={[st.sectionLabel, { color: P.sub }]}>{tf('icon').toUpperCase()}</Text>
          <View style={[st.card, st.iconGrid, { backgroundColor: P.card }]}>
            {['', ...FOLDER_ICON_KEYS.filter(k => k !== 'fd')].map(k => {
              const on = draft.iconKey === k;
              return (
                <Pressable
                  key={k || 'none'}
                  onPress={() => { try { haptic.select(); } catch {} setDraft(d => ({ ...d, iconKey: k })); }}
                  style={[st.iconCell, { backgroundColor: on ? P.ink : P.chip }]}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={k ? k : tf('noIcon')}
                >
                  {k
                    ? <FolderIconByKey iconKey={k} size={20} color={on ? P.onInk : P.text} />
                    : <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={on ? P.onInk : P.sub} strokeWidth={2} strokeLinecap="round"><Path d="M5 5l14 14" /><Path d="M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z" /></Svg>}
                </Pressable>
              );
            })}
          </View>

          <Text style={[st.sectionLabel, { color: P.sub }]}>{tf('include').toUpperCase()}</Text>
          <View style={[st.card, { backgroundColor: P.card }]}>
            {INCLUDE_RULES.map((r, i) => (
              <RuleRow key={r.k} P={P} Icon={r.Icon} label={tf(r.label)} sub={tf(r.sub)} on={!!draft.rules[r.k]} onPress={() => setRule(r.k)} first={i === 0} testID={`folder-rule-${r.k}`} />
            ))}
          </View>

          <Text style={[st.sectionLabel, { color: P.sub }]}>{tf('exclude').toUpperCase()}</Text>
          <View style={[st.card, { backgroundColor: P.card }]}>
            {EXCLUDE_RULES.map((r, i) => (
              <RuleRow key={r.k} P={P} Icon={r.Icon} label={tf(r.label)} on={!!draft.rules[r.k]} onPress={() => setRule(r.k)} first={i === 0} testID={`folder-rule-${r.k}`} />
            ))}
          </View>
          <Text style={[st.footnote, { color: P.sub }]}>{tf('excludeSub')}</Text>

          <Text style={[st.sectionLabel, { color: P.sub, marginTop: 22 }]}>{`${tf('chosen').toUpperCase()} · ${draft.ids.length}`}</Text>
          <View style={[st.card, { backgroundColor: P.card }]}>
            <Pressable
              onPress={() => setPicker(true)}
              style={({ pressed }) => [st.createRow, pressed && { opacity: 0.6 }]}
              accessibilityRole="button"
              testID="folder-add-chats"
            >
              <View style={[st.glyph, { backgroundColor: P.chip }]}><IconPlus size={18} color={P.text} /></View>
              <Text style={[st.rowTitle, { color: P.text, flex: 1 }]}>{tf('addChats')}</Text>
              <IconChevronRight size={18} color={P.faint} />
            </Pressable>
            {chosen.map(c => {
              const name = c._missing ? `#${c.id}` : convName(c);
              return (
                <View key={String(c.id)}>
                  <View style={[st.hairline, { backgroundColor: P.hair, marginLeft: 64 }]} />
                  <View style={st.chosenRow}>
                    <AvatarCircle name={name} email={convEmail(c)} uri={c.avatar || c.avatar_url} size={36} members={c.members} />
                    <View style={{ flex: 1, minWidth: 0, marginLeft: 12 }}>
                      <Text style={[st.rowTitle, { color: P.text, fontSize: 15 }]} numberOfLines={1}>{name}</Text>
                      {c._arch ? <Text style={[st.rowSub, { color: P.sub }]}>{tf('archivedTag')}</Text> : null}
                    </View>
                    <TouchableOpacity
                      onPress={() => { try { haptic.light(); } catch {} setDraft(d => ({ ...d, ids: d.ids.filter(x => Number(x) !== Number(c.id)) })); }}
                      hitSlop={10}
                      style={[st.removeBtn, { backgroundColor: P.chip }]}
                      accessibilityRole="button"
                      accessibilityLabel={`${tf('remove')} ${name}`}
                    >
                      <IconX size={14} color={P.text} />
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })}
          </View>
          <Text style={[st.footnote, { color: P.sub }]}>
            {Object.values(draft.rules).some(Boolean) || draft.ids.length ? tf('preview', { n: previewN }) : tf('onlyChosen')}
          </Text>

          {!isNew ? (
            <Pressable
              onPress={remove}
              style={({ pressed }) => [st.card, st.deleteRow, { backgroundColor: P.card }, pressed && { opacity: 0.6 }]}
              accessibilityRole="button"
              testID="folder-delete"
            >
              <IconTrash size={18} color={P.danger} />
              <Text style={{ color: P.danger, fontSize: 16, fontWeight: '600', marginLeft: 10 }}>{tf('delete')}</Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
      <ChatPicker
        visible={picker}
        initial={draft.ids.map(Number)}
        convs={convs}
        onCancel={() => setPicker(false)}
        onDone={(ids) => { setPicker(false); setDraft(d => ({ ...d, ids })); }}
      />
    </View>
  );
}

function RuleRow({ P, Icon, label, sub, on, onPress, first, testID }) {
  return (
    <View>
      {!first ? <View style={[st.hairline, { backgroundColor: P.hair, marginLeft: 64 }]} /> : null}
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [st.ruleRow, pressed && { opacity: 0.6 }]}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: on }}
        testID={testID}
      >
        <View style={[st.glyph, { backgroundColor: P.chip }]}><Icon size={18} color={P.text} /></View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[st.rowTitle, { color: P.text }]} numberOfLines={1}>{label}</Text>
          {sub ? <Text style={[st.rowSub, { color: P.sub }]} numberOfLines={1}>{sub}</Text> : null}
        </View>
        <View style={[st.check, on ? { backgroundColor: P.ink, borderColor: P.ink } : { borderColor: P.faint }]}>
          {on ? <IconCheck size={14} color={P.onInk} /> : null}
        </View>
      </Pressable>
    </View>
  );
}

export default function ChatFoldersScreen() {
  const params = useLocalSearchParams();
  const editId = typeof params?.edit === 'string' && params.edit ? params.edit : '';
  const isNew = params?.new === '1' || params?.new === 'true';
  const preset = typeof params?.preset === 'string' ? params.preset : '';
  if (editId || isNew) return <FolderEditor key={editId || 'new'} editId={editId} preset={preset} />;
  return <FoldersList />;
}

const st = StyleSheet.create({
  webHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  webHeaderSide: { minWidth: 64, justifyContent: 'center' },
  webHeaderTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700' },
  scrollPad: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 48, width: '100%', maxWidth: 640, alignSelf: 'center' },
  hero: { alignItems: 'center', paddingTop: 8, paddingBottom: 18, paddingHorizontal: 12 },
  heroBadge: { width: 60, height: 60, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  heroText: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
  sectionLabel: { fontSize: 12, fontWeight: '600', letterSpacing: 0.4, marginLeft: 16, marginBottom: 7, marginTop: 6 },
  card: { borderRadius: 14, overflow: 'visible', marginBottom: 10 },
  hairline: { height: StyleSheet.hairlineWidth },
  createRow: { flexDirection: 'row', alignItems: 'center', height: 56, paddingHorizontal: 14 },
  glyph: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginRight: 14 },
  rowTitle: { fontSize: 16, fontWeight: '600', letterSpacing: -0.2 },
  rowSub: { fontSize: 13, marginTop: 2 },
  folderRow: { flex: 1, flexDirection: 'row', alignItems: 'center', borderRadius: 14 },
  folderMain: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingLeft: 14, height: ROW_H, minWidth: 0 },
  handle: { width: 52, height: ROW_H, alignItems: 'center', justifyContent: 'center' },
  rowHair: { position: 'absolute', left: 64, right: 0, bottom: 0 },
  emptyBox: { paddingHorizontal: 18, paddingVertical: 18, alignItems: 'center' },
  emptyTitle: { fontSize: 16, fontWeight: '700', textAlign: 'center' },
  emptySub: { fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 4 },
  footnote: { fontSize: 13, lineHeight: 18, marginHorizontal: 16, marginTop: 2, marginBottom: 8 },
  sugRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12 },
  pillBtn: { paddingHorizontal: 14, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginLeft: 10 },
  pillBtnText: { fontSize: 14, fontWeight: '700' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  nameWrap: { alignItems: 'center', marginBottom: 14 },
  bigGlyph: { width: 72, height: 72, borderRadius: 22, alignItems: 'center', justifyContent: 'center', marginBottom: 14, marginTop: 4 },
  nameField: { alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', borderRadius: 14, paddingHorizontal: 16, height: 52 },
  nameInput: { flex: 1, fontSize: 17, fontWeight: '600', paddingVertical: 0 },
  nameCount: { fontSize: 12, marginLeft: 8 },
  err: { fontSize: 13, marginTop: 8, fontWeight: '600' },
  iconGrid: { flexDirection: 'row', flexWrap: 'wrap', padding: 10, gap: 8, justifyContent: 'flex-start' },
  iconCell: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  ruleRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, minHeight: 58, paddingVertical: 8 },
  check: { width: 24, height: 24, borderRadius: 12, borderWidth: 1.6, alignItems: 'center', justifyContent: 'center', marginLeft: 10 },
  chosenRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 9 },
  removeBtn: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginLeft: 10 },
  deleteRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 52, marginTop: 22 },
  pickHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  pickSide: { minWidth: 72 },
  pickBtn: { fontSize: 17 },
  pickTitle: { fontSize: 17, fontWeight: '700' },
  pickCount: { fontSize: 12, marginTop: 1 },
  searchBox: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, marginVertical: 10, borderRadius: 12, paddingHorizontal: 12, height: 40 },
  searchInput: { flex: 1, fontSize: 16, marginLeft: 8, paddingVertical: 0 },
  pickRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 9 },
});
