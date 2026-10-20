// app/watch-room.js — [assistir-junto 2026-10-20] Sala "Assistir junto" (tela 3) e "Ouvir junto" (tela 4).
// [fase 2 20/10] nível do mockup preview-2026/assistir-junto.html: player grande, pílula "Ana voltou 10 s",
// chat por cima do vídeo + reações flutuantes (SVG), abas Chat | Fila (fila arrastável), quem está
// assistindo com status (assistindo/carregando), "Todos controlam / Só eu", "Sincronizado · diferença 0,1 s".
// Chat da sala = mensagens NORMAIS da conversa com o tempo do vídeo na frente ("4:21 · que cena").
// Música: fundo desfocado com a capa, capa grande que encolhe ao pausar, Letra (Jamendo, quando houver),
// fila e "Você e Ana ouvindo juntos" com equalizador. Na chamada: botão PiP → janela flutuante na chamada.
// Params: cid (conversa), name (nome da conversa).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, ScrollView, Image, Animated, ActivityIndicator, Linking, StatusBar,
  TextInput, KeyboardAvoidingView, Platform, PanResponder, Easing,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import * as WT from '../services/watchTogether';
import WatchPlayer from '../components/watch/WatchPlayer';
import {
  IconChevronDown, IconPlayFill, IconPauseFill, IconBack10, IconFwd10, IconNextTrack, IconPrevTrack, IconQueue,
  IconSync, IconCrown, SourceIcon, IconHeadphones, IconTogether, IconHeart, IconLaugh, IconFire, IconWow, IconPip, IconGrip, IconLyrics, IconChat,
} from '../components/watch/WatchIcons';
import { IconPlus, IconX } from '../components/Icons';

const GRAY = '#a1a1a6';
const REACTS = [['heart', IconHeart], ['laugh', IconLaugh], ['fire', IconFire], ['wow', IconWow]];
const REACT_ICON = { heart: IconHeart, laugh: IconLaugh, fire: IconFire, wow: IconWow };
const ROW_H = 60;
const TIME_RE = /^(\d{1,2}:\d{2}(?::\d{2})?) · ([\s\S]+)$/;

function initials(n) {
  const p = String(n || '?').trim().split(/\s+/).filter(Boolean);
  return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}
const SHADES = ['#48484a', '#3a3a3c', '#636366', '#2c2c2e', '#8e8e93'];
function shadeOf(s) { let h = 0; for (const ch of String(s || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return SHADES[h % SHADES.length]; }
function Avatar({ name, email, size = 34, ring }) {
  return (
    <View style={[st.av, { width: size, height: size, borderRadius: size / 2, backgroundColor: shadeOf(email || name) }, ring ? { borderWidth: 2, borderColor: ring } : null]}>
      <Text style={{ color: '#fff', fontWeight: '700', fontSize: size * 0.38 }}>{initials(name)}</Text>
    </View>
  );
}
function Badge({ t, item, light }) {
  return (
    <View style={[st.badge, light ? { backgroundColor: 'rgba(255,255,255,0.92)' } : null]}>
      <SourceIcon source={item && item.source} size={12} color={light ? '#0b0b0c' : '#fff'} />
      <Text style={[st.badgeTx, light ? { color: '#0b0b0c' } : null]} numberOfLines={1}>{WT.sourceLabel(t, item)}</Text>
    </View>
  );
}

/** Pontinho pulsando (AO VIVO / esperando). */
function Pulse({ color = '#ff453a', size = 7 }) {
  const a = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const l = Animated.loop(Animated.sequence([
      Animated.timing(a, { toValue: 0.35, duration: 700, useNativeDriver: true }),
      Animated.timing(a, { toValue: 1, duration: 700, useNativeDriver: true }),
    ]));
    l.start();
    return () => l.stop();
  }, [a]);
  return <Animated.View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity: a }} />;
}

/** Equalizador animado (4 barras) — "ouvindo juntos". */
export function Eq({ playing, color = '#fff', h = 14 }) {
  const bars = useRef([0, 1, 2, 3].map(() => new Animated.Value(0.3))).current;
  useEffect(() => {
    if (!playing) { bars.forEach((b) => b.setValue(0.25)); return undefined; }
    const loops = bars.map((b, i) => Animated.loop(Animated.sequence([
      Animated.timing(b, { toValue: 1, duration: 380 + i * 90, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(b, { toValue: 0.2, duration: 380 + i * 70, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ])));
    loops.forEach((l, i) => setTimeout(() => l.start(), i * 120));
    return () => loops.forEach((l) => l.stop());
  }, [playing, bars]);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: h, gap: 2 }}>
      {bars.map((b, i) => <Animated.View key={i} style={{ width: 3, height: h, borderRadius: 1, backgroundColor: color, transform: [{ scaleY: b }] }} />)}
    </View>
  );
}

/** Reação que sobe e some (2,2 s). */
function Floater({ r, x, onDone }) {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => { Animated.timing(a, { toValue: 1, duration: 2200, easing: Easing.out(Easing.quad), useNativeDriver: true }).start(onDone); }, [a, onDone]);
  const Ic = REACT_ICON[r] || IconHeart;
  return (
    <Animated.View pointerEvents="none" style={{
      position: 'absolute', bottom: 0, right: x,
      opacity: a.interpolate({ inputRange: [0, 0.12, 0.8, 1], outputRange: [0, 1, 1, 0] }),
      transform: [
        { translateY: a.interpolate({ inputRange: [0, 1], outputRange: [0, -170] }) },
        { translateX: a.interpolate({ inputRange: [0, 1], outputRange: [0, -30] }) },
        { scale: a.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0.6, 1.1, 1] }) },
      ],
    }}>
      <Ic size={30} color="#fff" />
    </Animated.View>
  );
}

/** Mensagem por cima do vídeo (5 s). */
function OverMsg({ m, onDone }) {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.sequence([
      Animated.timing(a, { toValue: 1, duration: 250, useNativeDriver: true }),
      Animated.delay(3800),
      Animated.timing(a, { toValue: 0, duration: 700, useNativeDriver: true }),
    ]).start(onDone);
  }, [a, onDone]);
  return (
    <Animated.View style={[st.ovMsg, { opacity: a, transform: [{ translateY: a.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }] }]}>
      <Text style={st.ovMsgTx} numberOfLines={2}><Text style={{ fontWeight: '800' }}>{m.n} </Text>{m.text}</Text>
    </Animated.View>
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
  const myName = String((user && (user.name || user.display_name)) || '').trim();
  const [s, setS] = useState(() => WT.getSession(cid));
  const [pane, setPane] = useState('chat');
  const [overlay, setOverlay] = useState(true);
  const [sync, setSync] = useState({ status: 'loading', diff: null });
  const [chat, setChat] = useState([]); // {k, e, n, text, ts(s do vídeo) | ev}
  const [over, setOver] = useState([]);
  const [floats, setFloats] = useState([]);
  const [toast, setToast] = useState(null);
  const [trackW, setTrackW] = useState(1);
  const [draft, setDraft] = useState('');
  const [lyr, setLyr] = useState(null);
  const [duck, setDuck] = useState(WT.isCallSpeaking());
  const [, setTick] = useState(0);
  const toastAnim = useRef(new Animated.Value(0)).current;
  const toastTimer = useRef(null);
  const lastSeq = useRef(0);
  const seenMsg = useRef(new Set());
  const scrollRef = useRef(null);
  const sRef = useRef(s);
  sRef.current = s;

  const you = WT.tr(t, 'watch.you', 'Você');
  const nameOf = useCallback((email, fb) => {
    const e = String(email || '').toLowerCase();
    if (e === me) return you;
    const v = (sRef.current && sRef.current.viewers || []).find((x) => String(x.e).toLowerCase() === e);
    return (v && v.n) || fb || e.split('@')[0];
  }, [me, you]);

  const showToast = useCallback((txt, who) => {
    setToast({ txt, who });
    clearTimeout(toastTimer.current);
    Animated.timing(toastAnim, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    toastTimer.current = setTimeout(() => Animated.timing(toastAnim, { toValue: 0, duration: 250, useNativeDriver: true }).start(), 2400);
  }, [toastAnim]);

  const describe = useCallback((ns) => {
    const who = ns.by && ns.by === me ? you : (ns.by_name || '');
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
      case 'buffer': return ns.hold ? WT.tr(t, 'watch.ev.waiting', 'Esperando {who} carregar', { who: ns.hold.by === me ? you : (ns.hold.n || '') }) : '';
      case 'join': return WT.tr(t, 'watch.ev.join', '{who} entrou', { who });
      case 'end': return WT.tr(t, 'watch.ev.end', '{who} encerrou a sessão', { who });
      default: return '';
    }
  }, [me, t, you]);

  const pushFloat = useCallback((r) => {
    const id = Date.now() + Math.random();
    setFloats((f) => [...f.slice(-14), { id, r, x: 10 + Math.random() * 70 }]);
  }, []);
  const pushOver = useCallback((m) => setOver((o) => [...o.slice(-2), m]), []);

  // estado da sala
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
      if (['play', 'pause', 'seek', 'pick', 'next', 'prev', 'end'].includes(ns.cmd)) {
        setChat((c) => [...c.slice(-150), { k: 'ev' + ns.sid + ns.seq, ev: txt, ts: WT.positionAt(ns, Number(ns.server_ts)) }]);
      }
      if (ns.by && ns.by !== me && ['play', 'pause', 'seek', 'pick', 'next', 'prev'].includes(ns.cmd)) {
        const follow = ns.cmd === 'seek' || ns.cmd === 'play' || ns.cmd === 'pause' ? ' · ' + WT.tr(t, 'watch.youFollowed', 'você foi junto') : '';
        showToast(txt + follow, { e: ns.by, n: ns.by_name });
      }
      if (ns.cmd === 'buffer' && ns.hold && ns.hold.by !== me) showToast(txt, { e: ns.hold.by, n: ns.hold.n });
    });
    const offR = WT.onReact(cid, (d) => { if (d && d.e !== me) pushFloat(d.r); });
    const leave = WT.enterRoom(cid);
    WT.refresh(cid).then((x) => { if (x) setS(x); }).catch(() => {});
    const iv = setInterval(() => setTick((n) => (n + 1) % 1e6), 500);
    const offSp = WT.onCallSpeaking(setDuck);
    return () => { off(); offR(); offSp(); leave(); clearInterval(iv); clearTimeout(toastTimer.current); };
  }, [cid, describe, me, showToast, pushFloat, t]);

  // chat da sala = mensagens de texto da conversa que chegam enquanto a sala está aberta
  useEffect(() => {
    if (!cid) return undefined;
    let ws = null; try { ws = require('../services/websocket').default; } catch {}
    if (!ws) return undefined;
    const onMsg = (d) => {
      const m = (d && d.message) || d || {};
      if (String(m.conversation_id || '') !== cid || !m.id || (m.type && m.type !== 'text')) return;
      if (seenMsg.current.has(String(m.id))) return;
      seenMsg.current.add(String(m.id));
      const raw = String(m.content || '').trim();
      if (!raw || raw.startsWith('{')) return;
      const mm = raw.match(TIME_RE);
      const e = String(m.sender_email || '').toLowerCase();
      if (e === me) return; // os meus já entram na hora do envio
      const n = m.sender_name || nameOf(e);
      const item = { k: 'm' + m.id, e, n, text: mm ? mm[2] : raw, tl: mm ? mm[1] : '' };
      setChat((c) => [...c.slice(-150), item]);
      pushOver(item);
    };
    const a = ws.on('chat_message', onMsg);
    const b = ws.on('chat_summary', onMsg);
    return () => { try { a && a(); b && b(); } catch {} };
  }, [cid, me, nameOf, pushOver]);

  useEffect(() => {
    if (!overlay || !(s && s.playing)) return undefined;
    const id = setTimeout(() => setOverlay(false), 3500);
    return () => clearTimeout(id);
  }, [overlay, s && s.playing, s && s.seq]);

  const item = s && s.item;
  const music = s && s.kind === 'music';
  // letra (Jamendo) — só quando o servidor tem
  useEffect(() => {
    setLyr(null);
    if (!music || !item || !/^jm-/.test(String(item.id || ''))) return undefined;
    let alive = true;
    WT.lyrics(item.id).then((v) => { if (alive) setLyr(v || ''); }).catch(() => {});
    return () => { alive = false; };
  }, [music, item && item.id]);

  // música: o player mora no WatchAudioHost (raiz) → continua fora da sala e em 2º plano
  useEffect(() => {
    if (!music || !cid) return undefined;
    WT.setListening(cid);
    setSync(WT.getSyncStatus(cid) || { status: 'loading', diff: null });
    return WT.onSyncStatus((k, st) => { if (k === cid) setSync(st); });
  }, [music, cid]);

  const artScale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.spring(artScale, { toValue: s && s.playing ? 1 : 0.88, useNativeDriver: true, friction: 7, tension: 60 }).start();
  }, [s && s.playing, artScale]);

  const live = WT.isLive(s);
  const canCtl = WT.canControl(s, me);
  const isHost = !!(s && String(s.host || '').toLowerCase() === me);
  const pos = s ? WT.positionNow(s) : 0;
  const dur = Number(item && item.dur) || 0;
  const pct = dur > 0 ? Math.min(1, pos / dur) : 0;
  const held = WT.isHeld(s);
  const viewers = WT.viewersOf(s);
  const others = viewers.filter((v) => String(v.e).toLowerCase() !== me);
  const peerLabel = others.length === 1 ? others[0].n : (others.length > 1 ? WT.tr(t, 'watch.nPeople', '{n} pessoas', { n: others.length }) : (convName || ''));
  const callNow = WT.inCall();
  // iOS: o expo-video do binário atual troca a sessão de áudio p/ .playback e derruba o áudio do CallKit.
  // Na ligação o player só monta com o binário que tem o patch (liga por OTA: __chatyy_watch_call_ios = true).
  const callBlocked = callNow && WT.callPlaybackBlocked();

  const deny = useCallback(() => showToast(WT.tr(t, 'watch.hostOnly', 'Só o anfitrião controla')), [showToast, t]);
  const doCmd = useCallback(async (name, args) => {
    if (!sRef.current) return;
    if (!WT.canControl(sRef.current, me) && ['play', 'pause', 'seek', 'next', 'prev', 'pick'].includes(name)) { deny(); return; }
    const r = await WT.cmd(cid, name, { ...(args || {}), _me: me });
    if (!r.ok && r.error === 'host_only') deny();
    else if (!r.ok && r.error !== 'timeout') WT.refresh(cid).catch(() => {});
  }, [cid, me, deny]);
  const myEv = (txt) => setChat((c) => [...c.slice(-150), { k: 'me' + Date.now(), ev: txt, ts: WT.positionNow(sRef.current) }]);
  const togglePlay = () => {
    if (!s) return;
    if (!canCtl) { deny(); return; }
    if (s.playing) { doCmd('pause', { pos: WT.positionNow(s) }); myEv(WT.tr(t, 'watch.ev.pause', '{who} pausou', { who: you })); }
    else { doCmd('play', { pos: dur > 0 && pos >= dur - 0.5 ? 0 : WT.positionNow(s) }); myEv(WT.tr(t, 'watch.ev.play', '{who} continuou', { who: you })); }
    setOverlay(true);
  };
  const seekBy = (d) => {
    if (!s) return;
    if (!canCtl) { deny(); return; }
    const p = Math.max(0, Math.min(dur || 1e9, WT.positionNow(s) + d));
    doCmd('seek', { pos: p, delta: d });
    const txt = d < 0 ? WT.tr(t, 'watch.ev.back', '{who} voltou {n} s', { who: you, n: Math.abs(d) }) : WT.tr(t, 'watch.ev.fwd', '{who} avançou {n} s', { who: you, n: d });
    myEv(txt);
    showToast(txt + (peerLabel ? ' · ' + WT.tr(t, 'watch.syncedWithShort', 'sincronizado com {who}', { who: peerLabel }) : ''), { e: me, n: myName || you });
    setOverlay(true);
  };
  const seekTo = (x) => { if (!s || !dur) return; if (!canCtl) { deny(); return; } const p = Math.max(0, Math.min(dur, (x / Math.max(1, trackW)) * dur)); doCmd('seek', { pos: p, delta: Math.round(p - WT.positionNow(s)) }); };
  const setCtrl = (mode) => {
    if (!isHost) { deny(); return; }
    WT.cmd(cid, 'ctrl', { mode }).catch(() => {});
    showToast(mode === 'host' ? WT.tr(t, 'watch.ctrlHostOn', 'Só o anfitrião controla') : WT.tr(t, 'watch.ctrlAllOn', 'Todos podem controlar'));
  };
  const openCatalog = () => router.push({ pathname: music ? '/listen-catalog' : '/watch-catalog', params: { cid, name: convName, tab: music ? '' : 'filmes', mode: 'add' } });
  const goPip = () => { WT.setPip({ cid, name: convName }); router.back(); };
  const endSession = () => {
    try {
      require('../services/alerts').safeAlert(WT.tr(t, 'watch.endTitle', 'Encerrar a sessão?'), WT.tr(t, 'watch.endBody', 'Todo mundo para de assistir. O cartão fica na conversa.'), [
        { text: WT.tr(t, 'common.cancel', 'Cancelar'), style: 'cancel' },
        { text: WT.tr(t, 'watch.end', 'Encerrar'), style: 'destructive', onPress: () => { WT.cmd(cid, 'end').then(() => router.back()).catch(() => {}); } },
      ]);
    } catch {}
  };
  const sendReact = (r) => { pushFloat(r); WT.react(cid, r, WT.positionNow(sRef.current)).catch(() => {}); };
  const sendChat = async () => {
    const txt = draft.trim();
    if (!txt || !s) return;
    setDraft('');
    const tl = WT.fmtTime(WT.positionNow(s));
    const mine = { k: 'mine' + Date.now(), e: me, n: you, text: txt, tl };
    setChat((c) => [...c.slice(-150), mine]);
    pushOver(mine);
    try {
      const api = require('../services/api');
      const r = await api.chatSend(cid, `${tl} · ${txt}`, 'text');
      const id = r && r.data && (r.data.id ?? r.data.message_id);
      if (id != null) seenMsg.current.add(String(id));
    } catch {}
  };

  // sincronia (texto + cor)
  let syncTxt = '';
  let syncWait = false;
  if (!live) syncTxt = WT.tr(t, 'watch.ended', 'Sessão encerrada');
  else if (held) { syncWait = true; syncTxt = WT.tr(t, 'watch.waitingFor', 'Esperando {who} carregar · até 8 s', { who: s.hold.by === me ? you : (s.hold.n || '') }); }
  else if (sync.status !== 'readyToPlay') { syncWait = true; syncTxt = WT.tr(t, 'watch.loading', 'Carregando…'); }
  else {
    const d = Math.abs(Number(sync.diff) || 0);
    let loc = ''; try { loc = String(t('_locale') || ''); } catch {}
    const ds = d.toFixed(1).replace('.', loc.toLowerCase().startsWith('en') ? '.' : ',');
    syncTxt = peerLabel ? WT.tr(t, 'watch.syncedWith', 'Sincronizado com {who} · diferença {d} s', { who: peerLabel, d: ds }) : WT.tr(t, 'watch.synced', 'Sincronizado · diferença {d} s', { d: ds });
    syncWait = d > 0.5;
  }

  // fila arrastável (segurar a alça e arrastar)
  const [drag, setDrag] = useState(null); // {from, dy}
  const dragRef = useRef(null);
  const makeGrip = (i) => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => { if (!WT.canControl(sRef.current, me)) { deny(); return; } dragRef.current = { from: i, dy: 0 }; setDrag({ from: i, dy: 0 }); },
    onPanResponderMove: (_, g) => { if (!dragRef.current) return; dragRef.current = { from: i, dy: g.dy }; setDrag({ from: i, dy: g.dy }); },
    onPanResponderRelease: (_, g) => {
      const d = dragRef.current; dragRef.current = null; setDrag(null);
      if (!d) return;
      const n = ((sRef.current && sRef.current.queue) || []).length;
      const to = Math.max(0, Math.min(n - 1, d.from + Math.round(g.dy / ROW_H)));
      if (to !== d.from) WT.queueMove(cid, d.from, to).then((r) => { if (!r.ok && r.error === 'host_only') deny(); }).catch(() => {});
    },
    onPanResponderTerminate: () => { dragRef.current = null; setDrag(null); },
  });

  const header = (
    <View style={[st.vhd, { paddingTop: insets.top + 4 }]}>
      <Pressable hitSlop={10} style={st.ib} onPress={() => router.back()} accessibilityLabel={WT.tr(t, 'watch.minimize', 'Minimizar')}>
        <IconChevronDown size={24} color="#fff" />
      </Pressable>
      <View style={{ flex: 1, minWidth: 0, alignItems: music ? 'center' : 'flex-start' }}>
        <Text style={st.hdTitle} numberOfLines={1}>{music ? WT.tr(t, 'watch.listeningTogether', 'Ouvindo junto') : ((item && item.title) || WT.tr(t, 'watch.title', 'Assistir junto'))}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          {live ? <Pulse /> : null}
          <Text style={st.hdSub} numberOfLines={1}>
            {live ? (music ? (convName ? WT.tr(t, 'watch.inConvWith', 'na conversa com {name}', { name: convName }) : '') : WT.tr(t, 'watch.watchingN', 'Assistindo junto · {n} pessoas', { n: Math.max(1, viewers.length) })) : WT.tr(t, 'watch.ended', 'Sessão encerrada')}
          </Text>
        </View>
      </View>
      {live && callNow && !callBlocked ? (
        <Pressable hitSlop={8} style={st.ib} onPress={goPip} accessibilityLabel={WT.tr(t, 'watch.pip', 'Janela flutuante')}><IconPip size={22} color="#fff" /></Pressable>
      ) : null}
      {live && (isHost || s.ctrl_mode !== 'host') ? (
        <Pressable hitSlop={10} style={st.ib} onPress={endSession} accessibilityLabel={WT.tr(t, 'watch.end', 'Encerrar')}><IconX size={20} color="#fff" /></Pressable>
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

  const viewerPin = others[0];
  const timeline = (
    <View style={st.tl}>
      <Pressable onLayout={(e) => setTrackW(e.nativeEvent.layout.width)} onPress={(e) => seekTo(e.nativeEvent.locationX)} style={st.track} hitSlop={8}>
        <View style={[st.trackBg, music ? { backgroundColor: 'rgba(255,255,255,0.25)' } : null]} />
        {!music ? <View style={[st.trackBuf, { width: `${Math.min(100, pct * 100 + 12)}%` }]} /> : null}
        <View style={[st.trackFg, { width: `${pct * 100}%` }]} />
        <View style={[st.knob, { left: `${pct * 100}%` }]} />
        {!music && viewerPin ? <View style={[st.pin, { left: `${pct * 100}%` }]}><Avatar name={viewerPin.n} email={viewerPin.e} size={18} ring="#000" /></View> : null}
      </Pressable>
      <View style={st.tm}>
        <Text style={[st.tmTx, music ? { color: 'rgba(255,255,255,0.7)' } : null]}>{WT.fmtTime(pos)}</Text>
        <Text style={[st.tmTx, music ? { color: 'rgba(255,255,255,0.7)' } : null]}>{dur > 0 ? '-' + WT.fmtTime(Math.max(0, dur - pos)) : ''}</Text>
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
        const dragging = drag && drag.from === i;
        const grip = makeGrip(i);
        return (
          <View key={(q.id || '') + i} style={[st.qrow, dragging ? { transform: [{ translateY: drag.dy }], backgroundColor: music ? 'rgba(255,255,255,0.12)' : '#1c1c1e', zIndex: 5, borderRadius: 12 } : null]}>
            <Pressable style={st.qth} onPress={() => (cur ? togglePlay() : (canCtl ? doCmd('pick', { index: i }) : deny()))}>
              {q.thumb ? <Image source={{ uri: q.thumb }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : (q.kind === 'audio' ? <IconHeadphones size={18} color="#fff" /> : <IconTogether size={18} color="#fff" />)}
              {cur ? <View style={st.qnow}>{s.playing ? (music ? <Eq playing color="#fff" /> : <IconPauseFill size={16} color="#fff" />) : <IconPlayFill size={16} color="#fff" />}</View> : null}
            </Pressable>
            <Pressable style={{ flex: 1, minWidth: 0 }} onPress={() => (cur ? togglePlay() : (canCtl ? doCmd('pick', { index: i }) : deny()))}>
              <Text style={[st.qTitle, cur && music ? { textDecorationLine: 'underline' } : null]} numberOfLines={1}>{q.title}</Text>
              <Text style={[st.qSub, music ? { color: 'rgba(255,255,255,0.65)' } : null]} numberOfLines={1}>
                {cur ? WT.tr(t, 'watch.nowPlaying', 'Tocando agora') : (q.by && q.by === me ? WT.tr(t, 'watch.addedByYou', 'Adicionado por você') : WT.tr(t, 'watch.addedBy', 'Adicionado por {name}', { name: nameOf(q.by, '') }))}{q.dur ? ' · ' + WT.fmtTime(q.dur) : ''} · {WT.sourceLabel(t, q)}
              </Text>
            </Pressable>
            {queue.length > 1 ? <View {...grip.panHandlers} style={st.grip} hitSlop={8}><IconGrip size={18} color="#636366" /></View> : null}
          </View>
        );
      })}
      {live ? (
        <Pressable style={[st.qadd, music ? { borderColor: 'rgba(255,255,255,0.25)' } : null]} onPress={openCatalog}>
          <IconPlus size={16} color={music ? '#fff' : GRAY} />
          <Text style={[st.qaddTx, music ? { color: '#fff' } : null]}>{music ? WT.tr(t, 'watch.addMusic', 'Adicionar música') : WT.tr(t, 'watch.addFromCatalog', 'Adicionar do catálogo')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
  const chatPane = (
    <View>
      {chat.length === 0 ? <Text style={st.empty}>{WT.tr(t, 'watch.chatEmpty', 'Comente aqui: vira mensagem da conversa com o tempo do vídeo.')}</Text> : null}
      {chat.map((m) => (m.ev ? (
        <View key={m.k} style={st.vmsg}>
          <IconSync size={13} color="#8e8e93" />
          <Text style={st.evTx}>{m.ev}</Text>
          <Text style={st.tsx}>{WT.fmtTime(m.ts)}</Text>
        </View>
      ) : (
        <View key={m.k} style={st.vmsg}>
          <Avatar name={m.n} email={m.e} size={28} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Text style={st.vmsgName}>{m.n}</Text>
              {m.tl ? <Text style={st.tsx}>{m.tl}</Text> : null}
            </View>
            <Text style={st.vmsgTx}>{m.text}</Text>
          </View>
        </View>
      )))}
    </View>
  );

  const viewersRow = (
    <View style={[st.viewers, music ? { borderTopColor: 'rgba(255,255,255,0.12)' } : null]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }} style={{ flexGrow: 0, flexShrink: 1 }}>
        {(viewers.length ? viewers : [{ e: me, n: you }]).map((v) => {
          const host = String(v.e).toLowerCase() === String(s.host).toLowerCase();
          const waiting = held && s.hold && String(s.hold.by).toLowerCase() === String(v.e).toLowerCase();
          return (
            <View key={v.e} style={st.vp}>
              <View>
                <Avatar name={v.n} email={v.e} size={38} />
                <View style={st.vst}><View style={[st.vstDot, waiting ? { backgroundColor: '#ffb224' } : null]} /></View>
              </View>
              <Text style={st.vpName} numberOfLines={1}>{String(v.e).toLowerCase() === me ? you : (waiting ? WT.tr(t, 'watch.loadingShort', 'Carregando') : v.n)}</Text>
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
    <Animated.View pointerEvents="none" style={[st.syncpop, { top: insets.top + 58, opacity: toastAnim, transform: [{ translateY: toastAnim.interpolate({ inputRange: [0, 1], outputRange: [-10, 0] }) }] }]}>
      {toast.who ? <Avatar name={toast.who.n} email={toast.who.e} size={22} /> : <View style={{ width: 4 }} />}
      <Text style={st.syncpopTx} numberOfLines={1}>{toast.txt}</Text>
    </Animated.View>
  ) : null;

  const composer = live ? (
    <View style={[st.rbar, { paddingBottom: Math.max(insets.bottom, 10) }]}>
      <TextInput value={draft} onChangeText={setDraft} placeholder={music ? WT.tr(t, 'watch.commentMusic', 'Comentar a música') : WT.tr(t, 'watch.commentPh', 'Comentar no vídeo')} placeholderTextColor="#8e8e93"
        style={st.rin} returnKeyType="send" onSubmitEditing={sendChat} blurOnSubmit={false} maxLength={500} />
      {draft.trim() ? (
        <Pressable onPress={sendChat} style={[st.rbtn, { backgroundColor: '#fff' }]} accessibilityLabel={WT.tr(t, 'common.send', 'Enviar')}><IconPlayFill size={16} color="#000" /></Pressable>
      ) : REACTS.map(([r, Ic]) => (
        <Pressable key={r} onPress={() => sendReact(r)} style={st.rbtn} hitSlop={4} accessibilityLabel={WT.tr(t, 'watch.react.' + r, r)}><Ic size={19} color="#fff" /></Pressable>
      ))}
    </View>
  ) : null;

  const floatLayer = (
    <View pointerEvents="none" style={st.rx}>
      {floats.map((f) => <Floater key={f.id} r={f.r} x={f.x} onDone={() => setFloats((x) => x.filter((y) => y.id !== f.id))} />)}
    </View>
  );

  if (music) {
    const tabs = [['lyrics', IconLyrics, WT.tr(t, 'watch.lyrics', 'Letra')], ['queue', IconQueue, WT.tr(t, 'watch.queue', 'Fila')], ['chat', IconChat, WT.tr(t, 'watch.chat', 'Chat')]];
    const mpane = pane === 'activity' ? 'chat' : pane;
    return (
      <KeyboardAvoidingView style={[st.root, { backgroundColor: '#0b0b0c' }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <StatusBar barStyle="light-content" />
        {item && item.thumb ? <Image source={{ uri: item.thumb }} style={[StyleSheet.absoluteFill, { transform: [{ scale: 1.4 }], opacity: 0.85 }]} blurRadius={60} /> : null}
        <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.35)' }]} />
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { top: '45%', backgroundColor: 'rgba(0,0,0,0.45)' }]} />
        <ScrollView ref={scrollRef} contentContainerStyle={{ paddingBottom: 20 }} keyboardShouldPersistTaps="handled">
          {header}
          {mpane === 'lyrics' && lyr ? (
            <View style={st.lyr}>
              <ScrollView nestedScrollEnabled showsVerticalScrollIndicator={false}>
                <Text style={st.lyrTx}>{lyr}</Text>
                <Text style={st.lyrCredit}>{WT.tr(t, 'watch.lyricsBy', 'Letra enviada pelo artista · {lic}', { lic: (item && item.lic) || 'CC' })}</Text>
              </ScrollView>
            </View>
          ) : (
            <Animated.View style={[st.bigart, { transform: [{ scale: artScale }] }]}>
              {item && item.thumb ? <Image source={{ uri: item.thumb }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : <IconHeadphones size={72} color="rgba(255,255,255,0.8)" />}
            </Animated.View>
          )}
          <View style={st.minfo}>
            <Text style={st.mTitle} numberOfLines={2}>{item && item.title}</Text>
            <Text style={st.mSub} numberOfLines={1}>{item && (item.artist || item.author)}</Text>
            <View style={{ marginTop: 6, flexDirection: 'row' }}><Badge t={t} item={item} /></View>
          </View>
          {timeline}
          <View style={st.mctrl}>
            <Pressable hitSlop={8} onPress={() => (canCtl ? doCmd('prev') : deny())}><IconPrevTrack size={32} color="#fff" /></Pressable>
            <Pressable onPress={togglePlay} style={st.mmain}>{s.playing && !held ? <IconPauseFill size={30} color="#000" /> : <IconPlayFill size={30} color="#000" />}</Pressable>
            <Pressable hitSlop={8} onPress={() => (canCtl ? doCmd('next') : deny())}><IconNextTrack size={32} color="#fff" /></Pressable>
          </View>
          <View style={[st.sync, { justifyContent: 'center' }]}>{syncWait ? <Pulse color="#ffb224" /> : <View style={st.syncDot} />}<Text style={[st.syncTx, { color: 'rgba(255,255,255,0.7)' }]}>{syncTxt}</Text></View>
          <View style={st.together2}>
            <View style={{ flexDirection: 'row' }}>{(viewers.length ? viewers : [{ e: me, n: you }]).slice(0, 4).map((v, i) => <View key={v.e} style={{ marginLeft: i ? -8 : 0 }}><Avatar name={v.n} email={v.e} size={28} ring="rgba(0,0,0,0.35)" /></View>)}</View>
            <View style={{ flex: 1 }}>
              <Text style={st.t2b} numberOfLines={1}>{others.length ? WT.tr(t, 'watch.youAndListening', 'Você e {who} ouvindo juntos', { who: peerLabel }) : WT.tr(t, 'watch.waitingOthers', 'Esperando os outros entrarem')}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Eq playing={!!(s.playing && !held)} color="rgba(255,255,255,0.85)" h={12} />
                <Text style={st.t2s}>{WT.tr(t, 'watch.sameSecond', 'mesmo segundo em todos os celulares')}</Text>
              </View>
            </View>
            <Pressable onPress={() => router.back()} style={st.sw2}><Text style={st.sw2Tx}>{WT.tr(t, 'watch.inChat', 'Na conversa')}</Text></Pressable>
          </View>
          <View style={st.mtabs}>
            {tabs.map(([k, Ic, lbl]) => (
              <Pressable key={k} onPress={() => setPane(k)} style={[st.mtab, mpane === k ? null : { opacity: 0.55 }]}>
                <Ic size={20} color="#fff" />
                <Text style={st.mtabTx}>{lbl}</Text>
              </Pressable>
            ))}
          </View>
          <View style={st.mq}>
            {mpane === 'queue' ? (
              <>
                <View style={st.mqh}><Text style={st.mqhTx}>{WT.tr(t, 'watch.upNext', 'A seguir')}</Text><Text style={st.mqhSub}>{s.ctrl_mode === 'host' ? WT.tr(t, 'watch.hostOnly', 'Só o anfitrião controla') : WT.tr(t, 'watch.allCanAdd', 'Todos podem adicionar')}</Text></View>
                {queuePane}
              </>
            ) : mpane === 'lyrics' ? (
              <Text style={st.empty}>{lyr === null ? WT.tr(t, 'watch.loading', 'Carregando…') : (lyr ? WT.tr(t, 'watch.lyricsShown', 'A letra está no lugar da capa. Toque em Fila para voltar.') : WT.tr(t, 'watch.noLyrics', 'Esta faixa não tem letra (ou é instrumental).'))}</Text>
            ) : chatPane}
          </View>
          {credits}
          {viewersRow}
        </ScrollView>
        {floatLayer}
        {composer}
        {toastEl}
      </KeyboardAvoidingView>
    );
  }

  return (
    <KeyboardAvoidingView style={st.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <StatusBar barStyle="light-content" />
      {header}
      <Pressable onPress={() => setOverlay((o) => !o)} style={st.player}>
        {callBlocked ? (
          <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', padding: 24 }]}>
            <Text style={{ color: '#fff', fontSize: 14, textAlign: 'center' }}>{WT.tr(t, 'watch.callBlocked', 'Durante a ligação o vídeo fica pausado aqui. Termine a ligação para continuar assistindo.')}</Text>
          </View>
        ) : <WatchPlayer cid={cid} state={s} me={me} style={StyleSheet.absoluteFill} onSync={setSync} duck={duck} />}
        <View style={st.srcb} pointerEvents="none"><Badge t={t} item={item} light /></View>
        <View pointerEvents="none" style={st.ovchat}>
          {over.map((m) => <OverMsg key={m.k} m={m} onDone={() => setOver((o) => o.filter((x) => x.k !== m.k))} />)}
        </View>
        {floatLayer}
        {overlay || !s.playing || held ? (
          <View style={st.ov}>
            <Pressable hitSlop={10} onPress={() => seekBy(-10)}><IconBack10 size={36} color="#fff" /></Pressable>
            <Pressable onPress={togglePlay} style={st.big}>
              {held ? <ActivityIndicator color="#fff" /> : (s.playing ? <IconPauseFill size={28} color="#fff" /> : <IconPlayFill size={28} color="#fff" />)}
            </Pressable>
            <Pressable hitSlop={10} onPress={() => seekBy(10)}><IconFwd10 size={36} color="#fff" /></Pressable>
          </View>
        ) : null}
      </Pressable>
      {timeline}
      <View style={st.ctrl}>
        <Pressable style={st.cb} onPress={() => setPane('queue')}><IconQueue size={24} color="#fff" /></Pressable>
        <Pressable style={st.cb} onPress={() => seekBy(-10)}><IconBack10 size={32} color="#fff" /></Pressable>
        <Pressable style={st.cmain} onPress={togglePlay}>{s.playing && !held ? <IconPauseFill size={26} color="#000" /> : <IconPlayFill size={26} color="#000" />}</Pressable>
        <Pressable style={st.cb} onPress={() => seekBy(10)}><IconFwd10 size={32} color="#fff" /></Pressable>
        {callNow && !callBlocked ? <Pressable style={st.cb} onPress={goPip}><IconPip size={22} color="#fff" /></Pressable>
          : <Pressable style={st.cb} onPress={() => (canCtl ? doCmd('next') : deny())}><IconNextTrack size={22} color="#fff" /></Pressable>}
      </View>
      <View style={st.sync}>{syncWait ? <Pulse color="#ffb224" /> : <View style={st.syncDot} />}<Text style={st.syncTx} numberOfLines={1}>{syncTxt}</Text></View>
      {viewersRow}
      <View style={st.vtabs}>
        <Pressable style={st.vtab} onPress={() => setPane('chat')}><Text style={[st.vtabTx, pane !== 'queue' ? st.vtabOn : null]}>{WT.tr(t, 'watch.chat', 'Chat')}</Text>{pane !== 'queue' ? <View style={st.vtabBar} /> : null}</Pressable>
        <Pressable style={st.vtab} onPress={() => setPane('queue')}><Text style={[st.vtabTx, pane === 'queue' ? st.vtabOn : null]}>{WT.tr(t, 'watch.queueN', 'Fila · {n}', { n: queue.length })}</Text>{pane === 'queue' ? <View style={st.vtabBar} /> : null}</Pressable>
      </View>
      <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 8 }} scrollEnabled={!drag}
        onContentSizeChange={() => { if (pane !== 'queue') { try { scrollRef.current?.scrollToEnd?.({ animated: true }); } catch {} } }} keyboardShouldPersistTaps="handled">
        {pane === 'queue' ? queuePane : chatPane}
        {credits}
      </ScrollView>
      {composer}
      {toastEl}
    </KeyboardAvoidingView>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  av: { alignItems: 'center', justifyContent: 'center' },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(255,255,255,0.18)', paddingVertical: 3, paddingLeft: 5, paddingRight: 7, borderRadius: 999, maxWidth: 240 },
  badgeTx: { color: '#fff', fontSize: 10.5, fontWeight: '700' },
  vhd: { paddingHorizontal: 8, paddingBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 6 },
  ib: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  hdTitle: { color: '#fff', fontSize: 15, fontWeight: '700' },
  hdSub: { color: GRAY, fontSize: 12 },
  player: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#111', overflow: 'hidden' },
  srcb: { position: 'absolute', left: 10, top: 10, zIndex: 3 },
  ov: { ...StyleSheet.absoluteFillObject, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 34, backgroundColor: 'rgba(0,0,0,0.28)' },
  big: { width: 62, height: 62, borderRadius: 31, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' },
  ovchat: { position: 'absolute', left: 10, bottom: 12, maxWidth: '70%', gap: 4, zIndex: 4 },
  ovMsg: { alignSelf: 'flex-start', backgroundColor: 'rgba(0,0,0,0.5)', paddingVertical: 4, paddingHorizontal: 9, borderRadius: 12 },
  ovMsgTx: { color: '#fff', fontSize: 12.5 },
  rx: { position: 'absolute', right: 10, bottom: 8, width: '60%', height: '100%', zIndex: 4 },
  tl: { paddingHorizontal: 14, paddingTop: 12 },
  track: { height: 22, justifyContent: 'center' },
  trackBg: { position: 'absolute', left: 0, right: 0, height: 4, borderRadius: 2, backgroundColor: '#3a3a3c' },
  trackBuf: { position: 'absolute', left: 0, height: 4, borderRadius: 2, backgroundColor: '#6e6e73' },
  trackFg: { position: 'absolute', left: 0, height: 4, borderRadius: 2, backgroundColor: '#fff' },
  knob: { position: 'absolute', width: 14, height: 14, borderRadius: 7, marginLeft: -7, backgroundColor: '#fff' },
  pin: { position: 'absolute', top: -16, marginLeft: -9 },
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
  vmsg: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, paddingHorizontal: 14, paddingVertical: 5 },
  vmsgName: { color: '#d1d1d6', fontSize: 13, fontWeight: '700' },
  vmsgTx: { color: '#fff', fontSize: 14, lineHeight: 19 },
  evTx: { color: '#8e8e93', fontSize: 12.5, flexShrink: 1 },
  tsx: { color: '#8e8e93', fontSize: 11, backgroundColor: '#1c1c1e', paddingHorizontal: 5, borderRadius: 4, overflow: 'hidden', fontVariant: ['tabular-nums'] },
  empty: { color: '#8e8e93', fontSize: 13, paddingHorizontal: 14, paddingVertical: 10 },
  qrow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 14, height: ROW_H },
  qth: { width: 76, height: 44, borderRadius: 8, overflow: 'hidden', backgroundColor: '#1c1c1e', alignItems: 'center', justifyContent: 'center' },
  qnow: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  qTitle: { color: '#fff', fontSize: 14, fontWeight: '600' },
  qSub: { color: '#8e8e93', fontSize: 12 },
  grip: { width: 34, height: ROW_H, alignItems: 'center', justifyContent: 'center' },
  qadd: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 14, marginVertical: 8, paddingVertical: 11, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', borderColor: '#3a3a3c' },
  qaddTx: { color: GRAY, fontSize: 14, fontWeight: '600' },
  credit: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 14, marginTop: 14, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' },
  creditTx: { color: GRAY, fontSize: 11.5, flexShrink: 1 },
  syncpop: { position: 'absolute', alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: 'rgba(255,255,255,0.96)', paddingVertical: 6, paddingLeft: 6, paddingRight: 12, borderRadius: 999, maxWidth: '92%' },
  syncpopTx: { color: '#000', fontSize: 12.5, fontWeight: '700', flexShrink: 1 },
  rbar: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingTop: 8, backgroundColor: 'rgba(0,0,0,0.92)' },
  rin: { flex: 1, borderWidth: 1, borderColor: '#3a3a3c', borderRadius: 999, paddingHorizontal: 14, paddingVertical: Platform.OS === 'ios' ? 9 : 6, color: '#fff', fontSize: 14.5 },
  rbtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#1c1c1e', alignItems: 'center', justifyContent: 'center' },
  bigart: { width: 290, height: 290, alignSelf: 'center', marginTop: 18, borderRadius: 18, overflow: 'hidden', backgroundColor: '#2c2c2e', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 25, shadowOffset: { width: 0, height: 20 }, elevation: 12 },
  lyr: { width: 290, height: 290, alignSelf: 'center', marginTop: 18, borderRadius: 18, backgroundColor: 'rgba(0,0,0,0.28)', padding: 20, overflow: 'hidden' },
  lyrTx: { color: '#fff', fontSize: 19, fontWeight: '800', lineHeight: 26 },
  lyrCredit: { color: 'rgba(255,255,255,0.6)', fontSize: 11, fontWeight: '600', marginTop: 16 },
  minfo: { paddingHorizontal: 26, paddingTop: 22 },
  mTitle: { color: '#fff', fontSize: 21, fontWeight: '800', letterSpacing: -0.4 },
  mSub: { color: 'rgba(255,255,255,0.75)', fontSize: 15, marginTop: 2 },
  mctrl: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-evenly', paddingTop: 8 },
  mmain: { width: 70, height: 70, borderRadius: 35, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  together2: { marginHorizontal: 16, marginTop: 16, padding: 10, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.12)', flexDirection: 'row', alignItems: 'center', gap: 10 },
  t2b: { color: '#fff', fontSize: 13.5, fontWeight: '700' },
  t2s: { color: 'rgba(255,255,255,0.75)', fontSize: 12, flexShrink: 1 },
  sw2: { backgroundColor: '#fff', paddingVertical: 6, paddingHorizontal: 10, borderRadius: 999 },
  sw2Tx: { color: '#000', fontSize: 12, fontWeight: '700' },
  mtabs: { flexDirection: 'row', justifyContent: 'center', gap: 28, paddingTop: 16, paddingBottom: 4 },
  mtab: { alignItems: 'center', gap: 3 },
  mtabTx: { color: '#fff', fontSize: 11, fontWeight: '600' },
  mq: { marginHorizontal: 12, marginTop: 10, borderRadius: 18, backgroundColor: 'rgba(0,0,0,0.35)', paddingVertical: 6, overflow: 'hidden' },
  mqh: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 8, paddingBottom: 4 },
  mqhTx: { color: '#fff', fontSize: 13, fontWeight: '700' },
  mqhSub: { color: 'rgba(255,255,255,0.6)', fontSize: 12 },
});
