// components/profile/ProfileMediaStudio.js — [2026-10-21 foto-capa-studio]
//
// Founder (print aba Perfil/Ajustes): "Adicionar foto de perfil" na lista era
// redundante e trocar a CAPA era feio/escondido. Agora uma tela só para trocar
// foto de perfil ou capa, aberta pelo selo de câmera do avatar, por toque na
// capa (dono) e pelos botões do "Editar":
//   • menu: prévia GRANDE (avatar 200 em círculo / capa 3:1 com o avatar por
//     cima, como fica no perfil) + Escolher da galeria · Tirar foto · Remover;
//   • ajuste: recorte próprio (círculo p/ avatar, 3:1 p/ capa) com arrastar
//     para posicionar e pinça para ampliar + prévia AO VIVO do perfil;
//   • envio: véu + progresso sobre a prévia → "Foto atualizada" e fecha.
// Endpoints existentes: upload_avatar (api.uploadAvatar), upload_cover
// (api.uploadCover c/ progresso), update_profile {cover_url:''} (remover capa),
// profile_photo_remove (remover a foto principal; a próxima da galeria assume).
// Um Modal só (os estágios trocam DENTRO dele — nunca Modal sobre Modal no iOS).
// Sem capa = degradê grafite padrão (CoverFallback), também usado no "Você".
// Kill switch: globalThis.__chatyy_photo_studio = false → fluxos antigos.
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  Modal, View, Text, StyleSheet, Platform, Pressable, ActivityIndicator, Animated,
  PanResponder, Alert, Linking, Image as RNImage, useWindowDimensions, StatusBar,
} from 'react-native';
import { useSafeAreaInsets, initialWindowMetrics } from 'react-native-safe-area-context';
import { useLanguageOptional } from '../../context/LanguageContext';
import Svg, { Path, Rect, Defs, LinearGradient as SvgLinearGradient, RadialGradient, Stop } from 'react-native-svg';
import AvatarCircle from '../AvatarCircle';
import { useGroupedColors } from '../settings/SettingsKit';
import { IconX, IconImage, IconCamera, IconTrash, IconCheck } from '../Icons';
import { normalizeCoverUrl } from '../../services/profileCover';

export function isPhotoStudioEnabled() {
  try { if (globalThis.__chatyy_photo_studio === false) return false; } catch {}
  return true;
}

/** Sem capa: degradê grafite padrão (no lugar de fundo vazio / imagem borrada). */
export function coverDefaultOn() {
  try { if (globalThis.__chatyy_cover_default === false) return false; } catch {}
  return true;
}

export function CoverFallback({ isDark, style }) {
  const id = 'cvf' + String(useId()).replace(/[^a-zA-Z0-9]/g, '');
  const a = isDark ? '#34343B' : '#DCDCD6';
  const b = isDark ? '#1B1B1F' : '#B9B9B3';
  const glow = isDark ? '#5A5A64' : '#F7F7F3';
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      <Svg width="100%" height="100%" preserveAspectRatio="none">
        <Defs>
          <SvgLinearGradient id={`${id}l`} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={a} stopOpacity={1} />
            <Stop offset="1" stopColor={b} stopOpacity={1} />
          </SvgLinearGradient>
          <RadialGradient id={`${id}r`} cx="0.22" cy="0.18" rx="0.7" ry="0.9" fx="0.22" fy="0.18">
            <Stop offset="0" stopColor={glow} stopOpacity={isDark ? 0.35 : 0.75} />
            <Stop offset="1" stopColor={glow} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id}l)`} />
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id}r)`} />
      </Svg>
    </View>
  );
}

const MAX_SRC = 2400;      // lado maior da cópia de trabalho (desempenho do recorte)
const OUT_AVATAR = 1080;   // avatar final (quadrado)
const OUT_COVER = 1500;    // capa final (3:1 — o servidor também usa 1500×500)
const ZMAX = 5;

function _im() { try { return require('expo-image-manipulator'); } catch { return null; } }

async function _normalize(asset) {
  const IM = _im();
  let w = Number(asset.width) || 0;
  let h = Number(asset.height) || 0;
  if (IM && IM.manipulateAsync) {
    try {
      const big = Math.max(w, h);
      const act = !big || big > MAX_SRC ? [{ resize: w >= h ? { width: MAX_SRC } : { height: MAX_SRC } }] : [];
      const r = await IM.manipulateAsync(asset.uri, act, { compress: 0.92, format: IM.SaveFormat.JPEG });
      if (r && r.uri && r.width && r.height) return { uri: r.uri, w: r.width, h: r.height };
    } catch {}
  }
  if (!w || !h) {
    try {
      const d = await new Promise((res, rej) => RNImage.getSize(asset.uri, (a, b) => res({ a, b }), rej));
      w = d.a; h = d.b;
    } catch {}
  }
  if (!w || !h) return null;
  return { uri: asset.uri, w, h };
}

async function _cropOut(src, rect, outW) {
  const IM = _im();
  if (!IM || !IM.manipulateAsync) return { uri: src.uri, name: 'image.jpg', type: 'image/jpeg' };
  const acts = [{ crop: rect }];
  if (rect.width > outW) acts.push({ resize: { width: outW } });
  const r = await IM.manipulateAsync(src.uri, acts, { compress: 0.88, format: IM.SaveFormat.JPEG });
  return { uri: r.uri, name: 'image.jpg', type: 'image/jpeg', width: r.width, height: r.height };
}

function _haptic(kind) {
  try { require('../../services/haptics').hapticEvent?.(kind); } catch {}
}

// Estado do gesto fora do React (o compilador não vê refs/mutações no render).
function createCropGesture(tx, ty, sc) {
  const G = { tx: 0, ty: 0, z: 1, n: 0, cx: 0, cy: 0, d: 0, bw: 0, bh: 0, fw: 0, fh: 0, s0: 1, sw: 0, sh: 0 };
  const clamp = () => {
    G.z = Math.max(1, Math.min(ZMAX, G.z));
    const mx = Math.max(0, (G.bw * G.z - G.fw) / 2);
    const my = Math.max(0, (G.bh * G.z - G.fh) / 2);
    G.tx = Math.max(-mx, Math.min(mx, G.tx));
    G.ty = Math.max(-my, Math.min(my, G.ty));
  };
  const read = (e) => {
    const ts = (e && e.nativeEvent && e.nativeEvent.touches) || [];
    if (ts.length >= 2) {
      const a = ts[0]; const b = ts[1];
      return { n: 2, cx: (a.pageX + b.pageX) / 2, cy: (a.pageY + b.pageY) / 2, d: Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) };
    }
    if (ts.length === 1) return { n: 1, cx: ts[0].pageX, cy: ts[0].pageY, d: 0 };
    return { n: 0, cx: e?.nativeEvent?.pageX || 0, cy: e?.nativeEvent?.pageY || 0, d: 0 };
  };
  const base = (p) => { G.n = p.n; G.cx = p.cx; G.cy = p.cy; G.d = p.d; };
  const responder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => { base(read(e)); },
    onPanResponderMove: (e) => {
      const p = read(e);
      if (p.n !== G.n) { base(p); return; }
      G.tx += p.cx - G.cx;
      G.ty += p.cy - G.cy;
      if (p.n >= 2 && G.d > 0 && p.d > 0) G.z *= p.d / G.d;
      base(p);
      clamp();
      tx.setValue(G.tx); ty.setValue(G.ty); sc.setValue(G.z);
    },
    onPanResponderRelease: () => { G.n = 0; },
    onPanResponderTerminate: () => { G.n = 0; },
  });
  return {
    handlers: responder.panHandlers,
    reset(geo) {
      Object.assign(G, geo, { tx: 0, ty: 0, z: 1, n: 0 });
      tx.setValue(0); ty.setValue(0); sc.setValue(1);
    },
    // Retângulo de recorte em px da imagem.
    rect() {
      const k = G.s0 * G.z;
      const x0 = G.fw / 2 + G.tx - (G.bw * G.z) / 2;
      const y0 = G.fh / 2 + G.ty - (G.bh * G.z) / 2;
      const width = Math.max(1, Math.min(G.sw, Math.round(G.fw / k)));
      const height = Math.max(1, Math.min(G.sh, Math.round(G.fh / k)));
      const originX = Math.max(0, Math.min(G.sw - width, Math.round(-x0 / k)));
      const originY = Math.max(0, Math.min(G.sh - height, Math.round(-y0 / k)));
      return { originX, originY, width, height };
    },
  };
}

// ── Recorte: arrastar + pinça (PanResponder, sem Reanimated/GH → funciona em Modal no Android) ──
function Cropper({ src, aspect, round, frameW, onReady, previewW, previewNode }) {
  const fw = frameW;
  const fh = Math.round(frameW / aspect);
  const s0 = Math.max(fw / src.w, fh / src.h);
  const bw = src.w * s0;
  const bh = src.h * s0;
  const [tx] = useState(() => new Animated.Value(0));
  const [ty] = useState(() => new Animated.Value(0));
  const [sc] = useState(() => new Animated.Value(1));
  const [gest] = useState(() => createCropGesture(tx, ty, sc));

  useEffect(() => {
    gest.reset({ bw, bh, fw, fh, s0, sw: src.w, sh: src.h });
  }, [gest, src.uri, src.w, src.h, bw, bh, fw, fh, s0]);

  useEffect(() => {
    onReady?.(() => gest.rect());
  }, [onReady, gest]);

  // Máscara: tudo escurecido menos a janela (círculo ou retângulo 3:1).
  const pad = 400;
  const W = fw + pad * 2;
  const H = fh + pad * 2;
  const hole = round
    ? `M${pad} ${pad + fh / 2}a${fw / 2} ${fh / 2} 0 1 0 ${fw} 0a${fw / 2} ${fh / 2} 0 1 0 ${-fw} 0Z`
    : `M${pad} ${pad}h${fw}v${fh}h${-fw}Z`;
  const k = previewW > 0 ? previewW / fw : 0;

  return (
    <View style={{ alignItems: 'center' }}>
      <View style={{ width: fw, height: fh }} {...gest.handlers} testID="photo-studio-crop">
        <Animated.Image
          source={{ uri: src.uri }}
          style={{
            position: 'absolute', width: bw, height: bh, left: (fw - bw) / 2, top: (fh - bh) / 2,
            transform: [{ translateX: tx }, { translateY: ty }, { scale: sc }],
          }}
          resizeMode="cover"
        />
        <View pointerEvents="none" style={{ position: 'absolute', left: -pad, top: -pad, width: W, height: H }}>
          <Svg width={W} height={H}>
            <Path d={`M0 0H${W}V${H}H0Z ${hole}`} fill="rgba(0,0,0,0.62)" fillRule="evenodd" />
            {round
              ? <Path d={hole} fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth={1.5} />
              : (
                <>
                  <Path d={hole} fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth={1.5} />
                  <Path d={`M${pad + fw / 3} ${pad}v${fh}M${pad + (2 * fw) / 3} ${pad}v${fh}M${pad} ${pad + fh / 3}h${fw}M${pad} ${pad + (2 * fh) / 3}h${fw}`} stroke="rgba(255,255,255,0.28)" strokeWidth={1} />
                </>
              )}
          </Svg>
        </View>
      </View>
      {k > 0 && typeof previewNode === 'function' ? previewNode(
        <View style={{ width: fw * k, height: fh * k, overflow: 'hidden' }}>
          <Animated.Image
            source={{ uri: src.uri }}
            style={{
              position: 'absolute', width: bw * k, height: bh * k, left: (fw - bw) * k / 2, top: (fh - bh) * k / 2,
              transform: [{ translateX: Animated.multiply(tx, k) }, { translateY: Animated.multiply(ty, k) }, { scale: sc }],
            }}
            resizeMode="cover"
          />
        </View>,
      ) : null}
    </View>
  );
}

function ActionRow({ icon: Icon, label, onPress, destructive, disabled, g, last, testID }) {
  const color = destructive ? g.destructive : g.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      style={({ pressed }) => [st.row, { opacity: disabled ? 0.45 : 1, backgroundColor: pressed ? g.highlightBg : 'transparent' }]}
    >
      <View style={[st.rowIcon, { backgroundColor: destructive ? 'transparent' : g.fill }]}>
        <Icon size={19} color={color} />
      </View>
      <Text style={[st.rowText, { color }]} numberOfLines={1}>{label}</Text>
      {!last ? <View style={[st.rowSep, { backgroundColor: g.separator }]} /> : null}
    </Pressable>
  );
}

/**
 * props: visible, kind ('avatar' | 'cover'), onClose, t, email, name,
 *        avatarUri (atual, opcional), coverUrl (atual, já resolvida; '' = sem),
 *        onAvatarChanged(resp), onCoverChanged(url) ('' = removida)
 */
export default function ProfileMediaStudio({
  visible, kind = 'avatar', onClose, t, email, name, avatarUri, coverUrl,
  onAvatarChanged, onCoverChanged,
}) {
  const g = useGroupedColors();
  // [2026-10-23 capa-safe-area] Dentro do Modal (fullScreen + statusBarTranslucent)
  // o contexto às vezes devolve top=0 → Cancelar/Salvar ficavam por cima do
  // relógio/bateria. Piso = métricas da janela (iOS) / altura da status bar (Android).
  const _ctxInsets = useSafeAreaInsets();
  const _wm = (initialWindowMetrics && initialWindowMetrics.insets) || {};
  const insets = {
    top: Math.max(_ctxInsets.top || 0, _wm.top || 0, Platform.OS === 'android' ? (StatusBar.currentHeight || 0) : 0),
    bottom: Math.max(_ctxInsets.bottom || 0, _wm.bottom || 0),
  };
  const { width: winW } = useWindowDimensions();
  // [2026-10-23 capa-i18n] t do idioma do app (LanguageContext); prop t só de reserva.
  const _ctxT = useLanguageOptional()?.t || null;
  const tr = (k, fb) => {
    try { const v = (_ctxT || t)?.(k); if (v && v !== k) return v; } catch {}
    try { const v = t?.(k); if (v && v !== k) return v; } catch {}
    return fb;
  };
  const isCover = kind === 'cover';
  const [stage, setStage] = useState('menu'); // menu | crop
  const [src, setSrc] = useState(null);       // { uri, w, h }
  const [busy, setBusy] = useState('');       // '' | 'upload' | 'remove' | 'prep'
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState('');
  const [err, setErr] = useState('');
  const [localPreview, setLocalPreview] = useState('');
  const [avatarKey, setAvatarKey] = useState(0);
  const cropFnRef = useRef(null);
  const closeTimer = useRef(null);

  useEffect(() => {
    if (!visible) return;
    setStage('menu'); setSrc(null); setBusy(''); setProgress(0); setDone(''); setErr(''); setLocalPreview('');
  }, [visible, kind]);
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  const curCover = localPreview && isCover ? localPreview : (coverUrl ? normalizeCoverUrl(coverUrl) : '');
  const hasCover = !!(coverUrl && !(isCover && done === 'removed'));
  const colW = Math.min(winW, 520);
  const frameW = isCover ? colW - 32 : Math.min(colW - 64, 320);

  const finish = useCallback((msg) => {
    setDone(msg);
    _haptic('success');
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => { closeTimer.current = null; onClose?.(); }, 950);
  }, [onClose]);

  const pick = useCallback(async (fromCamera) => {
    if (busy) return;
    setErr('');
    if (Platform.OS === 'web' && fromCamera) return;
    let ImagePicker = null;
    try { ImagePicker = require('expo-image-picker'); } catch { return; }
    try {
      if (fromCamera) {
        let perm = await ImagePicker.getCameraPermissionsAsync?.();
        if (!perm?.granted && perm?.canAskAgain !== false) perm = await ImagePicker.requestCameraPermissionsAsync?.();
        if (!perm?.granted) {
          Alert.alert(
            tr('photoStudio.cameraPermTitle', 'Acesso à câmera'),
            tr('photoStudio.cameraPermMsg', 'Para tirar uma foto, permita o acesso à câmera nos Ajustes do aparelho.'),
            [
              { text: tr('common.cancel', 'Cancelar'), style: 'cancel' },
              { text: tr('common.openSettings', 'Abrir Ajustes'), onPress: () => { try { Linking.openSettings?.(); } catch {} } },
            ],
          );
          return;
        }
      } else if (Platform.OS !== 'web') {
        let ensure = null;
        try { ensure = require('../ProfileEditSheet').ensurePhotoPermission; } catch {}
        if (typeof ensure === 'function' && !(await ensure(t))) return;
      }
      const opts = { mediaTypes: ['images'], allowsEditing: false, quality: 0.92, exif: false };
      const res = fromCamera ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
      const a = res && !res.canceled && res.assets && res.assets[0];
      if (!a || !a.uri) return;
      setBusy('prep');
      const n = await _normalize(a);
      setBusy('');
      if (!n) { setErr(tr('photoStudio.failed', 'Não foi possível enviar. Tente de novo.')); return; }
      setSrc(n);
      setStage('crop');
    } catch (e) {
      setBusy('');
      setErr(String(e?.message || tr('photoStudio.failed', 'Não foi possível enviar. Tente de novo.')));
    }
  }, [busy, t]);

  const upload = useCallback(async () => {
    if (!src || busy) return;
    let rect = null;
    try { rect = cropFnRef.current ? cropFnRef.current() : null; } catch { rect = null; }
    setStage('menu');
    setErr('');
    setBusy('upload');
    setProgress(0);
    try {
      const file = rect ? await _cropOut(src, rect, isCover ? OUT_COVER : OUT_AVATAR) : { uri: src.uri, name: 'image.jpg', type: 'image/jpeg' };
      setLocalPreview(file.uri);
      const api = require('../../services/api');
      if (isCover) {
        const r = await api.uploadCover({ ...file, name: 'cover.jpg' }, { onProgress: (p) => setProgress(Math.max(0, Math.min(1, Number(p) || 0))) });
        if (r?.success && r?.data?.cover_url) {
          const url = normalizeCoverUrl(String(r.data.cover_url));
          try { onCoverChanged?.(url); } catch {}
          setBusy('');
          finish(tr('photoStudio.coverDone', 'Capa atualizada'));
          return;
        }
        throw new Error(r?.message || tr('photoStudio.failed', 'Não foi possível enviar. Tente de novo.'));
      } else {
        const r = await api.uploadAvatar({ ...file, name: 'avatar.jpg' });
        if (r?.success) {
          try { onAvatarChanged?.(r, file.uri); } catch {}
          setBusy('');
          finish(tr('photoStudio.avatarDone', 'Foto atualizada'));
          return;
        }
        throw new Error(r?.message || tr('photoStudio.failed', 'Não foi possível enviar. Tente de novo.'));
      }
    } catch (e) {
      setLocalPreview('');
      setBusy('');
      setErr(String(e?.message || tr('photoStudio.failed', 'Não foi possível enviar. Tente de novo.')));
      _haptic('error');
    }
  }, [src, busy, isCover, onAvatarChanged, onCoverChanged, finish]);

  const doRemove = useCallback(async () => {
    setErr('');
    setBusy('remove');
    try {
      if (isCover) {
        const api = require('../../services/api');
        const r = await api.updateProfile({ cover_url: '' });
        if (!r?.success) throw new Error(r?.message || '');
        try { onCoverChanged?.(''); } catch {}
        setBusy('');
        setDone('removed');
        _haptic('success');
        if (closeTimer.current) clearTimeout(closeTimer.current);
        closeTimer.current = setTimeout(() => { closeTimer.current = null; onClose?.(); }, 800);
        return;
      }
      const PP = require('../../services/profilePhotos');
      const list = await PP.fetchProfilePhotos(email, { force: true });
      const main = (list?.photos || []).find((p) => p && p.is_main);
      if (!main) throw new Error(tr('photoStudio.noPhoto', 'Você ainda não tem foto de perfil.'));
      const r = await PP.removeProfilePhoto(main.id, email);
      if (!r?.success) throw new Error(r?.message || '');
      try { onAvatarChanged?.(r, ''); } catch {}
      setAvatarKey((n) => n + 1);
      setBusy('');
      finish(tr('photoStudio.removed', 'Foto removida'));
    } catch (e) {
      setBusy('');
      setErr(String(e?.message || '') || tr('photoStudio.removeFailed', 'Não foi possível remover agora.'));
    }
  }, [isCover, email, onAvatarChanged, onCoverChanged, onClose, finish]);

  const askRemove = useCallback(() => {
    if (busy) return;
    Alert.alert(
      isCover ? tr('photoStudio.removeCoverTitle', 'Remover foto de capa?') : tr('photoStudio.removePhotoTitle', 'Remover foto de perfil?'),
      isCover ? '' : tr('photoStudio.removePhotoMsg', 'Se você tiver outras fotos no perfil, a mais recente passa a ser a principal.'),
      [
        { text: tr('common.cancel', 'Cancelar'), style: 'cancel' },
        { text: isCover ? tr('photoStudio.removeCover', 'Remover capa') : tr('photoStudio.removePhoto', 'Remover foto'), style: 'destructive', onPress: doRemove },
      ],
    );
  }, [busy, isCover, doRemove]);

  const requestClose = useCallback(() => {
    if (stage === 'crop') { setStage('menu'); setSrc(null); return; }
    onClose?.();
  }, [stage, onClose]);

  const setCropFn = useCallback((fn) => { cropFnRef.current = fn; }, []);

  // ── Prévia do perfil (capa 3:1 + avatar por cima + nome) ──
  const profileMock = (coverNode, w) => {
    const ch = Math.round(w / 3);
    const av = Math.round(Math.max(56, w * 0.2));
    return (
      <View style={{ width: w, alignItems: 'center' }}>
        <View style={[st.mockCover, { width: w, height: ch, backgroundColor: g.fill }]}>
          {coverNode}
        </View>
        <View style={{ marginTop: -av / 2, width: av + 8, height: av + 8, borderRadius: (av + 8) / 2, backgroundColor: g.pageBg, padding: 4 }}>
          <AvatarCircle key={`a${avatarKey}`} email={email} uri={avatarUri || undefined} name={name || email} size={av} />
        </View>
        {name ? <Text style={[st.mockName, { color: g.text }]} numberOfLines={1}>{name}</Text> : null}
      </View>
    );
  };

  const coverImgNode = curCover && !(done === 'removed')
    ? <RNImage source={{ uri: curCover }} style={StyleSheet.absoluteFill} resizeMode="cover" />
    : <CoverFallback isDark={g.isDark} />;

  const overlay = (busy === 'upload' || busy === 'remove' || busy === 'prep' || (done && done !== 'removed')) ? (
    <View style={[StyleSheet.absoluteFill, st.overlay]} pointerEvents="none">
      {done ? (
        <View style={st.doneBadge}><IconCheck size={30} color="#fff" strokeWidth={2.6} /></View>
      ) : <ActivityIndicator color="#fff" size="large" />}
      <Text style={st.overlayText}>
        {done || (busy === 'remove' ? tr('photoStudio.removing', 'Removendo…')
          : busy === 'prep' ? tr('photoStudio.preparing', 'Preparando…')
            : `${tr('photoStudio.uploading', 'Enviando…')}${isCover && progress > 0.01 ? ` ${Math.round(progress * 100)}%` : ''}`)}
      </Text>
      {busy === 'upload' && isCover ? (
        <View style={st.progTrack}><View style={[st.progFill, { width: `${Math.round(Math.max(0.04, progress) * 100)}%` }]} /></View>
      ) : null}
    </View>
  ) : null;

  const big = Math.min(200, colW - 120);
  const actions = [{ key: 'gallery', icon: IconImage, label: tr('photoStudio.gallery', 'Escolher da galeria'), onPress: () => pick(false) }];
  if (Platform.OS !== 'web') actions.push({ key: 'camera', icon: IconCamera, label: tr('photoStudio.camera', 'Tirar foto'), onPress: () => pick(true) });
  if (isCover ? hasCover : true) {
    actions.push({ key: 'remove', icon: IconTrash, destructive: true, label: isCover ? tr('photoStudio.removeCover', 'Remover capa') : tr('photoStudio.removePhoto', 'Remover foto'), onPress: askRemove });
  }
  const menu = (
    <View style={{ flex: 1 }}>
      <View style={[st.bar, { paddingTop: insets.top + 6 }]}>
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel={tr('common.close', 'Fechar')} style={[st.circleBtn, { backgroundColor: g.fill }]} testID="photo-studio-close">
          <IconX size={18} color={g.text} />
        </Pressable>
        <Text style={[st.barTitle, { color: g.text }]} numberOfLines={1}>
          {isCover ? tr('photoStudio.coverTitle', 'Foto de capa') : tr('photoStudio.avatarTitle', 'Foto de perfil')}
        </Text>
        <View style={{ width: 36 }} />
      </View>
      <View style={st.previewWrap}>
        {isCover ? (
          <View>
            {profileMock(coverImgNode, colW - 32)}
            <View style={[st.mockOverlayBox, { width: colW - 32, height: Math.round((colW - 32) / 3) }]} pointerEvents="none">{overlay}</View>
          </View>
        ) : (
          <View style={{ width: big, height: big, borderRadius: big / 2, overflow: 'hidden', backgroundColor: g.fill }}>
            {localPreview
              ? <RNImage source={{ uri: localPreview }} style={StyleSheet.absoluteFill} resizeMode="cover" />
              : <AvatarCircle key={`b${avatarKey}`} email={email} uri={avatarUri || undefined} name={name || email} size={big} />}
            {overlay}
          </View>
        )}
        <Text style={[st.hint, { color: g.secondary }]}>
          {isCover
            ? tr('photoStudio.coverHint', 'Fica no topo do seu perfil. Fotos na horizontal ficam melhores — depois de escolher, arraste para enquadrar.')
            : tr('photoStudio.avatarHint', 'Aparece nas conversas, nos contatos e no seu perfil.')}
        </Text>
        {err ? <Text style={[st.err, { color: g.destructive }]}>{err}</Text> : null}
      </View>
      <View style={[st.card, { backgroundColor: g.cardBg, width: colW - 32 }, g.cardShadow || null]}>
        {actions.map((a, i) => (
          <ActionRow key={a.key} g={g} icon={a.icon} label={a.label} onPress={a.onPress} destructive={!!a.destructive} disabled={!!busy} testID={`photo-studio-${a.key}`} last={i === actions.length - 1} />
        ))}
      </View>
    </View>
  );

  const previewW = isCover ? Math.min(colW - 96, 300) : 0;
  const crop = src ? (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <View style={[st.bar, { paddingTop: insets.top + 6 }]}>
        <Pressable onPress={requestClose} hitSlop={10} accessibilityRole="button" style={st.textBtn} testID="photo-studio-crop-cancel">
          <Text style={st.textBtnLabel}>{tr('common.cancel', 'Cancelar')}</Text>
        </Pressable>
        <Text style={[st.barTitle, { color: '#fff' }]} numberOfLines={1}>{tr('photoStudio.adjust', 'Mover e ajustar')}</Text>
        <Pressable onPress={upload} hitSlop={10} accessibilityRole="button" style={[st.textBtn, st.saveBtn]} testID="photo-studio-crop-save">
          <Text style={[st.textBtnLabel, { color: '#111', fontWeight: '700' }]}>{tr('common.save', 'Salvar')}</Text>
        </Pressable>
      </View>
      <View style={st.cropArea}>
        <Cropper
          key={src.uri}
          src={src}
          aspect={isCover ? 3 : 1}
          round={!isCover}
          frameW={frameW}
          onReady={setCropFn}
          previewW={previewW}
          previewNode={isCover ? (node) => (
            <View style={st.livePreview}>
              <Text style={st.liveLabel}>{tr('photoStudio.preview', 'Prévia')}</Text>
              <View style={[st.liveCard, { backgroundColor: g.pageBg }]}>
                {profileMock(node, previewW)}
              </View>
            </View>
          ) : null}
        />
        <Text style={st.cropHint}>{tr('photoStudio.adjustHint', 'Arraste para posicionar · pince para ampliar')}</Text>
      </View>
    </View>
  ) : null;

  return (
    <Modal
      visible={!!visible}
      animationType="slide"
      transparent={false}
      presentationStyle="fullScreen"
      onRequestClose={requestClose}
      statusBarTranslucent
    >
      <View style={[st.root, { backgroundColor: stage === 'crop' ? '#000' : g.pageBg, paddingBottom: insets.bottom + 12 }]}>
        {stage === 'crop' && crop ? crop : menu}
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, alignItems: 'stretch' },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8 },
  barTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600', letterSpacing: -0.3, marginHorizontal: 8 },
  circleBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  textBtn: { minWidth: 72, height: 34, paddingHorizontal: 12, borderRadius: 17, alignItems: 'flex-start', justifyContent: 'center' },
  saveBtn: { backgroundColor: '#fff', alignItems: 'center' },
  textBtnLabel: { color: '#fff', fontSize: 16 },
  previewWrap: { alignItems: 'center', paddingTop: 24, paddingBottom: 20, paddingHorizontal: 16 },
  mockCover: { borderRadius: 16, overflow: 'hidden' },
  mockOverlayBox: { position: 'absolute', top: 0, left: 0, borderRadius: 16, overflow: 'hidden' },
  mockName: { fontSize: 17, fontWeight: '700', marginTop: 6, letterSpacing: -0.3 },
  overlay: { backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  overlayText: { color: '#fff', fontSize: 14, fontWeight: '600', marginTop: 8 },
  doneBadge: { width: 52, height: 52, borderRadius: 26, backgroundColor: 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center' },
  progTrack: { width: '50%', height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.3)', marginTop: 10, overflow: 'hidden' },
  progFill: { height: 3, backgroundColor: '#fff' },
  hint: { fontSize: 13.5, lineHeight: 19, textAlign: 'center', marginTop: 18, maxWidth: 340 },
  err: { fontSize: 13.5, textAlign: 'center', marginTop: 10, maxWidth: 340 },
  card: { alignSelf: 'center', borderRadius: 14, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingHorizontal: 14 },
  rowIcon: { width: 32, height: 32, borderRadius: 9, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  rowText: { flex: 1, fontSize: 16.5, letterSpacing: -0.2 },
  rowSep: { position: 'absolute', left: 58, right: 0, bottom: 0, height: StyleSheet.hairlineWidth },
  cropArea: { flex: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  cropHint: { color: 'rgba(255,255,255,0.72)', fontSize: 13.5, marginTop: 18, textAlign: 'center', paddingHorizontal: 24 },
  livePreview: { alignItems: 'center', marginTop: 28 },
  liveLabel: { color: 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: '600', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 8 },
  liveCard: { borderRadius: 18, padding: 10, paddingBottom: 12 },
});
