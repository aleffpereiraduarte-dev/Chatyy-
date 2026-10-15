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

import { androidBottomInset } from '../utils/systemInsets'; // [2026-10-07 android-native] edge-to-edge
import React, { useState, useMemo, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, Modal, Image, Platform,
  ActivityIndicator, TextInput, StyleSheet, useWindowDimensions,
  KeyboardAvoidingView,
} from 'react-native';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Stop, Rect } from 'react-native-svg';
import PressableScale from './PressableScale';
import {
  IconArrowLeft, IconChevronRight, IconImage, IconPalette,
  IconSparkles, IconCheck,
} from './Icons';
import * as api from '../services/api';
// [2026-10-15 native-wallpaper] temas animados (4 cores) + padrão vetorial +
// foto c/ desfoque/paralaxe, prévia em tela cheia antes de aplicar, claro/escuro
// separados. Render nativo: modules/expo-chat-wallpaper (fallback JS idêntico ao antigo).
import ChatWallpaper from './wallpaper/ChatWallpaper';
import WallpaperPreview from './wallpaper/WallpaperPreview';
import { THEMES, buildValue, bubbleFor, specFor, composeValue, isV2 } from './wallpaper/wallpaperSpec';
let _WpExpoImage = null; // [2026-10-08 chat-open-flicker] see WallpaperBackground
try { _WpExpoImage = require('expo-image').Image; } catch {}

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

// [2026-10-14 wallpaper-photo] chat_upload silent devolve file_url RELATIVO
// ("/data/chat-files/<cid>/<arq>") e era gravado assim; no iOS/Android a
// <Image>/expo-image não resolve URI relativa → fundo vazio (web funcionava por
// ser mesma origem). Resolve pela mesma regra das bolhas (getMediaUrl) — conserta
// também valores já gravados. Locais (file://, data:) passam intactos.
export function resolveWallpaperUri(v) {
  if (typeof v !== 'string' || !v) return v;
  try { return api.getMediaUrl(v) || v; } catch { return v; }
}
function isImageWallpaper(v) {
  return typeof v === 'string' && !!v && v !== 'none' && !v.startsWith('#') && !isGradientValue(v) && !isV2(v);
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
  // [2026-10-15 native-wallpaper] valor v2 → renderizador novo (nativo/fallback)
  if (isV2(v)) return <ChatWallpaper value={v} isDark={isDark} preview={preview} style={style} />;
  if (v === 'none') {
    // Web keeps the faint dotted Chatyy pattern; native default = plain.
    if (!preview && Platform.OS === 'web') {
      return (
        <View style={[StyleSheet.absoluteFill, { opacity: isDark ? 0.03 : 0.04, backgroundColor: isDark ? '#000000' : '#ECE5DD' }, style]} pointerEvents="none" />
      );
    }
    if (preview) {
      return <View style={[{ flex: 1, backgroundColor: isDark ? '#000000' : '#ECE5DD' }, style]} pointerEvents="none" />;
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
  const uri = resolveWallpaperUri(v);
  // [2026-10-14 wallpaper-photo] opacidade 0.15/0.2 deixava a foto/IA quase
  // invisível (parecia "não aplicou"). Foto escolhida pelo usuário = visível;
  // no escuro escurece o bastante p/ as bolhas seguirem legíveis.
  const imgOp = isDark ? 0.55 : 0.85;
  // [2026-10-08 chat-open-flicker] expo-image (memory-disk, no fade) so a
  // photo wallpaper is decoded once and repaints from memory on every chat
  // open — RN <Image> re-decoded it per mount and the thread showed one or
  // two frames of plain background before the wallpaper popped in.
  if (_WpExpoImage && !preview) {
    return (
      <_WpExpoImage
        source={{ uri }}
        style={[StyleSheet.absoluteFill, { opacity: imgOp }]}
        contentFit="cover"
        cachePolicy="memory-disk"
        transition={0}
        pointerEvents="none"
      />
    );
  }
  return (
    <Image
      source={{ uri }}
      style={[preview ? { flex: 1 } : StyleSheet.absoluteFill, { opacity: preview ? 1 : imgOp }]}
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
        borderColor: selected ? (isDark ? '#fff' : '#111') : (isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)'),
        backgroundColor: isDark ? '#0b0b0b' : '#ECE5DD',
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
          <View style={{ position: 'absolute', top: 6, right: 6, width: 22, height: 22, borderRadius: 11, backgroundColor: isDark ? '#fff' : '#111', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 2, shadowOffset: { width: 0, height: 1 } }}>
            <IconCheck size={14} color={isDark ? '#000' : '#fff'} strokeWidth={3} />
          </View>
        )}
      </View>
    </PressableScale>
  );
}

// [2026-10-15 native-wallpaper] Miniatura VIVA de tema (gradiente animando,
// padrão, bolhas de exemplo na cor derivada).
function ThemeTile({ th, w, selected, onPress, isDark, idx, paused }) {
  const value = buildValue({ t: th.id });
  const tint = bubbleFor(value, isDark);
  return (
    <PressableScale onPress={onPress} scaleTo={0.94} haptic="select" style={{ width: w, height: Math.round(w * 1.45), marginBottom: 12 }}>
      <View style={{
        flex: 1, borderRadius: 16, overflow: 'hidden',
        borderWidth: selected ? 2.5 : StyleSheet.hairlineWidth,
        borderColor: selected ? (isDark ? '#fff' : '#111') : (isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)'),
        backgroundColor: isDark ? '#000' : '#fff',
      }}>
        <ChatWallpaper value={value} isDark={isDark} preview autoplay={paused ? 0 : 2600 + idx * 230} patternScale={0.42} motion={false} />
        <View style={[StyleSheet.absoluteFill, { justifyContent: 'flex-end', padding: 8 }]} pointerEvents="none">
          <View style={{ alignSelf: 'flex-start', width: '62%', height: 12, borderRadius: 6, marginBottom: 5, backgroundColor: isDark ? '#1C1C1E' : '#EEEEF0' }} />
          <View style={{ alignSelf: 'flex-end', width: '50%', height: 12, borderRadius: 6, backgroundColor: tint ? tint.bg : (isDark ? '#333336' : '#111111') }} />
        </View>
        {selected && (
          <View style={{ position: 'absolute', top: 6, right: 6, width: 22, height: 22, borderRadius: 11, backgroundColor: isDark ? '#fff' : '#111', alignItems: 'center', justifyContent: 'center' }}>
            <IconCheck size={14} color={isDark ? '#000' : '#fff'} strokeWidth={3} />
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
  const [photoError, setPhotoError] = useState('');
  const scrollRef = React.useRef(null);
  const { width } = useWindowDimensions();
  // [2026-10-15 native-wallpaper] prévia em tela cheia ({ spec } | null)
  const [preview, setPreview] = useState(null);

  // 4-column grid sizing. Sheet horizontal padding = 20 each side, 12 gaps.
  const GRID_PAD = 20;
  const GRID_GAP = 12;
  const sheetW = Math.min(width, 560);
  const tileW = Math.floor((sheetW - GRID_PAD * 2 - GRID_GAP * 3) / 4);
  const themeW = Math.floor((sheetW - GRID_PAD * 2 - GRID_GAP * 2) / 3);

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
      setPhotoError('');
      setPreview(null);
    }
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = useCallback((value) => {
    setSelected(value);
    try { onApply?.(value, scope); } catch {}
  }, [onApply, scope]);

  // Toda escolha passa pela prévia; "Aplicar" compõe o valor (claro/escuro).
  const openPreview = useCallback((spec) => setPreview({ spec: spec || null }), []);
  const applyPreview = useCallback((spec, target) => {
    const value = composeValue(selected, spec, target);
    setPreview(null);
    apply(value);
    try { onClose?.(); } catch {}
  }, [selected, apply, onClose]);

  const presets = useMemo(
    () => [{ id: 'none' }, ...WALLPAPER_GRADIENTS],
    []
  );

  const photoFailMsg = t?.('chatConv.wallpaperPhotoFailed') || 'Não foi possível usar esta foto. Verifique a conexão e tente de novo.';

  // [2026-10-14 wallpaper-photo] Sobe a foto e grava SEMPRE uma URL absoluta
  // pública (sincroniza entre aparelhos e não some quando o iOS limpa o cache do
  // ImagePicker). Antes: na conversa gravava o caminho RELATIVO do chat_upload
  // (fundo vazio no nativo); em Configurações ("Todas as conversas", sem
  // conversa) gravava o file:// local; na web, um data: URI truncado.
  const uploadPicked = useCallback(async (picked) => {
    let finalUri = '';
    if (conversationId) {
      try {
        const up = await api.chatUploadFile(conversationId, picked, '', false, null, 'image', null, true);
        const url = up?.data?.file_url || up?.data?.url || up?.data?.message?.file_url;
        if (up?.success !== false && url) finalUri = resolveWallpaperUri(url);
      } catch {}
    }
    if (!/^https?:\/\//i.test(finalUri)) {
      // Sem conversa (ou chat_upload falhou): upload genérico → URL do CDN.
      // Contexto 'media' = prefixo protegido do cleanup-r2-orphans.
      try {
        const r = await api.rustUpload(picked, '', 'media');
        const url = r?.cdn_url || r?.data?.cdn_url;
        if (r?.success !== false && url) finalUri = url;
      } catch {}
    }
    if (/^https?:\/\//i.test(finalUri)) { openPreview({ img: finalUri }); return true; }
    setPhotoError(photoFailMsg);
    return false;
  }, [openPreview, conversationId, photoFailMsg]);

  const pickPhoto = useCallback(async () => {
    setPhotoError('');
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
            await uploadPicked({ uri: '', blob: file, _raw: file, name: file.name || 'wallpaper.jpg', type: file.type || 'image/jpeg', size: file.size || 0 });
          } catch { setPhotoError(photoFailMsg); }
          finally { setPhotoBusy(false); }
        };
        input.oncancel = () => setPhotoBusy(false);
        input.click();
        return;
      }
      const ImagePicker = require('expo-image-picker');
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7, allowsEditing: true });
      if (result.canceled || !result.assets?.[0]?.uri) return;
      const a = result.assets[0];
      await uploadPicked({ uri: a.uri, name: a.fileName || 'wallpaper.jpg', type: a.mimeType || 'image/jpeg', size: a.fileSize || 0 });
    } catch {
      setPhotoError(photoFailMsg);
    } finally {
      if (Platform.OS !== 'web') setPhotoBusy(false);
    }
  }, [uploadPicked, photoFailMsg]);

  const generateAi = useCallback(async () => {
    const prompt = aiPrompt.trim();
    if (prompt.length < 3 || aiBusy) return;
    setAiBusy(true);
    setAiError('');
    try {
      // [2026-10-14 wallpaper-ai] retrato (1024x1536) = formato de tela; o
      // servidor leva 15-40 s (gpt-image-1) → timeout próprio no api.js.
      const r = await api.aiGenerateImage(prompt, '1024x1536');
      const url = r?.data?.url || r?.data?.image_url || r?.data?.file_url || r?.data?.image || r?.url;
      if (r?.success && url) {
        openPreview({ img: resolveWallpaperUri(url) });
      } else {
        // Mensagem do servidor (ex.: limite por hora, prompt recusado) quando houver.
        const m = typeof r?.message === 'string' && /limite/i.test(r.message) ? r.message : '';
        setAiError(m || t?.('chatConv.wallpaperAiUnavailable') || 'Não foi possível gerar agora. Tente novamente.');
      }
    } catch {
      setAiError(t?.('chatConv.wallpaperAiUnavailable') || 'Não foi possível gerar agora. Tente novamente.');
    } finally {
      setAiBusy(false);
    }
  }, [aiPrompt, aiBusy, openPreview, t]);

  const C = colors || {};
  const cardBg = isDark ? 'rgba(255,255,255,0.05)' : '#FFFFFF';
  const rowBorder = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';
  const subText = C.textSecondary || (isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.5)');
  // [2026-10-14 wallpaper] P&B: ícones/botões neutros (era azul/roxo/laranja/verde).
  const ink = C.text || (isDark ? '#fff' : '#111');
  const inkInv = isDark ? '#000' : '#fff';
  // seleção no modo atual do app (valores v2 podem ter claro/escuro separados)
  const selSpec = specFor(selected, isDark);
  const imgSelected = selSpec && selSpec.img ? selSpec.img
    : (selSpec && isImageWallpaper(selSpec.v) ? resolveWallpaperUri(selSpec.v) : '');

  const Row = ({ Icon, tint, title, subtitle, onPress, open, trailing }) => (
    <PressableScale onPress={onPress} scaleTo={0.985} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: rowBorder }}>
      <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)', alignItems: 'center', justifyContent: 'center', marginRight: 14 }}>
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
          backgroundColor: active ? ink : 'transparent',
          opacity: disabled ? 0.4 : 1,
        }}
      >
        <Text style={{ fontSize: 13.5, fontWeight: '700', color: active ? inkInv : ink }}>{label}</Text>
      </TouchableOpacity>
    );
  };

  return (
    <Modal visible={!!visible} transparent animationType="slide" onRequestClose={() => (preview ? setPreview(null) : onClose?.())}>
      {/* [2026-10-14 wallpaper-ai] KAV: o teclado cobria o campo e o botão Gerar
          (sheet ancorada embaixo) — no iPhone não dava pra ver/tocar em Gerar. */}
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
        <TouchableOpacity activeOpacity={1} style={{ flex: 1 }} onPress={onClose} />
        <View style={{ backgroundColor: C.background || (isDark ? '#000000' : '#F7F7F7'), borderTopLeftRadius: 22, borderTopRightRadius: 22, maxHeight: '92%', overflow: 'hidden' }}>
          {/* Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 10, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: rowBorder }}>
            <TouchableOpacity onPress={onClose} style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <IconArrowLeft size={22} color={C.text || (isDark ? '#fff' : '#111')} />
            </TouchableOpacity>
            <Text style={{ flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700', color: C.text || (isDark ? '#fff' : '#111'), marginRight: 40 }}>
              {t?.('chatConv.wallpaper') || 'Papel de parede'}
            </Text>
          </View>

          <ScrollView ref={scrollRef} contentContainerStyle={{ padding: GRID_PAD, paddingBottom: 40 }} showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
            {/* Scope segmented control */}
            <View style={{ flexDirection: 'row', backgroundColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)', borderRadius: 11, padding: 3, marginBottom: 18 }}>
              <ScopeBtn value="conversation" label={t?.('chatConv.wallpaperScopeThis') || 'Esta conversa'} disabled={!canConversation} />
              <ScopeBtn value="all" label={t?.('chatConv.wallpaperScopeAll') || 'Todas as conversas'} />
            </View>

            {/* 3-option card */}
            <View style={{ backgroundColor: cardBg, borderRadius: 16, overflow: 'hidden', marginBottom: 22, borderWidth: StyleSheet.hairlineWidth, borderColor: rowBorder }}>
              <Row
                Icon={IconImage}
                tint={ink}
                title={t?.('chatConv.wallpaperFromPhotos') || 'Escolher das Fotos'}
                subtitle={photoBusy ? (t?.('chatConv.wallpaperUploading') || 'Enviando foto...') : (imgSelected ? (t?.('chatConv.wallpaperApplied') || 'Papel de parede aplicado') : undefined)}
                onPress={photoBusy ? undefined : pickPhoto}
                trailing={photoBusy ? <ActivityIndicator size="small" color={ink} /> : (imgSelected ? (
                  <View style={{ width: 34, height: 48, borderRadius: 8, overflow: 'hidden', borderWidth: 2, borderColor: ink }}>
                    <Image source={{ uri: imgSelected }} style={{ flex: 1 }} resizeMode="cover" />
                  </View>
                ) : undefined)}
              />
              {!!photoError && (
                <Text style={{ color: '#EF4444', fontSize: 12.5, paddingHorizontal: 16, paddingVertical: 8 }}>{photoError}</Text>
              )}
              <Row
                Icon={IconPalette}
                tint={ink}
                title={t?.('chatConv.wallpaperSetColor') || 'Definir cor'}
                onPress={() => { setShowColors(v => !v); setShowAi(false); }}
                open={showColors}
              />
              {showColors && (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14, padding: 16, paddingTop: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: rowBorder }}>
                  {WALLPAPER_SOLIDS.map(c => (
                    <TouchableOpacity key={c} onPress={() => openPreview({ v: c })} activeOpacity={0.8}
                      style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: c, alignItems: 'center', justifyContent: 'center', borderWidth: selSpec?.v === c ? 3 : StyleSheet.hairlineWidth, borderColor: selSpec?.v === c ? ink : 'rgba(128,128,128,0.4)' }}>
                      {selSpec?.v === c && <IconCheck size={18} color="#fff" strokeWidth={3} />}
                    </TouchableOpacity>
                  ))}
                </View>
              )}
              <Row
                Icon={IconSparkles}
                tint={ink}
                title={t?.('chatConv.wallpaperCreateAi') || 'Criar com IA'}
                subtitle={t?.('chatConv.wallpaperCreateAiSub') || 'Descreva um fundo e a Bia cria pra você'}
                onPress={() => {
                  setShowAi(v => !v); setShowColors(false);
                  // Leva o campo pra perto do topo (o teclado vai subir).
                  setTimeout(() => { try { scrollRef.current?.scrollTo({ y: 150, animated: true }); } catch {} }, 80);
                }}
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
                    autoFocus
                    maxLength={500}
                    style={{ backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', borderRadius: 11, paddingHorizontal: 14, paddingVertical: 11, fontSize: 14.5, color: C.text || (isDark ? '#fff' : '#111') }}
                    returnKeyType="go"
                    onSubmitEditing={generateAi}
                  />
                  {!!aiError && <Text style={{ color: '#EF4444', fontSize: 12.5, marginTop: 8 }}>{aiError}</Text>}
                  <TouchableOpacity onPress={generateAi} disabled={aiBusy || aiPrompt.trim().length < 3} activeOpacity={0.85}
                    style={{ marginTop: 12, backgroundColor: ink, opacity: (aiBusy || aiPrompt.trim().length < 3) ? 0.45 : 1, borderRadius: 11, paddingVertical: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                    {aiBusy ? <ActivityIndicator size="small" color={inkInv} /> : <IconSparkles size={16} color={inkInv} />}
                    <Text style={{ color: inkInv, fontWeight: '700', fontSize: 14.5 }}>
                      {aiBusy ? (t?.('chatConv.wallpaperAiGenerating') || 'Gerando...') : (t?.('chatConv.wallpaperAiGenerate') || 'Gerar')}
                    </Text>
                  </TouchableOpacity>
                  {aiBusy && (
                    <Text style={{ color: subText, fontSize: 12.5, marginTop: 8, textAlign: 'center' }}>
                      {t?.('chatConv.wallpaperAiSlow') || 'Isso pode levar até 1 minuto'}
                    </Text>
                  )}
                </View>
              )}
            </View>

            {/* [2026-10-15 native-wallpaper] Temas animados (3 col, miniaturas vivas) */}
            <Text style={{ fontSize: 13, fontWeight: '700', color: subText, marginBottom: 14, letterSpacing: 0.3, textTransform: 'uppercase' }}>
              {t?.('chatConv.wallpaperThemes') || 'Temas'}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: GRID_GAP, marginBottom: 12 }}>
              {THEMES.map((th, idx) => (
                <ThemeTile key={th.id} th={th} w={themeW} idx={idx} isDark={isDark} paused={!!preview}
                  selected={selSpec?.t === th.id}
                  onPress={() => openPreview({ t: th.id, ...(selSpec?.t === th.id ? selSpec : {}) })} />
              ))}
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
                    selected={item.id === 'none' ? !selSpec : selSpec?.v === value}
                    onPress={() => openPreview(item.id === 'none' ? null : { v: value })}
                    isDark={isDark}
                    t={t}
                  />
                );
              })}
            </View>
          </ScrollView>

          {/* Done bar */}
          <View style={{ padding: 16, paddingBottom: Platform.OS === 'ios' ? 30 : androidBottomInset(16), borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: rowBorder, backgroundColor: C.background || (isDark ? '#000000' : '#F7F7F7') }}>
            <TouchableOpacity onPress={onClose} activeOpacity={0.85} style={{ backgroundColor: ink, borderRadius: 13, paddingVertical: 14, alignItems: 'center' }}>
              <Text style={{ color: inkInv, fontWeight: '700', fontSize: 16 }}>{t?.('common.done') || 'Concluído'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
      </KeyboardAvoidingView>
      {preview ? (
        <WallpaperPreview spec={preview.spec} appDark={isDark} t={t}
          onCancel={() => setPreview(null)} onApply={applyPreview} />
      ) : null}
    </Modal>
  );
}
