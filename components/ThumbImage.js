// components/ThumbImage.js — [2026-10-18 photos-native-always]
//
// Miniatura de lista/grade (Drive, Arquivos): expo-image com cache em
// memória + disco e `recyclingKey` (célula reciclada não mostra a foto antiga
// enquanto carrega a nova). Antes era <Image> do RN: baixava de novo a cada
// montagem e piscava ao rolar. Web / binário sem expo-image → <Image> do RN.
import React from 'react';
import { Image, Platform } from 'react-native';

let _ExpoImage = null;
if (Platform.OS !== 'web') {
  try { _ExpoImage = require('expo-image').Image; } catch { _ExpoImage = null; }
}

const FIT = { cover: 'cover', contain: 'contain', stretch: 'fill', center: 'none' };

export default function ThumbImage({ uri, source, style, resizeMode = 'cover', recyclingKey, accessibilityLabel, onError }) {
  const u = uri || (source && source.uri) || '';
  if (!u) return null;
  if (_ExpoImage) {
    return (
      <_ExpoImage
        source={{ uri: u }}
        style={style}
        contentFit={FIT[resizeMode] || 'cover'}
        cachePolicy="memory-disk"
        recyclingKey={recyclingKey != null ? String(recyclingKey) : u}
        transition={0}
        accessibilityLabel={accessibilityLabel}
        onError={onError}
      />
    );
  }
  return <Image source={{ uri: u }} style={style} resizeMode={resizeMode} accessibilityLabel={accessibilityLabel} onError={onError} />;
}
