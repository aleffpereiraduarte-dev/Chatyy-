// app/watch-room.js — [assistir-junto 2026-10-20] Sala "Assistir junto" (tela 3) e "Ouvir junto" básica (tela 4).
// Params: cid (conversa), name (nome da conversa). Estado: services/watchTogether (hub ou HTTP).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Image, Animated, ActivityIndicator, Linking, StatusBar } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import * as WT from '../services/watchTogether';
import WatchPlayer from '../components/watch/WatchPlayer';
import {
  IconChevronDown, IconPlayFill, IconPauseFill, IconBack10, IconFwd10, IconNextTrack, IconPrevTrack, IconQueue,
  IconSync, IconCrown, SourceIcon, IconHeadphones, IconTogether,
} from '../components/watch/WatchIcons';
import { IconPlus, IconX } from '../components/Icons';

const GRAY = '#a1a1a6';

function initials(n) {
  const p = String(n || '?').trim().split(/\s+/).filter(Boolean);
  return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}
function Avatar({ name, size = 34, ring }) {
  return (
    <View style={[st.av, { width: size, height: size, borderRadius: size / 2 }, ring ? { borderWidth: 2, borderColor: '#000' } : null]}>
      <Text style={{ color: '#fff', fontWeight: '700', fontSize: size * 0.38 }}>{initials(name)}</Text>
    </View>
  );
}
function Badge({ t, item, dark = true }) {
  return (
    <View style={[st.badge, dark ? null : { backgroundColor: 'rgba(255,255,255,0.92)' }]}>
      <SourceIcon source={item && item.source} size={12} color={dark ? '#fff' : '#0b0b0c'} />
      <Text style={[st.badgeTx, dark ? null : { color: '#0b0b0c' }]} numberOfLines={1}>{WT.sourceLabel(t, item)}</Text>
    </View>
  );
}

export default function WatchRoom() {
  const params = useLocalSearchParams();
  const cid = String(params.cid || '');
  const convName = String(params.name || '');
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { t } = useLanguage();
  const me = String((user && user.email) || '').toLowerCase();
  const [s, setS] = useState(() => WT.getSession(cid));
  const [pane, setPane] = useState('activity');
  const [overlay, setOverlay] = useState(true);
  const [sync, setSync] = useState({ status: 'loading', diff: null });
  const [activity, setActivity] = useState([]);
  const [toast, setToast] = useState(null);
  const [trackW, setTrackW] = useState(1);
  const [, setTick] = useState(0);
  const toastAnim = useRef(new Animated.Value(0)).current;
  const toastTimer = useRef(null);
  const lastSeq = useRef(0);

  const showToast = useCallback((txt) => {
    setToast(txt);
    clearTimeout(toastTimer.current);
    Animated.timing(toastAnim, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    toastTimer.current = setTimeout(() => Animated.timing(toastAnim, { toValue: 0, duration: 250, useNativeDriver: true }).start(), 2400);
  }, [toastAnim]);

  const describe = useCallback((ns) => {
    const who = ns.by && ns.by === me ? WT.tr(t, 'watch.you', 'Você') : (ns.by_name || '');
    const d = Number(ns.delta);
    switch (ns.cmd) {
      case 'play': return WT.tr(t, 'watch.ev.play', '{who} continuou', { who });
      case 'pause': return WT.tr(t, 'watch.ev.pause', '{who} pausou', { who });
      case 'seek':
        if (d < 0) return WT.tr(t, 'watch.ev.back', '{who} voltou {n} s', { who, n: Math.abs(d) });
        if (d > 0) return WT.tr(t, 'watch.ev.fwd', '{who} avançou {n} s', { who, n: d });
        return WT.tr(t, 'watch.ev.seek', '{who} pulou para {time}', { who, time: WT.fmtTime(ns.pos) });
      case 'next': case 'prev': case 'pick': return WT.tr(t, 'watch.ev.pick', '{who} trocou para {title}', { who, title: (ns.item && ns.item.title) || '' });
      case 'queue_add': { const q = ns.queue || []; const last = q[q.length - 1]; return WT.tr(t, 'watch.ev.queued', '{who} pôs {title} na fila', { who, title: (last && last.title) || '' }); }
      case 'ctrl': return ns.ctrl_mode === 'host' ? WT.tr(t, 'watch.ctrlHostOn', 'Só o anfitrião controla') : WT.tr(t, 'watch.ctrlAllOn', 'Todos podem controlar');
      case 'buffer': return ns.hold ? WT.tr(t, 'watch.ev.waiting', 'Esperando {who} carregar', { who: ns.hold.by === me ? WT.tr(t, 'watch.you', 'Você') : (ns.hold.n || '') }) : '';
      case 'join': return WT.tr(t, 'watch.ev.join', '{who} entrou', { who });
      case 'end': return WT.tr(t, 'watch.ev.end', '{who} encerrou a sessão', { who });
      default: return '';
    }
  }, [me, t]);

  useEffect(() => {
    if (!cid) return undefined;
    const off = WT.subscribe(cid, (ns, meta) => {
      setS(ns);
      if (!ns || meta.origin === 'local') return;
      if (Number(ns.seq) <= lastSeq.current) return;
      const first = lastSeq.current === 0;
      lastSeq.current = Number(ns.seq) || 0;
      if (first) return;
      const txt = describe(ns);
      if (!txt) return;
      setActivity((a) => [{ k: ns.sid + ':' + ns.seq, txt, at: WT.positionAt(ns, Number(ns.server_ts)) }, ...a].slice(0, 60));
      if (ns.by && ns.by !== me && ['play', 'pause', 'seek', 'pick', 'next', 'prev'].includes(ns.cmd)) showToast(txt);
      if (ns.cmd === 'buffer' && ns.hold && ns.hold.by !== me) showToast(txt);
    });
    const leave = WT.enterRoom(cid);
    WT.refresh(cid).then((x) => { if (x) setS(x); }).catch(() => {});
    const iv = setInterval(() => setTick((n) => (n + 1) % 1e6), 500);
    return () => { off(); leave(); clearInterval(iv); clearTimeout(toastTimer.current); };
  }, [cid, describe, me, showToast]);

  useEffect(() => {
    if (!overlay || !(s && s.playing)) return undefined;
    const id = setTimeout(() => setOverlay(false), 3500);
    return () => clearTimeout(id);
  }, [overlay, s && s.playing, s && s.seq]);

  const item = s && s.item;
  const live = WT.isLive(s);
  const music = s && s.kind === 'music';
  const canCtl = WT.canControl(s, me);
  const isHost = !!(s && String(s.host || '').toLowerCase() === me);
  const pos = s ? WT.positionNow(s) : 0;
  const dur = Number(item && item.dur) || 0;
  const pct = dur > 0 ? Math.min(1, pos / dur) : 0;
  const held = WT.isHeld(s);
  const viewers = WT.viewersOf(s);
  const others = viewers.filter((v) => String(v.e).toLowerCase() !== me);
  const peerLabel = others.length === 1 ? others[0].n : (others.length > 1 ? WT.tr(t, 'watch.nPeople', '{n} pessoas', { n: others.length }) : (convName || ''));

  const deny = useCallback(() => showToast(WT.tr(t, 'watch.hostOnly', 'Só o anfitrião controla')), [showToast, t]);
  const doCmd = useCallback(async (name, args) => {
    if (!s) return;
    if (!canCtl && ['play', 'pause', 'seek', 'next', 'prev', 'pick'].includes(name)) { deny(); return; }
    const r = await WT.cmd(cid, name, { ...(args || {}), _me: me });
    if (!r.ok && r.error === 'host_only') deny();
    else if (!r.ok && r.error !== 'timeout') { WT.refresh(cid).catch(() => {}); }
  }, [s, canCtl, cid, me, deny]);
  const togglePlay = () => {
    if (!s) return;
    if (s.playing) doCmd('pause', { pos: WT.positionNow(s) });
    else doCmd('play', { pos: dur > 0 && pos >= dur - 0.5 ? 0 : WT.positionNow(s) });
    setOverlay(true);
  };
  const seekBy = (d) => { if (!s) return; const p = Math.max(0, Math.min(dur || 1e9, WT.positionNow(s) + d)); doCmd('seek', { pos: p, delta: d }); setOverlay(true); };
  const seekTo = (x) => { if (!s || !dur) return; const p = Math.max(0, Math.min(dur, (x / Math.max(1, trackW)) * dur)); doCmd('seek', { pos: p, delta: Math.round(p - WT.positionNow(s)) }); };
  const setCtrl = (mode) => { if (!isHost) { deny(); return; } WT.cmd(cid, 'ctrl', { mode }).catch(() => {}); };
  const openCatalog = () => router.push({ pathname: '/watch-catalog', params: { cid, name: convName, tab: music ? 'musica' : 'filmes', mode: 'add' } });
  const endSession = () => {
    try {
      require('../services/alerts').safeAlert(WT.tr(t, 'watch.endTitle', 'Encerrar a sessão?'), WT.tr(t, 'watch.endBody', 'Todo mundo para de assistir. O cartão fica na conversa.'), [
        { text: WT.tr(t, 'common.cancel', 'Cancelar'), style: 'cancel' },
        { text: WT.tr(t, 'watch.end', 'Encerrar'), style: 'destructive', onPress: () => { WT.cmd(cid, 'end').then(() => router.back()).catch(() => {}); } },
      ]);
    } catch {}
  };

  let syncTxt = '';
  let syncWait = false;
  if (!live) syncTxt = WT.tr(t, 'watch.ended', 'Sessão encerrada');
  else if (held) { syncWait = true; syncTxt = WT.tr(t, 'watch.waitingFor', 'Esperando {who} carregar · até 8 s', { who: s.hold.by === me ? WT.tr(t, 'watch.you', 'Você') : (s.hold.n || '') }); }
  else if (sync.status !== 'readyToPlay') { syncWait = true; syncTxt = WT.tr(t, 'watch.loading', 'Carregando…'); }
  else {
    const d = Math.abs(Number(sync.diff) || 0);
    let loc = ''; try { loc = String(t('_locale') || ''); } catch {}
    const ds = d.toFixed(1).replace('.', loc.toLowerCase().startsWith('en') ? '.' : ',');
    syncTxt = peerLabel ? WT.tr(t, 'watch.syncedWith', 'Sincronizado com {who} · diferença {d} s', { who: peerLabel, d: ds }) : WT.tr(t, 'watch.synced', 'Sincronizado · diferença {d} s', { d: ds });
    syncWait = d > 0.5;
  }

  const header = (
    <View style={[st.vhd, { paddingTop: insets.top + 4 }]}>
      <Pressable hitSlop={10} style={st.ib} onPress={() => router.back()} accessibilityLabel={WT.tr(t, 'watch.minimize', 'Minimizar')}>
        <IconChevronDown size={24} color="#fff" />
      </Pressable>
      <View style={{ flex: 1, minWidth: 0, alignItems: music ? 'center' : 'flex-start' }}>
        <Text style={st.hdTitle} numberOfLines={1}>{music ? WT.tr(t, 'watch.listeningTogether', 'Ouvindo junto') : ((item && item.title) || WT.tr(t, 'watch.title', 'Assistir junto'))}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          {live ? <View style={st.dotLive} /> : null}
          <Text style={st.hdSub} numberOfLines={1}>
            {live ? (music ? (convName ? WT.tr(t, 'watch.inConvWith', 'na conversa com {name}', { name: convName }) : '') : WT.tr(t, 'watch.watchingN', 'Assistindo junto · {n} pessoas', { n: Math.max(1, viewers.length) })) : WT.tr(t, 'watch.ended', 'Sessão encerrada')}
          </Text>
        </View>
      </View>
      {live && (isHost || s.ctrl_mode !== 'host') ? (
        <Pressable hitSlop={10} style={st.ib} onPress={endSession} accessibilityLabel={WT.tr(t, 'watch.end', 'Encerrar')}>
          <IconX size={20} color="#fff" />
        </Pressable>
      ) : <View style={st.ib} />}
    </View>
  );

  if (!s) {
    return (
      <View style={[st.root, { alignItems: 'center', justifyContent: 'center' }]}>
        <StatusBar barStyle="light-content" />
        <ActivityIndicator color="#fff" />
        <Pressable style={{ marginTop: 20 }} onPress={() => router.back()}><Text style={{ color: GRAY }}>{WT.tr(t, 'common.close', 'Fechar')}</Text></Pressable>
      </View>
    );
  }

  const timeline = (
    <View style={st.tl}>
      <Pressable onLayout={(e) => setTrackW(e.nativeEvent.layout.width)} onPress={(e) => (canCtl ? seekTo(e.nativeEvent.locationX) : deny())} style={st.track} hitSlop={8}>
        <View style={[st.trackBg, music ? { backgroundColor: 'rgba(255,255,255,0.25)' } : null]} />
        <View style={[st.trackFg, { width: `${pct * 100}%` }]} />
        <View style={[st.knob, { left: `${pct * 100}%` }]} />
      </Pressable>
      <View style={st.tm}>
        <Text style={st.tmTx}>{WT.fmtTime(pos)}</Text>
        <Text style={st.tmTx}>{dur > 0 ? '-' + WT.fmtTime(Math.max(0, dur - pos)) : ''}</Text>
      </View>
    </View>
  );

  const credits = item ? (
    <Pressable onPress={() => { if (item.lic_url) Linking.openURL(item.lic_url).catch(() => {}); }} style={st.credit}>
      <SourceIcon source={item.source} size={13} color={GRAY} />
      <Text style={st.creditTx} numberOfLines={2}>{item.credit || item.title}{item.lic && item.lic !== 'public_domain' && item.lic !== 'conv' ? ' · ' + item.lic : ''}{item.source === 'pd' ? ' · ' + WT.tr(t, 'watch.src.pd', 'Domínio público') : ''}</Text>
    </Pressable>
  ) : null;

  const queue = Array.isArray(s.queue) ? s.queue : [];
  const queuePane = (
    <View>
      {queue.map((q, i) => {
        const cur = i === Number(s.qi);
        return (
          <Pressable key={(q.id || '') + i} style={st.qrow} onPress={() => (cur ? togglePlay() : (canCtl ? doCmd('pick', { index: i }) : deny()))}>
            <View style={st.qth}>
              {q.thumb ? <Image source={{ uri: q.thumb }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : (q.kind === 'audio' ? <IconHeadphones size={18} color="#fff" /> : <IconTogether size={18} color="#fff" />)}
              {cur ? <View style={st.qnow}>{s.playing ? <IconPauseFill size={16} color="#fff" /> : <IconPlayFill size={16} color="#fff" />}</View> : null}
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={st.qTitle} numberOfLines={1}>{q.title}</Text>
              <Text style={st.qSub} numberOfLines={1}>
                {cur ? WT.tr(t, 'watch.nowPlaying', 'Tocando agora') : (q.by && q.by === me ? WT.tr(t, 'watch.addedByYou', 'Adicionado por você') : WT.tr(t, 'watch.inQueue', 'Na fila'))}{q.dur ? ' · ' + WT.fmtTime(q.dur) : ''} · {WT.sourceLabel(t, q)}
              </Text>
            </View>
          </Pressable>
        );
      })}
      {live ? (
        <Pressable style={st.qadd} onPress={openCatalog}>
          <IconPlus size={16} color={GRAY} />
          <Text style={st.qaddTx}>{music ? WT.tr(t, 'watch.addMusic', 'Adicionar música') : WT.tr(t, 'watch.addFromCatalog', 'Adicionar do catálogo')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
  const activityPane = (
    <View>
      {activity.length === 0 ? <Text style={st.empty}>{WT.tr(t, 'watch.activityEmpty', 'Quem pausar, voltar ou trocar aparece aqui.')}</Text> : null}
      {activity.map((a) => (
        <View key={a.k} style={st.vmsg}>
          <IconSync size={13} color={GRAY} />
          <Text style={st.vmsgTx}>{a.txt}</Text>
          <Text style={st.tsx}>{WT.fmtTime(a.at)}</Text>
        </View>
      ))}
    </View>
  );

  const viewersRow = (
    <View style={st.viewers}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }} style={{ flexGrow: 0, flexShrink: 1 }}>
        {(viewers.length ? viewers : [{ e: me, n: WT.tr(t, 'watch.you', 'Você') }]).map((v) => {
          const host = String(v.e).toLowerCase() === String(s.host).toLowerCase();
          const waiting = s.hold && String(s.hold.by).toLowerCase() === String(v.e).toLowerCase() && held;
          return (
            <View key={v.e} style={st.vp}>
              <View>
                <Avatar name={v.n} size={38} />
                <View style={st.vst}><View style={[st.vstDot, waiting ? { backgroundColor: '#ffb224' } : null]} /></View>
              </View>
              <Text style={st.vpName} numberOfLines={1}>{String(v.e).toLowerCase() === me ? WT.tr(t, 'watch.you', 'Você') : v.n}</Text>
              {host ? <Text style={st.hostTag}>{WT.tr(t, 'watch.hostShort', 'anf.')}</Text> : null}
            </View>
          );
        })}
      </ScrollView>
      <View style={{ marginLeft: 'auto', alignItems: 'flex-end', gap: 4 }}>
        <View style={st.pillsw}>
          <Pressable onPress={() => setCtrl('all')} style={[st.pill, s.ctrl_mode !== 'host' ? st.pillOn : null]}>
            <Text style={[st.pillTx, s.ctrl_mode !== 'host' ? st.pillTxOn : null]}>{WT.tr(t, 'watch.ctrlAll', 'Todos controlam')}</Text>
          </Pressable>
          <Pressable onPress={() => setCtrl('host')} style={[st.pill, s.ctrl_mode === 'host' ? st.pillOn : null]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
              <IconCrown size={11} color={s.ctrl_mode === 'host' ? '#000' : GRAY} />
              <Text style={[st.pillTx, s.ctrl_mode === 'host' ? st.pillTxOn : null]}>{isHost ? WT.tr(t, 'watch.ctrlMe', 'Só eu') : WT.tr(t, 'watch.ctrlHost', 'Só o anfitrião')}</Text>
            </View>
          </Pressable>
        </View>
      </View>
    </View>
  );

  const toastEl = toast ? (
    <Animated.View pointerEvents="none" style={[st.syncpop, { top: insets.top + 56, opacity: toastAnim, transform: [{ translateY: toastAnim.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] }) }] }]}>
      <IconSync size={14} color="#000" />
      <Text style={st.syncpopTx} numberOfLines={1}>{toast}</Text>
    </Animated.View>
  ) : null;

  if (music) {
    return (
      <View style={[st.root, { backgroundColor: '#0b0b0c' }]}>
        <StatusBar barStyle="light-content" />
        {item && item.thumb ? <Image source={{ uri: item.thumb }} style={[StyleSheet.absoluteFill, { opacity: 0.35 }]} blurRadius={40} /> : null}
        <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.45)' }]} />
        <WatchPlayer cid={cid} state={s} me={me} audioOnly onSync={setSync} />
        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
          {header}
          <View style={[st.bigart, s.playing ? null : { transform: [{ scale: 0.9 }] }]}>
            {item && item.thumb ? <Image source={{ uri: item.thumb }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : <IconHeadphones size={72} color="rgba(255,255,255,0.8)" />}
          </View>
          <View style={st.minfo}>
            <Text style={st.mTitle} numberOfLines={2}>{item && item.title}</Text>
            <Text style={st.mSub} numberOfLines={1}>{item && (item.artist || item.author)}</Text>
            <View style={{ marginTop: 8, flexDirection: 'row' }}><Badge t={t} item={item} /></View>
          </View>
          {timeline}
          <View style={st.mctrl}>
            <Pressable hitSlop={8} onPress={() => (canCtl ? doCmd('prev') : deny())}><IconPrevTrack size={30} color="#fff" /></Pressable>
            <Pressable onPress={togglePlay} style={st.mmain}>{s.playing && !held ? <IconPauseFill size={30} color="#000" /> : <IconPlayFill size={30} color="#000" />}</Pressable>
            <Pressable hitSlop={8} onPress={() => (canCtl ? doCmd('next') : deny())}><IconNextTrack size={30} color="#fff" /></Pressable>
          </View>
          <View style={[st.sync, { justifyContent: 'center' }]}><View style={[st.syncDot, syncWait ? { backgroundColor: '#ffb224' } : null]} /><Text style={st.syncTx}>{syncTxt}</Text></View>
          {credits}
          <View style={st.together2}>
            <View style={{ flexDirection: 'row' }}>{viewers.slice(0, 4).map((v, i) => <View key={v.e} style={{ marginLeft: i ? -8 : 0 }}><Avatar name={v.n} size={28} ring /></View>)}</View>
            <View style={{ flex: 1 }}>
              <Text style={st.t2b} numberOfLines={1}>{others.length ? WT.tr(t, 'watch.youAndListening', 'Você e {who} ouvindo juntos', { who: peerLabel }) : WT.tr(t, 'watch.waitingOthers', 'Esperando os outros entrarem')}</Text>
              <Text style={st.t2s}>{WT.tr(t, 'watch.sameSecond', 'mesmo segundo em todos os celulares')}</Text>
            </View>
          </View>
          {viewersRow}
          <View style={st.mq}>
            <View style={st.mqh}><Text style={st.mqhTx}>{WT.tr(t, 'watch.upNext', 'A seguir')}</Text><Text style={st.mqhSub}>{s.ctrl_mode === 'host' ? WT.tr(t, 'watch.hostOnly', 'Só o anfitrião controla') : WT.tr(t, 'watch.allCanAdd', 'Todos podem adicionar')}</Text></View>
            {queuePane}
          </View>
        </ScrollView>
        {toastEl}
      </View>
    );
  }

  return (
    <View style={st.root}>
      <StatusBar barStyle="light-content" />
      {header}
      <Pressable onPress={() => setOverlay((o) => !o)} style={st.player}>
        <WatchPlayer cid={cid} state={s} me={me} style={StyleSheet.absoluteFill} onSync={setSync} />
        <View style={st.srcb} pointerEvents="none"><Badge t={t} item={item} dark={false} /></View>
        {overlay || !s.playing || held ? (
          <View style={st.ov}>
            <Pressable hitSlop={10} onPress={() => (canCtl ? seekBy(-10) : deny())}><IconBack10 size={34} color="#fff" /></Pressable>
            <Pressable onPress={() => (canCtl ? togglePlay() : deny())} style={st.big}>
              {held ? <ActivityIndicator color="#fff" /> : (s.playing ? <IconPauseFill size={28} color="#fff" /> : <IconPlayFill size={28} color="#fff" />)}
            </Pressable>
            <Pressable hitSlop={10} onPress={() => (canCtl ? seekBy(10) : deny())}><IconFwd10 size={34} color="#fff" /></Pressable>
          </View>
        ) : null}
      </Pressable>
      {timeline}
      <View style={st.ctrl}>
        <Pressable style={st.cb} onPress={() => setPane('queue')}><IconQueue size={24} color="#fff" /></Pressable>
        <Pressable style={st.cb} onPress={() => (canCtl ? seekBy(-10) : deny())}><IconBack10 size={30} color="#fff" /></Pressable>
        <Pressable style={st.cmain} onPress={() => (canCtl ? togglePlay() : deny())}>{s.playing && !held ? <IconPauseFill size={26} color="#000" /> : <IconPlayFill size={26} color="#000" />}</Pressable>
        <Pressable style={st.cb} onPress={() => (canCtl ? seekBy(10) : deny())}><IconFwd10 size={30} color="#fff" /></Pressable>
        <Pressable style={st.cb} onPress={() => (canCtl ? doCmd('next') : deny())}><IconNextTrack size={22} color="#fff" /></Pressable>
      </View>
      <View style={st.sync}><View style={[st.syncDot, syncWait ? { backgroundColor: '#ffb224' } : null]} /><Text style={st.syncTx} numberOfLines={1}>{syncTxt}</Text></View>
      {viewersRow}
      <View style={st.vtabs}>
        <Pressable style={st.vtab} onPress={() => setPane('activity')}><Text style={[st.vtabTx, pane === 'activity' ? st.vtabOn : null]}>{WT.tr(t, 'watch.activity', 'Atividade')}</Text>{pane === 'activity' ? <View style={st.vtabBar} /> : null}</Pressable>
        <Pressable style={st.vtab} onPress={() => setPane('queue')}><Text style={[st.vtabTx, pane === 'queue' ? st.vtabOn : null]}>{WT.tr(t, 'watch.queueN', 'Fila · {n}', { n: queue.length })}</Text>{pane === 'queue' ? <View style={st.vtabBar} /> : null}</Pressable>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 8, paddingBottom: insets.bottom + 24 }}>
        {pane === 'queue' ? queuePane : activityPane}
        {credits}
      </ScrollView>
      {toastEl}
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  av: { backgroundColor: '#3a3a3c', alignItems: 'center', justifyContent: 'center' },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(255,255,255,0.18)', paddingVertical: 3, paddingLeft: 5, paddingRight: 7, borderRadius: 999, maxWidth: 240 },
  badgeTx: { color: '#fff', fontSize: 10.5, fontWeight: '700' },
  vhd: { paddingHorizontal: 8, paddingBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 6 },
  ib: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  hdTitle: { color: '#fff', fontSize: 15, fontWeight: '700' },
  hdSub: { color: GRAY, fontSize: 12 },
  dotLive: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#ff453a' },
  player: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#111', overflow: 'hidden' },
  srcb: { position: 'absolute', left: 10, top: 10 },
  ov: { ...StyleSheet.absoluteFillObject, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 34, backgroundColor: 'rgba(0,0,0,0.28)' },
  big: { width: 62, height: 62, borderRadius: 31, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' },
  tl: { paddingHorizontal: 14, paddingTop: 10 },
  track: { height: 22, justifyContent: 'center' },
  trackBg: { position: 'absolute', left: 0, right: 0, height: 4, borderRadius: 2, backgroundColor: '#3a3a3c' },
  trackFg: { position: 'absolute', left: 0, height: 4, borderRadius: 2, backgroundColor: '#fff' },
  knob: { position: 'absolute', width: 14, height: 14, borderRadius: 7, marginLeft: -7, backgroundColor: '#fff' },
  tm: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 },
  tmTx: { color: GRAY, fontSize: 11.5, fontVariant: ['tabular-nums'] },
  ctrl: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 10, paddingTop: 4 },
  cb: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  cmain: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  sync: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingTop: 6, paddingHorizontal: 14 },
  syncDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#30a46c' },
  syncTx: { color: GRAY, fontSize: 12 },
  viewers: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#2c2c2e', marginTop: 10 },
  vp: { alignItems: 'center', width: 50, gap: 3 },
  vst: { position: 'absolute', right: -2, bottom: -2, width: 16, height: 16, borderRadius: 8, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  vstDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: '#30a46c' },
  vpName: { color: GRAY, fontSize: 10.5, maxWidth: 50 },
  hostTag: { color: '#fff', backgroundColor: '#3a3a3c', fontSize: 9, fontWeight: '800', paddingHorizontal: 4, borderRadius: 4, overflow: 'hidden', textTransform: 'uppercase' },
  pillsw: { flexDirection: 'row', backgroundColor: '#1c1c1e', borderRadius: 999, padding: 2 },
  pill: { paddingVertical: 4, paddingHorizontal: 9, borderRadius: 999 },
  pillOn: { backgroundColor: '#fff' },
  pillTx: { color: GRAY, fontSize: 11.5, fontWeight: '700' },
  pillTxOn: { color: '#000' },
  vtabs: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#2c2c2e', paddingHorizontal: 8 },
  vtab: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  vtabTx: { color: '#8e8e93', fontSize: 14, fontWeight: '600' },
  vtabOn: { color: '#fff' },
  vtabBar: { position: 'absolute', bottom: -1, left: '30%', right: '30%', height: 2.5, borderRadius: 2, backgroundColor: '#fff' },
  vmsg: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 14, paddingVertical: 5 },
  vmsgTx: { color: '#d1d1d6', fontSize: 13.5, flexShrink: 1 },
  tsx: { color: '#636366', fontSize: 11, backgroundColor: '#1c1c1e', paddingHorizontal: 5, borderRadius: 4, overflow: 'hidden', fontVariant: ['tabular-nums'] },
  empty: { color: '#636366', fontSize: 13, paddingHorizontal: 14, paddingVertical: 10 },
  qrow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 14, paddingVertical: 8 },
  qth: { width: 76, height: 44, borderRadius: 8, overflow: 'hidden', backgroundColor: '#1c1c1e', alignItems: 'center', justifyContent: 'center' },
  qnow: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  qTitle: { color: '#fff', fontSize: 14, fontWeight: '600' },
  qSub: { color: '#8e8e93', fontSize: 12 },
  qadd: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 14, marginVertical: 8, paddingVertical: 11, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', borderColor: '#3a3a3c' },
  qaddTx: { color: GRAY, fontSize: 14, fontWeight: '600' },
  credit: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 14, marginTop: 14, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, borderWidth: 1, borderColor: '#2c2c2e' },
  creditTx: { color: GRAY, fontSize: 11.5, flexShrink: 1 },
  syncpop: { position: 'absolute', alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: 'rgba(255,255,255,0.95)', paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, maxWidth: '90%' },
  syncpopTx: { color: '#000', fontSize: 12.5, fontWeight: '700' },
  bigart: { width: 280, height: 280, alignSelf: 'center', marginTop: 18, borderRadius: 18, overflow: 'hidden', backgroundColor: '#2c2c2e', alignItems: 'center', justifyContent: 'center' },
  minfo: { paddingHorizontal: 26, paddingTop: 22 },
  mTitle: { color: '#fff', fontSize: 21, fontWeight: '800' },
  mSub: { color: 'rgba(255,255,255,0.75)', fontSize: 15, marginTop: 2 },
  mctrl: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-evenly', paddingTop: 8 },
  mmain: { width: 70, height: 70, borderRadius: 35, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  together2: { marginHorizontal: 16, marginTop: 16, padding: 10, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.12)', flexDirection: 'row', alignItems: 'center', gap: 10 },
  t2b: { color: '#fff', fontSize: 13.5, fontWeight: '700' },
  t2s: { color: 'rgba(255,255,255,0.75)', fontSize: 12 },
  mq: { marginHorizontal: 12, marginTop: 10, borderRadius: 18, backgroundColor: 'rgba(0,0,0,0.35)', paddingVertical: 6 },
  mqh: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 8, paddingBottom: 4 },
  mqhTx: { color: '#fff', fontSize: 13, fontWeight: '700' },
  mqhSub: { color: 'rgba(255,255,255,0.6)', fontSize: 12 },
});
