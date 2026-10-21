// app/listen-catalog.js — [assistir-junto 2026-10-20 separação] "Ouvir junto": tela PRÓPRIA de música
// (cara de app de música, P&B premium). Nada de vídeo aqui; o "Assistir junto" é app/watch-catalog.js.
//   topo "Ouvir junto com {nome}" · busca · gêneros em cartões grandes · prateleiras de capas quadradas
//   (Em alta · Lo-fi para relaxar · Clássicos) · lista de faixas (capa, artista, duração, "+ fila") ·
//   "Da conversa" só com áudios. Tocar → começa a sessão e abre direto a sala de música.
// Fonte: watch_catalog (tab musica = Jamendo CC + Musopen domínio público; tab conv chip audios).
// Params: cid, name, mode ('add' = veio da sala → só fila).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Image, TextInput, ActivityIndicator, Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import * as WT from '../services/watchTogether';
import { IconPlayFill, IconHeadphones, SourceIcon } from '../components/watch/WatchIcons';
import { IconArrowLeft, IconSearch, IconPlus, IconCheck, IconX, IconMusic } from '../components/Icons';

import { a11yLabel } from '../utils/a11yLabel'; // [2026-10-20 a11y] rótulos dos botões só-ícone
// gêneros (chip do servidor → Jamendo fuzzytags). Tons P&B diferentes por cartão.
const GENRES = [
  ['lofi', 'Lo-fi', '#1c1c1e'], ['pop', 'Pop', '#3a3a3c'], ['eletronica', 'Eletrônica', '#0b0b0c'], ['jazz', 'Jazz', '#48484a'],
  ['rock', 'Rock', '#2c2c2e'], ['acustica', 'Acústica', '#636366'], ['classica', 'Clássica', '#000000'],
];
function deviceCountry() {
  try { const m = String(Intl.DateTimeFormat().resolvedOptions().locale || '').match(/[-_]([A-Z]{2})\b/); return m ? m[1] : ''; } catch { return ''; }
}
const _cache = new Map();
async function fetchTab(params) {
  const key = JSON.stringify(params);
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.data;
  const r = await WT.catalog(params);
  if (r && !r.error) _cache.set(key, { at: Date.now(), data: r });
  return r;
}

export default function ListenCatalog() {
  const params = useLocalSearchParams();
  const cid = String(params.cid || '');
  const convName = String(params.name || '');
  const addMode = params.mode === 'add';
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const country = useMemo(deviceCountry, []);
  const [hot, setHot] = useState(null);
  const [lofi, setLofi] = useState(null);
  const [classic, setClassic] = useState(null);
  const [convA, setConvA] = useState(null);
  const [genre, setGenre] = useState(null); // {k, label, items, next}
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [searching, setSearching] = useState(false);
  const [pending, setPending] = useState([]);
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState('');
  const [sess, setSess] = useState(() => WT.getSession(cid));
  const reqN = useRef(0);

  const c = useMemo(() => ({
    bg: isDark ? '#000' : '#fff', card: isDark ? '#1c1c1e' : '#f2f2f7', text: isDark ? '#f5f5f7' : '#0b0b0c',
    muted: colors.textSecondary || '#8a8a8f', line: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
    accent: isDark ? '#f5f5f7' : '#0b0b0c', accentInk: isDark ? '#000' : '#fff', chip: isDark ? '#2c2c2e' : '#ececf1',
  }), [colors, isDark]);

  useEffect(() => {
    if (!cid) return undefined;
    const off = WT.subscribe(cid, setSess);
    WT.refresh(cid).then(setSess).catch(() => {});
    return off;
  }, [cid]);
  useEffect(() => {
    let alive = true;
    const base = { tab: 'musica', country };
    fetchTab({ ...base, chip: '' }).then((r) => alive && setHot(r));
    fetchTab({ ...base, chip: 'lofi' }).then((r) => alive && setLofi(r));
    fetchTab({ ...base, chip: 'classica' }).then((r) => alive && setClassic(r));
    if (cid) fetchTab({ tab: 'conv', chip: 'audios', conversation_id: cid }).then((r) => alive && setConvA(r));
    return () => { alive = false; };
  }, [cid, country]);

  // busca: filtra na hora o que já está na tela; o servidor (Jamendo) confirma 350 ms depois
  useEffect(() => {
    const qq = q.trim();
    if (!qq) { setRes(null); setSearching(false); return undefined; }
    setSearching(true);
    const id = setTimeout(async () => {
      const n = ++reqN.current;
      const r = await fetchTab({ tab: 'musica', q: qq, country });
      if (n !== reqN.current) return;
      setSearching(false);
      setRes((r && r.items) || []);
    }, 350);
    return () => clearTimeout(id);
  }, [q, country]);

  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 2200); };
  const live = WT.isLive(sess) ? sess : null;
  const toItem = (it) => ({
    id: it.id, kind: 'audio', title: it.title, author: it.author, artist: it.artist, dur: it.dur, url: it.url, thumb: it.thumb,
    mime: it.mime, source: it.source, lic: it.lic, lic_url: it.lic_url, credit: it.credit, message_id: it.message_id,
  });
  const inQueue = (it) => (live && live.kind === 'music' ? (live.queue || []) : pending).some((x) => x && x.id === it.id && x.url === it.url);
  const addQ = async (it) => {
    if (inQueue(it)) { flash(WT.tr(t, 'watch.alreadyQueued', '{title} já está na fila', { title: it.title })); return; }
    if (live && live.kind === 'music') {
      const r = await WT.cmd(cid, 'queue_add', { item: toItem(it) });
      flash(r.ok ? WT.tr(t, 'watch.queuedFor', '{title} na fila · todos veem', { title: it.title }) : WT.tr(t, 'watch.queueError', 'Não deu para pôr na fila'));
      return;
    }
    setPending((p) => [...p, toItem(it)]);
    flash(WT.tr(t, 'watch.queuedLocal', '{title} na fila', { title: it.title }));
  };
  const play = async (it) => {
    if (busy) return;
    if (addMode && live && live.kind === 'music') { addQ(it); return; }
    setBusy(it.id);
    const r = await WT.start(cid, 'music', toItem(it), pending.filter((x) => x.id !== it.id));
    setBusy('');
    if (!r.ok) { flash(r.error === 'host_only' ? WT.tr(t, 'watch.hostOnly', 'Só o anfitrião controla') : WT.tr(t, 'watch.startError', 'Não deu para começar. Tente de novo.')); return; }
    setPending([]);
    if (addMode) router.back();
    else router.replace({ pathname: '/watch-room', params: { cid, name: convName } });
  };
  const openGenre = async (k, label) => {
    setGenre({ k, label, items: null, next: null });
    const r = await fetchTab({ tab: 'musica', chip: k, country });
    setGenre((g) => (g && g.k === k ? { ...g, items: (r && r.items) || [], next: r && r.next_cursor, failed: !r || !!r.error } : g));
  };
  const moreGenre = async () => {
    if (!genre || !genre.next) return;
    const r = await fetchTab({ tab: 'musica', chip: genre.k, cursor: genre.next, country });
    setGenre((g) => (g ? { ...g, items: [...(g.items || []), ...((r && r.items) || [])], next: r && r.next_cursor } : g));
  };

  const art = (it, size, radius = 8) => (
    <View style={{ width: size, height: size, borderRadius: radius, overflow: 'hidden', backgroundColor: c.chip, alignItems: 'center', justifyContent: 'center' }}>
      {it.thumb ? <Image source={{ uri: it.thumb }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : <IconMusic size={size * 0.38} color={c.muted} />}
      {busy === it.id ? <View style={st.busy}><ActivityIndicator color="#fff" /></View> : null}
    </View>
  );
  const lic = (it) => (
    <View style={[st.lic, { backgroundColor: c.chip }]}>
      <SourceIcon source={it.source} size={10} color={c.text} />
      <Text style={[st.licTx, { color: c.text }]} numberOfLines={1}>{WT.sourceLabel(t, it)}</Text>
    </View>
  );
  const row = (it, i) => {
    const qd = inQueue(it);
    return (
      <View key={it.id + ':' + i} style={st.row}>
        <Pressable onPress={() => play(it)}>{art(it, 52)}</Pressable>
        <Pressable onPress={() => play(it)} style={{ flex: 1, minWidth: 0 }}>
          <Text style={[st.rowT, { color: c.text }]} numberOfLines={1}>{it.title}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
            <Text style={[st.rowS, { color: c.muted, flexShrink: 1 }]} numberOfLines={1}>{[it.artist || it.author, it.dur ? WT.fmtTime(it.dur) : ''].filter(Boolean).join(' · ')}</Text>
            {lic(it)}
          </View>
        </Pressable>
        <Pressable onPress={() => addQ(it)} hitSlop={6} style={[st.qbtn, { backgroundColor: qd ? c.accent : 'transparent', borderColor: qd ? c.accent : c.line }]}
          accessibilityLabel={WT.tr(t, 'watch.addToQueue', 'Adicionar à fila')}>
          {qd ? <IconCheck size={15} color={c.accentInk} /> : <IconPlus size={15} color={c.text} />}
          <Text style={[st.qbtnTx, { color: qd ? c.accentInk : c.text }]}>{WT.tr(t, 'listen.queueShort', 'Fila')}</Text>
        </Pressable>
      </View>
    );
  };
  const shelf = (title, sub, data) => {
    const items = data && data.items ? data.items.slice(0, 14) : null;
    if (items && !items.length) return null;
    return (
      <View>
        <View style={st.shelfH}>
          <Text style={[st.shelfT, { color: c.text }]}>{title}</Text>
          {sub ? <Text style={[st.shelfS, { color: c.muted }]}>{sub}</Text> : null}
        </View>
        {!items ? <View style={{ height: 190, justifyContent: 'center' }}><ActivityIndicator color={c.muted} /></View> : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} decelerationRate="fast" snapToInterval={154} contentContainerStyle={{ paddingHorizontal: 16, gap: 14 }}>
            {items.map((it) => (
              <Pressable key={it.id} onPress={() => play(it)} style={{ width: 140 }}>
                <View>
                  {art(it, 140, 10)}
                  <Pressable onPress={() => addQ(it)} hitSlop={6} style={[st.addq, inQueue(it) ? { backgroundColor: '#fff' } : null]}>
                    {inQueue(it) ? <IconCheck size={15} color="#000" /> : <IconPlus size={15} color="#fff" />}
                  </Pressable>
                </View>
                <Text style={[st.cardT, { color: c.text }]} numberOfLines={1}>{it.title}</Text>
                <Text style={[st.cardS, { color: c.muted }]} numberOfLines={1}>{it.artist || it.author}</Text>
              </Pressable>
            ))}
          </ScrollView>
        )}
      </View>
    );
  };

  const hotOnly = hot && hot.items ? { ...hot, items: hot.items.filter((x) => x.source === 'jamendo') } : hot;
  const classicPd = classic && classic.items ? { ...classic, items: [...classic.items.filter((x) => x.source === 'pd'), ...classic.items.filter((x) => x.source !== 'pd')] } : classic;
  const jamOff = hot && hot.jamendo === false;
  const qLive = q.trim().toLowerCase();
  const localHits = qLive ? [...((hot && hot.items) || []), ...((lofi && lofi.items) || []), ...((classic && classic.items) || []), ...((convA && convA.items) || [])]
    .filter((it, i, a) => a.findIndex((x) => x.id === it.id) === i)
    .filter((it) => qLive.split(/\s+/).every((w) => [it.title, it.artist, it.author].filter(Boolean).join(' ').toLowerCase().includes(w))) : [];
  const results = qLive ? [...localHits, ...((res || []).filter((x) => !localHits.some((y) => y.id === x.id)))] : null;

  let body;
  if (results) {
    body = (
      <View style={{ paddingTop: 8 }}>
        {results.map(row)}
        {searching ? <ActivityIndicator style={{ marginTop: 16 }} color={c.muted} /> : null}
        {!searching && !results.length ? <Text style={[st.empty, { color: c.muted }]}>{WT.tr(t, 'watch.nothingFound', 'Nada encontrado. Tente outra palavra.')}</Text> : null}
      </View>
    );
  } else if (genre) {
    body = (
      <View>
        <View style={st.genreHead}>
          <Pressable onPress={() => setGenre(null)} style={[st.genrePill, { backgroundColor: c.accent }]}>
            <Text style={{ color: c.accentInk, fontWeight: '700', fontSize: 13 }}>{genre.label}</Text>
            <IconX size={13} color={c.accentInk} />
          </Pressable>
        </View>
        {!genre.items ? <ActivityIndicator style={{ marginTop: 30 }} color={c.muted} /> : genre.items.length ? genre.items.map(row) : (
          <Text style={[st.empty, { color: c.muted }]}>{genre.failed ? WT.tr(t, 'watch.catalogError', 'Não deu para carregar. Tente de novo daqui a pouco.') : WT.tr(t, 'watch.nothingFound', 'Nada encontrado. Tente outra palavra.')}</Text>
        )}
        {genre.next ? <Pressable onPress={moreGenre} style={[st.more, { borderColor: c.line }]}><Text style={{ color: c.text, fontWeight: '600' }}>{WT.tr(t, 'watch.loadMore', 'Carregar mais')}</Text></Pressable> : null}
      </View>
    );
  } else {
    const convItems = (convA && convA.items) || [];
    body = (
      <View>
        <View style={st.genres}>
          {GENRES.filter(([k]) => !jamOff || k === 'classica').map(([k, fb, bg], i) => (
            <Pressable key={k} onPress={() => openGenre(k, WT.tr(t, 'watch.chip.' + k, fb))} style={[st.genre, { backgroundColor: bg }, i === 0 ? st.genreWide : null]}>
              <Text style={st.genreTx}>{WT.tr(t, 'watch.chip.' + k, fb)}</Text>
              <View style={st.genreIc}><IconHeadphones size={i === 0 ? 46 : 34} color="rgba(255,255,255,0.18)" /></View>
            </Pressable>
          ))}
        </View>
        {!jamOff ? shelf(WT.tr(t, 'listen.hot', 'Em alta'), 'Jamendo', hotOnly) : null}
        {!jamOff ? shelf(WT.tr(t, 'listen.lofi', 'Lo-fi para relaxar'), null, lofi) : null}
        {shelf(WT.tr(t, 'listen.classics', 'Clássicos'), WT.tr(t, 'watch.src.pd', 'Domínio público'), classicPd)}
        {classic && classic.error && (jamOff || ((hot && hot.error) && (lofi && lofi.error))) ? (
          <Text style={[st.empty, { color: c.muted }]}>{WT.tr(t, 'watch.catalogError', 'Não deu para carregar. Tente de novo daqui a pouco.')}</Text>
        ) : null}
        {convItems.length ? (
          <View>
            <View style={st.shelfH}><Text style={[st.shelfT, { color: c.text }]}>{WT.tr(t, 'watch.tab.conv', 'Da conversa')}</Text><Text style={[st.shelfS, { color: c.muted }]}>{convItems.length}</Text></View>
            {convItems.slice(0, 8).map(row)}
          </View>
        ) : null}
        {hotOnly && hotOnly.items && hotOnly.items.length ? (
          <View>
            <View style={st.shelfH}><Text style={[st.shelfT, { color: c.text }]}>{WT.tr(t, 'listen.tracks', 'Faixas')}</Text></View>
            {hotOnly.items.map(row)}
          </View>
        ) : null}
        <Text style={[st.legal, { color: c.muted, borderColor: c.line }]}>{WT.tr(t, 'watch.legal.music', 'Músicas Creative Commons do Jamendo e gravações em domínio público (Musopen). O artista e a licença aparecem sempre na sala.')}</Text>
      </View>
    );
  }

  return (
    <View style={[st.root, { backgroundColor: c.bg }]}>
      <View style={{ paddingTop: insets.top }}>
        <View style={st.r1}>
          <Pressable hitSlop={10} style={st.ib} onPress={() => router.back()} accessibilityLabel={WT.tr(t, 'common.back', 'Voltar')}><IconArrowLeft size={22} color={c.text} /></Pressable>
          <Text style={[st.kicker, { color: c.muted }]}>{WT.tr(t, 'watch.listenTitle', 'Ouvir junto')}</Text>
          <View style={st.ib} />
        </View>
        <Text style={[st.h1, { color: c.text }]} numberOfLines={2}>{convName ? WT.tr(t, 'listen.withName', 'Ouvir junto com {name}', { name: convName.split(' ')[0] }) : WT.tr(t, 'watch.listenTitle', 'Ouvir junto')}</Text>
        <View style={[st.srch, { backgroundColor: c.chip }]}>
          <IconSearch size={18} color={c.muted} />
          <TextInput value={q} onChangeText={setQ} placeholder={WT.tr(t, 'listen.searchPh', 'Músicas, artistas, gêneros')} placeholderTextColor={c.muted}
            style={[st.srchIn, { color: c.text }]} returnKeyType="search" autoCorrect={false} />
          {q ? <Pressable accessibilityRole="button" accessibilityLabel={a11yLabel('common.close', 'Fechar')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} onPress={() => setQ('')}><IconX size={16} color={c.muted} /></Pressable> : null}
        </View>
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 100 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        {body}
      </ScrollView>
      {pending.length && !(live && live.kind === 'music') ? (
        <View style={[st.pend, { bottom: insets.bottom + 12, backgroundColor: c.accent }]}>
          <Text style={[st.pendTx, { color: c.accentInk }]} numberOfLines={1}>{WT.tr(t, 'watch.pendingN', '{n} na fila', { n: pending.length })}</Text>
          <Pressable onPress={() => play(pending[0])} style={[st.pendBtn, { backgroundColor: c.accentInk }]}>
            <IconPlayFill size={14} color={c.accent} />
            <Text style={{ color: c.accent, fontWeight: '800' }}>{WT.tr(t, 'watch.start', 'Começar')}</Text>
          </Pressable>
        </View>
      ) : null}
      {toast ? <View pointerEvents="none" style={[st.toast, { bottom: insets.bottom + 80, backgroundColor: c.accent }]}><Text style={{ color: c.accentInk, fontWeight: '600', fontSize: 13.5 }} numberOfLines={1}>{toast}</Text></View> : null}
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1 },
  r1: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 6 },
  ib: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  kicker: { fontSize: 13, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase' },
  h1: { fontSize: 34, lineHeight: 40, fontWeight: '800', letterSpacing: -0.8, paddingHorizontal: 16, marginTop: 4 },
  srch: { marginHorizontal: 16, marginTop: 12, marginBottom: 6, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, paddingHorizontal: 10, height: 40 },
  srchIn: { flex: 1, fontSize: 16, paddingVertical: Platform.OS === 'android' ? 0 : 6 },
  genres: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingHorizontal: 16, paddingTop: 12 },
  genre: { width: '48%', flexGrow: 1, height: 86, borderRadius: 14, padding: 12, overflow: 'hidden', justifyContent: 'flex-start' },
  genreWide: { width: '100%', height: 104 },
  genreTx: { color: '#fff', fontSize: 18, fontWeight: '800', letterSpacing: -0.3 },
  genreIc: { position: 'absolute', right: 10, bottom: 6, transform: [{ rotate: '-18deg' }] },
  genreHead: { flexDirection: 'row', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  genrePill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 7, paddingHorizontal: 12, borderRadius: 999 },
  shelfH: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 22, paddingBottom: 10 },
  shelfT: { fontSize: 20, fontWeight: '800', letterSpacing: -0.4 },
  shelfS: { fontSize: 12.5 },
  cardT: { fontSize: 13.5, fontWeight: '600', marginTop: 7 },
  cardS: { fontSize: 12 },
  addq: { position: 'absolute', right: 6, bottom: 6, width: 30, height: 30, borderRadius: 15, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' },
  busy: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 7 },
  rowT: { fontSize: 15, fontWeight: '600' },
  rowS: { fontSize: 12.5 },
  lic: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingVertical: 1, paddingHorizontal: 5, borderRadius: 999, maxWidth: 120 },
  licTx: { fontSize: 9.5, fontWeight: '700' },
  qbtn: { flexDirection: 'row', alignItems: 'center', gap: 3, height: 30, paddingHorizontal: 9, borderRadius: 15, borderWidth: 1 },
  qbtnTx: { fontSize: 12, fontWeight: '700' },
  more: { marginHorizontal: 16, marginTop: 10, paddingVertical: 11, borderRadius: 12, borderWidth: 1, alignItems: 'center' },
  legal: { marginHorizontal: 16, marginTop: 24, padding: 12, borderRadius: 14, borderWidth: 1, borderStyle: 'dashed', fontSize: 12, lineHeight: 17 },
  empty: { paddingVertical: 40, paddingHorizontal: 30, textAlign: 'center', fontSize: 14 },
  pend: { position: 'absolute', left: 16, right: 16, borderRadius: 999, paddingVertical: 8, paddingLeft: 18, paddingRight: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pendTx: { fontWeight: '700', fontSize: 14, flexShrink: 1 },
  pendBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999 },
  toast: { position: 'absolute', alignSelf: 'center', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 999, maxWidth: '92%' },
});
