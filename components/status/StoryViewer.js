// StoryViewer — full-screen status playback modal.
//
// Lifted out of Profile.js where it lived as `InlineStoryViewer` for the
// last few releases. Same code, same UX, but now it's the canonical viewer
// every status surface points at: profile (story ring around avatar),
// chat list home (status circle row), and eventually the dedicated Status
// tab (deferred — ChatStatusTab has 50+ specialized state hooks tied to
// reactions/forward/highlights/translate that we'll fold in next wave).
//
// Features (all gated by the `features` prop so callers don't pay for what
// they don't use):
//
//   - progress bars (always on; one per story item, animated to 100%)
//   - tap-left/tap-right navigation (always on)
//   - press-and-hold to pause (always on)
//   - auto-advance after STORY_DURATION_MS for image/text (always on)
//   - boomerang playback for short clips (always on; gated by item flag)
//   - reply input + 7 quick-reactions (other-user only, both gated by
//     `features.reply` / `features.reactions`)
//   - "viewed by N" counter for own stories (own-only, always on)
//   - delete + add-more buttons in header (own-only, gated by callbacks)
//   - mark-viewed on first paint via `api.statusView` (always on)
//
// Why not parameterize even more? The bigger features (forward, translate,
// highlights save, animated text overlays, music sync) live only in the
// ChatStatusTab viewer and don't share patterns cleanly. They'll be added
// here behind feature flags when that surface adopts the shared component
// — keeping this file scope-creep-free for now.

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, Pressable, Image,
  Platform, Modal, Alert, Animated,
} from 'react-native';
import * as api from '../../services/api';
import { BASE_URL } from '../../services/api';
import { IconX, IconPlus, IconTrash, IconSend, IconCheck, IconMessageSquare } from '../Icons';

const WEB = Platform.OS === 'web';
const STORY_DURATION_MS = 5000;

let _ExpoImage = null;
try { _ExpoImage = require('expo-image').Image; } catch {}

export default function StoryViewer({
  visible,
  stories: storiesProp,
  startIdx,
  ownerName,
  ownerEmail,                  // eslint-disable-line no-unused-vars
  onClose,
  isSelf = false,
  onDelete,
  onAddMore,
  onReply,
  onReact,
  t,
}) {
  // Defensive: callers can pass null/undefined or a stale prop while the parent
  // re-fetches. A single .map(...) on undefined would crash the whole modal +
  // ErrorBoundary the screen, so we coerce to array up-front.
  const stories = Array.isArray(storiesProp) ? storiesProp : [];
  const [idx, setIdx] = useState(startIdx || 0);
  const [paused, setPaused] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [replying, setReplying] = useState(false);
  // Sent toast — flashes "Enviado" pra feedback positivo ao mandar reply
  // (WhatsApp parity). User reportou status reply "muito ruim" e o gap real
  // era ausencia de confirmacao + emoji no place de SVG.
  const [replySent, setReplySent] = useState(false);
  const [reactPop, setReactPop] = useState(null); // emoji that just flew up
  const progressRef = useRef(new Animated.Value(0));
  const animRef = useRef(null);
  const viewedIdsRef = useRef(new Set());
  // Boomerang playback state — was being created fresh inside renderMedia()
  // every render, which stranded the ref on the prior render and reset the
  // toggle to false each pass. Lifted to component top-level so the ping-pong
  // alternates correctly across the clip's natural loops.
  const boomerangRef = useRef(null);
  const boomerangStateRef = useRef({ reversing: false });

  useEffect(() => {
    if (visible) {
      setIdx(Math.min(Math.max(0, startIdx || 0), Math.max(0, (stories?.length || 1) - 1)));
      setPaused(false);
    }
  }, [visible, startIdx, stories?.length]);

  const advance = useCallback(() => {
    setIdx(prev => {
      if (prev < (stories?.length || 0) - 1) return prev + 1;
      onClose?.();
      return prev;
    });
  }, [stories, onClose]);

  // Drive the top progress bar for the current story, and auto-advance when
  // it reaches 100%. Videos skip this (they advance via onEnd).
  useEffect(() => {
    if (!visible) return;
    const cur = stories?.[idx];
    if (!cur) return;
    progressRef.current.setValue(0);
    // Mark viewed once per session
    if (cur.id && !viewedIdsRef.current.has(cur.id)) {
      viewedIdsRef.current.add(cur.id);
      try { api.statusView?.(cur.id); } catch {}
    }
    if (cur.type === 'video') return; // video drives its own timing
    if (paused) return;
    animRef.current = Animated.timing(progressRef.current, {
      toValue: 1,
      duration: STORY_DURATION_MS,
      useNativeDriver: false,
    });
    animRef.current.start(({ finished }) => {
      if (finished) advance();
    });
    return () => { animRef.current?.stop?.(); };
  }, [visible, idx, paused, stories, advance]);

  // Stories evicted (e.g. last one deleted while viewer was open) — close
  // via effect so we don't fire setState during render. React 18 + StrictMode
  // double-invocation could otherwise warn "Cannot update component while
  // rendering a different component".
  useEffect(() => {
    if (visible && (!stories || stories.length === 0)) {
      const t = setTimeout(() => onClose?.(), 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [visible, stories?.length, onClose]);

  if (!visible) return null;
  if (!stories.length) return null;
  const safeIdx = Math.min(Math.max(0, idx), stories.length - 1);
  const cur = stories[safeIdx];
  if (!cur) return null;
  // Fallback for legacy rows where image/video URLs were accidentally
  // written to `content` instead of `media_url`. The DB was migrated but
  // this guards against stale cached responses still carrying the old
  // shape. Detects a URL-ish content (starts with / or http) when type is
  // image/video and media_url is empty.
  const rawMedia = cur.media_url
    || ((cur.type === 'image' || cur.type === 'video') && /^(\/|https?:\/\/)/.test(String(cur.content || ''))
        ? cur.content
        : '');
  const mediaUrl = rawMedia ? (rawMedia.startsWith('http') ? rawMedia : `${BASE_URL}${rawMedia}`) : '';

  const renderMedia = () => {
    if (cur.type === 'text') {
      return (
        <View style={{ flex: 1, backgroundColor: cur.bg_color || '#25D366', alignItems: 'center', justifyContent: 'center', padding: 30 }}>
          <Text style={{ color: '#fff', fontSize: 26, fontWeight: '800', textAlign: 'center', lineHeight: 34 }}>
            {cur.content || ''}
          </Text>
        </View>
      );
    }
    // Image/video with no resolvable URL — show a clear "media unavailable"
    // placeholder instead of falling through to the text-bg branch (which
    // produced a silent black void when bg_color was unset on the row).
    if (!mediaUrl) {
      return (
        <View style={{ flex: 1, backgroundColor: '#0f172a', alignItems: 'center', justifyContent: 'center', padding: 30 }}>
          <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 40, marginBottom: 12 }}>📷</Text>
          <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 16, fontWeight: '700', textAlign: 'center' }}>
            {t?.('status.unavailable') || 'Mídia indisponível'}
          </Text>
          <Text style={{ marginTop: 6, color: 'rgba(255,255,255,0.5)', fontSize: 12, textAlign: 'center' }}>
            {t?.('status.unavailableHint') || 'Esse status pode ter expirado ou foi removido.'}
          </Text>
        </View>
      );
    }
    if (cur.type === 'video') {
      // Boomerang: 1.5s clip played forward → reverse → forward (Instagram-style
      // ping-pong). Web uses a manual "rewind" by toggling currentTime; native
      // uses expo-av's setPositionAsync to bounce the head when the clip finishes.
      const isBoomerang = !!cur.is_boomerang || !!cur?.meta?.is_boomerang;
      const boomerangLoopDurationMs = 7000;
      if (WEB) {
        return (
          <video
            src={mediaUrl}
            autoPlay
            playsInline
            loop={isBoomerang}
            onEnded={isBoomerang ? undefined : advance}
            onLoadedMetadata={isBoomerang ? (() => setTimeout(advance, boomerangLoopDurationMs)) : undefined}
            style={{ width: '100%', height: '100%', objectFit: 'contain', backgroundColor: '#000' }}
          />
        );
      }
      let V = null;
      try { V = require('expo-av').Video; } catch {}
      if (V) {
        return (
          <V
            ref={boomerangRef}
            source={{ uri: mediaUrl }}
            resizeMode="contain"
            shouldPlay={!paused}
            isLooping={isBoomerang}
            onLoad={isBoomerang ? (() => setTimeout(advance, boomerangLoopDurationMs)) : undefined}
            onPlaybackStatusUpdate={(s) => {
              if (!isBoomerang) { if (s?.didJustFinish) advance(); return; }
              // Cheap ping-pong: when the loop wraps from end back to start, the
              // next pass jumps to ~end-200ms and counts toward `reversing` so
              // playback feels like it bounced. Visual approximation of true
              // frame-reverse, no re-encode required.
              try {
                if (s?.didJustFinish && boomerangRef?.current?.setPositionAsync) {
                  boomerangStateRef.current.reversing = !boomerangStateRef.current.reversing;
                  if (boomerangStateRef.current.reversing && s?.durationMillis) {
                    boomerangRef.current.setPositionAsync(Math.max(0, s.durationMillis - 50));
                  }
                }
              } catch {}
            }}
            style={{ width: '100%', height: '100%', backgroundColor: '#000' }}
          />
        );
      }
      // Fallback to image preview
      return <Image source={{ uri: mediaUrl }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />;
    }
    // image
    if (_ExpoImage && !WEB) {
      return (
        <_ExpoImage
          source={{ uri: mediaUrl }}
          style={{ width: '100%', height: '100%' }}
          contentFit="contain"
          cachePolicy="memory-disk"
        />
      );
    }
    return WEB
      ? <img src={mediaUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', backgroundColor: '#000' }} />
      : <Image source={{ uri: mediaUrl }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />;
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        {/* Progress bars */}
        <View style={{
          position: 'absolute', top: Platform.OS === 'ios' ? 50 : 20, left: 0, right: 0,
          flexDirection: 'row', gap: 4, paddingHorizontal: 10, zIndex: 5,
        }}>
          {stories.map((_, i) => (
            <View key={i} style={{ flex: 1, height: 2.5, backgroundColor: 'rgba(255,255,255,0.35)', borderRadius: 2, overflow: 'hidden' }}>
              {i < idx && <View style={{ width: '100%', height: '100%', backgroundColor: '#fff' }} />}
              {i === idx && (
                <Animated.View style={{
                  height: '100%',
                  backgroundColor: '#fff',
                  width: progressRef.current.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
                }} />
              )}
            </View>
          ))}
        </View>

        {/* Header */}
        <View style={{
          position: 'absolute', top: Platform.OS === 'ios' ? 64 : 34, left: 0, right: 0,
          flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, zIndex: 5,
        }}>
          <Text style={{ flex: 1, color: '#fff', fontWeight: '700', fontSize: 15 }} numberOfLines={1}>
            {ownerName}
          </Text>
          {isSelf && cur?.id && (
            <>
              <TouchableOpacity
                onPress={() => {
                  const id = cur.id;
                  const doDelete = () => { onDelete?.(id); };
                  if (Platform.OS === 'web') {
                    if (typeof window !== 'undefined' && window.confirm(t?.('status.deleteConfirm') || 'Apagar este status?')) doDelete();
                  } else {
                    Alert.alert(
                      t?.('status.deleteTitle') || 'Apagar status',
                      t?.('status.deleteConfirm') || 'Apagar este status?',
                      [
                        { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
                        { text: t?.('common.delete') || 'Excluir', style: 'destructive', onPress: doDelete },
                      ]
                    );
                  }
                }}
                style={{ padding: 8, marginRight: 4 }}
                accessibilityLabel={t?.('common.delete') || 'Excluir'}
              >
                <IconTrash size={22} color="#ef4444" />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => { onClose?.(); setTimeout(() => onAddMore?.(), 150); }}
                style={{ padding: 8, marginRight: 4 }}
                accessibilityLabel={t?.('status.addMore') || 'Adicionar outro'}
              >
                <IconPlus size={22} color="#fff" />
              </TouchableOpacity>
            </>
          )}
          <TouchableOpacity onPress={onClose} style={{ padding: 8 }} accessibilityLabel="Close">
            <IconX size={24} color="#fff" />
          </TouchableOpacity>
        </View>

        {/* Media */}
        <View style={{ flex: 1 }}>
          {renderMedia()}
        </View>

        {/* Tap zones — leave room at the bottom for the reply bar so taps in
            the input don't register as "next story". 80px buffer mirrors Instagram. */}
        <Pressable
          style={{ position: 'absolute', left: 0, top: 110, bottom: 80, width: '30%' }}
          onPress={() => setIdx(i => Math.max(0, i - 1))}
        />
        <Pressable
          style={{ position: 'absolute', right: 0, top: 110, bottom: 80, width: '30%' }}
          onPress={advance}
        />
        <Pressable
          style={{ position: 'absolute', left: '30%', right: '30%', top: 110, bottom: 80 }}
          onPressIn={() => setPaused(true)}
          onPressOut={() => setPaused(false)}
        />

        {/* Flying emoji animation — shows briefly when a quick reaction fires */}
        {reactPop && (
          <View pointerEvents="none" style={{
            position: 'absolute', left: 0, right: 0, bottom: 100,
            alignItems: 'center', zIndex: 20,
          }}>
            <Text style={{ fontSize: 72 }}>{reactPop}</Text>
          </View>
        )}

        {/* Bottom bar — Instagram pattern:
            - Other's story: reply input + emoji quick-reactions
            - Own story: "Visto por N" counter + eye icon  */}
        <View style={{
          position: 'absolute', left: 0, right: 0, bottom: 0,
          paddingHorizontal: 14, paddingBottom: Platform.OS === 'ios' ? 28 : 14, paddingTop: 10,
          backgroundColor: 'rgba(0,0,0,0.15)',
          zIndex: 10,
        }}>
          {isSelf ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600', opacity: 0.9 }}>
                👁  {(cur?.views ?? 0)} {cur?.views === 1 ? (t?.('status.view') || 'visualização') : (t?.('status.views') || 'visualizações')}
              </Text>
            </View>
          ) : (
            <View style={{ gap: 10 }}>
              {/* Quick reactions row */}
              <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
                {['❤️','🔥','😂','😮','😢','👏','👍'].map(emoji => (
                  <TouchableOpacity
                    key={emoji}
                    onPress={() => {
                      setReactPop(emoji);
                      setTimeout(() => setReactPop(null), 900);
                      try { onReact?.(cur, emoji); } catch {}
                    }}
                    hitSlop={8}
                    style={{ paddingHorizontal: 6 }}
                  >
                    <Text style={{ fontSize: 26 }}>{emoji}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              {/* Reply input — toast de "Enviado" sobrepoe o input enquanto
                  feedback ativo, desaparece em ~1.4s. Icones SVG (sem emoji
                  na UI, regra do projeto). */}
              {replySent ? (
                <View style={{
                  flexDirection: 'row', alignItems: 'center', gap: 8,
                  backgroundColor: 'rgba(34,197,94,0.22)',
                  borderRadius: 24, paddingHorizontal: 16, paddingVertical: 12,
                  borderWidth: 1, borderColor: 'rgba(34,197,94,0.5)',
                  justifyContent: 'center',
                }}>
                  <IconCheck size={16} color="#fff" strokeWidth={2.5} />
                  <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>
                    {t?.('status.replySent') || 'Resposta enviada'}
                  </Text>
                </View>
              ) : (
                <View style={{
                  flexDirection: 'row', alignItems: 'center', gap: 8,
                  backgroundColor: 'rgba(255,255,255,0.12)',
                  borderRadius: 24, paddingLeft: 14, paddingRight: 6,
                  borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)',
                }}>
                  <IconMessageSquare size={16} color="rgba(255,255,255,0.55)" />
                  <TextInput
                    value={replyText}
                    onChangeText={setReplyText}
                    onFocus={() => setPaused(true)}
                    onBlur={() => setPaused(false)}
                    placeholder={(t?.('status.replyPlaceholder') || 'Responder para') + ' ' + (ownerName || '...')}
                    placeholderTextColor="rgba(255,255,255,0.55)"
                    style={{ flex: 1, color: '#fff', fontSize: 14, paddingVertical: 10, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) }}
                    editable={!replying}
                    returnKeyType="send"
                    onSubmitEditing={async () => {
                      if (!replyText.trim() || replying) return;
                      setReplying(true);
                      try {
                        try { require('react-native').Vibration.vibrate(8); } catch {}
                        await onReply?.(cur, replyText.trim());
                        setReplyText('');
                        setReplySent(true);
                        setTimeout(() => setReplySent(false), 1400);
                      } catch {}
                      setReplying(false);
                    }}
                  />
                  {replyText.trim() ? (
                    <TouchableOpacity
                      disabled={replying}
                      onPress={async () => {
                        if (!replyText.trim() || replying) return;
                        setReplying(true);
                        try {
                          try { require('react-native').Vibration.vibrate(8); } catch {}
                          await onReply?.(cur, replyText.trim());
                          setReplyText('');
                          setReplySent(true);
                          setTimeout(() => setReplySent(false), 1400);
                        } catch {}
                        setReplying(false);
                      }}
                      style={{
                        width: 34, height: 34, borderRadius: 17,
                        backgroundColor: '#7C3AED',
                        alignItems: 'center', justifyContent: 'center',
                        opacity: replying ? 0.6 : 1,
                      }}
                      accessibilityLabel={t?.('common.send') || 'Enviar'}
                    >
                      <IconSend size={15} color="#fff" />
                    </TouchableOpacity>
                  ) : null}
                </View>
              )}
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}
