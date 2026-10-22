// components/watch/WatchPlayer.js — [assistir-junto 2026-10-20] player sincronizado (expo-video, um só p/ vídeo e música).
//
// [sync 22/10] nível Teleparty/SharePlay (services/watchSync): estado autoritativo {playing, pos, rate, server_ts, seq}
// + relógio do servidor (mediana NTP-like). A cada 250 ms (e na hora em que chega estado novo) compara a posição
// esperada com a do player: < 80 ms nada · 80 ms–1 s playbackRate 0,95–1,05 proporcional · > 1 s seek com avanço
// aprendido. Travou/carregando > 0,6 s com a sala tocando → `buffer` (todos esperam até 8 s); voltou → `ready`.
// Quem entra atrasado (posição > 3 s) só alcança sozinho, sem segurar os outros. Ação remota nunca vira comando
// (só gestos do usuário/tela de bloqueio mandam; o eco do próprio player é filtrado por selfAt).
// Fim do item → `next` com from_item (o servidor ignora duplicados de outros aparelhos).
// Kill: globalThis.__chatyy_watch_sync2 = false → limiares antigos (0,5 s / 2 s, tique 500 ms).
import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, AppState } from 'react-native';
import * as WT from '../../services/watchTogether';
import { createDriftController, createStallDetector } from '../../services/watchSync';

let _ev; // expo-video (lazy p/ testes/web sem módulo)
function ev() {
  if (_ev !== undefined) return _ev;
  try { _ev = require('expo-video'); } catch { _ev = null; }
  return _ev;
}
function mediaUrl(u) {
  try { return require('../../services/api').getMediaUrl(u); } catch { return u; }
}

const DRIFT_OK = 0.5; // limiares antigos (kill __chatyy_watch_sync2)
const DRIFT_SEEK = 2;
function sync2On() { try { return globalThis.__chatyy_watch_sync2 !== false; } catch { return true; } }

export default function WatchPlayer(props) {
  const E = ev();
  if (!E || !E.useVideoPlayer || !E.VideoView) return <View style={[styles.box, props.style]} />;
  return <WatchPlayerInner {...props} E={E} />;
}

// [fase 2 20/10] Ouvir junto em 2º plano (igual Spotify): music=true → staysActiveInBackground +
// Now Playing (tela de bloqueio / Central de Controle / notificação Android) com capa, título e artista.
// Comandos da tela de bloqueio mexem no player nativo; aqui viram comandos da SALA:
//   play/pause → 'playingChange' fora do 1º plano · arrastar a barra → salto detectado no tique ·
//   próxima/anterior (binário com o patch do expo-video) → o nativo pula p/ o fim/início e o tique
//   manda 'next' ou 'seek 0'. WS caiu em 2º plano → segue tocando pelo último estado; volta → refresh.
// Kill: globalThis.__chatyy_watch_bg = false (música para ao sair do app, como antes).
function bgOn() { try { return globalThis.__chatyy_watch_bg !== false; } catch { return true; } }
function srcFor(url, item, music) {
  if (!url) return null;
  if (!music || !bgOn()) return { uri: url };
  const md = { title: String((item && item.title) || ''), artist: String((item && (item.artist || item.author)) || '') };
  if (item && item.thumb) md.artwork = mediaUrl(item.thumb);
  return { uri: url, metadata: md };
}

function WatchPlayerInner({ E, cid, state, me, style, audioOnly, onSync, contentFit = 'contain', duck = false, music = false, surfaceType }) {
  const item = state && state.item;
  const url = item && item.url ? mediaUrl(item.url) : null;
  const bg = !!music && bgOn();
  const [inCallNow, setInCallNow] = React.useState(WT.inCall());
  useEffect(() => {
    let off = null;
    try { off = require('../../services/callState').subscribeCallState(() => setInCallNow(WT.inCall())); } catch {}
    return () => { try { off && off(); } catch {} };
  }, []);
  const stRef = useRef(state);
  stRef.current = state;
  const meRef = useRef(me);
  meRef.current = me;
  const urlRef = useRef(url);

  const player = E.useVideoPlayer(srcFor(url, item, music), (p) => {
    try { p.loop = false; } catch {}
    try { p.timeUpdateEventInterval = 0; } catch {}
    try { p.staysActiveInBackground = bg; } catch {}
    try { p.showNowPlayingNotification = bg; } catch {}
    try { p.preservesPitch = true; } catch {}
  });

  // troca de item (fila / outro filme)
  useEffect(() => {
    if (!player || urlRef.current === url) return;
    urlRef.current = url;
    try {
      if (!url) { player.pause(); return; }
      const src = srcFor(url, item, music);
      if (typeof player.replaceAsync === 'function') player.replaceAsync(src).catch(() => {});
      else player.replace(src);
    } catch {}
  }, [player, url]);

  // [fase 2] na chamada: som do filme abaixa enquanto alguém fala (duck), sobe devagar depois
  useEffect(() => {
    if (!player) return undefined;
    // alguém falando (chamada JS: ActiveSpeakers) → 22%; ligação sem sinal de fala (UI nativa) → 55%
    const target = duck ? 0.22 : (inCallNow ? 0.55 : 1);
    let v = 1; try { v = Number(player.volume); if (!Number.isFinite(v)) v = 1; } catch {}
    const steps = 6; let i = 0;
    const id = setInterval(() => {
      i++; const nv = v + (target - v) * (i / steps);
      try { player.volume = Math.max(0, Math.min(1, nv)); } catch {}
      if (i >= steps) clearInterval(id);
    }, duck ? 30 : 90);
    return () => clearInterval(id);
  }, [player, duck, inCallNow]);

  const loop = useRef({ seekUntil: 0, loadingSince: 0, bufSent: 0, bufActive: false, endFor: '', rate: 1, lastDiff: 0, selfAt: 0, lastCur: -1 });

  // comandos da tela de bloqueio / Central de Controle (play/pause) → sala
  useEffect(() => {
    if (!player || !bg || typeof player.addListener !== 'function') return undefined;
    const L = loop.current;
    let sub = null;
    try {
      sub = player.addListener('playingChange', (ev) => {
        const isPlaying = !!(ev && (ev.isPlaying !== undefined ? ev.isPlaying : ev));
        if (Date.now() - L.selfAt < 900) return; // fui eu (tique)
        if (AppState.currentState === 'active') return; // no app quem manda é a tela
        if (WT.inCall()) return; // interrupção da ligação não pausa a sala
        const s = stRef.current;
        if (!WT.isLive(s) || !WT.canControl(s, meRef.current)) return;
        let cur = 0; try { cur = Number(player.currentTime) || 0; } catch {}
        if (isPlaying && !s.playing) WT.cmd(cid, 'play', { pos: cur, _me: meRef.current }).catch(() => {});
        else if (!isPlaying && s.playing && !L.bufActive) WT.cmd(cid, 'pause', { pos: cur, _me: meRef.current }).catch(() => {});
      });
    } catch {}
    // voltou p/ o app → estado + relógio de novo (o WS pode ter caído em 2º plano)
    const as = AppState.addEventListener('change', (st) => { if (st === 'active') { WT.refresh(cid).catch(() => {}); WT.syncClock(true).catch(() => {}); } });
    return () => { try { sub && sub.remove(); } catch {} try { as.remove(); } catch {} };
  }, [player, bg, cid]);
  const tickRef = useRef(null);
  useEffect(() => {
    if (!player) return undefined;
    const L = loop.current;
    const ctl = createDriftController();
    const stall = createStallDetector(700);
    L.item = ''; L.firstLoad = true; L.lateJoin = false;
    const setRate = (r) => { if (Math.abs(L.rate - r) > 0.0005) { L.rate = r; try { player.playbackRate = r; } catch {} } };
    const tick = () => {
      const s = stRef.current;
      if (!s || !s.item) return;
      const v2 = sync2On();
      let status = 'idle';
      try { status = player.status; } catch {}
      const now = WT.serverNow();
      const nowL = Date.now();
      const target = WT.positionAt(s, now);
      const held = WT.isHeld(s);
      let cur = 0; let dur = 0; let playingNow = false;
      try { cur = Number(player.currentTime) || 0; dur = Number(player.duration) || 0; playingNow = !!player.playing; } catch {}
      const itemDur = Number(s.item.dur) || dur;
      const live = s.status === 'live';
      const want = live && s.playing && !held && !(itemDur > 0 && target >= itemDur - 0.15);
      const iid = String(s.item.id || '') + '|' + s.sid;
      if (L.item !== iid) { L.item = iid; L.firstLoad = true; L.lateJoin = target > 3; ctl.reset(); stall.reset(nowL); }

      // travada: status loading OU tocando sem o tempo andar (fora do assentamento de um seek)
      const settling = ctl.state.mode === 'align';
      const stalled = v2 && want && status === 'readyToPlay' && !settling && stall.feed(nowL, cur, playingNow);
      if (!want || status !== 'readyToPlay') stall.reset(nowL);
      const loading = status === 'loading' || stalled;
      // carregando enquanto a sala toca → todos esperam (máx. 8 s, servidor). Quem entrou atrasado não segura ninguém.
      if (loading && want) {
        if (!L.loadingSince) L.loadingSince = nowL;
        const holdOk = !(L.firstLoad && L.lateJoin);
        const waitMs = v2 ? 600 : 1200;
        if (holdOk && !L.bufActive && nowL - L.loadingSince > waitMs && nowL - L.bufSent > (v2 ? 15000 : 10000)) {
          L.bufActive = true; L.bufSent = nowL; L.bufStall = stalled && status !== 'loading';
          WT.cmd(cid, 'buffer', { pos: cur }).catch(() => {});
        }
      } else if (status === 'readyToPlay' && !stalled) {
        L.loadingSince = 0;
        if (playingNow || !want) L.firstLoad = false;
        // travada só pelo detector (status seguiu "pronto"): parado não dá p/ provar que voltou → espera 2 s
        if (L.bufActive && !(L.bufStall && nowL - L.bufSent < 2000)) {
          L.bufActive = false;
          if (s.hold && String(s.hold.by || '').toLowerCase() === String(meRef.current || '').toLowerCase()) WT.cmd(cid, 'ready').catch(() => {});
        }
      }
      if (status !== 'readyToPlay' || stalled) { onSync && onSync({ status: stalled ? 'loading' : status, diff: null, target }); return; }

      const diff = target - cur;
      // salto feito na tela de bloqueio (barra / anterior) com o app em 2º plano → seek da sala
      if (bg && AppState.currentState !== 'active' && nowL > L.seekUntil && L.lastCur >= 0 && Math.abs(diff) > 3
        && Math.abs(L.lastDiff) < 1.5 && Math.abs(cur - L.lastCur) > 2.5 && WT.isLive(s) && WT.canControl(s, meRef.current) && !WT.inCall()) {
        const nearEnd = (dur > 0 && cur >= dur - 0.6);
        if (!nearEnd) {
          L.seekUntil = nowL + 1500; L.lastCur = cur; L.lastDiff = 0;
          ctl.reset();
          WT.cmd(cid, 'seek', { pos: cur, delta: Math.round(cur - target), _me: meRef.current }).catch(() => {});
          onSync && onSync({ status, diff: 0, target: cur });
          return;
        }
      }
      L.lastCur = cur;
      L.lastDiff = diff;
      const base = Number(s.rate) || 1;
      let shown = diff;
      if (v2) {
        const fg = AppState.currentState === 'active';
        const r = ctl.step({ now: nowL, target, cur, want, ready: true, playing: playingNow, noPause: !fg });
        if (r.seek !== null) { try { player.currentTime = r.seek; } catch {} L.seekUntil = nowL + 800; }
        // wait = partida alinhada: segura pausado até a sala alcançar (em 2º plano tocando, nunca pausa por isso)
        const go = want && (!r.wait || (!fg && playingNow));
        if (go) { try { if (!playingNow) { L.selfAt = nowL; player.play(); } } catch {} }
        else { try { if (playingNow) { L.selfAt = nowL; player.pause(); } } catch {} }
        setRate(go ? r.rate * base : 1);
        if (r.diff !== null) shown = r.diff;
      } else if (want) {
        try { if (!playingNow) { L.selfAt = nowL; player.play(); } } catch {}
        if (nowL > L.seekUntil) {
          const ad = Math.abs(diff);
          let rate = 1;
          if (ad >= DRIFT_SEEK) {
            try { player.currentTime = target; } catch {}
            L.seekUntil = nowL + 1500;
          } else if (ad >= DRIFT_OK) rate = diff > 0 ? 1.05 : 0.95;
          setRate(rate * base);
        }
      } else {
        try { if (playingNow) { L.selfAt = nowL; player.pause(); } } catch {}
        setRate(1);
        if (Math.abs(diff) > 0.3 && nowL > L.seekUntil) { try { player.currentTime = target; } catch {} L.seekUntil = nowL + 800; }
      }
      // fim do item: quem pode controlar avança a fila (servidor deduplica por from_item)
      const endAt = itemDur > 0 ? itemDur : dur;
      const eid = String(s.item.id || '');
      if (live && s.playing && endAt > 0 && (target >= endAt - 0.3 || (dur > 0 && cur >= dur - 0.3)) && L.endFor !== eid + '|' + s.sid) {
        L.endFor = eid + '|' + s.sid;
        if (WT.canControl(s, meRef.current)) WT.cmd(cid, 'next', { from_item: eid }).catch(() => {});
      }
      onSync && onSync({ status, diff: shown, target, rate: L.rate });
    };
    tickRef.current = tick;
    const id = setInterval(tick, sync2On() ? 250 : 500);
    tick();
    return () => { clearInterval(id); tickRef.current = null; try { player.pause(); } catch {} };
  }, [player, cid]);
  // estado novo (play/pause/seek remoto) → age na hora, sem esperar o próximo tique
  const seqKey = state ? String(state.sid) + ':' + String(state.seq) + ':' + (state.playing ? 1 : 0) + ':' + String(state.server_ts) : '';
  useEffect(() => { if (seqKey && tickRef.current) { try { tickRef.current(); } catch {} } }, [seqKey]);

  const VideoView = E.VideoView;
  if (audioOnly) return <View style={[styles.hidden]} pointerEvents="none"><VideoView player={player} style={styles.hiddenView} nativeControls={false} /></View>;
  return (
    <View style={[styles.box, style]}>
      <VideoView player={player} style={StyleSheet.absoluteFill} nativeControls={false} contentFit={contentFit}
        allowsPictureInPicture={false} allowsFullscreen={false} {...(surfaceType ? { surfaceType } : {})} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { backgroundColor: '#000', overflow: 'hidden' },
  hidden: { position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden' },
  hiddenView: { width: 1, height: 1 },
});
