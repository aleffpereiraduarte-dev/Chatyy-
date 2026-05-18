import React, { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';
import {
  View, FlatList, Text, TouchableOpacity, StyleSheet, Modal,
  TextInput, KeyboardAvoidingView, Platform, ActivityIndicator,
  Animated, Dimensions, Pressable,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
// FlashList reverted to FlatList
import AvatarCircle from './AvatarCircle';
import { IconX, IconSend, IconTrash, IconHeart, IconHeartOutline, IconMic, IconPlay, IconPause, IconMessageCircle, IconImage, IconVideo } from './Icons';
import ModalHeader from './ModalHeader';
import * as api from '../services/api';

const ACCENT = '#7C3AED';
const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const SHEET_HEIGHT = Math.min(SCREEN_HEIGHT * 0.75, 700);

function timeAgo(dateStr, t) {
  if (!dateStr) return '';
  const str = dateStr.endsWith('Z') || dateStr.includes('+') ? dateStr : dateStr + 'Z';
  const now = Date.now();
  const then = new Date(str).getTime();
  if (!Number.isFinite(then)) return '';
  const diffMs = now - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return t?.('time.now') || 'now';
  if (mins < 60) return (t?.('time.min') || '{n}m').replace('{n}', mins);
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return (t?.('time.hours') || '{n}h').replace('{n}', hrs);
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  return (_d=>isNaN(_d.getTime())?'':_d.toLocaleDateString())(new Date(str));
}

// Swipeable comment row
const CommentItem = memo(function CommentItem({
  item, user, colors, isDark, t, onReply, onDelete, replyParent, onToggleLike,
}) {
  const isOwner = item.author_email === user?.email || item.email === user?.email;
  const authorName = item.author_name || item.name || item.email?.split('@')[0] || item.author_email?.split('@')[0] || '?';
  const authorEmail = item.author_email || item.email;
  const isWeb = Platform.OS === 'web';

  const [deleteVisible, setDeleteVisible] = useState(false);
  const fadeAnim = useRef(new Animated.Value(1)).current;
  // Local optimistic state — heart should react instantly even though the
  // PG round-trip lags by a couple hundred ms.
  const [liked, setLiked] = useState(!!item.liked_by_me);
  const [likesCount, setLikesCount] = useState(Number(item.likes_count) || 0);
  useEffect(() => {
    setLiked(!!item.liked_by_me);
    setLikesCount(Number(item.likes_count) || 0);
  }, [item.liked_by_me, item.likes_count]);

  const handleLike = useCallback(() => {
    const next = !liked;
    setLiked(next);
    setLikesCount(c => Math.max(0, c + (next ? 1 : -1)));
    onToggleLike?.(item, next).catch(() => {
      // Roll back on failure so the chip doesn't lie about server state.
      setLiked(!next);
      setLikesCount(c => Math.max(0, c + (next ? -1 : 1)));
    });
  }, [liked, item, onToggleLike]);

  const handleLongPress = useCallback(() => {
    if (isOwner) setDeleteVisible(true);
  }, [isOwner]);

  const handleDelete = useCallback(() => {
    Animated.timing(fadeAnim, {
      toValue: 0,
      duration: 250,
      useNativeDriver: true,
    }).start(() => {
      onDelete?.(item.id);
    });
  }, [fadeAnim, item.id, onDelete]);

  // Voice comments render as a play button + duration pill instead of text.
  // We render via a tiny Audio element on web; native uses expo-audio
  // (loaded lazily so the module isn't pulled into web bundles).
  const audioUrl = item.audio_url ? (
    String(item.audio_url).startsWith('http')
      ? item.audio_url
      : 'https://chatyy.com.br' + (String(item.audio_url).startsWith('/') ? '' : '/') + item.audio_url
  ) : '';
  // Reels P1 — sticker / GIF / video reply media. Backend stores it on
  // chat_feed_comments.media_url (legacy alias attachment_url). Whichever
  // arrives first wins.
  const mediaUrl = item.media_url || item.attachment_url || '';
  const mediaType = String(item.media_type || '').toLowerCase();
  const isStickerComment = !!mediaUrl && (mediaType === 'sticker' || mediaType === 'gif' || mediaType === 'image');
  const isVideoComment   = !!mediaUrl && mediaType === 'video';
  const [voicePlaying, setVoicePlaying] = useState(false);
  const voiceRef = useRef(null);
  const toggleVoice = useCallback(async () => {
    if (!audioUrl) return;
    if (Platform.OS === 'web') {
      try {
        if (!voiceRef.current) {
          voiceRef.current = new Audio(audioUrl);
          voiceRef.current.onended = () => setVoicePlaying(false);
        }
        if (voicePlaying) { voiceRef.current.pause(); setVoicePlaying(false); }
        else { await voiceRef.current.play(); setVoicePlaying(true); }
      } catch {}
      return;
    }
    try {
      const { AudioModule } = require('expo-audio');
      if (!voiceRef.current) {
        voiceRef.current = await AudioModule.createAudioPlayer({ uri: audioUrl });
        voiceRef.current.addListener?.('playbackStatusUpdate', (s) => {
          if (s?.didJustFinish) setVoicePlaying(false);
        });
      }
      if (voicePlaying) { voiceRef.current.pause(); setVoicePlaying(false); }
      else { voiceRef.current.play(); setVoicePlaying(true); }
    } catch {}
  }, [audioUrl, voicePlaying]);
  useEffect(() => () => {
    try { voiceRef.current?.pause?.(); } catch {}
    try { voiceRef.current?.remove?.(); } catch {}
  }, []);

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
        {/* Replies render with a thinner avatar (24px vs 32px) so the
            sub-thread reads as a visual nest rather than another root row. */}
        <AvatarCircle email={authorEmail} name={authorName} size={item.reply_to_id ? 24 : 32} />
        <View style={styles.commentBody}>
          <View style={styles.commentBubble}>
            {audioUrl ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={[styles.commentAuthor, { color: colors.text }]}>{authorName}</Text>
                <Pressable
                  onPress={toggleVoice}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 6,
                    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 18,
                    backgroundColor: 'rgba(124,58,237,0.12)',
                  }}
                  accessibilityLabel={t?.('feed.voiceComment') || 'Voice comment'}
                  accessibilityRole="button"
                >
                  {voicePlaying
                    ? <IconPause size={14} color="#7C3AED" />
                    : <IconPlay size={14} color="#7C3AED" />}
                  <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 14 }}>
                    {[5,9,7,11,6,10,8,12,7,9,5].map((h, i) => (
                      <View key={i} style={{ width: 2, height: h, borderRadius: 1, backgroundColor: '#7C3AED', opacity: 0.6 }} />
                    ))}
                  </View>
                </Pressable>
              </View>
            ) : isStickerComment ? (
              <View>
                <Text style={[styles.commentAuthor, { color: colors.text, marginBottom: 4 }]}>{authorName}</Text>
                {Platform.OS === 'web' ? (
                  // eslint-disable-next-line jsx-a11y/alt-text
                  <img src={mediaUrl} style={{ maxWidth: 160, maxHeight: 160, borderRadius: 10 }} />
                ) : (() => {
                  const RNImage = require('react-native').Image;
                  return <RNImage source={{ uri: mediaUrl }} style={{ width: 140, height: 140, borderRadius: 10 }} resizeMode="cover" />;
                })()}
              </View>
            ) : isVideoComment ? (
              <View>
                <Text style={[styles.commentAuthor, { color: colors.text, marginBottom: 4 }]}>{authorName}</Text>
                {Platform.OS === 'web' ? (
                  <video src={mediaUrl} controls playsInline style={{ maxWidth: 200, borderRadius: 10, backgroundColor: '#000' }} />
                ) : (
                  <Pressable
                    onPress={() => {
                      // Best-effort fullscreen open via WebBrowser. If
                      // expo-web-browser isn't available we fall back to
                      // Linking.openURL.
                      try { require('expo-web-browser').openBrowserAsync(mediaUrl); }
                      catch { try { require('react-native').Linking.openURL(mediaUrl); } catch {} }
                    }}
                    style={{ width: 160, height: 160, borderRadius: 10, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }}
                    accessibilityRole="button"
                    accessibilityLabel={t?.('feed.playVideo') || 'Play video'}
                  >
                    <IconPlay size={32} color="#fff" />
                  </Pressable>
                )}
              </View>
            ) : (
              <Text style={[styles.commentText, { color: colors.text }]}>
                <Text style={styles.commentAuthor}>{authorName}</Text>
                {'  '}{item.content}
              </Text>
            )}
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
              accessibilityLabel={t('feed.reply') || 'Responder'}
              accessibilityRole="button"
            >
              <Text style={[styles.commentMetaBtn, { color: colors.textSecondary }]}>
                {t('feed.reply') || 'Responder'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleLike}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}
              accessibilityLabel={liked ? 'Descurtir' : 'Curtir'}
              accessibilityRole="button"
            >
              {liked
                ? <IconHeart size={13} color="#ef4444" />
                : <IconHeartOutline size={13} color={colors.textTertiary} />}
              {likesCount > 0 && (
                <Text style={[styles.commentMetaBtn, { color: liked ? '#ef4444' : colors.textTertiary, fontSize: 11 }]}>
                  {likesCount}
                </Text>
              )}
            </TouchableOpacity>
            {isOwner && !deleteVisible && (
              <TouchableOpacity
                onPress={() => setDeleteVisible(true)}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                accessibilityLabel={t('feed.deleteComment') || 'Excluir'}
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
                accessibilityLabel={t('feed.delete') || 'Excluir'}
                accessibilityRole="button"
              >
                <Text style={styles.deleteConfirmText}>
                  {t('feed.delete') || 'Excluir'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setDeleteVisible(false)}
                style={[styles.deleteConfirmBtn, {
                  backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
                }]}
                accessibilityLabel={t('common.cancel') || 'Cancelar'}
                accessibilityRole="button"
              >
                <Text style={[styles.deleteConfirmCancelText, { color: colors.textSecondary }]}>
                  {t('common.cancel') || 'Cancelar'}
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </Pressable>
    </Animated.View>
  );
});

// ── Mic record button with pulse halo ──
// While `recording` is true we layer a softly-pulsing red ring behind the
// mic button so the user gets a clear "I'm recording" affordance without
// needing extra screen real estate. The halo unmounts when recording ends.
const MicRecordButton = memo(function MicRecordButton({ recording, sending, onPressIn, onPressOut, t }) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!recording) {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 700, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [recording, pulse]);
  const haloScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.6] });
  const haloOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] });
  return (
    <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
      {recording ? (
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            width: 32,
            height: 32,
            borderRadius: 16,
            backgroundColor: 'rgba(239,68,68,0.45)',
            opacity: haloOpacity,
            transform: [{ scale: haloScale }],
          }}
        />
      ) : null}
      <Pressable
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        disabled={sending}
        style={[styles.sendBtn, {
          opacity: sending ? 0.4 : 1,
          backgroundColor: recording ? '#ef4444' : 'transparent',
          borderRadius: 16,
          paddingHorizontal: recording ? 6 : 0,
        }]}
        hitSlop={{ top: 14, bottom: 14, left: 10, right: 10 }}
        accessibilityLabel={t('feed.voiceComment') || 'Voice comment'}
        accessibilityRole="button"
        accessibilityHint={t('feed.recordingTip') || 'Hold to record'}
      >
        {sending
          ? <ActivityIndicator size="small" color={ACCENT} />
          : <IconMic size={20} color={recording ? '#fff' : ACCENT} />}
      </Pressable>
    </View>
  );
});

export default function FeedComments({ visible, post, colors, isDark, t, user, onClose, onCommentCountChange }) {
  const insets = useSafeAreaInsets();
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
  // Voice comment (Instagram-parity). Tap-and-hold to record, release to
  // upload. Reuses the existing voice plumbing — same blob shape that
  // chatUploadFile uses, sent via feedVoiceComment endpoint.
  const [recording, setRecording] = useState(false);
  const recRef = useRef(null);
  const recStartRef = useRef(0);
  const recMediaRef = useRef(null); // web MediaRecorder + chunks
  // Reels P1 — sticker / GIF / video comment replies. Sticker picks come
  // from the same GifPicker (Tenor proxy) we use in chat-conversation.
  // Video replies pick up to 15s of footage on native via expo-image-picker,
  // or fall back to a file input on web.
  const [showStickerPicker, setShowStickerPicker] = useState(false);
  const [videoUploading, setVideoUploading] = useState(false);

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

  // Real-time comments: subscribe to feed_post_{id} channel while sheet open.
  // Server emits feed_comment_new on every new comment (Phase 1 backend patch).
  // Without this listener users had to re-open the sheet to see replies — now
  // they appear at the top live. Self-author comments are skipped because
  // handleSend already inserts them optimistically.
  useEffect(() => {
    if (!visible || !post?.id) return;
    let unsub = null;
    let mailWs = null;
    try { mailWs = require('../services/websocket').default; } catch {}
    if (!mailWs?.on || !mailWs?.subscribe) return;
    const channel = `feed_post_${post.id}`;
    try { mailWs.subscribe(channel); } catch {}
    unsub = mailWs.on('feed_comment_new', (data) => {
      if (!data || Number(data.post_id) !== Number(post.id)) return;
      const meLc = (user?.email || '').toLowerCase();
      if (String(data.email || '').toLowerCase() === meLc) return; // own send already inserted
      setComments(prev => {
        if (prev.some(c => Number(c.id) === Number(data.id))) return prev;
        return [data, ...prev];
      });
      currentCountRef.current += 1;
      onCommentCountChange?.(currentCountRef.current);
    });
    return () => {
      try { unsub?.(); } catch {}
      try { mailWs.unsubscribe?.(channel); } catch {}
    };
  }, [visible, post?.id, user?.email, onCommentCountChange]);

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
        // Light haptic to confirm the comment landed — like (line 393 in
        // FeedPost) already buzzes on tap; pairing it here keeps the feed
        // interaction loop tactile end-to-end.
        if (Platform.OS !== 'web') {
          try {
            const Haptics = require('expo-haptics');
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          } catch {}
        }
        // Scroll to top to show new comment
        setTimeout(() => {
          listRef.current?.scrollToOffset?.({ offset: 0, animated: true });
        }, 100);
      }
    } catch {} finally {
      setSending(false);
    }
  }, [text, sending, post, replyTo, user, onCommentCountChange]);

  // Voice comment record/upload. Web uses MediaRecorder; native uses
  // expo-audio's AudioModule + RecordingPresets. The upload itself goes
  // through `feedVoiceComment` which posts multipart to feed_voice_comment.
  const startRecording = useCallback(async () => {
    if (recording || sending) return;
    try {
      if (Platform.OS === 'web') {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return;
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mr = new MediaRecorder(stream);
        const chunks = [];
        mr.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
        recMediaRef.current = { mr, stream, chunks };
        mr.start();
      } else {
        const expoAudio = require('expo-audio');
        try { await expoAudio.setAudioModeAsync?.({ allowsRecording: true, playsInSilentMode: true }); } catch {}
        const AudioMod = require('expo-audio/build/AudioModule').default;
        const { RecordingPresets } = require('expo-audio');
        const recorder = await AudioMod.createRecorder(RecordingPresets.HIGH_QUALITY);
        await recorder.prepareToRecordAsync();
        recorder.record();
        recRef.current = recorder;
      }
      recStartRef.current = Date.now();
      setRecording(true);
      if (Platform.OS !== 'web') {
        try { require('expo-haptics').impactAsync(); } catch {}
      }
    } catch (e) {
      setRecording(false);
    }
  }, [recording, sending]);

  const stopRecording = useCallback(async (cancel = false) => {
    if (!recording) return;
    setRecording(false);
    const elapsed = Date.now() - recStartRef.current;
    let audio = null;
    try {
      if (Platform.OS === 'web') {
        const ref = recMediaRef.current;
        if (!ref) return;
        await new Promise((resolve) => {
          ref.mr.onstop = () => resolve();
          try { ref.mr.stop(); } catch { resolve(); }
        });
        try { ref.stream.getTracks().forEach(t => t.stop()); } catch {}
        if (!cancel && ref.chunks.length) {
          const blob = new Blob(ref.chunks, { type: 'audio/webm' });
          audio = { blob, name: 'voice.webm', type: 'audio/webm' };
        }
        recMediaRef.current = null;
      } else {
        const recorder = recRef.current;
        if (!recorder) return;
        try { await recorder.stop(); } catch {}
        const uri = recorder.uri;
        try { recorder.release?.(); } catch {}
        recRef.current = null;
        if (!cancel && uri) audio = { uri, name: 'voice.m4a', type: 'audio/m4a' };
        try { require('expo-audio').setAudioModeAsync?.({ allowsRecording: false }); } catch {}
      }
    } catch {}
    // Sub-300ms taps — treat as cancel; saves a 0-byte ghost upload.
    if (cancel || elapsed < 300 || !audio || !post?.id) return;
    setSending(true);
    try {
      const r = await api.feedVoiceComment(post.id, audio, replyTo?.id || null);
      if (r?.success && r.data) {
        const newComment = {
          ...r.data,
          author_email: r.data.email,
          author_name: r.data.name,
          liked_by_me: false,
          likes_count: 0,
        };
        setComments(prev => [newComment, ...prev]);
        setReplyTo(null);
        currentCountRef.current += 1;
        onCommentCountChange?.(currentCountRef.current);
        setTimeout(() => listRef.current?.scrollToOffset?.({ offset: 0, animated: true }), 100);
      }
    } catch {} finally {
      setSending(false);
    }
  }, [recording, post, replyTo, onCommentCountChange]);

  // Sticker / GIF comment — picks the GIF URL from the GifPicker (Tenor)
  // and posts as a comment with media_type=sticker. The backend stores it
  // on chat_feed_comments.media_url so the comment row can render the GIF
  // inline (FeedComments.CommentRow already reads attachment_url).
  const handleStickerPick = useCallback(async (item) => {
    setShowStickerPicker(false);
    if (!item || !post?.id) return;
    // Prefer `url` (full-size GIF) then `preview` (small), then `image_url`.
    const mediaUrl = String(item.url || item.image_url || item.preview || '');
    if (!mediaUrl) return;
    setSending(true);
    try {
      const r = await api.feedComment(post.id, '', replyTo?.id || null, {
        mediaUrl,
        mediaType: 'sticker',
      });
      if (r.success) {
        const newComment = r.data?.comment || r.data || {
          id: Date.now(),
          author_email: user?.email,
          email: user?.email,
          author_name: user?.name || user?.email?.split('@')[0],
          name: user?.name || user?.email?.split('@')[0],
          content: '',
          media_url: mediaUrl,
          attachment_url: mediaUrl,
          media_type: 'sticker',
          created_at: new Date().toISOString(),
          reply_to_id: replyTo?.id,
        };
        setComments(prev => [newComment, ...prev]);
        setReplyTo(null);
        currentCountRef.current += 1;
        onCommentCountChange?.(currentCountRef.current);
        setTimeout(() => listRef.current?.scrollToOffset?.({ offset: 0, animated: true }), 100);
      }
    } catch {} finally {
      setSending(false);
    }
  }, [post, replyTo, user, onCommentCountChange]);

  // Video reply — picks a clip via expo-image-picker (native) or file
  // input (web), uploads it via the existing feed-files endpoint, and
  // posts the URL as media_type=video on the comment.
  const pickVideoReply = useCallback(async () => {
    if (videoUploading || sending || !post?.id) return;
    let asset = null;
    try {
      if (Platform.OS === 'web') {
        await new Promise((resolve) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'video/*';
          input.onchange = (e) => {
            const f = e.target.files && e.target.files[0];
            if (f) asset = { file: f, uri: URL.createObjectURL(f), name: f.name, type: f.type || 'video/mp4' };
            resolve();
          };
          input.click();
        });
      } else {
        const ImagePicker = require('expo-image-picker');
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) return;
        const r = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Videos,
          allowsEditing: true,
          videoMaxDuration: 15,
          quality: 0.7,
        });
        if (r.canceled || !r.assets?.[0]) return;
        asset = { uri: r.assets[0].uri, name: 'reply.mp4', type: 'video/mp4' };
      }
    } catch {}
    if (!asset) return;
    setVideoUploading(true);
    try {
      // Upload via chatUploadFile (returns { url }) — same pipeline used by
      // chat-conversation video messages. Falls back to a multipart POST
      // to feed_voice_comment if chatUploadFile isn't available.
      let url = '';
      try {
        const up = await api.chatUploadFile?.(asset.file || asset);
        if (up?.success && up.data?.url) url = String(up.data.url);
      } catch {}
      if (!url) {
        // Last-ditch: skip and let the user pick again. We don't have a
        // generic feed-files upload helper for video, so the chat-upload
        // path is the canonical route.
        throw new Error('upload failed');
      }
      const r = await api.feedComment(post.id, '', replyTo?.id || null, {
        mediaUrl: url,
        mediaType: 'video',
      });
      if (r.success) {
        const newComment = r.data?.comment || r.data || {
          id: Date.now(),
          author_email: user?.email,
          email: user?.email,
          author_name: user?.name || user?.email?.split('@')[0],
          name: user?.name || user?.email?.split('@')[0],
          content: '',
          media_url: url,
          attachment_url: url,
          media_type: 'video',
          created_at: new Date().toISOString(),
          reply_to_id: replyTo?.id,
        };
        setComments(prev => [newComment, ...prev]);
        setReplyTo(null);
        currentCountRef.current += 1;
        onCommentCountChange?.(currentCountRef.current);
        setTimeout(() => listRef.current?.scrollToOffset?.({ offset: 0, animated: true }), 100);
      }
    } catch {} finally {
      setVideoUploading(false);
    }
  }, [post, replyTo, user, sending, videoUploading, onCommentCountChange]);

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

  const handleToggleCommentLike = useCallback(async (comment, nextLiked) => {
    const r = await api.feedCommentLikeToggle(comment.id);
    if (r?.success) {
      const newCount = Number(r.data?.likes_count) || 0;
      const liked = !!r.data?.liked;
      setComments(prev => prev.map(c => (
        c.id === comment.id ? { ...c, liked_by_me: liked, likes_count: newCount } : c
      )));
    } else {
      // Bubble up error so the row's optimistic state rolls back.
      throw new Error('like_failed');
    }
  }, []);

  // Flatten threaded comments — each parent followed by its replies.
  // Backend ships top-level rows + nested `replies: [...]`; the FlatList
  // is flat though, so we splice each parent's reply array right after
  // it. Old WS-pushed flat rows (with `reply_to_id` set) still render
  // correctly because we leave them in place if we can't find a parent.
  const flatComments = useMemo(() => {
    if (!Array.isArray(comments) || comments.length === 0) return [];
    const out = [];
    const seen = new Set();
    const replyOrphans = [];
    for (const c of comments) {
      if (!c || c.id == null) continue;
      // If this comment is itself a reply (sub-thread row arriving from WS
      // before its parent was rendered), defer it; we splice it back in
      // under its parent below.
      if (c.reply_to_id) {
        replyOrphans.push(c);
        continue;
      }
      out.push(c);
      seen.add(c.id);
      const replies = Array.isArray(c.replies) ? c.replies : null;
      if (replies && replies.length) {
        for (const r of replies) {
          if (r && r.id != null && !seen.has(r.id)) {
            out.push(r);
            seen.add(r.id);
          }
        }
      }
    }
    // Place any leftover replies under their parent (or at the end if the
    // parent is on a later page).
    for (const r of replyOrphans) {
      if (seen.has(r.id)) continue;
      const parentIdx = out.findIndex(c => c.id === r.reply_to_id);
      if (parentIdx >= 0) {
        out.splice(parentIdx + 1, 0, r);
      } else {
        out.push(r);
      }
      seen.add(r.id);
    }
    return out;
  }, [comments]);

  // Build a lookup map for reply parents — wrapped in useMemo so the
  // renderComment callback ref stays stable when only an unrelated state
  // changes (text input keystroke, replyTo, etc). Without this, every
  // keystroke in the input box re-rendered the entire FlatList of
  // comments because renderComment's ref changed on every render.
  const commentMap = useMemo(() => {
    const m = {};
    for (const c of flatComments) m[c.id] = c;
    return m;
  }, [flatComments]);

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
        onToggleLike={handleToggleCommentLike}
        replyParent={replyParent}
      />
    );
  }, [colors, isDark, t, user, handleReply, handleDelete, handleToggleCommentLike, commentMap]);

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
          accessibilityLabel={t('common.close') || 'Fechar'}
          accessibilityRole="button"
        />

        {/* Sheet */}
        <View style={[styles.sheet, {
          backgroundColor: isDark ? '#0f172a' : '#ffffff',
          maxHeight: SHEET_HEIGHT,
          ...(isWeb ? { boxShadow: '0 -4px 30px rgba(0,0,0,0.12)' } : {}),
        }]}>
          {/* Header — drag handle + centered title + close X */}
          <ModalHeader
            title={t('feed.comments') || 'Comentarios'}
            onClose={onClose}
            dragHandle
          />

          {/* Comments list */}
          {loading ? (
            <View style={styles.loadingWrap}>
              <ActivityIndicator size="large" color={ACCENT} />
            </View>
          ) : (
            <FlatList
              ref={listRef}
              data={flatComments}
              renderItem={renderComment}
              keyExtractor={(item) => String(item.id)}
              contentContainerStyle={[
                styles.listContent,
                flatComments.length === 0 && styles.listContentEmpty,
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
                  <View style={{ marginBottom: 12 }}>
                    <IconMessageCircle size={48} color={colors.textTertiary || '#999'} />
                  </View>
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
              backgroundColor: isDark ? 'rgba(124,58,237,0.08)' : 'rgba(124,58,237,0.06)',
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

          {/* Input — bottom padding tracks safe-area inset (was a fixed 28px
              that cropped on Dynamic Island devices). 10px floor keeps a
              comfortable gap on phones with no inset. */}
          <View style={[styles.inputRow, {
            borderTopColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
            backgroundColor: isDark ? '#0f172a' : '#fafafa',
            paddingBottom: Math.max(10, insets.bottom),
          }]}>
            {/* Sticker / GIF reply — Reels P1. Opens GifPicker (Tenor-backed)
                and posts the picked GIF as a comment with media_type=sticker
                + media_url=<gif_url>. */}
            <TouchableOpacity
              onPress={() => setShowStickerPicker(true)}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              style={{ paddingHorizontal: 4, paddingVertical: 4 }}
              accessibilityRole="button"
              accessibilityLabel={t('feed.replyWithSticker') || 'Reply with GIF'}
            >
              <IconImage size={20} color={ACCENT} />
            </TouchableOpacity>
            {/* Video reply — Reels P1. Records 15s clip and posts as a
                comment with media_type=video. On web we fall back to the
                file picker so users can still attach an existing clip. */}
            <TouchableOpacity
              onPress={pickVideoReply}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              style={{ paddingHorizontal: 4, paddingVertical: 4 }}
              accessibilityRole="button"
              accessibilityLabel={t('feed.replyWithVideo') || 'Reply with video'}
            >
              <IconVideo size={20} color={ACCENT} />
            </TouchableOpacity>
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
                    : (t('feed.writeComment') || 'Adicionar comentário...')
                }
                placeholderTextColor={colors.textTertiary}
                value={text}
                onChangeText={setText}
                multiline
                maxLength={500}
                accessibilityLabel={t('feed.writeComment') || 'Adicionar comentário'}
              />
              {text.trim() ? (
                <TouchableOpacity
                  onPress={handleSend}
                  disabled={sending}
                  style={[styles.sendBtn, {
                    opacity: !sending ? 1 : 0.3,
                  }]}
                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                  accessibilityLabel={t('feed.send') || 'Enviar'}
                  accessibilityRole="button"
                >
                  {sending ? (
                    <ActivityIndicator size="small" color={ACCENT} />
                  ) : (
                    <IconSend size={20} color={ACCENT} />
                  )}
                </TouchableOpacity>
              ) : (
                // Voice comment — Instagram-parity. Tap-and-hold to record,
                // release to upload. While recording we wrap the mic button
                // in an animated pulse halo (WhatsApp-style) so the user
                // sees the recording is live without needing a separate
                // status indicator. Halo only mounts while recording.
                <MicRecordButton
                  recording={recording}
                  sending={sending}
                  onPressIn={startRecording}
                  onPressOut={() => stopRecording(false)}
                  t={t}
                />
              )}
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>

      {/* Sticker / GIF picker — Reels P1 comment reply. Mounted as a
          stacked modal so it can sit on top of the comments sheet. The
          GifPicker (Tenor proxy) returns { url, preview }; we use `url`
          as media_url + media_type=sticker. */}
      <Modal
        visible={showStickerPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowStickerPicker(false)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }}
          onPress={() => setShowStickerPicker(false)}
        >
          <Pressable onPress={(e) => e.stopPropagation && e.stopPropagation()}>
            {(() => {
              try {
                const GifPicker = require('./GifPicker').default;
                return (
                  <GifPicker
                    onSelect={handleStickerPick}
                    onClose={() => setShowStickerPicker(false)}
                    colors={colors}
                    t={t}
                  />
                );
              } catch {
                return (
                  <View style={{ padding: 20, backgroundColor: isDark ? '#0f172a' : '#fff' }}>
                    <Text style={{ color: colors.text }}>{t('feed.stickerPickerUnavailable') || 'Sticker picker unavailable'}</Text>
                  </View>
                );
              }
            })()}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Tiny inline indicator while a video reply is uploading. */}
      {videoUploading ? (
        <View pointerEvents="none" style={{ position: 'absolute', top: 24, left: 0, right: 0, alignItems: 'center' }}>
          <View style={{ backgroundColor: 'rgba(0,0,0,0.8)', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <ActivityIndicator size="small" color="#fff" />
            <Text style={{ color: '#fff', fontSize: 12 }}>{t('feed.uploadingVideo') || 'Enviando vídeo…'}</Text>
          </View>
        </View>
      ) : null}
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
    // 24px nest indent — Instagram-style sub-thread (1 level deep).
    paddingLeft: 24,
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
