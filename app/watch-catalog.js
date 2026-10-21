// app/watch-catalog.js — [assistir-junto 2026-10-20] Catálogo (tela 2): Filmes | Animação | Música | Da conversa.
// Só fontes legais e nossas (servidor api/watch.php → watch_catalog): domínio público, curtas abertos CC BY
// (crédito sempre), Jamendo (CC, crédito + licença) e o que já foi mandado na conversa.
// Params: cid, name (conversa), tab (filmes|animacao|conv), mode ('add' = veio da sala → só fila).
// [separação 20/10] SÓ vídeo, com cara de cinema (fundo escuro, hero grande, pôsteres verticais).
// Música vive em app/listen-catalog.js (tab=musica aqui redireciona p/ lá).
// [juntos repaginado 21/10] mockup aprovado preview-2026/juntos.html: segue o TEMA do app (Grafite claro/escuro,
// não mais preto fixo), título 34/800, "com <nome> · grátis e legal" com avatar, busca, seletor segmentado
// Filmes | Animação | Músicas (Músicas → listen-catalog), destaque raio 24 com sombra e selo em vidro ACIMA do
// título, chips de gênero (+ "Da conversa"), trilhos com pôster 120x170, "Continuar assistindo" (watchProgress,
// só quando há algo salvo desta conversa).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Image, TextInput, ActivityIndicator, Platform, StatusBar } from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import * as WT from '../services/watchTogether';
import { IconPlayFill, IconHeadphones, IconTogether, IconClip, SourceIcon } from '../components/watch/WatchIcons';
import { IconChevronLeft, IconSearch, IconPlus, IconCheck } from '../components/Icons';
import { grafite, cardShadow } from '../constants/theme';
import { GradientFill, Glass } from '../components/watch/WatchAmbient';
import { listProgress } from '../services/watchProgress';

const TABS = [
  { k: 'filmes', label: ['watch.tab.movies', 'Filmes'] },
  { k: 'animacao', label: ['watch.tab.animation', 'Animação'] },
  { k: 'conv', label: ['watch.tab.conv', 'Da conversa'] },
];
// seletor segmentado do mockup (Da conversa vira chip no fim da fileira de gêneros)
const SEG = [['filmes', 'watch.tab.movies', 'Filmes'], ['animacao', 'watch.tab.animation', 'Animação'], ['musica', 'watch.tab.musicPl', 'Músicas']];
const HERO_STOPS = [[0, '#000', 0], [0.3, '#000', 0], [1, '#000', 0.78]];
const AV_STOPS = [[0, '#a9b4bd', 1], [1, '#5c6873', 1]];
function initials(n) {
  const p = String(n || '?').trim().split(/\s+/).filter(Boolean);
  return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}
function fmtLeft(t, sec) {
  const m = Math.max(1, Math.round(sec / 60));
  if (m < 60) return WT.tr(t, 'watch.leftMin', 'faltam {n} min', { n: m });
  return WT.tr(t, 'watch.leftH', 'faltam {h} h {m}', { h: Math.floor(m / 60), m: String(m % 60).padStart(2, '0') });
}
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

  // [juntos 21/10] segue o tema do app (Grafite claro/escuro)
  const c = useMemo(() => {
    const g = grafite(!!isDark);
    return {
      bg: g.bg, card: g.surface, s2: g.surface2, text: g.text, muted: g.muted, line: g.line, chip: g.surface2,
      accent: isDark ? '#F2F2EF' : '#34343A', accentInk: isDark ? '#0E0E10' : '#FFFFFF',
    };
  }, [isDark]);
  const shadow = cardShadow(!!isDark);
  const [prog, setProg] = useState([]);
  useFocusEffect(useCallback(() => {
    let alive = true;
    listProgress(cid).then((l) => { if (alive) setProg(l.filter((x) => x.cid === cid)); }).catch(() => {});
    return () => { alive = false; };
  }, [cid]));
  useEffect(() => { if (params.tab === 'musica') router.replace({ pathname: '/listen-catalog', params: { cid, name: convName, mode: params.mode || '' } }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
      setLoading(false);
      setData((d) => (cursor && d ? { ...hit.data, items: [...d.items, ...hit.data.items] } : hit.data)); setMore(hit.data.next_cursor || null); return;
    }
    if (!cursor) setLoading(true);
    const r = await WT.catalog({ tab, chip: tab === 'conv' ? 'videos' : (chip === 'tudo' ? '' : chip), q: qDeb, cursor: cursor || '', conversation_id: tab === 'conv' ? cid : undefined, country });
    if (n !== reqN.current) return;
    setLoading(false);
    // [2026-10-21] "carregar mais" que falha não apaga a lista já mostrada
    if (cursor && (!r || r.error)) { flash(WT.tr(t, 'watch.catalogError', 'Não deu para carregar. Tente de novo daqui a pouco.')); return; }
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

  // busca instantânea: filtra o que já está na tela a cada letra; o servidor confirma 350 ms depois
  const allItems = (data && data.items) || [];
  const qLive = q.trim().toLowerCase();
  const items = qLive && qLive !== qDeb.toLowerCase()
    ? allItems.filter((it) => qLive.split(/\s+/).every((w) => [it.title, it.original_title, it.author, it.artist, it.year].filter(Boolean).join(' ').toLowerCase().includes(w)))
    : allItems;
  const chips = tab === 'conv' ? [] : ((data && data.chips) || ['tudo']); // Da conversa = só vídeos

  const metaOf = (it) => [it.author, it.year, it.dur ? WT.fmtTime(it.dur) : ''].filter(Boolean).join(' · ');
  const subOf = (it) => [it.year, it.author].filter(Boolean).join(' · ');
  const firstName = convName ? convName.split(' ')[0] : '';

  // continuar de onde parou (mesmo item → sala; senão começa e pula p/ o ponto salvo)
  const resume = async (p) => {
    if (busy) return;
    if (live && live.item && live.item.id === p.item.id) { router.replace({ pathname: '/watch-room', params: { cid, name: convName } }); return; }
    setBusy(p.item.id);
    const r = await WT.start(cid, 'video', p.item, []);
    if (r.ok) { try { await WT.cmd(cid, 'seek', { pos: p.pos, delta: Math.round(p.pos) }); } catch {} }
    setBusy('');
    if (!r.ok) { flash(r.error === 'host_only' ? WT.tr(t, 'watch.hostOnly', 'Só o anfitrião controla') : WT.tr(t, 'watch.startError', 'Não deu para começar. Tente de novo.')); return; }
    router.replace({ pathname: '/watch-room', params: { cid, name: convName } });
  };

  // pôster vertical 120x170 (raio 16): duração e play no pôster, nome e ano/diretor embaixo
  const poster = (it) => {
    const q1 = inQueue(it);
    return (
      <View key={it.id} style={st.pc}>
        <View style={[st.poWrap, shadow]}>
          <Pressable onPress={() => open(it)} style={[st.po, { backgroundColor: c.s2 }]} accessibilityRole="button" accessibilityLabel={it.title}>
            {it.thumb ? <Image source={{ uri: it.thumb }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : <View style={st.coverFb}>{it.kind === 'audio' ? <IconHeadphones size={30} color={c.muted} /> : <IconTogether size={30} color={c.muted} />}</View>}
            <View pointerEvents="none" style={st.poPlay}><IconPlayFill size={12} color="#111" /></View>
            {it.dur ? <Text style={st.poDur}>{WT.fmtTime(it.dur)}</Text> : null}
            {busy === it.id ? <View style={st.busy}><ActivityIndicator color="#fff" /></View> : null}
          </Pressable>
          <Pressable onPress={() => addQ(it)} style={[st.poAdd, q1 ? { backgroundColor: '#fff' } : null]} hitSlop={6} accessibilityRole="button" accessibilityLabel={WT.tr(t, 'watch.addToQueue', 'Adicionar à fila')}>
            {q1 ? <IconCheck size={13} color="#111" /> : <IconPlus size={13} color="#fff" />}
          </Pressable>
        </View>
        <Text style={[st.nm, { color: c.text }]} numberOfLines={1}>{it.title}</Text>
        <Text style={[st.mt, { color: c.muted }]} numberOfLines={1}>{subOf(it)}</Text>
      </View>
    );
  };
  const row = (it) => {
    const q1 = inQueue(it);
    return (
      <View key={it.id} style={st.mrow}>
        <Pressable onPress={() => open(it)} style={[st.art, { backgroundColor: c.s2 }]}>
          {it.thumb ? <Image source={{ uri: it.thumb }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : (it.kind === 'audio' ? <IconHeadphones size={22} color={c.muted} /> : <IconTogether size={22} color={c.muted} />)}
          {busy === it.id ? <View style={st.busy}><ActivityIndicator color="#fff" /></View> : null}
        </Pressable>
        <Pressable onPress={() => open(it)} style={{ flex: 1, minWidth: 0 }}>
          <Text style={[st.rowT, { color: c.text }]} numberOfLines={1}>{it.title}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 }}>
            <SourceIcon source={it.source} size={12} color={c.muted} />
            <Text style={[st.rowS, { color: c.muted, flexShrink: 1 }]} numberOfLines={1}>{[it.artist || it.author, it.dur ? WT.fmtTime(it.dur) : '', WT.sourceLabel(t, it)].filter(Boolean).join(' · ')}</Text>
          </View>
        </Pressable>
        <Pressable onPress={() => addQ(it)} style={[st.q, { backgroundColor: q1 ? c.accent : c.s2 }]} hitSlop={6} accessibilityRole="button" accessibilityLabel={WT.tr(t, 'watch.addToQueue', 'Adicionar à fila')}>
          {q1 ? <IconCheck size={16} color={c.accentInk} /> : <IconPlus size={16} color={c.text} />}
        </Pressable>
      </View>
    );
  };
  const more1 = more ? <Pressable onPress={() => load(more)} style={[st.more, { backgroundColor: c.card }, shadow]}><Text style={{ color: c.text, fontWeight: '600' }}>{WT.tr(t, 'watch.loadMore', 'Carregar mais')}</Text></Pressable> : null;

  const legal = {
    filmes: WT.tr(t, 'watch.legal.movies', 'Filmes em domínio público e curtas abertos (Creative Commons), servidos pelo Chatyy. Não entram links piratas. Itens que ainda têm direitos no seu país ficam escondidos.'),
    animacao: WT.tr(t, 'watch.legal.animation', 'Curtas abertos da Blender (Creative Commons, crédito sempre visível) e desenhos antigos que já caíram em domínio público.'),
    musica: WT.tr(t, 'watch.legal.music', 'Músicas Creative Commons do Jamendo e gravações em domínio público (Musopen). O artista e a licença aparecem sempre na sala.'),
    conv: WT.tr(t, 'watch.legal.conv', 'Toca o arquivo que alguém já mandou aqui, direto do nosso servidor. Ninguém precisa baixar nada.'),
  }[tab];

  // "Continuar assistindo" — só quando há ponto salvo desta conversa (sem dado → a fileira não aparece)
  const resumeList = !addMode && !q.trim() && tab !== 'conv' ? prog : [];
  const continueRail = resumeList.length ? (
    <View key="continue">
      <View style={st.rowh}><Text style={[st.rowhT, { color: c.text }]}>{WT.tr(t, 'watch.continueWatching', 'Continuar assistindo')}</Text></View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.rail}>
        {resumeList.map((p) => (
          <View key={p.key} style={{ width: 200 }}>
            <View style={[st.poWrap, shadow]}>
              <Pressable onPress={() => resume(p)} style={[st.po, { height: 112, backgroundColor: c.s2 }]} accessibilityRole="button" accessibilityLabel={p.item.title}>
                {p.item.thumb ? <Image source={{ uri: p.item.thumb }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : <View style={st.coverFb}><IconTogether size={30} color={c.muted} /></View>}
                <Text style={st.poDur}>{fmtLeft(t, Math.max(0, (Number(p.dur) || 0) - (Number(p.pos) || 0)))}</Text>
                <View style={st.resBar}><View style={[st.resBarFg, { width: `${Math.min(100, ((Number(p.pos) || 0) / Math.max(1, Number(p.dur) || 1)) * 100)}%` }]} /></View>
                {busy === p.item.id ? <View style={st.busy}><ActivityIndicator color="#fff" /></View> : null}
              </Pressable>
            </View>
            <Text style={[st.nm, { color: c.text }]} numberOfLines={1}>{p.item.title}</Text>
            <Text style={[st.mt, { color: c.muted }]} numberOfLines={1}>{p.name ? WT.tr(t, 'watch.withName', 'com {name}', { name: p.name }) : subOf(p.item)}</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  ) : null;

  const chipsRow = (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.gen}>
      {chips.map((k) => {
        const on = tab !== 'conv' && chip === k;
        return (
          <Pressable key={k} onPress={() => setChip(k)} style={[st.chip, { backgroundColor: on ? c.accent : c.card }, on ? null : shadow]} accessibilityRole="button" accessibilityState={{ selected: on }}>
            <Text style={[st.chipTx, { color: on ? c.accentInk : c.text }]}>{WT.tr(t, 'watch.chip.' + k, CHIP_FB[k] || k)}</Text>
          </Pressable>
        );
      })}
      {cid ? (
        <Pressable onPress={() => { if (tab !== 'conv') { setTab('conv'); setData(null); } }} style={[st.chip, st.chipRow, { backgroundColor: tab === 'conv' ? c.accent : c.card }, tab === 'conv' ? null : shadow]} accessibilityRole="button" accessibilityState={{ selected: tab === 'conv' }}>
          <IconClip size={14} color={tab === 'conv' ? c.accentInk : c.text} />
          <Text style={[st.chipTx, { color: tab === 'conv' ? c.accentInk : c.text }]}>{WT.tr(t, 'watch.tab.conv', 'Da conversa')}</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );

  let body;
  if (loading && !items.length) body = <View style={st.emptyBox}><ActivityIndicator color={c.muted} /></View>;
  else if (data && data.error) body = <Text style={[st.empty, { color: c.muted }]}>{WT.tr(t, 'watch.catalogError', 'Não deu para carregar. Tente de novo daqui a pouco.')}</Text>;
  else if (!items.length) body = <Text style={[st.empty, { color: c.muted }]}>{tab === 'conv' ? WT.tr(t, 'watch.convEmptyVideo', 'Ainda não mandaram vídeos nesta conversa.') : WT.tr(t, 'watch.nothingFound', 'Nada encontrado. Tente outra palavra.')}</Text>;
  else if (tab === 'conv') {
    body = <View style={{ paddingTop: 6 }}>{items.map(row)}{more1}</View>;
  } else {
    // prateleiras por categoria (ordem dos chips); "Tudo" com 1 categoria só = 1 prateleira
    const groups = [];
    const order = chips.filter((k) => k !== 'tudo');
    const by = {};
    items.forEach((it) => { const k = it.chip || 'outros'; (by[k] = by[k] || []).push(it); });
    order.forEach((k) => { if (by[k] && by[k].length) groups.push([k, by[k]]); });
    Object.keys(by).forEach((k) => { if (!order.includes(k)) groups.push([k, by[k]]); });
    const shelves = groups.length > 1 ? groups : [['all', items]];
    const shelfEls = shelves.map(([k, list]) => (
      <View key={k}>
        <View style={st.rowh}>
          <Text style={[st.rowhT, { color: c.text }]} numberOfLines={1}>{k === 'all' ? (tab === 'animacao' ? WT.tr(t, 'watch.shelf.animation', 'Curtas e desenhos liberados') : WT.tr(t, 'watch.shelf.movies', 'Clássicos e curtas liberados')) : WT.tr(t, 'watch.chip.' + k, CHIP_FB[k] || k)}</Text>
          {k !== 'all' && chip === 'tudo' && chips.includes(k) ? (
            <Pressable onPress={() => setChip(k)} hitSlop={8} accessibilityRole="button"><Text style={[st.rowhA, { color: c.muted }]}>{WT.tr(t, 'watch.seeAll', 'Ver tudo')}</Text></Pressable>
          ) : <Text style={[st.rowhA, { color: c.muted }]}>{list.length}</Text>}
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} decelerationRate="fast" snapToInterval={132} contentContainerStyle={st.rail}>
          {list.map(poster)}
        </ScrollView>
      </View>
    ));
    if (continueRail) shelfEls.splice(1, 0, continueRail);
    body = <View>{shelfEls}{more1}</View>;
  }

  const hero = tab !== 'conv' && items.length && !(data && data.error) ? items[0] : null;
  const heroEl = hero ? (
    <View style={[st.heroWrap, shadow]}>
      <Pressable onPress={() => open(hero)} style={[st.hero, { backgroundColor: c.s2 }]} accessibilityRole="button" accessibilityLabel={hero.title}>
        {hero.thumb ? <Image source={{ uri: hero.thumb }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
        <GradientFill stops={HERO_STOPS} />
        <View style={st.heroIn}>
          {/* selo pequeno em vidro ACIMA do título (nunca por cima) */}
          <View style={{ flexDirection: 'row' }}>
            <Glass style={st.seal} veil={0.2} intensity={20}>
              <Text style={st.sealTx} numberOfLines={1}>{WT.sourceLabel(t, hero).toUpperCase()}</Text>
            </Glass>
          </View>
          <Text style={st.heroT} numberOfLines={2}>{hero.title}</Text>
          <Text style={st.heroS} numberOfLines={1}>{metaOf(hero)}</Text>
          <View style={st.heroBtns}>
            <Pressable onPress={() => open(hero)} style={st.heroBtn} accessibilityRole="button">
              {busy === hero.id ? <ActivityIndicator color="#111" size="small" /> : <IconPlayFill size={13} color="#111" />}
              <Text style={st.heroBtnTx} numberOfLines={1}>{firstName ? WT.tr(t, 'watch.watchWith', 'Assistir com {name}', { name: firstName }) : WT.tr(t, 'watch.watch', 'Assistir')}</Text>
            </Pressable>
            <Pressable onPress={() => addQ(hero)} accessibilityRole="button">
              <Glass style={[st.heroBtn, { backgroundColor: 'transparent' }]} veil={0.2} intensity={20}>
                {inQueue(hero) ? <IconCheck size={13} color="#fff" /> : <IconPlus size={13} color="#fff" />}
                <Text style={[st.heroBtnTx, { color: '#fff' }]}>{WT.tr(t, 'watch.queue', 'Fila')}</Text>
              </Glass>
            </Pressable>
          </View>
        </View>
      </Pressable>
    </View>
  ) : null;

  return (
    <View style={[st.root, { backgroundColor: c.bg }]}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <View style={{ paddingTop: insets.top + 6 }}>
        <View style={st.hd}>
          <Pressable hitSlop={10} style={[st.back, { backgroundColor: c.card }, shadow]} onPress={() => router.back()} accessibilityRole="button" accessibilityLabel={WT.tr(t, 'common.back', 'Voltar')}>
            <IconChevronLeft size={18} color={c.text} />
          </Pressable>
          <Text style={[st.h1, { color: c.text }]} numberOfLines={1}>{WT.tr(t, 'watch.title', 'Assistir junto')}</Text>
          <View style={st.sub}>
            {convName ? (
              <View style={st.subAv}>
                <GradientFill stops={AV_STOPS} />
                <Text style={st.subAvTx}>{initials(convName)}</Text>
              </View>
            ) : null}
            <Text style={[st.subTx, { color: c.muted }]} numberOfLines={1}>
              {convName ? WT.tr(t, 'watch.withFreeShort', 'com {name} · grátis e legal', { name: firstName }) : WT.tr(t, 'watch.freeShort', 'grátis e legal')}
            </Text>
          </View>
        </View>
        <View style={[st.srch, { backgroundColor: c.s2 }]}>
          <IconSearch size={17} color={c.muted} />
          <TextInput value={q} onChangeText={setQ} placeholder={WT.tr(t, 'watch.searchPh', 'Buscar filme, desenho ou música')} placeholderTextColor={c.muted}
            style={[st.srchIn, { color: c.text }]} returnKeyType="search" autoCorrect={false} keyboardAppearance={isDark ? 'dark' : 'light'} />
        </View>
        <View style={[st.mode, { backgroundColor: c.s2 }]} accessibilityRole="tablist">
          {SEG.map(([k, key, fb]) => {
            const on = k === tab;
            return (
              <Pressable key={k} accessibilityRole="tab" accessibilityState={{ selected: on }}
                onPress={() => {
                  if (k === 'musica') { router.replace({ pathname: '/listen-catalog', params: { cid, name: convName, mode: params.mode || '' } }); return; }
                  if (k !== tab) { setTab(k); setChip('tudo'); setData(null); }
                }}
                style={[st.modeSeg, on ? [{ backgroundColor: c.card }, shadow] : null]}>
                <Text style={[st.modeTx, { color: on ? c.text : c.muted }]} numberOfLines={1}>{WT.tr(t, key, fb)}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 90 }} keyboardShouldPersistTaps="handled">
        {heroEl}
        {chipsRow}
        {body}
        <View style={[st.legal, { backgroundColor: c.card }, shadow]}><Text style={[st.legalTx, { color: c.muted }]}>{legal}</Text></View>
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
  hd: { paddingHorizontal: 18 },
  back: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  h1: { fontSize: 34, lineHeight: 41, fontWeight: '800', letterSpacing: -1.2, marginTop: 10 },
  sub: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  subAv: { width: 22, height: 22, borderRadius: 11, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  subAvTx: { color: '#fff', fontSize: 9, fontWeight: '800' },
  subTx: { fontSize: 13.5, flexShrink: 1 },
  srch: { marginHorizontal: 18, marginTop: 14, marginBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 14, paddingHorizontal: 14, height: 42 },
  srchIn: { flex: 1, fontSize: 15, paddingVertical: Platform.OS === 'android' ? 0 : 6 },
  mode: { flexDirection: 'row', marginHorizontal: 18, marginBottom: 12, borderRadius: 999, padding: 3 },
  modeSeg: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 999 },
  modeTx: { fontSize: 14, fontWeight: '600' },
  heroWrap: { marginHorizontal: 18, borderRadius: 24 },
  hero: { borderRadius: 24, overflow: 'hidden', height: 230 },
  heroIn: { position: 'absolute', left: 16, right: 16, bottom: 14 },
  seal: { borderRadius: 999, paddingVertical: 4, paddingHorizontal: 8 },
  sealTx: { color: '#fff', fontSize: 10.5, fontWeight: '700', letterSpacing: 0.2 },
  heroT: { color: '#fff', fontSize: 24, lineHeight: 29, fontWeight: '800', letterSpacing: -0.5, marginTop: 6 },
  heroS: { color: 'rgba(255,255,255,0.8)', fontSize: 12.5, marginTop: 1 },
  heroBtns: { flexDirection: 'row', gap: 8, marginTop: 10 },
  heroBtn: { flexDirection: 'row', alignItems: 'center', gap: 7, height: 38, paddingHorizontal: 16, borderRadius: 19, backgroundColor: '#fff', maxWidth: 230 },
  heroBtnTx: { color: '#111', fontWeight: '700', fontSize: 14, flexShrink: 1 },
  gen: { paddingHorizontal: 18, paddingTop: 14, paddingBottom: 4, gap: 8 },
  chip: { paddingVertical: 7, paddingHorizontal: 14, borderRadius: 999 },
  chipRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  chipTx: { fontSize: 13.5, fontWeight: '600' },
  rowh: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, paddingHorizontal: 18, paddingTop: 16, paddingBottom: 8 },
  rowhT: { fontSize: 19, fontWeight: '800', letterSpacing: -0.3, flexShrink: 1 },
  rowhA: { fontSize: 13 },
  rail: { paddingHorizontal: 18, gap: 12, paddingBottom: 4 },
  pc: { width: 120 },
  poWrap: { borderRadius: 16 },
  po: { height: 170, borderRadius: 16, overflow: 'hidden' },
  poPlay: { position: 'absolute', right: 6, top: 6, width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.85)', alignItems: 'center', justifyContent: 'center' },
  poAdd: { position: 'absolute', left: 6, top: 6, width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  poDur: { position: 'absolute', right: 6, bottom: 6, color: '#fff', fontSize: 10.5, fontWeight: '700', backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: 'hidden' },
  resBar: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, backgroundColor: 'rgba(255,255,255,0.3)' },
  resBarFg: { height: 3, backgroundColor: '#fff' },
  coverFb: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  busy: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center' },
  nm: { fontSize: 13.5, fontWeight: '600', marginTop: 7 },
  mt: { fontSize: 11.5, marginTop: 1 },
  mrow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingVertical: 8 },
  art: { width: 64, height: 40, borderRadius: 9, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  rowT: { fontSize: 15, fontWeight: '600' },
  rowS: { fontSize: 12.5 },
  q: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  more: { marginHorizontal: 18, marginTop: 14, paddingVertical: 11, borderRadius: 14, alignItems: 'center' },
  legal: { marginHorizontal: 18, marginTop: 22, padding: 14, borderRadius: 18 },
  legalTx: { fontSize: 12, lineHeight: 17 },
  empty: { paddingVertical: 40, paddingHorizontal: 30, textAlign: 'center', fontSize: 14 },
  emptyBox: { paddingVertical: 40, alignItems: 'center' },
  pend: { position: 'absolute', left: 16, right: 16, borderRadius: 999, paddingVertical: 8, paddingLeft: 18, paddingRight: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pendTx: { fontWeight: '700', fontSize: 14, flexShrink: 1 },
  pendBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999 },
  toast: { position: 'absolute', alignSelf: 'center', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 999, maxWidth: '92%' },
});
