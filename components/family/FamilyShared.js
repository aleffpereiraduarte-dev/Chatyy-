// [2026-10-19 family-hub] Dados compartilhados da família (lista de compras,
// álbum, calendário) num hook só + as PRÉVIAS inline do hub e os corpos das
// folhas "Ver tudo". Antes cada recurso era uma linha com chevron que expandia
// e buscava sozinha; agora o hub carrega tudo junto (3 GETs leves) e mostra o
// conteúdo real direto na página.
//
// Contrato real (email.php):
//   family_shopping_list_get → { items:[{id,item,qty,checked,added_by}] }
//   family_shopping_list_add {item}  ·  family_shopping_list_toggle {id, checked}
//   family_shared_album_list → { items:[{id,url,mime,caption,uploader}] }
//   family_shared_album_add  multipart `file` (o servidor sobe pro R2)
//   family_calendar_list → { events:[{id,title,starts_at,ends_at,location}] }
//   family_calendar_add {title, starts_at:'YYYY-MM-DD HH:MM:00'}
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, ActivityIndicator, Alert, Platform, StyleSheet, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { useLanguage } from '../../context/LanguageContext';
import { haptic } from '../../constants/theme';
import * as api from '../../services/api';
import { IconPlus, IconCheck, IconChevronRight, IconCalendar, IconImage, IconMapPin } from '../Icons';
import { useFamilyColors, IconCart, parseWhen, hasTime, toStartsAt, pad2 } from './familyUi';

function pickArray(body, ...keys) {
  const d = body?.data ?? body;
  if (Array.isArray(d)) return d;
  for (const k of keys) {
    if (Array.isArray(d?.[k])) return d[k];
    if (Array.isArray(body?.[k])) return body[k];
  }
  if (Array.isArray(d?.items)) return d.items;
  return [];
}
const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 't';

const normShopping = (body) => pickArray(body, 'items', 'list', 'shopping').map((it, i) => ({
  id: it.id ?? it.item_id ?? String(i),
  text: String(it.item ?? it.text ?? it.name ?? it.title ?? ''),
  qty: String(it.qty || ''),
  checked: truthy(it.checked ?? it.done ?? it.completed),
})).filter(x => x.text);

const normAlbum = (body) => pickArray(body, 'items', 'photos', 'album').map((it, i) => ({
  id: it.id ?? String(i),
  url: it.url || it.image_url || it.photo_url || it.thumb || '',
  mime: String(it.mime || ''),
  caption: it.caption || '',
})).filter(x => x.url && !/^video\//.test(x.mime));

const normEvents = (body, fallbackTitle) => pickArray(body, 'events', 'items', 'calendar').map((it, i) => ({
  id: it.id ?? String(i),
  title: String(it.title ?? it.name ?? fallbackTitle),
  raw: it.starts_at || it.date || it.start || '',
  when: parseWhen(it.starts_at || it.date || it.start || ''),
  location: it.location || '',
}));

// ── Hook de dados ─────────────────────────────────────────────────────────
export function useFamilyShared() {
  const { t } = useLanguage();
  const [shopping, setShopping] = useState(null); // null = carregando
  const [album, setAlbum] = useState(null);
  const [events, setEvents] = useState(null);
  const [uploading, setUploading] = useState(false);
  const busyToggle = useRef(new Set());

  const loadShopping = useCallback(async () => {
    try { const r = await api.familyShoppingListGet(); setShopping(normShopping(r || {})); }
    catch { setShopping(prev => prev || []); }
  }, []);
  const loadAlbum = useCallback(async () => {
    try { const r = await api.familySharedAlbumList(); setAlbum(normAlbum(r || {})); }
    catch { setAlbum(prev => prev || []); }
  }, []);
  const loadEvents = useCallback(async () => {
    try { const r = await api.familyCalendarList(); setEvents(normEvents(r || {}, t('eventDetail.title'))); }
    catch { setEvents(prev => prev || []); }
  }, [t]);
  const loadAll = useCallback(() => Promise.all([loadShopping(), loadAlbum(), loadEvents()]), [loadShopping, loadAlbum, loadEvents]);

  const toggleItem = useCallback(async (id) => {
    if (busyToggle.current.has(id)) return;
    let next = true;
    setShopping(prev => (prev || []).map(it => {
      if (it.id !== id) return it;
      next = !it.checked;
      return { ...it, checked: next };
    }));
    try { haptic.select(); } catch {}
    busyToggle.current.add(id);
    try { const r = await api.familyShoppingListToggle(id, next); if (!r?.success) loadShopping(); }
    catch { loadShopping(); }
    finally { busyToggle.current.delete(id); }
  }, [loadShopping]);

  const addItem = useCallback(async (text) => {
    const v = String(text || '').trim();
    if (!v) return false;
    const tmpId = 'tmp-' + Date.now();
    setShopping(prev => [{ id: tmpId, text: v, qty: '', checked: false, pending: true }, ...(prev || [])]);
    try {
      const r = await api.familyShoppingListAdd(v);
      if (r?.success) { try { haptic.light(); } catch {} loadShopping(); return true; }
      setShopping(prev => (prev || []).filter(x => x.id !== tmpId));
      Alert.alert(t('family.shopping.title'), r?.message || t('notifPref.addFailed'));
    } catch {
      setShopping(prev => (prev || []).filter(x => x.id !== tmpId));
      Alert.alert(t('family.shopping.title'), t('common.networkError'));
    }
    return false;
  }, [loadShopping, t]);

  const addPhoto = useCallback(async () => {
    try {
      const ImagePicker = await import('expo-image-picker').catch(() => null);
      if (!ImagePicker) { Alert.alert(t('family.album.short'), t('family.album.pickerUnavailable')); return; }
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) { Alert.alert(t('common.permissionDenied'), t('family.album.permBody')); return; }
      if (Platform.OS === 'ios') await new Promise(r => setTimeout(r, 300));
      const pick = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.85 });
      if (pick.canceled || !pick.assets?.length) return;
      setUploading(true);
      const r = await api.familySharedAlbumAdd(pick.assets[0].uri, '');
      if (r?.success) { try { haptic.success(); } catch {} loadAlbum(); }
      else Alert.alert(t('family.album.short'), r?.message || t('profile.avatarUploadFailed'));
    } catch { Alert.alert(t('family.album.short'), t('profile.avatarUploadFailed')); }
    finally { setUploading(false); }
  }, [loadAlbum, t]);

  const addEvent = useCallback(async ({ title, startsAt }) => {
    try {
      const r = await api.familyCalendarAdd({ title, starts_at: startsAt });
      if (r?.success) { try { haptic.success(); } catch {} loadEvents(); return true; }
      Alert.alert(t('eventDetail.title'), r?.message || t('profile.saveFailed'));
    } catch { Alert.alert(t('eventDetail.title'), t('common.networkError')); }
    return false;
  }, [loadEvents, t]);

  const upcoming = useMemo(() => {
    if (!events) return null;
    const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
    return events.filter(e => e.when && e.when.getTime() >= startToday.getTime())
      .sort((a, b) => a.when - b.when);
  }, [events]);

  return { shopping, album, events, upcoming, uploading, loadAll, loadShopping, loadAlbum, loadEvents, toggleItem, addItem, addPhoto, addEvent };
}

// ── Peças ────────────────────────────────────────────────────────────────
function Card({ children, style }) {
  const c = useFamilyColors();
  return <View style={[{ backgroundColor: c.cardBg, borderRadius: 18, marginHorizontal: 16, overflow: 'hidden' }, style]}>{children}</View>;
}

function CardHeader({ Icon, title, meta, onPress, actionLabel }) {
  const c = useFamilyColors();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={actionLabel ? `${title}, ${actionLabel}` : title}
      style={({ pressed }) => [st.cardHead, pressed && onPress && { opacity: 0.6 }]}>
      <View style={[st.headIcon, { backgroundColor: c.tileBg }]}><Icon size={15} color={c.tileFg} /></View>
      <Text style={[st.headTitle, { color: c.text }]} numberOfLines={1}>{title}</Text>
      {!!meta && <Text style={[st.headMeta, { color: c.secondary }]} numberOfLines={1}>{meta}</Text>}
      {!!onPress && <IconChevronRight size={16} color={c.tertiary} />}
    </Pressable>
  );
}

function CheckCircle({ checked, pending }) {
  const c = useFamilyColors();
  return (
    <View style={[st.check, { borderColor: checked ? c.chipOn : c.tertiary, backgroundColor: checked ? c.chipOn : 'transparent', opacity: pending ? 0.4 : 1 }]}>
      {checked && <IconCheck size={13} color={c.onChipOn} strokeWidth={3} />}
    </View>
  );
}

export function ShoppingRow({ item, onToggle, last }) {
  const c = useFamilyColors();
  return (
    <Pressable onPress={() => !item.pending && onToggle(item.id)} accessibilityRole="checkbox" accessibilityState={{ checked: item.checked }} accessibilityLabel={item.text}
      style={({ pressed }) => [st.itemRow, pressed && { backgroundColor: c.chip }]}>
      <CheckCircle checked={item.checked} pending={item.pending} />
      <View style={[st.itemBody, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.separator }]}>
        <Text style={[st.itemText, { color: item.checked ? c.secondary : c.text, textDecorationLine: item.checked ? 'line-through' : 'none' }]} numberOfLines={2}>{item.text}</Text>
        {!!item.qty && <Text style={{ color: c.secondary, fontSize: 14, marginLeft: 8 }}>{item.qty}</Text>}
      </View>
    </Pressable>
  );
}

export function ShoppingAddRow({ onAdd, autoFocus }) {
  const c = useFamilyColors();
  const { t } = useLanguage();
  const [text, setText] = useState('');
  const submit = () => {
    const v = text.trim();
    if (!v) return;
    setText('');
    onAdd(v);
  };
  return (
    <View style={st.addRow}>
      <View style={[st.addPlus, { backgroundColor: c.chip }]}><IconPlus size={14} color={c.secondary} /></View>
      <TextInput value={text} onChangeText={setText} onSubmitEditing={submit} blurOnSubmit={false} returnKeyType="done" autoFocus={autoFocus}
        placeholder={t('family.shopping.addPh')} placeholderTextColor={c.secondary}
        style={[st.addInput, { color: c.text }]} accessibilityLabel={t('family.shopping.add')} />
      {!!text.trim() && (
        <Pressable onPress={submit} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('family.shopping.add')} style={[st.addBtn, { backgroundColor: c.pill }]}>
          <Text style={{ color: c.onPill, fontWeight: '600', fontSize: 14 }}>{t('family.hub.add')}</Text>
        </Pressable>
      )}
    </View>
  );
}

// ── Prévia: lista de compras (3 primeiros + adicionar) ─────────────────────
export function ShoppingPreview({ data, onOpen }) {
  const c = useFamilyColors();
  const { t } = useLanguage();
  const items = data.shopping;
  const pending = (items || []).filter(x => !x.checked);
  const top = pending.slice(0, 3);
  const meta = items == null ? '' : pending.length ? t('family.hub.pendingN', { n: pending.length }) : '';
  return (
    <Card>
      <CardHeader Icon={IconCart} title={t('family.shopping.title')} meta={meta} onPress={onOpen} actionLabel={t('family.hub.seeAll')} />
      {items == null ? (
        <View style={{ paddingVertical: 14 }}><ActivityIndicator color={c.secondary} /></View>
      ) : (
        <>
          {top.length === 0 && (
            <Text style={[st.empty, { color: c.secondary }]}>{items.length ? t('family.hub.shoppingAllDone') : t('family.shopping.empty')}</Text>
          )}
          {top.map((it, i) => <ShoppingRow key={it.id} item={it} onToggle={data.toggleItem} last={false} />)}
          <ShoppingAddRow onAdd={data.addItem} />
        </>
      )}
    </Card>
  );
}

// ── Prévia: álbum (4 últimas fotos) ────────────────────────────────────────
export function AlbumPreview({ data, onOpen }) {
  const c = useFamilyColors();
  const { t } = useLanguage();
  const items = data.album;
  const top = (items || []).slice(0, 4);
  const slots = [...top];
  const showAdd = top.length < 4;
  return (
    <Card>
      <CardHeader Icon={IconImage} title={t('family.album.title')} meta={items && items.length ? t('family.hub.photosN', { n: items.length }) : ''} onPress={onOpen} actionLabel={t('family.hub.seeAll')} />
      <View style={st.albumRow}>
        {items == null
          ? [0, 1, 2, 3].map(i => <View key={i} style={[st.albumCell, { backgroundColor: c.placeholder }]} />)
          : (
            <>
              {slots.map(it => (
                <Pressable key={it.id} onPress={onOpen} style={st.albumCell} accessibilityRole="imagebutton" accessibilityLabel={it.caption || t('family.album.title')}>
                  <Image source={{ uri: it.url }} style={[StyleSheet.absoluteFill, { borderRadius: 12, backgroundColor: c.placeholder }]} contentFit="cover" transition={150} recyclingKey={String(it.id)} />
                </Pressable>
              ))}
              {showAdd && (
                <Pressable onPress={data.addPhoto} disabled={data.uploading} style={[st.albumCell, st.albumAdd, { borderColor: c.tertiary }]} accessibilityRole="button" accessibilityLabel={t('family.album.add')}>
                  {data.uploading ? <ActivityIndicator color={c.secondary} /> : <IconPlus size={22} color={c.secondary} />}
                </Pressable>
              )}
              {Array.from({ length: Math.max(0, 4 - slots.length - (showAdd ? 1 : 0)) }).map((_, i) => <View key={'sp' + i} style={st.albumCell} />)}
            </>
          )}
      </View>
      {items != null && items.length === 0 && <Text style={[st.empty, { color: c.secondary, paddingTop: 0 }]}>{t('family.album.empty')}</Text>}
    </Card>
  );
}

// ── Prévia: próximo evento ────────────────────────────────────────────────
function useFmt() {
  const { language } = useLanguage();
  const loc = language || 'pt-BR';
  return useMemo(() => ({
    month: (d) => { try { return d.toLocaleDateString(loc, { month: 'short' }).replace('.', '').toUpperCase(); } catch { return pad2(d.getMonth() + 1); } },
    weekday: (d) => { try { return d.toLocaleDateString(loc, { weekday: 'long' }); } catch { return ''; } },
    time: (d) => { try { return d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' }); } catch { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; } },
  }), [loc]);
}

export function EventRow({ ev, last, muted }) {
  const c = useFamilyColors();
  const { t } = useLanguage();
  const f = useFmt();
  const d = ev.when;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dd = d ? new Date(d.getFullYear(), d.getMonth(), d.getDate()) : null;
  const dayDiff = dd ? Math.round((dd - today) / 86400000) : null;
  const dayLabel = dayDiff === 0 ? t('family.hub.today') : dayDiff === 1 ? t('family.hub.tomorrow') : (d ? f.weekday(d) : '');
  const sub = [dayLabel, d && hasTime(ev.raw) ? f.time(d) : '', ev.location].filter(Boolean).join(' · ');
  return (
    <View style={[st.evRow, { opacity: muted ? 0.55 : 1 }]}>
      <View style={[st.evDate, { backgroundColor: c.chip }]}>
        <Text style={[st.evMonth, { color: c.secondary }]}>{d ? f.month(d) : '—'}</Text>
        <Text style={[st.evDay, { color: c.text }]}>{d ? d.getDate() : '?'}</Text>
      </View>
      <View style={[st.evBody, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.separator }]}>
        <Text style={[st.itemText, { color: c.text, fontWeight: '600' }]} numberOfLines={1}>{ev.title}</Text>
        {!!sub && <Text style={{ color: c.secondary, fontSize: 14, marginTop: 2 }} numberOfLines={1}>{sub}</Text>}
      </View>
    </View>
  );
}

export function NextEventPreview({ data, onOpen, onAdd }) {
  const c = useFamilyColors();
  const { t } = useLanguage();
  const next = data.upcoming ? data.upcoming[0] : undefined;
  const more = data.upcoming ? Math.max(0, data.upcoming.length - 1) : 0;
  return (
    <Card>
      <CardHeader Icon={IconCalendar} title={t('family.hub.nextEvent')} meta={more ? t('family.hub.moreN', { n: more }) : ''} onPress={onOpen} actionLabel={t('family.hub.seeAll')} />
      {data.upcoming == null ? (
        <View style={{ paddingVertical: 14 }}><ActivityIndicator color={c.secondary} /></View>
      ) : next ? (
        <EventRow ev={next} last />
      ) : (
        <Pressable onPress={onAdd} accessibilityRole="button" style={({ pressed }) => [st.itemRow, pressed && { backgroundColor: c.chip }]}>
          <View style={[st.addPlus, { backgroundColor: c.chip, marginLeft: 2 }]}><IconPlus size={14} color={c.secondary} /></View>
          <Text style={{ color: c.secondary, fontSize: 16, marginLeft: 12, paddingVertical: 12 }}>{t('family.hub.noEvents')}</Text>
        </Pressable>
      )}
    </Card>
  );
}

// ── Corpos das folhas "Ver tudo" ──────────────────────────────────────────
export function SheetTitle({ title, sub }) {
  const c = useFamilyColors();
  return (
    <View style={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 10 }}>
      <Text style={{ fontSize: 22, fontWeight: '700', color: c.text, letterSpacing: -0.3 }} accessibilityRole="header">{title}</Text>
      {!!sub && <Text style={{ fontSize: 15, color: c.secondary, marginTop: 4, lineHeight: 20 }}>{sub}</Text>}
    </View>
  );
}

export function ShoppingSheetBody({ data }) {
  const c = useFamilyColors();
  const { t } = useLanguage();
  const items = data.shopping || [];
  const open = items.filter(x => !x.checked);
  const done = items.filter(x => x.checked);
  return (
    <View>
      <SheetTitle title={t('family.shopping.title')} sub={t('family.shopping.sub')} />
      <View style={{ backgroundColor: c.cardBg, borderRadius: 16, marginHorizontal: 16, overflow: 'hidden' }}>
        <ShoppingAddRow onAdd={data.addItem} />
      </View>
      <ScrollView style={{ maxHeight: 440 }} contentContainerStyle={{ paddingBottom: 8 }} keyboardShouldPersistTaps="handled">
        {items.length === 0 && <Text style={[st.empty, { color: c.secondary, paddingHorizontal: 20 }]}>{t('family.shopping.empty')}</Text>}
        {open.length > 0 && (
          <View style={{ backgroundColor: c.cardBg, borderRadius: 16, marginHorizontal: 16, marginTop: 12, overflow: 'hidden' }}>
            {open.map((it, i) => <ShoppingRow key={it.id} item={it} onToggle={data.toggleItem} last={i === open.length - 1} />)}
          </View>
        )}
        {done.length > 0 && (
          <>
            <Text style={[st.groupLabel, { color: c.header }]}>{t('family.hub.doneN', { n: done.length })}</Text>
            <View style={{ backgroundColor: c.cardBg, borderRadius: 16, marginHorizontal: 16, overflow: 'hidden' }}>
              {done.map((it, i) => <ShoppingRow key={it.id} item={it} onToggle={data.toggleItem} last={i === done.length - 1} />)}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

export function AlbumSheetBody({ data }) {
  const c = useFamilyColors();
  const { t } = useLanguage();
  const { width } = useWindowDimensions();
  const [focus, setFocus] = useState(null);
  const items = data.album || [];
  const W = Math.min(width, 640) - 32;
  const cell = Math.floor((W - 8) / 3);
  return (
    <View>
      <SheetTitle title={t('family.album.title')} sub={t('family.album.sub')} />
      {!!focus && (
        <Pressable onPress={() => setFocus(null)} style={{ marginHorizontal: 16, marginBottom: 10 }} accessibilityRole="button" accessibilityLabel={t('common.close')}>
          <Image source={{ uri: focus.url }} style={{ width: W, height: W * 0.75, borderRadius: 16, backgroundColor: c.placeholder }} contentFit="cover" transition={150} />
        </Pressable>
      )}
      <ScrollView style={{ maxHeight: 460 }} contentContainerStyle={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, paddingHorizontal: 16, paddingBottom: 8 }}>
        <Pressable onPress={data.addPhoto} disabled={data.uploading} style={[{ width: cell, height: cell, borderRadius: 10 }, st.albumAdd, { borderColor: c.tertiary }]} accessibilityRole="button" accessibilityLabel={t('family.album.add')}>
          {data.uploading ? <ActivityIndicator color={c.secondary} /> : <IconPlus size={24} color={c.secondary} />}
        </Pressable>
        {items.map(it => (
          <Pressable key={it.id} onPress={() => { try { haptic.select(); } catch {} setFocus(it); }} accessibilityRole="imagebutton" accessibilityLabel={it.caption || t('family.album.title')}>
            <Image source={{ uri: it.url }} style={{ width: cell, height: cell, borderRadius: 10, backgroundColor: c.placeholder }} contentFit="cover" transition={150} recyclingKey={String(it.id)} />
          </Pressable>
        ))}
      </ScrollView>
      {items.length === 0 && <Text style={[st.empty, { color: c.secondary, paddingHorizontal: 20 }]}>{t('family.album.empty')}</Text>}
    </View>
  );
}

export function CalendarSheetBody({ data, startAdding = false }) {
  const c = useFamilyColors();
  const { t } = useLanguage();
  const [adding, setAdding] = useState(!!startAdding);
  const [title, setTitle] = useState('');
  const [day, setDay] = useState('today'); // today | tomorrow | custom
  const [custom, setCustom] = useState('');
  const [time, setTime] = useState('');
  const [saving, setSaving] = useState(false);

  const all = data.events || [];
  const upcoming = data.upcoming || [];
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  const past = all.filter(e => e.when && e.when < startToday).sort((a, b) => b.when - a.when).slice(0, 5);

  const resolveDate = () => {
    const base = new Date(); base.setHours(0, 0, 0, 0);
    if (day === 'today') return base;
    if (day === 'tomorrow') { base.setDate(base.getDate() + 1); return base; }
    const m = custom.trim().match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/);
    const iso = custom.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    let y, mo, d;
    if (iso) { y = +iso[1]; mo = +iso[2]; d = +iso[3]; }
    else if (m) { d = +m[1]; mo = +m[2]; y = m[3] ? +m[3] : base.getFullYear(); if (y < 100) y += 2000; }
    else return null;
    const out = new Date(y, mo - 1, d);
    if (out.getMonth() !== mo - 1 || out.getDate() !== d) return null;
    if (!m?.[3] && !iso && out < base) out.setFullYear(out.getFullYear() + 1); // "25/12" já passou → ano que vem
    return out;
  };

  const save = async () => {
    const tt = title.trim();
    if (!tt) { Alert.alert(t('eventDetail.title'), t('family.event.needTitle')); return; }
    const date = resolveDate();
    if (!date) { Alert.alert(t('eventDetail.title'), t('family.hub.badDate')); return; }
    let hh = 0, mm = 0;
    if (time.trim()) {
      const tm = time.trim().match(/^(\d{1,2})(?::|h)?(\d{2})?$/i);
      if (!tm || +tm[1] > 23 || +(tm[2] || 0) > 59) { Alert.alert(t('eventDetail.title'), t('family.hub.badTime')); return; }
      hh = +tm[1]; mm = +(tm[2] || 0);
    }
    setSaving(true);
    const ok = await data.addEvent({ title: tt, startsAt: toStartsAt(date, hh, mm) });
    setSaving(false);
    if (ok) { setAdding(false); setTitle(''); setCustom(''); setTime(''); setDay('today'); }
  };

  const chip = (key, label) => {
    const on = day === key;
    return (
      <Pressable key={key} onPress={() => { try { haptic.select(); } catch {} setDay(key); }} accessibilityRole="radio" accessibilityState={{ checked: on }}
        style={[st.chip, { backgroundColor: on ? c.chipOn : c.chip }]}>
        <Text style={{ color: on ? c.onChipOn : c.text, fontWeight: '600', fontSize: 14 }}>{label}</Text>
      </Pressable>
    );
  };

  return (
    <View>
      <SheetTitle title={t('family.calendar.title')} sub={t('family.calendar.sub')} />
      {adding ? (
        <View style={{ backgroundColor: c.cardBg, borderRadius: 16, marginHorizontal: 16, padding: 14 }}>
          <TextInput value={title} onChangeText={setTitle} placeholder={t('eventDetail.titleField')} placeholderTextColor={c.secondary} autoFocus
            style={[st.field, { color: c.text, backgroundColor: c.chip }]} maxLength={200} />
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            {chip('today', t('family.hub.today'))}
            {chip('tomorrow', t('family.hub.tomorrow'))}
            {chip('custom', t('family.hub.otherDay'))}
          </View>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
            {day === 'custom' && (
              <TextInput value={custom} onChangeText={setCustom} placeholder={t('family.hub.datePh')} placeholderTextColor={c.secondary} keyboardType="numbers-and-punctuation"
                style={[st.field, { flex: 1, color: c.text, backgroundColor: c.chip }]} maxLength={10} />
            )}
            <TextInput value={time} onChangeText={setTime} placeholder={t('family.hub.timePh')} placeholderTextColor={c.secondary} keyboardType="numbers-and-punctuation"
              style={[st.field, { flex: 1, color: c.text, backgroundColor: c.chip }]} maxLength={5} />
          </View>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
            <Pressable onPress={() => setAdding(false)} style={[st.btn, { backgroundColor: c.chip }]} accessibilityRole="button">
              <Text style={{ color: c.text, fontWeight: '600', fontSize: 16 }}>{t('common.cancel')}</Text>
            </Pressable>
            <Pressable onPress={save} disabled={saving} style={[st.btn, { backgroundColor: c.pill, opacity: saving ? 0.6 : 1 }]} accessibilityRole="button">
              {saving ? <ActivityIndicator color={c.onPill} /> : <Text style={{ color: c.onPill, fontWeight: '600', fontSize: 16 }}>{t('common.save')}</Text>}
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable onPress={() => setAdding(true)} accessibilityRole="button" style={({ pressed }) => [{ backgroundColor: c.cardBg, borderRadius: 16, marginHorizontal: 16, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14 }, pressed && { opacity: 0.7 }]}>
          <IconPlus size={18} color={c.text} />
          <Text style={{ color: c.text, fontWeight: '600', fontSize: 16, marginLeft: 10 }}>{t('one.newEvent')}</Text>
        </Pressable>
      )}
      <ScrollView style={{ maxHeight: 380 }} contentContainerStyle={{ paddingBottom: 8 }} keyboardShouldPersistTaps="handled">
        {upcoming.length === 0 && !adding && <Text style={[st.empty, { color: c.secondary, paddingHorizontal: 20 }]}>{t('family.event.empty')}</Text>}
        {upcoming.length > 0 && (
          <>
            <Text style={[st.groupLabel, { color: c.header }]}>{t('family.hub.upcoming')}</Text>
            <View style={{ backgroundColor: c.cardBg, borderRadius: 16, marginHorizontal: 16, overflow: 'hidden' }}>
              {upcoming.map((ev, i) => <EventRow key={ev.id} ev={ev} last={i === upcoming.length - 1} />)}
            </View>
          </>
        )}
        {past.length > 0 && (
          <>
            <Text style={[st.groupLabel, { color: c.header }]}>{t('family.hub.past')}</Text>
            <View style={{ backgroundColor: c.cardBg, borderRadius: 16, marginHorizontal: 16, overflow: 'hidden' }}>
              {past.map((ev, i) => <EventRow key={ev.id} ev={ev} muted last={i === past.length - 1} />)}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  cardHead: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingTop: 13, paddingBottom: 9, gap: 10 },
  headIcon: { width: 26, height: 26, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  headTitle: { fontSize: 17, fontWeight: '600', flexShrink: 1, letterSpacing: -0.2 },
  headMeta: { fontSize: 15, flex: 1, textAlign: 'right' },
  check: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.6, alignItems: 'center', justifyContent: 'center' },
  itemRow: { flexDirection: 'row', alignItems: 'center', paddingLeft: 16 },
  itemBody: { flex: 1, flexDirection: 'row', alignItems: 'center', marginLeft: 12, paddingVertical: 12, paddingRight: 16, minHeight: 46 },
  itemText: { fontSize: 16, flex: 1 },
  addRow: { flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 10, minHeight: 48 },
  addPlus: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  addInput: { flex: 1, fontSize: 16, marginLeft: 12, paddingVertical: Platform.OS === 'ios' ? 13 : 9 },
  addBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999 },
  empty: { fontSize: 15, paddingHorizontal: 16, paddingVertical: 12, lineHeight: 20 },
  albumRow: { flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingBottom: 12 },
  albumCell: { flex: 1, aspectRatio: 1, borderRadius: 12, overflow: 'hidden' },
  albumAdd: { borderWidth: 1.2, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center' },
  evRow: { flexDirection: 'row', alignItems: 'center', paddingLeft: 14 },
  evDate: { width: 46, height: 50, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  evMonth: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  evDay: { fontSize: 20, fontWeight: '700', marginTop: -1 },
  evBody: { flex: 1, marginLeft: 12, paddingVertical: 13, paddingRight: 16 },
  groupLabel: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.3, marginHorizontal: 20, marginTop: 18, marginBottom: 7 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
  field: { borderRadius: 12, paddingHorizontal: 14, paddingVertical: Platform.OS === 'ios' ? 13 : 10, fontSize: 16 },
  btn: { flex: 1, borderRadius: 999, paddingVertical: 13, alignItems: 'center', justifyContent: 'center' },
});
