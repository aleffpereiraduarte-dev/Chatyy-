import { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Platform,
  Modal, TextInput, Image, Animated, Dimensions, KeyboardAvoidingView,
  ActivityIndicator, PanResponder, Pressable,
} from 'react-native';
import AvatarCircle from './AvatarCircle';
import { IconPlus, IconCamera, IconEdit, IconX, IconSearch, IconTrash, IconEye, IconChevronLeft, IconChevronRight, IconSend } from './Icons';
import * as api from '../services/api';
import { BASE_URL, chatCreate, chatSend, statusViewers, emailToDisplayName } from '../services/api';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const STATUS_DURATION = 5000;
const ACCENT = '#25D366';
const GRADIENT_COLORS = ['#25D366', '#128C7E', '#075E54'];

function timeAgo(dateStr, t) {
  if (!dateStr) return '';
  const str = dateStr.endsWith('Z') || dateStr.includes('+') ? dateStr : dateStr + 'Z';
  const now = Date.now();
  const then = new Date(str).getTime();
  const diffMs = now - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return t?.('time.now') || 'now';
  if (mins < 60) return (t?.('time.min') || '{n} min').replace('{n}', mins);
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return (t?.('time.hours') || '{n}h').replace('{n}', hrs);
  return `${Math.floor(hrs / 24)}d`;
}

const TEXT_BG_COLORS = [
  '#075E54', '#128C7E', '#25D366', '#1A73E8', '#6B5CE7',
  '#E84393', '#D63031', '#E17055', '#FDCB6E', '#00B894',
];

function EmptyStatusIllustration({ isDark }) {
  const Svg = require('react-native-svg').default;
  const { Circle, Path, Rect } = require('react-native-svg');
  return (
    <Svg width={120} height={120} viewBox="0 0 100 100" fill="none">
      <Circle cx="50" cy="50" r="35" stroke={isDark ? '#374151' : '#e5e7eb'} strokeWidth="2" strokeDasharray="8 4" />
      <Rect x="38" y="35" width="24" height="30" rx="4" stroke={isDark ? '#4b5563' : '#9ca3af'} strokeWidth="2" fill="none" />
      <Circle cx="50" cy="47" r="5" stroke={isDark ? '#4b5563' : '#9ca3af'} strokeWidth="1.5" fill="none" />
      <Path d="M38 58 L44 52 L48 56 L54 48 L62 58" stroke={isDark ? '#4b5563' : '#9ca3af'} strokeWidth="1.5" fill="none" strokeLinejoin="round" />
      <Path d="M68 30 L72 26" stroke={ACCENT} strokeWidth="2" strokeLinecap="round" />
      <Path d="M72 34 L76 34" stroke={ACCENT} strokeWidth="2" strokeLinecap="round" />
      <Path d="M68 38 L72 42" stroke={ACCENT} strokeWidth="2" strokeLinecap="round" />
    </Svg>
  );
}

/** Renders a segmented ring around an avatar (one arc per status item) */
function SegmentedRing({ items, size, viewed }) {
  const Svg = require('react-native-svg').default;
  const { Circle, Defs, LinearGradient, Stop } = require('react-native-svg');
  const count = items?.length || 1;
  const ringSize = size + 10;
  const radius = (ringSize / 2) - 3;
  const circumference = 2 * Math.PI * radius;
  const gapDeg = count > 1 ? 6 : 0;
  const totalGapDeg = gapDeg * count;
  const segmentDeg = (360 - totalGapDeg) / count;
  const segmentLen = (segmentDeg / 360) * circumference;
  const gapLen = (gapDeg / 360) * circumference;

  return (
    <View style={{ position: 'absolute', top: -5, left: -5 }}>
      <Svg width={ringSize} height={ringSize}>
        <Defs>
          <LinearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor="#25D366" />
            <Stop offset="0.5" stopColor="#128C7E" />
            <Stop offset="1" stopColor="#075E54" />
          </LinearGradient>
        </Defs>
        {Array.from({ length: count }).map((_, i) => {
          const isViewed = viewed || items?.[i]?.viewed;
          const offset = -((segmentLen + gapLen) * i) + (circumference * 0.25);
          return (
            <Circle
              key={i}
              cx={ringSize / 2}
              cy={ringSize / 2}
              r={radius}
              stroke={isViewed ? 'rgba(150,150,150,0.35)' : 'url(#ringGrad)'}
              strokeWidth={3}
              fill="none"
              strokeDasharray={`${segmentLen} ${circumference - segmentLen}`}
              strokeDashoffset={offset}
              strokeLinecap="round"
            />
          );
        })}
      </Svg>
    </View>
  );
}

/** Horizontal story-style avatar scroller */
function StoryScroller({ statuses, myStatuses, currentEmail, currentName, onOpenViewer, onOpenCreator, isDark, colors, t }) {
  const hasMyStatus = myStatuses.length > 0;
  const myStatusGroup = hasMyStatus
    ? { ownerEmail: currentEmail, ownerName: currentName, items: myStatuses }
    : null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.storyScroller}
      style={styles.storyScrollerContainer}
    >
      {/* My status always first */}
      <TouchableOpacity
        style={styles.storyItem}
        onPress={() => hasMyStatus ? onOpenViewer(myStatusGroup) : onOpenCreator()}
        activeOpacity={0.7}
      >
        <View style={styles.storyAvatarWrap}>
          {hasMyStatus && <SegmentedRing items={myStatuses} size={62} viewed={false} />}
          <AvatarCircle name={currentName} email={currentEmail} size={62} />
          {!hasMyStatus && (
            <View style={[styles.storyPlusBadge, {
              borderColor: isDark ? '#1a1a2e' : '#fff',
            }]}>
              <IconPlus size={14} color="#fff" />
            </View>
          )}
        </View>
        <Text style={[styles.storyName, { color: colors.text }]} numberOfLines={1}>
          {t?.('status.myStatus') || 'My status'}
        </Text>
      </TouchableOpacity>

      {/* Contact statuses */}
      {statuses.map((group) => {
        const allViewed = group.items.every((item) => item.viewed);
        return (
          <TouchableOpacity
            key={group.ownerEmail}
            style={styles.storyItem}
            onPress={() => onOpenViewer(group)}
            activeOpacity={0.7}
          >
            <View style={styles.storyAvatarWrap}>
              <SegmentedRing items={group.items} size={62} viewed={allViewed} />
              <AvatarCircle name={group.ownerName} email={group.ownerEmail} size={62} />
            </View>
            <Text style={[styles.storyName, { color: allViewed ? colors.textSecondary : colors.text }]} numberOfLines={1}>
              {group.ownerName}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}


export default function ChatStatusTab({ colors, isDark, t, user, router }) {
  const [contactStatuses, setContactStatuses] = useState([]);
  const [myStatuses, setMyStatuses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);

  // Viewer state
  const [viewerVisible, setViewerVisible] = useState(false);
  const [viewerStatuses, setViewerStatuses] = useState([]);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [viewerOwnerName, setViewerOwnerName] = useState('');
  const [viewerOwnerEmail, setViewerOwnerEmail] = useState('');
  const [viewerReply, setViewerReply] = useState('');
  const [isPaused, setIsPaused] = useState(false);
  const progressAnim = useRef(new Animated.Value(0)).current;
  const timerRef = useRef(null);
  const animRef = useRef(null);
  const viewerOpacity = useRef(new Animated.Value(0)).current;

  // Viewers modal state
  const [viewersModal, setViewersModal] = useState(false);
  const [viewersList, setViewersList] = useState([]);
  const [viewersLoading, setViewersLoading] = useState(false);

  const handleShowViewers = useCallback(async (statusId) => {
    setViewersLoading(true);
    setViewersModal(true);
    setIsPaused(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (animRef.current) animRef.current.stop();
    try {
      const r = await statusViewers(statusId);
      if (r.success && r.data?.viewers) {
        setViewersList(r.data.viewers);
      }
    } catch (err) {
      console.warn('[Status] Failed to load viewers:', err);
    } finally {
      setViewersLoading(false);
    }
  }, []);

  // Creator state
  const [creatorVisible, setCreatorVisible] = useState(false);
  const [creatorMode, setCreatorMode] = useState('text');
  const [textContent, setTextContent] = useState('');
  const [textBgColor, setTextBgColor] = useState(TEXT_BG_COLORS[0]);
  const [photoUri, setPhotoUri] = useState(null);
  const [photoFile, setPhotoFile] = useState(null);
  const [publishing, setPublishing] = useState(false);
  const [sendingReply, setSendingReply] = useState(false);

  const currentEmail = user?.email || '';
  const currentName = user?.name || user?.email?.split('@')[0] || '';

  // Reply to a status — sends a chat message to the status owner (WhatsApp-style)
  const handleStatusReply = useCallback(async () => {
    const text = viewerReply.trim();
    if (!text || sendingReply || !viewerOwnerEmail) return;
    setSendingReply(true);
    try {
      // Find or create direct conversation with status owner
      const createRes = await chatCreate([viewerOwnerEmail], '', 'direct');
      const convId = createRes?.data?.conversation_id || createRes?.data?.id;
      if (!convId) throw new Error('No conversation');

      // Build reply message with status reference (include image if photo status)
      const currentItem = viewerStatuses[viewerIndex];
      const statusType = currentItem?.type || 'text';

      if (statusType === 'image' && currentItem?.content) {
        // For image status: send the image first, then the reply text
        const imgUrl = (currentItem.content || '').split('\n')[0];
        const fullUrl = imgUrl.startsWith('/') ? BASE_URL + imgUrl : imgUrl;
        const caption = (currentItem.content || '').includes('\n')
          ? (currentItem.content.split('\n').slice(1).join('\n')).trim() : '';
        const statusLabel = `↩️ ${t?.('status.replyToStatus') || 'Respondeu ao seu status'}`;
        const replyMsg = caption
          ? `${statusLabel}:\n"${caption}"\n\n📷 ${fullUrl}\n\n${text}`
          : `${statusLabel}:\n\n📷 ${fullUrl}\n\n${text}`;
        await chatSend(convId, replyMsg, 'text');
      } else {
        // Text status: quote the text
        const statusPreview = (currentItem?.content || '').substring(0, 80);
        const replyMsg = `↩️ ${t?.('status.replyToStatus') || 'Respondeu ao seu status'}: "${statusPreview}"\n\n${text}`;
        await chatSend(convId, replyMsg, 'text');
      }

      setViewerReply('');
    } catch (err) {
      console.warn('[Status] Reply failed:', err);
    } finally {
      setSendingReply(false);
    }
  }, [viewerReply, sendingReply, viewerOwnerEmail, viewerStatuses, viewerIndex, t]);

  // Swipe down to dismiss
  const panY = useRef(new Animated.Value(0)).current;
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, gs) => gs.dy > 10 && Math.abs(gs.dy) > Math.abs(gs.dx) * 1.5,
      onPanResponderMove: (_, gs) => {
        if (gs.dy > 0) panY.setValue(gs.dy);
      },
      onPanResponderRelease: (_, gs) => {
        if (gs.dy > 120) {
          closeViewer();
        } else {
          Animated.spring(panY, { toValue: 0, useNativeDriver: false, tension: 40 }).start();
        }
      },
    })
  ).current;

  // Load statuses from API
  const loadStatuses = useCallback(async () => {
    try {
      const r = await api.statusList();
      if (r.success && r.data) {
        const mine = [];
        const others = [];
        const groups = r.data.statuses || r.data;
        const groupList = Array.isArray(groups) ? groups : [];
        for (const group of groupList) {
          if (group.email === currentEmail) {
            mine.push(...(group.items || []).map(item => ({
              ...item,
              bgColor: item.bg_color || item.bgColor || '#075E54',
              timestamp: item.created_at,
            })));
          } else {
            others.push({
              ownerEmail: group.email,
              ownerName: group.name || group.email.split('@')[0],
              items: (group.items || []).map(item => ({
                ...item,
                bgColor: item.bg_color || item.bgColor || '#075E54',
                timestamp: item.created_at,
              })),
            });
          }
        }
        setMyStatuses(mine);
        setContactStatuses(others);
      }
    } catch {} finally {
      setLoading(false);
    }
  }, [currentEmail]);

  useEffect(() => {
    loadStatuses();
    const interval = setInterval(loadStatuses, 30000);
    return () => clearInterval(interval);
  }, [loadStatuses]);

  // Filter by search
  const filteredStatuses = contactStatuses.filter((s) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return s.ownerName.toLowerCase().includes(q) || s.ownerEmail.toLowerCase().includes(q);
  });

  const recentStatuses = filteredStatuses.filter(
    (s) => !s.items.every((item) => item.viewed)
  );
  const viewedStatuses = filteredStatuses.filter(
    (s) => s.items.every((item) => item.viewed)
  );

  // ─── Viewer Logic ───
  const openViewer = useCallback((statusGroup) => {
    setViewerStatuses(statusGroup.items);
    setViewerOwnerName(statusGroup.ownerName);
    setViewerOwnerEmail(statusGroup.ownerEmail);
    setViewerIndex(0);
    setViewerReply('');
    setIsPaused(false);
    panY.setValue(0);
    viewerOpacity.setValue(0);
    setViewerVisible(true);
    Animated.timing(viewerOpacity, { toValue: 1, duration: 250, useNativeDriver: false }).start();
  }, [viewerOpacity, panY]);

  const closeViewer = useCallback(() => {
    Animated.timing(viewerOpacity, { toValue: 0, duration: 200, useNativeDriver: false }).start(() => {
      setViewerVisible(false);
    });
    if (timerRef.current) clearTimeout(timerRef.current);
    if (animRef.current) animRef.current.stop();
    progressAnim.setValue(0);
    panY.setValue(0);
    loadStatuses();
  }, [progressAnim, viewerOpacity, panY, loadStatuses]);

  const advanceViewer = useCallback(() => {
    const currentItem = viewerStatuses[viewerIndex];
    if (currentItem && !currentItem.viewed) {
      api.statusView(currentItem.id).catch(() => {});
      setViewerStatuses(prev => prev.map((s, idx) => idx === viewerIndex ? { ...s, viewed: true } : s));
    }

    if (viewerIndex < viewerStatuses.length - 1) {
      setViewerIndex((prev) => prev + 1);
    } else {
      closeViewer();
    }
  }, [viewerStatuses, viewerIndex, closeViewer]);

  const goBackViewer = useCallback(() => {
    if (viewerIndex > 0) {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (animRef.current) animRef.current.stop();
      setViewerIndex(prev => prev - 1);
    }
  }, [viewerIndex]);

  useEffect(() => {
    if (!viewerVisible || viewerStatuses.length === 0 || isPaused) return;

    progressAnim.setValue(0);
    const anim = Animated.timing(progressAnim, {
      toValue: 1,
      duration: STATUS_DURATION,
      useNativeDriver: false,
    });
    animRef.current = anim;
    anim.start();

    timerRef.current = setTimeout(advanceViewer, STATUS_DURATION);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      anim.stop();
    };
  }, [viewerVisible, viewerIndex, viewerStatuses.length, isPaused]);

  // Tap left half = previous, right half = next
  const handleViewerTap = useCallback((evt) => {
    const tapX = evt?.nativeEvent?.locationX || evt?.nativeEvent?.pageX || SCREEN_WIDTH / 2;
    if (timerRef.current) clearTimeout(timerRef.current);
    if (animRef.current) animRef.current.stop();

    if (tapX < SCREEN_WIDTH * 0.3) {
      goBackViewer();
    } else {
      advanceViewer();
    }
  }, [advanceViewer, goBackViewer]);

  // Long press = pause
  const handleLongPress = useCallback(() => {
    setIsPaused(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (animRef.current) animRef.current.stop();
  }, []);

  const handlePressOut = useCallback(() => {
    if (isPaused) setIsPaused(false);
  }, [isPaused]);

  // ─── Creator Logic ───
  const openCreator = useCallback((mode = 'text') => {
    setTextContent('');
    setPhotoUri(null);
    setPhotoFile(null);
    setCreatorMode(mode);
    setTextBgColor(TEXT_BG_COLORS[Math.floor(Math.random() * TEXT_BG_COLORS.length)]);
    if (mode === 'photo') {
      if (Platform.OS === 'web') {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = (e) => {
          const file = e.target.files?.[0];
          if (file) {
            setPhotoFile(file);
            setPhotoUri(URL.createObjectURL(file));
            setCreatorVisible(true);
          }
        };
        input.click();
      } else {
        import('expo-image-picker').then(({ launchImageLibraryAsync, MediaTypeOptions }) => {
          launchImageLibraryAsync({ mediaTypes: MediaTypeOptions.Images, quality: 0.8 }).then(result => {
            if (!result.canceled && result.assets?.[0]) {
              const asset = result.assets[0];
              setPhotoUri(asset.uri);
              setPhotoFile({ uri: asset.uri, name: 'status.jpg', type: asset.mimeType || 'image/jpeg' });
              setCreatorVisible(true);
            }
          });
        });
      }
    } else {
      setCreatorVisible(true);
    }
  }, []);

  const publishStatus = useCallback(async () => {
    if (publishing) return;
    if (creatorMode === 'text' && !textContent.trim()) return;
    if (creatorMode === 'photo' && !photoFile) return;

    setPublishing(true);
    try {
      if (creatorMode === 'photo' && photoFile) {
        const uploadR = await api.statusUpload(photoFile);
        if (uploadR.success && uploadR.data?.url) {
          const caption = textContent.trim();
          const content = caption ? uploadR.data.url + '\n' + caption : uploadR.data.url;
          const r = await api.statusPublish(content, 'image', '#000000');
          if (r.success) { setCreatorVisible(false); loadStatuses(); }
        }
      } else {
        const r = await api.statusPublish(textContent.trim(), 'text', textBgColor);
        if (r.success) { setCreatorVisible(false); setTextContent(''); loadStatuses(); }
      }
    } catch {} finally {
      setPublishing(false);
    }
  }, [textContent, textBgColor, creatorMode, photoFile, publishing, loadStatuses]);

  const deleteMyStatus = useCallback(async (statusId) => {
    try {
      await api.statusDelete(statusId);
      setMyStatuses(prev => prev.filter(s => s.id !== statusId));
    } catch {}
  }, []);

  // ─── Labels ───
  const hasMyStatus = myStatuses.length > 0;
  const myStatusGroup = hasMyStatus
    ? { ownerEmail: currentEmail, ownerName: currentName, items: myStatuses }
    : null;

  const myStatusLabel = t?.('status.myStatus') || 'Meu status';
  const addStatusLabel = t?.('status.tapToAdd') || 'Toque para adicionar status';
  const disappearsLabel = t?.('status.disappears') || 'Desaparece em 24 horas';
  const recentLabel = t?.('status.recentUpdates') || 'Atualizacoes recentes';
  const viewedLabel = t?.('status.viewed') || 'Visualizados';
  const typePlaceholder = t?.('status.typeSomething') || 'Digite um status...';
  const emptyLabel = t?.('status.noUpdates') || 'Nenhuma atualizacao recente';

  const isOwnStatus = viewerOwnerEmail === currentEmail;
  const currentViewerItem = viewerStatuses[viewerIndex];

  const renderStatusRow = (statusGroup) => {
    const latestItem = statusGroup.items[statusGroup.items.length - 1];
    const time = timeAgo(latestItem?.timestamp, t);
    const allViewed = statusGroup.items.every((item) => item.viewed);
    const count = statusGroup.items.length;

    return (
      <TouchableOpacity
        key={statusGroup.ownerEmail}
        style={[styles.statusRow, { backgroundColor: isDark ? colors.card : '#fff' }]}
        onPress={() => openViewer(statusGroup)}
        activeOpacity={0.7}
      >
        <View style={styles.avatarWrapper}>
          <SegmentedRing items={statusGroup.items} size={52} viewed={allViewed} />
          <AvatarCircle name={statusGroup.ownerName} email={statusGroup.ownerEmail} size={52} />
        </View>
        <View style={styles.statusInfo}>
          <Text style={[styles.statusName, { color: colors.text }]} numberOfLines={1}>
            {statusGroup.ownerName}
          </Text>
          <View style={styles.statusMeta}>
            <Text style={[styles.statusTime, { color: colors.textSecondary }]}>{time}</Text>
            {count > 1 && (
              <View style={[styles.countPill, { backgroundColor: isDark ? '#2d3748' : '#f0f0f0' }]}>
                <Text style={[styles.countPillText, { color: colors.textSecondary }]}>{count}</Text>
              </View>
            )}
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={ACCENT} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: isDark ? colors.background : '#f6f8fa' }]}>
      {/* Search */}
      {showSearch && (
        <View style={[styles.searchBar, {
          backgroundColor: isDark ? colors.card : '#fff',
        }]}>
          <IconSearch size={18} color={colors.textSecondary} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder={t?.('search.placeholder') || 'Pesquisar...'}
            placeholderTextColor={colors.textSecondary}
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoFocus
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')}>
              <IconX size={18} color={colors.textSecondary} />
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={() => { setShowSearch(false); setSearchQuery(''); }} style={{ marginLeft: 8 }}>
            <IconX size={20} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
      )}

      {!showSearch && (
        <View style={styles.inlineSearchRow}>
          <TouchableOpacity
            style={[styles.searchToggle, {
              backgroundColor: isDark ? colors.card : '#fff',
            }]}
            onPress={() => setShowSearch(true)}
          >
            <IconSearch size={18} color={colors.textSecondary} />
            <Text style={[styles.searchToggleText, { color: colors.textSecondary }]}>
              {t?.('search.placeholder') || 'Pesquisar...'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        {/* Horizontal story scroller */}
        {(filteredStatuses.length > 0 || hasMyStatus) && (
          <StoryScroller
            statuses={filteredStatuses}
            myStatuses={myStatuses}
            currentEmail={currentEmail}
            currentName={currentName}
            onOpenViewer={openViewer}
            onOpenCreator={openCreator}
            isDark={isDark}
            colors={colors}
            t={t}
          />
        )}

        {/* My Status Card */}
        <View style={[styles.myStatusCard, {
          backgroundColor: isDark ? colors.card : '#fff',
          ...(Platform.OS === 'web' ? { boxShadow: '0 2px 12px rgba(0,0,0,0.08)' } : {}),
        }]}>
          <TouchableOpacity
            style={styles.myStatusRow}
            onPress={() => hasMyStatus ? openViewer(myStatusGroup) : openCreator()}
            activeOpacity={0.7}
          >
            <View style={styles.myAvatarWrapper}>
              {hasMyStatus && (
                <SegmentedRing items={myStatuses} size={56} viewed={false} />
              )}
              <AvatarCircle name={currentName} email={currentEmail} size={56} />
              {!hasMyStatus && (
                <View style={[styles.plusBadge, {
                  borderColor: isDark ? colors.card : '#fff',
                }]}>
                  <IconPlus size={14} color="#fff" />
                </View>
              )}
            </View>
            <View style={styles.statusInfo}>
              <Text style={[styles.myStatusName, { color: colors.text }]}>
                {myStatusLabel}
              </Text>
              <Text style={[styles.myStatusSub, { color: colors.textSecondary }]}>
                {hasMyStatus
                  ? `${myStatuses.length} ${myStatuses.length > 1 ? 'status' : 'status'} - ${timeAgo(myStatuses[myStatuses.length - 1]?.timestamp, t)}`
                  : addStatusLabel
                }
              </Text>
            </View>
            <View style={styles.myStatusActions}>
              {hasMyStatus && (
                <TouchableOpacity
                  style={[styles.actionCircle, { backgroundColor: isDark ? '#3a1c1e' : '#fce4ec' }]}
                  onPress={() => {
                    const last = myStatuses[myStatuses.length - 1];
                    if (last) deleteMyStatus(last.id);
                  }}
                >
                  <IconTrash size={18} color="#D63031" />
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[styles.actionCircle, {
                  backgroundColor: isDark ? '#1a332a' : '#e8f5e9',
                  marginLeft: hasMyStatus ? 10 : 0,
                }]}
                onPress={openCreator}
              >
                <IconEdit size={20} color={ACCENT} />
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </View>

        {/* Recent Updates */}
        {recentStatuses.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <View style={styles.sectionAccent} />
              <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>{recentLabel}</Text>
              <Text style={[styles.sectionCount, { color: colors.textSecondary }]}>{recentStatuses.length}</Text>
            </View>
            {recentStatuses.map((s) => renderStatusRow(s))}
          </View>
        )}

        {/* Viewed */}
        {viewedStatuses.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <View style={[styles.sectionAccent, { backgroundColor: isDark ? '#555' : '#bbb' }]} />
              <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>{viewedLabel}</Text>
              <Text style={[styles.sectionCount, { color: colors.textSecondary }]}>{viewedStatuses.length}</Text>
            </View>
            {viewedStatuses.map((s) => renderStatusRow(s))}
          </View>
        )}

        {/* Empty state */}
        {recentStatuses.length === 0 && viewedStatuses.length === 0 && !hasMyStatus && (
          <View style={styles.emptyContainer}>
            <EmptyStatusIllustration isDark={isDark} />
            <Text style={[styles.emptyText, { color: colors.text }]}>{emptyLabel}</Text>
            <Text style={[styles.emptySubtext, { color: colors.textSecondary }]}>{disappearsLabel}</Text>
            <TouchableOpacity
              style={styles.emptyButton}
              onPress={() => openCreator()}
              activeOpacity={0.8}
            >
              <IconPlus size={18} color="#fff" />
              <Text style={styles.emptyButtonText}>{t?.('status.addStatus') || 'Adicionar status'}</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={{ height: 120 }} />
      </ScrollView>

      {/* FABs */}
      <TouchableOpacity
        style={[styles.fabSecondary, {
          backgroundColor: isDark ? '#2a2e2b' : '#fff',
          ...(Platform.OS === 'web' ? { boxShadow: '0 3px 12px rgba(0,0,0,0.12)' } : {}),
        }]}
        onPress={() => openCreator('photo')}
        activeOpacity={0.8}
      >
        <IconCamera size={22} color={ACCENT} />
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.fab, Platform.OS === 'web' && { boxShadow: '0 4px 14px rgba(37,211,102,0.4), 0 2px 6px rgba(0,0,0,0.1)' }]}
        onPress={() => openCreator('text')}
        activeOpacity={0.8}
      >
        <IconEdit size={24} color="#fff" />
      </TouchableOpacity>

      {/* ─── Full-Screen Status Viewer Modal ─── */}
      <Modal visible={viewerVisible} animationType="none" transparent statusBarTranslucent onRequestClose={closeViewer}>
        <Animated.View
          style={[styles.viewerContainer, { opacity: viewerOpacity }]}
          {...panResponder.panHandlers}
        >
          <Animated.View style={[StyleSheet.absoluteFill, {
            transform: [{ translateY: panY }],
            backgroundColor: '#000',
          }]}>
            {/* Progress bars */}
            <View style={styles.progressBarRow}>
              {viewerStatuses.map((item, idx) => (
                <View key={item.id || idx} style={styles.progressBarTrack}>
                  <Animated.View
                    style={[styles.progressBarFill, {
                      width: idx < viewerIndex ? '100%'
                        : idx === viewerIndex ? progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] })
                        : '0%',
                    }]}
                  />
                </View>
              ))}
            </View>

            {/* Header */}
            <View style={styles.viewerHeader}>
              <AvatarCircle name={viewerOwnerName} email={viewerOwnerEmail} size={40} />
              <View style={styles.viewerHeaderInfo}>
                <Text style={styles.viewerName} numberOfLines={1}>{viewerOwnerName}</Text>
                <Text style={styles.viewerTime}>
                  {timeAgo(currentViewerItem?.timestamp, t)}
                </Text>
              </View>
              {isOwnStatus && currentViewerItem?.view_count != null && (
                <TouchableOpacity
                  style={styles.viewCountBadge}
                  onPress={() => handleShowViewers(currentViewerItem.id)}
                  activeOpacity={0.7}
                >
                  <IconEye size={14} color="rgba(255,255,255,0.8)" />
                  <Text style={styles.viewCountText}>{currentViewerItem.view_count}</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={closeViewer} style={styles.viewerClose}>
                <IconX size={26} color="#fff" />
              </TouchableOpacity>
            </View>

            {/* Content area with tap zones */}
            <TouchableOpacity
              style={styles.viewerContent}
              activeOpacity={1}
              onPress={handleViewerTap}
              onLongPress={handleLongPress}
              onPressOut={handlePressOut}
              delayLongPress={300}
            >
              {/* Left/Right tap zone indicators */}
              {viewerIndex > 0 && (
                <View style={styles.tapZoneLeft} pointerEvents="none">
                  <View style={styles.tapZoneArrow}>
                    <IconChevronLeft size={20} color="rgba(255,255,255,0.4)" />
                  </View>
                </View>
              )}

              {currentViewerItem?.type === 'text' ? (
                <View style={[styles.viewerTextCard, { backgroundColor: currentViewerItem?.bgColor || '#075E54' }]}>
                  <Text style={styles.viewerText}>{currentViewerItem?.content}</Text>
                </View>
              ) : currentViewerItem?.type === 'image' ? (
                <View style={{ flex: 1, width: '100%', alignItems: 'center', justifyContent: 'center' }}>
                  <Image
                    source={{ uri: (() => { const url = (currentViewerItem?.content || '').split('\n')[0]; return url.startsWith('/') ? BASE_URL + url : url; })() }}
                    style={styles.viewerImage}
                    resizeMode="contain"
                  />
                  {(currentViewerItem?.content || '').includes('\n') && (
                    <View style={styles.viewerCaptionBar}>
                      <Text style={styles.viewerCaption}>
                        {(currentViewerItem?.content || '').split('\n').slice(1).join('\n')}
                      </Text>
                    </View>
                  )}
                </View>
              ) : null}

              {/* Paused indicator */}
              {isPaused && (
                <View style={styles.pausedOverlay} pointerEvents="none">
                  <View style={styles.pausedBadge}>
                    <Text style={styles.pausedText}>II</Text>
                  </View>
                </View>
              )}
            </TouchableOpacity>

            {/* Reply input (only for other people's statuses) */}
            {!isOwnStatus && (
              <View style={styles.replyBar}>
                <View style={styles.replyInputWrap}>
                  <TextInput
                    style={styles.replyInput}
                    value={viewerReply}
                    onChangeText={setViewerReply}
                    placeholder={t?.('status.reply') || 'Responder...'}
                    placeholderTextColor="rgba(255,255,255,0.4)"
                    returnKeyType="send"
                    onSubmitEditing={handleStatusReply}
                    editable={!sendingReply}
                    onFocus={() => {
                      setIsPaused(true);
                      if (timerRef.current) clearTimeout(timerRef.current);
                      if (animRef.current) animRef.current.stop();
                    }}
                    onBlur={() => setIsPaused(false)}
                  />
                </View>
                {viewerReply.trim().length > 0 && (
                  <TouchableOpacity
                    style={styles.replySendBtn}
                    onPress={handleStatusReply}
                    disabled={sendingReply}
                    activeOpacity={0.7}
                  >
                    {sendingReply
                      ? <ActivityIndicator size="small" color="#fff" />
                      : <IconSend size={20} color="#fff" />
                    }
                  </TouchableOpacity>
                )}
              </View>
            )}

            {/* Own status view count footer — tap to see who viewed */}
            {isOwnStatus && currentViewerItem?.view_count > 0 && (
              <TouchableOpacity
                style={styles.viewersFooter}
                onPress={() => handleShowViewers(currentViewerItem.id)}
                activeOpacity={0.7}
              >
                <IconEye size={16} color="rgba(255,255,255,0.6)" />
                <Text style={styles.viewersText}>
                  {currentViewerItem.view_count} {currentViewerItem.view_count === 1 ? (t?.('status.viewer') || 'visualização') : (t?.('status.viewers') || 'visualizações')}
                </Text>
                <IconChevronRight size={14} color="rgba(255,255,255,0.4)" />
              </TouchableOpacity>
            )}
          </Animated.View>
        </Animated.View>
      </Modal>

      {/* ─── Viewers List Modal ─── */}
      <Modal visible={viewersModal} transparent animationType="slide" onRequestClose={() => { setViewersModal(false); setIsPaused(false); }}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }} onPress={() => { setViewersModal(false); setIsPaused(false); }}>
          <Pressable style={{ backgroundColor: isDark ? '#1a1a2e' : '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '60%', paddingBottom: 34 }}>
            <View style={{ alignItems: 'center', paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: isDark ? 'rgba(255,255,255,0.1)' : '#e5e7eb' }}>
              <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: isDark ? 'rgba(255,255,255,0.2)' : '#d1d5db', marginBottom: 12 }} />
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <IconEye size={18} color={isDark ? '#fff' : '#111'} />
                <Text style={{ fontSize: 17, fontWeight: '700', color: isDark ? '#fff' : '#111' }}>
                  {viewersList.length} {viewersList.length === 1 ? (t?.('status.viewer') || 'visualização') : (t?.('status.viewers') || 'visualizações')}
                </Text>
              </View>
            </View>
            {viewersLoading ? (
              <ActivityIndicator size="large" color={ACCENT} style={{ marginVertical: 32 }} />
            ) : viewersList.length === 0 ? (
              <Text style={{ textAlign: 'center', color: isDark ? '#6b7280' : '#9ca3af', marginVertical: 32, fontSize: 15 }}>
                {t?.('status.noViewers') || 'Ninguém viu ainda'}
              </Text>
            ) : (
              <ScrollView>
                {viewersList.map((v, i) => (
                  <View key={i} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 12 }}>
                    <AvatarCircle name={v.name || v.viewer_email} email={v.viewer_email} size={40} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 15, fontWeight: '600', color: isDark ? '#fff' : '#111' }}>
                        {emailToDisplayName(v.name || v.viewer_email)}
                      </Text>
                      <Text style={{ fontSize: 12, color: isDark ? '#6b7280' : '#9ca3af', marginTop: 2 }}>
                        {v.viewed_at ? timeAgo(v.viewed_at, t) : ''}
                      </Text>
                    </View>
                  </View>
                ))}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* ─── Status Creator Modal ─── */}
      <Modal visible={creatorVisible} animationType="slide" transparent={false} onRequestClose={() => setCreatorVisible(false)}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={[styles.creatorContainer, { backgroundColor: creatorMode === 'photo' ? '#000' : textBgColor }]}>
            {/* Subtle pattern overlay for text mode */}
            {creatorMode === 'text' && (
              <View style={styles.creatorPatternOverlay} pointerEvents="none" />
            )}

            <View style={styles.creatorHeader}>
              <TouchableOpacity onPress={() => setCreatorVisible(false)} style={styles.creatorCloseBtn}>
                <IconX size={26} color="#fff" />
              </TouchableOpacity>
              <View style={{ flex: 1 }} />
              {creatorMode === 'text' && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.colorPicker}>
                  {TEXT_BG_COLORS.map((c) => (
                    <TouchableOpacity
                      key={c}
                      onPress={() => setTextBgColor(c)}
                      style={[
                        styles.colorDot,
                        { backgroundColor: c },
                        textBgColor === c && styles.colorDotSelected,
                      ]}
                    >
                      {textBgColor === c && (
                        <View style={styles.colorDotInner} />
                      )}
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}
            </View>

            <View style={styles.creatorBody}>
              {creatorMode === 'photo' && photoUri ? (
                <View style={styles.creatorPhotoWrap}>
                  <Image source={{ uri: photoUri }} style={styles.creatorPhoto} resizeMode="contain" />
                </View>
              ) : (
                <TextInput
                  style={styles.creatorInput}
                  placeholder={typePlaceholder}
                  placeholderTextColor="rgba(255,255,255,0.35)"
                  value={textContent}
                  onChangeText={setTextContent}
                  multiline
                  textAlign="center"
                  textAlignVertical="center"
                  autoFocus
                  maxLength={500}
                />
              )}
              {creatorMode === 'photo' && (
                <TextInput
                  style={[styles.captionInput, { color: '#fff' }]}
                  placeholder={t?.('status.addCaption') || 'Adicionar legenda...'}
                  placeholderTextColor="rgba(255,255,255,0.4)"
                  value={textContent}
                  onChangeText={setTextContent}
                  maxLength={200}
                />
              )}
            </View>

            <View style={styles.creatorFooter}>
              <TouchableOpacity
                style={[styles.sendBtn,
                  publishing && styles.sendBtnDisabled,
                  creatorMode === 'text' && !textContent.trim() && styles.sendBtnDisabled,
                ]}
                onPress={publishStatus}
                disabled={publishing || (creatorMode === 'text' && !textContent.trim())}
                activeOpacity={0.8}
              >
                {publishing ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <View style={styles.sendBtnInner}>
                    <IconEdit size={18} color="#fff" />
                    <Text style={styles.sendBtnText}>{t?.('status.publish') || 'Publicar'}</Text>
                  </View>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  // Story horizontal scroller
  storyScrollerContainer: {
    maxHeight: 110,
    marginTop: 4,
  },
  storyScroller: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 2,
  },
  storyItem: {
    alignItems: 'center',
    width: 80,
    marginRight: 4,
  },
  storyAvatarWrap: {
    position: 'relative',
    marginBottom: 6,
  },
  storyPlusBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2.5,
  },
  storyName: {
    fontSize: 11,
    fontWeight: '500',
    textAlign: 'center',
    width: 72,
  },

  // Search
  inlineSearchRow: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  searchToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 10,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4 },
      android: { elevation: 1 },
      web: { boxShadow: '0 1px 4px rgba(0,0,0,0.06)' },
    }),
  },
  searchToggleText: {
    fontSize: 15,
    marginLeft: 10,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 4,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 10,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 6 },
      android: { elevation: 2 },
      web: { boxShadow: '0 1px 6px rgba(0,0,0,0.08)' },
    }),
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    marginLeft: 10,
    marginRight: 8,
    paddingVertical: 0,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },

  scrollView: { flex: 1 },

  // My Status Card
  myStatusCard: {
    marginHorizontal: 16,
    marginTop: 6,
    marginBottom: 6,
    borderRadius: 18,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 10 },
      android: { elevation: 3 },
    }),
  },
  myStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 16,
  },
  myAvatarWrapper: { position: 'relative' },
  plusBadge: {
    position: 'absolute',
    bottom: -1,
    right: -1,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2.5,
    ...Platform.select({
      ios: { shadowColor: ACCENT, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.3, shadowRadius: 3 },
      android: { elevation: 3 },
      web: { boxShadow: '0 1px 4px rgba(37,211,102,0.3)' },
    }),
  },
  myStatusName: {
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.1,
  },
  myStatusSub: {
    fontSize: 13,
    marginTop: 3,
    letterSpacing: 0.1,
  },
  myStatusActions: { flexDirection: 'row', alignItems: 'center' },
  actionCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Status rows
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 14,
    marginHorizontal: 16,
    marginBottom: 3,
    borderRadius: 16,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 4 },
      android: { elevation: 1 },
      web: { boxShadow: '0 1px 4px rgba(0,0,0,0.04)' },
    }),
  },
  avatarWrapper: { position: 'relative' },
  statusInfo: { flex: 1, marginLeft: 16 },
  statusName: { fontSize: 16, fontWeight: '600', letterSpacing: 0.15 },
  statusMeta: { flexDirection: 'row', alignItems: 'center', marginTop: 3, gap: 8 },
  statusTime: { fontSize: 13, letterSpacing: 0.1 },
  countPill: {
    paddingHorizontal: 7,
    paddingVertical: 1,
    borderRadius: 8,
  },
  countPillText: {
    fontSize: 11,
    fontWeight: '700',
  },

  // Section headers
  section: { marginTop: 14 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 10,
    marginLeft: 16,
  },
  sectionAccent: {
    width: 3,
    height: 16,
    borderRadius: 2,
    backgroundColor: ACCENT,
    marginRight: 10,
  },
  sectionTitle: {
    fontSize: 11.5,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1.3,
    flex: 1,
  },
  sectionCount: {
    fontSize: 11,
    fontWeight: '600',
    marginRight: 16,
  },

  // Empty state
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
    paddingHorizontal: 40,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
    marginTop: 24,
  },
  emptySubtext: {
    fontSize: 14,
    marginTop: 8,
    textAlign: 'center',
    lineHeight: 20,
  },
  emptyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ACCENT,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 24,
    marginTop: 24,
    gap: 8,
    ...Platform.select({
      web: { boxShadow: '0 3px 10px rgba(37,211,102,0.3)' },
      ios: { shadowColor: ACCENT, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.3, shadowRadius: 8 },
      android: { elevation: 4 },
    }),
  },
  emptyButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },

  // FABs
  fabSecondary: {
    position: 'absolute',
    bottom: 96,
    right: 24,
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.15, shadowRadius: 8 },
      android: { elevation: 6 },
    }),
  },
  fab: {
    position: 'absolute',
    bottom: 28,
    right: 20,
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      ios: { shadowColor: ACCENT, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.35, shadowRadius: 10 },
      android: { elevation: 8 },
    }),
  },

  // ─── Full-Screen Viewer ───
  viewerContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  progressBarRow: {
    flexDirection: 'row',
    paddingHorizontal: 10,
    paddingTop: Platform.OS === 'ios' ? 54 : 14,
    gap: 4,
  },
  progressBarTrack: {
    flex: 1,
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#fff',
    borderRadius: 2,
  },
  viewerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  viewerHeaderInfo: { flex: 1, marginLeft: 12 },
  viewerName: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  viewerTime: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 12,
    marginTop: 2,
  },
  viewCountBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    gap: 5,
    marginRight: 8,
  },
  viewCountText: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 13,
    fontWeight: '600',
  },
  viewerClose: {
    padding: 8,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  viewerContent: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  tapZoneLeft: {
    position: 'absolute',
    left: 8,
    top: '45%',
    zIndex: 5,
  },
  tapZoneArrow: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerTextCard: {
    width: '100%',
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  viewerText: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '700',
    textAlign: 'center',
    lineHeight: 40,
    textShadowColor: 'rgba(0,0,0,0.25)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  viewerImage: { width: SCREEN_WIDTH, height: '100%' },
  viewerCaptionBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 24,
    paddingVertical: 18,
    backgroundColor: 'rgba(0,0,0,0.55)',
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)' } : {}),
  },
  viewerCaption: {
    color: '#fff',
    fontSize: 16,
    textAlign: 'center',
    lineHeight: 22,
    textShadowColor: 'rgba(0,0,0,0.3)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  pausedOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pausedBadge: {
    backgroundColor: 'rgba(0,0,0,0.4)',
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pausedText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: 2,
  },

  // Reply bar
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    paddingBottom: Platform.OS === 'ios' ? 36 : 16,
  },
  replyInputWrap: {
    flex: 1,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    overflow: 'hidden',
  },
  replyInput: {
    height: 44,
    paddingHorizontal: 18,
    color: '#fff',
    fontSize: 15,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  replySendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },

  // Viewers footer
  viewersFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 14,
    paddingBottom: Platform.OS === 'ios' ? 36 : 18,
    gap: 8,
  },
  viewersText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
  },

  // ─── Creator ───
  creatorContainer: { flex: 1 },
  creatorPatternOverlay: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0.04,
    backgroundColor: '#fff',
  },
  creatorHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'ios' ? 54 : 16,
    paddingBottom: 12,
    zIndex: 2,
  },
  creatorCloseBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(0,0,0,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  colorPicker: { flexDirection: 'row', maxWidth: 260 },
  colorDot: {
    width: 32,
    height: 32,
    borderRadius: 16,
    marginHorizontal: 4,
    borderWidth: 2.5,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.15, shadowRadius: 3 },
      android: { elevation: 2 },
      web: { boxShadow: '0 1px 4px rgba(0,0,0,0.2)' },
    }),
  },
  colorDotSelected: {
    borderColor: '#fff',
    transform: [{ scale: 1.15 }],
  },
  colorDotInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: 'rgba(255,255,255,0.8)',
  },
  creatorBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  creatorInput: {
    color: '#fff',
    fontSize: 32,
    fontWeight: '700',
    textAlign: 'center',
    width: '100%',
    maxHeight: 260,
    lineHeight: 44,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none', caretColor: '#fff' } : {}),
  },
  creatorPhotoWrap: {
    flex: 1,
    width: '100%',
    borderRadius: 20,
    overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 8 },
      android: { elevation: 4 },
      web: { boxShadow: '0 4px 16px rgba(0,0,0,0.3)' },
    }),
  },
  creatorPhoto: {
    width: '100%',
    flex: 1,
  },
  captionInput: {
    fontSize: 16,
    textAlign: 'center',
    width: '100%',
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.12)',
    marginTop: 10,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  creatorFooter: {
    paddingHorizontal: 20,
    paddingBottom: Platform.OS === 'ios' ? 40 : 28,
    alignItems: 'center',
    zIndex: 2,
  },
  sendBtn: {
    backgroundColor: 'rgba(255,255,255,0.22)',
    paddingHorizontal: 40,
    paddingVertical: 16,
    borderRadius: 30,
    minWidth: 180,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)' } : {}),
  },
  sendBtnDisabled: { opacity: 0.35 },
  sendBtnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  sendBtnText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
});
