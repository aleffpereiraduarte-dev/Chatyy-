// app/live-viewer.web.js — Web-only live viewer.
//
// Why this file exists:
// `app/live-viewer.js` (mobile) imports `@livekit/react-native`, which on
// web either silently no-ops or returns stubs depending on Metro's resolution
// of `react-native` mocks. The screen rendered as a blank white page when a
// shared link `chatyy.com.br/live/<session_id>` was opened in a browser —
// the mobile screen's first render threw, the ErrorBoundary swallowed it,
// nothing visible. Expo Router's `.web.js` platform extension picks THIS file
// for the web bundle automatically, leaving `live-viewer.js` untouched on
// mobile.
//
// Pipeline branching mirrors the mobile screen but uses web-native tech:
//   - LiveKit  → `livekit-client` (^2.19) attaching tracks to <video>/<audio>
//   - CF HLS   → `hls.js` (^1.6) for Chrome/Firefox, native <video> on Safari
//   - ended    → "Esta live terminou" card
//   - fallback → "Live indisponível" message
//
// Author: 2026-05-21 — fix for the `chatyy.com.br/live/<id>` white-page bug.

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Pressable, TextInput } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import * as api from '../services/api';

// LiveKit web SDK — direct import is fine on web (it's the JS package, no
// native bindings). On mobile this file is never bundled because of the
// `.web.js` extension.
// [2026-10-11 boot-split] livekit-client via services/lkLoader (own async
// chunk); the default export is wrapped in withLiveKit() so these bindings are
// filled before the screen renders.
import { lkSync as _lkSync, withLiveKit as _withLiveKit } from '../services/lkLoader';
let Room, RoomEvent, Track;
function _bindLiveKit() { if (Room) return; const lk = _lkSync(); if (lk) ({ Room, RoomEvent, Track } = lk); }
import { IconEye, IconSend, IconHeart, IconVolumeX, IconChevronLeft, IconVideoOff, IconWifiOff } from '../components/Icons';
// [multi-guest 2026-10-10] Palco multi-convidados também no web.
import useLiveStage from '../hooks/useLiveStage';
import LiveGuestStage from '../components/liveGuests/LiveGuestStage';
// [live-pk 2026-10-10] Batalha PK (split host x adversário + placar).
import LiveBattleStage from '../components/liveBattle/LiveBattleStage';
import LiveBattleLayer from '../components/liveBattle/LiveBattleLayer';
import { useLiveBattleController, useBattleSelector, selSplitVisible } from '../components/liveBattle/battleStore';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import LiveFollowButton from '../components/live/LiveFollowButton';

// [lives 2026-10-10] Interação no web: comentários em tempo real pelo hub WS
// (sem polling), corações SVG animados por CSS (compositor do browser, sem
// re-render por quadro), contagem de pessoas assistindo do hub, aviso de host
// reconectando, comentário fixado. Visual P&B (sem vermelho/rosa).
const WS_URL = 'wss://chatyy.com.br/ws';
const HEART_PATH = 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z';
const MAX_COMMENTS = 60;
const MAX_HEARTS = 24;
let _lvwCssDone = false;
function ensureLiveCss() {
  if (_lvwCssDone || typeof document === 'undefined') return;
  _lvwCssDone = true;
  try {
    const st = document.createElement('style');
    st.textContent = '@keyframes lvwFloat{0%{transform:translate(0,0) scale(.6);opacity:0}12%{opacity:1;transform:translate(0,-30px) scale(1.05)}100%{transform:translate(var(--dx),-340px) scale(.9);opacity:0}}'
      + '.lvw-heart{position:absolute;right:28px;bottom:96px;width:30px;height:30px;pointer-events:none;animation:lvwFloat 1.9s cubic-bezier(.2,.7,.3,1) forwards;will-change:transform,opacity;filter:drop-shadow(0 2px 6px rgba(0,0,0,.45))}'
      + '@keyframes lvwIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}.lvw-c{animation:lvwIn .22s ease-out}'
      // [2026-10-12 live-polish] anel "respirando" do conectando + entrada suave dos cartões.
      + '@keyframes lvwRing{0%{transform:scale(1);opacity:.55}100%{transform:scale(1.55);opacity:0}}.lvw-ring{position:absolute;inset:0;border-radius:999px;border:2px solid rgba(255,255,255,.7);animation:lvwRing 1.6s ease-out infinite;pointer-events:none}'
      + '.lvw-card{animation:lvwIn .32s cubic-bezier(.2,.7,.3,1)}';
    document.head.appendChild(st);
  } catch {}
}

// hls.js is loaded dynamically only when we need it (CF HLS pipeline). Keeps
// the initial bundle smaller for LiveKit-only viewers.


function prettifyHandle(handle) {
  if (!handle) return '';
  return String(handle)
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function getInitial(name, email) {
  const src = (name || email || '?').trim();
  return src.charAt(0).toUpperCase() || '?';
}

function LiveViewerWeb() {
  _bindLiveKit();
  const params = useLocalSearchParams();
  const router = useRouter();
  const { t } = useLanguage();
  const { user } = useAuth() || {};
  const sessionId = String(params.sessionId || params.id || '');

  // Pipeline state.
  const [phase, setPhase] = useState('loading'); // loading | ended | livekit | hls | unavailable
  const [errorMsg, setErrorMsg] = useState('');
  const [host, setHost] = useState({
    name: params.hostName ? String(params.hostName) : '',
    email: params.hostEmail ? String(params.hostEmail) : '',
    avatar: params.hostAvatar ? String(params.hostAvatar) : '',
  });
  const [viewerCount, setViewerCount] = useState(0);
  const [likesTotal, setLikesTotal] = useState(0); // [lives-engage] total do hub
  const [muted, setMuted] = useState(true); // browsers require muted autoplay
  const [connected, setConnected] = useState(false);
  // [lives 2026-10-10] interação
  const [comments, setComments] = useState([]);
  const [draft, setDraft] = useState('');
  const [hearts, setHearts] = useState([]);
  const [notice, setNotice] = useState('');
  const [pinned, setPinned] = useState(null);
  const wsRef = useRef(null);
  const battle = useLiveBattleController({ sessionId, wsRef, me: {}, isHost: false });
  const battleSplit = useBattleSelector(battle, selSplitVisible);
  const noticeTimerRef = useRef(null);
  const heartSeqRef = useRef(0);
  const lastHeartSentRef = useRef([]);

  // DOM refs.
  const videoElRef = useRef(null);
  const audioElRef = useRef(null);

  // LK refs.
  const lkRoomRef = useRef(null);
  // [multi-guest] Um <audio> por faixa remota (host + convidados). Antes tudo
  // ia para UM elemento → com convidado no palco só se ouvia uma pessoa.
  const extraAudioRef = useRef(new Map()); // trackSid → HTMLAudioElement
  const mutedRef = useRef(true);
  // Tracks whether we ever successfully attached a remote track. If we did and
  // the room later disconnects (host ended the live / socket dropped), we show
  // an "ended" card instead of an infinite "Conectando à live..." spinner.
  const wasConnectedRef = useRef(false);

  // HLS refs.
  const hlsInstanceRef = useRef(null);
  const hlsUrlRef = useRef('');
  // [2026-05-26] Bounded HLS recovery. hls.js does NOT stop on its own when a
  // fatal error fires — and our old handler set phase=unavailable WITHOUT
  // destroying the instance, so hls.js kept retrying fragment loads in the
  // background (CPU burn while the user stares at the error card). Now we
  // attempt hls.js's built-in recovery (startLoad / recoverMediaError) up to
  // MAX_HLS_RETRIES, then destroy the instance and surface unavailable once.
  const hlsRetryRef = useRef(0);
  const MAX_HLS_RETRIES = 5;

  // ─── Cleanup helpers ─────────────────────────────────────────────────
  const teardownLk = useCallback(() => {
    try {
      extraAudioRef.current.forEach((el) => { try { el.srcObject = null; el.remove(); } catch {} });
      extraAudioRef.current.clear();
    } catch {}
    try {
      if (lkRoomRef.current) {
        lkRoomRef.current.disconnect();
        lkRoomRef.current = null;
      }
    } catch (e) {
      // swallow — already disconnected
    }
  }, []);

  const teardownHls = useCallback(() => {
    try {
      if (hlsInstanceRef.current) {
        hlsInstanceRef.current.destroy();
        hlsInstanceRef.current = null;
      }
    } catch (e) {
      // swallow
    }
  }, []);

  useEffect(() => {
    return () => {
      teardownLk();
      teardownHls();
    };
  }, [teardownLk, teardownHls]);

  // ─── Discovery: status + pipeline ─────────────────────────────────────
  useEffect(() => {
    if (!sessionId) {
      setPhase('unavailable');
      setErrorMsg(t('liveWeb.invalidSession') || 'Sessão inválida');
      return undefined;
    }

    let cancelled = false;

    (async () => {
      try {
        const res = await api.liveStatusCf(sessionId);
        if (cancelled) return;
        const data = res?.data || res || {};

        // ENDED — strict check (status='ended' AND ended_at set) to avoid
        // false positives on dual-pipeline legacy rows.
        const ds = String(data.status || '').toLowerCase();
        const endedAt = data.ended_at;
        const endedStatus = (ds === 'ended' || ds === 'finished' || ds === 'complete');
        const hasEndedAt = (endedAt != null && endedAt !== '' && endedAt !== '0');
        if (endedStatus && hasEndedAt) {
          setPhase('ended');
          return;
        }

        // Populate host metadata if backend returned it (helps avatar/name
        // overlay).
        if (data.host_email && !host.email) {
          setHost(h => ({
            ...h,
            email: data.host_email,
            name: data.host_name || h.name || prettifyHandle(String(data.host_email).split('@')[0]),
            avatar: data.host_avatar || data.avatar_url || h.avatar,
          }));
        }
        if (typeof data.viewer_count === 'number') setViewerCount(data.viewer_count);

        const pipeline = String(data.pipeline || '').toLowerCase();

        // LIVEKIT branch.
        if (pipeline === 'livekit' || data.lk_room_name) {
          await connectLiveKit();
          return;
        }

        // CF HLS branch.
        const hlsUrl = data.hls_url ? String(data.hls_url) : '';
        if (pipeline === 'cf_stream' && hlsUrl) {
          await connectHls(hlsUrl);
          return;
        }

        // Pipeline known but no playable URL yet — surface "publisher missing"
        if (pipeline === 'cf_stream' && !hlsUrl) {
          setPhase('unavailable');
          setErrorMsg(t('live.publisherMissing') || 'Aguardando o host publicar a transmissão...');
          return;
        }

        // Unknown / legacy_p2p — web has no P2P client; show fallback.
        setPhase('unavailable');
        setErrorMsg(pipeline === 'legacy_p2p'
          ? (t('liveWeb.legacyP2p') || 'Esta live usa um formato antigo (P2P) incompatível com o navegador. Abra no app.')
          : (t('liveWeb.tryLater') || 'Tente novamente em alguns instantes.'));
      } catch (e) {
        if (cancelled) return;
        console.warn('[live-viewer.web] discover failed:', e?.message || e);
        setPhase('unavailable');
        setErrorMsg(t('liveWeb.loadFailed') || 'Não foi possível carregar a live');
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // ─── LiveKit connect ──────────────────────────────────────────────────
  const connectLiveKit = useCallback(async () => {
    try {
      const join = await api.liveJoinLk(sessionId);
      if (!join?.success || !join?.data?.lk_token) {
        throw new Error(join?.message || 'live_join_lk failed');
      }
      const { lk_url, lk_token } = join.data;
      const url = lk_url || 'wss://livekit.chatyy.com.br';

      // Populate host info from join payload if discovery didn't already.
      if (join.data.host_email) {
        setHost(h => ({
          ...h,
          email: join.data.host_email,
          name: join.data.host_name || h.name || prettifyHandle(String(join.data.host_email).split('@')[0]),
          avatar: join.data.host_avatar || h.avatar,
        }));
      }

      setPhase('livekit');

      const room = new Room({ adaptiveStream: true, dynacast: false });
      lkRoomRef.current = room;

      const attach = (track) => {
        try {
          if (!track) return;
          if (track.kind === Track.Kind.Video && videoElRef.current) {
            track.attach(videoElRef.current);
            videoElRef.current.muted = muted;
            videoElRef.current.playsInline = true;
            const playPromise = videoElRef.current.play?.();
            if (playPromise && playPromise.catch) playPromise.catch(() => {});
          } else if (track.kind === Track.Kind.Audio) {
            const key = track.sid || track.mediaStreamTrack?.id || String(Math.random());
            if (!extraAudioRef.current.has(key)) {
              const el = track.attach();
              el.muted = mutedRef.current;
              el.style.display = 'none';
              try { document.body.appendChild(el); } catch {}
              extraAudioRef.current.set(key, el);
              const playPromise = el.play?.();
              if (playPromise && playPromise.catch) playPromise.catch(() => {});
            }
          }
          setConnected(true);
          wasConnectedRef.current = true;
        } catch (e) {
          console.warn('[live-viewer.web] track attach failed:', e?.message || e);
        }
      };

      const detachAll = () => {
        try {
          if (videoElRef.current) videoElRef.current.srcObject = null;
          if (audioElRef.current) audioElRef.current.srcObject = null;
        } catch {}
      };

      room.on(RoomEvent.TrackSubscribed, (track) => attach(track));
      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        try {
          if (track && track.kind === Track.Kind.Audio) {
            const key = track.sid || track.mediaStreamTrack?.id;
            const el = key ? extraAudioRef.current.get(key) : null;
            if (el) { try { track.detach(el); el.remove(); } catch {} extraAudioRef.current.delete(key); }
          }
        } catch {}
        // Re-collect to keep playing if other tracks exist.
        room.remoteParticipants.forEach((p) => {
          p.trackPublications.forEach((pub) => {
            if (pub.track) attach(pub.track);
          });
        });
      });
      room.on(RoomEvent.ParticipantConnected, () => {
        setViewerCount(c => c + 1);
      });
      room.on(RoomEvent.ParticipantDisconnected, () => {
        setViewerCount(c => Math.max(0, c - 1));
      });
      room.on(RoomEvent.Disconnected, () => {
        detachAll();
        setConnected(false);
        // Once we've had a live picture, a disconnect means the broadcast is
        // over (host ended it) or our connection dropped for good. Render the
        // "encerrada" card rather than leaving the viewer stuck on the
        // "Conectando à live..." spinner forever (#permanent-loading).
        if (wasConnectedRef.current) {
          setPhase('ended');
        }
      });

      await room.connect(url, lk_token);

      // Initial sweep — host may have published before our listener attached.
      room.remoteParticipants.forEach((p) => {
        p.trackPublications.forEach((pub) => {
          if (pub.track) attach(pub.track);
        });
      });
    } catch (e) {
      console.warn('[live-viewer.web] LK connect failed:', e?.message || e);
      setPhase('unavailable');
      setErrorMsg(t('liveWeb.connectFailed') || 'Não foi possível conectar à live');
    }
  }, [sessionId, muted]);

  // ─── HLS connect ──────────────────────────────────────────────────────
  const connectHls = useCallback(async (url) => {
    setPhase('hls');
    hlsUrlRef.current = url;
    hlsRetryRef.current = 0; // fresh stream → fresh retry budget.
    // Defer to next tick so <video> is mounted.
    setTimeout(async () => {
      const video = videoElRef.current;
      if (!video) return;
      video.muted = muted;
      video.playsInline = true;

      // Safari can play HLS natively via the canPlayType MIME check.
      const canNative = !!video.canPlayType && video.canPlayType('application/vnd.apple.mpegurl') !== '';
      if (canNative) {
        video.src = url;
        try { await video.play(); } catch {}
        setConnected(true);
        return;
      }

      try {
        const mod = await import('hls.js');
        const Hls = mod.default || mod;
        if (!Hls.isSupported || !Hls.isSupported()) {
          setPhase('unavailable');
          setErrorMsg(t('liveWeb.hlsUnsupported') || 'Este navegador não consegue reproduzir a live');
          return;
        }
        const hls = new Hls({ enableWorker: true, lowLatencyMode: true });
        hlsInstanceRef.current = hls;
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          const p = video.play?.();
          if (p && p.catch) p.catch(() => {});
          setConnected(true);
          // A successful (re)parse means the stream is healthy again — reset the
          // retry budget so a later transient blip gets its full recovery window.
          hlsRetryRef.current = 0;
        });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data?.fatal) return; // non-fatal: hls.js self-heals, ignore.
          hlsRetryRef.current += 1;
          console.warn('[live-viewer.web] HLS fatal:', data?.type, data?.details,
            'retry', hlsRetryRef.current, '/', MAX_HLS_RETRIES);
          if (hlsRetryRef.current > MAX_HLS_RETRIES) {
            // Budget exhausted — STOP. Destroy the instance so hls.js doesn't
            // keep hammering the segment endpoint in the background, then
            // surface the failure exactly once.
            try { hls.destroy(); } catch {}
            if (hlsInstanceRef.current === hls) hlsInstanceRef.current = null;
            setPhase('unavailable');
            setErrorMsg(t('liveWeb.playbackError') || 'Erro de reprodução da live');
            return;
          }
          // Within budget — attempt the matching hls.js recovery.
          try {
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              hls.startLoad();
            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              hls.recoverMediaError();
            } else {
              // Other fatal error (e.g. MUX/KEY) is unrecoverable — give up now.
              try { hls.destroy(); } catch {}
              if (hlsInstanceRef.current === hls) hlsInstanceRef.current = null;
              setPhase('unavailable');
              setErrorMsg(t('liveWeb.playbackError') || 'Erro de reprodução da live');
            }
          } catch (recErr) {
            console.warn('[live-viewer.web] HLS recovery threw:', recErr?.message || recErr);
            try { hls.destroy(); } catch {}
            if (hlsInstanceRef.current === hls) hlsInstanceRef.current = null;
            setPhase('unavailable');
            setErrorMsg(t('liveWeb.playbackError') || 'Erro de reprodução da live');
          }
        });
      } catch (e) {
        console.warn('[live-viewer.web] hls.js import failed:', e?.message || e);
        setPhase('unavailable');
        setErrorMsg(t('liveWeb.playerLoadFailed') || 'Não foi possível carregar o player da live');
      }
    }, 0);
  }, [muted]);

  // ─── [lives 2026-10-10] Hub WS: comentários/reações/contagem ─────────
  const flashNotice = useCallback((txt, ms = 2200) => {
    setNotice(txt || '');
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    if (txt) noticeTimerRef.current = setTimeout(() => setNotice(''), ms);
  }, []);

  const spawnHeart = useCallback(() => {
    const id = ++heartSeqRef.current;
    const dx = Math.round((Math.random() - 0.5) * 120);
    const shade = Math.random() < 0.5 ? '#ffffff' : '#d4d4d4';
    setHearts((prev) => {
      const next = prev.length >= MAX_HEARTS ? prev.slice(prev.length - MAX_HEARTS + 1) : prev.slice();
      next.push({ id, dx, shade });
      return next;
    });
    setTimeout(() => setHearts((prev) => prev.filter((h) => h.id !== id)), 2000);
  }, []);

  const liveActive = phase === 'livekit' || phase === 'hls';
  useEffect(() => {
    if (!sessionId || !liveActive) return undefined;
    ensureLiveCss();
    let alive = true;
    let attempt = 0;
    let timer = null;
    const open = () => {
      if (!alive) return;
      let ws;
      try { ws = new WebSocket(WS_URL); } catch { return; }
      wsRef.current = ws;
      ws.onopen = () => {
        attempt = 0;
        try { ws.send(JSON.stringify({ type: 'auth', token: api.getAuthToken(), client: 'js', platform: 'web' })); } catch {}
      };
      ws.onmessage = (ev) => {
        if (!alive) return;
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m && m.data && typeof m.data === 'object' && !Array.isArray(m.data)) m = { ...m.data, ...m };
        try { battle.onWsMessage(m); } catch {} // [live-pk] observador
        const ty = m?.type || m?.event;
        if (ty === 'auth_success' || ty === 'authenticated') {
          try { ws.send(JSON.stringify({ type: 'live_join', session_id: sessionId })); } catch {}
          return;
        }
        if (m.session_id && String(m.session_id) !== sessionId) return;
        switch (ty) {
          case 'live_chat': {
            const c = { id: `${m.timestamp || Date.now()}-${Math.random()}`, name: m.sender_name || String(m.sender_email || '').split('@')[0] || '?', text: String(m.content || '') };
            if (!c.text) return;
            setComments((prev) => { const n = prev.concat(c); return n.length > MAX_COMMENTS ? n.slice(n.length - MAX_COMMENTS) : n; });
            return;
          }
          case 'live_reaction':
            if (typeof m.likes_total === 'number') setLikesTotal((v) => Math.max(v, m.likes_total));
            spawnHeart();
            return;
          // [lives-engage] estado inicial de curtidas (hub com live_engage.go).
          case 'live_joined':
            setTimeout(() => { try { ws.send(JSON.stringify({ type: 'live_engage_state', session_id: sessionId })); } catch {} }, 400);
            return;
          case 'live_engage_state':
            if (typeof m.likes_total === 'number') setLikesTotal((v) => Math.max(v, m.likes_total));
            return;
          case 'live_viewer_count':
            if (typeof m.count === 'number') setViewerCount(m.count);
            return;
          case 'live_pin_comment':
          case 'live_pin': {
            const txt = String(m.comment_text || m.content || '');
            setPinned(txt ? { text: txt, name: m.comment_author_name || m.sender_name || '' } : null);
            return;
          }
          case 'live_host_reconnecting':
            flashNotice(t('live.hostReconnecting'), 45000);
            return;
          case 'live_host_back':
            flashNotice('');
            return;
          case 'live_chat_rejected': {
            const r = m.reason;
            flashNotice(r === 'filtered' ? t('live.commentBlocked')
              : r === 'banned' ? t('live.commentBanned')
              : r === 'slow_mode' ? String(t('live.slowModeWait') || '').replace('{n}', String(m.wait_seconds || 1))
              : r === 'too_long' ? t('live.commentTooLong')
              : t('live.commentTooFast'));
            return;
          }
          case 'live_ended':
            setPhase('ended');
            return;
          default:
        }
      };
      ws.onclose = () => {
        if (!alive) return;
        const wait = Math.min(15000, 800 * 2 ** attempt++);
        timer = setTimeout(open, wait);
      };
      ws.onerror = () => { try { ws.close(); } catch {} };
    };
    open();
    // Histórico curto pra quem chega no meio (best-effort).
    api.liveChatHistory?.(sessionId, 30).then((res) => {
      const rows = res?.data?.messages || res?.data || [];
      if (!alive || !Array.isArray(rows) || !rows.length) return;
      setComments((prev) => {
        const old = rows.map((r, i) => ({ id: `h${r.id || i}`, name: r.sender_name || r.name || String(r.sender_email || r.email || '').split('@')[0] || '?', text: String(r.content || '') })).filter((c) => c.text);
        return old.concat(prev).slice(-MAX_COMMENTS);
      });
    }).catch(() => {});
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      try { wsRef.current?.close(); } catch {}
      wsRef.current = null;
    };
  }, [sessionId, liveActive, spawnHeart, flashNotice, t]);

  useEffect(() => () => { if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current); }, []);

  const sendComment = useCallback(() => {
    const text = String(draft || '').trim();
    if (!text) return;
    setDraft('');
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify({ type: 'live_chat', session_id: sessionId, content: text.slice(0, 300) })); } catch {}
    }
    // Persistência/moderação no servidor (histórico pra quem chega depois).
    api.liveSendChat?.(sessionId, text.slice(0, 300)).catch(() => {});
  }, [draft, sessionId]);

  const sendHeart = useCallback(() => {
    spawnHeart();
    // Teto local (o hub também limita): 8 reações/s.
    const now = Date.now();
    lastHeartSentRef.current = lastHeartSentRef.current.filter((x) => now - x < 1000);
    if (lastHeartSentRef.current.length >= 8) return;
    lastHeartSentRef.current.push(now);
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify({ type: 'live_reaction', session_id: sessionId, emoji: 'heart', like: true, count: 1 })); } catch {}
    }
  }, [sessionId, spawnHeart]);

  // ─── Unmute on first user gesture ────────────────────────────────────
  const handleUnmute = useCallback(() => {
    setMuted(false);
    mutedRef.current = false;
    try { extraAudioRef.current.forEach((el) => { el.muted = false; el.play?.()?.catch?.(() => {}); }); } catch {}
    try { if (videoElRef.current) videoElRef.current.muted = false; } catch {}
    try { if (audioElRef.current) audioElRef.current.muted = false; } catch {}
    try { videoElRef.current?.play?.()?.catch?.(() => {}); } catch {}
    try { audioElRef.current?.play?.()?.catch?.(() => {}); } catch {}
  }, []);

  // ─── Go back ─────────────────────────────────────────────────────────
  const handleBack = useCallback(() => {
    teardownLk();
    teardownHls();
    if (router.canGoBack && router.canGoBack()) router.back();
    else router.replace('/');
  }, [router, teardownLk, teardownHls]);

  // [multi-guest 2026-10-10] Grade TikTok quando há convidados no palco.
  const _stage = useLiveStage(phase === 'livekit' ? lkRoomRef.current : null, { hostEmail: host.email });
  const stageTiles = _stage.publishers.slice(0, 5).map((p) => ({
    key: p.email, email: p.email, name: p.isHost ? (host.name || p.name) : p.name, isHost: p.isHost,
    videoTrack: p.videoTrack, micMuted: p.micMuted, camOff: p.camOff, speaking: p.speaking,
  }));

  // ─── Render branches ─────────────────────────────────────────────────

  // [2026-10-12 live-polish] Estados (encerrada / indisponível) no mesmo
  // visual do app: fundo preto, avatar do host, CTA branco, link secundário.
  const goDiscover = () => {
    teardownLk();
    teardownHls();
    try { router.replace('/live-discover'); } catch { try { router.push('/live-discover'); } catch {} }
  };
  const renderAvatar = (size, dim) => (
    <View style={[styles.avatarCircle, { width: size, height: size, borderRadius: size / 2 }, dim && { opacity: 0.55 }]}>
      {host.avatar
        ? React.createElement('img', {
            src: host.avatar,
            alt: host.name || '',
            style: { width: size, height: size, borderRadius: size / 2, objectFit: 'cover', filter: dim ? 'grayscale(1)' : 'none' },
          })
        : <Text style={[styles.avatarInitial, { fontSize: Math.round(size * 0.4) }]}>{getInitial(host.name, host.email)}</Text>}
    </View>
  );
  const renderStateCard = ({ Icon, title, body }) => (
    <View style={styles.fullScreen}>
      {React.createElement('div', { style: { position: 'absolute', inset: 0, pointerEvents: 'none', background: 'radial-gradient(120% 70% at 50% 0%, rgba(255,255,255,0.10) 0%, rgba(0,0,0,0) 60%)' } })}
      <View style={styles.stateWrap}>
        {React.createElement('div', { className: 'lvw-card', style: { display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' } },
          <View style={styles.stateMedia}>
            {(host.avatar || host.name || host.email) ? renderAvatar(88, true) : (
              <View style={styles.stateIconCircle}><Icon size={34} color="#fff" /></View>
            )}
            {(host.avatar || host.name || host.email) ? (
              <View style={styles.stateIconBadge}><Icon size={14} color="#000" /></View>
            ) : null}
          </View>,
          <Text key="t" style={styles.cardTitle}>{title}</Text>,
          <Text key="b" style={styles.cardSub}>{body}</Text>,
          <Pressable key="p" onPress={handleBack} style={({ hovered, pressed }) => [styles.primaryBtn, (hovered || pressed) && { opacity: 0.88 }]} accessibilityRole="button">
            <Text style={styles.primaryBtnText}>{t('common.back') || 'Voltar'}</Text>
          </Pressable>,
          <Pressable key="s" onPress={goDiscover} style={({ hovered }) => [styles.ghostBtn, hovered && { opacity: 0.75 }]} accessibilityRole="button">
            <Text style={styles.ghostBtnText}>{t('live.seeOtherLives') || 'Ver outras lives'}</Text>
          </Pressable>,
        )}
      </View>
    </View>
  );

  if (phase === 'ended') {
    ensureLiveCss();
    return renderStateCard({
      Icon: IconVideoOff,
      title: t('liveWeb.endedTitle') || 'Esta live já terminou',
      body: host.name
        ? (t('liveWeb.endedByHost', { name: host.name }) || `${host.name} encerrou a transmissão.`)
        : (t('liveWeb.endedGeneric') || 'A transmissão foi encerrada.'),
    });
  }

  if (phase === 'unavailable') {
    ensureLiveCss();
    return renderStateCard({
      Icon: IconWifiOff,
      title: t('liveWeb.unavailableTitle') || 'Live indisponível',
      body: errorMsg || t('liveWeb.tryLater') || 'Tente novamente em alguns instantes.',
    });
  }

  // loading / livekit / hls — all share the player layout.
  const showLoading = phase === 'loading' || !connected;
  const hostLabel = host.name || (host.email ? prettifyHandle(host.email.split('@')[0]) : 'Live');
  const fmtCount = (n) => (n >= 1000000 ? (Math.floor(n / 100000) / 10) + 'M' : n >= 1000 ? (Math.floor(n / 100) / 10) + 'K' : String(n));

  return (
    <View style={styles.fullScreen}>
      {/* Underlying media. Both elements always mounted; LK/HLS attach to whichever they need. */}
      {/* React Native Web translates these via "data-rn" — but for <video> we
          render them with createElement directly for browser semantics. */}
      {React.createElement('video', {
        ref: videoElRef,
        autoPlay: true,
        playsInline: true,
        muted,
        onDoubleClick: sendHeart,
        style: {
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          // [lives 2026-10-10] tela cheia vertical (estilo TikTok/IG); host em
          // paisagem continua inteiro em telas largas.
          objectFit: (typeof window !== 'undefined' && window.innerWidth < 700) ? 'cover' : 'contain',
          backgroundColor: '#000',
        },
      })}
      {React.createElement('audio', {
        ref: audioElRef,
        autoPlay: true,
        muted,
        style: { display: 'none' },
      })}
      {phase === 'livekit' && stageTiles.length >= 2 ? (
        <LiveGuestStage tiles={stageTiles} topInset={0} hostLabel={t('liveGuests.host')} youLabel={t('liveGuests.you')} />
      ) : null}
      {phase === 'livekit' && battleSplit ? (
        <LiveBattleStage battle={battle} left={{ track: _stage.host?.videoTrack || null }} topInset={0} t={t} muted={muted} />
      ) : null}
      <LiveBattleLayer battle={battle} t={t} isHost={false} topInset={0} />

      {/* [2026-10-12 live-polish] Degradês de leitura (topo + base) — o texto
          branco fica legível em qualquer vídeo, sem faixa preta chapada. */}
      {React.createElement('div', { style: { position: 'absolute', top: 0, left: 0, right: 0, height: 150, pointerEvents: 'none', zIndex: 4, background: 'linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.18) 60%, rgba(0,0,0,0) 100%)' } })}
      {React.createElement('div', { style: { position: 'absolute', bottom: 0, left: 0, right: 0, height: '46%', pointerEvents: 'none', zIndex: 4, background: 'linear-gradient(0deg, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.35) 45%, rgba(0,0,0,0) 100%)' } })}

      {/* Top overlay: host pill + viewer count */}
      <View style={styles.topRow} pointerEvents="box-none">
        <View style={styles.hostPill}>
          {renderAvatar(32, false)}
          <View style={styles.hostMeta}>
            <Text style={styles.hostName} numberOfLines={1}>{hostLabel}</Text>
            {likesTotal > 0 ? (
              <View style={styles.hostSubRow}>
                <IconHeart size={11} color="rgba(255,255,255,0.75)" />
                <Text style={styles.hostSubText}>{fmtCount(likesTotal)}</Text>
              </View>
            ) : null}
          </View>
          {/* [2026-10-12 live-polish] Seguir direto do vídeo (igual ao app). */}
          {host.email && user?.email ? (
            <View style={styles.followWrap}>
              <LiveFollowButton hostEmail={host.email} myEmail={user?.email} />
            </View>
          ) : null}
        </View>

        <View style={styles.topRight}>
          <View style={styles.liveBadge}>
            <View style={styles.liveDot} />
            <Text style={styles.liveText}>{t('live.live') || 'AO VIVO'}</Text>
          </View>
          <View style={styles.viewerPill}>
            <IconEye size={14} color="#fff" />
            <Text style={styles.viewerCount}>{fmtCount(viewerCount)}</Text>
          </View>
        </View>
      </View>

      {/* Loading / connecting overlay */}
      {showLoading && (
        <View style={styles.loadingOverlay} pointerEvents="none">
          <View style={styles.loadingAvatarWrap}>
            {React.createElement('div', { className: 'lvw-ring' })}
            {renderAvatar(76, false)}
          </View>
          <View style={styles.loadingRow}>
            <ActivityIndicator size="small" color="#fff" />
            <Text style={styles.loadingText}>{t('liveWeb.connecting') || 'Conectando à live…'}</Text>
          </View>
        </View>
      )}

      {/* [lives 2026-10-10] corações (CSS no compositor) */}
      {hearts.map((h) => React.createElement('svg', {
        key: h.id,
        className: 'lvw-heart',
        viewBox: '0 0 24 24',
        style: { '--dx': `${h.dx}px` },
      }, React.createElement('path', { d: HEART_PATH, fill: h.shade })))}

      {/* comentário fixado */}
      {pinned ? (
        <View style={styles.pinned} pointerEvents="none">
          <Text style={styles.pinnedText} numberOfLines={2}>
            {pinned.name ? <Text style={styles.pinnedName}>{pinned.name}  </Text> : null}
            {pinned.text}
          </Text>
        </View>
      ) : null}

      {/* comentários ao vivo */}
      {liveActive ? (
        <View style={styles.commentsWrap} pointerEvents="none">
          {comments.slice(-7).map((c) => (
            <View key={c.id} style={styles.commentRow}>
              <Text style={styles.commentText}>
                <Text style={styles.commentName}>{c.name}  </Text>
                {c.text}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {notice ? (
        <View style={styles.notice} pointerEvents="none">
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      ) : null}

      {/* barra inferior: comentar + coração */}
      {liveActive ? (
        <View style={styles.composerRow}>
          <Pressable onPress={handleBack} style={styles.roundBtn} accessibilityLabel={t('common.back') || 'Voltar'}>
            <IconChevronLeft size={22} color="#fff" />
          </Pressable>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={sendComment}
            placeholder={t('live.commentPlaceholder') || ''}
            placeholderTextColor="rgba(255,255,255,0.6)"
            maxLength={300}
            style={styles.composerInput}
            returnKeyType="send"
          />
          {draft.trim() ? (
            <Pressable onPress={sendComment} style={[styles.roundBtn, styles.sendBtn]} accessibilityLabel={t('live.send') || 'Enviar'}>
              <IconSend size={18} color="#000" />
            </Pressable>
          ) : (
            <Pressable onPress={sendHeart} style={[styles.roundBtn, styles.heartBtn]} accessibilityLabel={t('live.react')}>
              {React.createElement('svg', { viewBox: '0 0 24 24', width: 22, height: 22 }, React.createElement('path', { d: HEART_PATH, fill: '#000' }))}
            </Pressable>
          )}
        </View>
      ) : null}

      {/* Tap-to-unmute prompt (only while muted and connected) */}
      {muted && connected && (
        <Pressable onPress={handleUnmute} style={styles.unmuteBanner} accessibilityRole="button">
          <IconVolumeX size={16} color="#000" />
          <Text style={styles.unmuteText}>{t('liveWeb.tapUnmute') || 'Toque para ativar o som'}</Text>
        </Pressable>
      )}

      {/* Back button (bottom-left) — a barra de comentários já tem voltar */}
      {!liveActive && (
      <Pressable onPress={handleBack} style={styles.backBtn} accessibilityRole="button" accessibilityLabel={t('common.back') || 'Voltar'}>
        <IconChevronLeft size={18} color="#fff" />
        <Text style={styles.backBtnText}>{t('common.back') || 'Voltar'}</Text>
      </Pressable>
      )}
    </View>
  );
}

const GLASS = {
  backgroundColor: 'rgba(0,0,0,0.38)',
  borderWidth: StyleSheet.hairlineWidth,
  borderColor: 'rgba(255,255,255,0.16)',
  backdropFilter: 'blur(14px) saturate(140%)',
  WebkitBackdropFilter: 'blur(14px) saturate(140%)',
};
const TEXT_SHADOW = { textShadowColor: 'rgba(0,0,0,0.55)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3 };

const styles = StyleSheet.create({
  fullScreen: {
    flex: 1,
    minHeight: '100vh',
    backgroundColor: '#000',
    position: 'relative',
    overflow: 'hidden',
  },
  stateWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    maxWidth: 420,
    width: '100%',
    alignSelf: 'center',
  },
  stateMedia: {
    width: 88,
    height: 88,
    marginBottom: 22,
    position: 'relative',
  },
  stateIconCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stateIconBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#fff',
    borderWidth: 3,
    borderColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: -0.3,
    marginBottom: 8,
    textAlign: 'center',
  },
  cardSub: {
    color: 'rgba(255,255,255,0.62)',
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 28,
    lineHeight: 21,
    maxWidth: 320,
  },
  primaryBtn: {
    backgroundColor: '#fff',
    height: 48,
    minWidth: 220,
    paddingHorizontal: 28,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  },
  primaryBtnText: {
    color: '#000',
    fontWeight: '700',
    fontSize: 15,
  },
  ghostBtn: {
    marginTop: 10,
    height: 44,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  },
  ghostBtnText: {
    color: 'rgba(255,255,255,0.8)',
    fontWeight: '600',
    fontSize: 14,
  },
  topRow: {
    position: 'absolute',
    top: 14,
    left: 12,
    right: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    zIndex: 10,
  },
  hostPill: {
    ...GLASS,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    paddingLeft: 4,
    paddingRight: 14,
    borderRadius: 999,
    maxWidth: '62%',
  },
  hostMeta: { marginLeft: 8, flexShrink: 1, minWidth: 0 },
  followWrap: { marginLeft: 10, marginRight: -6 },
  hostSubRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 1 },
  hostSubText: { color: 'rgba(255,255,255,0.75)', fontSize: 11, fontWeight: '600' },
  avatarCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#2a2a2a',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.9)',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarInitial: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
  },
  hostName: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 14,
    letterSpacing: -0.1,
  },
  topRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#dc2626',
    paddingHorizontal: 8,
    height: 24,
    borderRadius: 6,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#fff',
    marginRight: 5,
  },
  liveText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  commentsWrap: {
    position: 'absolute',
    left: 12,
    right: 88,
    bottom: 80,
    zIndex: 9,
  },
  commentRow: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(0,0,0,0.28)',
    borderRadius: 14,
    paddingVertical: 6,
    paddingHorizontal: 10,
    marginTop: 6,
    maxWidth: '100%',
  },
  commentText: { color: '#fff', fontSize: 14, lineHeight: 19, ...TEXT_SHADOW },
  commentName: { color: 'rgba(255,255,255,0.72)', fontWeight: '700', fontSize: 13, ...TEXT_SHADOW },
  pinned: {
    position: 'absolute',
    top: 64,
    left: 12,
    right: 12,
    backgroundColor: 'rgba(255,255,255,0.94)',
    borderRadius: 14,
    paddingVertical: 9,
    paddingHorizontal: 12,
    zIndex: 10,
  },
  pinnedText: { color: '#000', fontSize: 13, fontWeight: '500' },
  pinnedName: { color: '#000', fontWeight: '800', fontSize: 13 },
  notice: {
    ...GLASS,
    position: 'absolute',
    top: '42%',
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 18,
    zIndex: 12,
  },
  noticeText: { color: '#fff', fontSize: 14, fontWeight: '600', textAlign: 'center' },
  composerRow: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    zIndex: 11,
  },
  composerInput: {
    ...GLASS,
    flex: 1,
    height: 44,
    borderRadius: 22,
    paddingHorizontal: 16,
    color: '#fff',
    fontSize: 15,
    backgroundColor: 'rgba(255,255,255,0.14)',
    outlineStyle: 'none',
  },
  roundBtn: {
    ...GLASS,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  },
  heartBtn: { backgroundColor: '#fff', borderColor: '#fff' },
  sendBtn: { backgroundColor: '#fff', borderColor: '#fff' },
  viewerPill: {
    ...GLASS,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 24,
    paddingHorizontal: 9,
    borderRadius: 6,
  },
  viewerCount: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  loadingOverlay: {
    position: 'absolute',
    inset: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    zIndex: 5,
  },
  loadingAvatarWrap: {
    width: 76,
    height: 76,
    marginBottom: 22,
    position: 'relative',
  },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  loadingText: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 14,
    fontWeight: '600',
  },
  unmuteBanner: {
    position: 'absolute',
    top: 64,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#fff',
    paddingVertical: 9,
    paddingHorizontal: 16,
    borderRadius: 999,
    zIndex: 11,
    cursor: 'pointer',
    boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
  },
  unmuteText: {
    color: '#000',
    fontWeight: '700',
    fontSize: 14,
  },
  backBtn: {
    ...GLASS,
    position: 'absolute',
    bottom: 20,
    left: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingVertical: 9,
    paddingLeft: 10,
    paddingRight: 16,
    borderRadius: 999,
    zIndex: 11,
    cursor: 'pointer',
  },
  backBtnText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
  },
});

export default _withLiveKit(LiveViewerWeb);
