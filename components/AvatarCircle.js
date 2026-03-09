import React, { useState, memo } from 'react';
import { View, Image, Text, StyleSheet } from 'react-native';
import { getAvatarUrlForEmail } from '../services/api';

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/[\s@]+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name[0].toUpperCase();
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
  const avatarUrl = email ? getAvatarUrlForEmail(email) : null;
  const showImage = avatarUrl && !imgError;

  const initials = getInitials(name || email);
  const bgColor = hashColor(name || email);

  return (
    <View style={[styles.container, { width: size, height: size, borderRadius: size / 2, backgroundColor: bgColor }, style]}>
      {showImage ? (
        <Image
          source={{ uri: avatarUrl }}
          style={{ width: size, height: size, borderRadius: size / 2 }}
          onError={() => setImgError(true)}
        />
      ) : (
        <Text style={[styles.initials, { fontSize: size * 0.38 }]}>{initials}</Text>
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
