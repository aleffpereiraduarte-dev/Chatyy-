// [2026-10-13 video-studio] Prévia em tempo real de uma EDL v1.
//
// • Dois players expo-video em "pingue-pongue": o ativo toca o clip atual, o
//   outro já fica carregado no PRÓXIMO clip (pausado no `in`) → troca sem tela
//   preta. Respeita in/out, velocidade (playbackRate, pitch preservado) e espelho.
// • Clips de foto (kind:"image") avançam por relógio de parede.
// • Música e voz (expo-audio) sincronizadas ao relógio da timeline (corrige
//   desvio > 250 ms a cada ~1 s).
// • Nada de re-render por frame: o tempo vai para um `clock` (pub/sub) que só
//   os componentes interessados assinam, em frequência baixa.
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Image } from 'expo-image';
import { FilterLayer } from './filters';
import { clipStarts, locate, totalDuration } from '../../services/videoStudio/edlOps';

// ─── Relógio compartilhado ──────────────────────────────────────────────────
export function createClock() {
  const subs = new Set();
  const c = {
    t: 0,
    playing: false,
    set(t) { c.t = t; subs.forEach((fn) => { try { fn(t); } catch {} }); },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
  return c;
}

/** Valor derivado do relógio, re-renderiza no máx. `hz` vezes/s e só se mudar. */
export function useClockValue(clock, map, hz = 8) {
  const mapRef = useRef(map);
  mapRef.current = map;
  const [v, setV] = useState(() => mapRef.current(clock ? clock.t : 0));
  useEffect(() => {
    if (!clock) return undefined;
    let last = 0;
    let pending = null;
    let cur = mapRef.current(clock.t);
    setV(cur);
    const fn = (t) => {
      const now = Date.now();
      const apply = () => { pending = null; last = Date.now(); const nv = mapRef.current(clock.t); if (nv !== cur) { cur = nv; setV(nv); } };
      if (now - last >= 1000 / hz) apply();
      else if (!pending) pending = setTimeout(apply, 1000 / hz - (now - last));
    };
    const un = clock.subscribe(fn);
    return () => { un(); if (pending) clearTimeout(pending); };
  }, [clock, hz]);
  return v;
}

function setupPlayer(p) {
  try { p.loop = false; } catch {}
  try { p.preservesPitch = true; } catch {}
  try { p.audioMixingMode = 'mixWithOthers'; } catch {}
}

async function replaceSrc(p, uri) {
  try {
    if (typeof p.replaceAsync === 'function') await p.replaceAsync({ uri });
    else p.replace({ uri });
  } catch {
    try { p.replace({ uri }); } catch {}
  }
}

function createAudio(uri) {
  if (!uri) return null;
  try {
    const A = require('expo-audio');
    const pl = A.createAudioPlayer({ uri }, { updateInterval: 250 });
    return pl;
  } catch { return null; }
}

const EdlPreview = forwardRef(function EdlPreview({
  edl, clock, width, height, loop = true, muteOriginal = false, muteMusic = false, muteVoice = false,
  onPlayingChange, onEnded, children,
}, ref) {
  const pA = useVideoPlayer(null, setupPlayer);
  const pB = useVideoPlayer(null, setupPlayer);
  const players = [pA, pB];
  const playersRef = useRef(players);
  playersRef.current = players;

  const edlRef = useRef(null); // preenchido no efeito de [edl] (1ª execução = carga inicial)
  const startsRef = useRef(clipStarts(edl));
  const slotLoad = useRef([Promise.resolve(), Promise.resolve()]);
  const slotClip = useRef([-1, -1]);
  const slotUri = useRef([null, null]);
  const activeIdx = useRef(0);
  const activeSlotRef = useRef(0);
  const playingRef = useRef(false);
  const imgWall = useRef({ at: 0, local: 0 });
  const tickRef = useRef(null);
  const lastAudioSync = useRef(0);
  const opSeq = useRef(0);
  const flags = useRef({ muteOriginal, muteMusic, muteVoice, loop });
  flags.current = { muteOriginal, muteMusic, muteVoice, loop };

  const [view, setView] = useState({ slot: 0, image: null, mirror: [false, false], fit: ['cover', 'cover'] });

  const musicRef = useRef(null);
  const voiceRef = useRef(null);

  // ─── Áudio ───────────────────────────────────────────────────────────────
  const syncAudio = useCallback((t, force) => {
    const e = edlRef.current;
    const playing = playingRef.current;
    const m = musicRef.current;
    const mus = e?.audio?.music;
    if (m && mus) {
      try {
        m.volume = flags.current.muteMusic ? 0 : Math.max(0, Math.min(1, mus.volume ?? 0.6));
        const target = (mus.start || 0) + t;
        const dur = m.duration || 0;
        if (dur > 0 && target >= dur) { if (m.playing) m.pause(); }
        else {
          if (force || Math.abs((m.currentTime || 0) - target) > 0.25) m.seekTo(target).catch?.(() => {});
          if (playing && !m.playing) m.play();
          if (!playing && m.playing) m.pause();
        }
      } catch {}
    }
    const v = voiceRef.current;
    const vo = e?.audio?.voiceover;
    if (v && vo) {
      try {
        v.volume = flags.current.muteVoice ? 0 : Math.max(0, Math.min(1, vo.volume ?? 1));
        const dur = v.duration || 0;
        if (dur > 0 && t >= dur) { if (v.playing) v.pause(); }
        else {
          if (force || Math.abs((v.currentTime || 0) - t) > 0.25) v.seekTo(t).catch?.(() => {});
          if (playing && !v.playing) v.play();
          if (!playing && v.playing) v.pause();
        }
      } catch {}
    }
  }, []);

  const musicUrl = edl?.audio?.music?.url || null;
  useEffect(() => {
    const pl = createAudio(musicUrl);
    musicRef.current = pl;
    if (pl) setTimeout(() => syncAudio(clock?.t || 0, true), 150);
    return () => { musicRef.current = null; try { pl?.pause(); pl?.remove?.(); } catch {} };
  }, [musicUrl, syncAudio, clock]);
  const voiceUri = edl?.audio?.voiceover?.uri || null;
  useEffect(() => {
    const pl = createAudio(voiceUri);
    voiceRef.current = pl;
    if (pl) setTimeout(() => syncAudio(clock?.t || 0, true), 150);
    return () => { voiceRef.current = null; try { pl?.pause(); pl?.remove?.(); } catch {} };
  }, [voiceUri, syncAudio, clock]);

  // ─── Vídeo ───────────────────────────────────────────────────────────────
  const applyClipProps = useCallback((p, clip) => {
    if (!p || !clip) return;
    try { p.playbackRate = clip.speed || 1; } catch {}
    try {
      const ov = edlRef.current?.audio?.original_volume ?? 1;
      p.volume = flags.current.muteOriginal ? 0 : Math.max(0, Math.min(1, ov));
      p.muted = flags.current.muteOriginal || ov <= 0;
    } catch {}
  }, []);

  // Carregamentos por player são ENFILEIRADOS (pré-carga × seek no mesmo player
  // não podem trocar a fonte em paralelo); activate espera o do slot que usar.
  const loadSlot = useCallback((slot, idx) => {
    const run = async () => {
      const clip = edlRef.current?.clips?.[idx];
      const p = playersRef.current[slot];
      if (!clip || !p) return;
      slotClip.current[slot] = idx;
      if (clip.kind === 'image') return;
      if (slotUri.current[slot] !== clip.uri) {
        slotUri.current[slot] = clip.uri;
        await replaceSrc(p, clip.uri);
      }
      if (activeSlotRef.current === slot && slotClip.current[slot] === activeIdx.current && playingRef.current) return;
      try { p.pause(); } catch {}
      try { p.currentTime = clip.in; } catch {}
      applyClipProps(p, clip);
    };
    // Marca o slot já (activate encontra pelo índice) e serializa a troca de fonte.
    if (edlRef.current?.clips?.[idx]) slotClip.current[slot] = idx;
    const pr = slotLoad.current[slot].then(run, run);
    slotLoad.current[slot] = pr.catch(() => {});
    return pr;
  }, [applyClipProps]);

  const fitOf = (clip) => (clip && clip.w && clip.h && clip.w / clip.h > 0.75 ? 'contain' : 'cover');

  const activate = useCallback(async (idx, local, play) => {
    const e = edlRef.current;
    const clip = e?.clips?.[idx];
    if (!clip) return;
    const seq = ++opSeq.current;
    const players2 = playersRef.current;
    let slot = slotClip.current.indexOf(idx);
    if (slot < 0) {
      slot = 1 - activeSlotRef.current;
      await loadSlot(slot, idx);
    } else {
      await slotLoad.current[slot];
      if (clip.kind !== 'image' && slotUri.current[slot] !== clip.uri) await loadSlot(slot, idx);
    }
    if (seq !== opSeq.current) return;
    activeIdx.current = idx;
    activeSlotRef.current = slot;
    const other = players2[1 - slot];
    try { other.pause(); } catch {}
    if (clip.kind === 'image') {
      imgWall.current = { at: Date.now(), local };
      try { players2[slot].pause(); } catch {}
    } else {
      const p = players2[slot];
      applyClipProps(p, clip);
      try { p.currentTime = local; } catch {}
      try { if (play) p.play(); else p.pause(); } catch {}
    }
    setView((v) => {
      const mirror = [...v.mirror];
      const fit = [...v.fit];
      mirror[slot] = !!clip.mirror;
      fit[slot] = fitOf(clip);
      return { slot, image: clip.kind === 'image' ? clip.uri : null, mirror, fit };
    });
    // Pré-carrega o próximo no outro player.
    const n = e.clips.length;
    const nx = idx + 1 < n ? idx + 1 : (flags.current.loop && n > 1 ? 0 : -1);
    if (nx >= 0 && nx !== idx) loadSlot(1 - slot, nx).catch(() => {});
  }, [loadSlot, applyClipProps]);

  const currentT = useCallback(() => {
    const e = edlRef.current;
    const idx = activeIdx.current;
    const clip = e?.clips?.[idx];
    if (!clip) return 0;
    let local;
    if (clip.kind === 'image') {
      local = playingRef.current ? imgWall.current.local + (Date.now() - imgWall.current.at) / 1000 : imgWall.current.local;
    } else {
      try { local = playersRef.current[activeSlotRef.current].currentTime; } catch { local = clip.in; }
      if (!(local >= 0)) local = clip.in;
    }
    const sp = clip.kind === 'image' ? 1 : (clip.speed || 1);
    return { t: (startsRef.current[idx] || 0) + Math.max(0, local - clip.in) / sp, local, clip, idx };
  }, []);

  const stopTicker = () => { if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; } };

  const setPlaying = useCallback((on) => {
    if (playingRef.current === on) return;
    playingRef.current = on;
    if (clock) clock.playing = on;
    onPlayingChange?.(on);
  }, [clock, onPlayingChange]);

  const pause = useCallback(() => {
    if (!playingRef.current) return;
    const cur = currentT();
    stopTicker();
    if (cur?.clip?.kind === 'image') imgWall.current = { at: Date.now(), local: cur.local };
    setPlaying(false);
    try { playersRef.current[activeSlotRef.current].pause(); } catch {}
    syncAudio(cur?.t || 0, false);
    if (cur && clock) clock.set(cur.t);
  }, [currentT, setPlaying, syncAudio, clock]);

  const advance = useCallback(async () => {
    const e = edlRef.current;
    const n = e?.clips?.length || 0;
    const nx = activeIdx.current + 1;
    if (nx < n) {
      await activate(nx, e.clips[nx].in, true);
      return;
    }
    if (flags.current.loop) {
      await activate(0, e.clips[0].in, true);
      clock?.set(0);
      syncAudio(0, true);
      return;
    }
    stopTicker();
    setPlaying(false);
    try { playersRef.current[activeSlotRef.current].pause(); } catch {}
    syncAudio(totalDuration(e), false);
    clock?.set(totalDuration(e));
    onEnded?.();
  }, [activate, clock, syncAudio, setPlaying, onEnded]);

  const startTicker = useCallback(() => {
    stopTicker();
    let advancing = false;
    tickRef.current = setInterval(() => {
      if (!playingRef.current || advancing) return;
      const cur = currentT();
      if (!cur || !cur.clip) return;
      clock?.set(cur.t);
      const now = Date.now();
      if (now - lastAudioSync.current > 1000) { lastAudioSync.current = now; syncAudio(cur.t, false); }
      const endLocal = cur.clip.out - (cur.clip.kind === 'image' ? 0 : 0.045 * (cur.clip.speed || 1));
      if (cur.local >= endLocal) {
        advancing = true;
        advance().finally(() => { advancing = false; });
      }
    }, 40);
  }, [currentT, clock, syncAudio, advance]);

  const seek = useCallback(async (t) => {
    const e = edlRef.current;
    if (!e?.clips?.length) return;
    const total = totalDuration(e);
    const tt = Math.max(0, Math.min(total - 0.01, t));
    const { index, local } = locate(e, tt);
    await activate(index, local, playingRef.current);
    clock?.set(tt);
    syncAudio(tt, true);
  }, [activate, clock, syncAudio]);

  const play = useCallback(async () => {
    const e = edlRef.current;
    if (!e?.clips?.length) return;
    let t = clock ? clock.t : 0;
    if (t >= totalDuration(e) - 0.05) t = 0;
    setPlaying(true);
    const { index, local } = locate(e, t);
    await activate(index, local, true);
    clock?.set(t);
    syncAudio(t, true);
    startTicker();
  }, [clock, activate, syncAudio, startTicker, setPlaying]);

  useImperativeHandle(ref, () => ({
    play, pause, seek,
    toggle: () => (playingRef.current ? pause() : play()),
    isPlaying: () => playingRef.current,
    time: () => (clock ? clock.t : 0),
  }), [play, pause, seek, clock]);

  // EDL mudou (corte, ordem, velocidade, volume…) → re-sincroniza no mesmo t.
  useEffect(() => {
    const prev = edlRef.current;
    edlRef.current = edl;
    startsRef.current = clipStarts(edl);
    const clipsChanged = !prev || prev.clips !== edl?.clips;
    if (clipsChanged) {
      slotClip.current = [-1, -1];
      const t = Math.min(clock ? clock.t : 0, Math.max(0, totalDuration(edl) - 0.01));
      if (edl?.clips?.length) {
        const { index, local } = locate(edl, t);
        activate(index, local, playingRef.current).catch(() => {});
        clock?.set(t);
      }
    } else {
      const p = playersRef.current[activeSlotRef.current];
      applyClipProps(p, edl?.clips?.[activeIdx.current]);
    }
    syncAudio(clock ? clock.t : 0, false);
  }, [edl]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const p = playersRef.current[activeSlotRef.current];
    applyClipProps(p, edlRef.current?.clips?.[activeIdx.current]);
    syncAudio(clock ? clock.t : 0, false);
  }, [muteOriginal, muteMusic, muteVoice, applyClipProps, syncAudio, clock]);

  useEffect(() => () => {
    stopTicker();
    try { playersRef.current.forEach((p) => p.pause()); } catch {}
  }, []);

  const filter = edl?.filter || { id: 'none', intensity: 1 };
  return (
    <View style={[styles.stage, { width, height }]}>
      {[0, 1].map((s) => (
        <VideoView
          key={s}
          player={players[s]}
          style={[
            StyleSheet.absoluteFill,
            { opacity: view.slot === s && !view.image ? 1 : 0 },
            view.mirror[s] ? { transform: [{ scaleX: -1 }] } : null,
          ]}
          contentFit={view.fit[s]}
          nativeControls={false}
          allowsPictureInPicture={false}
          surfaceType={Platform.OS === 'android' ? 'textureView' : undefined}
          useExoShutter={false}
          pointerEvents="none"
        />
      ))}
      {!!view.image && (
        <Image source={{ uri: view.image }} style={[StyleSheet.absoluteFill, view.mirror[view.slot] ? { transform: [{ scaleX: -1 }] } : null]} contentFit="cover" />
      )}
      <FilterLayer id={filter.id} intensity={filter.intensity ?? 1} />
      {children}
    </View>
  );
});

const styles = StyleSheet.create({
  stage: { backgroundColor: '#000', overflow: 'hidden' },
});

export default EdlPreview;
