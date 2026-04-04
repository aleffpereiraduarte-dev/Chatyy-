import React, { useState, useEffect, memo } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { getAvatarUrlForEmail } from '../services/api';

let ExpoImage = null;
let RNImage = null;

// Use expo-image on native for built-in disk caching, RN Image on web
if (Platform.OS !== 'web') {
  try { ExpoImage = require('expo-image').Image; } catch {}
}
if (!ExpoImage) {
  RNImage = require('react-native').Image;
}

function getInitials(name) {
  if (!name) return '';
  const trimmed = name.trim();
  if (!trimmed) return '';
  const parts = trimmed.split(/[\s@]+/).filter(Boolean);
  if (parts.length >= 2) return ((parts[0][0] || '') + (parts[1][0] || '')).toUpperCase();
  return parts[0]?.[0]?.toUpperCase() || '';
}

function hashColor(name) {
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}

function AvatarCircle({ name, email, size = 48, style }) {
  const [imgError, setImgError] = useState(false);
  useEffect(() => { setImgError(false); }, [email]);
  const avatarUrl = email ? getAvatarUrlForEmail(email) : null;
  const showImage = avatarUrl && !imgError;

  const displayName = name || email || '';
  const initials = getInitials(displayName);
  const bgColor = hashColor(displayName);
  const accessLabel = displayName ? `Avatar of ${displayName}` : 'User avatar';

  const ImageComponent = ExpoImage || RNImage;

  return (
    <View
      style={[styles.container, { width: size, height: size, borderRadius: size / 2, backgroundColor: bgColor }, style]}
      accessibilityLabel={accessLabel}
      accessibilityRole="image"
    >
      {showImage ? (
        <ImageComponent
          source={{ uri: avatarUrl }}
          style={{ width: size, height: size, borderRadius: size / 2 }}
          onError={() => setImgError(true)}
          accessibilityLabel={accessLabel}
          {...(ExpoImage ? {
            cachePolicy: 'memory-disk',
            contentFit: 'cover',
            transition: 200,
            recyclingKey: email,
          } : {})}
        />
      ) : (
        <Text
          style={[styles.initials, { fontSize: size * 0.38 }]}
          allowFontScaling={false}
          accessibilityElementsHidden
        >
          {initials}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  initials: {
    color: '#fff',
    fontWeight: '600',
  },
});

export default memo(AvatarCircle);
