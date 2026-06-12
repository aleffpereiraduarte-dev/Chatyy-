// AddToCallSheet.js (2026-06-12)
//
// WhatsApp-grade "add participant to a LIVE call" bottom sheet. Keeps the user
// IN the call (no navigation away) and rings selected contacts INTO the running
// room via `chat_call_add` (backend pre-mints a per-recipient LiveKit token for
// the existing call_id, so they join THIS call).
//
// Canonical sheet pattern mirrors components/CallParticipantList.js: Modal +
// Pressable backdrop + Animated slide-up + drag handle. The call surface is
// always dark, so this sheet keeps the same dark palette as the participant
// list for visual continuity (the `colors`/`isDark` props are accepted and used
// only as defensive accents so the parent can theme if it ever lives elsewhere).
//
// Flow:
//   - Loads api.chatContacts() on open (bare array [{email,name,status,...}]).
//   - Search bar filters by name/email as you type.
//   - Contacts already in the call (existingEmails) render DISABLED with a
//     "Na chamada" pill and aren't selectable.
//   - Tap a selectable row toggles selection (right-side check) + haptic.
//   - Selected strip (horizontal avatars) shows the current picks.
//   - "Adicionar (N)" footer rings the selected emails (capped 16 client-side)
//     via onAdd(emails); spinner while loading.

import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  Pressable,
  Animated,
  Easing,
  FlatList,
  ScrollView,
  StyleSheet,
  TextInput,
  ActivityIndicator,
  Platform,
} from 'react-native';
import Svg, { Path as SvgPath, Circle as SvgCircle } from 'react-native-svg';
import AvatarCircle from './AvatarCircle';
import * as api from '../services/api';

let Haptics = null;
try { Haptics = require('expo-haptics'); } catch {}
function hSelect() { try { Haptics?.selectionAsync?.(); } catch {} }
function hImpact() {
  try { Haptics?.impactAsync?.(Haptics.ImpactFeedbackStyle?.Medium); } catch {}
}

const BRAND_PURPLE = '#7C3AED';
const MAX_FANOUT = 16; // backend caps fan-out at 16/request

const IconSearch = ({ size = 16, color = '#9CA3AF' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <SvgCircle cx={11} cy={11} r={8} stroke={color} strokeWidth={2} />
    <SvgPath d="M21 21l-4.35-4.35" stroke={color} strokeWidth={2} strokeLinecap="round" />
  </Svg>
);
const IconClose = ({ size = 20, color = '#fff' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <SvgPath d="M18 6L6 18M6 6l12 12" stroke={color} strokeWidth={2} strokeLinecap="round" />
  </Svg>
);
const IconCheck = ({ size = 14, color = '#fff' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <SvgPath d="M20 6L9 17l-5-5" stroke={color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);
const IconUsers = ({ size = 30, color = '#6B7280' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <SvgPath d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

export default function AddToCallSheet({
  visible,
  onClose,
  onAdd,                 // (emails: string[]) => void
  existingEmails = [],
  colors,                // theme object (optional; defaults to dark call palette)
  isDark = true,
  t,
  loading = false,       // ringing in-flight (footer spinner)
}) {
  const tr = typeof t === 'function' ? t : (_k, fb) => fb;
  const [query, setQuery] = useState('');
  const [contacts, setContacts] = useState([]);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [selected, setSelected] = useState({}); // lowercased email -> true

  const translateY = useRef(new Animated.Value(60)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);

  // Set of emails already in the call (lowercased) — these are non-selectable.
  const existingSet = useMemo(() => {
    const s = new Set();
    (existingEmails || []).forEach((e) => { if (e) s.add(String(e).toLowerCase()); });
    return s;
  }, [existingEmails]);

  // Slide-in / reset on open-close — mirror CallParticipantList.
  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.spring(translateY, { toValue: 0, friction: 8, tension: 70, useNativeDriver: true }),
      ]).start();
    } else {
      translateY.setValue(60);
      opacity.setValue(0);
      setQuery('');
      setSelected({});
    }
  }, [visible, translateY, opacity]);

  // Load contacts each time the sheet opens (cheap; backend list is small).
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      setLoadingContacts(true);
      try {
        const r = await api.chatContacts();
        // chat_contacts returns a BARE array [{email,name,status,...}].
        // Normalize through apiList if present, else defensively.
        let list = [];
        if (typeof api.apiList === 'function') {
          list = api.apiList(r, 'contacts');
        } else {
          const d = r?.data;
          list = Array.isArray(d) ? d : (Array.isArray(d?.data) ? d.data : []);
        }
        if (!cancelled && isMountedRef.current) {
          setContacts(Array.isArray(list) ? list.filter((c) => c && c.email) : []);
        }
      } catch {
        if (!cancelled && isMountedRef.current) setContacts([]);
      } finally {
        if (!cancelled && isMountedRef.current) setLoadingContacts(false);
      }
    })();
    return () => { cancelled = true; };
  }, [visible]);

  // Filter by name/email; keep already-in-call contacts visible (disabled).
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) =>
      (c.email || '').toLowerCase().includes(q) ||
      (c.name || '').toLowerCase().includes(q)
    );
  }, [contacts, query]);

  const selectedEmails = useMemo(
    () => Object.keys(selected).filter((e) => selected[e]),
    [selected]
  );

  const toggle = useCallback((email) => {
    const e = String(email || '').toLowerCase();
    if (!e || existingSet.has(e)) return;
    hSelect();
    setSelected((prev) => {
      const next = { ...prev };
      if (next[e]) {
        delete next[e];
      } else {
        // Respect the 16 fan-out cap client-side too.
        if (Object.keys(next).filter((k) => next[k]).length >= MAX_FANOUT) return prev;
        next[e] = true;
      }
      return next;
    });
  }, [existingSet]);

  const handleAdd = useCallback(() => {
    if (loading) return;
    const emails = selectedEmails.slice(0, MAX_FANOUT);
    if (emails.length === 0) return;
    hImpact();
    onAdd?.(emails);
  }, [selectedEmails, onAdd, loading]);

  if (!visible) return null;

  const C = colors || {};
  const sheetBg = (isDark === false && C.surface) ? C.surface : '#111827';
  const textPrimary = (isDark === false && C.text) ? C.text : '#fff';
  const inputBg = 'rgba(255,255,255,0.08)';

  // Resolve a contact's display name from its row.
  const nameOf = (c) => c.name || (c.email || '').split('@')[0];

  const renderRow = ({ item }) => {
    const email = (item.email || '').toLowerCase();
    const inCall = existingSet.has(email);
    const isSel = !!selected[email];
    return (
      <TouchableOpacity
        activeOpacity={inCall ? 1 : 0.7}
        disabled={inCall}
        onPress={() => toggle(item.email)}
        style={[styles.row, inCall && styles.rowDisabled]}
      >
        <AvatarCircle email={item.email} name={nameOf(item)} size={44} style={styles.rowAvatar} />
        <View style={styles.rowMain}>
          <Text style={[styles.rowName, { color: textPrimary }]} numberOfLines={1}>
            {nameOf(item)}
          </Text>
          <Text style={styles.rowEmail} numberOfLines={1}>{item.email}</Text>
        </View>
        {inCall ? (
          <View style={styles.inCallPill}>
            <Text style={styles.inCallPillText}>{tr('call.inCallSection', 'Em chamada')}</Text>
          </View>
        ) : (
          <View style={[styles.checkCircle, isSel && styles.checkCircleOn]}>
            {isSel && <IconCheck />}
          </View>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Animated.View
          style={[styles.sheet, { backgroundColor: sheetBg, opacity, transform: [{ translateY }] }]}
          onStartShouldSetResponder={() => true}
        >
          <Pressable onPress={(e) => e.stopPropagation?.()} style={{ flex: 1 }}>
            <View style={styles.handle} />

            <View style={styles.header}>
              <Text style={[styles.title, { color: textPrimary }]}>
                {tr('call.addParticipantTitle', 'Adicionar à chamada')}
              </Text>
              <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                <IconClose color={textPrimary} />
              </TouchableOpacity>
            </View>

            {/* Selected avatars strip — WhatsApp-style horizontal picks */}
            {selectedEmails.length > 0 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.selectedStrip}
                contentContainerStyle={styles.selectedStripContent}
                keyboardShouldPersistTaps="handled"
              >
                {selectedEmails.map((email) => {
                  const c = contacts.find((x) => (x.email || '').toLowerCase() === email) || { email };
                  return (
                    <TouchableOpacity
                      key={email}
                      style={styles.selectedChip}
                      activeOpacity={0.8}
                      onPress={() => toggle(email)}
                    >
                      <AvatarCircle email={c.email} name={nameOf(c)} size={48} />
                      <View style={styles.selectedRemove}>
                        <IconClose size={11} color="#fff" />
                      </View>
                      <Text style={styles.selectedChipName} numberOfLines={1}>
                        {nameOf(c)}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}

            {/* Search */}
            <View style={[styles.searchBox, { backgroundColor: inputBg }]}>
              <IconSearch />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder={tr('call.searchContacts', 'Buscar contatos')}
                placeholderTextColor="#6B7280"
                style={[styles.searchInput, { color: textPrimary }]}
                autoCorrect={false}
                autoCapitalize="none"
              />
            </View>

            {/* List / loading / empty */}
            {loadingContacts ? (
              <View style={styles.centerState}>
                <ActivityIndicator color={BRAND_PURPLE} />
                <Text style={styles.centerStateText}>
                  {tr('call.addParticipantLoading', 'Carregando contatos...')}
                </Text>
              </View>
            ) : filtered.length === 0 ? (
              <View style={styles.centerState}>
                <IconUsers />
                <Text style={styles.centerStateText}>
                  {query
                    ? tr('common.noResults', 'Nenhum resultado')
                    : tr('call.noContacts', 'Nenhum contato')}
                </Text>
              </View>
            ) : (
              <FlatList
                data={filtered}
                keyExtractor={(item, i) => (item.email || String(i))}
                renderItem={renderRow}
                style={styles.list}
                contentContainerStyle={{ paddingBottom: 12 }}
                keyboardShouldPersistTaps="handled"
              />
            )}

            {/* Footer add button */}
            <View style={styles.footer}>
              <TouchableOpacity
                activeOpacity={0.85}
                disabled={selectedEmails.length === 0 || loading}
                onPress={handleAdd}
                style={[
                  styles.addBtn,
                  (selectedEmails.length === 0 || loading) && styles.addBtnDisabled,
                ]}
              >
                {loading ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.addBtnText}>
                    {selectedEmails.length > 0
                      ? `${tr('call.addParticipant', 'Adicionar')} (${selectedEmails.length})`
                      : tr('call.addParticipant', 'Adicionar')}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    maxHeight: '82%',
    paddingTop: 8,
    paddingBottom: Platform.OS === 'ios' ? 28 : 16,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.25)',
    alignSelf: 'center',
    marginBottom: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  title: { fontSize: 17, fontWeight: '700', letterSpacing: -0.2 },
  selectedStrip: { maxHeight: 92, marginTop: 4 },
  selectedStripContent: { paddingHorizontal: 16, gap: 14, alignItems: 'flex-start' },
  selectedChip: { width: 56, alignItems: 'center' },
  selectedRemove: {
    position: 'absolute',
    top: -2,
    right: 2,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#374151',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#111827',
  },
  selectedChipName: { color: '#9CA3AF', fontSize: 11, marginTop: 4, maxWidth: 56, textAlign: 'center' },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 6,
  },
  searchInput: { flex: 1, fontSize: 14, padding: 0 },
  list: { flex: 1, paddingHorizontal: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 64,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 16,
  },
  rowDisabled: { opacity: 0.5 },
  rowAvatar: { marginRight: 14 },
  rowMain: { flex: 1, justifyContent: 'center' },
  rowName: { fontSize: 15.5, fontWeight: '600', letterSpacing: -0.2 },
  rowEmail: { color: '#9CA3AF', fontSize: 12.5, marginTop: 2 },
  inCallPill: {
    backgroundColor: 'rgba(124,58,237,0.18)',
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  inCallPillText: { color: BRAND_PURPLE, fontSize: 11, fontWeight: '700' },
  checkCircle: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkCircleOn: {
    backgroundColor: BRAND_PURPLE,
    borderColor: BRAND_PURPLE,
  },
  centerState: { flex: 1, minHeight: 160, alignItems: 'center', justifyContent: 'center', gap: 12, paddingVertical: 32 },
  centerStateText: { color: '#9CA3AF', fontSize: 14 },
  footer: { paddingHorizontal: 16, paddingTop: 10 },
  addBtn: {
    backgroundColor: BRAND_PURPLE,
    borderRadius: 14,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addBtnDisabled: { backgroundColor: 'rgba(124,58,237,0.35)' },
  addBtnText: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: 0.2 },
});
