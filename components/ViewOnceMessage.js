import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, Pressable,
  Image, ActivityIndicator, Platform, StatusBar as RNStatusBar, BackHandler,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { IconLock, IconX, IconMic, IconPlay, IconPause } from './Icons';
import ChatyySecureView from './chat/ChatyySecureView'; // [2026-10-19 secure-view] view-once sempre protegido
import { secureViewAvailable } from '../services/captureBlock';
import Svg, { Path } from 'react-native-svg';
import { viewOncePaths, viewOnceRingPaths, viewOnceState } from './chat/viewOnceGlyphs'; // [2026-10-21 view-once WA]

// [2026-10-21 view-once WA] Glifo "1" tracejado / ✓ aberta / anel de envio —
// MESMOS paths do cartão nativo (viewOnceGlyphs). Sem disco de fundo.
function VOGlyph({ kind, color, pct, track, size = 24 }) {
  if (kind === 'sending' && (pct == null)) return <ActivityIndicator size="small" color={color} />;
  const ps = kind === 'sending' ? viewOnceRingPaths(Math.max(0.04, pct), color, track || 'rgba(127,127,127,0.3)') : viewOncePaths(kind, color);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" strokeLinecap="round" strokeLinejoin="round">
      {ps.map((p, i) => <Path key={i} d={p.d} stroke={p.k} strokeWidth={p.w} fill="none" />)}
    </Svg>
  );
}
function _rgbaOf(hex, a) {
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return `rgba(127,127,127,${a})`;
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

let _expoVideoMod = null;
function loadExpoVideo() {
  if (_expoVideoMod !== null) return _expoVideoMod;
  try { _expoVideoMod = require('expo-video'); }
  catch { _expoVideoMod = false; }
  return _expoVideoMod;
}

let _expoAudioMod = null;
function loadExpoAudio() {
  if (_expoAudioMod !== null) return _expoAudioMod;
  try { _expoAudioMod = require('expo-audio'); }
  catch { _expoAudioMod = false; }
  return _expoAudioMod;
}

// [2026-10-12 P0 view-once] expo-image com cachePolicy="none" no viewer: o
// <Image> do RN gravava a foto no cache de disco do SO (NSURLCache/Fresco).
let _expoImageMod = null;
function loadExpoImage() {
  if (_expoImageMod !== null) return _expoImageMod;
  if (Platform.OS === 'web') { _expoImageMod = false; return _expoImageMod; }
  try { _expoImageMod = require('expo-image'); }
  catch { _expoImageMod = false; }
  return _expoImageMod;
}

// Registro view-once no mediaCache (recusa gravar em disco) + purge.
function _mc() {
  if (Platform.OS === 'web') return null;
  try { return require('../services/mediaCache'); } catch { return null; }
}

// expo-screen-capture is native-only (no-op on web). Load defensively so the
// view-once viewer still mounts if the module is absent (web bundle / older
// native build that predates the dependency).
let _screenCaptureMod = null;
function loadScreenCapture() {
  if (_screenCaptureMod !== null) return _screenCaptureMod;
  try { _screenCaptureMod = require('expo-screen-capture'); }
  catch { _screenCaptureMod = false; }
  return _screenCaptureMod;
}

// [2026-10-14 adv-privacy] View-once SEMPRE protegido: iOS escudo durante
// gravação/espelhamento (modules/expo-chat-privacy) + áudio não toca gravando.
function _cp() {
  try { return require('../services/chatPrivacy'); } catch { return null; }
}

const VIEWED_KEY = 'chatyy.viewOnceViewed.v1';

async function _loadLocalViewed() {
  try {
    const raw = await AsyncStorage.getItem(VIEWED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch { return new Set(); }
}
async function _markLocalViewed(id) {
  try {
    const raw = await AsyncStorage.getItem(VIEWED_KEY);
    const arr = raw ? (JSON.parse(raw) || []) : [];
    const set = new Set(arr.map(String));
    set.add(String(id));
    const next = Array.from(set).slice(-2000);
    await AsyncStorage.setItem(VIEWED_KEY, JSON.stringify(next));
  } catch {}
}

const _parseViewedBy = (raw) => {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
};

function FullscreenVideoPlayer({ uri, onLoaded, onEnded, onError }) {
  const mod = loadExpoVideo();
  if (!mod || !mod.useVideoPlayer || !mod.VideoView) {
    onError?.(new Error('expo-video unavailable'));
    return null;
  }
  const { useVideoPlayer, VideoView } = mod;
  const loadedRef = useRef(false);
  const endedRef = useRef(false);

  // useCaching:false — view-once nunca vai pro cache de vídeo do expo-video.
  const player = useVideoPlayer(uri ? { uri, useCaching: false } : null, (p) => {
    p.loop = false;
    try { const r = p.play?.(); if (r?.catch) r.catch(() => {}); } catch {}
  });

  useEffect(() => {
    if (!player) return;
    const subStatus = player.addListener?.('statusChange', (e) => {
      const status = e?.status || e;
      if ((status === 'readyToPlay' || status === 'playing') && !loadedRef.current) {
        loadedRef.current = true;
        onLoaded?.();
      }
      if (status === 'error') onError?.(e?.error || new Error('video error'));
    });
    const subEnded = player.addListener?.('ended', () => {
      if (!endedRef.current) { endedRef.current = true; onEnded?.(); }
    });
    return () => {
      try { subStatus?.remove?.(); subEnded?.remove?.(); } catch {}
      // Defensive teardown — expo-video's hook auto-disposes the player on
      // unmount, but on rapid open/close cycles (multiple view-once views in
      // a row) the AVPlayer/MediaCodec buffer can stay resident long enough
      // to push iPad/low-RAM Android into GC pressure. Pause + release the
      // source explicitly so resources are reclaimed before the next modal
      // mounts a fresh player.
      try { player.pause?.(); } catch {}
      try { player.replace?.(null); } catch {}
      try { player.release?.(); } catch {}
    };
  }, [player, onLoaded, onEnded, onError]);

  return (
    <VideoView
      player={player}
      style={{ flex: 1, width: '100%', backgroundColor: '#000' }}
      contentFit="contain"
      nativeControls={false}
      allowsFullscreen={false}
    />
  );
}

function ViewOnceFullscreen({ uri, isVideo, t, senderName, onClose, onLoaded, onError, conversationId, messageId }) {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);

  // Anti-screenshot: block OS screen capture while the one-shot media is on
  // screen and notify the sender if a screenshot still slips through (same
  // pattern as ChatMediaViewer). Native-only — no-op on web / when the module
  // is missing.
  useEffect(() => {
    let _releaseShield = null;
    try {
      if (Platform.OS === 'ios') {
        _releaseShield = _cp()?.acquireCaptureProtection?.('chatyy-view-once-shield', {
          labels: { title: t?.('advPriv.protectedTitle') || 'Conteúdo protegido', subtitle: t?.('advPriv.protectedRecording') || '' },
          secureView: true,
        }) || null;
      }
    } catch {}
    const SC = loadScreenCapture();
    if (!SC) return () => { try { _releaseShield?.(); } catch {} };
    let sub;
    (async () => {
      // [2026-10-19 secure-view] iOS com <ChatyySecureView>: o print sai com o
      // aviso "Captura de tela bloqueada" — sem o prevent do expo (janela preta).
      if (!(Platform.OS === 'ios' && secureViewAvailable())) {
        try { await SC.preventScreenCaptureAsync?.('chatyy-view-once'); } catch {}
      }
      try {
        sub = SC.addScreenshotListener?.(() => {
          // Notify the peer that this user just took a screenshot. Backend
          // (chat.php case 'chat_screenshot_event') inserts a system msg with
          // subtype='screenshot' + emits a WS event. Fire-and-forget.
          if (conversationId) {
            try { globalThis.__chatyy_vo_shot_at = Date.now(); } catch {} // [2026-10-14 adv-privacy] sem aviso duplo
            try {
              const api = require('../services/api');
              api.apiCall?.('chat_screenshot_event', {
                conversation_id: conversationId,
                message_id: messageId || 0,
              }, 'POST').catch(() => {});
            } catch {}
          }
        });
      } catch {}
    })();
    return () => {
      try { sub?.remove?.(); } catch {}
      try { SC.allowScreenCaptureAsync?.('chatyy-view-once')?.catch?.(() => {}); } catch {}
      try { require('../services/screenProtect').reassertScreenProtect?.(); } catch {} // [2026-10-15 screen-protect-all]
      try { _releaseShield?.(); } catch {}
    };
  }, [conversationId, messageId]);

  // Android back closes modal — mirror iOS X close
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose?.();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  const handleLoaded = useCallback(() => {
    if (loaded) return;
    setLoaded(true);
    onLoaded?.();
  }, [loaded, onLoaded]);

  const handleError = useCallback((e) => {
    setErrored(true);
    onError?.(e);
  }, [onError]);

  return (
    <Modal
      visible={true}
      transparent={false}
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
      hardwareAccelerated
    >
      <ChatyySecureView enabled dark coverColor="#000000" t={t}>
      <View style={fs.root}>
        {Platform.OS === 'android' ? (
          <RNStatusBar barStyle="light-content" backgroundColor="rgba(0,0,0,0.6)" translucent />
        ) : null}

        {/* Top header — sender + view-once badge */}
        <View style={[fs.header, { paddingTop: Platform.OS === 'android' ? 36 : 56 }]}>
          <Pressable
            onPress={onClose}
            hitSlop={16}
            style={({ pressed }) => [fs.closeBtn, pressed && { opacity: 0.6 }]}
            accessibilityRole="button"
            accessibilityLabel={t?.('common.close') || 'Fechar'}
          >
            <IconX size={26} color="#fff" />
          </Pressable>
          <View style={fs.headerCenter} pointerEvents="none">
            {senderName ? (
              <Text style={fs.senderName} numberOfLines={1}>{senderName}</Text>
            ) : null}
            <View style={fs.badgeRow}>
              <IconLock size={12} color="rgba(255,255,255,0.85)" />
              <Text style={fs.badgeText}>
                {(isVideo
                  ? (t?.('chatConv.viewOnceVideo') || 'Vídeo')
                  : (t?.('chatConv.viewOncePhoto') || 'Foto')) +
                  ' · ' +
                  (t?.('chatConv.viewOnce') || 'Visualização única')}
              </Text>
            </View>
          </View>
          <View style={fs.closeBtn} />
        </View>

        {/* Content area */}
        <View style={fs.contentWrap}>
          {!!uri && isVideo ? (
            <FullscreenVideoPlayer
              uri={uri}
              onLoaded={handleLoaded}
              onEnded={onClose}
              onError={handleError}
            />
          ) : !!uri ? (
            (() => {
              const EI = loadExpoImage();
              if (EI && EI.Image) {
                return (
                  <EI.Image
                    source={{ uri }}
                    style={fs.fullImage}
                    contentFit="contain"
                    cachePolicy="none"
                    onLoad={handleLoaded}
                    onError={handleError}
                  />
                );
              }
              return (
                <Image
                  source={{ uri, cache: 'reload' }}
                  style={fs.fullImage}
                  resizeMode="contain"
                  onLoad={handleLoaded}
                  onError={handleError}
                />
              );
            })()
          ) : (
            <View style={fs.errorBox}>
              <Text style={fs.errorText}>
                {t?.('chatConv.viewOnceMissing') || 'Mídia indisponível'}
              </Text>
            </View>
          )}

          {!loaded && !errored ? (
            <View style={fs.spinnerWrap} pointerEvents="none">
              <ActivityIndicator size="large" color="#fff" />
            </View>
          ) : null}

          {errored ? (
            <View style={fs.errorOverlay}>
              <Text style={fs.errorText}>
                {t?.('chatConv.viewOnceLoadFailed') || 'Não foi possível carregar a mídia'}
              </Text>
              <TouchableOpacity
                onPress={onClose}
                style={fs.errorBtn}
                accessibilityRole="button"
              >
                <Text style={fs.errorBtnText}>
                  {t?.('common.close') || 'Fechar'}
                </Text>
              </TouchableOpacity>
            </View>
          ) : null}
        </View>

        {/* Bottom hint — reinforce one-shot semantics */}
        {loaded && !errored ? (
          <View style={fs.bottomHint} pointerEvents="none">
            <IconLock size={14} color="rgba(255,255,255,0.85)" />
            <Text style={fs.bottomHintText}>
              {t?.('chatConv.viewOnceHint') || 'Foto/vídeo só pode ser visto uma vez'}
            </Text>
          </View>
        ) : null}
      </View>
      </ChatyySecureView>
    </Modal>
  );
}

/**
 * View Once Message — strict WhatsApp semantics:
 *  - Sender: NEVER opens. Always sees a locked pill ("Foto · Visualização única",
 *    or "Aberta" if a recipient already opened). No tap target.
 *  - Receiver unviewed: Tap pill → fullscreen modal opens. Photo stays open
 *    until user dismisses (X / Android back). Video plays once and auto-closes.
 *    Mark-as-viewed fires only on real onLoad success — if media fails the
 *    user can retry and the pill stays tap-to-view.
 *  - Receiver viewed: locked "Aberta" / "Expirou" pill, no re-open.
 */
// [2026-10-16 native-cover] autoOpen: a lista NATIVA desenha o cartão "Toque
// para ver" e, no toque, monta este componente escondido com autoOpen → abre
// direto o MESMO viewer (mesmas regras de queima/captura). onAutoDone quando
// fecha (ou quando já estava visto/expirado).
export default function ViewOnceMessage({ msg, colors = {}, isOwn, onView, t, currentEmail, autoOpen = false, onAutoDone, ownInk, ownSubtle }) {
  const safeColors = {
    surface: '#fff',
    border: '#e0e0e0',
    primary: '#111111',
    textTertiary: '#999',
    textSecondary: '#666',
    text: '#000',
    ...colors,
  };

  const fileUrl = msg?.file_url || null;
  // Audio detection MUST come before video — a `.webm` voice note hits the
  // video extension regex otherwise and gets rendered with VideoView (black
  // screen, no audible playback). Voice notes use msg.type === 'audio' or
  // 'voice'; the extension check (.m4a/.opus/.ogg/.mp3/.aac/.wav) is the
  // belt-and-suspenders fallback for legacy rows that left type unset.
  const isAudio = (msg?.type === 'audio' || msg?.type === 'voice') ||
    /\.(m4a|opus|ogg|mp3|aac|wav)(\?|$)/i.test(String(fileUrl || ''));
  const isVideo = !isAudio && (
    (msg?.type === 'video') ||
    /\.(mp4|mov|webm|mkv|avi|m4v|3gp)(\?|$)/i.test(String(fileUrl || ''))
  );

  const vb = _parseViewedBy(msg?.viewed_by);
  const meLower = String(currentEmail || '').toLowerCase();
  const vbHasMe = !!meLower && vb.map(e => String(e || '').toLowerCase()).includes(meLower);
  const vbHasAny = vb.length > 0;

  const [localViewed, setLocalViewed] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      const set = await _loadLocalViewed();
      if (alive && msg?.id != null && set.has(String(msg.id))) setLocalViewed(true);
    })();
    return () => { alive = false; };
  }, [msg?.id]);

  const isLocked = !!msg?.expired_at || vbHasMe || localViewed;
  const [modalOpen, setModalOpen] = useState(false);
  // [FIX 2026-06-30 "foto de visualização única tem bug"] Snapshot the media
  // URL the instant the modal opens. The server's chat_view_once_open handler
  // (called via onView on image load) now ACTUALLY deletes the file + clears
  // file_url + stamps expired_at, then broadcasts an 'update'. That update
  // round-trips back to THIS device and (a) flips isLocked→true (which used to
  // unmount the Modal mid-view) and (b) blanks msg.file_url (which blanked the
  // <Image> source). Holding the opened URI in state keeps the already-decoded
  // image on screen until the user dismisses it — true WhatsApp view-once UX.
  const [openedUri, setOpenedUri] = useState(null);
  // [2026-10-12 P1] Só "queima" a visualização se a mídia carregou de fato.
  const viewLoadedRef = useRef(false);
  // Receptor: registra a mídia como view-once p/ nenhum caminho de cache gravar.
  useEffect(() => {
    if (isOwn || !msg) return;
    try { _mc()?.markViewOnceMedia?.(msg.file_url, msg.id); } catch {}
  }, [isOwn, msg?.id, msg?.file_url]);

  const _autoRef = useRef(false);
  const _autoDoneRef = useRef(onAutoDone);
  _autoDoneRef.current = onAutoDone;
  useEffect(() => {
    if (!autoOpen || _autoRef.current || isOwn || isAudio) return;
    _autoRef.current = true;
    (async () => {
      let seen = false;
      try { const set = await _loadLocalViewed(); seen = msg?.id != null && set.has(String(msg.id)); } catch {}
      if (seen || !!msg?.expired_at || vbHasMe || !fileUrl) { try { _autoDoneRef.current?.(); } catch {} return; }
      viewLoadedRef.current = false;
      setOpenedUri(fileUrl);
      setModalOpen(true);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen]);

  // ───────────── SENDER BRANCH ─────────────
  if (isOwn) {
    // [fix 2026-10-01] Was hardcoded WHITE text (assumed a dark bubble), but the
    // own bubble is LIGHT (#F1F3F5) in light mode → white-on-light = "muito
    // apagada". Use theme text colors so it contrasts on both own-bubble tones.
    // [2026-10-21 view-once WA] tinta da PRÓPRIA bolha (grafite #34343A → branco);
    // antes colors.text (#18181B) = ícone invisível na bolha escura.
    const accent = ownInk || '#FFFFFF';
    const subtle = ownSubtle || _rgbaOf(accent, 0.6);
    const S = viewOnceState(msg, true, false, vbHasAny);
    const sub = S.st === 'sending'
      ? (t?.('chatConv.sending') || 'Enviando...')
      : S.st === 'opened'
        ? (t?.('chatConv.viewOnceOpened') || 'Aberta')
        : (t?.('chatConv.viewOnceSent') || 'Visualização única');
    const title = isAudio
      ? (t?.('chatConv.viewOnceVoiceLabel') || 'Áudio único')
      : isVideo
        ? (t?.('chatConv.viewOnceVideo') || 'Vídeo único')
        : (t?.('chatConv.viewOncePhoto') || 'Foto única');
    const opened = S.st === 'opened';
    return (
      <View style={s.expiredRow}>
        <View style={s.glyphBox}>
          <VOGlyph kind={S.st === 'sent' ? 'one' : S.st} color={opened ? subtle : accent} pct={S.pct} track={_rgbaOf(accent, 0.25)} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[s.expiredTitle, { color: opened ? subtle : accent }]} numberOfLines={1}>{title}</Text>
          <Text style={[s.expiredSub, { color: subtle }, !opened && { fontStyle: 'normal' }]} numberOfLines={1}>{sub}</Text>
        </View>
      </View>
    );
  }

  // ───────────── RECEIVER EXPIRED ─────────────
  // Stay out of the expired-pill branch while the fullscreen modal is open, so
  // a server 'update' (expired_at/viewed_by/file_url cleared, fired the instant
  // the photo loads) can't unmount the Modal before the user has actually seen
  // the photo. Locks cleanly once they close it (onClose sets modalOpen=false).
  if (isLocked && !modalOpen) {
    const accent = safeColors.primary;
    const subtle = safeColors.textSecondary;
    const title = isAudio
      ? (t?.('chatConv.viewOnceVoiceLabel') || 'Áudio único')
      : isVideo
        ? (t?.('chatConv.viewOnceVideo') || 'Vídeo único')
        : (t?.('chatConv.viewOncePhoto') || 'Foto única');
    const subLabel = isAudio
      ? (t?.('chatConv.viewOnceVoiceExpired') || 'Áudio expirado')
      : (t?.('chatConv.viewOnceOpened') || 'Aberta');
    return (
      <View style={s.expiredRow}>
        <View style={s.glyphBox}>
          {isAudio ? <IconMic size={18} color={subtle} /> : <VOGlyph kind="opened" color={subtle} />}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[s.expiredTitle, { color: subtle }]} numberOfLines={1}>{title}</Text>
          <Text style={[s.expiredSub, { color: subtle }]} numberOfLines={1}>{subLabel}</Text>
        </View>
      </View>
    );
  }

  // ───────────── RECEIVER UNVIEWED — AUDIO inline play ─────────────
  // Audio view-once doesn't open a fullscreen modal — the recipient taps the
  // pill, the audio plays inline once, and the bubble locks to "expired" as
  // soon as the player emits `ended`. If playback errors out the pill stays
  // tap-to-listen so the user can retry (same retry semantics as image/video).
  if (isAudio) {
    return (
      <ViewOnceAudioPlayer
        msg={msg}
        fileUrl={fileUrl}
        colors={safeColors}
        t={t}
        onConsumed={() => {
          if (msg?.id != null) { _markLocalViewed(msg.id).catch(() => {}); }
          setLocalViewed(true);
          onView?.(msg?.id);
        }}
      />
    );
  }

  // ───────────── RECEIVER UNVIEWED — tap to open fullscreen ─────────────
  const accent = safeColors.primary;
  const subtle = safeColors.textSecondary;

  return (
    <>
      <TouchableOpacity
        onPress={() => { if (!modalOpen) { viewLoadedRef.current = false; setOpenedUri(fileUrl); setModalOpen(true); } }}
        activeOpacity={0.7}
        style={s.tapRow}
        accessibilityRole="button"
        accessibilityLabel={t?.('chatConv.tapToView') || 'Toque para ver'}
      >
        <View style={s.glyphBox}>
          <VOGlyph kind="one" color={accent} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[s.tapTitle, { color: accent }]} numberOfLines={1}>
            {isVideo
              ? (t?.('chatConv.viewOnceVideo') || 'Vídeo único')
              : (t?.('chatConv.viewOncePhoto') || 'Foto única')}
          </Text>
          <Text style={[s.tapSub, { color: subtle }]} numberOfLines={1}>
            {t?.('chatConv.tapToView') || 'Toque para ver'}
          </Text>
        </View>
      </TouchableOpacity>

      {modalOpen ? (
        <ViewOnceFullscreen
          uri={openedUri || fileUrl}
          isVideo={isVideo}
          t={t}
          senderName={msg?.sender_name || ''}
          conversationId={msg?.conversation_id}
          messageId={msg?.id}
          onClose={() => {
            // [FIX 2026-05-20] Lock state moves to onClose so the Modal stays
            // mounted while the user is actually viewing. Previously setLocalViewed
            // ran on onLoaded → isLocked flipped true mid-render → component
            // switched to "expired" branch → Modal unmounted before the user
            // saw anything ("abre e fecha na hora"). WhatsApp parity: lock
            // only after user dismisses.
            setModalOpen(false);
            if (autoOpen) { try { _autoDoneRef.current?.(); } catch {} } // [native-cover]
            // [2026-10-12 P1] Falhou/fechou antes de carregar → NÃO queima:
            // o pill continua "Toque para ver" p/ tentar de novo.
            if (!viewLoadedRef.current) return;
            if (msg?.id != null) { _markLocalViewed(msg.id).catch(() => {}); }
            setLocalViewed(true);
            try { _mc()?.purgeViewOnceMedia?.(openedUri || fileUrl, msg?.id)?.catch?.(() => {}); } catch {}
          }}
          onLoaded={() => {
            // Tell the server it was opened (so the sender sees "Aberta") but
            // DO NOT flip local state yet — that would unmount the Modal.
            viewLoadedRef.current = true;
            onView?.(msg?.id);
          }}
          onError={() => { /* keep pill open for retry */ }}
        />
      ) : null}
    </>
  );
}

/**
 * View-once audio player — receiver-side, single-shot inline playback.
 *
 *  - Initial state: purple pill with mic icon + "Tocar para ouvir" sub.
 *  - On tap: starts playback (HTMLAudio on web, expo-audio AudioPlayer on
 *    native). Pill flips to "Tocando... 0:03 / 0:14" with a play→pause swap.
 *  - On `ended`: fire onConsumed (which marks the row server-side as opened
 *    + locks locally). The parent ViewOnceMessage then re-renders us into
 *    the "expired" pill via `isLocked === true`.
 *  - On `error`: surface a "tap to retry" sub. Don't burn the view.
 *  - Pause: tapping while playing pauses but does NOT lock — only `ended`
 *    counts as consumption (WhatsApp parity; user must hear it through).
 */
function ViewOnceAudioPlayer({ msg, fileUrl, colors, t, onConsumed }) {
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(Number(msg?.duration) || 0);
  const [errored, setErrored] = useState(false);
  const soundRef = useRef(null);
  const intervalRef = useRef(null);
  const consumedRef = useRef(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (intervalRef.current) clearInterval(intervalRef.current);
      // Pause + release on unmount so we don't leak an AVPlayer / HTMLAudio.
      try {
        if (Platform.OS === 'web') soundRef.current?.pause?.();
        else {
          soundRef.current?.pause?.();
          soundRef.current?._sub?.remove?.();
          soundRef.current?.remove?.();
        }
      } catch {}
      soundRef.current = null;
    };
  }, []);

  // [2026-10-14 adv-privacy] Tocando: Android FLAG_SECURE, iOS escudo; começou
  // a gravar/espelhar a tela no iPhone → pausa (o áudio iria para a gravação).
  useEffect(() => {
    if (!playing || Platform.OS === 'web') return undefined;
    const cp = _cp();
    if (!cp) return undefined;
    const release = cp.acquireCaptureProtection?.('chatyy-view-once-audio', {
      labels: { title: t?.('advPriv.protectedTitle') || 'Conteúdo protegido', subtitle: t?.('advPriv.protectedRecording') || '' },
    });
    const sub = cp.addScreenCaptureListener?.((captured) => {
      if (!captured) return;
      try { soundRef.current?.pause?.(); } catch {}
      setPlaying(false);
    });
    return () => { try { release?.(); } catch {} try { sub?.remove?.(); } catch {} };
  }, [playing]);

  const fireConsumed = useCallback(() => {
    if (consumedRef.current) return;
    consumedRef.current = true;
    try { onConsumed?.(); } catch {}
  }, [onConsumed]);

  const handleTap = useCallback(async () => {
    if (errored) {
      // Retry path: reset and let the user tap again.
      setErrored(false);
      soundRef.current = null;
      return;
    }
    if (!fileUrl) { setErrored(true); return; }

    if (Platform.OS === 'web') {
      try {
        if (!soundRef.current) {
          const audio = new window.Audio(fileUrl);
          audio.preload = 'auto';
          audio.onloadedmetadata = () => {
            if (!isMountedRef.current) return;
            if (audio.duration && isFinite(audio.duration)) setDuration(audio.duration);
          };
          audio.onended = () => {
            if (!isMountedRef.current) return;
            setPlaying(false);
            setCurrentTime(0);
            if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
            // The actual consumption hook — fire AFTER state cleanup so the
            // re-render that flips us into the locked pill happens cleanly.
            fireConsumed();
          };
          audio.onerror = () => {
            if (!isMountedRef.current) return;
            setPlaying(false);
            setErrored(true);
            if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
          };
          soundRef.current = audio;
        }
        if (playing) {
          soundRef.current.pause();
          setPlaying(false);
          if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
          return;
        }
        await soundRef.current.play();
        if (!isMountedRef.current) return;
        setPlaying(true);
        if (intervalRef.current) clearInterval(intervalRef.current);
        intervalRef.current = setInterval(() => {
          const a = soundRef.current;
          if (!a) return;
          if (a.duration > 0) {
            setCurrentTime(a.currentTime);
            if (a.duration && isFinite(a.duration) && !duration) setDuration(a.duration);
          }
        }, 100);
      } catch (e) {
        setErrored(true);
        setPlaying(false);
      }
      return;
    }

    // [2026-10-14 adv-privacy] iPhone gravando/espelhando → não toca.
    if (!playing && Platform.OS === 'ios') {
      try {
        if (_cp()?.isScreenCaptured?.()) {
          require('react-native').Alert.alert(t?.('advPriv.protectedTitle') || 'Conteúdo protegido', t?.('advPriv.audioCaptureBlocked') || 'Pare a gravação de tela para ouvir.');
          return;
        }
      } catch {}
    }

    // Native (iOS/Android) — expo-audio
    const mod = loadExpoAudio();
    if (!mod || !mod.createAudioPlayer) {
      setErrored(true);
      return;
    }
    try {
      if (!soundRef.current) {
        // Force playback through speaker (not earpiece) and pause Spotify/etc.
        // Same audio session config the regular AudioPlayer uses, so the
        // view-once playback behaves identically — silent-switch safe, no
        // mixing with music, releases focus back to other apps on ended.
        // [2026-10-20 call-audio-guard] durante ligação: toca mixado SEM mexer na sessão (CallKit/LiveKit)
        const _G = require('../services/callAudioGuard');
        try {
          if (!_G.callAudioGuardActive()) await mod.setAudioModeAsync?.({
            playsInSilentMode: true,
            allowsRecording: false,
            shouldPlayInBackground: true,
            interruptionMode: 'doNotMix',
            interruptionModeAndroid: 'doNotMix',
            shouldDuckAndroid: false,
          });
        } catch {}
        const player = mod.createAudioPlayer(typeof fileUrl === 'string' ? fileUrl : { uri: String(fileUrl) }, _G.callSafePlayerOptions({ updateInterval: 150, downloadFirst: false }));
        const sub = player.addListener?.('playbackStatusUpdate', (status) => {
          if (!isMountedRef.current) return;
          if (status?.error) {
            setErrored(true); setPlaying(false);
            if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
            return;
          }
          if (status?.duration && isFinite(status.duration) && status.duration > 0) {
            setDuration(status.duration);
            if (status.playing) setCurrentTime(status.currentTime || 0);
          }
          // expo-audio reports `ended` by status.didJustFinish (preferred) or
          // currentTime >= duration after !playing. Either signal counts.
          const didFinish = status?.didJustFinish === true ||
            (!status?.playing && status?.duration > 0 && status?.currentTime >= status?.duration);
          if (didFinish) {
            setPlaying(false);
            setCurrentTime(0);
            // Hand the audio session back to the OS so Spotify/YT can resume.
            try {
              if (!_G.callAudioGuardActive()) mod.setAudioModeAsync?.({
                interruptionMode: 'mixWithOthers',
                interruptionModeAndroid: 'mixWithOthers',
              }).catch(() => {});
            } catch {}
            fireConsumed();
          }
        });
        player._sub = sub;
        soundRef.current = player;
      }
      if (playing) {
        try { soundRef.current.pause(); } catch {}
        setPlaying(false);
        return;
      }
      try {
        soundRef.current.play();
        setPlaying(true);
      } catch {
        setErrored(true);
      }
    } catch (e) {
      setErrored(true);
      setPlaying(false);
    }
  }, [errored, fileUrl, fireConsumed, playing, duration]);

  const accent = colors.primary;
  const subtle = colors.textSecondary;
  const fmt = (s) => {
    const n = Math.max(0, Math.floor(s || 0));
    const m = Math.floor(n / 60);
    const r = n % 60;
    return `${m}:${r < 10 ? '0' : ''}${r}`;
  };

  const sub = errored
    ? (t?.('chatConv.viewOnceLoadFailed') || 'Não foi possível carregar. Toque pra tentar.')
    : playing
      ? `${fmt(currentTime)} / ${fmt(duration)}`
      : (t?.('chatConv.viewOnceVoiceTapToHear') || 'Tocar para ouvir');

  return (
    <TouchableOpacity
      onPress={handleTap}
      activeOpacity={0.7}
      style={s.tapRow}
      accessibilityRole="button"
      accessibilityLabel={t?.('chatConv.viewOnceVoiceTapToHear') || 'Tocar para ouvir'}
    >
      <View style={[s.tapIconCircle, { backgroundColor: 'rgba(17, 17, 17,0.14)' }]}>
        {playing
          ? <IconPause size={18} color={accent} />
          : errored
            ? <IconMic size={18} color={accent} />
            : <IconPlay size={18} color={accent} />}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[s.tapTitle, { color: accent }]} numberOfLines={1}>
          {t?.('chatConv.viewOnceVoiceLabel') || 'Áudio único'}
        </Text>
        <Text style={[s.tapSub, { color: subtle }]} numberOfLines={1}>
          {sub}
        </Text>
      </View>
      <IconLock size={13} color={subtle} />
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  expiredRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, paddingRight: 4, minWidth: 180 },
  expiredIconCircle: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  expiredTitle: { fontSize: 14, fontWeight: '600' },
  expiredSub: { fontSize: 12, marginTop: 1, fontStyle: 'italic' },
  tapRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingRight: 4, minWidth: 200 },
  tapIconCircle: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  glyphBox: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }, // [2026-10-21 view-once WA]
  tapTitle: { fontSize: 14, fontWeight: '600' },
  tapSub: { fontSize: 12, marginTop: 1 },
});

const fs = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingBottom: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    zIndex: 20,
  },
  closeBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  headerCenter: { flex: 1, alignItems: 'center', paddingHorizontal: 8 },
  senderName: { color: '#fff', fontSize: 15, fontWeight: '600', maxWidth: '100%' },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  badgeText: { color: 'rgba(255,255,255,0.85)', fontSize: 12, fontWeight: '500' },
  contentWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },
  fullImage: { width: '100%', height: '100%' },
  spinnerWrap: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  errorBox: { padding: 24, alignItems: 'center', justifyContent: 'center' },
  errorOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.85)', padding: 24, gap: 16 },
  errorText: { color: '#fff', fontSize: 16, textAlign: 'center' },
  errorBtn: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 22, backgroundColor: '#111111' },
  errorBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  bottomHint: {
    position: 'absolute', bottom: 32, left: 16, right: 16,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 10, paddingHorizontal: 14,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 18,
  },
  bottomHintText: { color: 'rgba(255,255,255,0.92)', fontSize: 12, fontWeight: '500' },
});
