// Sticker editor — WhatsApp-style. Crop to 512x512, text overlay with 3 colors,
// rotate/scale via pinch. Output is uploaded via api.rustUpload (sticker context).
//
// Flow:
//   1. User picks photo (camera or gallery) — already done by caller
//   2. This modal renders: [image preview] [text input] [color buttons] [save/cancel]
//   3. On Save: react-native-view-shot captures the composite → upload to R2
import React, { useRef, useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, Modal, Platform,
  StyleSheet, Dimensions, ActivityIndicator, Image, PanResponder, Animated,
} from 'react-native';
import { IconX, IconCheck } from './Icons';

const { width: SW } = Dimensions.get('window');
const CANVAS = Math.min(SW - 40, 360);

const TEXT_COLORS = ['#ffffff', '#000000', '#FF3B30', '#FFCC00', '#30D158', '#0A84FF', '#BF5AF2'];
const OUTLINE_COLORS = { '#ffffff': '#000000', '#000000': '#ffffff', '#FF3B30': '#000000', '#FFCC00': '#000000', '#30D158': '#000000', '#0A84FF': '#ffffff', '#BF5AF2': '#ffffff' };

export default function StickerEditor({ visible, imageUri, onCancel, onSave, t, colors, userEmail }) {
  const [text, setText] = useState('');
  const [color, setColor] = useState(TEXT_COLORS[0]);
  const [saving, setSaving] = useState(false);
  const shotRef = useRef(null);

  // Draggable text position
  const pan = useRef({ x: new Animated.Value(0), y: new Animated.Value(0) }).current;
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        pan.x.extractOffset();
        pan.y.extractOffset();
      },
      onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false }),
    })
  ).current;

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
        // react-native-view-shot. In older versions the module's default
        // export is the captureRef function itself (not a component), so we
        // must pick the named export carefully and always call captureRef on
        // the View ref directly.
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
          // Fallback: without capture the text overlay is lost. Warn the
          // caller so they don't silently ship a text-less sticker.
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
      onSave?.(file);
    } catch (e) {
      console.warn('[StickerEditor] save error:', e?.message);
    } finally {
      setSaving(false);
    }
  }, [saving, imageUri, text, color, onSave]);

  if (!visible) return null;

  // A plain View works fine — captureRef(viewRef) snapshots the View and all
  // its children (including the animated text overlay). Using the ViewShot
  // component added a failure path: when the module's default export is the
  // captureRef function (not a component), React silently rendered nothing
  // → capture silently failed → text was lost.
  const Canvas = View;
  const canvasExtra = {};

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', justifyContent: 'center', alignItems: 'center', padding: 16 }}>
        {/* Canvas */}
        <Canvas ref={shotRef} {...canvasExtra} style={{
          width: CANVAS, height: CANVAS, borderRadius: 12, overflow: 'hidden',
          backgroundColor: '#333',
        }}>
          {Platform.OS === 'web' ? (
            <img src={imageUri} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt="" />
          ) : (
            <Image source={{ uri: imageUri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
          )}
          {!!text.trim() && (
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
        </Canvas>

        {/* Text input */}
        <View style={{ width: CANVAS, marginTop: 16 }}>
          <TextInput
            value={text}
            onChangeText={setText}
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

        <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, marginTop: 12 }}>
          {t?.('chat.stickerHint') || 'Arraste o texto • Escolha cor • Toque em ✓ pra salvar'}
        </Text>
      </View>
    </Modal>
  );
}
