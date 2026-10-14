// [2026-10-14 busca-global] Aba "Mensagens" da busca global (app/search.js):
// busca em TODAS as conversas por texto + TIPO (Fotos, Vídeos, Links, Áudio,
// Documentos, Enquetes) + intervalo de DATAS, como o WhatsApp. Backend:
// chat_search_advanced (paginação por cursor). Resultados agrupados por
// conversa com prévia/miniatura; tocar abre a conversa já NA mensagem
// (scrollToMessageId/highlightMessageId — mesmo salto da busca da lista).
// Os chips usam o MESMO estilo das pílulas de aba da tela (pillStyle vem do
// search.js), então ajuste visual lá vale aqui também.
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, ScrollView, ActivityIndicator, Modal, Pressable, StyleSheet } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import FastImage from './FastImage';
import AvatarCircle from './AvatarCircle';
import { DateTimePickerModal } from './ScheduleModals';
import { IconSearch, IconImage, IconVideo, IconLink, IconMic, IconFileText, IconBarChart, IconCalendar, IconX, IconPlay } from './Icons';
import { useAuth } from '../context/AuthContext';
import * as api from '../services/api';

const KINDS = [
  { key: 'photo', labelKey: 'gsearch.photos', fallback: 'Fotos', Icon: IconImage },
  { key: 'video', labelKey: 'gsearch.videos', fallback: 'Vídeos', Icon: IconVideo },
  { key: 'link', labelKey: 'gsearch.links', fallback: 'Links', Icon: IconLink },
  { key: 'audio', labelKey: 'gsearch.audio', fallback: 'Áudio', Icon: IconMic },
  { key: 'doc', labelKey: 'gsearch.docs', fallback: 'Documentos', Icon: IconFileText },
  { key: 'poll', labelKey: 'gsearch.polls', fallback: 'Enquetes', Icon: IconBarChart },
];
const KIND_ICON = { photo: IconImage, video: IconVideo, link: IconLink, audio: IconMic, doc: IconFileText, poll: IconBarChart, text: IconSearch };

const DATE_PRESETS = [
  { key: 'today', labelKey: 'gsearch.today', fallback: 'Hoje', days: 0 },
  { key: 'last7', labelKey: 'gsearch.last7', fallback: 'Últimos 7 dias', days: 6 },
  { key: 'last30', labelKey: 'gsearch.last30', fallback: 'Últimos 30 dias', days: 29 },
  { key: 'year', labelKey: 'gsearch.thisYear', fallback: 'Este ano', year: true },
];

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function parseTs(s) {
  if (!s) return null;
  let v = String(s);
  if (/^\d{4}-\d{2}-\d{2} \d/.test(v)) v = v.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(v)) v += 'Z';
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
function fmtDuration(sec) {
  const n = Math.max(0, Math.round(Number(sec) || 0));
  if (!n) return '';
  return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0');
}

export default function GlobalMessageSearch({ query, colors, isDark, t, router, pillStyle }) {
  const { user } = useAuth();
  const me = String(user?.email || '').toLowerCase();
  const loc = (t && t('_locale')) || undefined;
  const tt = useCallback((k, fb) => { const v = t ? t(k) : ''; return v && v !== k ? v : fb; }, [t]);

  const [kind, setKind] = useState(null);
  const [range, setRange] = useState(null); // { from: Date, to: Date, key }
  const [rows, setRows] = useState([]);
  const [convs, setConvs] = useState({});
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [dateSheet, setDateSheet] = useState(false);
  const [pick, setPick] = useState(null); // 'from' | 'to'
  const [customFrom, setCustomFrom] = useState(null);
  const reqRef = useRef(0);
  const debRef = useRef(null);

  const q = String(query || '').trim();
  const active = !!kind || !!range || q.length >= 2;

  const fetchPage = useCallback(async (cur) => {
    const myReq = cur ? reqRef.current : ++reqRef.current;
    if (cur) setLoadingMore(true); else { setLoading(true); setError(false); }
    try {
      const r = await api.chatSearchAdvanced({
        query: q, types: kind ? [kind] : [], dateFrom: range?.from, dateTo: range?.to, cursor: cur || undefined,
      });
      if (myReq !== reqRef.current) return;
      if (!r?.success) { if (!cur) { setRows([]); setError(true); } return; }
      const d = r.data || {};
      const msgs = Array.isArray(d.messages) ? d.messages : [];
      const cv = d.conversations && typeof d.conversations === 'object' ? d.conversations : {};
      setConvs((prev) => (cur ? { ...prev, ...cv } : cv));
      setRows((prev) => {
        if (!cur) return msgs;
        const seen = new Set(prev.map((m) => m.id));
        return prev.concat(msgs.filter((m) => !seen.has(m.id)));
      });
      setHasMore(!!d.has_more && !!d.next_cursor);
      setCursor(d.next_cursor || null);
    } catch {
      if (myReq === reqRef.current && !cur) { setRows([]); setError(true); }
    } finally {
      if (myReq === reqRef.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [q, kind, range]);

  // Debounce 350ms (mesmo da tela) — texto, tipo ou data mudou → página 1.
  useEffect(() => {
    if (debRef.current) clearTimeout(debRef.current);
    if (!active) {
      reqRef.current++;
      setRows([]); setConvs({}); setHasMore(false); setCursor(null); setLoading(false); setError(false);
      return undefined;
    }
    debRef.current = setTimeout(() => { fetchPage(null); }, q.length >= 2 ? 350 : 0);
    return () => { if (debRef.current) clearTimeout(debRef.current); };
  }, [active, fetchPage]);

  const loadMore = useCallback(() => {
    if (!hasMore || loading || loadingMore || !cursor) return;
    fetchPage(cursor);
  }, [hasMore, loading, loadingMore, cursor, fetchPage]);

  // Agrupa por conversa (ordem = 1ª aparição; resultados já vêm do mais novo).
  const items = useMemo(() => {
    const order = [];
    const by = new Map();
    for (const m of rows) {
      const k = String(m.conversation_id);
      if (!by.has(k)) { by.set(k, []); order.push(k); }
      by.get(k).push(m);
    }
    const out = [];
    for (const k of order) {
      const list = by.get(k);
      out.push({ _t: 'h', id: 'h' + k, cid: k, count: list.length, first: list[0] });
      for (const m of list) out.push({ _t: 'm', id: 'm' + m.id, m });
    }
    return out;
  }, [rows]);

  const convMeta = useCallback((cid, m) => {
    const c = convs[String(cid)] || {};
    const type = c.type || m?.conv_type || 'direct';
    const peer = c.peer_email || m?.peer_email || '';
    let name = c.name || m?.conv_name || '';
    const saved = type === 'saved' || (type === 'direct' && peer && peer.toLowerCase() === me);
    if (saved) name = tt('chat.savedMessages', 'Mensagens salvas');
    if (!name) name = peer ? peer.split('@')[0] : '';
    return { type, peer, name, avatar: c.avatar_url || null };
  }, [convs, me, tt]);

  const openHit = useCallback((m) => {
    const meta = convMeta(m.conversation_id, m);
    try {
      require('../services/openConversation').openConversation({
        pathname: '/chat-conversation',
        params: {
          id: String(m.conversation_id),
          name: meta.name || '',
          type: meta.type,
          ...(meta.type === 'direct' && meta.peer ? { email: meta.peer } : {}),
          scrollToMessageId: String(m.id),
          highlightMessageId: String(m.id),
        },
      }, { router });
    } catch {}
  }, [convMeta, router]);

  const fmtDate = useCallback((s) => {
    const d = parseTs(s);
    if (!d) return '';
    const now = new Date();
    if (startOfDay(d).getTime() === startOfDay(now).getTime()) {
      try { return d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
    }
    try {
      return d.toLocaleDateString(loc, d.getFullYear() === now.getFullYear()
        ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
    } catch { return d.toISOString().slice(0, 10); }
  }, [loc]);

  const rangeLabel = useMemo(() => {
    if (!range) return tt('gsearch.date', 'Data');
    const p = DATE_PRESETS.find((x) => x.key === range.key);
    if (p) return tt(p.labelKey, p.fallback);
    const o = { day: 'numeric', month: 'short' };
    try { return `${range.from.toLocaleDateString(loc, o)} – ${range.to.toLocaleDateString(loc, o)}`; } catch { return tt('gsearch.custom', 'Personalizado'); }
  }, [range, loc, tt]);

  const applyPreset = (p) => {
    const to = startOfDay(new Date());
    let from;
    if (p.year) { from = new Date(to.getFullYear(), 0, 1); }
    else { from = new Date(to); from.setDate(to.getDate() - p.days); }
    setRange({ from, to, key: p.key });
    setDateSheet(false);
  };

  const pillBase = pillStyle || styles.pillFallback;
  const pillColors = (on) => ({
    backgroundColor: on ? colors.primary : 'transparent',
    borderColor: on ? colors.primary : (isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.10)'),
  });
  const pillText = (on) => ({ color: on ? colors.onPrimary : colors.text, fontWeight: on ? '600' : '500', fontSize: 13 });
  const sub = colors.textSecondary;
  const tile = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)';

  const renderThumb = (m) => {
    const k = m.kind || 'text';
    let uri = '';
    if (k === 'photo' || k === 'video') {
      if (m.thumb_b64) uri = String(m.thumb_b64).startsWith('data:') ? m.thumb_b64 : `data:image/jpeg;base64,${m.thumb_b64}`;
      else if (m.thumbnail_url) uri = api.getMediaUrl(m.thumbnail_url);
      else if (k === 'photo' && m.file_url) uri = api.getMediaUrl(m.file_url);
    }
    if (uri) {
      return (
        <View style={styles.thumb}>
          <FastImage source={{ uri }} style={styles.thumbImg} recyclingKey={String(m.id)} />
          {k === 'video' ? (
            <View style={styles.playBadge}><IconPlay size={12} color="#fff" /></View>
          ) : null}
        </View>
      );
    }
    const Ico = KIND_ICON[k] || IconSearch;
    return (
      <View style={[styles.thumb, { backgroundColor: tile, alignItems: 'center', justifyContent: 'center' }]}>
        <Ico size={20} color={colors.text} />
      </View>
    );
  };

  const previewText = (m) => {
    const k = m.kind || 'text';
    const content = String(m.content || '').replace(/\s+/g, ' ').trim();
    if (k === 'audio') return [tt('gsearch.audio', 'Áudio'), fmtDuration(m.duration)].filter(Boolean).join(' · ');
    if (k === 'doc') return m.file_name || content || tt('gsearch.docs', 'Documentos');
    if (k === 'poll') return content ? `${tt('chat.poll', 'Enquete')}: ${content}` : tt('chat.poll', 'Enquete');
    if (k === 'photo' || k === 'video') return content || m.file_name || (k === 'photo' ? tt('chat.photo', 'Foto') : tt('gsearch.videos', 'Vídeos'));
    if (k === 'link') return content || m.link_url || '';
    return content;
  };

  const renderItem = ({ item }) => {
    if (item._t === 'h') {
      const meta = convMeta(item.cid, item.first);
      return (
        <View style={styles.header}>
          <AvatarCircle name={meta.name} email={meta.type === 'direct' ? meta.peer : undefined} uri={meta.avatar || undefined} size={26} />
          <Text style={[styles.headerText, { color: colors.text }]} numberOfLines={1}>{meta.name}</Text>
          <Text style={{ color: sub, fontSize: 12 }}>{item.count}{hasMore ? '+' : ''}</Text>
        </View>
      );
    }
    const m = item.m;
    const own = String(m.sender_email || '').toLowerCase() === me;
    const meta = convMeta(m.conversation_id, m);
    const who = own ? tt('gsearch.you', 'Você') : (meta.type === 'direct' ? '' : (m.sender_name || ''));
    return (
      <TouchableOpacity
        style={[styles.row, { backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : colors.surface }]}
        activeOpacity={0.75}
        onPress={() => openHit(m)}
        accessibilityRole="button"
        accessibilityLabel={`${meta.name}: ${previewText(m)}`}
      >
        {renderThumb(m)}
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ flex: 1, color: sub, fontSize: 12 }} numberOfLines={1}>{who}</Text>
            <Text style={{ color: sub, fontSize: 12 }}>{fmtDate(m.created_at)}</Text>
          </View>
          <Text style={{ color: colors.text, fontSize: 14 }} numberOfLines={2}>{previewText(m)}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  const empty = (() => {
    if (loading) return null;
    if (error) {
      return (
        <TouchableOpacity onPress={() => fetchPage(null)} style={styles.empty} accessibilityRole="button">
          <Text style={{ color: sub, fontSize: 14, textAlign: 'center' }}>{tt('gsearch.error', 'Não foi possível buscar. Toque para tentar de novo.')}</Text>
        </TouchableOpacity>
      );
    }
    return (
      <View style={styles.empty}>
        <View style={[styles.emptyIcon, { backgroundColor: tile }]}>
          <IconSearch size={26} color={sub} />
        </View>
        <Text style={{ color: sub, fontSize: 14, textAlign: 'center', lineHeight: 20 }}>
          {active ? tt('gsearch.empty', 'Nenhuma mensagem encontrada') : tt('gsearch.hint', 'Digite para buscar ou toque em um tipo')}
        </Text>
      </View>
    );
  })();

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}
        style={{ flexGrow: 0, flexShrink: 0, maxHeight: 52 }}
        keyboardShouldPersistTaps="handled"
      >
        <TouchableOpacity
          onPress={() => setDateSheet(true)}
          style={[pillBase, pillColors(!!range), styles.pillRow]}
          activeOpacity={0.75}
          accessibilityRole="button"
          accessibilityLabel={rangeLabel}
          accessibilityState={{ selected: !!range }}
        >
          <IconCalendar size={14} color={range ? colors.onPrimary : colors.text} />
          <Text numberOfLines={1} style={pillText(!!range)}>{rangeLabel}</Text>
          {range ? (
            <TouchableOpacity onPress={() => setRange(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityLabel={tt('gsearch.anyDate', 'Qualquer data')}>
              <IconX size={14} color={colors.onPrimary} />
            </TouchableOpacity>
          ) : null}
        </TouchableOpacity>
        {KINDS.map((k) => {
          const on = kind === k.key;
          return (
            <TouchableOpacity
              key={k.key}
              onPress={() => setKind(on ? null : k.key)}
              style={[pillBase, pillColors(on), styles.pillRow]}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel={tt(k.labelKey, k.fallback)}
              accessibilityState={{ selected: on }}
            >
              <k.Icon size={14} color={on ? colors.onPrimary : colors.text} />
              <Text numberOfLines={1} style={pillText(on)}>{tt(k.labelKey, k.fallback)}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {loading ? (
        <View style={{ paddingVertical: 10 }}><ActivityIndicator size="small" color={sub} /></View>
      ) : null}

      <FlashList
        data={items}
        keyExtractor={(it) => it.id}
        getItemType={(it) => it._t}
        renderItem={renderItem}
        contentContainerStyle={{ padding: 12 }}
        keyboardShouldPersistTaps="handled"
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={empty}
        ListFooterComponent={loadingMore ? <View style={{ paddingVertical: 14 }}><ActivityIndicator size="small" color={sub} /></View> : null}
      />

      <Modal visible={dateSheet} transparent animationType="fade" onRequestClose={() => setDateSheet(false)}>
        <Pressable style={styles.overlay} onPress={() => setDateSheet(false)}>
          <Pressable style={[styles.sheet, { backgroundColor: colors.surface }]} onPress={() => {}}>
            <Text style={[styles.sheetTitle, { color: colors.text }]}>{tt('gsearch.date', 'Data')}</Text>
            {[{ key: 'any', labelKey: 'gsearch.anyDate', fallback: 'Qualquer data' }, ...DATE_PRESETS, { key: 'custom', labelKey: 'gsearch.custom', fallback: 'Personalizado' }].map((p) => {
              const on = p.key === 'any' ? !range : (range && (range.key === p.key || (p.key === 'custom' && !DATE_PRESETS.some((x) => x.key === range.key))));
              return (
                <TouchableOpacity
                  key={p.key}
                  style={styles.sheetRow}
                  onPress={() => {
                    if (p.key === 'any') { setRange(null); setDateSheet(false); }
                    else if (p.key === 'custom') { setDateSheet(false); setPick('from'); }
                    else applyPreset(p);
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: !!on }}
                >
                  <Text style={{ flex: 1, color: colors.text, fontSize: 15, fontWeight: on ? '600' : '400' }}>{tt(p.labelKey, p.fallback)}</Text>
                  {on ? <View style={[styles.dot, { backgroundColor: colors.primary }]} /> : null}
                </TouchableOpacity>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Personalizado: "De" (até 2 anos atrás) e depois "Até" (a partir do "De" até hoje). */}
      <DateTimePickerModal
        visible={pick === 'from'}
        mode="date"
        title={tt('gsearch.from', 'De')}
        listStart={(() => { const d = startOfDay(new Date()); d.setDate(d.getDate() - 730); return d; })()}
        initial={(() => { const d = startOfDay(new Date()); d.setDate(d.getDate() - 30); return d; })()}
        dayCount={731}
        colors={colors}
        t={t}
        onClose={() => setPick((p) => (p === 'from' ? null : p))}
        onConfirm={(d) => { setCustomFrom(startOfDay(d)); setTimeout(() => setPick('to'), 250); }}
      />
      <DateTimePickerModal
        visible={pick === 'to' && !!customFrom}
        mode="date"
        title={tt('gsearch.to', 'Até')}
        listStart={customFrom || undefined}
        initial={startOfDay(new Date())}
        dayCount={customFrom ? Math.max(1, Math.round((startOfDay(new Date()) - customFrom) / 86400000) + 1) : 1}
        colors={colors}
        t={t}
        onClose={() => setPick(null)}
        onConfirm={(d) => {
          const to = startOfDay(d);
          const from = customFrom && customFrom <= to ? customFrom : to;
          setRange({ from, to, key: 'custom' });
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
  pillFallback: {
    flexShrink: 0, flexGrow: 0, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center',
  },
  pillRow: { flexDirection: 'row', gap: 6 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4, paddingTop: 10, paddingBottom: 6 },
  headerText: { flex: 1, fontSize: 14, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 10, borderRadius: 12, marginBottom: 6 },
  thumb: { width: 48, height: 48, borderRadius: 8, overflow: 'hidden' },
  thumbImg: { width: 48, height: 48 },
  playBadge: {
    position: 'absolute', right: 4, bottom: 4, width: 20, height: 20, borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center',
  },
  empty: { alignItems: 'center', paddingTop: 72, paddingHorizontal: 32, gap: 12 },
  emptyIcon: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 28 },
  sheetTitle: { fontSize: 16, fontWeight: '700', marginBottom: 6, textAlign: 'center' },
  sheetRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
