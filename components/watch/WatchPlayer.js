// components/watch/WatchPlayer.js — [assistir-junto 2026-10-20] player sincronizado (expo-video, um só p/ vídeo e música).
//
// Segue o estado da sala (services/watchTogether): a cada 500 ms compara a posição alvo
// (pos + tempo de servidor desde server_ts) com a do player:
//   |diferença| < 0,5 s → nada · 0,5–2 s → velocidade 0,95/1,05 até alcançar · > 2 s → seek.
// Carregando por > 1,2 s enquanto a sala toca → manda `buffer` (todos esperam até 8 s); voltou → `ready`.
// Fim do item → `next` com from_item (o servidor ignora duplicados de outros aparelhos).
// Sem áudio em 2º plano (staysActiveInBackground=false) e sem PiP nesta fase.
import React, { useEffect, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import * as WT from '../../services/watchTogether';

let _ev; // expo-video (lazy p/ testes/web sem módulo)
function ev() {
  if (_ev !== undefined) return _ev;
  try { _ev = require('expo-video'); } catch { _ev = null; }
  return _ev;
}
function mediaUrl(u) {
  try { return require('../../services/api').getMediaUrl(u); } catch { return u; }
}

const DRIFT_OK = 0.5;
const DRIFT_SEEK = 2;

export default function WatchPlayer(props) {
  const E = ev();
  if (!E || !E.useVideoPlayer || !E.VideoView) return <View style={[styles.box, props.style]} />;
  return <WatchPlayerInner {...props} E={E} />;
}

function WatchPlayerInner({ E, cid, state, me, style, audioOnly, onSync, contentFit = 'contain' }) {
  const item = state && state.item;
  const url = item && item.url ? mediaUrl(item.url) : null;
  const stRef = useRef(state);
  stRef.current = state;
  const meRef = useRef(me);
  meRef.current = me;
  const urlRef = useRef(url);

  const player = E.useVideoPlayer(url ? { uri: url } : null, (p) => {
    try { p.loop = false; } catch {}
    try { p.timeUpdateEventInterval = 0; } catch {}
    try { p.staysActiveInBackground = false; } catch {}
    try { p.showNowPlayingNotification = false; } catch {}
    try { p.preservesPitch = true; } catch {}
  });

  // troca de item (fila / outro filme)
  useEffect(() => {
    if (!player || urlRef.current === url) return;
    urlRef.current = url;
    try {
      if (!url) { player.pause(); return; }
      if (typeof player.replaceAsync === 'function') player.replaceAsync({ uri: url }).catch(() => {});
      else player.replace({ uri: url });
    } catch {}
  }, [player, url]);

  const loop = useRef({ seekUntil: 0, loadingSince: 0, bufSent: 0, bufActive: false, endFor: '', rate: 1, lastDiff: 0 });
  useEffect(() => {
    if (!player) return undefined;
    const L = loop.current;
    const tick = () => {
      const s = stRef.current;
      if (!s || !s.item) return;
      let status = 'idle';
      try { status = player.status; } catch {}
      const now = WT.serverNow();
      const target = WT.positionAt(s, now);
      const held = WT.isHeld(s);
      let cur = 0; let dur = 0;
      try { cur = Number(player.currentTime) || 0; dur = Number(player.duration) || 0; } catch {}
      const itemDur = Number(s.item.dur) || dur;
      const live = s.status === 'live';
      const want = live && s.playing && !held && !(itemDur > 0 && target >= itemDur - 0.15);

      // carregando enquanto a sala toca → todos esperam (máx. 8 s, servidor)
      if (status === 'loading' && want) {
        if (!L.loadingSince) L.loadingSince = Date.now();
        if (!L.bufActive && Date.now() - L.loadingSince > 1200 && Date.now() - L.bufSent > 10000) {
          L.bufActive = true; L.bufSent = Date.now();
          WT.cmd(cid, 'buffer', { pos: cur }).catch(() => {});
        }
      } else if (status === 'readyToPlay') {
        L.loadingSince = 0;
        if (L.bufActive) {
          L.bufActive = false;
          if (s.hold && String(s.hold.by || '').toLowerCase() === String(meRef.current || '').toLowerCase()) WT.cmd(cid, 'ready').catch(() => {});
        }
      }
      if (status !== 'readyToPlay') { onSync && onSync({ status, diff: null, target }); return; }

      const diff = target - cur;
      L.lastDiff = diff;
      if (want) {
        try { if (!player.playing) player.play(); } catch {}
        if (Date.now() > L.seekUntil) {
          const ad = Math.abs(diff);
          let rate = 1;
          if (ad >= DRIFT_SEEK) {
            try { player.currentTime = target; } catch {}
            L.seekUntil = Date.now() + 1500;
          } else if (ad >= DRIFT_OK) rate = diff > 0 ? 1.05 : 0.95;
          const base = Number(s.rate) || 1;
          if (Math.abs(L.rate - rate * base) > 0.001) { L.rate = rate * base; try { player.playbackRate = L.rate; } catch {} }
        }
      } else {
        try { if (player.playing) player.pause(); } catch {}
        if (L.rate !== 1) { L.rate = 1; try { player.playbackRate = 1; } catch {} }
        if (Math.abs(diff) > 0.3 && Date.now() > L.seekUntil) { try { player.currentTime = target; } catch {} L.seekUntil = Date.now() + 800; }
      }
      // fim do item: quem pode controlar avança a fila (servidor deduplica por from_item)
      const endAt = itemDur > 0 ? itemDur : dur;
      const iid = String(s.item.id || '');
      if (live && s.playing && endAt > 0 && (target >= endAt - 0.3 || (dur > 0 && cur >= dur - 0.3)) && L.endFor !== iid + '|' + s.sid) {
        L.endFor = iid + '|' + s.sid;
        if (WT.canControl(s, meRef.current)) WT.cmd(cid, 'next', { from_item: iid }).catch(() => {});
      }
      onSync && onSync({ status, diff, target });
    };
    const id = setInterval(tick, 500);
    tick();
    return () => { clearInterval(id); try { player.pause(); } catch {} };
  }, [player, cid]);

  const VideoView = E.VideoView;
  if (audioOnly) return <View style={[styles.hidden]} pointerEvents="none"><VideoView player={player} style={styles.hiddenView} nativeControls={false} /></View>;
  return (
    <View style={[styles.box, style]}>
      <VideoView player={player} style={StyleSheet.absoluteFill} nativeControls={false} contentFit={contentFit}
        allowsPictureInPicture={false} allowsFullscreen={false} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { backgroundColor: '#000', overflow: 'hidden' },
  hidden: { position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden' },
  hiddenView: { width: 1, height: 1 },
});
