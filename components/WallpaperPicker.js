// WallpaperPicker — WhatsApp-iOS-style chat wallpaper chooser.
//
// Replaces the old cramped circle-swatch sheet in both entry points:
//   • chat-conversation.js  (showWallpaperPicker modal)   → scope "conversation"
//   • components/ChatProfileTab.js (settings › wallpaper)   → scope "all"
//
// It is a self-contained <Modal> presented as a bottom sheet / full card.
// The caller only wires `visible`, `onClose`, theme (`colors`/`isDark`), `t`,
// the current resolved value (for the check mark) and an `onApply(value, scope)`
// callback — persistence stays 100% in the caller so the existing
// save/read plumbing is untouched.
//
// WALLPAPER VALUE SCHEME (backward-compatible with the existing render):
//   'none'          → Chatyy default (no custom background)
//   '#RRGGBB'       → solid color            (existing)
//   'grad:<id>'     → built-in gradient preset (NEW — rendered via SVG)
//   any other string→ image URI               (existing)
//
// The matching renderer <WallpaperBackground> is exported from here and used
// by chat-conversation.js so '#'/'grad:'/'uri'/'none' all paint correctly and
// identically everywhere.
//
// Zero new native deps: gradients use react-native-svg (already in the app),
// photos reuse expo-image-picker + the chat_upload silent pipeline, and the
// "Criar com IA" row calls the existing api.aiGenerateImage() helper.

import React, { useState, useMemo, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, Modal, Image, Platform,
  ActivityIndicator, TextInput, StyleSheet, useWindowDimensions,
} from 'react-native';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Stop, Rect } from 'react-native-svg';
import PressableScale from './PressableScale';
import {
  IconArrowLeft, IconChevronRight, IconImage, IconPalette,
  IconSparkles, IconCheck,
} from './Icons';
import * as api from '../services/api';

// ── Gradient presets ─────────────────────────────────────────────────────
// id → two/three stop colors + direction. Kept small + hand-picked so the
// 4-col grid reads like the WhatsApp reference (soft, varied, tasteful).
// direction: 'diag' (TL→BR) | 'vert' (top→bottom).
export const WALLPAPER_GRADIENTS = [
  { id: 'teal',    colors: ['#0C8767', '#064E3B'], dir: 'diag' },
  { id: 'emerald', colors: ['#34D399', '#0F766E'], dir: 'diag' },
  { id: 'ocean',   colors: ['#2563EB', '#0E7490'], dir: 'diag' },
  { id: 'sky',     colors: ['#60A5FA', '#A5B4FC'], dir: 'vert' },
  { id: 'indigo',  colors: ['#4F46E5', '#1E1B4B'], dir: 'diag' },
  { id: 'violet',  colors: ['#8B5CF6', '#4C1D95'], dir: 'diag' },
  { id: 'grape',   colors: ['#A855F7', '#6D28D9'], dir: 'vert' },
  { id: 'rose',    colors: ['#FB7185', '#BE123C'], dir: 'diag' },
  { id: 'sunset',  colors: ['#FB923C', '#DB2777'], dir: 'diag' },
  { id: 'peach',   colors: ['#FDBA74', '#F472B6'], dir: 'vert' },
  { id: 'amber',   colors: ['#FBBF24', '#D97706'], dir: 'diag' },
  { id: 'forest',  colors: ['#166534', '#052E16'], dir: 'vert' },
  { id: 'slate',   colors: ['#334155', '#0F172A'], dir: 'diag' },
  { id: 'midnight',colors: ['#1E293B', '#020617'], dir: 'vert' },
  { id: 'sand',    colors: ['#EFEAE2', '#D6CcbE'], dir: 'vert' },
  { id: 'mist',    colors: ['#E2E8F0', '#CBD5E1'], dir: 'diag' },
];

// Solid colors offered under "Definir cor" (mirrors the previous picker +
// WhatsApp staples).
export const WALLPAPER_SOLIDS = [
  '#0C8767', '#008069', '#1B3A2D', '#111B21', '#161618', '#0E0A18',
  '#E4DCD4', '#EFEAE2', '#D5DBDF', '#B3C8D6', '#F1F3F5', '#FFC4C4',
];

export function isGradientValue(v) {
  return typeof v === 'string' && v.startsWith('grad:');
}
export function gradientById(id) {
  return WALLPAPER_GRADIENTS.find(g => g.id === id) || null;
}
function gradientFromValue(v) {
  if (!isGradientValue(v)) return null;
  return gradientById(v.slice(5));
}

// ── Reusable gradient fill (SVG) ───────────────────────────────────────────
function GradientFill({ colors, dir, style, gradKey }) {
  const diag = dir !== 'vert';
  const uid = `wpg_${gradKey}`;
  return (
    <Svg style={style} width="100%" height="100%" preserveAspectRatio="none">
      <Defs>
        <SvgLinearGradient id={uid} x1="0" y1="0" x2={diag ? '1' : '0'} y2="1">
          {colors.map((c, i) => (
            <Stop key={i} offset={i / Math.max(1, colors.length - 1)} stopColor={c} stopOpacity="1" />
          ))}
        </SvgLinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${uid})`} />
    </Svg>
  );
}

// ── Public renderer used by the chat background ─────────────────────────────
// `preview` = true renders at full strength (grid tiles / live preview);
// false applies the subtle chat-background opacity so bubbles stay readable.
export function WallpaperBackground({ value, isDark, preview = false, style }) {
  const v = value || 'none';
  if (v === 'none') {
    // Web keeps the faint dotted Chatyy pattern; native default = plain.
    if (!preview && Platform.OS === 'web') {
      return (
        <View style={[StyleSheet.absoluteFill, { opacity: isDark ? 0.03 : 0.04, backgroundColor: isDark ? '#000000' : '#ECE5DD' }, style]} pointerEvents="none" />
      );
    }
    if (preview) {
      return <View style={[{ flex: 1, backgroundColor: isDark ? '#0B141A' : '#ECE5DD' }, style]} pointerEvents="none" />;
    }
    return null;
  }
  if (isGradientValue(v)) {
    const g = gradientFromValue(v);
    if (!g) return null;
    const op = preview ? 1 : (isDark ? 0.32 : 0.4);
    return (
      <View style={[preview ? { flex: 1 } : StyleSheet.absoluteFill, { opacity: op, overflow: 'hidden' }, style]} pointerEvents="none">
        <GradientFill colors={g.colors} dir={g.dir} gradKey={g.id} style={{ flex: 1 }} />
      </View>
    );
  }
  if (typeof v === 'string' && v.startsWith('#')) {
    return (
      <View style={[preview ? { flex: 1 } : StyleSheet.absoluteFill, { backgroundColor: v, opacity: preview ? 1 : 0.15 }, style]} pointerEvents="none" />
    );
  }
  // Image URI
  return (
    <Image
      source={{ uri: v }}
      style={[preview ? { flex: 1 } : StyleSheet.absoluteFill, { opacity: preview ? 1 : (isDark ? 0.15 : 0.2) }]}
      resizeMode="cover"
      pointerEvents="none"
    />
  );
}

// Small tile used in the 4-col grid.
function PresetTile({ item, size, selected, onPress, isDark, t }) {
  return (
    <PressableScale onPress={onPress} scaleTo={0.94} haptic="select" style={{ width: size, height: size * 1.72, marginBottom: 12 }}>
      <View style={{
        flex: 1, borderRadius: 16, overflow: 'hidden',
        borderWidth: selected ? 2.5 : StyleSheet.hairlineWidth,
        borderColor: selected ? '#25D366' : (isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)'),
        backgroundColor: isDark ? '#111B21' : '#ECE5DD',
      }}>
        {item.id === 'none'
          ? <WallpaperBackground value="none" isDark={isDark} preview />
          : <WallpaperBackground value={`grad:${item.id}`} isDark={isDark} preview />}
        {item.id === 'none' && (
          <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 10, fontWeight: '700', color: isDark ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.45)', letterSpacing: 0.3 }}>
              {t?.('chatConv.wallpaperDefaultTile') || 'Chatyy'}
            </Text>
          </View>
        )}
        {selected && (
          <View style={{ position: 'absolute', top: 6, right: 6, width: 22, height: 22, borderRadius: 11, backgroundColor: '#25D366', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 2, shadowOffset: { width: 0, height: 1 } }}>
            <IconCheck size={14} color="#fff" strokeWidth={3} />
          </View>
        )}
      </View>
    </PressableScale>
  );
}

// ── Main picker ─────────────────────────────────────────────────────────────
export default function WallpaperPicker({
  visible,
  onClose,
  colors,
  isDark,
  t,
  conversationId = null,
  currentValue = 'none',
  defaultScope = 'conversation', // 'conversation' | 'all'
  onApply, // (value, scope) => void
}) {
  const canConversation = !!conversationId;
  const [scope, setScope] = useState(canConversation ? defaultScope : 'all');
  const [selected, setSelected] = useState(currentValue || 'none');
  const [showColors, setShowColors] = useState(false);
  const [showAi, setShowAi] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState('');
  const [photoBusy, setPhotoBusy] = useState(false);
  const { width } = useWindowDimensions();

  // 4-column grid sizing. Sheet horizontal padding = 20 each side, 12 gaps.
  const GRID_PAD = 20;
  const GRID_GAP = 12;
  const sheetW = Math.min(width, 560);
  const tileW = Math.floor((sheetW - GRID_PAD * 2 - GRID_GAP * 3) / 4);

  // Reset local state each time it opens so the check mark + scope match the
  // caller's current value/entry point.
  React.useEffect(() => {
    if (visible) {
      setSelected(currentValue || 'none');
      setScope(canConversation ? defaultScope : 'all');
      setShowColors(false);
      setShowAi(false);
      setAiPrompt('');
      setAiError('');
    }
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = useCallback((value) => {
    setSelected(value);
    try { onApply?.(value, scope); } catch {}
  }, [onApply, scope]);

  const presets = useMemo(
    () => [{ id: 'none' }, ...WALLPAPER_GRADIENTS],
    []
  );

  const pickPhoto = useCallback(async () => {
    setPhotoBusy(true);
    try {
      if (Platform.OS === 'web') {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = async (e) => {
          const file = e.target.files?.[0];
          if (!file) { setPhotoBusy(false); return; }
          try {
            const reader = new FileReader();
            reader.onload = () => { apply(String(reader.result).substring(0, 500000)); setPhotoBusy(false); };
            reader.onerror = () => setPhotoBusy(false);
            reader.readAsDataURL(file);
          } catch { setPhotoBusy(false); }
        };
        input.oncancel = () => setPhotoBusy(false);
        input.click();
        return;
      }
      const ImagePicker = require('expo-image-picker');
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7, allowsEditing: true });
      if (result.canceled || !result.assets?.[0]?.uri) { setPhotoBusy(false); return; }
      const a = result.assets[0];
      let finalUri = a.uri;
      // Upload so the wallpaper syncs across devices. Reuses the same silent
      // chat_upload pipeline as group-photo changes. Needs a conversation to
      // attach to; without one (global scope) we fall back to the local uri.
      if (conversationId) {
        try {
          const picked = { uri: a.uri, name: a.fileName || 'wallpaper.jpg', type: a.mimeType || 'image/jpeg' };
          const up = await api.chatUploadFile(conversationId, picked, '', false, null, 'image', null, true);
          const url = up?.data?.file_url || up?.data?.url || up?.data?.message?.file_url;
          if (url) finalUri = url;
        } catch {}
      }
      apply(finalUri);
    } catch {} finally {
      if (Platform.OS !== 'web') setPhotoBusy(false);
    }
  }, [apply, conversationId]);

  const generateAi = useCallback(async () => {
    const prompt = aiPrompt.trim();
    if (!prompt || aiBusy) return;
    setAiBusy(true);
    setAiError('');
    try {
      const r = await api.aiGenerateImage(prompt, '1024x1024');
      const url = r?.data?.url || r?.data?.image_url || r?.data?.file_url || r?.data?.image || r?.url;
      if (r?.success && url) {
        apply(url);
      } else {
        setAiError(t?.('chatConv.wallpaperAiUnavailable') || 'Não foi possível gerar agora. Tente novamente.');
      }
    } catch {
      setAiError(t?.('chatConv.wallpaperAiUnavailable') || 'Não foi possível gerar agora. Tente novamente.');
    } finally {
      setAiBusy(false);
    }
  }, [aiPrompt, aiBusy, apply, t]);

  const C = colors || {};
  const cardBg = isDark ? 'rgba(255,255,255,0.05)' : '#FFFFFF';
  const rowBorder = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';
  const subText = C.textSecondary || (isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.5)');

  const Row = ({ Icon, tint, title, subtitle, onPress, open, trailing }) => (
    <PressableScale onPress={onPress} scaleTo={0.985} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: rowBorder }}>
      <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: tint + '22', alignItems: 'center', justifyContent: 'center', marginRight: 14 }}>
        <Icon size={20} color={tint} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 15.5, fontWeight: '600', color: C.text || (isDark ? '#fff' : '#111') }}>{title}</Text>
        {!!subtitle && <Text style={{ fontSize: 12.5, color: subText, marginTop: 2 }}>{subtitle}</Text>}
      </View>
      {trailing || <IconChevronRight size={18} color={isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.25)'} style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }} />}
    </PressableScale>
  );

  const ScopeBtn = ({ value, label, disabled }) => {
    const active = scope === value;
    return (
      <TouchableOpacity
        disabled={disabled}
        onPress={() => setScope(value)}
        activeOpacity={0.8}
        style={{
          flex: 1, paddingVertical: 9, borderRadius: 9, alignItems: 'center', justifyContent: 'center',
          backgroundColor: active ? (isDark ? '#25D366' : '#111') : 'transparent',
          opacity: disabled ? 0.4 : 1,
        }}
      >
        <Text style={{ fontSize: 13.5, fontWeight: '700', color: active ? '#fff' : (C.text || (isDark ? '#fff' : '#111')) }}>{label}</Text>
      </TouchableOpacity>
    );
  };

  return (
    <Modal visible={!!visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
        <TouchableOpacity activeOpacity={1} style={{ flex: 1 }} onPress={onClose} />
        <View style={{ backgroundColor: C.background || (isDark ? '#0B141A' : '#F7F7F7'), borderTopLeftRadius: 22, borderTopRightRadius: 22, maxHeight: '92%', overflow: 'hidden' }}>
          {/* Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 10, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: rowBorder }}>
            <TouchableOpacity onPress={onClose} style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <IconArrowLeft size={22} color={C.text || (isDark ? '#fff' : '#111')} />
            </TouchableOpacity>
            <Text style={{ flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700', color: C.text || (isDark ? '#fff' : '#111'), marginRight: 40 }}>
              {t?.('chatConv.wallpaper') || 'Papel de parede'}
            </Text>
          </View>

          <ScrollView contentContainerStyle={{ padding: GRID_PAD, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
            {/* Scope segmented control */}
            <View style={{ flexDirection: 'row', backgroundColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)', borderRadius: 11, padding: 3, marginBottom: 18 }}>
              <ScopeBtn value="conversation" label={t?.('chatConv.wallpaperScopeThis') || 'Esta conversa'} disabled={!canConversation} />
              <ScopeBtn value="all" label={t?.('chatConv.wallpaperScopeAll') || 'Todas as conversas'} />
            </View>

            {/* 3-option card */}
            <View style={{ backgroundColor: cardBg, borderRadius: 16, overflow: 'hidden', marginBottom: 22, borderWidth: StyleSheet.hairlineWidth, borderColor: rowBorder }}>
              <Row
                Icon={IconImage}
                tint="#3B82F6"
                title={t?.('chatConv.wallpaperFromPhotos') || 'Escolher das Fotos'}
                onPress={pickPhoto}
                trailing={photoBusy ? <ActivityIndicator size="small" color="#3B82F6" /> : undefined}
              />
              <Row
                Icon={IconPalette}
                tint="#8B5CF6"
                title={t?.('chatConv.wallpaperSetColor') || 'Definir cor'}
                onPress={() => { setShowColors(v => !v); setShowAi(false); }}
                open={showColors}
              />
              {showColors && (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14, padding: 16, paddingTop: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: rowBorder }}>
                  {WALLPAPER_SOLIDS.map(c => (
                    <TouchableOpacity key={c} onPress={() => apply(c)} activeOpacity={0.8}
                      style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: c, alignItems: 'center', justifyContent: 'center', borderWidth: selected === c ? 3 : StyleSheet.hairlineWidth, borderColor: selected === c ? '#25D366' : 'rgba(128,128,128,0.4)' }}>
                      {selected === c && <IconCheck size={18} color="#fff" strokeWidth={3} />}
                    </TouchableOpacity>
                  ))}
                </View>
              )}
              <Row
                Icon={IconSparkles}
                tint="#F59E0B"
                title={t?.('chatConv.wallpaperCreateAi') || 'Criar com IA'}
                subtitle={t?.('chatConv.wallpaperCreateAiSub') || 'Descreva um fundo e a Bia cria pra você'}
                onPress={() => { setShowAi(v => !v); setShowColors(false); }}
                open={showAi}
              />
              {showAi && (
                <View style={{ padding: 16, paddingTop: 14 }}>
                  <TextInput
                    value={aiPrompt}
                    onChangeText={setAiPrompt}
                    placeholder={t?.('chatConv.wallpaperAiPlaceholder') || 'Ex: montanhas ao pôr do sol, minimalista'}
                    placeholderTextColor={subText}
                    editable={!aiBusy}
                    style={{ backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', borderRadius: 11, paddingHorizontal: 14, paddingVertical: 11, fontSize: 14.5, color: C.text || (isDark ? '#fff' : '#111') }}
                    returnKeyType="go"
                    onSubmitEditing={generateAi}
                  />
                  {!!aiError && <Text style={{ color: '#EF4444', fontSize: 12.5, marginTop: 8 }}>{aiError}</Text>}
                  <TouchableOpacity onPress={generateAi} disabled={aiBusy || !aiPrompt.trim()} activeOpacity={0.85}
                    style={{ marginTop: 12, backgroundColor: '#F59E0B', opacity: (aiBusy || !aiPrompt.trim()) ? 0.5 : 1, borderRadius: 11, paddingVertical: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                    {aiBusy ? <ActivityIndicator size="small" color="#fff" /> : <IconSparkles size={16} color="#fff" />}
                    <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14.5 }}>
                      {aiBusy ? (t?.('chatConv.wallpaperAiGenerating') || 'Gerando...') : (t?.('chatConv.wallpaperAiGenerate') || 'Gerar')}
                    </Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>

            {/* Preset grid (4-col) */}
            <Text style={{ fontSize: 13, fontWeight: '700', color: subText, marginBottom: 14, letterSpacing: 0.3, textTransform: 'uppercase' }}>
              {t?.('chatConv.wallpaperPresets') || 'Predefinidos'}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
              {presets.map(item => {
                const value = item.id === 'none' ? 'none' : `grad:${item.id}`;
                return (
                  <PresetTile
                    key={item.id}
                    item={item}
                    size={tileW}
                    selected={selected === value}
                    onPress={() => apply(value)}
                    isDark={isDark}
                    t={t}
                  />
                );
              })}
            </View>
          </ScrollView>

          {/* Done bar */}
          <View style={{ padding: 16, paddingBottom: Platform.OS === 'ios' ? 30 : 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: rowBorder, backgroundColor: C.background || (isDark ? '#0B141A' : '#F7F7F7') }}>
            <TouchableOpacity onPress={onClose} activeOpacity={0.85} style={{ backgroundColor: '#25D366', borderRadius: 13, paddingVertical: 14, alignItems: 'center' }}>
              <Text style={{ color: '#fff', fontWeight: '700', fontSize: 16 }}>{t?.('common.done') || 'Concluído'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}
