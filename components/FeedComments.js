import React, { useState, useEffect, useCallback, useRef, memo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, FlatList,
  TextInput, KeyboardAvoidingView, Platform, ActivityIndicator,
  Animated, Dimensions, Pressable,
} from 'react-native';
import AvatarCircle from './AvatarCircle';
import { IconX, IconSend, IconTrash, IconHeart, IconHeartOutline } from './Icons';
import * as api from '../services/api';

const ACCENT = '#25D366';
const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const SHEET_HEIGHT = Math.min(SCREEN_HEIGHT * 0.75, 700);

function timeAgo(dateStr, t) {
  if (!dateStr) return '';
  const str = dateStr.endsWith('Z') || dateStr.includes('+') ? dateStr : dateStr + 'Z';
  const now = Date.now();
  const then = new Date(str).getTime();
  const diffMs = now - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return t?.('time.now') || 'now';
  if (mins < 60) return (t?.('time.min') || '{n}m').replace('{n}', mins);
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return (t?.('time.hours') || '{n}h').replace('{n}', hrs);
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  return new Date(str).toLocaleDateString();
}

// Swipeable comment row
const CommentItem = memo(function CommentItem({
  item, user, colors, isDark, t, onReply, onDelete, replyParent,
}) {
  const isOwner = item.author_email === user?.email || item.email === user?.email;
  const authorName = item.author_name || item.name || item.email?.split('@')[0] || item.author_email?.split('@')[0] || '?';
  const authorEmail = item.author_email || item.email;
  const isWeb = Platform.OS === 'web';

  const [deleteVisible, setDeleteVisible] = useState(false);
  const fadeAnim = useRef(new Animated.Value(1)).current;

  const handleLongPress = useCallback(() => {
    if (isOwner) setDeleteVisible(true);
  }, [isOwner]);

  const handleDelete = useCallback(() => {
    Animated.timing(fadeAnim, {
      toValue: 0,
      duration: 250,
      useNativeDriver: false,
    }).start(() => {
      onDelete?.(item.id);
    });
  }, [fadeAnim, item.id, onDelete]);

  return (
    <Animated.View style={{ opacity: fadeAnim }}>
      <Pressable
        onLongPress={handleLongPress}
        delayLongPress={500}
        style={[
          styles.commentRow,
          !!item.reply_to_id && styles.commentReplyIndent,
        ]}
      >
        <AvatarCircle email={authorEmail} name={authorName} size={32} />
        <View style={styles.commentBody}>
          <View style={styles.commentBubble}>
            <Text style={[styles.commentText, { color: colors.text }]}>
              <Text style={styles.commentAuthor}>{authorName}</Text>
              {'  '}{item.content}
            </Text>
          </View>
          {/* Reply-to indicator */}
          {replyParent && (
            <Text style={[styles.replyToLabel, { color: colors.textTertiary }]} numberOfLines={1}>
              @{replyParent.author_name || replyParent.name || replyParent.author_email?.split('@')[0] || '?'}
            </Text>
          )}
          <View style={styles.commentMeta}>
            <Text style={[styles.commentTime, { color: colors.textTertiary }]}>
              {timeAgo(item.created_at, t)}
            </Text>
            <TouchableOpacity
              onPress={() => onReply?.(item)}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              accessibilityLabel={t('feed.reply') || 'Reply'}
              accessibilityRole="button"
            >
              <Text style={[styles.commentMetaBtn, { color: colors.textSecondary }]}>
                {t('feed.reply') || 'Reply'}
              </Text>
            </TouchableOpacity>
            {isOwner && !deleteVisible && (
              <TouchableOpacity
                onPress={() => setDeleteVisible(true)}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                accessibilityLabel={t('feed.deleteComment') || 'Delete'}
                accessibilityRole="button"
              >
                <IconTrash size={13} color={colors.textTertiary} />
              </TouchableOpacity>
            )}
          </View>
          {/* Inline delete confirmation */}
          {deleteVisible && (
            <View style={styles.deleteConfirmRow}>
              <TouchableOpacity
                onPress={handleDelete}
                style={[styles.deleteConfirmBtn, { backgroundColor: '#ef4444' }]}
                accessibilityLabel={t('feed.delete') || 'Delete'}
                accessibilityRole="button"
              >
                <Text style={styles.deleteConfirmText}>
                  {t('feed.delete') || 'Delete'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setDeleteVisible(false)}
                style={[styles.deleteConfirmBtn, {
                  backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
                }]}
                accessibilityLabel={t('common.cancel') || 'Cancel'}
                accessibilityRole="button"
              >
                <Text style={[styles.deleteConfirmCancelText, { color: colors.textSecondary }]}>
                  {t('common.cancel') || 'Cancel'}
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </Pressable>
    </Animated.View>
  );
});

export default function FeedComments({ visible, post, colors, isDark, t, user, onClose, onCommentCountChange }) {
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const currentCountRef = useRef(0);
  const slideAnim = useRef(new Animated.Value(0)).current;
  const isWeb = Platform.OS === 'web';

  useEffect(() => {
    if (post) {
      currentCountRef.current = Number(post.comment_count) || 0;
    }
  }, [post?.id, post?.comment_count]);

  const loadComments = useCallback(async (pageNum = 1) => {
    if (!post?.id) return;
    if (pageNum > 1) setLoadingMore(true);
    try {
      const r = await api.feedComments(post.id, pageNum);
      if (r.success && r.data) {
        const newComments = r.data.comments || r.data || [];
        if (pageNum === 1) {
          setComments(newComments);
        } else {
          setComments(prev => {
            const existingIds = new Set(prev.map(c => c.id));
            const unique = newComments.filter(c => !existingIds.has(c.id));
            return [...prev, ...unique];
          });
        }
        setHasMore(newComments.length >= 20);
      }
    } catch {} finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [post?.id]);

  useEffect(() => {
    if (visible && post?.id) {
      setLoading(true);
      setPage(1);
      setReplyTo(null);
      setText('');
      loadComments(1);
    }
  }, [visible, post?.id, loadComments]);

  const loadMore = useCallback(() => {
    if (hasMore && !loading && !loadingMore) {
      const nextPage = page + 1;
      setPage(nextPage);
      loadComments(nextPage);
    }
  }, [hasMore, loading, loadingMore, page, loadComments]);

  const handleSend = useCallback(async () => {
    const content = text.trim();
    if (!content || sending || !post?.id) return;
    setSending(true);
    try {
      const r = await api.feedComment(post.id, content, replyTo?.id);
      if (r.success) {
        const newComment = r.data?.comment || {
          id: Date.now(),
          author_email: user?.email,
          email: user?.email,
          author_name: user?.name || user?.email?.split('@')[0],
          name: user?.name || user?.email?.split('@')[0],
          content,
          created_at: new Date().toISOString(),
          reply_to_id: replyTo?.id,
        };
        setComments(prev => [newComment, ...prev]);
        setText('');
        setReplyTo(null);
        currentCountRef.current += 1;
        onCommentCountChange?.(currentCountRef.current);
        // Scroll to top to show new comment
        setTimeout(() => {
          listRef.current?.scrollToOffset?.({ offset: 0, animated: true });
        }, 100);
      }
    } catch {} finally {
      setSending(false);
    }
  }, [text, sending, post, replyTo, user, onCommentCountChange]);

  const handleDelete = useCallback(async (commentId) => {
    try {
      const r = await api.feedDeleteComment(commentId);
      if (r.success) {
        setComments(prev => prev.filter(c => c.id !== commentId));
        currentCountRef.current = Math.max(0, currentCountRef.current - 1);
        onCommentCountChange?.(currentCountRef.current);
      }
    } catch {}
  }, [onCommentCountChange]);

  const handleReply = useCallback((comment) => {
    setReplyTo(comment);
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  // Build a lookup map for reply parents
  const commentMap = {};
  for (const c of comments) {
    commentMap[c.id] = c;
  }

  const renderComment = useCallback(({ item }) => {
    const replyParent = item.reply_to_id ? commentMap[item.reply_to_id] : null;
    return (
      <CommentItem
        item={item}
        user={user}
        colors={colors}
        isDark={isDark}
        t={t}
        onReply={handleReply}
        onDelete={handleDelete}
        replyParent={replyParent}
      />
    );
  }, [colors, isDark, t, user, handleReply, handleDelete, commentMap]);

  const captionAuthor = post?.author_name || post?.author_email?.split('@')[0] || '?';

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Backdrop */}
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityLabel={t('common.close') || 'Close'}
          accessibilityRole="button"
        />

        {/* Sheet */}
        <View style={[styles.sheet, {
          backgroundColor: isDark ? '#0f172a' : '#ffffff',
          maxHeight: SHEET_HEIGHT,
          ...(isWeb ? { boxShadow: '0 -4px 30px rgba(0,0,0,0.12)' } : {}),
        }]}>
          {/* Handle bar */}
          <View style={styles.handleRow}>
            <View style={[styles.handle, {
              backgroundColor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.12)',
            }]} />
          </View>

          {/* Title */}
          <View style={[styles.titleRow, {
            borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
          }]}>
            <Text style={[styles.title, { color: colors.text }]}>
              {t('feed.comments') || 'Comments'}
            </Text>
            <TouchableOpacity
              onPress={onClose}
              style={styles.closeBtn}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityLabel={t('common.close') || 'Close'}
              accessibilityRole="button"
            >
              <IconX size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {/* Comments list */}
          {loading ? (
            <View style={styles.loadingWrap}>
              <ActivityIndicator size="large" color={ACCENT} />
            </View>
          ) : (
            <FlatList
              ref={listRef}
              data={comments}
              renderItem={renderComment}
              keyExtractor={(item) => String(item.id)}
              contentContainerStyle={[
                styles.listContent,
                comments.length === 0 && styles.listContentEmpty,
              ]}
              onEndReached={loadMore}
              onEndReachedThreshold={0.3}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
              ListHeaderComponent={
                // Post caption at top
                post?.caption ? (
                  <View style={[styles.captionHeader, {
                    borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                  }]}>
                    <AvatarCircle email={post.author_email} name={post.author_name} size={32} />
                    <View style={styles.captionHeaderBody}>
                      <Text style={[styles.captionHeaderText, { color: colors.text }]}>
                        <Text style={styles.captionHeaderAuthor}>{captionAuthor}</Text>
                        {'  '}{post.caption}
                      </Text>
                      <Text style={[styles.captionHeaderTime, { color: colors.textTertiary }]}>
                        {timeAgo(post.created_at, t)}
                      </Text>
                    </View>
                  </View>
                ) : null
              }
              ListFooterComponent={
                loadingMore ? (
                  <View style={styles.loadingMore}>
                    <ActivityIndicator size="small" color={ACCENT} />
                  </View>
                ) : null
              }
              ListEmptyComponent={
                <View style={styles.emptyWrap}>
                  <Text style={{ fontSize: 48, marginBottom: 12 }}>💬</Text>
                  <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
                    {t('feed.noComments') || 'No comments yet'}
                  </Text>
                  <Text style={[styles.emptySubtext, { color: colors.textTertiary }]}>
                    {t('feed.beFirst') || 'Be the first to comment'}
                  </Text>
                </View>
              }
            />
          )}

          {/* Reply indicator */}
          {replyTo && (
            <View style={[styles.replyBar, {
              backgroundColor: isDark ? 'rgba(37,211,102,0.08)' : 'rgba(37,211,102,0.06)',
              borderTopColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
            }]}>
              <View style={[styles.replyAccent, { backgroundColor: ACCENT }]} />
              <Text style={[styles.replyText, { color: colors.textSecondary }]} numberOfLines={1}>
                {(t('feed.replyingTo') || 'Replying to @{name}')
                  .replace('{name}', replyTo.author_name || replyTo.name || replyTo.author_email?.split('@')[0] || replyTo.email?.split('@')[0] || '?')}
              </Text>
              <TouchableOpacity
                onPress={() => setReplyTo(null)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityLabel={t('feed.cancelReply') || 'Cancel reply'}
                accessibilityRole="button"
              >
                <IconX size={16} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
          )}

          {/* Input */}
          <View style={[styles.inputRow, {
            borderTopColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
            backgroundColor: isDark ? '#0f172a' : '#fafafa',
            paddingBottom: Platform.OS === 'ios' ? 28 : 10,
          }]}>
            <AvatarCircle email={user?.email} name={user?.name} size={32} />
            <View style={[styles.inputWrapper, {
              backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
              borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
            }]}>
              <TextInput
                ref={inputRef}
                style={[styles.input, {
                  color: colors.text,
                }]}
                placeholder={
                  replyTo
                    ? (t('feed.replyPlaceholder') || 'Reply...')
                    : (t('feed.writeComment') || 'Add a comment...')
                }
                placeholderTextColor={colors.textTertiary}
                value={text}
                onChangeText={setText}
                multiline
                maxLength={500}
                accessibilityLabel={t('feed.writeComment') || 'Add a comment'}
              />
              <TouchableOpacity
                onPress={handleSend}
                disabled={!text.trim() || sending}
                style={[styles.sendBtn, {
                  opacity: text.trim() && !sending ? 1 : 0.3,
                }]}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                accessibilityLabel={t('feed.send') || 'Send'}
                accessibilityRole="button"
              >
                {sending ? (
                  <ActivityIndicator size="small" color={ACCENT} />
                ) : (
                  <IconSend size={20} color={ACCENT} />
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    minHeight: 320,
    overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.15, shadowRadius: 16 },
      android: { elevation: 16 },
      default: {},
    }),
  },
  handleRow: {
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: 2,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    position: 'relative',
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  closeBtn: {
    position: 'absolute',
    right: 16,
    padding: 4,
  },
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
  },
  listContent: {
    paddingHorizontal: 14,
    paddingBottom: 8,
  },
  listContentEmpty: {
    flex: 1,
    justifyContent: 'center',
  },
  // Caption header
  captionHeader: {
    flexDirection: 'row',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    marginBottom: 4,
    alignItems: 'flex-start',
  },
  captionHeaderBody: {
    flex: 1,
    marginLeft: 10,
  },
  captionHeaderText: {
    fontSize: 14,
    lineHeight: 20,
  },
  captionHeaderAuthor: {
    fontWeight: '600',
  },
  captionHeaderTime: {
    fontSize: 12,
    marginTop: 4,
  },
  emptyWrap: {
    alignItems: 'center',
    paddingVertical: 48,
  },
  emptyText: {
    fontSize: 16,
    fontWeight: '600',
  },
  emptySubtext: {
    fontSize: 14,
    marginTop: 4,
  },
  loadingMore: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  // Comment row
  commentRow: {
    flexDirection: 'row',
    paddingVertical: 10,
    alignItems: 'flex-start',
  },
  commentReplyIndent: {
    paddingLeft: 42,
  },
  commentBody: {
    flex: 1,
    marginLeft: 10,
  },
  commentBubble: {
    // no background - Instagram-style inline text
  },
  commentText: {
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: -0.1,
  },
  commentAuthor: {
    fontWeight: '600',
  },
  replyToLabel: {
    fontSize: 11,
    marginTop: 2,
  },
  commentMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    marginTop: 5,
  },
  commentTime: {
    fontSize: 12,
  },
  commentMetaBtn: {
    fontSize: 12,
    fontWeight: '600',
  },
  deleteConfirmRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
  },
  deleteConfirmBtn: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 6,
  },
  deleteConfirmText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  deleteConfirmCancelText: {
    fontSize: 12,
    fontWeight: '600',
  },
  // Reply bar
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  replyAccent: {
    width: 3,
    height: 20,
    borderRadius: 1.5,
    marginRight: 10,
  },
  replyText: {
    fontSize: 13,
    flex: 1,
    marginRight: 8,
    fontWeight: '500',
  },
  // Input
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  inputWrapper: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderRadius: 22,
    borderWidth: 1,
    paddingLeft: 14,
    paddingRight: 4,
    minHeight: 40,
  },
  input: {
    flex: 1,
    fontSize: 14,
    paddingVertical: Platform.OS === 'ios' ? 10 : 8,
    maxHeight: 80,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  sendBtn: {
    padding: 8,
  },
});
