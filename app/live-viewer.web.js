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
import { View, Text, StyleSheet, ActivityIndicator, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import * as api from '../services/api';

// LiveKit web SDK — direct import is fine on web (it's the JS package, no
// native bindings). On mobile this file is never bundled because of the
// `.web.js` extension.
import { Room, RoomEvent, Track } from 'livekit-client';

// hls.js is loaded dynamically only when we need it (CF HLS pipeline). Keeps
// the initial bundle smaller for LiveKit-only viewers.

const BRAND = '#7C3AED';

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

export default function LiveViewerWeb() {
  const params = useLocalSearchParams();
  const router = useRouter();
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
  const [muted, setMuted] = useState(true); // browsers require muted autoplay
  const [connected, setConnected] = useState(false);

  // DOM refs.
  const videoElRef = useRef(null);
  const audioElRef = useRef(null);

  // LK refs.
  const lkRoomRef = useRef(null);

  // HLS refs.
  const hlsInstanceRef = useRef(null);
  const hlsUrlRef = useRef('');

  // ─── Cleanup helpers ─────────────────────────────────────────────────
  const teardownLk = useCallback(() => {
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
      setErrorMsg('Sessão inválida');
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
          setErrorMsg('Aguardando o host publicar a transmissão...');
          return;
        }

        // Unknown / legacy_p2p — web has no P2P client; show fallback.
        setPhase('unavailable');
        setErrorMsg(pipeline === 'legacy_p2p'
          ? 'Esta live usa um formato antigo (P2P) incompatível com o navegador. Abra no app.'
          : 'Live indisponível');
      } catch (e) {
        if (cancelled) return;
        console.warn('[live-viewer.web] discover failed:', e?.message || e);
        setPhase('unavailable');
        setErrorMsg('Não foi possível carregar a live');
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
          } else if (track.kind === Track.Kind.Audio && audioElRef.current) {
            track.attach(audioElRef.current);
            audioElRef.current.muted = muted;
            const playPromise = audioElRef.current.play?.();
            if (playPromise && playPromise.catch) playPromise.catch(() => {});
          }
          setConnected(true);
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
      room.on(RoomEvent.TrackUnsubscribed, () => {
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
      setErrorMsg('Não foi possível conectar à live');
    }
  }, [sessionId, muted]);

  // ─── HLS connect ──────────────────────────────────────────────────────
  const connectHls = useCallback(async (url) => {
    setPhase('hls');
    hlsUrlRef.current = url;
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
          setErrorMsg('Navegador não suporta HLS');
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
        });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data?.fatal) {
            console.warn('[live-viewer.web] HLS fatal:', data?.type, data?.details);
            setPhase('unavailable');
            setErrorMsg('Erro de reprodução da live');
          }
        });
      } catch (e) {
        console.warn('[live-viewer.web] hls.js import failed:', e?.message || e);
        setPhase('unavailable');
        setErrorMsg('Não foi possível carregar o player de live');
      }
    }, 0);
  }, [muted]);

  // ─── Unmute on first user gesture ────────────────────────────────────
  const handleUnmute = useCallback(() => {
    setMuted(false);
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

  // ─── Render branches ─────────────────────────────────────────────────

  if (phase === 'ended') {
    return (
      <View style={styles.fullScreen}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Esta live já terminou</Text>
          <Text style={styles.cardSub}>
            {host.name ? `${host.name} encerrou a transmissão.` : 'A transmissão foi encerrada.'}
          </Text>
          <Pressable onPress={handleBack} style={styles.primaryBtn}>
            <Text style={styles.primaryBtnText}>Voltar</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (phase === 'unavailable') {
    return (
      <View style={styles.fullScreen}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Live indisponível</Text>
          <Text style={styles.cardSub}>{errorMsg || 'Tente novamente em alguns instantes.'}</Text>
          <Pressable onPress={handleBack} style={styles.primaryBtn}>
            <Text style={styles.primaryBtnText}>Voltar</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // loading / livekit / hls — all share the player layout.
  const showLoading = phase === 'loading' || !connected;
  const hostLabel = host.name || (host.email ? prettifyHandle(host.email.split('@')[0]) : 'Live');

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
        style: {
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          backgroundColor: '#000',
        },
      })}
      {React.createElement('audio', {
        ref: audioElRef,
        autoPlay: true,
        muted,
        style: { display: 'none' },
      })}

      {/* Top overlay: host pill + viewer count */}
      <View style={styles.topRow} pointerEvents="box-none">
        <View style={styles.hostPill}>
          <View style={styles.avatarCircle}>
            {host.avatar
              ? React.createElement('img', {
                  src: host.avatar,
                  alt: hostLabel,
                  style: { width: 28, height: 28, borderRadius: 14, objectFit: 'cover' },
                })
              : <Text style={styles.avatarInitial}>{getInitial(host.name, host.email)}</Text>}
          </View>
          <View style={{ marginLeft: 8 }}>
            <Text style={styles.hostName} numberOfLines={1}>{hostLabel}</Text>
            <View style={styles.liveBadge}>
              <View style={styles.liveDot} />
              <Text style={styles.liveText}>AO VIVO</Text>
            </View>
          </View>
        </View>

        <View style={styles.viewerPill}>
          <Text style={styles.viewerEye}>👁</Text>
          <Text style={styles.viewerCount}>{viewerCount}</Text>
        </View>
      </View>

      {/* Loading / connecting overlay */}
      {showLoading && (
        <View style={styles.loadingOverlay} pointerEvents="none">
          <ActivityIndicator size="large" color={BRAND} />
          <Text style={styles.loadingText}>Conectando à live...</Text>
        </View>
      )}

      {/* Tap-to-unmute prompt (only while muted and connected) */}
      {muted && connected && (
        <Pressable onPress={handleUnmute} style={styles.unmuteBanner}>
          <Text style={styles.unmuteText}>Toque para ativar o som</Text>
        </Pressable>
      )}

      {/* Back button (bottom-left) */}
      <Pressable onPress={handleBack} style={styles.backBtn}>
        <Text style={styles.backBtnText}>‹ Voltar</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  fullScreen: {
    flex: 1,
    minHeight: '100vh',
    backgroundColor: '#000',
    position: 'relative',
    overflow: 'hidden',
  },
  card: {
    margin: 'auto',
    padding: 24,
    maxWidth: 380,
    width: '90%',
    backgroundColor: '#111',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#222',
    alignItems: 'center',
  },
  cardTitle: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  cardSub: {
    color: '#aaa',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 20,
    lineHeight: 20,
  },
  primaryBtn: {
    backgroundColor: BRAND,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 999,
  },
  primaryBtnText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 15,
  },
  topRow: {
    position: 'absolute',
    top: 16,
    left: 16,
    right: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    zIndex: 10,
  },
  hostPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
    maxWidth: '70%',
  },
  avatarCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: BRAND,
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
    fontWeight: '600',
    fontSize: 13,
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#ff3b30',
    marginRight: 4,
  },
  liveText: {
    color: '#ff3b30',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  viewerPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
  },
  viewerEye: {
    color: '#fff',
    fontSize: 13,
    marginRight: 4,
  },
  viewerCount: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  loadingOverlay: {
    position: 'absolute',
    inset: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
    zIndex: 5,
  },
  loadingText: {
    color: '#fff',
    marginTop: 12,
    fontSize: 14,
    fontWeight: '500',
  },
  unmuteBanner: {
    position: 'absolute',
    bottom: 80,
    alignSelf: 'center',
    backgroundColor: BRAND,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 999,
    zIndex: 11,
  },
  unmuteText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
  },
  backBtn: {
    position: 'absolute',
    bottom: 24,
    left: 16,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    zIndex: 11,
  },
  backBtnText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
  },
});
