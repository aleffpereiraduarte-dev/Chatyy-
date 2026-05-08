// Sticker editor — WhatsApp-style. Crop to 512x512, text overlay with 3 colors,
// rotate/scale via pinch. Output is uploaded via api.chatStickerCreate → PG.
//
// Flow:
//   1. User picks photo (camera or gallery) — already done by caller
//   2. This modal renders: [image preview] [text input] [color buttons]
//      [emoji tag input] [remove-bg toggle] [save/cancel]
//   3. On Save: react-native-view-shot captures the composite → upload to
//      chat.php sticker_create → persists in PG chat_stickers
import React, { useRef, useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, Modal, Platform,
  Dimensions, ActivityIndicator, PanResponder, Animated, ScrollView,
} from 'react-native';
import CachedImage from './CachedImage';
import { IconX, IconCheck } from './Icons';
import * as api from '../services/api';

const { width: SW } = Dimensions.get('window');
const CANVAS = Math.min(SW - 40, 360);

const TEXT_COLORS = ['#ffffff', '#000000', '#FF3B30', '#FFCC00', '#30D158', '#0A84FF', '#BF5AF2'];
const OUTLINE_COLORS = { '#ffffff': '#000000', '#000000': '#ffffff', '#FF3B30': '#000000', '#FFCC00': '#000000', '#30D158': '#000000', '#0A84FF': '#ffffff', '#BF5AF2': '#ffffff' };

// Curated emoji for quick-tag. Tapping one adds it to the tag list.
const QUICK_EMOJIS = ['😀', '😂', '🥰', '😎', '😢', '😡', '🤔', '🔥', '❤️', '👍', '👎', '🎉', '💯', '🙏', '👻', '🥳', '😴', '🤯'];

// Instagram-style sticker library tabs. Each one is a quick-insert overlay
// type that appears as a chip at the top of the editor. Tapping a chip adds
// a draggable widget on top of the canvas (text/emoji/etc).
const STICKER_TABS = [
  { id: 'emoji',    label: 'Emoji',     glyph: '😀' },
  { id: 'text',     label: 'Texto',     glyph: 'Aa' },
  { id: 'gif',      label: 'GIF',       glyph: 'GIF' },
  { id: 'location', label: 'Local',     glyph: '📍' },
  { id: 'time',     label: 'Hora',      glyph: '🕒' },
  { id: 'music',    label: 'Música',    glyph: '🎵' },
  { id: 'mention',  label: 'Mention',   glyph: '@' },
  { id: 'question', label: 'Pergunta',  glyph: '❓' },
  { id: 'poll',     label: 'Poll',      glyph: '📊' },
  { id: 'quiz',     label: 'Quiz',      glyph: '🧠' },
  { id: 'slider',   label: 'Slider',    glyph: '🎚️' },
];

// Trash-zone hit area, centered horizontally near the bottom of the canvas.
const TRASH_ZONE = { y: CANVAS - 64, w: 96, h: 64 };

export default function StickerEditor({ visible, imageUri, onCancel, onSave, t, colors, userEmail }) {
  const [text, setText] = useState('');
  const [color, setColor] = useState(TEXT_COLORS[0]);
  const [saving, setSaving] = useState(false);
  const [emojiTags, setEmojiTags] = useState([]);
  const [primaryEmoji, setPrimaryEmoji] = useState('');
  const [removeBg, setRemoveBg] = useState(false);
  const [activeTab, setActiveTab] = useState('text');
  const [trashHot, setTrashHot] = useState(false);
  const [textDeleted, setTextDeleted] = useState(false);
  const shotRef = useRef(null);

  // Draggable text position. PanResponder also tracks whether the current
  // drag is overlapping the bottom trash zone — when released over it we
  // delete the text overlay (Instagram pattern).
  const pan = useRef({ x: new Animated.Value(0), y: new Animated.Value(0) }).current;
  const lastDrag = useRef({ x: 0, y: 0 });
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        pan.x.extractOffset();
        pan.y.extractOffset();
      },
      onPanResponderMove: (e, gs) => {
        pan.x.setValue(gs.dx);
        pan.y.setValue(gs.dy);
        // Compute current absolute position of text (canvas-local) and check
        // overlap with the trash zone. Text anchor sits ~CANVAS/2 + dy.
        const absY = CANVAS / 2 + pan.y._value + pan.y._offset;
        const absX = CANVAS / 2 + pan.x._value + pan.x._offset;
        const inX = Math.abs(absX - CANVAS / 2) < TRASH_ZONE.w / 2;
        const inY = absY > TRASH_ZONE.y;
        const hot = inX && inY;
        if (hot !== trashHot) setTrashHot(hot);
        lastDrag.current = { x: pan.x._value + pan.x._offset, y: pan.y._value + pan.y._offset };
      },
      onPanResponderRelease: () => {
        pan.x.flattenOffset();
        pan.y.flattenOffset();
        if (trashHot) {
          setText('');
          setTextDeleted(true);
          pan.x.setValue(0); pan.y.setValue(0);
        }
        setTrashHot(false);
      },
    })
  ).current;

  const toggleEmojiTag = useCallback((e) => {
    setEmojiTags(prev => {
      if (prev.includes(e)) return prev.filter(x => x !== e);
      if (prev.length >= 5) return prev; // cap at 5 tags
      return [...prev, e];
    });
    // First selected emoji becomes the primary (used as pack grouping key)
    setPrimaryEmoji(prev => prev || e);
  }, []);

  const handleSave = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      let file;
      if (Platform.OS === 'web') {
        // Web: composite via canvas — load image, draw, stamp text
        const canvas = document.createElement('canvas');
        canvas.width = 512; canvas.height = 512;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'rgba(0,0,0,0)';
        ctx.clearRect(0, 0, 512, 512);
        const img = new window.Image();
        img.crossOrigin = 'anonymous';
        img.src = imageUri;
        await new Promise((r, j) => { img.onload = r; img.onerror = j; });
        // Cover-crop (square)
        const ratio = Math.max(512 / img.width, 512 / img.height);
        const w = img.width * ratio, h = img.height * ratio;
        ctx.drawImage(img, (512 - w) / 2, (512 - h) / 2, w, h);
        if (text.trim()) {
          ctx.font = 'bold 48px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.lineWidth = 6;
          ctx.strokeStyle = OUTLINE_COLORS[color] || '#000';
          ctx.fillStyle = color;
          const tx = 256 + pan.x._value * (512 / CANVAS);
          const ty = 256 + pan.y._value * (512 / CANVAS);
          ctx.strokeText(text, tx, ty);
          ctx.fillText(text, tx, ty);
        }
        const blob = await new Promise(r => canvas.toBlob(r, 'image/png', 1));
        file = { uri: URL.createObjectURL(blob), blob, name: `sticker_${Date.now()}.png`, type: 'image/png' };
      } else {
        // Native: capture the composed canvas (image + positioned text) via
        // react-native-view-shot.
        let captureUri = null;
        try {
          const mod = require('react-native-view-shot');
          const captureRef = mod.captureRef || (typeof mod.default === 'function' ? mod.default : null);
          if (captureRef && shotRef.current) {
            captureUri = await captureRef(shotRef.current, {
              format: 'png', quality: 1, result: 'tmpfile',
            });
          }
        } catch (e) {
          console.warn('[StickerEditor] captureRef failed:', e?.message);
        }
        if (!captureUri) {
          console.warn('[StickerEditor] capture failed — sticker may not include text overlay');
          captureUri = imageUri;
        }
        // Resize to 512x512 (WhatsApp sticker spec)
        try {
          const M = require('expo-image-manipulator');
          const res = await M.manipulateAsync(captureUri, [{ resize: { width: 512, height: 512 } }], { compress: 0.9, format: M.SaveFormat.PNG });
          captureUri = res.uri;
        } catch {}
        file = { uri: captureUri, name: `sticker_${Date.now()}.png`, type: 'image/png' };
      }

      // Optional: run remove-bg. Server currently returns processed:false for
      // most cases, so we skip blocking on it. Future: when REMOVE_BG_API_KEY
      // is set server-side, this path returns a new URL we can use instead.
      if (removeBg) {
        try {
          const bgRes = await api.chatStickerRemoveBg(file);
          if (bgRes?.processed && bgRes?.url) {
            // Not implemented yet — keep going with the original file.
            console.log('[StickerEditor] remove_bg processed:', bgRes.url);
          }
        } catch (e) { /* best effort */ }
      }

      // Upload via the sticker_create endpoint. Falls back to hand-off to the
      // caller (which then does its own upload flow) only if the endpoint is
      // explicitly disabled.
      const tags = emojiTags.join(',');
      const createRes = await api.chatStickerCreate(file, {
        emoji: primaryEmoji,
        emojiTags: tags,
      });
      if (createRes?.success && (createRes.url || createRes.data?.url)) {
        const url = createRes.url || createRes.data?.url;
        const stickerId = createRes.id || createRes.data?.id;
        const packId = createRes.pack_id || createRes.data?.pack_id;
        onSave?.({ ...file, cdn_url: url, url, sticker_id: stickerId, pack_id: packId, emoji: primaryEmoji, emoji_tags: tags });
      } else {
        // Back-compat: hand file off to caller so it can try rustUpload path
        // (previous behavior). If the server endpoint is wired everywhere
        // this branch should never trigger.
        onSave?.(file);
      }
    } catch (e) {
      console.warn('[StickerEditor] save error:', e?.message);
    } finally {
      setSaving(false);
    }
  }, [saving, imageUri, text, color, onSave, emojiTags, primaryEmoji, removeBg]);

  if (!visible) return null;

  const Canvas = View;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', justifyContent: 'center', alignItems: 'center', padding: 16 }}>
        <ScrollView contentContainerStyle={{ alignItems: 'center', paddingVertical: 20 }} showsVerticalScrollIndicator={false}>
          {/* Sticker library tabs — Instagram-style horizontal chip rail.
              Tapping a chip selects the active overlay type. Currently only
              `text` and `emoji` are wired into the canvas; the other chips
              are placeholders so the UI matches IG's affordance set. */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 12, gap: 8, marginBottom: 12 }}
            style={{ width: CANVAS + 24, maxHeight: 44 }}
          >
            {STICKER_TABS.map(tab => {
              const active = activeTab === tab.id;
              return (
                <TouchableOpacity
                  key={tab.id}
                  onPress={() => {
                    setActiveTab(tab.id);
                    if (tab.id === 'emoji' && QUICK_EMOJIS[0]) {
                      // Tap-to-insert: append a curated emoji into the text overlay
                      setText(prev => (prev + ' ' + QUICK_EMOJIS[Math.floor(Math.random() * QUICK_EMOJIS.length)]).trim().slice(0, 40));
                      setTextDeleted(false);
                    }
                  }}
                  style={{
                    height: 36, paddingHorizontal: 14, borderRadius: 18,
                    backgroundColor: active ? '#0A84FF' : 'rgba(255,255,255,0.10)',
                    borderWidth: active ? 0 : 1,
                    borderColor: 'rgba(255,255,255,0.14)',
                    flexDirection: 'row', alignItems: 'center', gap: 6,
                  }}
                >
                  <Text style={{ fontSize: 14 }}>{tab.glyph}</Text>
                  <Text style={{ color: '#fff', fontSize: 13, fontWeight: active ? '700' : '500' }}>
                    {tab.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {/* Canvas */}
          <Canvas ref={shotRef} style={{
            width: CANVAS, height: CANVAS, borderRadius: 12, overflow: 'hidden',
            backgroundColor: '#333',
          }}>
            {Platform.OS === 'web' ? (
              <img src={imageUri} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt="" />
            ) : (
              <CachedImage source={{ uri: imageUri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
            )}
            {!!text.trim() && !textDeleted && (
              <Animated.View
                {...panResponder.panHandlers}
                style={{
                  position: 'absolute', top: '50%', left: 0, right: 0,
                  alignItems: 'center',
                  transform: [{ translateY: -20 }, { translateX: pan.x }, { translateY: pan.y }],
                }}
              >
                <Text style={{
                  fontSize: 32, fontWeight: '800',
                  color,
                  textShadowColor: OUTLINE_COLORS[color] || '#000',
                  textShadowOffset: { width: 0, height: 0 },
                  textShadowRadius: 4,
                  paddingHorizontal: 10, paddingVertical: 2,
                }}>
                  {text}
                </Text>
              </Animated.View>
            )}

            {/* Trash drop zone — appears while a sticker is being dragged.
                Drag a sticker over it and release to delete (Instagram-style). */}
            {!!text.trim() && !textDeleted && (
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: (CANVAS - TRASH_ZONE.w) / 2,
                  top: TRASH_ZONE.y,
                  width: TRASH_ZONE.w, height: TRASH_ZONE.h,
                  borderRadius: TRASH_ZONE.h / 2,
                  alignItems: 'center', justifyContent: 'center',
                  backgroundColor: trashHot ? 'rgba(255,59,48,0.85)' : 'rgba(0,0,0,0.45)',
                  borderWidth: trashHot ? 2 : 1,
                  borderColor: trashHot ? '#FF3B30' : 'rgba(255,255,255,0.25)',
                  transform: [{ scale: trashHot ? 1.1 : 1 }],
                  ...(Platform.OS === 'web' && trashHot
                    ? { boxShadow: '0 0 24px 6px rgba(255,59,48,0.7)' }
                    : {}),
                }}
              >
                <Text style={{ fontSize: 22 }}>🗑️</Text>
              </View>
            )}
          </Canvas>

          {/* Text input */}
          <View style={{ width: CANVAS, marginTop: 16 }}>
            <TextInput
              value={text}
              onChangeText={(v) => { setText(v); if (v) setTextDeleted(false); }}
              placeholder={t?.('chat.stickerText') || 'Adicione texto'}
              placeholderTextColor="rgba(255,255,255,0.5)"
              maxLength={40}
              style={{
                backgroundColor: 'rgba(255,255,255,0.12)', color: '#fff',
                paddingHorizontal: 14, paddingVertical: 11, borderRadius: 10,
                fontSize: 15, outlineStyle: 'none',
              }}
            />
          </View>

          {/* Colors */}
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
            {TEXT_COLORS.map(c => (
              <TouchableOpacity
                key={c}
                onPress={() => setColor(c)}
                style={{
                  width: 28, height: 28, borderRadius: 14,
                  backgroundColor: c,
                  borderWidth: c === color ? 3 : 1,
                  borderColor: c === color ? '#fff' : 'rgba(255,255,255,0.35)',
                }}
              />
            ))}
          </View>

          {/* Emoji tags (for search) */}
          <View style={{ width: CANVAS, marginTop: 18 }}>
            <Text style={{ color: 'rgba(255,255,255,0.75)', fontSize: 12, marginBottom: 6, fontWeight: '600' }}>
              {t?.('chat.stickerTagsLabel') || 'Tags (para buscar esta figurinha)'}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {QUICK_EMOJIS.map(e => (
                <TouchableOpacity
                  key={e}
                  onPress={() => toggleEmojiTag(e)}
                  style={{
                    width: 36, height: 36, borderRadius: 18,
                    backgroundColor: emojiTags.includes(e) ? 'rgba(10,132,255,0.35)' : 'rgba(255,255,255,0.08)',
                    borderWidth: emojiTags.includes(e) ? 2 : 0,
                    borderColor: '#0A84FF',
                    alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <Text style={{ fontSize: 20 }}>{e}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Background removal toggle (TODO — server stub returns processed:false
              until REMOVE_BG_API_KEY is configured. Kept in the UI so the
              feature is discoverable and the client side can be upgraded to
              MediaPipe SelfieSegmentation without another release.) */}
          <TouchableOpacity
            onPress={() => setRemoveBg(!removeBg)}
            style={{
              width: CANVAS, marginTop: 16, paddingVertical: 10, paddingHorizontal: 14,
              borderRadius: 10,
              backgroundColor: removeBg ? 'rgba(48,209,88,0.18)' : 'rgba(255,255,255,0.08)',
              borderWidth: removeBg ? 1.5 : 0,
              borderColor: '#30D158',
              flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
            }}
          >
            <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>
              {removeBg ? '✓ ' : ''}
              {t?.('chat.stickerRemoveBg') || 'Remover fundo automaticamente'}
            </Text>
            <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 10 }}>
              {t?.('chat.stickerRemoveBgBeta') || 'Beta'}
            </Text>
          </TouchableOpacity>

          {/* Actions */}
          <View style={{ flexDirection: 'row', gap: 14, marginTop: 24 }}>
            <TouchableOpacity
              onPress={onCancel}
              disabled={saving}
              style={{
                width: 56, height: 56, borderRadius: 28,
                backgroundColor: 'rgba(255,255,255,0.12)',
                alignItems: 'center', justifyContent: 'center',
              }}
            >
              <IconX size={22} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleSave}
              disabled={saving}
              style={{
                width: 64, height: 64, borderRadius: 32,
                backgroundColor: '#0A84FF',
                alignItems: 'center', justifyContent: 'center',
                ...(Platform.OS === 'web' ? { boxShadow: '0 4px 14px rgba(10,132,255,0.4)' } : {}),
              }}
            >
              {saving ? <ActivityIndicator color="#fff" /> : <IconCheck size={26} color="#fff" />}
            </TouchableOpacity>
          </View>

          <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, marginTop: 12, textAlign: 'center' }}>
            {t?.('chat.stickerHint') || 'Arraste o texto • Escolha cor • Toque em ✓ pra salvar'}
          </Text>
        </ScrollView>
      </View>
    </Modal>
  );
}
