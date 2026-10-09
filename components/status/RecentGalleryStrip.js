// [2026-10-09 status-composer] Faixa de galeria recente na câmera do status
// (WhatsApp/Instagram): últimas fotos e vídeos do rolo logo acima do obturador.
// Toque = abre no estúdio; segurar = entra em multi-seleção (até 10) e o botão
// "Próximo" manda todas juntas. Só aparece se a permissão da galeria JÁ foi
// dada (nunca pede permissão sozinha ao abrir a câmera). expo-media-library já
// está no binário 2.6.0 → OTA.
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, Image, ScrollView, Platform, StyleSheet } from 'react-native';
import { IconCheck, IconPlay } from '../Icons';

function _ML() { try { return require('expo-media-library'); } catch { return null; } }

async function _localUri(ML, asset) {
  if (!asset) return null;
  if (Platform.OS === 'android' && String(asset.uri || '').startsWith('file:')) return asset.uri;
  try {
    const info = await ML.getAssetInfoAsync(asset);
    return info?.localUri || info?.uri || asset.uri;
  } catch { return asset.uri; }
}

export default function RecentGalleryStrip({ visible, onPick, nextLabel, style }) {
  const [assets, setAssets] = useState([]);
  const [sel, setSel] = useState([]); // ids em ordem
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible || Platform.OS === 'web') return undefined;
    let cancelled = false;
    (async () => {
      try {
        const ML = _ML();
        if (!ML?.getAssetsAsync) return;
        const perm = await ML.getPermissionsAsync?.();
        if (!perm?.granted) return;
        const res = await ML.getAssetsAsync({
          first: 30,
          sortBy: [[ML.SortBy?.creationTime || 'creationTime', false]],
          mediaType: [ML.MediaType?.photo || 'photo', ML.MediaType?.video || 'video'],
        });
        if (!cancelled) setAssets(res?.assets || []);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [visible]);

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

  if (!assets.length) return null;
  const selecting = sel.length > 0;
  return (
    <View style={[st.wrap, style]} pointerEvents="box-none">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 10, gap: 6, alignItems: 'center' }}>
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
              <Image source={{ uri: a.uri }} style={st.img} />
              {a.mediaType === 'video' ? (
                <View style={st.vid}><IconPlay size={10} color="#fff" /></View>
              ) : null}
              {selecting ? (
                <View style={[st.check, n >= 0 && st.checkOn]}>
                  {n >= 0 ? <Text style={st.checkTxt}>{n + 1}</Text> : null}
                </View>
              ) : null}
            </TouchableOpacity>
          );
        })}
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
  cell: { width: 52, height: 60, borderRadius: 8, overflow: 'hidden', borderWidth: 2, borderColor: 'transparent', backgroundColor: 'rgba(255,255,255,0.08)' },
  cellOn: { borderColor: '#fff' },
  img: { width: '100%', height: '100%' },
  vid: { position: 'absolute', left: 4, bottom: 4, width: 16, height: 16, borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' },
  check: { position: 'absolute', top: 4, right: 4, width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: '#fff', backgroundColor: 'rgba(0,0,0,0.3)', alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: '#fff' },
  checkTxt: { color: '#000', fontSize: 10, fontWeight: '800' },
  next: { position: 'absolute', right: 12, top: -40, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#fff', borderRadius: 16, paddingHorizontal: 12, height: 32 },
  nextTxt: { color: '#000', fontWeight: '800', fontSize: 13 },
});
