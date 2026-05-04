/**
 * ChannelView.js
 * Standalone Telegram-style channel viewer.
 * Admins can post; subscribers read-only with emoji reactions.
 * Used as a full-screen modal from ChannelsTab or any deep-link.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl,
  ActivityIndicator, TextInput, Platform, Alert, Animated, Pressable,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { IconArrowLeft, IconPlus } from './Icons';
import AvatarCircle from './AvatarCircle';
import Svg, { Path } from 'react-native-svg';
import * as api from '../services/api';

const ACCENT = '#7C3AED';

// Quick-react emoji row shown on every post
const QUICK_REACTIONS = ['\uD83D\uDC4D', '\u2764\uFE0F', '\uD83D\uDD25', '\uD83D\uDE02', '\uD83D\uDE2E', '\uD83D\uDE22', '\uD83D\uDC4F', '\uD83E\uDD14'];

// ── Inline SVG icons ─────────────────────────────────────────────────────────

function IconMegaphone({ size = 20, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M3 11l18-5v12L3 13v-2z" />
      <Path d="M11.6 16.8a3 3 0 11-5.8-1.6" />
    </Svg>
  );
}

function IconSend({ size = 20, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M22 2L11 13" />
      <Path d="M22 2L15 22l-4-9-9-4 20-7z" />
    </Svg>
  );
}

function IconShield({ size = 16, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </Svg>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(dateStr, t) {
  if (!dateStr) return '';
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 60) return t('time.now') || 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  {const _d = new Date(dateStr); return isNaN(_d.getTime()) ? "" : _d.toLocaleDateString();}
}

// ── PostCard ─────────────────────────────────────────────────────────────────

function PostCard({ item, isAdmin, colors, isDark, t, onReact, onDelete }) {
  const [showAll, setShowAll] = useState(false);
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handleReact = useCallback((emoji) => {
    Animated.sequence([
      Animated.timing(scaleAnim, { toValue: 1.2, duration: 80, useNativeDriver: true }),
      Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true }),
    ]).start();
    onReact(item.id, emoji);
  }, [item.id, onReact, scaleAnim]);

  const totalReactions = (item.reactions || []).reduce((s, r) => s + (r.cnt || 0), 0);
  const needsTruncate = (item.content || '').length > 300;

  return (
    <View style={[styles.postCard, { borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]}>
      {/* Author row */}
      <View style={styles.postAuthorRow}>
        <View style={[styles.channelBadge, { backgroundColor: ACCENT + '22' }]}>
          <IconMegaphone size={12} color={ACCENT} />
        </View>
        <Text style={[styles.postAuthorName, { color: ACCENT }]} numberOfLines={1}>
          {item.channel_name || t('channel.channel') || 'Channel'}
        </Text>
        {item.is_pinned ? (
          <View style={[styles.pinnedBadge, { backgroundColor: '#f59e0b22' }]}>
            <Text style={{ fontSize: 10, color: '#f59e0b', fontWeight: '700' }}>
              {t('channel.pinned') || 'Fixado'}
            </Text>
          </View>
        ) : null}
        <Text style={[styles.postTime, { color: isDark ? '#555' : '#bbb' }]}>
          {relativeTime(item.created_at, t)}
        </Text>
        {isAdmin && (
          <TouchableOpacity
            onPress={() => Alert.alert(
              t('channel.deletePost') || 'Delete post',
              t('channel.deletePostConfirm') || 'Are you sure?',
              [
                { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
                { text: t('common.delete') || 'Excluir', style: 'destructive', onPress: () => onDelete(item.id) },
              ]
            )}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={styles.deletePostBtn}
          >
            <Svg width={14} height={14} viewBox="0 0 24 24" fill="none"
              stroke={isDark ? '#555' : '#ccc'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <Path d="M3 6h18M19 6l-1 14H6L5 6M10 11v6M14 11v6M9 6V4h6v2" />
            </Svg>
          </TouchableOpacity>
        )}
      </View>

      {/* Content */}
      <Text style={[styles.postContent, { color: colors.text }]} numberOfLines={showAll ? undefined : (needsTruncate ? 8 : undefined)}>
        {item.content}
      </Text>
      {needsTruncate && !showAll && (
        <TouchableOpacity onPress={() => setShowAll(true)}>
          <Text style={{ color: ACCENT, fontSize: 13, marginTop: 4 }}>{t('channel.readMore') || 'Read more'}</Text>
        </TouchableOpacity>
      )}

      {/* View count */}
      {typeof item.view_count === 'number' && (
        <Text style={[styles.viewCount, { color: isDark ? '#444' : '#ccc' }]}>
          {item.view_count} {t('channel.views') || 'views'}
        </Text>
      )}

      {/* Existing reactions */}
      {(item.reactions || []).length > 0 && (
        <View style={styles.reactionsRow}>
          {item.reactions.map((r) => (
            <Animated.View key={r.emoji} style={item.my_reaction === r.emoji ? { transform: [{ scale: scaleAnim }] } : {}}>
              <TouchableOpacity
                onPress={() => handleReact(r.emoji)}
                style={[
                  styles.reactionChip,
                  {
                    backgroundColor: item.my_reaction === r.emoji
                      ? (isDark ? 'rgba(124,58,237,0.22)' : 'rgba(124,58,237,0.1)')
                      : (isDark ? '#1a1a24' : '#f3f4f6'),
                    borderColor: item.my_reaction === r.emoji ? ACCENT : 'transparent',
                  },
                ]}
              >
                <Text style={{ fontSize: 14 }}>{r.emoji}</Text>
                <Text style={{ fontSize: 12, color: colors.textSecondary || (isDark ? '#888' : '#666'), marginLeft: 4 }}>{r.cnt}</Text>
              </TouchableOpacity>
            </Animated.View>
          ))}
          {totalReactions > 0 && (
            <Text style={{ fontSize: 11, color: isDark ? '#555' : '#bbb', alignSelf: 'center', marginLeft: 4 }}>
              {totalReactions}
            </Text>
          )}
        </View>
      )}

      {/* Quick react bar */}
      <View style={styles.quickReactRow}>
        {QUICK_REACTIONS.map((emoji) => (
          <Pressable
            key={emoji}
            onPress={() => handleReact(emoji)}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : (item.my_reaction === emoji ? 1 : 0.45) })}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
          >
            <Text style={{ fontSize: 16 }}>{emoji}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

// ── Main ChannelView ──────────────────────────────────────────────────────────

/**
 * ChannelView
 *
 * Props:
 *   channel   {object}   — at minimum { id, name, description?, follower_count? }
 *   onBack    {function} — called when the user presses back
 *   colors    {object?}  — override theme colors (passed down from parent)
 *   isDark    {boolean?} — override dark flag
 *   t         {function?}— override i18n (falls back to useLanguage)
 */
export default function ChannelView({ channel, onBack, colors: propColors, isDark: propIsDark, t: propT }) {
  const { colors: themeColors, isDark: themeIsDark } = useTheme();
  const { t: langT } = useLanguage();
  const { user } = useAuth();

  const colors = propColors || themeColors;
  const isDark = propIsDark !== undefined ? propIsDark : themeIsDark;
  const t = propT || langT;

  const [posts, setPosts] = useState([]);
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [newPost, setNewPost] = useState('');
  const [posting, setPosting] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const offsetRef = useRef(0);
  const PAGE = 20;

  // ── Load (first page or refresh) ─────────────────────────────────────────
  const loadPosts = useCallback(async (isRefresh = false) => {
    try {
      const offset = isRefresh ? 0 : offsetRef.current;
      const [feedRes, infoRes] = await Promise.all([
        api.channelFeed(channel.id, PAGE, offset),
        isRefresh || !info ? api.channelInfo(channel.id) : Promise.resolve(null),
      ]);

      if (feedRes?.data?.success) {
        const fetched = feedRes.data.data?.posts || [];
        if (isRefresh) {
          setPosts(fetched);
          offsetRef.current = fetched.length;
        } else {
          setPosts(prev => [...prev, ...fetched]);
          offsetRef.current = offset + fetched.length;
        }
        setHasMore(fetched.length === PAGE);
      }
      if (infoRes?.data?.success) {
        setInfo(infoRes.data.data || null);
      }
    } catch (e) {
      // silently ignore network errors
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
    }
  }, [channel.id, info]);

  useEffect(() => {
    setLoading(true);
    offsetRef.current = 0;
    loadPosts(true);
  }, [channel.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    offsetRef.current = 0;
    loadPosts(true);
  }, [loadPosts]);

  const onEndReached = useCallback(() => {
    if (!loadingMore && hasMore && !loading) {
      setLoadingMore(true);
      loadPosts(false);
    }
  }, [loadingMore, hasMore, loading, loadPosts]);

  // ── Follow / Unfollow ─────────────────────────────────────────────────────
  const handleFollowToggle = useCallback(async () => {
    if (!info) return;
    try {
      if (info.is_member) {
        await api.channelUnfollow(channel.id);
      } else {
        await api.channelFollow(channel.id);
      }
      // Refresh info
      const res = await api.channelInfo(channel.id);
      if (res?.data?.success) setInfo(res.data.data || null);
    } catch {}
  }, [channel.id, info]);

  // ── Admin post ────────────────────────────────────────────────────────────
  const handlePost = useCallback(async () => {
    if (!newPost.trim() || posting) return;
    setPosting(true);
    try {
      const res = await api.channelPost(channel.id, newPost.trim());
      if (res?.data?.success) {
        setNewPost('');
        offsetRef.current = 0;
        loadPosts(true);
      } else {
        Alert.alert(t('common.error') || 'Erro', res?.data?.message || (t('channel.postFailed') || 'Não foi possível publicar'));
      }
    } catch {
      Alert.alert(t('common.error') || 'Erro', t('channel.postFailed') || 'Não foi possível publicar');
    } finally {
      setPosting(false);
    }
  }, [newPost, posting, channel.id, loadPosts, t]);

  // ── React ─────────────────────────────────────────────────────────────────
  const handleReact = useCallback(async (postId, emoji) => {
    // Optimistic toggle
    setPosts(prev => prev.map(p => {
      if (p.id !== postId) return p;
      const alreadyMine = p.my_reaction === emoji;
      const reactions = (p.reactions || []).map(r => {
        if (r.emoji !== emoji) return r;
        return { ...r, cnt: Math.max(0, (r.cnt || 0) + (alreadyMine ? -1 : 1)) };
      });
      // Add new emoji to reactions list if not present
      if (!reactions.find(r => r.emoji === emoji)) {
        reactions.push({ emoji, cnt: 1 });
      }
      return { ...p, my_reaction: alreadyMine ? null : emoji, reactions };
    }));
    try {
      await api.channelReact(postId, emoji);
    } catch {
      // On error, revert by reloading
      loadPosts(true);
    }
  }, [loadPosts]);

  // ── Delete post ───────────────────────────────────────────────────────────
  const handleDeletePost = useCallback(async (postId) => {
    try {
      await api.channelDeletePost(postId);
      setPosts(prev => prev.filter(p => p.id !== postId));
    } catch {
      Alert.alert(t('common.error') || 'Erro', t('channel.deleteFailed') || 'Não foi possível excluir a publicação');
    }
  }, [t]);

  const isAdmin = info?.is_admin || false;
  const isMember = info?.is_member ?? channel.is_member ?? false;
  const subscriberCount = info?.subscriber_count ?? channel.follower_count ?? 0;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <View style={[styles.container, { backgroundColor: isDark ? '#0a0a0f' : '#f5f5f7' }]}>

      {/* ── Header ── */}
      <View style={[styles.header, {
        backgroundColor: isDark ? '#0a0a0f' : '#fff',
        borderBottomColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)',
      }]}>
        <TouchableOpacity
          onPress={onBack}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          style={styles.backBtn}
          accessibilityLabel={t('common.back') || 'Voltar'}
          accessibilityRole="button"
        >
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>

        <View style={[styles.headerAvatar, { backgroundColor: isDark ? '#1a1a24' : '#ede9fe' }]}>
          <IconMegaphone size={22} color={ACCENT} />
        </View>

        <View style={styles.headerInfo}>
          <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
            {channel.name}
          </Text>
          <View style={styles.headerMeta}>
            <Text style={[styles.headerSubs, { color: isDark ? '#777' : '#9ca3af' }]}>
              {subscriberCount.toLocaleString()} {t('channel.followers') || 'seguidores'}
            </Text>
            {isAdmin && (
              <View style={styles.adminBadge}>
                <IconShield size={10} color="#fff" />
                <Text style={styles.adminBadgeText}>{t('community.admin') || 'Admin'}</Text>
              </View>
            )}
          </View>
        </View>

        {/* Follow / Unfollow button */}
        <TouchableOpacity
          onPress={handleFollowToggle}
          style={[
            styles.followBtn,
            { backgroundColor: isMember ? (isDark ? '#1a1a24' : '#f3f4f6') : ACCENT },
          ]}
          accessibilityLabel={isMember ? (t('channel.joined') || 'Inscrito') : (t('channel.join') || 'Inscrever')}
          accessibilityRole="button"
        >
          <Text style={{ color: isMember ? (isDark ? '#aaa' : '#555') : '#fff', fontSize: 13, fontWeight: '700' }}>
            {isMember ? (t('channel.joined') || 'Inscrito') : (t('channel.join') || 'Inscrever')}
          </Text>
        </TouchableOpacity>
      </View>

      {/* ── Description banner ── */}
      {channel.description ? (
        <View style={[styles.descBanner, { backgroundColor: isDark ? 'rgba(124,58,237,0.08)' : 'rgba(124,58,237,0.04)', borderBottomColor: isDark ? 'rgba(124,58,237,0.15)' : 'rgba(124,58,237,0.1)' }]}>
          <Text style={{ color: isDark ? '#a78bfa' : '#6d28d9', fontSize: 13, lineHeight: 18 }}>
            {channel.description}
          </Text>
        </View>
      ) : null}

      {/* ── Posts ── */}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={ACCENT} />
        </View>
      ) : (
        <FlatList
          data={posts}
          keyExtractor={(item) => String(item.id)}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ACCENT} colors={[ACCENT]} />}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.3}
          contentContainerStyle={posts.length === 0 ? styles.emptyContainer : { paddingBottom: isAdmin ? 80 : 20 }}
          ListEmptyComponent={(
            <View style={styles.emptyInner}>
              <IconMegaphone size={52} color={isDark ? '#333' : '#ddd'} />
              <Text style={[styles.emptyTitle, { color: colors.text }]}>
                {t('channel.noPosts') || 'No posts yet'}
              </Text>
              {isAdmin && (
                <Text style={[styles.emptySubtitle, { color: isDark ? '#666' : '#999' }]}>
                  {t('channel.firstPost') || 'Write your first post below'}
                </Text>
              )}
            </View>
          )}
          ListFooterComponent={loadingMore ? (
            <ActivityIndicator size="small" color={ACCENT} style={{ marginVertical: 16 }} />
          ) : null}
          renderItem={({ item }) => (
            <PostCard
              item={{ ...item, channel_name: channel.name }}
              isAdmin={isAdmin}
              colors={colors}
              isDark={isDark}
              t={t}
              onReact={handleReact}
              onDelete={handleDeletePost}
            />
          )}
        />
      )}

      {/* ── Admin compose bar ── */}
      {isAdmin && (
        <View style={[styles.composeBar, {
          backgroundColor: isDark ? '#0a0a0f' : '#fff',
          borderTopColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)',
        }]}>
          <TextInput
            value={newPost}
            onChangeText={setNewPost}
            placeholder={t('channel.writeSomething') || 'Write something...'}
            placeholderTextColor={isDark ? '#555' : '#9ca3af'}
            style={[styles.composeInput, {
              color: colors.text,
              backgroundColor: isDark ? '#1a1a24' : '#f3f4f6',
            }]}
            multiline
            maxLength={5000}
            accessibilityLabel={t('channel.writeSomething') || 'Write something'}
          />
          <TouchableOpacity
            onPress={handlePost}
            disabled={!newPost.trim() || posting}
            style={[styles.sendBtn, { opacity: newPost.trim() && !posting ? 1 : 0.4 }]}
            accessibilityLabel={t('channel.post') || 'Post'}
            accessibilityRole="button"
          >
            {posting ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <IconSend size={18} color="#fff" />
            )}
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    gap: 10,
  },
  backBtn: {
    padding: 2,
  },
  headerAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerInfo: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  headerMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 1,
  },
  headerSubs: {
    fontSize: 12,
  },
  adminBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: ACCENT,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  adminBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
  followBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
  },

  // Description banner
  descBanner: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },

  // Post card
  postCard: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  postAuthorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
  },
  channelBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    justifyContent: 'center',
    alignItems: 'center',
  },
  postAuthorName: {
    fontSize: 13,
    fontWeight: '700',
    flex: 1,
  },
  pinnedBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  postTime: {
    fontSize: 11,
  },
  deletePostBtn: {
    padding: 4,
  },
  postContent: {
    fontSize: 15,
    lineHeight: 22,
  },
  viewCount: {
    fontSize: 11,
    marginTop: 6,
  },
  reactionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 10,
    gap: 6,
    alignItems: 'center',
  },
  reactionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
  },
  quickReactRow: {
    flexDirection: 'row',
    gap: 14,
    marginTop: 10,
  },

  // Compose bar
  composeBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 10,
    borderTopWidth: 1,
    gap: 8,
    ...Platform.select({
      web: {},
      default: { paddingBottom: 16 },
    }),
  },
  composeInput: {
    flex: 1,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 14,
    maxHeight: 120,
    ...Platform.select({
      web: { outlineStyle: 'none' },
      default: {},
    }),
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: ACCENT,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Empty state
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyInner: {
    marginTop: 80,
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '600',
    marginTop: 16,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: 13,
    marginTop: 8,
    textAlign: 'center',
  },
});
