import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, FlatList, Image,
  Dimensions, Platform, ActivityIndicator, RefreshControl,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import AvatarCircle from '../components/AvatarCircle';
import { IconArrowLeft, IconMessageSquare, IconPhone, IconSettings, IconGrid, IconLock } from '../components/Icons';
import * as api from '../services/api';

const { width: SCREEN_W } = Dimensions.get('window');
const GRID_GAP = 2;
const GRID_COLS = 3;
const GRID_SIZE = (SCREEN_W - GRID_GAP * (GRID_COLS - 1)) / GRID_COLS;
const ACCENT = '#25D366';

export default function UserProfileScreen() {
  const router = useRouter();
  const { email, name } = useLocalSearchParams();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const isOwnProfile = user?.email === email;

  const [profileData, setProfileData] = useState(null);
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ posts: 0, followers: 0, following: 0 });
  const [isFollowing, setIsFollowing] = useState(false);
  const [followLoading, setFollowLoading] = useState(false);
  const [tab, setTab] = useState('posts'); // posts | tagged

  const displayName = profileData?.display_name || profileData?.name || name || email?.split('@')[0] || '?';
  const bio = profileData?.bio || profileData?.about || '';
  const phone = profileData?.phone || '';

  const loadProfile = useCallback(async () => {
    setLoading(true);
    try {
      // Load profile info
      const [profileRes, postsRes, followRes] = await Promise.all([
        api.apiCall('get_public_profile', { email }, 'GET').catch(() => null),
        api.feedUserPosts(email).catch(() => ({ data: [] })),
        api.apiCall('follow_status', { target_email: email }, 'GET').catch(() => null),
      ]);

      if (profileRes?.success && profileRes.data) {
        setProfileData(profileRes.data);
        setStats({
          posts: profileRes.data.post_count || 0,
          followers: profileRes.data.followers_count || 0,
          following: profileRes.data.following_count || 0,
        });
      }

      if (postsRes?.data) {
        const postList = Array.isArray(postsRes.data) ? postsRes.data : (postsRes.data.posts || []);
        setPosts(postList);
        if (!profileRes?.data?.post_count) {
          setStats(prev => ({ ...prev, posts: postList.length }));
        }
      }

      if (followRes?.success) {
        setIsFollowing(followRes.data?.is_following || false);
      }
    } catch {}
    setLoading(false);
  }, [email]);

  useEffect(() => { loadProfile(); }, [loadProfile]);

  const handleFollow = useCallback(async () => {
    setFollowLoading(true);
    try {
      const action = isFollowing ? 'unfollow_user' : 'follow_user';
      const r = await api.apiCall(action, { target_email: email }, 'POST');
      if (r?.success) {
        setIsFollowing(!isFollowing);
        setStats(prev => ({
          ...prev,
          followers: prev.followers + (isFollowing ? -1 : 1),
        }));
      }
    } catch {}
    setFollowLoading(false);
  }, [isFollowing, email]);

  const handleMessage = useCallback(() => {
    router.push({ pathname: '/chat-conversation', params: { email, name: displayName } });
  }, [email, displayName]);

  const handleCall = useCallback(() => {
    router.push({ pathname: '/call', params: { email, name: displayName, video: 'false' } });
  }, [email, displayName]);

  const renderPost = useCallback(({ item }) => {
    const mediaUrl = item.media_urls?.[0] || item.thumbnail_url;
    if (!mediaUrl) return null;
    const fullUrl = mediaUrl.startsWith('http') ? mediaUrl : `https://chatyy.com.br${mediaUrl}`;
    return (
      <TouchableOpacity
        style={{ width: GRID_SIZE, height: GRID_SIZE, marginRight: GRID_GAP, marginBottom: GRID_GAP }}
        activeOpacity={0.8}
      >
        <Image source={{ uri: fullUrl }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
        {item.media_type === 'video' && (
          <View style={{ position: 'absolute', top: 6, right: 6 }}>
            <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700', textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 2 }}>▶</Text>
          </View>
        )}
        {(item.media_urls?.length || 0) > 1 && (
          <View style={{ position: 'absolute', top: 6, right: 6 }}>
            <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700', textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 2 }}>⊞</Text>
          </View>
        )}
      </TouchableOpacity>
    );
  }, []);

  const formatCount = (n) => {
    if (!n) return '0';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  };

  return (
    <View style={[s.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[s.header, { borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[s.headerTitle, { color: colors.text }]} numberOfLines={1}>
          {displayName}
        </Text>
        {isOwnProfile && (
          <TouchableOpacity onPress={() => router.push('/settings')} style={s.backBtn}>
            <IconSettings size={20} color={colors.text} />
          </TouchableOpacity>
        )}
        {!isOwnProfile && <View style={{ width: 40 }} />}
      </View>

      <ScrollView
        refreshControl={<RefreshControl refreshing={loading} onRefresh={loadProfile} tintColor={ACCENT} />}
        showsVerticalScrollIndicator={false}
      >
        {/* Profile Info */}
        <View style={s.profileSection}>
          <View style={s.avatarRow}>
            <View style={s.avatarWrap}>
              <AvatarCircle email={email} name={displayName} size={86} />
            </View>
            <View style={s.statsRow}>
              <View style={s.statItem}>
                <Text style={[s.statNum, { color: colors.text }]}>{formatCount(stats.posts)}</Text>
                <Text style={[s.statLabel, { color: colors.textSecondary }]}>{t('profile.posts') || 'Posts'}</Text>
              </View>
              <TouchableOpacity style={s.statItem}>
                <Text style={[s.statNum, { color: colors.text }]}>{formatCount(stats.followers)}</Text>
                <Text style={[s.statLabel, { color: colors.textSecondary }]}>{t('profile.followers') || 'Seguidores'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.statItem}>
                <Text style={[s.statNum, { color: colors.text }]}>{formatCount(stats.following)}</Text>
                <Text style={[s.statLabel, { color: colors.textSecondary }]}>{t('profile.following') || 'Seguindo'}</Text>
              </TouchableOpacity>
            </View>
          </View>

          <Text style={[s.displayName, { color: colors.text }]}>{displayName}</Text>
          {bio ? <Text style={[s.bio, { color: colors.textSecondary }]}>{bio}</Text> : null}

          {/* Action buttons */}
          <View style={s.actionRow}>
            {isOwnProfile ? (
              <TouchableOpacity style={[s.actionBtn, { backgroundColor: isDark ? '#333' : '#f0f0f0' }]} onPress={() => router.push('/profile')}>
                <Text style={[s.actionBtnText, { color: colors.text }]}>{t('profile.editProfile') || 'Editar perfil'}</Text>
              </TouchableOpacity>
            ) : (
              <>
                <TouchableOpacity
                  style={[s.actionBtn, { backgroundColor: isFollowing ? (isDark ? '#333' : '#f0f0f0') : ACCENT }]}
                  onPress={handleFollow}
                  disabled={followLoading}
                >
                  {followLoading ? (
                    <ActivityIndicator size="small" color={isFollowing ? colors.text : '#fff'} />
                  ) : (
                    <Text style={[s.actionBtnText, { color: isFollowing ? colors.text : '#fff', fontWeight: '700' }]}>
                      {isFollowing ? (t('profile.following') || 'Seguindo') : (t('profile.follow') || 'Seguir')}
                    </Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity style={[s.actionBtnSmall, { backgroundColor: isDark ? '#333' : '#f0f0f0' }]} onPress={handleMessage}>
                  <IconMessageSquare size={18} color={colors.text} />
                </TouchableOpacity>
                <TouchableOpacity style={[s.actionBtnSmall, { backgroundColor: isDark ? '#333' : '#f0f0f0' }]} onPress={handleCall}>
                  <IconPhone size={18} color={colors.text} />
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>

        {/* Tab bar */}
        <View style={[s.tabBar, { borderBottomColor: colors.border }]}>
          <TouchableOpacity style={[s.tab, tab === 'posts' && { borderBottomColor: colors.text, borderBottomWidth: 1.5 }]} onPress={() => setTab('posts')}>
            <IconGrid size={22} color={tab === 'posts' ? colors.text : colors.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity style={[s.tab, tab === 'tagged' && { borderBottomColor: colors.text, borderBottomWidth: 1.5 }]} onPress={() => setTab('tagged')}>
            <IconLock size={22} color={tab === 'tagged' ? colors.text : colors.textSecondary} />
          </TouchableOpacity>
        </View>

        {/* Posts grid */}
        {posts.length === 0 && !loading ? (
          <View style={s.emptyState}>
            <Text style={{ color: colors.textSecondary, fontSize: 14 }}>
              {isOwnProfile ? (t('feed.noPosts') || 'Nenhum post ainda') : (t('feed.noUserPosts') || 'Nenhum post')}
            </Text>
          </View>
        ) : (
          <View style={s.grid}>
            {posts.map((post, i) => (
              <React.Fragment key={post.id || i}>
                {renderPost({ item: post })}
              </React.Fragment>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  backBtn: { width: 40, alignItems: 'center', justifyContent: 'center', padding: 8 },
  headerTitle: { flex: 1, fontSize: 18, fontWeight: '700', textAlign: 'center' },
  profileSection: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12 },
  avatarRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  avatarWrap: { marginRight: 24 },
  statsRow: { flex: 1, flexDirection: 'row', justifyContent: 'space-around' },
  statItem: { alignItems: 'center' },
  statNum: { fontSize: 18, fontWeight: '700' },
  statLabel: { fontSize: 12, marginTop: 2 },
  displayName: { fontSize: 15, fontWeight: '700', marginBottom: 2 },
  bio: { fontSize: 14, lineHeight: 19, marginBottom: 8 },
  actionRow: { flexDirection: 'row', gap: 6, marginTop: 10 },
  actionBtn: { flex: 1, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  actionBtnText: { fontSize: 14, fontWeight: '600' },
  actionBtnSmall: { width: 36, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  tabBar: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, marginTop: 4 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  emptyState: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
});
