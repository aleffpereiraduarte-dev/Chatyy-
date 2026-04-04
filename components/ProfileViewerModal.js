import React, { useState, useEffect, memo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, Pressable,
  Image, Dimensions, Platform, Animated,
} from 'react-native';
import { getAvatarUrlForEmail } from '../services/api';
import { IconX, IconPhone, IconVideo, IconMessageSquare, IconMail } from './Icons';

const SCREEN_W = Dimensions.get('window').width;
const AVATAR_SIZE = Math.min(SCREEN_W * 0.4, 160);

// Same hash functions as AvatarCircle for consistency
function getInitials(name) {
  if (!name) return '?';
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/[\s@]+/).filter(Boolean);
  if (parts.length >= 2) return ((parts[0][0] || '') + (parts[1][0] || '')).toUpperCase();
  return parts[0]?.[0]?.toUpperCase() || '?';
}

function hashHue(name) {
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 360;
}

// Generate a pair of gradient-like colors from the name
function gradientColors(name) {
  const hue = hashHue(name);
  const hue2 = (hue + 35) % 360;
  return {
    top: `hsl(${hue}, 50%, 40%)`,
    bottom: `hsl(${hue2}, 60%, 30%)`,
    accent: `hsl(${hue}, 55%, 55%)`,
  };
}

function ProfileViewerModal({
  visible,
  profile, // { name, email }
  onClose,
  onMessage,
  onAudioCall,
  onVideoCall,
  presence, // { status, last_seen } or null
  conversationType, // 'direct' or 'group'
  colors, // theme colors
  t, // i18n function
  formatLastSeen, // function(last_seen, t) => string
}) {
  const [imgError, setImgError] = useState(false);
  const [fadeAnim] = useState(new Animated.Value(0));

  useEffect(() => {
    if (visible) {
      setImgError(false);
      Animated.timing(fadeAnim, { toValue: 1, duration: 250, useNativeDriver: false }).start();
    } else {
      fadeAnim.setValue(0);
    }
  }, [visible, profile?.email]);

  if (!visible || !profile) return null;

  const displayName = profile.name || profile.email || '';
  const initials = getInitials(displayName);
  const grad = gradientColors(displayName);
  const avatarUrl = profile.email ? getAvatarUrlForEmail(profile.email) : null;
  const showImage = avatarUrl && !imgError;
  const isDirect = conversationType === 'direct';

  // Status text
  let statusText = '';
  let statusColor = colors.textTertiary || '#999';
  if (presence) {
    if (presence.status === 'online') {
      statusText = t('chatConv.online') || 'online';
      statusColor = '#25D366';
    } else if (presence.status === 'away') {
      statusText = t('chatConv.away') || 'ausente';
      statusColor = '#f59e0b';
    } else if (presence.last_seen && formatLastSeen) {
      statusText = `${t('chatConv.lastSeen') || 'visto por ultimo'} ${formatLastSeen(presence.last_seen, t)}`;
    }
  }

  const actionBtnSize = 52;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={s.overlay} onPress={onClose}>
        <Animated.View style={[s.card, { backgroundColor: colors.surface || '#fff', opacity: fadeAnim, transform: [{ scale: fadeAnim.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) }] }]}>
          <Pressable onPress={e => e.stopPropagation()}>
            {/* Header gradient band */}
            <View style={[s.headerBand, { backgroundColor: grad.top }]}>
              <View style={[s.headerBandBottom, { backgroundColor: grad.bottom }]} />
              {/* Close button */}
              <TouchableOpacity style={s.closeBtn} onPress={onClose} activeOpacity={0.7}>
                <IconX size={20} color="rgba(255,255,255,0.85)" />
              </TouchableOpacity>
            </View>

            {/* Avatar area - overlapping the band */}
            <View style={s.avatarArea}>
              <View style={[s.avatarRing, { borderColor: colors.surface || '#fff' }]}>
                {showImage ? (
                  <Image
                    source={{ uri: avatarUrl }}
                    style={s.avatarImage}
                    resizeMode="cover"
                    onError={() => setImgError(true)}
                  />
                ) : (
                  <View style={[s.avatarFallback, { backgroundColor: grad.accent }]}>
                    <Text style={s.avatarInitials} allowFontScaling={false}>{initials}</Text>
                  </View>
                )}
                {/* Online indicator */}
                {presence?.status === 'online' && isDirect && (
                  <View style={[s.onlineDot, { borderColor: colors.surface || '#fff' }]} />
                )}
              </View>
            </View>

            {/* Info section */}
            <View style={s.infoSection}>
              <Text style={[s.nameText, { color: colors.text }]} numberOfLines={2}>{displayName}</Text>
              {!!profile.email && (
                <Text style={[s.emailText, { color: colors.textSecondary || '#666' }]} numberOfLines={1} selectable>{profile.email}</Text>
              )}
              {!!statusText && isDirect && (
                <View style={s.statusRow}>
                  <View style={[s.statusDot, { backgroundColor: statusColor }]} />
                  <Text style={[s.statusText, { color: statusColor }]}>{statusText}</Text>
                </View>
              )}
              {conversationType === 'group' && (
                <Text style={[s.statusText, { color: colors.textTertiary || '#999', marginTop: 4 }]}>{t('chatConv.group') || 'Grupo'}</Text>
              )}
            </View>

            {/* Action buttons */}
            {isDirect && (
              <View style={s.actionRow}>
                {onMessage && (
                  <TouchableOpacity style={[s.actionBtn, { backgroundColor: (colors.primaryLight || '#e8f5e9') }]} onPress={() => { onClose(); onMessage(); }} activeOpacity={0.7}>
                    <IconMessageSquare size={22} color={colors.primary || '#128C7E'} />
                    <Text style={[s.actionLabel, { color: colors.primary || '#128C7E' }]}>{t('chatConv.message') || 'Mensagem'}</Text>
                  </TouchableOpacity>
                )}
                {onAudioCall && (
                  <TouchableOpacity style={[s.actionBtn, { backgroundColor: (colors.primaryLight || '#e8f5e9') }]} onPress={() => { onClose(); onAudioCall(); }} activeOpacity={0.7}>
                    <IconPhone size={22} color={colors.primary || '#128C7E'} />
                    <Text style={[s.actionLabel, { color: colors.primary || '#128C7E' }]}>{t('call.audioCall') || 'Chamada'}</Text>
                  </TouchableOpacity>
                )}
                {onVideoCall && (
                  <TouchableOpacity style={[s.actionBtn, { backgroundColor: (colors.primaryLight || '#e8f5e9') }]} onPress={() => { onClose(); onVideoCall(); }} activeOpacity={0.7}>
                    <IconVideo size={22} color={colors.primary || '#128C7E'} />
                    <Text style={[s.actionLabel, { color: colors.primary || '#128C7E' }]}>{t('call.videoCall') || 'Video'}</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {/* Bottom spacing */}
            <View style={{ height: 20 }} />
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 28,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    borderRadius: 24,
    overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.25, shadowRadius: 24 },
      android: { elevation: 16 },
      web: { boxShadow: '0 12px 48px rgba(0,0,0,0.3)' },
    }),
  },
  headerBand: {
    height: 100,
    position: 'relative',
  },
  headerBandBottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 50,
    opacity: 0.7,
  },
  closeBtn: {
    position: 'absolute',
    top: 12,
    right: 12,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(0,0,0,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarArea: {
    alignItems: 'center',
    marginTop: -AVATAR_SIZE / 2,
  },
  avatarRing: {
    width: AVATAR_SIZE + 8,
    height: AVATAR_SIZE + 8,
    borderRadius: (AVATAR_SIZE + 8) / 2,
    borderWidth: 4,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  avatarImage: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
  },
  avatarFallback: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitials: {
    color: '#fff',
    fontSize: AVATAR_SIZE * 0.36,
    fontWeight: '700',
    letterSpacing: 1,
  },
  onlineDot: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#25D366',
    borderWidth: 3,
  },
  infoSection: {
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 14,
    paddingBottom: 4,
  },
  nameText: {
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
    lineHeight: 28,
  },
  emailText: {
    fontSize: 14,
    marginTop: 4,
    textAlign: 'center',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    gap: 6,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 13,
    fontWeight: '500',
  },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 4,
  },
  actionBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 16,
    gap: 6,
  },
  actionLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
});

export default memo(ProfileViewerModal);
