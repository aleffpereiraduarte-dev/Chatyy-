// QrScanTools — [2026-10-09 media-native] WhatsApp-style extras under a QR
// viewfinder: flashlight toggle + "scan from photo" (picks an image and decodes
// it with expo-camera's native decoder — AVFoundation/Vision on iOS, ML Kit on
// Android). JS-only: expo-camera + expo-image-picker are already in the binary.
//
// Usage:
//   const [torch, setTorch] = useState(false);
//   <CameraView enableTorch={torch} ... />
//   <QrScanTools t={t} torch={torch} onToggleTorch={() => setTorch(v => !v)}
//                onResult={(data) => handleScanned({ data })} />
import React, { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, Alert, ActivityIndicator } from 'react-native';
import { IconZap, IconImage } from './Icons';

export async function scanQrFromImageUri(uri) {
  if (!uri) return null;
  try {
    const cam = require('expo-camera');
    const fn = cam.scanFromURLAsync || cam.Camera?.scanFromURLAsync;
    if (typeof fn !== 'function') return null;
    const res = await fn(uri, ['qr']);
    const hit = Array.isArray(res) ? res.find((r) => r && r.data) : null;
    return hit ? String(hit.data) : null;
  } catch {
    return null;
  }
}

export default function QrScanTools({ t, torch, onToggleTorch, onResult, color = '#fff', style }) {
  const [busy, setBusy] = useState(false);

  const pickPhoto = useCallback(async () => {
    if (busy) return;
    let picker;
    try { picker = require('expo-image-picker'); } catch { picker = null; }
    if (!picker?.launchImageLibraryAsync) return;
    setBusy(true);
    try {
      const r = await picker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, allowsEditing: false });
      if (r?.canceled || !r?.assets?.[0]?.uri) return;
      const data = await scanQrFromImageUri(r.assets[0].uri);
      if (data) onResult?.(data);
      else Alert.alert(t('qr.noQrInPhoto'));
    } catch {
      Alert.alert(t('qr.noQrInPhoto'));
    } finally {
      setBusy(false);
    }
  }, [busy, onResult, t]);

  if (Platform.OS === 'web') return null;
  return (
    <View style={[st.row, style]}>
      {onToggleTorch ? (
        <TouchableOpacity
          onPress={onToggleTorch}
          style={[st.btn, torch && st.btnOn]}
          accessibilityRole="button"
          accessibilityLabel={t('qr.flash')}
          accessibilityState={{ selected: !!torch }}
        >
          <IconZap size={20} color={torch ? '#000' : color} />
          <Text style={[st.label, { color: torch ? '#000' : color }]} numberOfLines={1}>{t('qr.flash')}</Text>
        </TouchableOpacity>
      ) : null}
      <TouchableOpacity onPress={pickPhoto} style={st.btn} accessibilityRole="button" accessibilityLabel={t('qr.fromPhoto')} disabled={busy}>
        {busy ? <ActivityIndicator size="small" color={color} /> : <IconImage size={20} color={color} />}
        <Text style={[st.label, { color }]} numberOfLines={1}>{t('qr.fromPhoto')}</Text>
      </TouchableOpacity>
    </View>
  );
}

const st = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'center', gap: 12, marginTop: 14 },
  btn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingVertical: 10, borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.72)',
  },
  btnOn: { backgroundColor: '#fff' },
  label: { fontSize: 14, fontWeight: '600' },
});
