// components/watch/WatchInviteCard.js — [assistir-junto 2026-10-20] cartão do convite na conversa (tela 5)
// e mini-player fixo no topo da conversa enquanto a sessão está ativa.
//   <WatchInviteCard msg isOwn me colors isDark t onOpen/> — mensagem type=watch_session (content JSON kind:'watch').
//     Ao vivo (mesmo sid da sessão atual) → "AO VIVO · mm:ss", progresso, quem entrou e o botão Entrar.
//     Encerrada → "Sessão encerrada".
//   <WatchMiniBar cid me colors isDark t onOpen/> — barra com capa, título, "Você e Ana · mm:ss", play/pause e X (esconde).
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, Image, StyleSheet, Animated } from 'react-native';
import * as WT from '../../services/watchTogether';
import { IconPlayFill, IconPauseFill, IconHeadphones, IconTogether, SourceIcon } from './WatchIcons';
import { IconX } from '../Icons';

function useSession(cid) {
  const [s, setS] = useState(() => WT.getSession(cid));
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!cid) return undefined;
    const off = WT.subscribe(cid, (x) => setS(x));
    setS(WT.getSession(cid));
    return off;
  }, [cid]);
  const live = WT.isLive(s);
  useEffect(() => {
    if (!live) return undefined;
    const id = setInterval(() => setTick((n) => (n + 1) % 1e6), 1000);
    return () => clearInterval(id);
  }, [live]);
  return s;
}

/** Ponto vermelho pulsando (AO VIVO). */
function LiveDot() {
  const a = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const l = Animated.loop(Animated.sequence([
      Animated.timing(a, { toValue: 0.35, duration: 700, useNativeDriver: true }),
      Animated.timing(a, { toValue: 1, duration: 700, useNativeDriver: true }),
    ]));
    l.start();
    return () => l.stop();
  }, [a]);
  return <Animated.View style={[cs.dot, { opacity: a }]} />;
}

/** Equalizador (4 barras) do cartão de música. */
function Eq({ playing }) {
  const bars = useRef([0, 1, 2, 3].map(() => new Animated.Value(0.3))).current;
  useEffect(() => {
    if (!playing) { bars.forEach((b) => b.setValue(0.25)); return undefined; }
    const loops = bars.map((b, i) => Animated.loop(Animated.sequence([
      Animated.timing(b, { toValue: 1, duration: 380 + i * 90, useNativeDriver: true }),
      Animated.timing(b, { toValue: 0.2, duration: 380 + i * 70, useNativeDriver: true }),
    ])));
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [playing, bars]);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 16, gap: 2, marginLeft: 4 }}>
      {bars.map((b, i) => <Animated.View key={i} style={{ width: 3, height: 16, borderRadius: 1, backgroundColor: '#fff', transform: [{ scaleY: b }] }} />)}
    </View>
  );
}

function initials(n) {
  const p = String(n || '?').trim().split(/\s+/).filter(Boolean);
  return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}
function Stack({ names, border }) {
  return (
    <View style={{ flexDirection: 'row' }}>
      {names.slice(0, 4).map((n, i) => (
        <View key={n + i} style={[cs.av, { marginLeft: i ? -7 : 0, borderColor: border }]}><Text style={cs.avTx}>{initials(n)}</Text></View>
      ))}
    </View>
  );
}

export function WatchInviteCard({ msg, isOwn, me, colors = {}, isDark, t, onOpen }) {
  const j = WT.parseWatchContent(msg && msg.content);
  const cid = msg && msg.conversation_id;
  const s = useSession(cid);
  if (!j) return <Text style={{ color: colors.text, fontSize: 15 }}>{WT.previewText(t, msg && msg.content) || ''}</Text>;
  const same = s && s.sid === j.sid;
  const live = same ? WT.isLive(s) : (j.status === 'live' && !s); // sem estado ainda: confia no cartão
  const ended = !live && (same || j.status !== 'live' || (s && s.sid !== j.sid));
  const music = j.mode === 'music';
  const cur = same && s.item ? s.item : { title: j.title, thumb: j.thumb, source: j.source, lic: j.lic, dur: j.dur };
  const pos = same ? WT.positionNow(s) : 0;
  const dur = Number(cur.dur) || 0;
  const bub = isOwn ? (isDark ? '#f5f5f7' : '#0b0b0c') : (colors.surface || (isDark ? '#1c1c1e' : '#fff'));
  const ink = isOwn ? (isDark ? '#000' : '#fff') : (colors.text || (isDark ? '#f5f5f7' : '#0b0b0c'));
  const muted = isOwn ? (isDark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.65)') : (colors.textSecondary || '#8a8a8f');
  const joinBg = isOwn ? (isDark ? '#000' : '#fff') : (isDark ? '#f5f5f7' : '#0b0b0c');
  const joinInk = isOwn ? (isDark ? '#fff' : '#000') : (isDark ? '#000' : '#fff');
  const viewers = same ? WT.viewersOf(s) : [];
  const names = viewers.length ? viewers.map((v) => v.n) : [j.host_name || ''];
  const hostIsMe = String(j.host || '').toLowerCase() === String(me || '').toLowerCase();
  const who = hostIsMe ? WT.tr(t, 'watch.you', 'Você') : (j.host_name || '');
  const verb = music ? WT.tr(t, 'watch.card.startedListening', 'começou a ouvir') : WT.tr(t, 'watch.card.startedWatching', 'começou a assistir');
  const othersIn = viewers.filter((v) => String(v.e).toLowerCase() !== String(j.host || '').toLowerCase());
  const joinedTxt = othersIn.length === 1 ? WT.tr(t, 'watch.card.joined1', '{name} entrou', { name: String(othersIn[0].e).toLowerCase() === String(me).toLowerCase() ? WT.tr(t, 'watch.you', 'Você') : othersIn[0].n })
    : (othersIn.length > 1 ? WT.tr(t, 'watch.card.joinedN', '{n} entraram', { n: othersIn.length }) : '');

  return (
    <View style={[cs.card, { backgroundColor: bub }]}>
      <Pressable onPress={() => live && onOpen && onOpen()} style={[cs.cv, music ? cs.cvMusic : null]}>
        {music ? (
          <>
            <View style={cs.art}>{cur.thumb ? <Image source={{ uri: cur.thumb }} style={StyleSheet.absoluteFill} /> : <IconHeadphones size={30} color="#fff" />}</View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={cs.mt} numberOfLines={2}>{cur.title}</Text>
              <Text style={cs.ms} numberOfLines={1}>{cur.artist || cur.author || ''}</Text>
              {live ? <Text style={cs.mLive}>{WT.tr(t, 'watch.card.live', 'AO VIVO')}</Text> : null}
            </View>
            {live ? <Eq playing={!!(same && s.playing)} /> : null}
          </>
        ) : (
          <>
            {cur.thumb ? <Image source={{ uri: cur.thumb }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : <View style={cs.fb}><IconTogether size={40} color="rgba(255,255,255,0.7)" /></View>}
            <View style={cs.shade} />
          </>
        )}
        {live && !music ? (
          <View style={cs.live}>
            <LiveDot />
            <Text style={cs.liveTx}>{WT.tr(t, 'watch.card.live', 'AO VIVO')}{same ? ' · ' + WT.fmtTime(pos) : ''}</Text>
          </View>
        ) : null}
        {live && dur > 0 && !music ? <View style={cs.bar0}><View style={[cs.bar0In, { width: `${Math.min(100, (pos / dur) * 100)}%` }]} /></View> : null}
      </Pressable>
      <View style={cs.bd}>
        <Text style={[cs.t, { color: ink }]}>
          <Text style={{ fontWeight: '700' }}>{who}</Text> {verb} <Text style={{ fontWeight: '700' }}>{j.title}</Text>
        </Text>
        <View style={cs.m}>
          <View style={[cs.badge, { backgroundColor: isOwn ? 'rgba(127,127,127,0.25)' : (isDark ? '#2c2c2e' : '#ececf1') }]}>
            <SourceIcon source={j.source} size={11} color={ink} />
            <Text style={[cs.badgeTx, { color: ink }]} numberOfLines={1}>{WT.sourceLabel(t, j)}</Text>
          </View>
          {j.dur ? <Text style={[cs.mTx, { color: muted }]}>{WT.fmtTime(j.dur)}</Text> : null}
        </View>
        <View style={cs.row2}>
          {live ? <Stack names={names} border={bub} /> : null}
          <Text style={[cs.mTx, { color: muted, flexShrink: 1 }]} numberOfLines={1}>{ended ? WT.tr(t, 'watch.ended', 'Sessão encerrada') : joinedTxt}</Text>
          {live ? (
            <Pressable onPress={() => onOpen && onOpen()} style={[cs.join, { backgroundColor: joinBg }]}>
              {music ? <IconHeadphones size={14} color={joinInk} /> : <IconPlayFill size={13} color={joinInk} />}
              <Text style={[cs.joinTx, { color: joinInk }]}>{music ? WT.tr(t, 'watch.card.listen', 'Ouvir junto') : WT.tr(t, 'watch.card.join', 'Entrar')}</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

export function WatchMiniBar({ cid, me, colors = {}, isDark, t, onOpen }) {
  const s = useSession(cid);
  const [hidden, setHidden] = useState('');
  // conversa aberta: estado inicial + poll leve (20 s) só enquanto há sessão ao vivo (modo HTTP)
  useEffect(() => (cid ? WT.watchConversation(cid) : undefined), [cid]);
  if (!WT.watchEnabled() || !WT.isLive(s) || hidden === s.sid) return null;
  const item = s.item || {};
  const pos = WT.positionNow(s);
  const dur = Number(item.dur) || 0;
  const viewers = WT.viewersOf(s);
  const others = viewers.filter((v) => String(v.e).toLowerCase() !== String(me || '').toLowerCase());
  const who = others.length === 1 ? WT.tr(t, 'watch.youAnd', 'Você e {name}', { name: others[0].n })
    : (others.length > 1 ? WT.tr(t, 'watch.youAndN', 'Você e mais {n}', { n: others.length }) : (s.host_name || ''));
  const can = WT.canControl(s, me);
  const card = colors.surface || (isDark ? '#1c1c1e' : '#fff');
  const text = colors.text || (isDark ? '#f5f5f7' : '#0b0b0c');
  const muted = colors.textSecondary || '#8a8a8f';
  const acc = isDark ? '#f5f5f7' : '#0b0b0c';
  const accInk = isDark ? '#000' : '#fff';
  const toggle = () => {
    if (!can) return;
    if (s.playing) WT.cmd(cid, 'pause', { pos: WT.positionNow(s), _me: me }).catch(() => {});
    else WT.cmd(cid, 'play', { pos: WT.positionNow(s), _me: me }).catch(() => {});
  };
  return (
    <Pressable onPress={onOpen} style={[cs.mini, { backgroundColor: card, borderBottomColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)' }]}>
      <View style={cs.th}>
        {item.thumb ? <Image source={{ uri: item.thumb }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : (s.kind === 'music' ? <IconHeadphones size={18} color="#fff" /> : <IconTogether size={18} color="#fff" />)}
        {dur > 0 ? <View style={cs.prog}><View style={[cs.progIn, { width: `${Math.min(100, (pos / dur) * 100)}%` }]} /></View> : null}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[cs.miniT, { color: text }]} numberOfLines={1}>{item.title}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <LiveDot />
          <Text style={[cs.miniS, { color: muted }]} numberOfLines={1}>{who ? who + ' · ' : ''}{WT.fmtTime(pos)}</Text>
        </View>
      </View>
      {can ? (
        <Pressable onPress={toggle} hitSlop={6} style={[cs.pp, { backgroundColor: acc }]} accessibilityLabel={s.playing ? WT.tr(t, 'watch.pause', 'Pausar') : WT.tr(t, 'watch.play', 'Continuar')}>
          {s.playing ? <IconPauseFill size={16} color={accInk} /> : <IconPlayFill size={16} color={accInk} />}
        </Pressable>
      ) : null}
      <Pressable onPress={() => { setHidden(s.sid); try { if (WT.getListening() === String(cid)) WT.setListening(null); } catch {} }} hitSlop={8} style={cs.x} accessibilityLabel={WT.tr(t, 'common.close', 'Fechar')}>
        <IconX size={16} color={muted} />
      </Pressable>
    </Pressable>
  );
}

const cs = StyleSheet.create({
  card: { width: 268, borderRadius: 18, overflow: 'hidden' },
  cv: { height: 128, justifyContent: 'flex-end', backgroundColor: '#1c1c1e' },
  cvMusic: { height: undefined, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, backgroundColor: '#0b0b0c' },
  fb: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  shade: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.2)' },
  mLive: { color: '#ff453a', fontSize: 10.5, fontWeight: '800', marginTop: 4, letterSpacing: 0.4 },
  art: { width: 72, height: 72, borderRadius: 10, overflow: 'hidden', backgroundColor: '#3a3a3c', alignItems: 'center', justifyContent: 'center' },
  mt: { color: '#fff', fontSize: 15, fontWeight: '700' },
  ms: { color: 'rgba(255,255,255,0.8)', fontSize: 12 },
  live: { position: 'absolute', left: 10, top: 10, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(0,0,0,0.55)', paddingVertical: 3, paddingHorizontal: 9, borderRadius: 999 },
  liveTx: { color: '#fff', fontSize: 11.5, fontWeight: '700', fontVariant: ['tabular-nums'] },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#ff453a' },
  bar0: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, backgroundColor: 'rgba(255,255,255,0.25)' },
  bar0In: { height: 3, backgroundColor: '#fff' },
  bd: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 12 },
  t: { fontSize: 14.5, lineHeight: 19 },
  m: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  mTx: { fontSize: 12 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 2, paddingHorizontal: 6, borderRadius: 999, maxWidth: 170 },
  badgeTx: { fontSize: 10.5, fontWeight: '700' },
  row2: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  av: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, backgroundColor: '#48484a', alignItems: 'center', justifyContent: 'center' },
  avTx: { color: '#fff', fontSize: 9.5, fontWeight: '700' },
  join: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999 },
  joinTx: { fontWeight: '700', fontSize: 14 },
  mini: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingLeft: 8, paddingRight: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  th: { width: 52, height: 34, borderRadius: 7, overflow: 'hidden', backgroundColor: '#2c2c2e', alignItems: 'center', justifyContent: 'center' },
  prog: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 2, backgroundColor: 'rgba(255,255,255,0.3)' },
  progIn: { height: 2, backgroundColor: '#fff' },
  miniT: { fontSize: 13.5, fontWeight: '700' },
  miniS: { fontSize: 11.5, fontVariant: ['tabular-nums'] },
  pp: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  x: { width: 28, height: 34, alignItems: 'center', justifyContent: 'center' },
});

/** Atalho no cabeçalho da conversa — só aparece com sessão ao vivo (botão destacado, como no mockup). */
export function WatchHeaderButton({ cid, isDark, style, t, onOpen }) {
  const s = useSession(cid);
  if (!WT.watchEnabled() || !WT.isLive(s)) return null;
  const acc = isDark ? '#f5f5f7' : '#0b0b0c';
  const ink = isDark ? '#000' : '#fff';
  return (
    <Pressable onPress={onOpen} style={style} hitSlop={6} accessibilityRole="button"
      accessibilityLabel={s.kind === 'music' ? WT.tr(t, 'watch.menu.listen', 'Ouvir junto') : WT.tr(t, 'watch.menu.watch', 'Assistir junto')}>
      <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: acc, alignItems: 'center', justifyContent: 'center' }}>
        {s.kind === 'music' ? <IconHeadphones size={18} color={ink} /> : <IconTogether size={18} color={ink} />}
      </View>
    </Pressable>
  );
}
