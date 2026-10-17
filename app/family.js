/**
 * Family — a premium, Apple-Family-Sharing-style hub, wired to the REAL
 * `family_*` backend (email.php).
 *
 * The backend AUTO-CREATES a solo family on the first `family_info` call, so
 * a family ALWAYS exists — a brand-new user already owns a family containing
 * just themselves. There is therefore NO "create / no-family" state: the
 * "has family" view is the default and the primary action for a solo family
 * is "Convidar familiar". We keep graceful Loading + Error states.
 *
 * Real contract:
 *   family_info → { data: { family:{id,name,photo_url,owner_email,share_plan},
 *                   members:[{email,name,online,last_seen,presence}],  // SIBLING
 *                   my_role, is_owner } }
 *     · members has NO avatar_url / is_me / role → computed client-side
 *       (is_me = email === current user; avatar from AvatarCircle(email)).
 *   family_invite {target, role} → { data:{ token, role, link } }  (rate-limited
 *       10/24h → surfaces a pt-BR message). `link` = chatyy://family/join/<token>
 *       → shared via the OS Share sheet.
 *   family_join {token} · family_update {name?,photo_url?} ·
 *   family_remove_member {email} · family_leave
 *   Shared features (all real): family_shared_album_list / _add ·
 *   family_calendar_list / _add · family_shopping_list_get / _add {text} /
 *   _toggle {id} · family_location_all.
 *
 * OTA-safe (RN Animated only; expo-image-picker dynamically imported — it's
 * already a native dep). Fully theme-aware (no #111111 hardcodes — accent
 * derives from `colors` so dark mode stays legible). ErrorBoundary-wrapped.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Platform, Alert, ActivityIndicator, TextInput, Modal, Share, Animated, Easing, Image } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { USE_NATIVE_HEADER, nativeHeaderOptions, HeaderIconButton } from '../components/nativeHeader'; // [2026-10-09 native-sheets-headers]
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import {
  IconArrowLeft, IconUsers, IconPlus, IconChevronRight, IconChevronDown, IconShield,
  IconImage, IconStar, IconNavigation, IconShare, IconMessageCircle,
  IconLogout, IconKey, IconEdit, IconSparkles, IconCalendar, IconCheckbox, IconCheckboxChecked,
} from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';
import ErrorBoundary from '../components/ErrorBoundary';
import PressableScale from '../components/PressableScale';
import FadeSlideIn from '../components/FadeSlideIn';
import { FontSize, BorderRadius, Shadow, haptic } from '../constants/theme';
import * as api from '../services/api';
// [2026-05-22 monetization-pause] hidden by MONETIZATION_ENABLED flag
import { PLANS_ENABLED } from '../constants/featureFlags';
import useDragToDismiss, { DragSheetRoot, DragPanel } from '../components/ui/useDragToDismiss';

// Theme-aware accent + helpers. `colors.primary` is a neutral near-black in
// BOTH themes, so using it raw as an accent went invisible in dark mode. We
// derive a legible accent (ink in light, near-white in dark) + an inverted
// "on-accent" color for filled buttons.
function useFamilyPalette() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const accent = isDark ? colors.text : colors.primary;
  const onAccent = isDark ? colors.background : '#ffffff';
  const heroBg = isDark ? colors.surfaceVariant : '#f5f6f8';
  const roles = {
    parent: { bg: accent + '1A', fg: accent, label: t('family.role.parent') },
    spouse: { bg: (isDark ? '#F472B6' : '#DB2777') + '22', fg: isDark ? '#F9A8D4' : '#DB2777', label: t('family.role.spouse') },
    child:  { bg: (colors.success || '#10B981') + '22', fg: colors.success || '#10B981', label: t('family.role.child') },
  };
  return { colors, isDark, accent, onAccent, heroBg, roles };
}

// Relative "last seen" — tolerant of seconds / ms epochs and ISO strings.
function relativeSeen(lastSeen, t) {
  if (!lastSeen) return null;
  let ts = 0;
  if (typeof lastSeen === 'number') ts = lastSeen < 1e12 ? lastSeen * 1000 : lastSeen;
  else {
    const n = Number(lastSeen);
    if (!Number.isNaN(n) && n > 0) ts = n < 1e12 ? n * 1000 : n;
    else { const d = Date.parse(lastSeen); if (!Number.isNaN(d)) ts = d; }
  }
  if (!ts) return null;
  const diff = Date.now() - ts;
  if (diff < 90000) return t('family.seen.now');
  const min = Math.floor(diff / 60000);
  if (min < 60) return t('family.seen.min', { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t('family.seen.hour', { n: h });
  const d = Math.floor(h / 24);
  if (d < 7) return t(d === 1 ? 'family.seen.day' : 'family.seen.days', { n: d });
  const w = Math.floor(d / 7);
  if (w < 5) return t('family.seen.week', { n: w });
  const mo = Math.floor(d / 30);
  return t(mo === 1 ? 'family.seen.month' : 'family.seen.months', { n: mo });
}

// Normalize any "list" response body into a plain array (the real handlers'
// exact wrapper key is confirmed at runtime; we accept the common shapes).
function pickArray(body, ...keys) {
  const d = body?.data ?? body;
  if (Array.isArray(d)) return d;
  for (const k of keys) {
    if (Array.isArray(d?.[k])) return d[k];
    if (Array.isArray(body?.[k])) return body[k];
  }
  if (Array.isArray(d?.items)) return d.items;
  if (Array.isArray(d?.list)) return d.list;
  if (Array.isArray(d?.rows)) return d.rows;
  return [];
}
const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true';

// Composite avatar — up to 4 members in a 2×2 grid; defensive.
function FamilyComposite({ members, size = 100, accent }) {
  const slice = (Array.isArray(members) ? members : []).filter(Boolean).slice(0, 4);
  const cell = size / 2;
  if (slice.length === 0) {
    return (
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: accent + '1A', alignItems: 'center', justifyContent: 'center' }}>
        <IconUsers size={size * 0.44} color={accent} />
      </View>
    );
  }
  if (slice.length === 1) {
    return <AvatarCircle email={slice[0].email} name={slice[0].name} size={size} ringColor={accent} />;
  }
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, overflow: 'hidden', flexDirection: 'row', flexWrap: 'wrap', borderWidth: 3, borderColor: accent }}>
      {slice.map((m, idx) => (
        <View key={m.email || idx} style={{ width: cell, height: cell }}>
          <AvatarCircle email={m.email} name={m.name} size={cell} />
        </View>
      ))}
    </View>
  );
}

function SectionHeader({ title, colors }) {
  return <Text style={[s.sectionHeader, { color: colors.textSecondary }]}>{title}</Text>;
}

function FeatureRow({ icon: Icon, color, title, subtitle, onPress, colors, badge, last }) {
  return (
    <PressableScale
      onPress={onPress}
      scaleTo={0.985}
      style={[s.row, { borderBottomColor: colors.border }, last && { borderBottomWidth: 0 }]}
      accessibilityRole="button"
      accessibilityLabel={title}
    >
      <View style={[s.rowIcon, { backgroundColor: color + '22' }]}>
        <Icon size={20} color={color} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[s.rowTitle, { color: colors.text }]}>{title}</Text>
        {!!subtitle && <Text style={[s.rowSub, { color: colors.textSecondary }]} numberOfLines={1}>{subtitle}</Text>}
      </View>
      {!!badge && (
        <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: color + '22', marginRight: 6 }}>
          <Text style={{ fontSize: 11, fontWeight: '800', color }}>{badge}</Text>
        </View>
      )}
      <IconChevronRight size={18} color={colors.textSecondary} />
    </PressableScale>
  );
}

// Expandable feature card — header toggles; the body component mounts only
// while open, so it self-loads its data on first expand (and refreshes on
// re-expand).
function CollapsibleFeature({ icon: Icon, color, title, subtitle, colors, badge, renderBody, last }) {
  const [open, setOpen] = useState(false);
  const rot = useRef(new Animated.Value(0)).current;
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try { haptic.select(); } catch {}
    Animated.timing(rot, { toValue: next ? 1 : 0, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  };
  return (
    <View style={{ borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
      <PressableScale onPress={toggle} scaleTo={0.985} style={[s.row, { borderBottomWidth: 0 }]} accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded: open }}>
        <View style={[s.rowIcon, { backgroundColor: color + '22' }]}>
          <Icon size={20} color={color} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[s.rowTitle, { color: colors.text }]}>{title}</Text>
          {!!subtitle && <Text style={[s.rowSub, { color: colors.textSecondary }]} numberOfLines={1}>{subtitle}</Text>}
        </View>
        {!!badge && (
          <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: color + '22', marginRight: 6 }}>
            <Text style={{ fontSize: 11, fontWeight: '800', color }}>{badge}</Text>
          </View>
        )}
        <Animated.View style={{ transform: [{ rotate: rot.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] }) }] }}>
          <IconChevronDown size={18} color={colors.textSecondary} />
        </Animated.View>
      </PressableScale>
      {open && (
        <FadeSlideIn distance={6} duration={180}>
          <View style={{ paddingHorizontal: 14, paddingBottom: 14 }}>{renderBody()}</View>
        </FadeSlideIn>
      )}
    </View>
  );
}

// ── Shared shopping list — fully interactive (get / add {text} / toggle {id}) ──
function SharedShoppingList({ colors, accent, onAccent }) {
  const { t } = useLanguage();
  const [items, setItems] = useState(null); // null = not loaded
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);

  const normalize = (body) => pickArray(body, 'items', 'list', 'shopping').map((it, i) => ({
    id: it.id ?? it.item_id ?? it._id ?? String(i),
    text: (it.text ?? it.name ?? it.title ?? it.label ?? '').toString(),
    checked: truthy(it.checked ?? it.done ?? it.completed ?? it.is_checked),
  }));

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await api.familyShoppingListGet();
      setItems(r?.success ? normalize(r) : (r ? normalize(r) : []));
    } catch { setItems([]); } finally { setBusy(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const add = async () => {
    const v = text.trim();
    if (!v) return;
    setAdding(true);
    setText('');
    try {
      const r = await api.familyShoppingListAdd(v);
      if (r?.success) { try { haptic.light(); } catch {} load(); }
      else { setText(v); Alert.alert(t('family.shopping.title'), r?.message || t('notifPref.addFailed')); }
    } catch { setText(v); } finally { setAdding(false); }
  };

  const toggle = async (id) => {
    setItems(prev => (prev || []).map(it => it.id === id ? { ...it, checked: !it.checked } : it));
    try { haptic.select(); } catch {}
    try { const r = await api.familyShoppingListToggle(id); if (!r?.success) load(); } catch { load(); }
  };

  if (items === null) {
    return busy
      ? <ActivityIndicator color={accent} style={{ marginVertical: 10 }} />
      : <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm, paddingVertical: 6 }}>{t('family.tapToLoad')}</Text>;
  }
  return (
    <View>
      {items.length === 0 && !busy && (
        <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm, paddingVertical: 8 }}>{t('family.shopping.empty')}</Text>
      )}
      {items.map(it => (
        <TouchableOpacity key={it.id} onPress={() => toggle(it.id)} activeOpacity={0.6} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9 }} accessibilityRole="checkbox" accessibilityState={{ checked: it.checked }} accessibilityLabel={it.text}>
          {it.checked
            ? <IconCheckboxChecked size={22} color={colors.success || '#10B981'} />
            : <IconCheckbox size={22} color={colors.textSecondary} />}
          <Text style={{ flex: 1, fontSize: FontSize.base, color: it.checked ? colors.textSecondary : colors.text, textDecorationLine: it.checked ? 'line-through' : 'none' }}>{it.text}</Text>
        </TouchableOpacity>
      ))}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <TextInput
          value={text}
          onChangeText={setText}
          onSubmitEditing={add}
          returnKeyType="done"
          placeholder={t('family.shopping.addPh')}
          placeholderTextColor={colors.textSecondary}
          style={{ flex: 1, backgroundColor: colors.borderLight, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, color: colors.text, fontSize: FontSize.base }}
        />
        <TouchableOpacity onPress={add} disabled={adding || !text.trim()} style={{ backgroundColor: accent, borderRadius: 10, width: 42, height: 40, alignItems: 'center', justifyContent: 'center', opacity: (adding || !text.trim()) ? 0.5 : 1 }} accessibilityRole="button" accessibilityLabel={t('family.shopping.add')}>
          {adding ? <ActivityIndicator color={onAccent} /> : <IconPlus size={20} color={onAccent} />}
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Shared album — grid of photos + add via picker ──
function SharedAlbum({ colors, accent }) {
  const { t } = useLanguage();
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);

  const normalize = (body) => pickArray(body, 'items', 'photos', 'album', 'media').map((it, i) => ({
    id: it.id ?? it._id ?? String(i),
    url: it.url || it.image_url || it.photo_url || it.media_url || it.thumb || it.src || it.thumbnail || '',
    caption: it.caption || it.title || '',
  })).filter(x => x.url);

  const load = useCallback(async () => {
    setBusy(true);
    try { const r = await api.familySharedAlbumList(); setItems(normalize(r || {})); }
    catch { setItems([]); } finally { setBusy(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const addPhoto = async () => {
    try {
      const ImagePicker = await import('expo-image-picker').catch(() => null);
      if (!ImagePicker) { Alert.alert(t('family.album.short'), t('family.album.pickerUnavailable')); return; }
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) { Alert.alert(t('common.permissionDenied'), t('family.album.permBody')); return; }
      if (Platform.OS === 'ios') await new Promise(r => setTimeout(r, 300));
      const pick = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.9 });
      if (pick.canceled || !pick.assets?.length) return;
      setUploading(true);
      const r = await api.familySharedAlbumAdd(pick.assets[0].uri, '');
      if (r?.success) { try { haptic.success(); } catch {} load(); }
      else Alert.alert(t('family.album.short'), r?.message || t('profile.avatarUploadFailed'));
    } catch { Alert.alert(t('family.album.short'), t('profile.avatarUploadFailed')); }
    finally { setUploading(false); }
  };

  if (items === null) {
    return busy
      ? <ActivityIndicator color={accent} style={{ marginVertical: 10 }} />
      : <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm, paddingVertical: 6 }}>{t('family.tapToLoad')}</Text>;
  }
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
      {items.map(it => (
        <Image key={it.id} source={{ uri: it.url }} style={{ width: 84, height: 84, borderRadius: 12, backgroundColor: colors.borderLight }} />
      ))}
      <TouchableOpacity onPress={addPhoto} disabled={uploading} style={{ width: 84, height: 84, borderRadius: 12, borderWidth: 1.5, borderColor: colors.border, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', backgroundColor: accent + '0D' }} accessibilityRole="button" accessibilityLabel={t('family.album.add')}>
        {uploading ? <ActivityIndicator color={accent} /> : <IconPlus size={24} color={accent} />}
      </TouchableOpacity>
      {items.length === 0 && !busy && (
        <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm, width: '100%', marginTop: 8 }}>{t('family.album.empty')}</Text>
      )}
    </View>
  );
}

// ── Shared calendar — upcoming events list + quick add ──
function SharedCalendar({ colors, accent, onAccent }) {
  const { t } = useLanguage();
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [saving, setSaving] = useState(false);

  const normalize = (body) => pickArray(body, 'events', 'items', 'calendar').map((it, i) => ({
    id: it.id ?? it._id ?? String(i),
    title: (it.title ?? it.name ?? it.summary ?? t('eventDetail.title')).toString(),
    date: it.date || it.start || it.when || it.datetime || it.start_date || '',
  }));

  const load = useCallback(async () => {
    setBusy(true);
    try { const r = await api.familyCalendarList(); setItems(normalize(r || {})); }
    catch { setItems([]); } finally { setBusy(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    const tt = title.trim();
    if (!tt) { Alert.alert(t('eventDetail.title'), t('family.event.needTitle')); return; }
    setSaving(true);
    try {
      const r = await api.familyCalendarAdd({ title: tt, date: date.trim() });
      if (r?.success) { try { haptic.success(); } catch {} setAddOpen(false); setTitle(''); setDate(''); load(); }
      else Alert.alert(t('eventDetail.title'), r?.message || t('profile.saveFailed'));
    } catch { Alert.alert(t('eventDetail.title'), t('common.networkError')); } finally { setSaving(false); }
  };

  const fmtDate = (d) => {
    const r = relativeSeen(d, t); // reuse epoch/ISO parsing; fall back to raw
    if (!d) return '';
    const parsed = Date.parse(typeof d === 'number' ? d : d);
    if (!Number.isNaN(parsed)) {
      try { return new Date(parsed).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }); } catch {}
    }
    return (typeof d === 'string') ? d : (r || '');
  };

  if (items === null) {
    return busy
      ? <ActivityIndicator color={accent} style={{ marginVertical: 10 }} />
      : <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm, paddingVertical: 6 }}>{t('family.tapToLoad')}</Text>;
  }
  return (
    <View>
      {items.length === 0 && !busy && (
        <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm, paddingVertical: 8 }}>{t('family.event.empty')}</Text>
      )}
      {items.map(ev => (
        <View key={ev.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9 }}>
          <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: accent + '14', alignItems: 'center', justifyContent: 'center' }}>
            <IconCalendar size={17} color={accent} />
          </View>
          <Text style={{ flex: 1, fontSize: FontSize.base, color: colors.text }} numberOfLines={1}>{ev.title}</Text>
          {!!ev.date && <Text style={{ fontSize: FontSize.sm, color: colors.textSecondary, fontWeight: '600' }}>{fmtDate(ev.date)}</Text>}
        </View>
      ))}
      <TouchableOpacity onPress={() => setAddOpen(true)} activeOpacity={0.7} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, paddingVertical: 8 }} accessibilityRole="button" accessibilityLabel={t('one.newEvent')}>
        <IconPlus size={18} color={accent} />
        <Text style={{ color: accent, fontWeight: '700', fontSize: FontSize.base }}>{t('one.newEvent')}</Text>
      </TouchableOpacity>

      <Modal visible={addOpen} transparent animationType="fade" onRequestClose={() => setAddOpen(false)}>
        <View style={s.centerOverlay}>
          <View style={[s.centerCard, { backgroundColor: colors.surface }]}>
            <Text style={[s.modalTitle, { color: colors.text }]}>{t('one.newEvent')}</Text>
            <TextInput value={title} onChangeText={setTitle} placeholder={t('eventDetail.titleField')} placeholderTextColor={colors.textSecondary} style={[s.input, { color: colors.text, backgroundColor: colors.borderLight, borderColor: colors.border, marginTop: 14 }]} autoFocus />
            <TextInput value={date} onChangeText={setDate} placeholder={t('family.event.datePh')} placeholderTextColor={colors.textSecondary} autoCapitalize="none" style={[s.input, { color: colors.text, backgroundColor: colors.borderLight, borderColor: colors.border, marginTop: 10 }]} />
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
              <TouchableOpacity onPress={() => setAddOpen(false)} style={[s.btn, { backgroundColor: colors.borderLight, flex: 1 }]}><Text style={[s.btnText, { color: colors.text }]}>{t('common.cancel')}</Text></TouchableOpacity>
              <TouchableOpacity onPress={save} disabled={saving} style={[s.btn, { backgroundColor: accent, flex: 1, opacity: saving ? 0.6 : 1 }]}>{saving ? <ActivityIndicator color={onAccent} /> : <Text style={[s.btnText, { color: onAccent }]}>{t('common.save')}</Text>}</TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function MemberRow({ member, colors, roles, ownerEmail, isMe, onRemove, index = 0 }) {
  const { t } = useLanguage();
  const safeEmail = (member?.email || member?.child_email || '').toString();
  const safeName = (member?.name || member?.child_name || (safeEmail.includes('@') ? safeEmail.split('@')[0] : safeEmail) || '').toString();
  const online = !!member?.online || member?.presence === 'online';
  const seen = online ? null : relativeSeen(member?.last_seen, t);
  // Role badge: owner → "Responsável"; else the member's role if the backend
  // provides one; else nothing (the contract's member shape has no role).
  const isOwnerEmail = !!ownerEmail && safeEmail.toLowerCase() === ownerEmail.toLowerCase();
  const palette = isOwnerEmail
    ? { bg: (colors.primary || '#111') + '00', fg: colors.text, label: t('family.role.owner'), owner: true }
    : (member?.role && roles[member.role]) ? roles[member.role] : null;

  const enter = useRef(new Animated.Value(0)).current;
  const avatarScale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const tm = setTimeout(() => {
      Animated.timing(enter, { toValue: 1, duration: 320, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    }, Math.min(index, 8) * 55);
    return () => clearTimeout(tm);
  }, [enter, index]);
  const bounceAvatar = () => {
    try { haptic.light(); } catch {}
    Animated.sequence([
      Animated.timing(avatarScale, { toValue: 0.9, duration: 90, useNativeDriver: true }),
      Animated.spring(avatarScale, { toValue: 1, friction: 4, tension: 220, useNativeDriver: true }),
    ]).start();
  };

  return (
    <Animated.View style={[s.memberRow, { borderBottomColor: colors.border }, { opacity: enter, transform: [{ scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) }] }]}>
      <TouchableOpacity activeOpacity={0.85} onPress={bounceAvatar} accessibilityRole="image" accessibilityLabel={safeName || safeEmail || t('family.memberFallback')}>
        <Animated.View style={{ transform: [{ scale: avatarScale }] }}>
          <AvatarCircle email={safeEmail} name={safeName} size={46} online={online} showStatus ringColor={colors.success || '#10B981'} />
        </Animated.View>
      </TouchableOpacity>
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text style={[s.memberName, { color: colors.text }]} numberOfLines={1}>
          {safeName || safeEmail || t('family.memberFallback')}{isMe ? ` (${t('chatConv.you')})` : ''}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
          {palette && (
            <View style={{ paddingHorizontal: palette.owner ? 0 : 8, paddingVertical: 2, borderRadius: 8, backgroundColor: palette.bg }}>
              <Text style={{ fontSize: 11, fontWeight: '700', color: palette.fg }}>{palette.label}</Text>
            </View>
          )}
          {online ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.success || '#10B981' }} />
              <Text style={{ fontSize: 12, fontWeight: '600', color: colors.success || '#10B981' }}>{t('parental.onlineNow')}</Text>
            </View>
          ) : !!seen && <Text style={{ fontSize: 12, color: colors.textSecondary }}>{seen}</Text>}
        </View>
      </View>
      {onRemove && !isMe && (
        <TouchableOpacity onPress={() => onRemove(member)} accessibilityLabel={t('family.removeA11y', { name: safeName || safeEmail })} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={{ padding: 6 }}>
          <Text style={{ color: colors.error || '#ef4444', fontSize: 13, fontWeight: '700' }}>{t('common.remove')}</Text>
        </TouchableOpacity>
      )}
    </Animated.View>
  );
}

// Idle pulse ring behind the "Convidar familiar" CTA while the family is small.
function InvitePulseRing({ active, accent }) {
  const ring = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active) return;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(ring, { toValue: 1, duration: 1400, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(ring, { toValue: 0, duration: 0, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [active, ring]);
  return (
    <Animated.View pointerEvents="none" style={{ position: 'absolute', left: 14, top: '50%', marginTop: -19, width: 38, height: 38, borderRadius: 19, borderWidth: 2, borderColor: accent, opacity: ring.interpolate({ inputRange: [0, 1], outputRange: [0.4, 0] }), transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.7] }) }] }} />
  );
}

function FamilySkeleton({ colors }) {
  const block = (h, w = '100%', mb = 10) => (
    <View style={{ height: h, width: w, borderRadius: 12, backgroundColor: colors.borderLight, marginBottom: mb }} />
  );
  return (
    <View style={{ padding: 20 }}>
      <View style={{ alignItems: 'center', marginBottom: 28 }}>
        <View style={{ width: 100, height: 100, borderRadius: 50, backgroundColor: colors.borderLight, marginBottom: 14 }} />
        {block(22, 180, 8)}{block(13, 120, 0)}
      </View>
      <View style={{ height: 14 }} />
      {block(64)}{block(64)}{block(64)}
    </View>
  );
}

function FamilyScreenInner() {
  // [2026-10-17 drag-dismiss] folha desce arrastando de qualquer ponto (components/ui/useDragToDismiss).
  const _drag929 = useDragToDismiss({ onDismiss: () => { const f = () => setInviteOpen(false); f(); } });
  const router = useRouter();
  const { colors, accent, onAccent, heroBg, roles } = useFamilyPalette();
  const { isDark } = useTheme();
  const { user } = useAuth();
  const { t } = useLanguage();

  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);
  const [family, setFamily] = useState(null);
  const [planShare, setPlanShare] = useState(null);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteTarget, setInviteTarget] = useState('');
  const [inviteRole, setInviteRole] = useState('child');
  const [inviteSending, setInviteSending] = useState(false);

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');

  const [joinOpen, setJoinOpen] = useState(false);
  const [joinValue, setJoinValue] = useState('');
  const [joinBusy, setJoinBusy] = useState(false);

  const myEmail = (user?.email || '').toLowerCase();

  const loadInfo = useCallback(async () => {
    setErrored(false);
    try {
      const [r1, r2] = await Promise.all([
        api.familyInfo(),
        PLANS_ENABLED ? api.familyPlanShare().catch(() => null) : Promise.resolve(null),
      ]);
      if (r1?.success && r1?.data) {
        const d = r1.data;
        // REAL contract: members is a SIBLING of family (data.members), and
        // my_role / is_owner live at data level.
        const members = Array.isArray(d.members)
          ? d.members.filter(m => m && (typeof m.email === 'string') && m.email)
          : [];
        setFamily({
          ...(d.family || {}),
          members,
          my_role: d.my_role,
          is_owner: !!d.is_owner,
        });
      } else {
        // Backend auto-creates a solo family, so this is rare. Synthesize a
        // minimal solo family from the signed-in user so the screen never
        // renders blank.
        setFamily({
          id: 'self', name: '', owner_email: myEmail, is_owner: true,
          members: [{ email: myEmail || 'me', name: user?.name || myEmail || t('common.you'), online: true, presence: 'online' }],
        });
      }
      if (r2?.success && r2.data) setPlanShare(r2.data);
    } catch {
      setErrored(true);
    } finally {
      setLoading(false);
    }
  }, [myEmail, user?.name, t]);

  useEffect(() => { try { console.log('[FAMILIA-DIAG][family][mount]'); } catch {} loadInfo(); }, [loadInfo]);

  const members = family?.members || [];
  const isOwner = !!family?.is_owner;
  const ownerEmail = family?.owner_email || '';
  const memberCount = members.length;
  const onlineCount = useMemo(
    () => members.filter(m => (m.online || m.presence === 'online') && (m.email || '').toLowerCase() !== myEmail).length,
    [members, myEmail]
  );

  // ── Invite → share deep-link ──
  const handleInvite = async () => {
    const target = inviteTarget.trim();
    if (!target) { Alert.alert(t('family.invite.title'), t('family.invite.needTarget')); return; }
    const tgtLower = target.toLowerCase();
    if (tgtLower === myEmail) { Alert.alert(t('family.invite.title'), t('family.invite.self')); return; }
    if (members.some(m => (m.email || '').toLowerCase() === tgtLower)) {
      Alert.alert(t('family.invite.title'), t('family.invite.already')); return;
    }
    setInviteSending(true);
    try {
      const r = await api.familyInvite(target, inviteRole);
      if (r?.success) {
        try { haptic.success(); } catch {}
        setInviteOpen(false); setInviteTarget('');
        const link = r?.data?.link;
        if (link) {
          Alert.alert(t('family.invite.created'), t('family.invite.createdBody', { target }), [
            { text: t('common.close'), style: 'cancel' },
            { text: t('common.share'), onPress: () => { Share.share({ message: t('family.invite.shareMsg', { family: family?.name || t('family.myFamilyLower'), link }) }).catch(() => {}); } },
          ]);
        } else {
          Alert.alert(t('family.invite.sent'), t('family.invite.sentBody', { target }));
        }
        loadInfo();
      } else {
        // Rate-limit (10/24h) and other failures return a pt-BR message.
        Alert.alert(t('family.invite.title'), r?.message || t('family.invite.sendFailed'));
      }
    } catch {
      Alert.alert(t('family.invite.title'), t('common.networkError'));
    } finally { setInviteSending(false); }
  };

  // ── Join by pasted invite link / token ──
  const handleJoin = async () => {
    const raw = joinValue.trim();
    if (!raw) { Alert.alert(t('family.invite.title'), t('family.join.needValue')); return; }
    const m = raw.match(/family\/join\/([^\s/?#]+)/i);
    const token = m ? m[1] : raw;
    setJoinBusy(true);
    try {
      const r = await api.familyJoin(token);
      if (r?.success) {
        try { haptic.success(); } catch {}
        setJoinOpen(false); setJoinValue('');
        setLoading(true);
        await loadInfo();
      } else {
        Alert.alert(t('family.invite.title'), r?.message || t('family.join.invalid'));
      }
    } catch { Alert.alert(t('family.invite.title'), t('common.networkError')); }
    finally { setJoinBusy(false); }
  };

  // ── Rename (owner, optimistic) ──
  const handleRename = async () => {
    const name = renameValue.trim();
    if (!name) return;
    const prevName = family?.name;
    setFamily(prev => prev ? { ...prev, name } : prev);
    setRenameOpen(false);
    try { const r = await api.familyUpdate({ name }); if (!r?.success) setFamily(prev => prev ? { ...prev, name: prevName } : prev); }
    catch { setFamily(prev => prev ? { ...prev, name: prevName } : prev); }
  };

  // ── Remove member (owner) ──
  const confirmRemove = (member) => {
    const label = member.name || member.email;
    const doRemove = async () => { try { await api.familyRemoveMember(member.email); } catch {} loadInfo(); };
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm(t('family.remove.confirm', { name: label }))) doRemove();
    } else {
      Alert.alert(t('family.remove.title'), t('family.remove.confirm', { name: label }), [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('common.remove'), style: 'destructive', onPress: doRemove },
      ]);
    }
  };

  // ── Leave (non-owner) ──
  const confirmLeave = () => {
    const doLeave = async () => { try { await api.familyLeave(); } catch {} setLoading(true); await loadInfo(); };
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm(t('family.leave.confirmWeb'))) doLeave();
    } else {
      Alert.alert(t('family.leave.title'), t('family.leave.body'), [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('community.leave'), style: 'destructive', onPress: doLeave },
      ]);
    }
  };

  // ── Find My Family → prefetch locations, then open the map ──
  const openFamilyMap = () => {
    api.familyLocationAll().catch(() => {}); // warm the map's data source
    try { require('../services/snapMapPrefetch').prefetchSnapMap(); } catch {} // [2026-10-12 snapmap-speed]
    router.push('/snap-map');
  };

  // [2026-10-09 native-sheets-headers] Nativo: UINavigationBar/Toolbar do sistema
  // (antes o header JS ficava sob a status bar — sem inset do topo).
  const Header = USE_NATIVE_HEADER ? (
    <Stack.Screen options={nativeHeaderOptions({
      colors,
      isDark,
      title: t('menu.family'),
      headerRight: isOwner && !loading && !errored ? () => (
        <HeaderIconButton onPress={() => setInviteOpen(true)} accessibilityLabel={t('chat.invite')}>
          <IconPlus size={22} color={colors.text} />
        </HeaderIconButton>
      ) : () => null,
    })} />
  ) : (
    <View style={[s.header, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
      <TouchableOpacity onPress={() => router.back()} style={s.backBtn} accessibilityRole="button" accessibilityLabel={t('common.back')}>
        <IconArrowLeft size={22} color={colors.text} />
      </TouchableOpacity>
      <Text style={[s.headerTitle, { color: colors.text }]}>{t('menu.family')}</Text>
      {isOwner && !loading && !errored ? (
        <TouchableOpacity onPress={() => setInviteOpen(true)} style={s.backBtn} accessibilityRole="button" accessibilityLabel={t('family.invite.cta')}>
          <IconPlus size={22} color={accent} />
        </TouchableOpacity>
      ) : <View style={{ width: 30 }} />}
    </View>
  );

  if (loading) {
    return <View style={[s.container, { backgroundColor: colors.background }]}>{Header}<FamilySkeleton colors={colors} /></View>;
  }

  if (errored) {
    return (
      <View style={[s.container, { backgroundColor: colors.background }]}>
        {Header}
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
          <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: accent + '14', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
            <IconUsers size={34} color={accent} />
          </View>
          <Text style={{ fontSize: FontSize.lg, fontWeight: '800', color: colors.text, marginBottom: 6 }}>{t('family.loadErrorTitle')}</Text>
          <Text style={{ fontSize: FontSize.sm, color: colors.textSecondary, textAlign: 'center', marginBottom: 20, lineHeight: 19 }}>{t('family.loadErrorBody')}</Text>
          <PressableScale onPress={() => { setLoading(true); loadInfo(); }} style={[s.cta, { backgroundColor: accent }]} accessibilityRole="button" accessibilityLabel={t('common.tryAgain')}>
            <Text style={{ color: onAccent, fontWeight: '800', fontSize: FontSize.base }}>{t('common.tryAgain')}</Text>
          </PressableScale>
        </View>
      </View>
    );
  }

  return (
    <View style={[s.container, { backgroundColor: colors.background }]}>
      {Header}
      <FadeSlideIn>
      <ScrollView contentContainerStyle={{ paddingBottom: 48 }}>
        {/* Hero */}
        <View style={[s.hero, { backgroundColor: heroBg }]}>
          <FamilyComposite members={members} size={100} accent={accent} />
          <TouchableOpacity
            disabled={!isOwner}
            onPress={() => { setRenameValue(family?.name || ''); setRenameOpen(true); }}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={isOwner ? t('family.rename') : t('family.nameTitle')}
            style={{ marginTop: 16, alignItems: 'center' }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
              <Text style={[s.heroTitle, { color: colors.text }]}>{family?.name || t('family.myFamily')}</Text>
              {isOwner && <IconEdit size={16} color={colors.textSecondary} />}
            </View>
            <Text style={[s.heroSub, { color: colors.textSecondary }]}>
              {t(memberCount === 1 ? 'family.memberCount1' : 'family.memberCountN', { n: memberCount })}
              {onlineCount > 0 ? ` · ${t('family.onlineCount', { n: onlineCount })}` : ''}
            </Text>
          </TouchableOpacity>

          {memberCount <= 1 && isOwner && (
            <PressableScale onPress={() => setInviteOpen(true)} style={[s.cta, { backgroundColor: accent, marginTop: 18, paddingHorizontal: 22 }]} accessibilityRole="button" accessibilityLabel={t('family.invite.cta')}>
              <IconPlus size={18} color={onAccent} />
              <Text style={{ color: onAccent, fontWeight: '800', fontSize: FontSize.base }}>{t('family.invite.cta')}</Text>
            </PressableScale>
          )}
        </View>

        {/* Members */}
        <View style={s.section}>
          <SectionHeader title={t('community.members')} colors={colors} />
          <View style={[s.card, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
            {members.map((m, idx) => (
              <MemberRow
                key={m.email || idx}
                member={m}
                index={idx}
                colors={colors}
                roles={roles}
                ownerEmail={ownerEmail}
                isMe={(m.email || '').toLowerCase() === myEmail}
                onRemove={isOwner ? confirmRemove : null}
              />
            ))}
            {isOwner && (
              <TouchableOpacity onPress={() => setInviteOpen(true)} activeOpacity={0.7} style={[s.row, { borderBottomWidth: 0 }]} accessibilityRole="button" accessibilityLabel={t('family.invite.cta')}>
                <InvitePulseRing active={memberCount <= 1} accent={accent} />
                <View style={[s.rowIcon, { backgroundColor: accent + '1A' }]}>
                  <IconPlus size={20} color={accent} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[s.rowTitle, { color: accent, fontWeight: '700' }]}>{t('family.invite.cta')}</Text>
                  <Text style={[s.rowSub, { color: colors.textSecondary }]}>{t('family.invite.rowSub')}</Text>
                </View>
                <IconChevronRight size={18} color={accent} />
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Smart section — real, functional shared features */}
        <View style={s.section}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 4, marginBottom: 8 }}>
            <IconSparkles size={14} color={accent} />
            <Text style={[s.sectionHeader, { color: colors.textSecondary, marginBottom: 0, marginLeft: 0 }]}>{t('family.smart')}</Text>
          </View>
          <View style={[s.card, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
            <FeatureRow
              icon={IconNavigation}
              color={accent}
              title={t('family.find.title')}
              subtitle={onlineCount > 0 ? t(onlineCount === 1 ? 'family.find.subOnline1' : 'family.find.subOnlineN', { n: onlineCount }) : t('family.find.sub')}
              badge={onlineCount > 0 ? t('family.onlineCount', { n: onlineCount }) : null}
              onPress={openFamilyMap}
              colors={colors}
            />
            <FeatureRow
              icon={IconMessageCircle}
              color={accent}
              title={t('family.chat.title')}
              subtitle={t('family.chat.sub')}
              onPress={() => router.push('/chat-new')}
              colors={colors}
            />
            <CollapsibleFeature
              icon={IconCheckbox}
              color={accent}
              title={t('family.shopping.title')}
              subtitle={t('family.shopping.sub')}
              colors={colors}
              renderBody={() => <SharedShoppingList colors={colors} accent={accent} onAccent={onAccent} />}
            />
            <CollapsibleFeature
              icon={IconImage}
              color={accent}
              title={t('family.album.title')}
              subtitle={t('family.album.sub')}
              colors={colors}
              renderBody={() => <SharedAlbum colors={colors} accent={accent} />}
            />
            <CollapsibleFeature
              icon={IconCalendar}
              color={accent}
              title={t('family.calendar.title')}
              subtitle={t('family.calendar.sub')}
              colors={colors}
              renderBody={() => <SharedCalendar colors={colors} accent={accent} onAccent={onAccent} />}
              last
            />
          </View>
        </View>

        {/* Plan / parental (gated) */}
        {(PLANS_ENABLED) && (
          <View style={s.section}>
            <SectionHeader title={t('family.sharedSection')} colors={colors} />
            <View style={[s.card, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
              <FeatureRow
                icon={IconStar}
                color={accent}
                title={planShare?.plan_name ? t('family.plan.named', { name: planShare.plan_name }) : t('family.plan.default')}
                subtitle={planShare?.shared ? t('family.plan.sharedWith', { n: planShare.shared_with || memberCount }) : t('family.plan.shareUpTo')}
                badge={planShare?.shared ? t('plans.active') : null}
                onPress={() => router.push('/plans')}
                colors={colors}
                last
              />
            </View>
          </View>
        )}

        {/* Settings */}
        <View style={s.section}>
          <SectionHeader title={t('family.settings')} colors={colors} />
          <View style={[s.card, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
            <FeatureRow
              icon={IconUsers}
              color={accent}
              title={t('family.nameTitle')}
              subtitle={isOwner ? (family?.name || t('family.setName')) : t('family.ownerOnlyEdits', { name: family?.name || '—' })}
              onPress={() => { if (isOwner) { setRenameValue(family?.name || ''); setRenameOpen(true); } else Alert.alert(t('family.nameTitle'), t('family.ownerOnlyRename')); }}
              colors={colors}
            />
            <FeatureRow
              icon={IconShield}
              color={accent}
              title={t('settings.parentalControls')}
              subtitle={t('family.parental.sub')}
              onPress={() => router.push('/parental')}
              colors={colors}
            />
            <FeatureRow
              icon={IconKey}
              color={accent}
              title={t('family.join.rowTitle')}
              subtitle={t('family.join.rowSub')}
              onPress={() => { setJoinValue(''); setJoinOpen(true); }}
              colors={colors}
              last={isOwner}
            />
            {!isOwner && (
              <FeatureRow
                icon={IconLogout}
                color={colors.error || '#EF4444'}
                title={t('family.leave.title')}
                subtitle={t('family.leave.sub')}
                onPress={confirmLeave}
                colors={colors}
                last
              />
            )}
          </View>
        </View>
      </ScrollView>
      </FadeSlideIn>

      {/* Invite sheet */}
      <Modal visible={inviteOpen} transparent animationType="slide" onRequestClose={() => setInviteOpen(false)}>
        <DragSheetRoot>
        <View style={s.sheetOverlay}>
          <View style={[s.sheet, { backgroundColor: colors.surface }]}>
            <View style={[s.grabber, { backgroundColor: colors.border }]} />
            <Text style={[s.modalTitle, { color: colors.text }]}>{t('family.invite.cta')}</Text>
            <Text style={[s.modalSub, { color: colors.textSecondary }]}>{t('family.invite.sheetSub')}</Text>

            <Text style={[s.label, { color: colors.textSecondary }]}>{t('family.invite.targetLabel')}</Text>
            <TextInput
              value={inviteTarget}
              onChangeText={setInviteTarget}
              placeholder={t('family.invite.targetPh')}
              placeholderTextColor={colors.textSecondary}
              keyboardType="email-address"
              autoCapitalize="none"
              style={[s.input, { color: colors.text, backgroundColor: colors.borderLight, borderColor: colors.border }]}
            />

            <Text style={[s.label, { color: colors.textSecondary, marginTop: 16 }]}>{t('family.invite.roleLabel')}</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 18 }}>
              {[{ key: 'child', label: t('family.role.child') }, { key: 'parent', label: t('family.role.parent') }, { key: 'spouse', label: t('family.role.spouse') }].map(opt => {
                const sel = inviteRole === opt.key;
                const palette = roles[opt.key];
                return (
                  <TouchableOpacity key={opt.key} onPress={() => { try { haptic.select(); } catch {} setInviteRole(opt.key); }} activeOpacity={0.75} style={{ flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center', backgroundColor: sel ? palette.bg : colors.borderLight, borderWidth: 2, borderColor: sel ? palette.fg : 'transparent' }} accessibilityRole="button">
                    <Text style={{ fontSize: 13, fontWeight: '700', color: sel ? palette.fg : colors.text }}>{opt.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <DragPanel drag={_drag929} style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity onPress={() => setInviteOpen(false)} style={[s.btn, { backgroundColor: colors.borderLight, flex: 1 }]} accessibilityRole="button">
                <Text style={[s.btnText, { color: colors.text }]}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={handleInvite} disabled={inviteSending} style={[s.btn, { backgroundColor: accent, flex: 1, opacity: inviteSending ? 0.6 : 1 }]} accessibilityRole="button">
                {inviteSending ? <ActivityIndicator color={onAccent} /> : <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}><IconShare size={16} color={onAccent} /><Text style={[s.btnText, { color: onAccent }]}>{t('family.invite.generate')}</Text></View>}
              </TouchableOpacity>
            </DragPanel>
          </View>
        </View>
        </DragSheetRoot>
      </Modal>

      {/* Rename */}
      <Modal visible={renameOpen} transparent animationType="fade" onRequestClose={() => setRenameOpen(false)}>
        <View style={s.centerOverlay}>
          <View style={[s.centerCard, { backgroundColor: colors.surface }]}>
            <Text style={[s.modalTitle, { color: colors.text }]}>{t('family.nameTitle')}</Text>
            <TextInput value={renameValue} onChangeText={setRenameValue} placeholder={t('family.renamePh')} placeholderTextColor={colors.textSecondary} style={[s.input, { color: colors.text, backgroundColor: colors.borderLight, borderColor: colors.border, marginTop: 14 }]} maxLength={60} autoFocus />
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
              <TouchableOpacity onPress={() => setRenameOpen(false)} style={[s.btn, { backgroundColor: colors.borderLight, flex: 1 }]}><Text style={[s.btnText, { color: colors.text }]}>{t('common.cancel')}</Text></TouchableOpacity>
              <TouchableOpacity onPress={handleRename} style={[s.btn, { backgroundColor: accent, flex: 1 }]}><Text style={[s.btnText, { color: onAccent }]}>{t('common.save')}</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Join by invite */}
      <Modal visible={joinOpen} transparent animationType="fade" onRequestClose={() => setJoinOpen(false)}>
        <View style={s.centerOverlay}>
          <View style={[s.centerCard, { backgroundColor: colors.surface }]}>
            <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: accent + '14', alignItems: 'center', justifyContent: 'center', alignSelf: 'center', marginBottom: 12 }}>
              <IconKey size={24} color={accent} />
            </View>
            <Text style={[s.modalTitle, { color: colors.text, textAlign: 'center' }]}>{t('family.join.modalTitle')}</Text>
            <Text style={[s.modalSub, { color: colors.textSecondary, textAlign: 'center' }]}>{t('family.join.modalSub')}</Text>
            <TextInput value={joinValue} onChangeText={setJoinValue} placeholder={t('family.join.ph')} placeholderTextColor={colors.textSecondary} autoCapitalize="none" autoCorrect={false} style={[s.input, { color: colors.text, backgroundColor: colors.borderLight, borderColor: colors.border }]} autoFocus />
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
              <TouchableOpacity onPress={() => setJoinOpen(false)} style={[s.btn, { backgroundColor: colors.borderLight, flex: 1 }]}><Text style={[s.btnText, { color: colors.text }]}>{t('common.cancel')}</Text></TouchableOpacity>
              <TouchableOpacity onPress={handleJoin} disabled={joinBusy} style={[s.btn, { backgroundColor: accent, flex: 1, opacity: joinBusy ? 0.6 : 1 }]}>{joinBusy ? <ActivityIndicator color={onAccent} /> : <Text style={[s.btnText, { color: onAccent }]}>{t('meetings.join')}</Text>}</TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 14, borderBottomWidth: 1 },
  backBtn: { padding: 4, minWidth: 30, alignItems: 'center' },
  headerTitle: { fontSize: FontSize.xxl, fontWeight: '700' },

  hero: { alignItems: 'center', paddingVertical: 30, paddingHorizontal: 20 },
  heroTitle: { fontSize: FontSize.heading, fontWeight: '800', letterSpacing: -0.4 },
  heroSub: { fontSize: FontSize.sm, marginTop: 5, fontWeight: '500' },

  section: { paddingHorizontal: 16, paddingTop: 20 },
  sectionHeader: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 8, marginLeft: 4 },
  card: { borderRadius: BorderRadius.xxl, borderWidth: 1, overflow: 'hidden' },

  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 14, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  rowIcon: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { fontSize: FontSize.lg, fontWeight: '600' },
  rowSub: { fontSize: FontSize.xs, marginTop: 2 },

  memberRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  memberName: { fontSize: FontSize.lg, fontWeight: '700' },

  cta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, paddingVertical: 14, paddingHorizontal: 24, borderRadius: BorderRadius.xxl, ...Shadow.md },

  sheetOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 24, paddingTop: 12, paddingBottom: 30 },
  grabber: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 14, opacity: 0.6 },
  centerOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 24 },
  centerCard: { borderRadius: 22, padding: 22, ...Shadow.float },

  modalTitle: { fontSize: FontSize.xxl, fontWeight: '800' },
  modalSub: { fontSize: FontSize.sm, marginTop: 5, marginBottom: 16, lineHeight: 19 },
  label: { fontSize: 12, fontWeight: '700', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.4 },
  input: { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 13, fontSize: FontSize.lg, borderWidth: 1 },

  btn: { borderRadius: 12, paddingVertical: 14, alignItems: 'center', justifyContent: 'center' },
  btnText: { fontSize: FontSize.lg, fontWeight: '700' },
});

export default function FamilyScreen() {
  return <ErrorBoundary><FamilyScreenInner /></ErrorBoundary>;
}
