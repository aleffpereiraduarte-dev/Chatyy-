// components/watch/WatchPip.js — [assistir-junto fase 2 20/10] janela flutuante (tela 6 do mockup).
// Overlay na RAIZ do app (Late overlay em app/_layout): aparece quando a pessoa toca no botão PiP da
// sala durante uma ligação (WT.setPip) e fica por cima das telas do app enquanto a ligação segue
// (a UI nativa de chamada minimizada → conversa/lista). Arrasta com o dedo e encosta no lado mais perto.
// Toque no expandir → sala; X → fecha (o filme continua na conversa). Som abaixa quando alguém fala
// (chamada JS: ActiveSpeakers; UI nativa: volume fixo 55%). Aviso "Use fone" 1x por sessão.
// iOS só com o binário que tem o patch do expo-video (WT.callPlaybackBlocked) — senão não monta player.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Animated, PanResponder, Dimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as WT from '../../services/watchTogether';
import WatchPlayer from './WatchPlayer';
import { IconPlayFill, IconPauseFill, IconBack10, IconFwd10, IconExpand, IconHeadphones } from './WatchIcons';
import { IconX } from '../Icons';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';

const W = 230;
const H = Math.round(W * 9 / 16);
let _duckHintShown = false;

export default function WatchPip() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { t } = useLanguage();
  const me = String((user && user.email) || '').toLowerCase();
  const [pip, setPipSt] = useState(WT.getPip());
  const [s, setS] = useState(() => (pip ? WT.getSession(pip.cid) : null));
  const [call, setCall] = useState(WT.inCall());
  const [duck, setDuck] = useState(WT.isCallSpeaking());
  const [ctl, setCtl] = useState(true);
  const [hint, setHint] = useState(!_duckHintShown);
  const [, setTick] = useState(0);
  useEffect(() => WT.onPip(setPipSt), []);
  useEffect(() => WT.onCallSpeaking(setDuck), []);
  useEffect(() => {
    let off = null;
    try { off = require('../../services/callState').subscribeCallState(() => setCall(WT.inCall())); } catch {}
    return () => { try { off && off(); } catch {} };
  }, []);
  useEffect(() => {
    if (!pip) { setS(null); return undefined; }
    setS(WT.getSession(pip.cid));
    const off = WT.subscribe(pip.cid, (x) => { setS(x); if (!x || x.status !== 'live') WT.setPip(null); });
    const leave = WT.enterRoom(pip.cid);
    const iv = setInterval(() => setTick((n) => (n + 1) % 1e6), 1000);
    return () => { off(); leave(); clearInterval(iv); };
  }, [pip && pip.cid]);
  useEffect(() => { if (!call && pip) WT.setPip(null); }, [call]); // ligação acabou → volta ao normal
  useEffect(() => { if (!ctl) return undefined; const id = setTimeout(() => setCtl(false), 3000); return () => clearTimeout(id); }, [ctl]);

  const { width: SW, height: SH } = Dimensions.get('window');
  const pos = useRef(new Animated.ValueXY({ x: 14, y: insets.top + 180 })).current;
  const last = useRef({ x: 14, y: insets.top + 180 });
  const pan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) + Math.abs(g.dy) > 6,
    onPanResponderGrant: () => { pos.setOffset(last.current); pos.setValue({ x: 0, y: 0 }); },
    onPanResponderMove: Animated.event([null, { dx: pos.x, dy: pos.y }], { useNativeDriver: false }),
    onPanResponderRelease: (_, g) => {
      pos.flattenOffset();
      const nx = last.current.x + g.dx; const ny = last.current.y + g.dy;
      const x = nx + W / 2 < SW / 2 ? 14 : SW - W - 14;
      const y = Math.max(insets.top + 50, Math.min(SH - H - 160, ny));
      last.current = { x, y };
      Animated.spring(pos, { toValue: { x, y }, useNativeDriver: false, friction: 8 }).start();
    },
  }), [SW, SH, insets.top, pos]);

  if (!pip || !WT.isLive(s) || s.kind === 'music' || !call || WT.callPlaybackBlocked()) return null;
  const item = s.item || {};
  const p = WT.positionNow(s);
  const dur = Number(item.dur) || 0;
  const can = WT.canControl(s, me);
  const viewers = WT.viewersOf(s);
  const act = (name, args) => { if (!can) return; WT.cmd(pip.cid, name, { ...(args || {}), _me: me }).catch(() => {}); setCtl(true); };
  const toggle = () => act(s.playing ? 'pause' : 'play', { pos: WT.positionNow(s) });
  const seekBy = (d) => act('seek', { pos: Math.max(0, Math.min(dur || 1e9, WT.positionNow(s) + d)), delta: d });

  return (
    <>
      <Animated.View {...pan.panHandlers} style={[st.pip, { transform: pos.getTranslateTransform() }]}>
        <Pressable onPress={() => setCtl((c) => !c)} style={st.pv}>
          <WatchPlayer cid={pip.cid} state={s} me={me} style={StyleSheet.absoluteFill} duck={duck} />
          {ctl ? (
            <View style={st.pctl}>
              <Pressable hitSlop={8} onPress={() => seekBy(-10)}><IconBack10 size={24} color="#fff" /></Pressable>
              <Pressable hitSlop={8} onPress={toggle}>{s.playing ? <IconPauseFill size={26} color="#fff" /> : <IconPlayFill size={26} color="#fff" />}</Pressable>
              <Pressable hitSlop={8} onPress={() => seekBy(10)}><IconFwd10 size={24} color="#fff" /></Pressable>
            </View>
          ) : null}
          {ctl ? (
            <View style={st.ptop}>
              <Pressable hitSlop={8} style={st.pbtn} onPress={() => { const c = pip; WT.setPip(null); router.push({ pathname: '/watch-room', params: { cid: c.cid, name: c.name || '' } }); }}>
                <IconExpand size={13} color="#fff" />
              </Pressable>
              <Pressable hitSlop={8} style={st.pbtn} onPress={() => WT.setPip(null)}><IconX size={13} color="#fff" /></Pressable>
            </View>
          ) : null}
          {dur > 0 ? <View style={st.pbar}><View style={[st.pbarIn, { width: `${Math.min(100, (p / dur) * 100)}%` }]} /></View> : null}
        </Pressable>
        <View style={st.pinfo}>
          <Text style={st.pt} numberOfLines={1}>{item.title}</Text>
          <Text style={st.ptime}>{WT.fmtTime(p)}</Text>
          <View style={{ flexDirection: 'row' }}>
            {viewers.slice(0, 3).map((v, i) => (
              <View key={v.e} style={[st.av, { marginLeft: i ? -5 : 0 }]}><Text style={st.avTx}>{String(v.n || '?').slice(0, 1).toUpperCase()}</Text></View>
            ))}
          </View>
        </View>
      </Animated.View>
      {hint ? (
        <View style={[st.duckn, { bottom: insets.bottom + 110 }]}>
          <IconHeadphones size={18} color="#000" />
          <View style={{ flex: 1 }}>
            <Text style={st.dnT}>{WT.tr(t, 'watch.pipHintTitle', 'Use fone para não dar eco')}</Text>
            <Text style={st.dnS}>{WT.tr(t, 'watch.pipHintBody', 'O som do filme abaixa quando alguém fala.')}</Text>
          </View>
          <Pressable onPress={() => { _duckHintShown = true; setHint(false); }} style={st.dnBtn}><Text style={st.dnBtnTx}>{WT.tr(t, 'watch.gotIt', 'Entendi')}</Text></Pressable>
        </View>
      ) : null}
    </>
  );
}

const st = StyleSheet.create({
  pip: { position: 'absolute', left: 0, top: 0, width: W, borderRadius: 16, overflow: 'hidden', backgroundColor: '#111', zIndex: 9999, elevation: 30, shadowColor: '#000', shadowOpacity: 0.55, shadowRadius: 20, shadowOffset: { width: 0, height: 14 } },
  pv: { width: W, height: H, backgroundColor: '#000' },
  pctl: { ...StyleSheet.absoluteFillObject, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 22, backgroundColor: 'rgba(0,0,0,0.25)' },
  ptop: { position: 'absolute', left: 6, right: 6, top: 6, flexDirection: 'row', justifyContent: 'space-between' },
  pbtn: { width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
  pbar: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, backgroundColor: 'rgba(255,255,255,0.25)' },
  pbarIn: { height: 3, backgroundColor: '#fff' },
  pinfo: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 7, paddingHorizontal: 9, backgroundColor: '#1c1c1e' },
  pt: { flex: 1, color: '#fff', fontSize: 12, fontWeight: '700' },
  ptime: { color: '#a1a1a6', fontSize: 11.5, fontVariant: ['tabular-nums'] },
  av: { width: 18, height: 18, borderRadius: 9, backgroundColor: '#48484a', borderWidth: 1.5, borderColor: '#1c1c1e', alignItems: 'center', justifyContent: 'center' },
  avTx: { color: '#fff', fontSize: 8, fontWeight: '700' },
  duckn: { position: 'absolute', left: 12, right: 12, zIndex: 9998, backgroundColor: 'rgba(255,255,255,0.96)', borderRadius: 16, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 9, elevation: 20 },
  dnT: { color: '#000', fontSize: 13, fontWeight: '700' },
  dnS: { color: '#000', fontSize: 12.5 },
  dnBtn: { backgroundColor: '#000', paddingVertical: 6, paddingHorizontal: 10, borderRadius: 999 },
  dnBtnTx: { color: '#fff', fontSize: 12.5, fontWeight: '700' },
});
