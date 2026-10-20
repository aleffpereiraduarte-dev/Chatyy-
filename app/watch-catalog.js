// app/watch-catalog.js — [assistir-junto 2026-10-20] Catálogo (tela 2): Filmes | Animação | Música | Da conversa.
// Só fontes legais e nossas (servidor api/watch.php → watch_catalog): domínio público, curtas abertos CC BY
// (crédito sempre), Jamendo (CC, crédito + licença) e o que já foi mandado na conversa.
// Params: cid, name (conversa), tab (filmes|animacao|musica|conv), mode ('add' = veio da sala → só fila).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Image, TextInput, ActivityIndicator, Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import * as WT from '../services/watchTogether';
import { IconPlayFill, IconHeadphones, IconTogether, IconTv, IconClip, SourceIcon } from '../components/watch/WatchIcons';
import { IconArrowLeft, IconSearch, IconPlus, IconCheck, IconFilm, IconMusic } from '../components/Icons';

const TABS = [
  { k: 'filmes', icon: IconFilm, label: ['watch.tab.movies', 'Filmes'] },
  { k: 'animacao', icon: IconTv, label: ['watch.tab.animation', 'Animação'] },
  { k: 'musica', icon: IconMusic, label: ['watch.tab.music', 'Música'] },
  { k: 'conv', icon: IconClip, label: ['watch.tab.conv', 'Da conversa'] },
];
const CHIP_FB = {
  tudo: 'Tudo', comedia: 'Comédia', terror: 'Terror', ficcao: 'Ficção', drama: 'Drama', curtas: 'Curtas abertos', classicos: 'Clássicos',
  lofi: 'Lo-fi', pop: 'Pop', jazz: 'Jazz', eletronica: 'Eletrônica', rock: 'Rock', acustica: 'Acústica', classica: 'Clássica',
  videos: 'Vídeos', audios: 'Áudios',
};
function deviceCountry() {
  try {
    const loc = Intl.DateTimeFormat().resolvedOptions().locale || '';
    const m = String(loc).match(/[-_]([A-Z]{2})\b/);
    return m ? m[1] : '';
  } catch { return ''; }
}
const _cache = new Map(); // chave → {at, data}

export default function WatchCatalog() {
  const params = useLocalSearchParams();
  const cid = String(params.cid || '');
  const convName = String(params.name || '');
  const addMode = params.mode === 'add';
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const [tab, setTab] = useState(TABS.some((x) => x.k === params.tab) ? String(params.tab) : 'filmes');
  const [chip, setChip] = useState('tudo');
  const [q, setQ] = useState('');
  const [qDeb, setQDeb] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState(null);
  const [pending, setPending] = useState([]); // fila montada antes de começar
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState('');
  const [sess, setSess] = useState(() => WT.getSession(cid));
  const reqN = useRef(0);
  const country = useMemo(deviceCountry, []);

  const c = useMemo(() => ({
    bg: colors.background || (isDark ? '#000' : '#f2f2f7'), card: colors.surface || (isDark ? '#1c1c1e' : '#fff'),
    text: colors.text || (isDark ? '#f5f5f7' : '#0b0b0c'), muted: colors.textSecondary || '#8a8a8f',
    chip: isDark ? '#2c2c2e' : '#ececf1', line: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
    accent: isDark ? '#f5f5f7' : '#0b0b0c', accentInk: isDark ? '#000' : '#fff',
  }), [colors, isDark]);

  useEffect(() => { const id = setTimeout(() => setQDeb(q.trim()), 350); return () => clearTimeout(id); }, [q]);
  useEffect(() => {
    if (!cid) return undefined;
    const off = WT.subscribe(cid, (s) => setSess(s));
    WT.refresh(cid).then(setSess).catch(() => {});
    return off;
  }, [cid]);

  const load = useCallback(async (cursor) => {
    const key = [tab, chip, qDeb, cursor || '', tab === 'conv' ? cid : ''].join('|');
    const hit = _cache.get(key);
    const n = ++reqN.current;
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) {
      setData((d) => (cursor && d ? { ...hit.data, items: [...d.items, ...hit.data.items] } : hit.data)); setMore(hit.data.next_cursor || null); return;
    }
    if (!cursor) setLoading(true);
    const r = await WT.catalog({ tab, chip: chip === 'tudo' ? '' : chip, q: qDeb, cursor: cursor || '', conversation_id: tab === 'conv' ? cid : undefined, country });
    if (n !== reqN.current) return;
    setLoading(false);
    if (r && !r.error) _cache.set(key, { at: Date.now(), data: r });
    setData((d) => (cursor && d && r && !r.error ? { ...r, items: [...d.items, ...(r.items || [])] } : r));
    setMore((r && r.next_cursor) || null);
  }, [tab, chip, qDeb, cid, country]);
  useEffect(() => { load(''); }, [load]);

  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 2200); };
  const live = WT.isLive(sess) ? sess : null;
  const kindOf = (it) => (it && it.kind === 'audio' ? 'music' : 'video');
  const inQueue = (it) => {
    const src = live ? (live.queue || []) : pending;
    return src.some((x) => x && x.id === it.id && x.url === it.url);
  };
  const toItem = (it) => ({
    id: it.id, kind: it.kind, title: it.title, author: it.author, artist: it.artist, year: it.year, dur: it.dur, url: it.url,
    thumb: it.thumb, mime: it.mime, source: it.source, lic: it.lic, lic_url: it.lic_url, credit: it.credit, message_id: it.message_id,
  });

  const open = async (it) => {
    if (busy) return;
    const kind = kindOf(it);
    if (addMode && live && live.kind === kind) { addQ(it); return; }
    setBusy(it.id);
    const queue = pending.filter((x) => x.id !== it.id && kindOf(x) === kind);
    const r = await WT.start(cid, kind, toItem(it), queue);
    setBusy('');
    if (!r.ok) { flash(r.error === 'host_only' ? WT.tr(t, 'watch.hostOnly', 'Só o anfitrião controla') : WT.tr(t, 'watch.startError', 'Não deu para começar. Tente de novo.')); return; }
    setPending([]);
    if (addMode) router.back();
    else router.replace({ pathname: '/watch-room', params: { cid, name: convName } });
  };
  const addQ = async (it) => {
    if (inQueue(it)) { flash(WT.tr(t, 'watch.alreadyQueued', '{title} já está na fila', { title: it.title })); return; }
    if (live && live.kind === kindOf(it)) {
      const r = await WT.cmd(cid, 'queue_add', { item: toItem(it) });
      flash(r.ok ? WT.tr(t, 'watch.queuedFor', '{title} na fila · todos veem', { title: it.title }) : WT.tr(t, 'watch.queueError', 'Não deu para pôr na fila'));
      return;
    }
    setPending((p) => [...p, toItem(it)]);
    flash(WT.tr(t, 'watch.queuedLocal', '{title} na fila', { title: it.title }));
  };

  const items = (data && data.items) || [];
  const chips = (data && data.chips) || ['tudo'];
  const isMusic = tab === 'musica';
  const title = isMusic ? WT.tr(t, 'watch.listenTitle', 'Ouvir junto') : WT.tr(t, 'watch.title', 'Assistir junto');

  const badge = (it, inline) => (
    <View style={[st.badge, inline ? { backgroundColor: c.chip, position: 'relative', left: 0, top: 0 } : null]}>
      <SourceIcon source={it.source} size={12} color={inline ? c.text : '#0b0b0c'} />
      <Text style={[st.badgeTx, inline ? { color: c.text } : null]} numberOfLines={1}>{WT.sourceLabel(t, it)}</Text>
    </View>
  );
  const metaOf = (it) => [it.author, it.year, it.dur ? WT.fmtTime(it.dur) : ''].filter(Boolean).join(' · ');

  const card = (it, wide) => {
    const q1 = inQueue(it);
    return (
      <View key={it.id} style={[st.card, wide ? { width: 230 } : null]}>
        <Pressable onPress={() => open(it)} style={[st.cover, { aspectRatio: wide ? 16 / 9 : 2 / 3, backgroundColor: c.chip }]}>
          {it.thumb ? <Image source={{ uri: it.thumb }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : <View style={st.coverFb}>{it.kind === 'audio' ? <IconHeadphones size={34} color={c.muted} /> : <IconTogether size={34} color={c.muted} />}</View>}
          <View style={st.coverShade} />
          {badge(it)}
          <Text style={st.coverTtl} numberOfLines={3}>{it.title}</Text>
          {it.dur ? <Text style={st.dur}>{WT.fmtTime(it.dur)}</Text> : null}
          {busy === it.id ? <View style={st.busy}><ActivityIndicator color="#fff" /></View> : null}
        </Pressable>
        <Pressable onPress={() => addQ(it)} style={[st.addq, q1 ? { backgroundColor: '#fff' } : null]} hitSlop={6} accessibilityLabel={WT.tr(t, 'watch.addToQueue', 'Adicionar à fila')}>
          {q1 ? <IconCheck size={16} color="#000" /> : <IconPlus size={16} color="#fff" />}
        </Pressable>
        <Text style={[st.nm, { color: c.text }]} numberOfLines={1}>{it.title}</Text>
        <Text style={[st.mt, { color: c.muted }]} numberOfLines={1}>{metaOf(it)}</Text>
      </View>
    );
  };
  const row = (it) => {
    const q1 = inQueue(it);
    return (
      <View key={it.id} style={st.mrow}>
        <Pressable onPress={() => open(it)} style={[st.art, { backgroundColor: c.chip }]}>
          {it.thumb ? <Image source={{ uri: it.thumb }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : (it.kind === 'audio' ? <IconHeadphones size={22} color={c.muted} /> : <IconTogether size={22} color={c.muted} />)}
          {busy === it.id ? <View style={st.busy}><ActivityIndicator color="#fff" /></View> : null}
        </Pressable>
        <Pressable onPress={() => open(it)} style={{ flex: 1, minWidth: 0 }}>
          <Text style={[st.rowT, { color: c.text }]} numberOfLines={1}>{it.title}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 }}>
            <Text style={[st.rowS, { color: c.muted, flexShrink: 1 }]} numberOfLines={1}>{[it.artist || it.author, it.dur ? WT.fmtTime(it.dur) : ''].filter(Boolean).join(' · ')}</Text>
            {badge(it, true)}
          </View>
        </Pressable>
        <Pressable onPress={() => addQ(it)} style={[st.q, { backgroundColor: q1 ? c.accent : c.chip }]} hitSlop={6}>
          {q1 ? <IconCheck size={16} color={c.accentInk} /> : <IconPlus size={16} color={c.text} />}
        </Pressable>
      </View>
    );
  };

  const legal = {
    filmes: WT.tr(t, 'watch.legal.movies', 'Filmes em domínio público e curtas abertos (Creative Commons), servidos pelo Chatyy. Não entram links piratas. Itens que ainda têm direitos no seu país ficam escondidos.'),
    animacao: WT.tr(t, 'watch.legal.animation', 'Curtas abertos da Blender (Creative Commons, crédito sempre visível) e desenhos antigos que já caíram em domínio público.'),
    musica: WT.tr(t, 'watch.legal.music', 'Músicas Creative Commons do Jamendo e gravações em domínio público (Musopen). O artista e a licença aparecem sempre na sala.'),
    conv: WT.tr(t, 'watch.legal.conv', 'Toca o arquivo que alguém já mandou aqui, direto do nosso servidor. Ninguém precisa baixar nada.'),
  }[tab];

  let body;
  if (loading && !items.length) body = <View style={st.emptyBox}><ActivityIndicator color={c.muted} /></View>;
  else if (data && data.error) body = <Text style={[st.empty, { color: c.muted }]}>{WT.tr(t, 'watch.catalogError', 'Não deu para carregar. Tente de novo daqui a pouco.')}</Text>;
  else if (!items.length) body = <Text style={[st.empty, { color: c.muted }]}>{tab === 'conv' ? WT.tr(t, 'watch.convEmpty', 'Ainda não mandaram vídeos ou áudios nesta conversa.') : WT.tr(t, 'watch.nothingFound', 'Nada encontrado. Tente outra palavra.')}</Text>;
  else if (isMusic) {
    const top = items.slice(0, 6);
    body = (
      <View>
        <View style={st.shelfH}><Text style={[st.shelfT, { color: c.text }]}>{WT.tr(t, 'watch.toListen', 'Para ouvir juntos')}</Text><Text style={[st.shelfS, { color: c.muted }]}>Jamendo · Musopen</Text></View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}>
          {top.map((it) => (
            <Pressable key={'s' + it.id} onPress={() => open(it)} style={{ width: 148 }}>
              <View style={[st.cover, { aspectRatio: 1, backgroundColor: c.chip }]}>
                {it.thumb ? <Image source={{ uri: it.thumb }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : <View style={st.coverFb}><IconHeadphones size={34} color={c.muted} /></View>}
                <View style={st.coverShade} />
                {badge(it)}
              </View>
              <Text style={[st.nm, { color: c.text }]} numberOfLines={1}>{it.title}</Text>
              <Text style={[st.mt, { color: c.muted }]} numberOfLines={1}>{it.artist || it.author}</Text>
            </Pressable>
          ))}
        </ScrollView>
        <View style={st.shelfH}><Text style={[st.shelfT, { color: c.text }]}>{WT.tr(t, 'watch.all', 'Todas')}</Text><Text style={[st.shelfS, { color: c.muted }]}>{items.length}</Text></View>
        {items.map(row)}
        {more ? <Pressable onPress={() => load(more)} style={[st.more, { borderColor: c.line }]}><Text style={{ color: c.text, fontWeight: '600' }}>{WT.tr(t, 'watch.loadMore', 'Carregar mais')}</Text></Pressable> : null}
      </View>
    );
  } else if (tab === 'conv') {
    body = <View>{items.map(row)}{more ? <Pressable onPress={() => load(more)} style={[st.more, { borderColor: c.line }]}><Text style={{ color: c.text, fontWeight: '600' }}>{WT.tr(t, 'watch.loadMore', 'Carregar mais')}</Text></Pressable> : null}</View>;
  } else {
    const hero = items[0];
    body = (
      <View>
        <Pressable onPress={() => open(hero)} style={[st.hero, { backgroundColor: c.chip }]}>
          {hero.thumb ? <Image source={{ uri: hero.thumb }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
          <View style={st.heroShade} />
          <View style={st.heroIn}>
            <View style={{ flexDirection: 'row' }}>{badge(hero, false)}</View>
            <Text style={st.heroT} numberOfLines={2}>{hero.title}</Text>
            <Text style={st.heroS} numberOfLines={1}>{metaOf(hero)}</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
              <Pressable onPress={() => open(hero)} style={st.heroBtn}>
                <IconPlayFill size={16} color="#000" />
                <Text style={st.heroBtnTx} numberOfLines={1}>{convName ? WT.tr(t, 'watch.watchWith', 'Assistir com {name}', { name: convName.split(' ')[0] }) : WT.tr(t, 'watch.watch', 'Assistir')}</Text>
              </Pressable>
              <Pressable onPress={() => addQ(hero)} style={[st.heroBtn, st.heroBtnG]}>
                <IconPlus size={16} color="#fff" />
                <Text style={[st.heroBtnTx, { color: '#fff' }]}>{WT.tr(t, 'watch.queue', 'Fila')}</Text>
              </Pressable>
            </View>
          </View>
        </Pressable>
        <View style={st.shelfH}>
          <Text style={[st.shelfT, { color: c.text }]}>{tab === 'animacao' ? WT.tr(t, 'watch.shelf.animation', 'Curtas e desenhos liberados') : WT.tr(t, 'watch.shelf.movies', 'Clássicos e curtas liberados')}</Text>
          <Text style={[st.shelfS, { color: c.muted }]}>{items.length}</Text>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}>
          {items.map((it) => card(it))}
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={[st.root, { backgroundColor: c.bg }]}>
      <View style={{ paddingTop: insets.top }}>
        <View style={st.r1}>
          <Pressable hitSlop={10} style={st.ib} onPress={() => router.back()} accessibilityLabel={WT.tr(t, 'common.back', 'Voltar')}><IconArrowLeft size={22} color={c.text} /></Pressable>
        </View>
        <Text style={[st.h1, { color: c.text }]}>{title}</Text>
        <Text style={[st.sub, { color: c.muted }]} numberOfLines={1}>
          {convName ? WT.tr(t, 'watch.withFree', 'com {name} · tudo grátis e legal', { name: convName }) : WT.tr(t, 'watch.free', 'tudo grátis e legal')}
        </Text>
        <View style={[st.srch, { backgroundColor: c.chip }]}>
          <IconSearch size={18} color={c.muted} />
          <TextInput value={q} onChangeText={setQ} placeholder={WT.tr(t, 'watch.searchPh', 'Buscar filme, desenho ou música')} placeholderTextColor={c.muted}
            style={[st.srchIn, { color: c.text }]} returnKeyType="search" autoCorrect={false} />
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[st.ctabs, { borderBottomColor: c.line }]} contentContainerStyle={{ paddingHorizontal: 12, gap: 4 }}>
          {TABS.map((x) => {
            const on = x.k === tab;
            const Ic = x.icon;
            return (
              <Pressable key={x.k} onPress={() => { setTab(x.k); setChip('tudo'); setData(null); }} style={st.ctab}>
                <Ic size={17} color={on ? c.text : c.muted} />
                <Text style={[st.ctabTx, { color: on ? c.text : c.muted }]}>{WT.tr(t, x.label[0], x.label[1])}</Text>
                {on ? <View style={[st.ctabBar, { backgroundColor: c.text }]} /> : null}
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 90 }} keyboardShouldPersistTaps="handled">
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.chips}>
          {chips.map((k) => (
            <Pressable key={k} onPress={() => setChip(k)} style={[st.chip, { backgroundColor: chip === k ? c.accent : c.card, borderColor: chip === k ? 'transparent' : c.line }]}>
              <Text style={[st.chipTx, { color: chip === k ? c.accentInk : c.text }]}>{WT.tr(t, 'watch.chip.' + k, CHIP_FB[k] || k)}</Text>
            </Pressable>
          ))}
        </ScrollView>
        {body}
        <Text style={[st.legal, { color: c.muted, borderColor: c.line }]}>{legal}</Text>
      </ScrollView>
      {pending.length && !live ? (
        <View style={[st.pend, { bottom: insets.bottom + 12, backgroundColor: c.accent }]}>
          <Text style={[st.pendTx, { color: c.accentInk }]} numberOfLines={1}>{WT.tr(t, 'watch.pendingN', '{n} na fila', { n: pending.length })}</Text>
          <Pressable onPress={() => open(pending[0])} style={[st.pendBtn, { backgroundColor: c.accentInk }]}>
            <IconPlayFill size={14} color={c.accent} />
            <Text style={{ color: c.accent, fontWeight: '800' }}>{WT.tr(t, 'watch.start', 'Começar')}</Text>
          </Pressable>
        </View>
      ) : null}
      {toast ? <View pointerEvents="none" style={[st.toast, { bottom: insets.bottom + (pending.length && !live ? 80 : 24), backgroundColor: c.accent }]}><Text style={{ color: c.accentInk, fontWeight: '600', fontSize: 13.5 }} numberOfLines={1}>{toast}</Text></View> : null}
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1 },
  r1: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6 },
  ib: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  h1: { fontSize: 28, fontWeight: '800', letterSpacing: -0.6, paddingHorizontal: 16 },
  sub: { fontSize: 13, paddingHorizontal: 16, marginTop: 2 },
  srch: { marginHorizontal: 16, marginTop: 10, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, paddingHorizontal: 10, height: 38 },
  srchIn: { flex: 1, fontSize: 15.5, paddingVertical: Platform.OS === 'android' ? 0 : 6 },
  ctabs: { marginTop: 10, borderBottomWidth: StyleSheet.hairlineWidth, flexGrow: 0 },
  ctab: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 9, paddingTop: 9, paddingBottom: 10 },
  ctabTx: { fontSize: 15, fontWeight: '600' },
  ctabBar: { position: 'absolute', left: 7, right: 7, bottom: -1, height: 3, borderTopLeftRadius: 3, borderTopRightRadius: 3 },
  chips: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 2, gap: 6 },
  chip: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1 },
  chipTx: { fontSize: 13, fontWeight: '600' },
  shelfH: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 18, paddingBottom: 8 },
  shelfT: { fontSize: 18, fontWeight: '700' },
  shelfS: { fontSize: 13 },
  card: { width: 148 },
  cover: { width: '100%', borderRadius: 14, overflow: 'hidden' },
  coverFb: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  coverShade: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.18)' },
  coverTtl: { position: 'absolute', left: 10, right: 10, bottom: 10, color: '#fff', fontWeight: '800', fontSize: 16, lineHeight: 18, textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 8 },
  dur: { position: 'absolute', right: 8, top: 40, color: '#fff', fontSize: 11, fontWeight: '700', backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 6, borderRadius: 5, overflow: 'hidden' },
  badge: { position: 'absolute', left: 8, top: 8, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(255,255,255,0.92)', paddingVertical: 3, paddingLeft: 5, paddingRight: 7, borderRadius: 999, maxWidth: 130 },
  badgeTx: { color: '#0b0b0c', fontSize: 10.5, fontWeight: '700' },
  addq: { position: 'absolute', right: 7, top: 7, width: 30, height: 30, borderRadius: 15, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
  busy: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center' },
  nm: { fontSize: 13.5, fontWeight: '600', marginTop: 7 },
  mt: { fontSize: 12 },
  hero: { marginHorizontal: 16, marginTop: 14, borderRadius: 20, overflow: 'hidden', aspectRatio: 16 / 10 },
  heroShade: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.38)' },
  heroIn: { ...StyleSheet.absoluteFillObject, padding: 16, justifyContent: 'flex-end' },
  heroT: { color: '#fff', fontSize: 26, fontWeight: '800', letterSpacing: -0.6, marginTop: 8 },
  heroS: { color: 'rgba(255,255,255,0.85)', fontSize: 13, marginTop: 4 },
  heroBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 9, paddingHorizontal: 14, borderRadius: 999, backgroundColor: '#fff', maxWidth: 220 },
  heroBtnG: { backgroundColor: 'rgba(255,255,255,0.22)' },
  heroBtnTx: { color: '#000', fontWeight: '700', fontSize: 14 },
  mrow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 8 },
  art: { width: 50, height: 50, borderRadius: 9, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  rowT: { fontSize: 15, fontWeight: '600' },
  rowS: { fontSize: 12.5 },
  q: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  more: { marginHorizontal: 16, marginTop: 10, paddingVertical: 11, borderRadius: 12, borderWidth: 1, alignItems: 'center' },
  legal: { marginHorizontal: 16, marginTop: 20, padding: 12, borderRadius: 14, borderWidth: 1, borderStyle: 'dashed', fontSize: 12, lineHeight: 17 },
  empty: { paddingVertical: 40, paddingHorizontal: 30, textAlign: 'center', fontSize: 14 },
  emptyBox: { paddingVertical: 40, alignItems: 'center' },
  pend: { position: 'absolute', left: 16, right: 16, borderRadius: 999, paddingVertical: 8, paddingLeft: 18, paddingRight: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pendTx: { fontWeight: '700', fontSize: 14, flexShrink: 1 },
  pendBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999 },
  toast: { position: 'absolute', alignSelf: 'center', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 999, maxWidth: '92%' },
});
