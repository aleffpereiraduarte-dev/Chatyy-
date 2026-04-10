import React, { useState, useEffect, memo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, Pressable,
  Image, Dimensions, Platform, Animated, ScrollView,
} from 'react-native';
import { getAvatarUrlForEmail, getPublicProfile, feedUserPosts, followUser, unfollowUser } from '../services/api';
import { IconX, IconPhone, IconVideo, IconMessageSquare, IconMail } from './Icons';
import { useRouter } from 'expo-router';

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
  const [stats, setStats] = useState({ posts: 0, followers: 0, following: 0 });
  const [bio, setBio] = useState('');
  const [postPreview, setPostPreview] = useState([]);
  const [isFollowing, setIsFollowing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (visible) {
      setImgError(false);
      Animated.timing(fadeAnim, { toValue: 1, duration: 250, useNativeDriver: false }).start();
      // Load Instagram-style stats + bio + a preview of recent posts
      let alive = true;
      (async () => {
        if (!profile?.email) return;
        try {
          const r = await getPublicProfile(profile.email);
          if (!alive) return;
          if (r?.success && r.data) {
            setStats({
              posts: r.data.post_count || 0,
              followers: r.data.followers_count || 0,
              following: r.data.following_count || 0,
            });
            setBio(r.data.bio || r.data.about || '');
            setIsFollowing(!!r.data.is_following);
          }
        } catch {}
        try {
          const pr = await feedUserPosts(profile.email);
          if (!alive) return;
          const list = Array.isArray(pr?.data) ? pr.data : (pr?.data?.posts || []);
          setPostPreview(list.slice(0, 6));
        } catch {}
      })();
      return () => { alive = false; };
    } else {
      fadeAnim.setValue(0);
      setBio('');
      setStats({ posts: 0, followers: 0, following: 0 });
      setPostPreview([]);
    }
  }, [visible, profile?.email]);

  const toggleFollow = async () => {
    if (!profile?.email || followBusy) return;
    setFollowBusy(true);
    try {
      if (isFollowing) {
        const r = await unfollowUser(profile.email);
        if (r?.success) {
          setIsFollowing(false);
          setStats(s => ({ ...s, followers: Math.max(0, s.followers - 1) }));
        }
      } else {
        const r = await followUser(profile.email);
        if (r?.success) {
          setIsFollowing(true);
          setStats(s => ({ ...s, followers: s.followers + 1 }));
        }
      }
    } catch {}
    setFollowBusy(false);
  };

  const openFullProfile = () => {
    if (!profile?.email) return;
    onClose?.();
    setTimeout(() => {
      try {
        router.push({ pathname: '/user-profile', params: { email: profile.email, name: profile.name || '' } });
      } catch {}
    }, 80);
  };

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
      statusColor = '#7C3AED';
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

            <ScrollView style={{ maxHeight: 520 }} showsVerticalScrollIndicator={false}>
            {/* Info section */}
            <View style={s.infoSection}>
              <Text style={[s.nameText, { color: colors.text }]} numberOfLines={2}>{displayName}</Text>
              {!!profile.email && (
                <Text style={[s.emailText, { color: colors.textSecondary || '#666' }]} numberOfLines={1} selectable>@{(profile.email || '').split('@')[0]}</Text>
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

            {/* Stats row — Instagram-like */}
            {isDirect && (
              <View style={s.statsRow}>
                <View style={s.statCol}>
                  <Text style={[s.statValue, { color: colors.text }]}>{stats.posts}</Text>
                  <Text style={[s.statLabel, { color: colors.textSecondary || '#666' }]}>{t('profile.posts') || 'posts'}</Text>
                </View>
                <View style={[s.statDivider, { backgroundColor: colors.border }]} />
                <TouchableOpacity style={s.statCol} onPress={openFullProfile} activeOpacity={0.7}>
                  <Text style={[s.statValue, { color: colors.text }]}>{stats.followers}</Text>
                  <Text style={[s.statLabel, { color: colors.textSecondary || '#666' }]}>{t('profile.followers') || 'seguidores'}</Text>
                </TouchableOpacity>
                <View style={[s.statDivider, { backgroundColor: colors.border }]} />
                <TouchableOpacity style={s.statCol} onPress={openFullProfile} activeOpacity={0.7}>
                  <Text style={[s.statValue, { color: colors.text }]}>{stats.following}</Text>
                  <Text style={[s.statLabel, { color: colors.textSecondary || '#666' }]}>{t('profile.following') || 'seguindo'}</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Bio */}
            {!!bio && (
              <View style={{ paddingHorizontal: 22, marginTop: 8 }}>
                <Text style={[s.bioText, { color: colors.text }]} numberOfLines={4}>{bio}</Text>
              </View>
            )}

            {/* Action buttons */}
            {isDirect && (
              <View style={s.actionRow}>
                {onMessage && (
                  <TouchableOpacity style={[s.actionBtn, { backgroundColor: (colors.primaryLight || '#e8f5e9') }]} onPress={() => { onClose(); onMessage(); }} activeOpacity={0.7}>
                    <IconMessageSquare size={22} color={colors.primary || '#6D28D9'} />
                    <Text style={[s.actionLabel, { color: colors.primary || '#6D28D9' }]}>{t('chatConv.message') || 'Mensagem'}</Text>
                  </TouchableOpacity>
                )}
                {onAudioCall && (
                  <TouchableOpacity style={[s.actionBtn, { backgroundColor: (colors.primaryLight || '#e8f5e9') }]} onPress={() => { onClose(); onAudioCall(); }} activeOpacity={0.7}>
                    <IconPhone size={22} color={colors.primary || '#6D28D9'} />
                    <Text style={[s.actionLabel, { color: colors.primary || '#6D28D9' }]}>{t('call.audioCall') || 'Chamada'}</Text>
                  </TouchableOpacity>
                )}
                {onVideoCall && (
                  <TouchableOpacity style={[s.actionBtn, { backgroundColor: (colors.primaryLight || '#e8f5e9') }]} onPress={() => { onClose(); onVideoCall(); }} activeOpacity={0.7}>
                    <IconVideo size={22} color={colors.primary || '#6D28D9'} />
                    <Text style={[s.actionLabel, { color: colors.primary || '#6D28D9' }]}>{t('call.videoCall') || 'Video'}</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {/* Follow + View profile */}
            {isDirect && (
              <View style={s.profileBtnRow}>
                <TouchableOpacity
                  onPress={toggleFollow}
                  disabled={followBusy}
                  style={[s.profileBtn, isFollowing
                    ? { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }
                    : { backgroundColor: colors.primary || '#6D28D9' }]}
                  activeOpacity={0.7}
                >
                  <Text style={[s.profileBtnText, { color: isFollowing ? colors.text : '#fff' }]}>
                    {isFollowing ? (t('profile.following') || 'Seguindo') : (t('profile.follow') || 'Seguir')}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={openFullProfile} style={[s.profileBtn, { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }]} activeOpacity={0.7}>
                  <Text style={[s.profileBtnText, { color: colors.text }]}>
                    {t('profile.viewFull') || 'Ver perfil completo'}
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Posts grid preview */}
            {isDirect && postPreview.length > 0 && (
              <View style={s.gridWrap}>
                {postPreview.map((p, i) => {
                  const url = p.media_urls && p.media_urls[0] ? p.media_urls[0] : (p.thumb_url || p.image_url || '');
                  return (
                    <TouchableOpacity key={p.id || i} style={s.gridCell} onPress={openFullProfile} activeOpacity={0.85}>
                      {url ? (
                        <Image source={{ uri: url }} style={s.gridImg} resizeMode="cover" />
                      ) : (
                        <View style={[s.gridImg, { backgroundColor: colors.border, alignItems: 'center', justifyContent: 'center' }]}>
                          <Text style={{ fontSize: 18, color: colors.textTertiary }}>📷</Text>
                        </View>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {/* Bottom spacing */}
            <View style={{ height: 20 }} />
            </ScrollView>
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
    backgroundColor: '#7C3AED',
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
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 14,
    marginTop: 6,
  },
  statCol: {
    flex: 1,
    alignItems: 'center',
  },
  statValue: { fontSize: 20, fontWeight: '800' },
  statLabel: { fontSize: 11, fontWeight: '600', marginTop: 2, letterSpacing: 0.3 },
  statDivider: { width: StyleSheet.hairlineWidth, height: 28 },
  bioText: { fontSize: 13, lineHeight: 18, textAlign: 'center' },
  profileBtnRow: {
    flexDirection: 'row', gap: 10,
    paddingHorizontal: 20, marginTop: 12,
  },
  profileBtn: {
    flex: 1,
    paddingVertical: 10, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  profileBtnText: { fontSize: 13, fontWeight: '700', letterSpacing: 0.2 },
  gridWrap: {
    flexDirection: 'row', flexWrap: 'wrap',
    marginTop: 16,
    paddingHorizontal: 2,
    gap: 2,
  },
  gridCell: {
    width: '32%',
    aspectRatio: 1,
  },
  gridImg: {
    width: '100%', height: '100%',
  },
});

export default memo(ProfileViewerModal);
