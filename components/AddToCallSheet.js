// AddToCallSheet.js — "Adicionar à chamada" (ligação 1:1 → grupo, e grupo).
//
// [2026-10-13 add-to-call redesign] Print do founder: folha branca com TODO o
// diretório do domínio (contas de teste inclusas), nomes = usernames crus +
// e-mail, avatares coloridos, ícone azul, sem busca, e erro cru "Não foi
// possível chamar <email>". Agora (nível WhatsApp, mesma folha nas 3 telas —
// app/call.js, app/group-call.js e web):
//   • folha ESCURA (a tela de chamada é escura), só P&B;
//   • busca no topo (nome, @usuário, e-mail ou telefone completo) — filtra na
//     hora o que já está na tela e consulta o servidor com debounce;
//   • seções "Conversas recentes" e "Contatos": SÓ quem tem conversa direct com
//     o usuário ou está na agenda dele (servidor chat_call_add_candidates);
//     contas de teste/sistema escondidas;
//   • nome de exibição + foto real; @usuário embaixo quando existe;
//   • "Na chamada" / "Chamando…" desabilitados;
//   • seleção múltipla com check + "Adicionar (N)" no rodapé;
//   • skeleton, estado vazio, erro com "Tentar de novo";
//   • erro do convite traduzido com o motivo (services/callAddParticipants).
//
// Props:
//   visible, onClose, t
//   callId, conversationId, isVideo  → o próprio sheet chama chat_call_add
//   onAdd?(emails, rows) → Promise<{ok, code, invited, skipped}>  (opcional:
//       a tela pode interceptar p/ checar limite / subir P2P→LiveKit antes)
//   onAdded?(result, rows)  → depois de um convite OK (tela fecha / mostra aviso)
//   existingEmails  → já estão na chamada (pill "Na chamada")
//   topSlot         → nó opcional acima da lista (ex.: "Silenciar" do anfitrião)

import { androidBottomInset } from '../utils/systemInsets'; // [2026-10-07 android-native] edge-to-edge
import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  Pressable,
  Animated,
  Easing,
  SectionList,
  ScrollView,
  StyleSheet,
  TextInput,
  ActivityIndicator,
  Platform,
  Keyboard,
} from 'react-native';
import Svg, { Path as SvgPath, Circle as SvgCircle } from 'react-native-svg';
import AvatarCircle from './AvatarCircle';
import {
  fetchAddCandidates,
  addToCall,
  addToCallErrorText,
  normalizeForSearch,
} from '../services/callAddParticipants';
import useDragToDismiss, { DragSheetRoot, DragPanel, DragScroll } from './ui/useDragToDismiss';

let Haptics = null;
try { Haptics = require('../services/haptics').HapticsCompat; } catch {}
function hSelect() { try { Haptics?.selectionAsync?.(); } catch {} }
function hImpact() { try { Haptics?.impactAsync?.(Haptics.ImpactFeedbackStyle?.Medium); } catch {} }

const MAX_FANOUT = 16; // servidor limita 16 por pedido
const C = {
  sheet: '#121212',
  surface: '#1E1E1E',
  surface2: '#2A2A2A',
  text: '#FFFFFF',
  text2: '#A3A3A3',
  text3: '#737373',
  divider: 'rgba(255,255,255,0.08)',
  overlay: 'rgba(0,0,0,0.6)',
};

const IconSearch = ({ size = 18, color = C.text2 }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <SvgCircle cx={11} cy={11} r={7} stroke={color} strokeWidth={2} />
    <SvgPath d="M20 20l-3.5-3.5" stroke={color} strokeWidth={2} strokeLinecap="round" />
  </Svg>
);
const IconClose = ({ size = 20, color = C.text }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <SvgPath d="M18 6L6 18M6 6l12 12" stroke={color} strokeWidth={2} strokeLinecap="round" />
  </Svg>
);
const IconCheck = ({ size = 14, color = '#000' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <SvgPath d="M20 6L9 17l-5-5" stroke={color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);
const IconUsers = ({ size = 36, color = C.text3 }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <SvgPath d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);
const IconAlert = ({ size = 18, color = C.text }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <SvgCircle cx={12} cy={12} r={9} stroke={color} strokeWidth={2} />
    <SvgPath d="M12 7.5v5.5M12 16.5v.01" stroke={color} strokeWidth={2.2} strokeLinecap="round" />
  </Svg>
);

function SkeletonRows() {
  const pulse = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 0.9, duration: 650, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0.45, duration: 650, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return (
    <View style={{ paddingTop: 8 }}>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <Animated.View key={i} style={[styles.row, { opacity: pulse }]}>
          <View style={styles.skelAvatar} />
          <View style={{ flex: 1 }}>
            <View style={[styles.skelLine, { width: `${55 - i * 4}%` }]} />
            <View style={[styles.skelLine, { width: '28%', height: 10, marginTop: 8 }]} />
          </View>
        </Animated.View>
      ))}
    </View>
  );
}

export default function AddToCallSheet({
  visible,
  onClose,
  onAdd,
  onAdded,
  existingEmails = [],
  callId = '',
  conversationId = null,
  isVideo = false,
  t,
  topSlot = null,
  loading: loadingProp = false, // compat: convite em andamento controlado pela tela
}) {
  // [2026-10-17 drag-dismiss] folha desce arrastando de qualquer ponto (components/ui/useDragToDismiss).
  const _drag382 = useDragToDismiss({ onDismiss: () => { const f = onClose; if (typeof f === 'function') f(); } });
  const tr = useCallback((k, fb, vars) => {
    let s = '';
    try { s = typeof t === 'function' ? t(k, vars) : ''; } catch { s = ''; }
    if (!s || s === k) {
      s = fb;
      if (vars) Object.keys(vars).forEach((v) => { s = String(s).split(`{${v}}`).join(String(vars[v])); });
    }
    return s;
  }, [t]);

  const [query, setQuery] = useState('');
  const [base, setBase] = useState({ recent: [], contacts: [] });
  const [results, setResults] = useState(null); // null = sem busca no servidor
  const [loadingList, setLoadingList] = useState(false);
  const [searching, setSearching] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState({}); // email -> row
  const [ringing, setRinging] = useState({}); // email -> true (convidados nesta abertura)
  const [adding, setAdding] = useState(false);
  const [banner, setBanner] = useState(null); // { text, tone: 'error'|'info' }

  const translateY = useRef(new Animated.Value(80)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const mountedRef = useRef(true);
  const searchSeqRef = useRef(0);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const existingSet = useMemo(() => {
    const s = new Set();
    (existingEmails || []).forEach((e) => { if (e) s.add(String(e).toLowerCase()); });
    return s;
  }, [existingEmails]);

  // Abrir/fechar: animação + reset.
  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.spring(translateY, { toValue: 0, friction: 9, tension: 70, useNativeDriver: true }),
      ]).start();
    } else {
      translateY.setValue(80);
      opacity.setValue(0);
      setQuery('');
      setResults(null);
      setSelected({});
      setRinging({});
      setBanner(null);
      setLoadError(false);
    }
  }, [visible, translateY, opacity]);

  const loadBase = useCallback(async () => {
    setLoadingList(true);
    setLoadError(false);
    const r = await fetchAddCandidates({ query: '', callId });
    if (!mountedRef.current) return;
    if (r.ok) setBase({ recent: r.recent, contacts: r.contacts });
    else setLoadError(true);
    setLoadingList(false);
  }, [callId]);

  useEffect(() => { if (visible) loadBase(); }, [visible, loadBase]);

  // Busca no servidor com debounce (o filtro local abaixo já responde na hora).
  useEffect(() => {
    if (!visible) return undefined;
    const q = query.trim();
    if (!q) { setResults(null); setSearching(false); return undefined; }
    const seq = ++searchSeqRef.current;
    setSearching(true);
    const h = setTimeout(async () => {
      const r = await fetchAddCandidates({ query: q, callId });
      if (!mountedRef.current || seq !== searchSeqRef.current) return;
      setResults(r.ok ? r.results : null);
      setSearching(false);
    }, 280);
    return () => clearTimeout(h);
  }, [query, visible, callId]);

  const stateOf = useCallback((row) => {
    const e = row.email;
    if (existingSet.has(e) || row.callState === 'in_call') return 'in_call';
    if (ringing[e] || row.callState === 'ringing') return 'ringing';
    return '';
  }, [existingSet, ringing]);

  const sections = useMemo(() => {
    const q = normalizeForSearch(query.replace(/^@/, ''));
    if (q) {
      let list = results;
      if (!list) {
        const all = [...base.recent, ...base.contacts];
        list = all.filter((r) => normalizeForSearch(r.name).includes(q)
          || normalizeForSearch(r.username).includes(q)
          || r.email.split('@')[0].includes(q));
      }
      return list.length ? [{ key: 'results', title: tr('callAdd.results', 'Resultados'), data: list }] : [];
    }
    const out = [];
    if (base.recent.length) out.push({ key: 'recent', title: tr('callAdd.recent', 'Conversas recentes'), data: base.recent });
    if (base.contacts.length) out.push({ key: 'contacts', title: tr('callAdd.contacts', 'Contatos'), data: base.contacts });
    return out;
  }, [query, results, base, tr]);

  const selectedRows = useMemo(() => Object.values(selected), [selected]);

  const toggle = useCallback((row) => {
    if (!row?.email || stateOf(row)) return;
    hSelect();
    setBanner(null);
    setSelected((prev) => {
      const next = { ...prev };
      if (next[row.email]) delete next[row.email];
      else {
        if (Object.keys(next).length >= MAX_FANOUT) return prev;
        next[row.email] = row;
      }
      return next;
    });
  }, [stateOf]);

  const busy = adding || !!loadingProp;

  const handleAdd = useCallback(async () => {
    if (busy || selectedRows.length === 0) return;
    hImpact();
    try { Keyboard.dismiss(); } catch {}
    const rows = selectedRows.slice(0, MAX_FANOUT);
    const emails = rows.map((r) => r.email);
    setAdding(true);
    setBanner(null);
    let res = null;
    try {
      res = typeof onAdd === 'function'
        ? await onAdd(emails, rows)
        : await addToCall({ callId, conversationId, emails, video: isVideo });
    } catch { res = { ok: false, code: 'generic' }; }
    if (!mountedRef.current) return;
    setAdding(false);
    if (!res || typeof res !== 'object') res = { ok: true, invited: emails.map((email) => ({ email, reachable: true })), skipped: [] };
    const nameOf = (email) => (rows.find((r) => r.email === String(email || '').toLowerCase())?.name) || String(email || '').split('@')[0];
    if (!res.ok) {
      const skippedNames = (res.skipped || []).map((s) => nameOf(s.email));
      const who = (skippedNames.length ? skippedNames : rows.map((r) => r.name)).join(', ');
      setBanner({ tone: 'error', text: addToCallErrorText(t, res.code, who) });
      return;
    }
    const rung = {};
    (res.invited || []).forEach((i) => { if (i?.email) rung[String(i.email).toLowerCase()] = true; });
    setRinging((prev) => ({ ...prev, ...rung }));
    setSelected({});
    const problems = [];
    (res.skipped || []).forEach((s) => problems.push(addToCallErrorText(t, s.reason, nameOf(s.email))));
    (res.invited || []).filter((i) => i && i.reachable === false).forEach((i) => problems.push(addToCallErrorText(t, 'offline', nameOf(i.email))));
    if (problems.length) setBanner({ tone: 'error', text: problems.slice(0, 2).join('\n') });
    try { onAdded?.(res, rows, { hasProblems: problems.length > 0 }); } catch {}
  }, [busy, selectedRows, onAdd, callId, conversationId, isVideo, t, onAdded]);

  if (!visible) return null;

  const renderRow = ({ item }) => {
    const st = stateOf(item);
    const isSel = !!selected[item.email];
    const sub = item.username && normalizeForSearch(item.username) !== normalizeForSearch(item.name) ? `@${item.username}` : '';
    return (
      <TouchableOpacity
        activeOpacity={st ? 1 : 0.7}
        disabled={!!st}
        onPress={() => toggle(item)}
        style={styles.row}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: isSel, disabled: !!st }}
        accessibilityLabel={item.name}
      >
        <AvatarCircle email={item.email} name={item.name} uri={item.avatar || undefined} size={46} />
        <View style={styles.rowMain}>
          <Text style={[styles.rowName, st && styles.dim]} numberOfLines={1}>{item.name}</Text>
          {!!sub && <Text style={styles.rowSub} numberOfLines={1}>{sub}</Text>}
        </View>
        {st ? (
          <View style={styles.pill}>
            <Text style={styles.pillText}>
              {st === 'in_call' ? tr('callAdd.inCall', 'Na chamada') : tr('callAdd.ringing', 'Chamando…')}
            </Text>
          </View>
        ) : (
          <View style={[styles.check, isSel && styles.checkOn]}>{isSel && <IconCheck />}</View>
        )}
      </TouchableOpacity>
    );
  };

  const qTrim = query.trim();
  let body;
  if (loadingList && !qTrim && !base.recent.length && !base.contacts.length) {
    body = <SkeletonRows />;
  } else if (loadError && !qTrim && !base.recent.length && !base.contacts.length) {
    body = (
      <View style={styles.center}>
        <IconAlert size={30} color={C.text3} />
        <Text style={styles.centerTitle}>{tr('callAdd.loadError', 'Não foi possível carregar seus contatos.')}</Text>
        <TouchableOpacity onPress={() => { require('../utils/userRetry').noteUserRetry(); loadBase(); }} style={styles.retryBtn} activeOpacity={0.8}>
          <Text style={styles.retryText}>{tr('callAdd.retry', 'Tentar de novo')}</Text>
        </TouchableOpacity>
      </View>
    );
  } else if (sections.length === 0) {
    body = qTrim && searching ? (
      <View style={styles.center}><ActivityIndicator color={C.text2} /></View>
    ) : (
      <View style={styles.center}>
        <IconUsers />
        <Text style={styles.centerTitle}>
          {qTrim ? tr('callAdd.noResults', 'Ninguém encontrado para “{q}”', { q: qTrim }) : tr('callAdd.emptyTitle', 'Nenhum contato ainda')}
        </Text>
        {!qTrim && (
          <Text style={styles.centerBody}>
            {tr('callAdd.emptyBody', 'Converse com alguém ou sincronize sua agenda para adicionar pessoas à chamada.')}
          </Text>
        )}
      </View>
    );
  } else {
    body = (
      <DragScroll drag={_drag382}><SectionList
        sections={sections}
        keyExtractor={(item) => item.email}
        renderItem={renderRow}
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionTitle}>{section.title}</Text>
        )}
        stickySectionHeadersEnabled={false}
        style={styles.list}
        contentContainerStyle={{ paddingBottom: 12 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        initialNumToRender={14}
      /></DragScroll>
    );
  }

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <DragSheetRoot>
      <Pressable style={styles.overlay} onPress={onClose}>
        <DragPanel drag={_drag382}
          style={[styles.sheet, { opacity, transform: [{ translateY }] }]}
          onStartShouldSetResponder={() => true}
        >
          <Pressable onPress={(e) => e.stopPropagation?.()} style={{ flex: 1 }}>
            <View style={styles.handle} />
            <View style={styles.header}>
              <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} accessibilityRole="button" accessibilityLabel={tr('common.close', 'Fechar')} style={styles.closeBtn}>
                <IconClose />
              </TouchableOpacity>
              <Text style={styles.title} numberOfLines={1}>{tr('callAdd.title', 'Adicionar à chamada')}</Text>
              <View style={styles.closeBtn} />
            </View>

            <View style={styles.searchBox}>
              <IconSearch />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder={tr('callAdd.search', 'Buscar nome, @usuário ou telefone')}
                placeholderTextColor={C.text3}
                style={styles.searchInput}
                autoCorrect={false}
                autoCapitalize="none"
                returnKeyType="search"
                clearButtonMode="while-editing"
                selectionColor={C.text}
              />
              {searching && <ActivityIndicator size="small" color={C.text2} />}
            </View>

            {!!banner && (
              <View style={styles.banner} accessibilityLiveRegion="polite">
                <IconAlert size={16} />
                <Text style={styles.bannerText}>{banner.text}</Text>
              </View>
            )}

            {selectedRows.length > 0 && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.strip} contentContainerStyle={styles.stripContent} keyboardShouldPersistTaps="handled">
                {selectedRows.map((r) => (
                  <TouchableOpacity key={r.email} style={styles.chip} activeOpacity={0.8} onPress={() => toggle(r)}>
                    <AvatarCircle email={r.email} name={r.name} uri={r.avatar || undefined} size={48} />
                    <View style={styles.chipRemove}><IconClose size={10} color={C.text} /></View>
                    <Text style={styles.chipName} numberOfLines={1}>{r.name}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}

            {topSlot}
            {body}

            <View style={styles.footer}>
              <TouchableOpacity
                activeOpacity={0.85}
                disabled={selectedRows.length === 0 || busy}
                onPress={handleAdd}
                style={[styles.addBtn, (selectedRows.length === 0 || busy) && styles.addBtnOff]}
                accessibilityRole="button"
              >
                {busy ? (
                  <ActivityIndicator color="#000" />
                ) : (
                  <Text style={[styles.addText, selectedRows.length === 0 && styles.addTextOff]}>
                    {selectedRows.length > 0
                      ? tr('callAdd.addN', 'Adicionar ({n})', { n: selectedRows.length })
                      : tr('callAdd.add', 'Adicionar')}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </Pressable>
        </DragPanel>
      </Pressable>
      </DragSheetRoot>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: C.overlay, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: C.sheet,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    height: '88%',
    maxWidth: 640,
    width: '100%',
    alignSelf: 'center',
    paddingTop: 8,
    paddingBottom: Platform.OS === 'ios' ? 28 : androidBottomInset(16),
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.22)', alignSelf: 'center', marginBottom: 6 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6 },
  closeBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, textAlign: 'center', color: C.text, fontSize: 17, fontWeight: '600', letterSpacing: -0.2 },
  searchBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: C.surface, borderRadius: 12,
    paddingHorizontal: 12, height: 42, marginHorizontal: 16, marginTop: 6, marginBottom: 6,
  },
  searchInput: { flex: 1, color: C.text, fontSize: 16, padding: 0, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null) },
  banner: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    backgroundColor: C.surface2, borderRadius: 12,
    marginHorizontal: 16, marginTop: 4, marginBottom: 4, paddingHorizontal: 12, paddingVertical: 10,
  },
  bannerText: { flex: 1, color: C.text, fontSize: 14, lineHeight: 19 },
  strip: { maxHeight: 88, marginTop: 6, flexGrow: 0 },
  stripContent: { paddingHorizontal: 16, gap: 14, alignItems: 'flex-start' },
  chip: { width: 58, alignItems: 'center' },
  chipRemove: {
    position: 'absolute', top: -2, right: 2, width: 18, height: 18, borderRadius: 9,
    backgroundColor: C.surface2, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: C.sheet,
  },
  chipName: { color: C.text2, fontSize: 11, marginTop: 4, maxWidth: 58, textAlign: 'center' },
  list: { flex: 1 },
  sectionTitle: { color: C.text2, fontSize: 13, fontWeight: '600', paddingHorizontal: 20, paddingTop: 14, paddingBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 64, paddingVertical: 8, paddingHorizontal: 20, gap: 14 },
  rowMain: { flex: 1, justifyContent: 'center' },
  rowName: { color: C.text, fontSize: 16, fontWeight: '500', letterSpacing: -0.2 },
  rowSub: { color: C.text2, fontSize: 13, marginTop: 2 },
  dim: { color: C.text2 },
  pill: { backgroundColor: C.surface2, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5 },
  pillText: { color: C.text2, fontSize: 12, fontWeight: '600' },
  check: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: 'rgba(255,255,255,0.35)', alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: C.text, borderColor: C.text },
  skelAvatar: { width: 46, height: 46, borderRadius: 23, backgroundColor: C.surface2 },
  skelLine: { height: 13, borderRadius: 6, backgroundColor: C.surface2 },
  center: { flex: 1, minHeight: 200, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 32 },
  centerTitle: { color: C.text, fontSize: 16, fontWeight: '600', textAlign: 'center' },
  centerBody: { color: C.text2, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  retryBtn: { marginTop: 6, borderRadius: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)', paddingHorizontal: 18, paddingVertical: 9 },
  retryText: { color: C.text, fontSize: 14, fontWeight: '600' },
  footer: { paddingHorizontal: 16, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.divider },
  addBtn: { backgroundColor: C.text, borderRadius: 26, height: 50, alignItems: 'center', justifyContent: 'center' },
  addBtnOff: { backgroundColor: C.surface2 },
  addText: { color: '#000', fontSize: 16, fontWeight: '600' },
  addTextOff: { color: C.text3 },
});
