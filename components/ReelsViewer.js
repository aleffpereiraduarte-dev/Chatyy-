import React, { useState, useEffect, useCallback, useRef, memo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList, Dimensions,
  Animated, Platform, Share, TextInput, Modal, KeyboardAvoidingView,
  ActivityIndicator, Pressable, ScrollView, Image, Easing,
} from 'react-native';
import AvatarCircle from './AvatarCircle';
import {
  IconHeart, IconHeartOutline, IconMessageCircle, IconShare,
  IconBookmark, IconBookmarkFilled, IconMusic, IconPlay, IconPause,
  IconX, IconSend, IconChevronDown, IconCamera, IconVolume2, IconVolumeX, IconEye,
} from './Icons';
import * as api from '../services/api';

// Pick the active subtitle segment for a video time (in ms). Segments
// arrive shaped like {start, end, text} with start/end in SECONDS. We
// linear-scan because subtitle counts cap at 500 — a binary search would
// save ~3 µs per frame and isn't worth the complexity.
function pickSubtitle(segments, currentMs) {
  if (!Array.isArray(segments) || segments.length === 0) return '';
  const t = (currentMs || 0) / 1000;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const start = Number(s.start) || 0;
    const end = Number(s.end) || 0;
    if (t >= start && t <= end) return s.text || '';
  }
  return '';
}

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// Native video player using WebView with HTML5 video (autoplay, loop, controls via JS)
const NativeReelVideo = memo(function NativeReelVideo({ videoUrl, poster, isActive, paused, playbackRate = 1 }) {
  const webViewRef = useRef(null);
  const webViewReady = useRef(false);

  useEffect(() => {
    if (!webViewRef.current || !webViewReady.current) return;
    if (isActive && !paused) {
      webViewRef.current.injectJavaScript(`
        var v=document.querySelector("video");
        if(v){v.muted=true;v.play().then(function(){setTimeout(function(){v.muted=false},300)}).catch(function(){});}
        true;
      `);
    } else {
      webViewRef.current.injectJavaScript('var v=document.querySelector("video");if(v)v.pause();true;');
    }
  }, [isActive, paused]);

  // Speed control: TikTok-style 0.5x / 1x / 1.5x / 2x. Inject playbackRate
  // each time it changes; the underlying <video> applies it instantly.
  useEffect(() => {
    if (!webViewRef.current || !webViewReady.current) return;
    const r = Number(playbackRate) || 1;
    webViewRef.current.injectJavaScript(`var v=document.querySelector("video");if(v){v.playbackRate=${r};}true;`);
  }, [playbackRate]);

  // iOS quirk: when a transparent Modal slides up over the WebView (the
  // CommentsSheet), iOS treats the underlying WebView as backgrounded and
  // pauses HTML5 <video>. There's no JS event we can hook on the RN side,
  // but we CAN periodically re-inject play() while the reel should still
  // be playing — a "watchdog" loop. Cheap (1 frame eval per 800ms) and only
  // runs while isActive && !paused.
  useEffect(() => {
    if (!webViewRef.current || !webViewReady.current) return;
    if (!isActive || paused) return;
    const watchdog = setInterval(() => {
      try {
        webViewRef.current?.injectJavaScript(
          'var v=document.querySelector("video");if(v&&v.paused){v.muted=true;v.play().then(function(){setTimeout(function(){v.muted=false},300)}).catch(function(){});}true;'
        );
      } catch {}
    }, 800);
    return () => clearInterval(watchdog);
  }, [isActive, paused]);

  const WebView = require('react-native-webview').WebView;
  const html = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"><style>*{margin:0;padding:0}html,body{width:100%;height:100%;background:#000;overflow:hidden}video{position:fixed;top:0;left:0;width:100%;height:100%;object-fit:cover}</style></head><body><video src="${videoUrl}" ${poster ? `poster="${poster}"` : ''} autoplay loop playsinline webkit-playsinline muted preload="auto"></video><script>var v=document.querySelector('video');v.muted=true;v.play().then(function(){setTimeout(function(){v.muted=false},300)}).catch(function(){});document.addEventListener('visibilitychange',function(){if(!document.hidden){v.muted=true;v.play().then(function(){setTimeout(function(){v.muted=false},300)}).catch(function(){});}});</script></body></html>`;

  return (
    <View style={StyleSheet.absoluteFill}>
      <WebView
        ref={webViewRef}
        source={{ html, baseUrl: 'https://chatyy.com.br' }}
        style={{ flex: 1, backgroundColor: '#000' }}
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
        javaScriptEnabled={true}
        originWhitelist={['*']}
        setSupportMultipleWindows={false}
        allowsFullscreenVideo={false}
        scrollEnabled={false}
        bounces={false}
        onLoadEnd={() => {
          webViewReady.current = true;
          if (isActive && !paused && webViewRef.current) {
            webViewRef.current.injectJavaScript(`
              var v=document.querySelector("video");
              if(v){v.muted=true;v.play().then(function(){setTimeout(function(){v.muted=false},300)}).catch(function(){});}
              true;
            `);
          }
        }}
        onShouldStartLoadWithRequest={(req) => {
          if (req.url === 'about:blank' || req.url.startsWith('https://chatyy.com.br')) return true;
          return false;
        }}
      />
    </View>
  );
});

const ACCENT = '#7C3AED';
const DOUBLE_TAP_DELAY = 300;
const BASE_URL = 'https://chatyy.com.br';
const isWeb = Platform.OS === 'web';
const useNative = Platform.OS !== 'web';

// Text shadow style for readability over video
const TEXT_SHADOW = {
  textShadowColor: 'rgba(0,0,0,0.75)',
  textShadowOffset: { width: 0, height: 1.5 },
  textShadowRadius: 5,
};

const ICON_SHADOW = {
  shadowColor: '#000',
  shadowOffset: { width: 0, height: 1 },
  shadowOpacity: 0.5,
  shadowRadius: 3,
  ...(isWeb ? {} : { elevation: 3 }),
};

function resolveMediaUrl(url) {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return BASE_URL + (url.startsWith('/') ? '' : '/') + url;
}

function parseMediaUrls(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return []; }
  }
  return [];
}

function formatCount(n) {
  if (!n || n <= 0) return '0';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

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
  return (_d=>isNaN(_d.getTime())?'':_d.toLocaleDateString())(new Date(str));
}

// ── Likers Bottom Sheet ──
function LikersSheet({ visible, post, colors, isDark, t, onClose }) {
  const [likers, setLikers] = useState([]);
  const [loading, setLoading] = useState(false);
  const slideAnim = useRef(new Animated.Value(SCREEN_HEIGHT)).current;

  useEffect(() => {
    if (visible && post) {
      loadLikers();
      Animated.spring(slideAnim, {
        toValue: 0,
        tension: 65,
        friction: 11,
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(slideAnim, {
        toValue: SCREEN_HEIGHT,
        duration: 250,
        useNativeDriver: true,
      }).start();
    }
  }, [visible, post]);

  const loadLikers = async () => {
    if (!post) return;
    setLoading(true);
    try {
      const r = await api.feedLikers(post.id);
      if (r.success && r.data) {
        setLikers(Array.isArray(r.data.likers) ? r.data.likers : (Array.isArray(r.data) ? r.data : []));
      }
    } catch {} finally { setLoading(false); }
  };

  if (!visible) return null;

  return (
    <Modal transparent visible={visible} animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <Animated.View
          style={[styles.sheetContainer, {
            transform: [{ translateY: slideAnim }],
          }]}
        >
          <Pressable onPress={() => {}}>
            <View style={styles.sheetHandle}>
              <View style={styles.sheetHandleBar} />
            </View>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>
                {t('feed.likes') || 'Likes'}
              </Text>
              <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <IconX size={22} color="#999" />
              </TouchableOpacity>
            </View>

            {loading ? (
              <View style={styles.sheetLoading}>
                <ActivityIndicator size="small" color="#fff" />
              </View>
            ) : likers.length === 0 ? (
              <View style={styles.sheetEmpty}>
                <Text style={styles.sheetEmptyText}>
                  {t('feed.noLikes') || 'Sem curtidas'}
                </Text>
              </View>
            ) : (
              <ScrollView style={styles.sheetList} showsVerticalScrollIndicator={false}>
                {likers.map((liker, idx) => (
                  <View key={liker.email || idx} style={styles.commentRow}>
                    <AvatarCircle email={liker.email} name={liker.name} size={32} />
                    <View style={styles.commentContent}>
                      <Text style={styles.commentAuthor}>
                        {liker.name || liker.email?.split('@')[0] || '?'}
                      </Text>
                      <Text style={styles.commentTime}>
                        {timeAgo(liker.created_at, t)}
                      </Text>
                    </View>
                  </View>
                ))}
                <View style={{ height: 20 }} />
              </ScrollView>
            )}
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

// ── Comments Bottom Sheet ──
function CommentsSheet({ visible, post, colors, isDark, t, user, onClose }) {
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const slideAnim = useRef(new Animated.Value(SCREEN_HEIGHT)).current;

  useEffect(() => {
    if (visible && post) {
      loadComments();
      Animated.spring(slideAnim, {
        toValue: 0,
        tension: 65,
        friction: 11,
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(slideAnim, {
        toValue: SCREEN_HEIGHT,
        duration: 250,
        useNativeDriver: true,
      }).start();
    }
  }, [visible, post]);

  const loadComments = async () => {
    if (!post) return;
    setLoading(true);
    try {
      const r = await api.feedComments(post.id);
      if (r.success && r.data) {
        setComments(Array.isArray(r.data.comments) ? r.data.comments : (Array.isArray(r.data) ? r.data : []));
      }
    } catch {} finally { setLoading(false); }
  };

  const sendComment = async () => {
    if (!text.trim() || sending || !post) return;
    setSending(true);
    try {
      const r = await api.feedComment(post.id, text.trim());
      if (r.success) {
        setText('');
        loadComments();
      }
    } catch {} finally { setSending(false); }
  };

  if (!visible) return null;

  return (
    <Modal transparent visible={visible} animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <Animated.View
          style={[styles.sheetContainer, {
            transform: [{ translateY: slideAnim }],
          }]}
        >
          <Pressable onPress={() => {}}>
            {/* Handle bar */}
            <View style={styles.sheetHandle}>
              <View style={styles.sheetHandleBar} />
            </View>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>
                {t('feed.comments') || 'Comments'}
              </Text>
              <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <IconX size={22} color="#999" />
              </TouchableOpacity>
            </View>

            {loading ? (
              <View style={styles.sheetLoading}>
                <ActivityIndicator size="small" color="#fff" />
              </View>
            ) : comments.length === 0 ? (
              <View style={styles.sheetEmpty}>
                <Text style={styles.sheetEmptyText}>
                  {t('feed.noComments') || 'Sem comentarios'}
                </Text>
              </View>
            ) : (
              <ScrollView style={styles.sheetList} showsVerticalScrollIndicator={false}>
                {comments.map((c, idx) => (
                  <View key={c.id || idx} style={styles.commentRow}>
                    <AvatarCircle email={c.author_email} name={c.author_name} size={32} />
                    <View style={styles.commentContent}>
                      <Text style={styles.commentAuthor}>
                        {c.author_name || c.author_email?.split('@')[0] || '?'}
                        <Text style={styles.commentText}>
                          {'  '}{c.content}
                        </Text>
                      </Text>
                      <Text style={styles.commentTime}>
                        {timeAgo(c.created_at, t)}
                      </Text>
                    </View>
                  </View>
                ))}
                <View style={{ height: 20 }} />
              </ScrollView>
            )}

            {/* Input */}
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
              <View style={styles.sheetInput}>
                <AvatarCircle email={user?.email} name={user?.name} size={30} />
                <TextInput
                  style={styles.sheetTextInput}
                  placeholder={t('feed.writeComment') || 'Adicionar comentario...'}
                  placeholderTextColor="#666"
                  value={text}
                  onChangeText={setText}
                  returnKeyType="send"
                  onSubmitEditing={sendComment}
                />
                <TouchableOpacity
                  onPress={sendComment}
                  disabled={!text.trim() || sending}
                  style={{ opacity: text.trim() ? 1 : 0.4 }}
                >
                  {sending ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <IconSend size={22} color="#fff" />
                  )}
                </TouchableOpacity>
              </View>
            </KeyboardAvoidingView>
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

// ── Spinning Album Art ──
const SpinningDisc = memo(function SpinningDisc({ authorEmail, authorName }) {
  const spinValue = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const spin = Animated.loop(
      Animated.timing(spinValue, {
        toValue: 1,
        duration: 3000,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    spin.start();
    return () => spin.stop();
  }, []);

  const rotate = spinValue.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  return (
    <Animated.View style={[styles.albumArt, { transform: [{ rotate }] }]}>
      <View style={styles.albumArtInner}>
        <View style={styles.albumArtCenter}>
          <AvatarCircle email={authorEmail} name={authorName} size={18} />
        </View>
      </View>
    </Animated.View>
  );
});

// ── Music equalizer (3 bars bouncing) ──
// Renders next to the music icon to signal "audio is playing" without
// audio actually being present (the reel is muted in the UI; this is
// purely visual flair). 3 thin vertical bars, each on its own loop
// with offset phase + duration so they look like real EQ levels.
const MusicEqualizer = memo(function MusicEqualizer() {
  const bars = useRef([
    new Animated.Value(0.4),
    new Animated.Value(0.85),
    new Animated.Value(0.55),
  ]).current;
  useEffect(() => {
    const cfgs = [
      { dur: [320, 460], min: 0.25, max: 1 },
      { dur: [380, 520], min: 0.40, max: 0.95 },
      { dur: [300, 440], min: 0.30, max: 0.90 },
    ];
    const loops = bars.map((v, i) => {
      const c = cfgs[i];
      return Animated.loop(
        Animated.sequence([
          Animated.timing(v, { toValue: c.max, duration: c.dur[0], useNativeDriver: false }),
          Animated.timing(v, { toValue: c.min, duration: c.dur[1], useNativeDriver: false }),
        ])
      );
    });
    loops.forEach(l => l.start());
    return () => loops.forEach(l => l.stop());
  }, []);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 1.5, height: 12, marginRight: 2 }}>
      {bars.map((v, i) => (
        <Animated.View
          key={i}
          style={{
            width: 2.5,
            borderRadius: 1.25,
            backgroundColor: '#fff',
            height: v.interpolate({ inputRange: [0, 1], outputRange: [3, 12] }),
          }}
        />
      ))}
    </View>
  );
});

// ── Music Marquee (scrolling text) ──
const MusicMarquee = memo(function MusicMarquee({ text: musicText }) {
  const scrollX = useRef(new Animated.Value(0)).current;
  const textWidth = useRef(200);

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(scrollX, {
          toValue: -textWidth.current,
          duration: 6000,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
        Animated.timing(scrollX, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [musicText]);

  return (
    <View style={styles.marqueeContainer}>
      <Animated.View
        style={[styles.marqueeTrack, { transform: [{ translateX: scrollX }] }]}
        onLayout={(e) => { textWidth.current = e.nativeEvent.layout.width / 2; }}
      >
        <Text style={styles.marqueeText}>{musicText}    </Text>
        <Text style={styles.marqueeText}>{musicText}    </Text>
      </Animated.View>
    </View>
  );
});

// ── Pause Icon Flash ──
const PauseFlash = memo(function PauseFlash({ visible }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    if (visible) {
      opacity.setValue(1);
      scale.setValue(0.5);
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 0,
          duration: 600,
          delay: 200,
          useNativeDriver: true,
        }),
        Animated.spring(scale, {
          toValue: 1,
          tension: 300,
          friction: 15,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible]);

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.pauseFlashOverlay, {
        opacity,
        transform: [{ scale }],
      }]}
    >
      <View style={styles.pauseFlashCircle}>
        <IconPlay size={36} color="#fff" />
      </View>
    </Animated.View>
  );
});

// ── Single Reel Item ──
const ReelItem = memo(function ReelItem({ reel, isActive, colors, isDark, t, user, containerHeight, onOpenComments, onOpenLikers, onOpenProfile, overlayOpen }) {
  const [paused, setPaused] = useState(false);
  // When the comments/likers/share sheet opens above this reel, pause so the
  // user isn't trying to read with audio blasting underneath. Without this,
  // the Modal stack doesn't pause the underlying video — the reel keeps
  // playing unmuted and you have to manually pause before reading replies.
  const effectivePaused = paused || !!overlayOpen;
  // TikTok-style speed selector: cycle 1x → 1.5x → 2x → 0.5x → 1x. Stored
  // per-reel in this component instance so swiping between reels resets to
  // 1x (matches TikTok behavior where each reel starts at default speed).
  const [playbackRate, setPlaybackRate] = useState(1);
  const cyclePlaybackRate = useCallback(() => {
    setPlaybackRate(r => (r === 1 ? 1.5 : r === 1.5 ? 2 : r === 2 ? 0.5 : 1));
    try { require('expo-haptics').selectionAsync(); } catch {}
  }, []);
  const [muted, setMuted] = useState(false);
  const [liked, setLiked] = useState(!!reel.user_liked);
  const [likeCount, setLikeCount] = useState(Number(reel.like_count) || 0);
  const [bookmarked, setBookmarked] = useState(!!reel.user_bookmarked);
  const [captionExpanded, setCaptionExpanded] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentMs, setCurrentMs] = useState(0);
  const [showPauseFlash, setShowPauseFlash] = useState(false);
  const [viewCount, setViewCount] = useState(Number(reel.view_count) || 0);
  // Subtitles (TikTok auto-captions). Toggle persists per-session inside
  // this list — defaults to ON when segments are present so first-time
  // viewers see captions Just Like TikTok.
  const initialSegs = Array.isArray(reel?.subtitles) ? reel.subtitles : [];
  const [subtitleSegments, setSubtitleSegments] = useState(initialSegs);
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(initialSegs.length > 0);
  const transcribeFiredRef = useRef(false);

  const videoRef = useRef(null);
  const lastTapRef = useRef(0);
  const heartScale = useRef(new Animated.Value(0)).current;
  const heartOpacity = useRef(new Animated.Value(0)).current;
  const likeScale = useRef(new Animated.Value(1)).current;
  const bookmarkScale = useRef(new Animated.Value(1)).current;
  const progressIntervalRef = useRef(null);
  const pauseFlashKey = useRef(0);

  const mediaUrls = parseMediaUrls(reel.media_urls);
  const videoUrl = resolveMediaUrl(mediaUrls[0]);
  const authorDisplay = reel.author_name || reel.author_email?.split('@')[0] || '?';
  const commentCount = Number(reel.comment_count) || 0;
  const musicName = reel.audio_name || `${authorDisplay} - ${t('feed.originalAudio') || 'Audio original'}`;

  // Sync with prop changes
  useEffect(() => {
    setLiked(!!reel.user_liked);
    setLikeCount(Number(reel.like_count) || 0);
    setBookmarked(!!reel.user_bookmarked);
  }, [reel.user_liked, reel.like_count, reel.user_bookmarked]);

  // Track view when reel becomes active
  useEffect(() => {
    if (isActive && reel.id) {
      api.feedView?.(reel.id).catch(() => {});
    }
  }, [isActive, reel.id]);

  // Auto-play/pause based on active state (web)
  useEffect(() => {
    if (!isWeb) return;
    const v = videoRef.current;
    if (!v) return;
    if (isActive && !effectivePaused) {
      v.muted = true;
      v.currentTime = v.currentTime || 0;
      const playPromise = v.play();
      if (playPromise) {
        playPromise.then(() => {
          if (!muted) setTimeout(() => { v.muted = false; }, 300);
        }).catch(() => {
          v.muted = true;
          v.play().catch(() => {});
        });
      }
    } else {
      v.pause();
    }
  }, [isActive, effectivePaused, muted]);

  // Progress tracking (web). Also drives subtitle current-time so the
  // overlay re-paints in sync with playback. 100ms tick is generous —
  // captions feel stuttery below ~250ms but TikTok runs ~16ms; we
  // compromise at 100ms because RN setState batches anyway.
  useEffect(() => {
    if (!isWeb) return;
    if (isActive) {
      progressIntervalRef.current = setInterval(() => {
        if (videoRef.current && videoRef.current.duration) {
          setProgress(videoRef.current.currentTime / videoRef.current.duration);
          setCurrentMs(videoRef.current.currentTime * 1000);
        }
      }, 100);
    } else {
      setProgress(0);
      setCurrentMs(0);
    }
    return () => {
      if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
    };
  }, [isActive]);

  // Auto-transcribe own reel that doesn't yet have captions. Whisper
  // hits the existing `ai_transcribe_audio` endpoint; the result is
  // saved back via `feed_post_set_subtitles` so the next viewer sees
  // captions instantly. Fire-once: transcribeFiredRef prevents
  // duplicate jobs across re-renders or tab toggles.
  useEffect(() => {
    if (transcribeFiredRef.current) return;
    if (!isActive || !reel?.id) return;
    if (subtitleSegments.length > 0) return;
    const ownerLc = String(reel.author_email || '').toLowerCase();
    const meLc = String(user?.email || '').toLowerCase();
    if (!ownerLc || ownerLc !== meLc) return; // only owner triggers
    if (!videoUrl) return;
    transcribeFiredRef.current = true;
    (async () => {
      try {
        const r = await api.aiAssist?.('transcribe_video', { url: videoUrl });
        const segs = r?.data?.segments;
        if (Array.isArray(segs) && segs.length > 0) {
          setSubtitleSegments(segs);
          setSubtitlesEnabled(true);
          try { await api.feedPostSetSubtitles(reel.id, segs); } catch {}
        }
      } catch {}
    })();
  }, [isActive, reel?.id, reel?.author_email, user?.email, subtitleSegments.length, videoUrl]);

  // Compute the visible caption line for the current playback time.
  const subtitleLine = subtitlesEnabled ? pickSubtitle(subtitleSegments, currentMs) : '';

  // Reset paused state when becoming active
  useEffect(() => {
    if (isActive) {
      setPaused(false);
      setCaptionExpanded(false);
    }
  }, [isActive]);

  const toggleMute = useCallback(() => {
    setMuted(m => {
      const newMuted = !m;
      if (isWeb && videoRef.current) {
        videoRef.current.muted = newMuted;
      }
      return newMuted;
    });
  }, []);

  const togglePause = useCallback(() => {
    if (isWeb) {
      if (!videoRef.current) return;
      if (videoRef.current.paused) {
        videoRef.current.muted = muted;
        videoRef.current.play().catch(() => {});
        setPaused(false);
      } else {
        videoRef.current.pause();
        setPaused(true);
        pauseFlashKey.current += 1;
        setShowPauseFlash(prev => !prev);
      }
    } else {
      setPaused(p => {
        if (!p) {
          pauseFlashKey.current += 1;
          setShowPauseFlash(prev => !prev);
        }
        return !p;
      });
    }
  }, [muted]);

  const showHeartAnimation = useCallback(() => {
    heartScale.setValue(0);
    heartOpacity.setValue(1);
    Animated.sequence([
      Animated.spring(heartScale, {
        toValue: 1.3,
        tension: 200,
        friction: 5,
        useNativeDriver: true,
      }),
      Animated.parallel([
        Animated.spring(heartScale, {
          toValue: 1,
          tension: 200,
          friction: 10,
          useNativeDriver: true,
        }),
        Animated.timing(heartOpacity, {
          toValue: 0,
          duration: 400,
          delay: 400,
          useNativeDriver: true,
        }),
      ]),
    ]).start();
  }, [heartScale, heartOpacity]);

  const likeInFlightRef = useRef(false);
  const toggleLike = useCallback(async () => {
    // Race guard — without this, rapid double-tap fires N parallel requests
    // and the like state desyncs (icon flickers or count jumps wildly).
    if (likeInFlightRef.current) return;
    likeInFlightRef.current = true;
    const wasLiked = liked;
    setLiked(!wasLiked);
    setLikeCount(prev => wasLiked ? Math.max(0, prev - 1) : prev + 1);
    likeScale.setValue(0.5);
    Animated.spring(likeScale, {
      toValue: 1,
      tension: 300,
      friction: 8,
      useNativeDriver: true,
    }).start();
    try {
      const r = await api.feedLike(reel.id);
      if (r.success && r.data) {
        if (r.data.liked !== undefined) setLiked(!!r.data.liked);
        if (r.data.like_count !== undefined) setLikeCount(Number(r.data.like_count));
      }
    } catch {
      setLiked(wasLiked);
      setLikeCount(prev => wasLiked ? prev + 1 : Math.max(0, prev - 1));
    } finally {
      likeInFlightRef.current = false;
    }
  }, [liked, reel.id, likeScale]);

  const handleDoubleTap = useCallback(() => {
    const now = Date.now();
    if (now - lastTapRef.current < DOUBLE_TAP_DELAY) {
      // Double tap - like
      if (!liked) toggleLike();
      showHeartAnimation();
      lastTapRef.current = 0;
    } else {
      lastTapRef.current = now;
      // Single tap with delay to differentiate
      setTimeout(() => {
        if (lastTapRef.current !== 0) {
          togglePause();
        }
      }, DOUBLE_TAP_DELAY + 50);
    }
  }, [liked, toggleLike, showHeartAnimation, togglePause]);

  const toggleBookmark = useCallback(async () => {
    const was = bookmarked;
    setBookmarked(!was);
    bookmarkScale.setValue(0.5);
    Animated.spring(bookmarkScale, {
      toValue: 1,
      tension: 300,
      friction: 8,
      useNativeDriver: true,
    }).start();
    try {
      const r = await api.feedBookmark(reel.id);
      if (r.success && r.data) {
        if (r.data.bookmarked !== undefined) setBookmarked(!!r.data.bookmarked);
      }
    } catch {
      setBookmarked(was);
    }
  }, [bookmarked, reel.id, bookmarkScale]);

  const handleShare = useCallback(async () => {
    const url = `${BASE_URL}/feed/${reel.id}`;
    if (isWeb && typeof navigator !== 'undefined' && navigator.share) {
      try { await navigator.share({ title: reel.caption || '', url }); } catch {}
    } else if (!isWeb) {
      try { await Share.share({ message: url }); } catch {}
    }
  }, [reel.id, reel.caption]);

  const height = containerHeight || SCREEN_HEIGHT;

  return (
    <View style={[styles.reelContainer, { height, width: SCREEN_WIDTH }]}>
      {/* Video - full screen edge to edge */}
      <TouchableOpacity
        activeOpacity={1}
        onPress={handleDoubleTap}
        style={StyleSheet.absoluteFill}
      >
        {isWeb ? (
          <video
            ref={(el) => {
              videoRef.current = el;
              if (el && isActive) {
                el.muted = true;
                el.play().then(() => {
                  if (!muted) setTimeout(() => { el.muted = false; }, 300);
                }).catch(() => {
                  el.muted = true;
                  el.play().catch(() => {});
                });
              } else if (el && !isActive) {
                el.pause();
              }
            }}
            src={videoUrl}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              backgroundColor: '#000',
            }}
            loop
            playsInline
            muted
            preload="auto"
            poster={reel.thumbnail_url ? resolveMediaUrl(reel.thumbnail_url) : undefined}
          />
        ) : (
          <NativeReelVideo videoUrl={videoUrl} poster={reel.thumbnail_url ? resolveMediaUrl(reel.thumbnail_url) : null} isActive={isActive} paused={effectivePaused} playbackRate={playbackRate} />
        )}
      </TouchableOpacity>

      {/* Gradient overlays for readability */}
      <View pointerEvents="none" style={styles.topGradient} />
      <View pointerEvents="none" style={styles.bottomGradient} />

      {/* Pause flash animation */}
      <PauseFlash key={pauseFlashKey.current} visible={paused} />

      {/* Heart animation (double-tap) - big white heart center screen */}
      <Animated.View
        pointerEvents="none"
        style={[styles.heartAnimOverlay, {
          opacity: heartOpacity,
          transform: [{ scale: heartScale }],
        }]}
      >
        <IconHeart size={110} color="#fff" />
      </Animated.View>

      {/* ── TOP BAR (right side only - tabs are rendered by parent) ── */}
      <View style={styles.topBar}>
        <View />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
          <TouchableOpacity
            onPress={toggleMute}
            activeOpacity={0.7}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={{ backgroundColor: 'rgba(0,0,0,0.35)', borderRadius: 20, width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}
            accessibilityLabel={muted ? (t('feed.unmute') || 'Unmute') : (t('feed.mute') || 'Mute')}
            accessibilityRole="button"
          >
            {muted ? <IconVolumeX size={20} color="#fff" /> : <IconVolume2 size={20} color="#fff" />}
          </TouchableOpacity>
          {/* CC toggle — only renders when the post has segments. Tap
              hides/shows the bottom subtitle overlay. */}
          {subtitleSegments.length > 0 && (
            <TouchableOpacity
              onPress={() => setSubtitlesEnabled(v => !v)}
              activeOpacity={0.7}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              style={{ backgroundColor: subtitlesEnabled ? 'rgba(124,58,237,0.85)' : 'rgba(0,0,0,0.35)', borderRadius: 8, paddingHorizontal: 8, height: 28, alignItems: 'center', justifyContent: 'center' }}
              accessibilityLabel={subtitlesEnabled ? (t('media.subtitlesOn') || 'Subtitles on') : (t('media.subtitlesOff') || 'Subtitles off')}
              accessibilityRole="button"
            >
              <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800', letterSpacing: 0.5 }}>CC</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity activeOpacity={0.7} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <IconCamera size={26} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>

      {/* ── RIGHT SIDE BUTTONS ── */}
      <View style={styles.rightSidebar}>
        {/* Profile avatar with white border + follow badge. Tapping opens
            the author's unified profile at /u/{email}. Previously had no
            onPress so the tap was a silent no-op. */}
        <TouchableOpacity
          style={styles.profileAvatarBtn}
          activeOpacity={0.8}
          onPress={() => onOpenProfile?.(reel.author_email)}
          accessibilityLabel={authorDisplay}
          accessibilityRole="button"
        >
          <View style={styles.profileAvatarRing}>
            <AvatarCircle email={reel.author_email} name={reel.author_name} size={36} />
          </View>
          <View style={styles.profileFollowBadge}>
            <Text style={styles.profileFollowPlus}>+</Text>
          </View>
        </TouchableOpacity>

        {/* Like */}
        <Animated.View style={{ transform: [{ scale: likeScale }] }}>
          <TouchableOpacity
            style={styles.sidebarBtn}
            onPress={toggleLike}
            activeOpacity={0.7}
            accessibilityLabel={liked ? (t('feed.unlike') || 'Unlike') : (t('feed.like') || 'Like')}
            accessibilityRole="button"
          >
            {liked ? (
              <IconHeart size={28} color="#FF2D55" />
            ) : (
              <IconHeartOutline size={28} color="#fff" />
            )}
          </TouchableOpacity>
          <TouchableOpacity onPress={() => onOpenLikers?.(reel)} activeOpacity={0.7}>
            <Text style={styles.sidebarCount}>{formatCount(likeCount)}</Text>
          </TouchableOpacity>
        </Animated.View>

        {/* Comment */}
        <TouchableOpacity
          style={styles.sidebarBtn}
          onPress={() => onOpenComments?.(reel)}
          activeOpacity={0.7}
          accessibilityLabel={t('feed.comment') || 'Comment'}
          accessibilityRole="button"
        >
          <IconMessageCircle size={28} color="#fff" />
          <Text style={styles.sidebarCount}>{formatCount(commentCount)}</Text>
        </TouchableOpacity>

        {/* Share */}
        <TouchableOpacity
          style={styles.sidebarBtn}
          onPress={handleShare}
          activeOpacity={0.7}
          accessibilityLabel={t('feed.share') || 'Compartilhar'}
          accessibilityRole="button"
        >
          <IconShare size={26} color="#fff" />
        </TouchableOpacity>

        {/* Playback speed — TikTok parity. Tap cycles 1x → 1.5x → 2x → 0.5x.
            Hidden when at 1x to keep the rail clean; reveals as a small pill
            once user opted into a non-default speed. */}
        <TouchableOpacity
          style={[styles.sidebarBtn, { paddingVertical: 6 }]}
          onPress={cyclePlaybackRate}
          activeOpacity={0.7}
          accessibilityLabel={`${t?.('feed.speed') || 'Velocidade'} ${playbackRate}x`}
          accessibilityRole="button"
        >
          <View style={{
            paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12,
            backgroundColor: playbackRate === 1 ? 'rgba(255,255,255,0.15)' : '#7C3AED',
            minWidth: 36, alignItems: 'center',
          }}>
            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>
              {playbackRate === 0.5 ? '0.5×' : playbackRate === 1 ? '1×' : playbackRate === 1.5 ? '1.5×' : '2×'}
            </Text>
          </View>
        </TouchableOpacity>

        {/* Views */}
        {viewCount > 0 && (
          <View style={styles.sidebarBtn}>
            <IconEye size={24} color="#fff" />
            <Text style={styles.sidebarCount}>{formatCount(viewCount)}</Text>
          </View>
        )}

        {/* Bookmark */}
        <Animated.View style={{ transform: [{ scale: bookmarkScale }] }}>
          <TouchableOpacity
            style={styles.sidebarBtn}
            onPress={toggleBookmark}
            activeOpacity={0.7}
            accessibilityLabel={bookmarked ? (t('feed.removeBookmark') || 'Remove') : (t('feed.bookmark') || 'Save')}
            accessibilityRole="button"
          >
            {bookmarked ? (
              <IconBookmarkFilled size={26} color="#fff" />
            ) : (
              <IconBookmark size={26} color="#fff" />
            )}
          </TouchableOpacity>
        </Animated.View>

        {/* Spinning album art disc */}
        <SpinningDisc authorEmail={reel.author_email} authorName={reel.author_name} />
      </View>

      {/* ── Subtitle overlay (TikTok auto-caption) ──
          Sits above the bottom info block so the visible caption doesn't
          fight for the same vertical space. We pin to bottom-center with
          a max-width of 78% so it never collides with the right rail. */}
      {!!subtitleLine && (
        <View pointerEvents="none" style={styles.subtitleOverlay}>
          <View style={styles.subtitleBg}>
            <Text style={styles.subtitleText}>{subtitleLine}</Text>
          </View>
        </View>
      )}

      {/* ── BOTTOM LEFT INFO ── */}
      <View style={styles.bottomInfo}>
        {/* Username */}
        <Text style={styles.username}>@{authorDisplay}</Text>

        {/* Caption */}
        {reel.caption ? (
          <TouchableOpacity
            onPress={() => setCaptionExpanded(!captionExpanded)}
            activeOpacity={0.9}
          >
            <Text style={styles.caption} numberOfLines={captionExpanded ? undefined : 2}>
              {reel.caption}
            </Text>
            {!captionExpanded && reel.caption.length > 80 && (
              <Text style={styles.moreText}>{t('feed.more') || 'mais'}</Text>
            )}
          </TouchableOpacity>
        ) : null}

        {/* Music row with marquee + tiny equalizer (signals audio
            is "playing" even when the reel is muted). */}
        <View style={styles.musicRow}>
          <IconMusic size={12} color="#fff" />
          <MusicEqualizer />
          <MusicMarquee text={musicName} />
        </View>
      </View>

      {/* ── PROGRESS BAR ── */}
      <View style={styles.progressBar}>
        <View style={[styles.progressFill, { width: `${Math.min(progress * 100, 100)}%` }]} />
      </View>
    </View>
  );
});

// ── Empty state ──
function EmptyReels({ colors, isDark, t }) {
  return (
    <View style={styles.emptyContainer}>
      <View style={styles.emptyIcon}>
        <IconPlay size={48} color="#555" />
      </View>
      <Text style={styles.emptyTitle}>
        {t('feed.noReels') || 'Sem reels ainda'}
      </Text>
      <Text style={styles.emptySubtext}>
        {t('feed.noReelsHint') || 'Videos aparecerao aqui'}
      </Text>
    </View>
  );
}

// ── Main ReelsViewer ──
export default function ReelsViewer({ colors, isDark, t, user, router }) {
  const [reelTab, setReelTab] = useState('forYou'); // 'forYou' | 'following'
  const [reels, setReels] = useState([]);
  const [followingReels, setFollowingReels] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [commentsReel, setCommentsReel] = useState(null);
  const [likersReel, setLikersReel] = useState(null);
  const [containerHeight, setContainerHeight] = useState(SCREEN_HEIGHT);

  const viewConfigRef = useRef({ viewAreaCoveragePercentThreshold: 50 });
  const onViewableRef = useRef(({ viewableItems }) => {
    if (viewableItems && viewableItems[0]) {
      setCurrentIndex(viewableItems[0].index);
    }
  });
  const listRef = useRef(null);

  useEffect(() => {
    loadReels();
  }, []);

  const loadReels = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const r = await api.feedList(1, 50);
      if (r && r.success && r.data) {
        const rawPosts = r.data.posts || r.data;
        const allPosts = Array.isArray(rawPosts) ? rawPosts : [];
        const videos = allPosts.filter(p => {
          if (p.media_type === 'video') return true;
          const urls = parseMediaUrls(p.media_urls);
          return urls.some(u => typeof u === 'string' && (u.endsWith('.mp4') || u.endsWith('.mov') || u.endsWith('.webm')));
        });
        setReels(videos);
        // Filter following reels (posts from users the current user follows)
        const following = videos.filter(p => p.is_following || p.author_email === user?.email);
        setFollowingReels(following);
      }
    } catch (e) {
      console.warn('Reels load error:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = useCallback(() => loadReels(true), []);

  const handleOpenComments = useCallback((reel) => {
    setCommentsReel(reel);
  }, []);

  const handleOpenLikers = useCallback((reel) => {
    setLikersReel(reel);
  }, []);

  const onLayout = useCallback((e) => {
    const h = e.nativeEvent.layout.height;
    if (h > 0) setContainerHeight(h);
  }, []);

  const activeReels = reelTab === 'following' ? followingReels : reels;

  // Reset index when switching tabs
  const handleTabChange = useCallback((tab) => {
    setReelTab(tab);
    setCurrentIndex(0);
    if (listRef.current) {
      try { listRef.current.scrollToOffset({ offset: 0, animated: false }); } catch {}
    }
  }, []);

  const handleOpenProfile = useCallback((email) => {
    if (!email || !router) return;
    router.push(`/u/${encodeURIComponent(email)}`);
  }, [router]);

  const overlayOpen = !!commentsReel || !!likersReel;
  const renderItem = useCallback(({ item, index }) => (
    <ReelItem
      reel={item}
      isActive={index === currentIndex}
      colors={colors}
      isDark={isDark}
      t={t}
      user={user}
      containerHeight={containerHeight}
      onOpenComments={handleOpenComments}
      onOpenLikers={handleOpenLikers}
      onOpenProfile={handleOpenProfile}
      overlayOpen={overlayOpen}
    />
  ), [currentIndex, colors, isDark, t, user, containerHeight, handleOpenComments, handleOpenLikers, handleOpenProfile, overlayOpen]);

  const keyExtractor = useCallback((item) => String(item.id), []);

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#fff" />
      </View>
    );
  }

  if (reels.length === 0) {
    return (
      <View style={styles.loadingContainer}>
        <EmptyReels colors={colors} isDark={isDark} t={t} />
      </View>
    );
  }

  return (
    <View style={styles.reelsRoot} onLayout={onLayout}>
      {/* Following / For You tabs overlaying the top */}
      <View style={styles.reelTabBar} pointerEvents="box-none">
        <TouchableOpacity
          onPress={() => handleTabChange('following')}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={[
            styles.reelTabText,
            reelTab === 'following' && styles.reelTabTextActive,
          ]}>
            {t('feed.followingReels') || 'Following'}
          </Text>
          {reelTab === 'following' && <View style={styles.reelTabIndicator} />}
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => handleTabChange('forYou')}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={[
            styles.reelTabText,
            reelTab === 'forYou' && styles.reelTabTextActive,
          ]}>
            {t('feed.forYou') || 'For You'}
          </Text>
          {reelTab === 'forYou' && <View style={styles.reelTabIndicator} />}
        </TouchableOpacity>
      </View>

      <FlatList
        ref={listRef}
        data={activeReels}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        pagingEnabled
        showsVerticalScrollIndicator={false}
        snapToInterval={containerHeight}
        snapToAlignment="start"
        decelerationRate="fast"
        onViewableItemsChanged={onViewableRef.current}
        viewabilityConfig={viewConfigRef.current}
        getItemLayout={(data, index) => ({
          length: containerHeight,
          offset: containerHeight * index,
          index,
        })}
        initialNumToRender={2}
        maxToRenderPerBatch={3}
        windowSize={3}
        removeClippedSubviews={Platform.OS !== 'web'}
        onRefresh={handleRefresh}
        refreshing={refreshing}
        ListEmptyComponent={
          // Surface an empty state for *every* tab — silently rendering
          // null on Discover/For You looked like a hung load. Copy varies
          // by tab; icon adapts to dark mode contrast (was hardcoded #555).
          <View style={[styles.loadingContainer, { height: containerHeight }]}>
            <View style={styles.emptyIcon}>
              <IconPlay size={48} color="rgba(255,255,255,0.55)" />
            </View>
            <Text style={styles.emptyTitle}>
              {reelTab === 'following'
                ? (t('feed.noFollowingReels') || 'No reels from people you follow')
                : (t('feed.noReels') || 'Sem reels por aqui')}
            </Text>
            <Text style={styles.emptySubtext}>
              {reelTab === 'following'
                ? (t('feed.noFollowingReelsHint') || 'Follow people to see their reels here')
                : (t('feed.noReelsHint') || 'Volte mais tarde — novos reels chegam o tempo todo.')}
            </Text>
          </View>
        }
      />

      {/* Comments bottom sheet */}
      <CommentsSheet
        visible={!!commentsReel}
        post={commentsReel}
        colors={colors}
        isDark={isDark}
        t={t}
        user={user}
        onClose={() => setCommentsReel(null)}
      />

      {/* Likers bottom sheet */}
      <LikersSheet
        visible={!!likersReel}
        post={likersReel}
        colors={colors}
        isDark={isDark}
        t={t}
        onClose={() => setLikersReel(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // ── Root ──
  reelsRoot: {
    flex: 1,
    backgroundColor: '#000',
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  reelContainer: {
    backgroundColor: '#000',
    position: 'relative',
    overflow: 'hidden',
  },

  // ── Gradient overlays ──
  topGradient: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 120,
    background: isWeb ? 'linear-gradient(to bottom, rgba(0,0,0,0.4) 0%, transparent 100%)' : undefined,
    backgroundColor: isWeb ? undefined : 'transparent',
    zIndex: 1,
  },
  bottomGradient: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 300,
    background: isWeb ? 'linear-gradient(to top, rgba(0,0,0,0.6) 0%, transparent 100%)' : undefined,
    backgroundColor: isWeb ? undefined : 'transparent',
    zIndex: 1,
  },

  // ── Top bar ──
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'ios' ? 54 : 16,
    paddingBottom: 12,
    zIndex: 10,
  },
  topTitle: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: 0.3,
    ...TEXT_SHADOW,
  },

  // ── Pause flash ──
  pauseFlashOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 5,
  },
  pauseFlashCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── Heart animation ──
  heartAnimOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
  },

  // ── Right sidebar ──
  rightSidebar: {
    position: 'absolute',
    right: 12,
    bottom: 100,
    alignItems: 'center',
    zIndex: 10,
    gap: 20,
  },
  profileAvatarBtn: {
    alignItems: 'center',
    marginBottom: 4,
  },
  profileAvatarRing: {
    borderWidth: 2,
    borderColor: '#fff',
    borderRadius: 20,
    padding: 1,
    overflow: 'hidden',
  },
  profileFollowBadge: {
    position: 'absolute',
    bottom: -6,
    backgroundColor: '#FF2D55',
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#000',
  },
  profileFollowPlus: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '800',
    lineHeight: 15,
    marginTop: -1,
  },
  sidebarBtn: {
    alignItems: 'center',
    gap: 3,
  },
  sidebarCount: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    ...TEXT_SHADOW,
  },

  // ── Spinning album art ──
  albumArt: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 8,
    borderColor: '#333',
    backgroundColor: '#1a1a1a',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
    overflow: 'hidden',
  },
  albumArtInner: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#222',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  albumArtCenter: {
    width: 18,
    height: 18,
    borderRadius: 9,
    overflow: 'hidden',
  },

  // ── Bottom info ──
  bottomInfo: {
    position: 'absolute',
    bottom: 24,
    left: 14,
    right: 72,
    zIndex: 10,
    gap: 8,
  },
  username: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
    ...TEXT_SHADOW,
  },
  caption: {
    color: '#fff',
    fontSize: 14,
    lineHeight: 19,
    ...TEXT_SHADOW,
  },
  moreText: {
    color: 'rgba(255,255,255,0.65)',
    fontSize: 14,
    fontWeight: '500',
    marginTop: 2,
  },

  // ── Music row ──
  musicRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  marqueeContainer: {
    flex: 1,
    overflow: 'hidden',
    height: 18,
  },
  marqueeTrack: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  marqueeText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '400',
    ...TEXT_SHADOW,
  },

  // ── Subtitle overlay (TikTok-style auto-caption) ──
  subtitleOverlay: {
    position: 'absolute',
    bottom: 180,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: 24,
    zIndex: 12,
  },
  subtitleBg: {
    maxWidth: '78%',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  subtitleText: {
    color: '#fff',
    fontSize: 16,
    lineHeight: 21,
    fontWeight: '600',
    textAlign: 'center',
    letterSpacing: 0.1,
    textShadowColor: 'rgba(0,0,0,0.85)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },

  // ── Progress bar ──
  progressBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.18)',
    zIndex: 15,
  },
  // Progress fill on web gets a tasty cyan→white→cyan gradient with a
  // soft glow at the leading edge, signalling "watch progress" with a
  // tech feel instead of a flat white bar. Native still uses solid
  // white (RN Animated doesn't render gradient inline cheaply).
  progressFill: {
    height: '100%',
    backgroundColor: '#fff',
    borderRadius: 1.5,
    ...(isWeb ? {
      backgroundImage: 'linear-gradient(90deg, rgba(255,255,255,0.85) 0%, #fff 50%, rgba(124,58,237,0.95) 100%)',
      boxShadow: '0 0 10px rgba(255,255,255,0.6), 0 0 18px rgba(124,58,237,0.4)',
    } : {}),
  },

  // ── Empty state ──
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  emptyIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 2,
    borderColor: '#333',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#fff',
  },
  emptySubtext: {
    color: '#666',
    fontSize: 14,
  },

  // ── Comments sheet (dark themed) ──
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  sheetContainer: {
    backgroundColor: '#1c1c1e',
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    maxHeight: SCREEN_HEIGHT * 0.6,
    minHeight: 300,
  },
  sheetHandle: {
    alignItems: 'center',
    paddingVertical: 10,
  },
  // Why: handle bar grew (36×4 → 44×5) so the drag affordance reads more
  // substantial — TikTok/Instagram both use ~44px. Header title bumped from
  // 15 → 16.5 with negative letter-spacing for the polished sheet look.
  sheetHandleBar: {
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.1)',
  },
  sheetTitle: {
    fontSize: 16.5,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: -0.3,
  },
  sheetLoading: {
    padding: 40,
    alignItems: 'center',
  },
  sheetEmpty: {
    padding: 40,
    alignItems: 'center',
  },
  sheetEmptyText: {
    fontSize: 14,
    color: '#888',
  },
  sheetList: {
    maxHeight: SCREEN_HEIGHT * 0.35,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  commentRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 16,
  },
  commentContent: {
    flex: 1,
  },
  commentAuthor: {
    fontSize: 13.5,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: -0.15,
    lineHeight: 19,
  },
  commentText: {
    fontWeight: '400',
    color: 'rgba(255,255,255,0.88)',
    letterSpacing: -0.05,
  },
  commentTime: {
    fontSize: 11.5,
    marginTop: 4,
    color: 'rgba(255,255,255,0.55)',
    fontWeight: '500',
    letterSpacing: 0.1,
  },
  sheetInput: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.1)',
    backgroundColor: '#1c1c1e',
  },
  // Why: input pill enlarged (radius 20→22, padX 14→16) so it reads more like
  // a chat input than a search box. Web transition smooths the focus tint.
  sheetTextInput: {
    flex: 1,
    fontSize: 14,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 22,
    color: '#fff',
    backgroundColor: 'rgba(255,255,255,0.10)',
    ...(Platform.OS === 'web' ? { outlineStyle: 'none', transition: 'background-color 180ms ease' } : {}),
  },

  // ── Reel tab bar (Following / For You) ──
  reelTabBar: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 54 : 16,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 28,
    zIndex: 20,
    paddingVertical: 8,
  },
  reelTabText: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  reelTabTextActive: {
    color: '#fff',
    fontWeight: '700',
  },
  reelTabIndicator: {
    width: 24,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: '#fff',
    alignSelf: 'center',
    marginTop: 4,
  },
});
