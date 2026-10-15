// [2026-10-09 status-composer] Faixa de galeria recente na câmera do status
// (WhatsApp/Instagram): últimas fotos e vídeos do rolo logo acima do obturador.
// Toque = abre no estúdio; segurar = entra em multi-seleção (até 10) e o botão
// "Próximo" manda todas juntas.
//
// [2026-10-15 status-cam] Quadrados VAZIOS no iPhone: no iOS o asset vem como
// `ph://<id>` e o <Image> do RN NÃO carrega ph:// (o loader de fotos saiu do
// core junto com o CameraRoll) → célula cinza. Agora expo-image (FastImage),
// que resolve ph:// via PHImageManager e já faz cache/decodificação em
// background. Também: permissão "limitada" do iOS 17/18 mostra o bloco
// "Gerenciar" (presentPermissionsPickerAsync); sem permissão mostra um botão
// "Permitir acesso às fotos" (só pede quando o usuário toca — nunca sozinho);
// arrastar a faixa para cima abre a galeria completa (onOpenGallery); lista
// em cache de módulo → reabrir a câmera pinta na hora.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Platform, StyleSheet, PanResponder, Linking } from 'react-native';
import FastImage from '../FastImage';
import { IconCheck, IconPlay, IconImage, IconChevronUp } from '../Icons';

function _ML() { try { return require('expo-media-library'); } catch { return null; } }

// Cache de módulo: última lista + permissão (reabrir a câmera não pisca).
let _cache = { assets: [], perm: null, at: 0 };
const _subs = new Set();
function _publish(next) { _cache = { ..._cache, ...next, at: Date.now() }; _subs.forEach(fn => { try { fn(_cache); } catch {} }); }

export async function loadRecentAssets({ first = 30, force = false } = {}) {
  if (Platform.OS === 'web') return _cache;
  const ML = _ML();
  if (!ML?.getAssetsAsync) return _cache;
  if (!force && _cache.assets.length && Date.now() - _cache.at < 15000) return _cache;
  try {
    const perm = await ML.getPermissionsAsync?.();
    if (!perm?.granted) { _publish({ perm, assets: [] }); return _cache; }
    const res = await ML.getAssetsAsync({
      first,
      sortBy: [[ML.SortBy?.creationTime || 'creationTime', false]],
      mediaType: [ML.MediaType?.photo || 'photo', ML.MediaType?.video || 'video'],
    });
    _publish({ perm, assets: res?.assets || [] });
  } catch {}
  return _cache;
}

// Hook compartilhado (faixa + quadradinho da galeria ao lado do disparador).
export function useRecentAssets(visible) {
  const [state, setState] = useState(_cache);
  useEffect(() => {
    const fn = (c) => setState(c);
    _subs.add(fn);
    return () => { _subs.delete(fn); };
  }, []);
  useEffect(() => {
    if (!visible || Platform.OS === 'web') return undefined;
    loadRecentAssets({ force: true });
    // Rolo mudou (foto nova, seleção limitada alterada) → recarrega.
    let sub = null;
    try { sub = _ML()?.addListener?.(() => { loadRecentAssets({ force: true }); }); } catch {}
    return () => { try { sub?.remove?.(); } catch {} };
  }, [visible]);
  return state;
}

async function _localUri(ML, asset) {
  if (!asset) return null;
  if (Platform.OS === 'android' && String(asset.uri || '').startsWith('file:')) return asset.uri;
  try {
    const info = await ML.getAssetInfoAsync(asset);
    return info?.localUri || info?.uri || asset.uri;
  } catch { return asset.uri; }
}

export default function RecentGalleryStrip({ visible, onPick, onOpenGallery, nextLabel, style, t }) {
  const { assets, perm } = useRecentAssets(visible);
  const [sel, setSel] = useState([]); // ids em ordem
  const [busy, setBusy] = useState(false);
  const limited = perm?.granted && perm?.accessPrivileges === 'limited';

  // Arrastar para cima = galeria completa (grade do sistema).
  const openRef = useRef(onOpenGallery);
  openRef.current = onOpenGallery;
  const pan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => g.dy < -12 && Math.abs(g.dy) > Math.abs(g.dx) * 1.5,
    onPanResponderRelease: (_e, g) => { if (g.dy < -30) { try { openRef.current?.(); } catch {} } },
  }), []);

  const askPermission = useCallback(async () => {
    const ML = _ML();
    if (!ML) return;
    try {
      if (perm && perm.canAskAgain === false) { try { Linking.openSettings?.(); } catch {} return; }
      await ML.requestPermissionsAsync?.();
    } catch {}
    loadRecentAssets({ force: true });
  }, [perm]);

  const manageSelection = useCallback(async () => {
    try { await _ML()?.presentPermissionsPickerAsync?.(); } catch {}
    loadRecentAssets({ force: true });
  }, []);

  const emit = useCallback(async (list) => {
    const ML = _ML();
    if (!ML || busy) return;
    setBusy(true);
    try {
      const items = [];
      for (const a of list) {
        const uri = await _localUri(ML, a);
        if (uri) items.push({ uri, type: a.mediaType === 'video' ? 'video' : 'photo', width: a.width, height: a.height });
      }
      if (items.length === 1) onPick?.({ ...items[0] });
      else if (items.length > 1) onPick?.({ multi: true, items });
    } finally {
      setBusy(false);
      setSel([]);
    }
  }, [busy, onPick]);

  if (Platform.OS === 'web') return null;

  // Sem permissão (ainda não perguntado ou negado): CTA discreto em vez de nada.
  if (perm && !perm.granted) {
    return (
      <View style={[st.wrap, style, { alignItems: 'center', justifyContent: 'center' }]} pointerEvents="box-none">
        <TouchableOpacity onPress={askPermission} style={st.permBtn} accessibilityRole="button" testID="status-gallery-allow">
          <IconImage size={15} color="#fff" />
          <Text style={st.permTxt}>{t?.('statusCam.allowPhotos') || 'Permitir acesso às fotos'}</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (!assets.length && !limited) return null;
  const selecting = sel.length > 0;
  return (
    <View style={[st.wrap, style]} pointerEvents="box-none" {...pan.panHandlers}>
      {onOpenGallery && !selecting ? (
        <View style={st.grabber} pointerEvents="none"><IconChevronUp size={14} color="rgba(255,255,255,0.75)" /></View>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 10, gap: 4, alignItems: 'center' }}>
        {assets.map((a) => {
          const n = sel.indexOf(a.id);
          return (
            <TouchableOpacity
              key={a.id}
              activeOpacity={0.8}
              delayLongPress={280}
              onLongPress={() => setSel(s => (s.includes(a.id) ? s : [...s, a.id].slice(0, 10)))}
              onPress={() => {
                if (selecting) { setSel(s => (s.includes(a.id) ? s.filter(x => x !== a.id) : [...s, a.id].slice(0, 10))); return; }
                emit([a]);
              }}
              style={[st.cell, n >= 0 && st.cellOn]}
            >
              <FastImage source={{ uri: a.uri }} style={st.img} resizeMode="cover" recyclingKey={a.id} transition={120} />
              {a.mediaType === 'video' ? (
                <View style={st.vid}><IconPlay size={9} color="#fff" /></View>
              ) : null}
              {selecting ? (
                <View style={[st.check, n >= 0 && st.checkOn]}>
                  {n >= 0 ? <Text style={st.checkTxt}>{n + 1}</Text> : null}
                </View>
              ) : null}
            </TouchableOpacity>
          );
        })}
        {limited ? (
          <TouchableOpacity onPress={manageSelection} style={[st.cell, st.manage]} accessibilityRole="button">
            <Text style={st.manageTxt} numberOfLines={2}>{t?.('statusCam.manageSelection') || 'Gerenciar seleção'}</Text>
          </TouchableOpacity>
        ) : null}
      </ScrollView>
      {selecting ? (
        <TouchableOpacity onPress={() => emit(sel.map(id => assets.find(a => a.id === id)).filter(Boolean))} style={st.next} accessibilityRole="button">
          <Text style={st.nextTxt}>{nextLabel} ({sel.length})</Text>
          <IconCheck size={14} color="#000" />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, height: 64 },
  grabber: { position: 'absolute', top: -18, alignSelf: 'center', left: 0, right: 0, alignItems: 'center' },
  cell: { width: 48, height: 60, borderRadius: 6, overflow: 'hidden', borderWidth: 1.5, borderColor: 'transparent', backgroundColor: 'rgba(255,255,255,0.10)' },
  cellOn: { borderColor: '#fff' },
  img: { width: '100%', height: '100%' },
  vid: { position: 'absolute', left: 3, bottom: 3, width: 15, height: 15, borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' },
  check: { position: 'absolute', top: 4, right: 4, width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: '#fff', backgroundColor: 'rgba(0,0,0,0.3)', alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: '#fff' },
  checkTxt: { color: '#000', fontSize: 10, fontWeight: '800' },
  manage: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3, borderColor: 'rgba(255,255,255,0.35)' },
  manageTxt: { color: '#fff', fontSize: 9, fontWeight: '700', textAlign: 'center' },
  permBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, height: 34, borderRadius: 17, backgroundColor: 'rgba(0,0,0,0.5)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)' },
  permTxt: { color: '#fff', fontSize: 13, fontWeight: '600' },
  next: { position: 'absolute', right: 12, top: -40, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#fff', borderRadius: 16, paddingHorizontal: 12, height: 32 },
  nextTxt: { color: '#000', fontWeight: '800', fontSize: 13 },
});
