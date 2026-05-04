import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, TextInput,
  Image, ScrollView, Platform, ActivityIndicator, Dimensions,
  KeyboardAvoidingView, FlatList, Switch, Pressable,
} from 'react-native';
import {
  IconX, IconImage, IconMapPin, IconCamera, IconChevronLeft, IconTrash,
  IconVideo, IconPlay, IconSparkles, IconMusic, IconUsers, IconLock,
  IconClock, IconChevronRight, IconHash, IconAtSign, IconGlobe, IconShield,
  IconCheck,
} from './Icons';
import CachedImage from './CachedImage';
import AvatarCircle from './AvatarCircle';
import * as api from '../services/api';

// Generate video thumbnail on native
async function getVideoThumbnail(uri) {
  if (Platform.OS === 'web') return null;
  try {
    const { getThumbnailAsync } = require('expo-video-thumbnails');
    const result = await getThumbnailAsync(uri, { time: 500, quality: 0.7 });
    return result.uri;
  } catch { return null; }
}

const SCREEN_WIDTH = Dimensions.get('window').width;
const SCREEN_HEIGHT = Dimensions.get('window').height;
const MAX_WIDTH = 600;
const ACCENT = '#7C3AED';
const MAX_CAPTION = 2200;
const MAX_MEDIA = 10;

// Instagram-style CSS filters
const FILTERS = [
  { name: 'Normal', css: '' },
  { name: 'Clarendon', css: 'contrast(1.2) saturate(1.35)' },
  { name: 'Gingham', css: 'brightness(1.05) hue-rotate(-10deg)' },
  { name: 'Moon', css: 'grayscale(1) contrast(1.1) brightness(1.1)' },
  { name: 'Lark', css: 'contrast(0.9) brightness(1.1) saturate(1.2)' },
  { name: 'Reyes', css: 'sepia(0.22) brightness(1.1) contrast(0.85) saturate(0.75)' },
  { name: 'Juno', css: 'contrast(1.1) brightness(1.05) saturate(1.3)' },
  { name: 'Slumber', css: 'saturate(0.66) brightness(1.05) sepia(0.1)' },
  { name: 'Aden', css: 'hue-rotate(20deg) contrast(0.9) saturate(0.85) brightness(1.2)' },
  { name: 'Perpetua', css: 'brightness(1.05) contrast(1.1) saturate(1.1)' },
];

function getNativeFilterStyle(filterName) {
  switch (filterName) {
    case 'Moon': return { opacity: 0.85 };
    case 'Reyes': return { opacity: 0.88 };
    case 'Slumber': return { opacity: 0.9 };
    default: return {};
  }
}

// Audience options
const AUDIENCE_EVERYONE = 'everyone';
const AUDIENCE_FOLLOWERS = 'followers';
const AUDIENCE_CLOSE_FRIENDS = 'close_friends';

// Hashtag / mention regex
const HASHTAG_REGEX = /#[\w\u00C0-\u024F]+/g;
const MENTION_REGEX = /@[\w.\-]*/;

// Format video duration
function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ---- Gallery Grid (device photos) ----
function GalleryGrid({ onSelect, selectedIds, colors, isDark, t, isWeb }) {
  const [assets, setAssets] = useState([]);
  const [hasPermission, setHasPermission] = useState(null);
  const [endCursor, setEndCursor] = useState(undefined);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isWeb) return; // Web uses file picker instead
    let cancelled = false;
    (async () => {
      try {
        const MediaLibrary = require('expo-media-library');
        const { status } = await MediaLibrary.requestPermissionsAsync();
        if (cancelled) return;
        setHasPermission(status === 'granted');
        if (status === 'granted') {
          loadMore(MediaLibrary, null, cancelled);
        }
      } catch {
        setHasPermission(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isWeb]);

  const loadMore = useCallback(async (ML, cursor, cancelled) => {
    if (loading) return;
    setLoading(true);
    try {
      const MediaLibrary = ML || require('expo-media-library');
      const page = await MediaLibrary.getAssetsAsync({
        first: 60,
        after: cursor || undefined,
        mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
        sortBy: [MediaLibrary.SortBy.creationTime],
      });
      if (cancelled) return;
      setAssets(prev => cursor ? [...prev, ...page.assets] : page.assets);
      setEndCursor(page.endCursor);
      setHasMore(page.hasNextPage);
    } catch { /* ignore */ }
    setLoading(false);
  }, [loading]);

  if (isWeb) return null;
  // While the permission prompt is still in-flight hasPermission is null.
  // Previously we rendered an empty FlatList in that window which looked
  // exactly like "no photos in gallery" to the user — they had no idea
  // the app was waiting on a permission grant.
  if (hasPermission === null) {
    return (
      <View style={gs.galleryEmpty}>
        <ActivityIndicator size="large" color={ACCENT} />
        <Text style={[gs.galleryEmptyText, { color: colors.textSecondary, marginTop: 12 }]}>
          {t('post.loadingGallery') || 'Carregando galeria...'}
        </Text>
      </View>
    );
  }
  if (hasPermission === false) {
    return (
      <View style={gs.galleryEmpty}>
        <Text style={[gs.galleryEmptyText, { color: colors.textSecondary, marginBottom: 16 }]}>
          {t('post.galleryPermission') || 'Permitir acesso às suas fotos para selecionar mídia'}
        </Text>
        <TouchableOpacity
          style={{ paddingHorizontal: 20, paddingVertical: 12, borderRadius: 10, backgroundColor: ACCENT }}
          onPress={async () => {
            try {
              const MediaLibrary = require('expo-media-library');
              const { status } = await MediaLibrary.requestPermissionsAsync();
              setHasPermission(status === 'granted');
              if (status === 'granted') loadMore(MediaLibrary, null, false);
            } catch {}
          }}
          activeOpacity={0.8}
        >
          <Text style={{ color: '#fff', fontWeight: '700' }}>
            {t('post.allowPhotos') || 'Permitir Fotos'}
          </Text>
        </TouchableOpacity>
      </View>
    );
  }
  // Permission granted but loadMore hasn't returned any assets yet
  if (assets.length === 0 && loading) {
    return (
      <View style={gs.galleryEmpty}>
        <ActivityIndicator size="large" color={ACCENT} />
      </View>
    );
  }

  const ITEM_SIZE = (SCREEN_WIDTH - 6) / 4;

  return (
    <FlatList
      data={assets}
      numColumns={4}
      keyExtractor={item => item.id}
      contentContainerStyle={{ paddingBottom: 100 }}
      columnWrapperStyle={{ gap: 2 }}
      ItemSeparatorComponent={() => <View style={{ height: 2 }} />}
      onEndReached={() => hasMore && !loading && loadMore(null, endCursor, false)}
      onEndReachedThreshold={0.5}
      renderItem={({ item }) => {
        const isSelected = selectedIds.includes(item.id);
        const selIndex = selectedIds.indexOf(item.id);
        const isVideo = item.mediaType === 'video';
        return (
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={() => onSelect(item)}
            style={[gs.galleryItem, { width: ITEM_SIZE, height: ITEM_SIZE }]}
          >
            {/* iOS returns `ph://...` URIs from MediaLibrary, which plain
                <Image> can't render (hence the "white thumbnails" bug).
                expo-image handles `ph://`, `file://` and `content://` out
                of the box. Fall back to plain Image on web/Android. */}
            {(() => {
              let ExpoImg = null;
              try { ExpoImg = require('expo-image').Image; } catch {}
              if (ExpoImg && Platform.OS === 'ios') {
                return <ExpoImg source={{ uri: item.uri }} style={gs.galleryThumb} contentFit="cover" cachePolicy="memory" />;
              }
              return <CachedImage source={{ uri: item.uri }} style={gs.galleryThumb} />;
            })()}
            {isVideo && (
              <View style={gs.galleryDuration}>
                <Text style={gs.galleryDurationText}>{formatDuration(item.duration)}</Text>
              </View>
            )}
            <View style={[
              gs.gallerySel,
              isSelected
                ? { backgroundColor: ACCENT, borderColor: ACCENT }
                : { backgroundColor: 'rgba(0,0,0,0.3)', borderColor: '#fff' },
            ]}>
              {isSelected ? (
                <Text style={gs.gallerySelText}>{selIndex + 1}</Text>
              ) : null}
            </View>
          </TouchableOpacity>
        );
      }}
      ListFooterComponent={loading ? <ActivityIndicator color={ACCENT} style={{ marginVertical: 16 }} /> : null}
    />
  );
}

// ---- Mention Autocomplete Dropdown ----
function MentionDropdown({ query, onSelect, colors, isDark }) {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!query || query.length < 1) { setResults([]); return; }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await api.searchContacts(query);
        if (!cancelled && r.contacts) setResults(r.contacts.slice(0, 8));
      } catch { /* ignore */ }
      if (!cancelled) setLoading(false);
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query]);

  if (!query || (results.length === 0 && !loading)) return null;

  return (
    <View style={[gs.mentionDrop, {
      backgroundColor: isDark ? '#1e293b' : '#fff',
      borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
    }]}>
      {loading && <ActivityIndicator size="small" color={ACCENT} style={{ paddingVertical: 8 }} />}
      {results.map((c, i) => (
        <TouchableOpacity
          key={c.email || i}
          style={gs.mentionItem}
          onPress={() => onSelect(c)}
        >
          <AvatarCircle email={c.email} name={c.name || c.email} size={32} colors={colors} />
          <View style={{ marginLeft: 10, flex: 1 }}>
            <Text style={[gs.mentionName, { color: colors.text }]} numberOfLines={1}>
              {c.name || c.email}
            </Text>
            {c.name && (
              <Text style={[gs.mentionEmail, { color: colors.textSecondary }]} numberOfLines={1}>
                {c.email}
              </Text>
            )}
          </View>
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ---- Caption Input with Hashtag Highlighting and @mention ----
function CaptionInput({ value, onChangeText, placeholder, colors, isDark, t, onMentionQuery }) {
  const inputRef = useRef(null);
  const [cursorPos, setCursorPos] = useState(0);

  const handleChange = useCallback((text) => {
    onChangeText(text);
    // Check for @mention at cursor
    const beforeCursor = text.slice(0, cursorPos + (text.length - value.length));
    const mentionMatch = beforeCursor.match(/@([\w.\-]*)$/);
    onMentionQuery(mentionMatch ? mentionMatch[1] : null);
  }, [onChangeText, cursorPos, value, onMentionQuery]);

  const handleSelection = useCallback((e) => {
    setCursorPos(e.nativeEvent.selection.end);
  }, []);

  return (
    <View style={gs.captionWrap}>
      <TextInput
        ref={inputRef}
        style={[gs.captionInput, { color: colors.text }]}
        placeholder={placeholder}
        placeholderTextColor={colors.textTertiary}
        value={value}
        onChangeText={handleChange}
        onSelectionChange={handleSelection}
        multiline
        maxLength={MAX_CAPTION}
        accessibilityLabel={t('post.caption') || 'Caption'}
        {...(Platform.OS === 'web' ? {} : {})}
      />
    </View>
  );
}

// ---- Audience Selector Modal ----
function AudienceModal({ visible, onClose, selected, onSelect, colors, isDark, t }) {
  const options = [
    { key: AUDIENCE_EVERYONE, icon: IconGlobe, label: t('post.everyone') || 'Everyone', desc: t('post.everyoneDesc') || 'Anyone can see this post' },
    { key: AUDIENCE_FOLLOWERS, icon: IconUsers, label: t('post.followersOnly') || 'Followers only', desc: t('post.followersDesc') || 'Only your followers can see' },
    { key: AUDIENCE_CLOSE_FRIENDS, icon: IconShield, label: t('post.closeFriends') || 'Close friends', desc: t('post.closeFriendsDesc') || 'Only close friends can see' },
  ];
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={gs.overlay} onPress={onClose}>
        <View style={[gs.audienceSheet, { backgroundColor: isDark ? '#1e293b' : '#fff' }]}>
          <Text style={[gs.audienceTitle, { color: colors.text }]}>
            {t('post.audience') || 'Audience'}
          </Text>
          {options.map(opt => {
            const Icon = opt.icon;
            const isActive = selected === opt.key;
            return (
              <TouchableOpacity
                key={opt.key}
                style={[gs.audienceRow, isActive && { backgroundColor: isDark ? 'rgba(124,58,237,0.1)' : 'rgba(124,58,237,0.06)' }]}
                onPress={() => { onSelect(opt.key); onClose(); }}
              >
                <View style={[gs.audienceIcon, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }]}>
                  <Icon size={22} color={isActive ? ACCENT : colors.textSecondary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[gs.audienceLabel, { color: colors.text }]}>{opt.label}</Text>
                  <Text style={[gs.audienceDesc, { color: colors.textSecondary }]}>{opt.desc}</Text>
                </View>
                {isActive && <IconCheck size={22} color={ACCENT} />}
              </TouchableOpacity>
            );
          })}
        </View>
      </Pressable>
    </Modal>
  );
}

// ---- Schedule Picker ----
function SchedulePicker({ value, onChange, colors, isDark, t }) {
  // Simple date/time input (web: native inputs; native: text-based)
  const isWeb = Platform.OS === 'web';
  if (!value) return null;

  if (isWeb) {
    return (
      <View style={gs.scheduleRow}>
        <input
          type="datetime-local"
          value={value || ''}
          onChange={e => onChange(e.target.value)}
          min={new Date().toISOString().slice(0, 16)}
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            color: isDark ? '#e2e8f0' : '#1e293b',
            fontSize: 15,
            outline: 'none',
            fontFamily: 'inherit',
          }}
        />
        <TouchableOpacity onPress={() => onChange(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <IconX size={18} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={gs.scheduleRow}>
      <TextInput
        style={[gs.scheduleInput, { color: colors.text }]}
        placeholder="YYYY-MM-DD HH:MM"
        placeholderTextColor={colors.textTertiary}
        value={value || ''}
        onChangeText={onChange}
        maxLength={16}
      />
      <TouchableOpacity onPress={() => onChange(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <IconX size={18} color={colors.textSecondary} />
      </TouchableOpacity>
    </View>
  );
}

// ---- Tag People Modal ----
function TagPeopleModal({ visible, onClose, tagged, onTag, colors, isDark, t }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!query || query.length < 1) { setResults([]); return; }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await api.searchContacts(query);
        if (!cancelled && r.contacts) setResults(r.contacts.slice(0, 15));
      } catch { /* ignore */ }
      if (!cancelled) setLoading(false);
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={[gs.tagModal, { backgroundColor: isDark ? '#0f172a' : '#fff' }]}>
        <View style={[gs.tagHeader, { borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]}>
          <TouchableOpacity onPress={onClose} style={{ padding: 6 }}>
            <IconX size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={[gs.tagTitle, { color: colors.text }]}>{t('post.tagPeople') || 'Marcar pessoas'}</Text>
          <TouchableOpacity onPress={onClose} style={[gs.tagDoneBtn, { backgroundColor: ACCENT }]}>
            <Text style={gs.tagDoneText}>{t('common.done') || 'Pronto'}</Text>
          </TouchableOpacity>
        </View>
        <View style={[gs.tagSearchRow, { backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)' }]}>
          <TextInput
            style={[gs.tagSearchInput, { color: colors.text }]}
            placeholder={t('post.searchPeople') || 'Search people...'}
            placeholderTextColor={colors.textTertiary}
            value={query}
            onChangeText={setQuery}
            autoFocus
          />
        </View>
        {/* Tagged chips */}
        {tagged.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={gs.tagChipScroll} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
            {tagged.map(person => (
              <TouchableOpacity
                key={person.email}
                style={[gs.tagChip, { backgroundColor: isDark ? 'rgba(124,58,237,0.15)' : 'rgba(124,58,237,0.1)' }]}
                onPress={() => onTag(tagged.filter(p => p.email !== person.email))}
              >
                <Text style={[gs.tagChipText, { color: ACCENT }]}>{person.name || person.email}</Text>
                <IconX size={14} color={ACCENT} />
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
        {loading && <ActivityIndicator color={ACCENT} style={{ marginTop: 16 }} />}
        <FlatList
          data={results}
          keyExtractor={item => item.email}
          contentContainerStyle={{ paddingHorizontal: 16 }}
          renderItem={({ item }) => {
            const isTagged = tagged.some(p => p.email === item.email);
            return (
              <TouchableOpacity
                style={gs.tagResultRow}
                onPress={() => {
                  if (isTagged) {
                    onTag(tagged.filter(p => p.email !== item.email));
                  } else {
                    onTag([...tagged, { email: item.email, name: item.name || item.email }]);
                  }
                }}
              >
                <AvatarCircle email={item.email} name={item.name || item.email} size={40} colors={colors} />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={[gs.tagResultName, { color: colors.text }]}>{item.name || item.email}</Text>
                  {item.name && <Text style={[gs.tagResultEmail, { color: colors.textSecondary }]}>{item.email}</Text>}
                </View>
                <View style={[gs.tagCheckbox, isTagged && { backgroundColor: ACCENT, borderColor: ACCENT }]}>
                  {isTagged && <IconCheck size={14} color="#fff" />}
                </View>
              </TouchableOpacity>
            );
          }}
        />
      </View>
    </Modal>
  );
}

// ===========================================================================
// MAIN COMPONENT
// ===========================================================================
export default function CreatePostModal({ visible, colors, isDark, t, user, onClose, onPostCreated, initialFiles, repostOf, originalPost }) {
  const [step, setStep] = useState(1); // 1 = select media, 2 = caption/options
  const [mediaFiles, setMediaFiles] = useState([]); // { uri, file, type, id, duration?, thumbnail? }

  // If a caller (e.g. the iOS share extension or share-receive screen) opens
  // this modal with a pre-selected file, jump straight to the caption step.
  useEffect(() => {
    if (!visible) return;
    if (!initialFiles || !initialFiles.length) return;
    setMediaFiles(initialFiles);
    setStep(2);
  }, [visible, initialFiles]);
  const [caption, setCaption] = useState('');
  const [location, setLocation] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [activePreviewIndex, setActivePreviewIndex] = useState(0);
  const [error, setError] = useState('');
  const [activeFilter, setActiveFilter] = useState('Normal');
  const [audience, setAudience] = useState(AUDIENCE_EVERYONE);
  const [showAudienceModal, setShowAudienceModal] = useState(false);
  const [scheduleDate, setScheduleDate] = useState(null);
  const [taggedPeople, setTaggedPeople] = useState([]);
  const [showTagModal, setShowTagModal] = useState(false);
  const [mentionQuery, setMentionQuery] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [multiSelectMode, setMultiSelectMode] = useState(true);
  const [gallerySelectedIds, setGallerySelectedIds] = useState([]);
  const [postAsReel, setPostAsReel] = useState(false);
  const scrollRef = useRef(null);

  const isWeb = Platform.OS === 'web';
  const cardWidth = Math.min(SCREEN_WIDTH, MAX_WIDTH);
  const mediaFilesRef = useRef([]);

  // Keep ref in sync for cleanup
  useEffect(() => { mediaFilesRef.current = mediaFiles; }, [mediaFiles]);

  // Revoke all object URLs on unmount
  useEffect(() => {
    return () => {
      if (Platform.OS === 'web') {
        mediaFilesRef.current.forEach(m => {
          if (m.uri?.startsWith('blob:')) { try { URL.revokeObjectURL(m.uri); } catch {} }
        });
      }
    };
  }, []);

  const reset = useCallback(() => {
    setStep(1);
    // Revoke object URLs before clearing
    if (Platform.OS === 'web') {
      mediaFilesRef.current.forEach(m => {
        if (m.uri?.startsWith('blob:')) { try { URL.revokeObjectURL(m.uri); } catch {} }
      });
    }
    setMediaFiles([]);
    setCaption('');
    setLocation('');
    setPublishing(false);
    setActivePreviewIndex(0);
    setError('');
    setActiveFilter('Normal');
    setAudience(AUDIENCE_EVERYONE);
    setShowAudienceModal(false);
    setScheduleDate(null);
    setTaggedPeople([]);
    setShowTagModal(false);
    setMentionQuery(null);
    setAiLoading(false);
    setMultiSelectMode(true);
    setGallerySelectedIds([]);
    setPostAsReel(false);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  // -- Pick media from file picker (web) or image picker (native fallback) --
  const pickMedia = useCallback(() => {
    setError('');
    if (isWeb) {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*,video/*';
      input.multiple = true;
      input.onchange = (e) => {
        const files = Array.from(e.target.files || []);
        if (files.length === 0) return;
        const items = files.slice(0, MAX_MEDIA).map((file, idx) => ({
          uri: URL.createObjectURL(file),
          file,
          type: file.type.startsWith('video') ? 'video' : 'image',
          id: `${Date.now()}_${idx}`,
        }));
        setMediaFiles(prev => {
          const combined = [...prev, ...items].slice(0, MAX_MEDIA);
          return combined;
        });
        setStep(2);
      };
      input.click();
    } else {
      import('expo-image-picker').then(({ launchImageLibraryAsync, MediaTypeOptions }) => {
        launchImageLibraryAsync({
          mediaTypes: MediaTypeOptions.All,
          allowsMultipleSelection: true,
          quality: 0.8,
          selectionLimit: MAX_MEDIA,
        }).then(async (result) => {
          if (!result.canceled && result.assets?.length > 0) {
            const items = await Promise.all(result.assets.map(async (asset, idx) => {
              const isVideo = asset.type === 'video';
              const thumb = isVideo ? await getVideoThumbnail(asset.uri) : null;
              return {
                uri: asset.uri,
                thumbnail: thumb,
                file: {
                  uri: asset.uri,
                  name: asset.fileName || `media_${Date.now()}_${idx}.${isVideo ? 'mp4' : 'jpg'}`,
                  type: asset.mimeType || (isVideo ? 'video/mp4' : 'image/jpeg'),
                },
                type: isVideo ? 'video' : 'image',
                id: `${Date.now()}_${idx}`,
                duration: isVideo ? asset.duration : undefined,
              };
            }));
            setMediaFiles(prev => [...prev, ...items].slice(0, MAX_MEDIA));
            setStep(2);
          }
        });
      });
    }
  }, [isWeb]);

  // -- Select from gallery grid (native only) --
  const handleGallerySelect = useCallback(async (asset) => {
    setError('');
    const assetId = asset.id;
    const isAlreadySelected = gallerySelectedIds.includes(assetId);

    if (isAlreadySelected) {
      // Deselect
      setGallerySelectedIds(prev => prev.filter(id => id !== assetId));
      setMediaFiles(prev => prev.filter(m => m.galleryId !== assetId));
      return;
    }

    if (mediaFiles.length >= MAX_MEDIA) {
      setError((t('post.maxMedia') || 'Maximum {max} items').replace('{max}', MAX_MEDIA));
      return;
    }

    const isVideo = asset.mediaType === 'video';
    let fileUri = asset.uri;

    // On native, get local URI from media library
    try {
      const MediaLibrary = require('expo-media-library');
      const info = await MediaLibrary.getAssetInfoAsync(asset.id);
      if (info.localUri) fileUri = info.localUri;
    } catch { /* use asset.uri */ }

    const thumb = isVideo ? await getVideoThumbnail(fileUri) : null;
    const item = {
      uri: fileUri,
      thumbnail: thumb,
      file: {
        uri: fileUri,
        name: asset.filename || `media_${Date.now()}.${isVideo ? 'mp4' : 'jpg'}`,
        type: isVideo ? 'video/mp4' : 'image/jpeg',
      },
      type: isVideo ? 'video' : 'image',
      id: `${Date.now()}_${asset.id}`,
      galleryId: assetId,
      duration: isVideo ? asset.duration : undefined,
    };

    setGallerySelectedIds(prev => [...prev, assetId]);
    setMediaFiles(prev => [...prev, item].slice(0, MAX_MEDIA));
  }, [gallerySelectedIds, mediaFiles.length, t]);

  // -- Camera capture --
  const openCamera = useCallback(() => {
    setError('');
    if (isWeb) {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*,video/*';
      input.capture = 'environment';
      input.onchange = (e) => {
        const files = Array.from(e.target.files || []);
        if (files.length === 0) return;
        const file = files[0];
        const item = {
          uri: URL.createObjectURL(file),
          file,
          type: file.type.startsWith('video') ? 'video' : 'image',
          id: `${Date.now()}_cam`,
        };
        setMediaFiles(prev => [...prev, item].slice(0, MAX_MEDIA));
        setStep(2);
      };
      input.click();
    } else {
      import('expo-image-picker').then(({ launchCameraAsync, MediaTypeOptions }) => {
        launchCameraAsync({
          mediaTypes: MediaTypeOptions.All,
          quality: 0.8,
          videoMaxDuration: 60,
        }).then(async (result) => {
          if (!result.canceled && result.assets?.length > 0) {
            const asset = result.assets[0];
            const isVideo = asset.type === 'video';
            const thumb = isVideo ? await getVideoThumbnail(asset.uri) : null;
            const item = {
              uri: asset.uri,
              thumbnail: thumb,
              file: {
                uri: asset.uri,
                name: asset.fileName || `capture_${Date.now()}.${isVideo ? 'mp4' : 'jpg'}`,
                type: asset.mimeType || (isVideo ? 'video/mp4' : 'image/jpeg'),
              },
              type: isVideo ? 'video' : 'image',
              id: `${Date.now()}_cam`,
              duration: isVideo ? asset.duration : undefined,
            };
            setMediaFiles(prev => [...prev, item].slice(0, MAX_MEDIA));
            setStep(2);
          }
        }).catch(() => {
          setError(t('feed.cameraError') || 'Camera not available');
        });
      });
    }
  }, [isWeb, t]);

  const removeMedia = useCallback((id) => {
    setMediaFiles(prev => {
      const item = prev.find(m => m.id === id);
      if (item?.galleryId) {
        setGallerySelectedIds(gids => gids.filter(gid => gid !== item.galleryId));
      }
      // Revoke object URL to prevent memory leak
      if (Platform.OS === 'web' && item?.uri?.startsWith('blob:')) {
        try { URL.revokeObjectURL(item.uri); } catch {}
      }
      const updated = prev.filter(m => m.id !== id);
      if (updated.length === 0) setStep(1);
      return updated;
    });
  }, []);

  // -- Reorder media (move item) --
  const moveMedia = useCallback((fromIndex, direction) => {
    setMediaFiles(prev => {
      const arr = [...prev];
      const toIndex = fromIndex + direction;
      if (toIndex < 0 || toIndex >= arr.length) return arr;
      [arr[fromIndex], arr[toIndex]] = [arr[toIndex], arr[fromIndex]];
      return arr;
    });
  }, []);

  // -- Mention selection --
  const handleMentionSelect = useCallback((contact) => {
    const atMatch = caption.match(/@([\w.\-]*)$/);
    if (atMatch) {
      const before = caption.slice(0, caption.length - atMatch[0].length);
      const handle = contact.email.split('@')[0];
      setCaption(before + '@' + handle + ' ');
    }
    setMentionQuery(null);
  }, [caption]);

  // -- AI caption suggestion --
  const suggestCaption = useCallback(async () => {
    if (aiLoading || mediaFiles.length === 0) return;
    setAiLoading(true);
    try {
      // Build a context description from media
      const mediaDesc = mediaFiles.map((m, i) => `${m.type} ${i + 1}`).join(', ');
      const locStr = location ? ` at ${location}` : '';
      const r = await api.apiCall('ai_compose', {
        prompt: `Write a short, engaging social media caption (1-2 sentences, include relevant emojis and hashtags) for a post with: ${mediaDesc}${locStr}. Keep it natural and trendy.`,
        style: 'casual',
      });
      if (r.text || r.result) {
        setCaption(r.text || r.result || '');
      }
    } catch { /* ignore */ }
    setAiLoading(false);
  }, [aiLoading, mediaFiles, location]);

  // -- Publish --
  const publish = useCallback(async () => {
    // Reposts publish without media (the embedded card supplies the visual).
    if (publishing || (mediaFiles.length === 0 && !repostOf)) return;
    setPublishing(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('caption', caption.trim());
      if (location.trim()) formData.append('location', location.trim());
      if (audience !== AUDIENCE_EVERYONE) formData.append('audience', audience);
      if (scheduleDate) formData.append('scheduled_at', scheduleDate);
      if (taggedPeople.length > 0) formData.append('tagged', JSON.stringify(taggedPeople.map(p => p.email)));
      if (repostOf) formData.append('repost_of', String(repostOf));

      const hasVideo = mediaFiles.some(m => m.type === 'video');
      formData.append('media_type', hasVideo ? 'video' : 'image');
      if (postAsReel && hasVideo) formData.append('is_reel', '1');
      if (activeFilter && activeFilter !== 'Normal') {
        formData.append('filter', activeFilter);
      }

      for (let i = 0; i < mediaFiles.length; i++) {
        const item = mediaFiles[i];
        if (isWeb) {
          formData.append('media[]', item.file, item.file.name);
        } else {
          formData.append('media[]', item.file);
        }
      }

      const r = await api.feedCreatePost(formData);
      if (r.success) {
        onPostCreated?.(r.data?.post || r.data);
        handleClose();
      } else {
        setError(r.error || t('feed.publishError') || 'Failed to publish');
        setPublishing(false);
      }
    } catch {
      setError(t('feed.publishError') || 'Failed to publish');
      setPublishing(false);
    }
  }, [publishing, mediaFiles, caption, location, audience, scheduleDate, taggedPeople, isWeb, handleClose, onPostCreated, t, activeFilter, repostOf, postAsReel]);

  const bgColor = isDark ? '#0f172a' : '#ffffff';
  const surfaceColor = isDark ? '#1e293b' : '#f8fafc';
  const borderColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const captionRemaining = MAX_CAPTION - caption.length;

  const audienceLabel = useMemo(() => {
    switch (audience) {
      case AUDIENCE_FOLLOWERS: return t('post.followersOnly') || 'Followers only';
      case AUDIENCE_CLOSE_FRIENDS: return t('post.closeFriends') || 'Close friends';
      default: return t('post.everyone') || 'Everyone';
    }
  }, [audience, t]);

  const audienceIcon = useMemo(() => {
    switch (audience) {
      case AUDIENCE_FOLLOWERS: return IconUsers;
      case AUDIENCE_CLOSE_FRIENDS: return IconShield;
      default: return IconGlobe;
    }
  }, [audience]);
  const AudienceIcon = audienceIcon;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={false}
      onRequestClose={handleClose}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        style={[gs.container, { backgroundColor: bgColor }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* ---- HEADER ---- */}
        <View style={[gs.header, { borderBottomColor: borderColor }]}>
          <TouchableOpacity
            onPress={step === 2 ? () => setStep(1) : handleClose}
            style={gs.headerBtn}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel={step === 2 ? (t('common.back') || 'Back') : (t('common.close') || 'Close')}
            accessibilityRole="button"
          >
            {step === 2 ? (
              <IconChevronLeft size={26} color={colors.text} />
            ) : (
              <IconX size={24} color={colors.text} />
            )}
          </TouchableOpacity>
          <Text style={[gs.headerTitle, { color: colors.text }]}>
            {t('post.newPost') || 'New Post'}
          </Text>
          {step === 2 ? (
            <TouchableOpacity
              onPress={publish}
              disabled={publishing || mediaFiles.length === 0}
              style={[gs.publishBtn, {
                backgroundColor: publishing || mediaFiles.length === 0 ? (isDark ? '#1a3a2a' : '#a8e6c1') : ACCENT,
              }]}
              accessibilityLabel={t('post.share') || 'Share'}
              accessibilityRole="button"
            >
              {publishing ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={gs.publishText}>
                  {scheduleDate ? (t('post.schedule') || 'Schedule') : (t('post.share') || 'Share')}
                </Text>
              )}
            </TouchableOpacity>
          ) : (
            mediaFiles.length > 0 ? (
              <TouchableOpacity
                onPress={() => setStep(2)}
                style={[gs.publishBtn, { backgroundColor: ACCENT }]}
                accessibilityLabel={t('common.next') || 'Next'}
                accessibilityRole="button"
              >
                <Text style={gs.publishText}>{t('common.next') || 'Next'}</Text>
              </TouchableOpacity>
            ) : (
              <View style={{ width: 80 }} />
            )
          )}
        </View>

        {step === 1 ? (
          /* ============= STEP 1: MEDIA SELECTION ============= */
          <View style={gs.step1Wrap}>
            {/* Top preview area for selected media */}
            {mediaFiles.length > 0 ? (
              <View style={gs.previewStrip}>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={gs.previewStripContent}
                >
                  {mediaFiles.map((item, idx) => (
                    <View key={item.id} style={gs.previewStripItem}>
                      {item.type === 'video' && isWeb ? (
                        <video
                          src={item.uri + '#t=0.1'}
                          style={{ width: '100%', height: '100%', objectFit: 'cover', backgroundColor: '#000', borderRadius: 8 }}
                          preload="metadata"
                          muted
                        />
                      ) : (
                        <Image
                          source={{ uri: item.thumbnail || item.uri }}
                          style={gs.previewStripThumb}
                          resizeMode="cover"
                        />
                      )}
                      {item.type === 'video' && (
                        <View style={gs.previewStripDuration}>
                          <Text style={gs.previewStripDurationText}>
                            {item.duration ? formatDuration(item.duration) : 'VIDEO'}
                          </Text>
                        </View>
                      )}
                      {/* Reorder buttons */}
                      {mediaFiles.length > 1 && (
                        <View style={gs.reorderBtns}>
                          {idx > 0 && (
                            <TouchableOpacity onPress={() => moveMedia(idx, -1)} style={gs.reorderBtn}>
                              <Text style={gs.reorderBtnText}>{'<'}</Text>
                            </TouchableOpacity>
                          )}
                          {idx < mediaFiles.length - 1 && (
                            <TouchableOpacity onPress={() => moveMedia(idx, 1)} style={gs.reorderBtn}>
                              <Text style={gs.reorderBtnText}>{'>'}</Text>
                            </TouchableOpacity>
                          )}
                        </View>
                      )}
                      <TouchableOpacity
                        onPress={() => removeMedia(item.id)}
                        style={gs.previewStripRemove}
                        hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                      >
                        <IconX size={12} color="#fff" />
                      </TouchableOpacity>
                      <View style={gs.previewStripIndex}>
                        <Text style={gs.previewStripIndexText}>{idx + 1}</Text>
                      </View>
                    </View>
                  ))}
                </ScrollView>
                <Text style={[gs.previewStripCount, { color: colors.textSecondary }]}>
                  {mediaFiles.length}/{MAX_MEDIA}
                </Text>
              </View>
            ) : null}

            {/* Action buttons row */}
            <View style={[gs.actionRow, { borderBottomColor: borderColor }]}>
              <TouchableOpacity style={gs.actionBtn} onPress={pickMedia} activeOpacity={0.7}>
                <View style={[gs.actionIcon, { backgroundColor: isDark ? 'rgba(124,58,237,0.15)' : 'rgba(124,58,237,0.1)' }]}>
                  <IconImage size={22} color={ACCENT} />
                </View>
                <Text style={[gs.actionLabel, { color: colors.text }]}>{t('post.gallery') || 'Gallery'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={gs.actionBtn} onPress={openCamera} activeOpacity={0.7}>
                <View style={[gs.actionIcon, { backgroundColor: isDark ? 'rgba(59,130,246,0.15)' : 'rgba(59,130,246,0.1)' }]}>
                  <IconCamera size={22} color="#A78BFA" />
                </View>
                <Text style={[gs.actionLabel, { color: colors.text }]}>{t('post.camera') || 'Camera'}</Text>
              </TouchableOpacity>
              {!isWeb && (
                <TouchableOpacity
                  style={gs.actionBtn}
                  onPress={() => setMultiSelectMode(m => !m)}
                  activeOpacity={0.7}
                >
                  <View style={[gs.actionIcon, {
                    backgroundColor: multiSelectMode
                      ? (isDark ? 'rgba(168,85,247,0.2)' : 'rgba(168,85,247,0.1)')
                      : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'),
                  }]}>
                    <IconCheck size={22} color={multiSelectMode ? '#a855f7' : colors.textSecondary} />
                  </View>
                  <Text style={[gs.actionLabel, { color: multiSelectMode ? '#a855f7' : colors.text }]}>
                    {t('post.selectMultiple') || 'Multi'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Gallery Grid (native) or empty prompt (web) */}
            {isWeb ? (
              <View style={gs.webEmptyState}>
                <View style={[gs.webEmptyCard, {
                  backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
                  borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
                }]}>
                  <View style={[gs.iconCircle, {
                    backgroundColor: isDark ? 'rgba(124,58,237,0.12)' : 'rgba(124,58,237,0.08)',
                  }]}>
                    <IconCamera size={44} color={ACCENT} />
                  </View>
                  <Text style={[gs.webEmptyTitle, { color: colors.text }]}>
                    {t('post.dragOrSelect') || 'Select photos and videos'}
                  </Text>
                  <Text style={[gs.webEmptySubtitle, { color: colors.textSecondary }]}>
                    {(t('feed.selectMediaHint') || 'Up to {max} items').replace('{max}', MAX_MEDIA)}
                  </Text>
                  <View style={gs.webBtnRow}>
                    <TouchableOpacity style={gs.webBtn} onPress={pickMedia} activeOpacity={0.8}>
                      <IconImage size={20} color="#fff" />
                      <Text style={gs.webBtnText}>{t('post.gallery') || 'Gallery'}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[gs.webBtn, { backgroundColor: '#A78BFA' }]} onPress={openCamera} activeOpacity={0.8}>
                      <IconCamera size={20} color="#fff" />
                      <Text style={gs.webBtnText}>{t('post.camera') || 'Camera'}</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            ) : (
              <GalleryGrid
                onSelect={handleGallerySelect}
                selectedIds={gallerySelectedIds}
                colors={colors}
                isDark={isDark}
                t={t}
                isWeb={isWeb}
              />
            )}

            {/* Error */}
            {error ? (
              <View style={gs.floatingError}>
                <Text style={gs.floatingErrorText}>{error}</Text>
              </View>
            ) : null}
          </View>
        ) : (
          /* ============= STEP 2: CAPTION + OPTIONS ============= */
          <ScrollView
            style={gs.step2Scroll}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {/* Media preview carousel */}
            <View style={gs.previewContainer}>
              {mediaFiles.length === 1 ? (
                // Single media
                renderSingleMedia(mediaFiles[0], isWeb, activeFilter, colors, t)
              ) : (
                // Carousel
                <View>
                  <ScrollView
                    ref={scrollRef}
                    horizontal
                    pagingEnabled
                    showsHorizontalScrollIndicator={false}
                    decelerationRate="fast"
                    onScroll={(e) => {
                      const idx = Math.round(e.nativeEvent.contentOffset.x / cardWidth);
                      setActivePreviewIndex(idx);
                    }}
                    scrollEventThrottle={16}
                  >
                    {mediaFiles.map((item, idx) => (
                      <View key={item.id || idx} style={[gs.previewImage, { width: cardWidth }]}>
                        {renderMediaItem(item, isWeb, activeFilter, colors, t, idx)}
                      </View>
                    ))}
                  </ScrollView>
                  <View style={gs.previewCounter}>
                    <Text style={gs.previewCounterText}>
                      {activePreviewIndex + 1}/{mediaFiles.length}
                    </Text>
                  </View>
                  {mediaFiles.length <= 10 && (
                    <View style={gs.dotRow}>
                      {mediaFiles.map((_, idx) => (
                        <View
                          key={idx}
                          style={[gs.dot, {
                            width: idx === activePreviewIndex ? 8 : 6,
                            height: idx === activePreviewIndex ? 8 : 6,
                            borderRadius: 4,
                            backgroundColor: idx === activePreviewIndex ? ACCENT : 'rgba(255,255,255,0.5)',
                          }]}
                        />
                      ))}
                    </View>
                  )}
                </View>
              )}
            </View>

            {/* Filter bar */}
            <View style={[gs.filterSection, { borderTopColor: borderColor }]}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={gs.filterScrollContent}
              >
                {FILTERS.map((filter) => {
                  const isActive = activeFilter === filter.name;
                  const firstUri = mediaFiles.find(m => m.type === 'image')?.uri || mediaFiles[0]?.thumbnail || mediaFiles[0]?.uri;
                  return (
                    <TouchableOpacity
                      key={filter.name}
                      style={[gs.filterItem, isActive && gs.filterItemActive]}
                      onPress={() => setActiveFilter(filter.name)}
                      activeOpacity={0.7}
                      accessibilityLabel={filter.name}
                    >
                      <View style={[gs.filterThumb, isActive && { borderColor: ACCENT, borderWidth: 2 }]}>
                        {isWeb ? (
                          <img
                            src={firstUri}
                            style={{
                              width: '100%', height: '100%', objectFit: 'cover', borderRadius: 30,
                              filter: filter.css || undefined,
                            }}
                            alt={filter.name}
                          />
                        ) : (
                          <Image
                            source={{ uri: firstUri }}
                            style={[gs.filterThumbImage, getNativeFilterStyle(filter.name)]}
                            resizeMode="cover"
                          />
                        )}
                      </View>
                      <Text style={[gs.filterName, { color: isActive ? ACCENT : colors.textSecondary }, isActive && { fontWeight: '700' }]} numberOfLines={1}>
                        {filter.name}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>

            {/* Caption area */}
            <View style={[gs.captionSection, { borderTopColor: borderColor }]}>
              <View style={gs.captionHeader}>
                <AvatarCircle email={user?.email} name={user?.name || user?.email} size={36} colors={colors} />
                <View style={{ flex: 1, marginLeft: 10 }}>
                  <CaptionInput
                    value={caption}
                    onChangeText={setCaption}
                    placeholder={t('post.caption') || 'Write a caption...'}
                    colors={colors}
                    isDark={isDark}
                    t={t}
                    onMentionQuery={setMentionQuery}
                  />
                </View>
              </View>

              {/* Mention dropdown */}
              <MentionDropdown
                query={mentionQuery}
                onSelect={handleMentionSelect}
                colors={colors}
                isDark={isDark}
              />

              {/* Caption footer: char count + AI suggest */}
              <View style={gs.captionFooter}>
                <TouchableOpacity
                  style={[gs.aiBtn, { backgroundColor: isDark ? 'rgba(168,85,247,0.15)' : 'rgba(168,85,247,0.08)' }]}
                  onPress={suggestCaption}
                  disabled={aiLoading}
                  activeOpacity={0.7}
                >
                  {aiLoading ? (
                    <ActivityIndicator size="small" color="#a855f7" />
                  ) : (
                    <>
                      <IconSparkles size={16} color="#a855f7" />
                      <Text style={gs.aiBtnText}>{t('post.aiSuggest') || 'AI Suggest'}</Text>
                    </>
                  )}
                </TouchableOpacity>
                <Text style={[gs.charCount, {
                  color: captionRemaining < 100
                    ? (captionRemaining < 20 ? '#ef4444' : '#f59e0b')
                    : colors.textTertiary,
                }]}>
                  {captionRemaining}
                </Text>
              </View>
            </View>

            {/* ---- OPTIONS ---- */}

            {/* Location */}
            <TouchableOpacity
              style={[gs.optionRow, { borderTopColor: borderColor }]}
              activeOpacity={0.7}
              onPress={() => {
                // Focus location input - just toggle visibility
              }}
            >
              <IconMapPin size={22} color={colors.textSecondary} />
              <TextInput
                style={[gs.optionInput, { color: colors.text }]}
                placeholder={t('post.addLocation') || 'Add location'}
                placeholderTextColor={colors.textTertiary}
                value={location}
                onChangeText={setLocation}
                maxLength={100}
                accessibilityLabel={t('post.addLocation') || 'Add location'}
              />
              {location ? (
                <TouchableOpacity onPress={() => setLocation('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <IconX size={16} color={colors.textTertiary} />
                </TouchableOpacity>
              ) : (
                <IconChevronRight size={18} color={colors.textTertiary} />
              )}
            </TouchableOpacity>

            {/* Tag people */}
            <TouchableOpacity
              style={[gs.optionRow, { borderTopColor: borderColor }]}
              activeOpacity={0.7}
              onPress={() => setShowTagModal(true)}
            >
              <IconUsers size={22} color={colors.textSecondary} />
              <Text style={[gs.optionLabel, { color: taggedPeople.length > 0 ? colors.text : colors.textTertiary }]}>
                {taggedPeople.length > 0
                  ? taggedPeople.map(p => p.name || p.email.split('@')[0]).join(', ')
                  : (t('post.tagPeople') || 'Tag people')}
              </Text>
              <IconChevronRight size={18} color={colors.textTertiary} />
            </TouchableOpacity>

            {/* Add music */}
            <TouchableOpacity
              style={[gs.optionRow, { borderTopColor: borderColor }]}
              activeOpacity={0.7}
              onPress={() => { /* TODO: Sound picker */ }}
            >
              <IconMusic size={22} color={colors.textSecondary} />
              <Text style={[gs.optionLabel, { color: colors.textTertiary }]}>
                {t('post.addMusic') || 'Add music'}
              </Text>
              <IconChevronRight size={18} color={colors.textTertiary} />
            </TouchableOpacity>

            {/* Audience */}
            <TouchableOpacity
              style={[gs.optionRow, { borderTopColor: borderColor }]}
              activeOpacity={0.7}
              onPress={() => setShowAudienceModal(true)}
            >
              <AudienceIcon size={22} color={colors.textSecondary} />
              <Text style={[gs.optionLabel, { color: colors.text }]}>
                {audienceLabel}
              </Text>
              <IconChevronRight size={18} color={colors.textTertiary} />
            </TouchableOpacity>

            {/* Post as Reel toggle (only if there's video content) */}
            {mediaFiles.some(m => m.type === 'video') && (
              <View style={[gs.optionRow, { borderTopColor: borderColor }]}>
                <IconVideo size={22} color={postAsReel ? ACCENT : colors.textSecondary} />
                <Text style={[gs.optionLabel, { color: postAsReel ? ACCENT : colors.text, flex: 1 }]}>
                  {t('post.postAsReel') || 'Post as Reel'}
                </Text>
                <Switch
                  value={postAsReel}
                  onValueChange={setPostAsReel}
                  trackColor={{ false: isDark ? '#333' : '#ddd', true: 'rgba(124,58,237,0.4)' }}
                  thumbColor={postAsReel ? ACCENT : '#f4f3f4'}
                />
              </View>
            )}

            {/* Schedule */}
            <TouchableOpacity
              style={[gs.optionRow, { borderTopColor: borderColor }]}
              activeOpacity={0.7}
              onPress={() => {
                if (!scheduleDate) {
                  // Set default to 1 hour from now
                  const d = new Date(Date.now() + 3600000);
                  const iso = d.toISOString().slice(0, 16);
                  setScheduleDate(iso);
                } else {
                  setScheduleDate(null);
                }
              }}
            >
              <IconClock size={22} color={scheduleDate ? '#f59e0b' : colors.textSecondary} />
              <Text style={[gs.optionLabel, { color: scheduleDate ? '#f59e0b' : colors.textTertiary }]}>
                {scheduleDate ? (t('post.scheduled') || 'Scheduled') : (t('post.schedule') || 'Schedule post')}
              </Text>
              {scheduleDate ? (
                <TouchableOpacity onPress={() => setScheduleDate(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <IconX size={16} color="#f59e0b" />
                </TouchableOpacity>
              ) : (
                <IconChevronRight size={18} color={colors.textTertiary} />
              )}
            </TouchableOpacity>

            {/* Schedule date picker */}
            <SchedulePicker value={scheduleDate} onChange={setScheduleDate} colors={colors} isDark={isDark} t={t} />

            {/* Error */}
            {error ? (
              <View style={gs.errorRow}>
                <Text style={gs.errorText}>{error}</Text>
              </View>
            ) : null}

            <View style={{ height: 120 }} />
          </ScrollView>
        )}
      </KeyboardAvoidingView>

      {/* Modals */}
      <AudienceModal
        visible={showAudienceModal}
        onClose={() => setShowAudienceModal(false)}
        selected={audience}
        onSelect={setAudience}
        colors={colors}
        isDark={isDark}
        t={t}
      />
      <TagPeopleModal
        visible={showTagModal}
        onClose={() => setShowTagModal(false)}
        tagged={taggedPeople}
        onTag={setTaggedPeople}
        colors={colors}
        isDark={isDark}
        t={t}
      />
    </Modal>
  );
}

// ---- Render helpers for media preview ----
function renderSingleMedia(item, isWeb, activeFilter, colors, t) {
  if (item.type === 'video') {
    if (isWeb) {
      return (
        <View style={gs.previewImage}>
          <video
            src={item.uri + '#t=0.1'}
            style={{
              width: '100%', height: '100%', objectFit: 'contain', backgroundColor: '#000',
              filter: activeFilter !== 'Normal' ? FILTERS.find(f => f.name === activeFilter)?.css || '' : undefined,
            }}
            controls playsInline preload="auto"
          />
        </View>
      );
    }
    return (
      <View style={[gs.previewImage, { backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }]}>
        {(() => {
          const thumbUri = item.thumbnail;
          if (thumbUri) {
            return (
              <>
                <CachedImage source={{ uri: thumbUri }} style={StyleSheet.absoluteFill} resizeMode="contain" />
                <View style={{ position: 'absolute', alignItems: 'center', justifyContent: 'center' }}>
                  <View style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' }}>
                    <IconPlay size={28} color="#fff" />
                  </View>
                </View>
                {item.duration && (
                  <View style={gs.previewDuration}>
                    <Text style={gs.previewDurationText}>{formatDuration(item.duration)}</Text>
                  </View>
                )}
              </>
            );
          }
          try {
            const { Video } = require('expo-av');
            return <Video source={{ uri: item.uri }} style={StyleSheet.absoluteFill} resizeMode="contain" useNativeControls shouldPlay={false} positionMillis={1} />;
          } catch {
            return (
              <>
                <CachedImage source={{ uri: item.uri }} style={StyleSheet.absoluteFill} resizeMode="contain" />
                <View style={gs.previewVideoBadge}><Text style={gs.previewVideoBadgeText}>VIDEO</Text></View>
              </>
            );
          }
        })()}
      </View>
    );
  }
  // Image
  if (isWeb) {
    return (
      <View style={gs.previewImage}>
        <img
          src={item.uri}
          style={{
            width: '100%', height: '100%', objectFit: 'contain',
            filter: activeFilter !== 'Normal' ? FILTERS.find(f => f.name === activeFilter)?.css || '' : undefined,
          }}
          alt={t('feed.selectedMedia') || 'Selected media'}
        />
      </View>
    );
  }
  return (
    <Image
      source={{ uri: item.uri }}
      style={[gs.previewImage, getNativeFilterStyle(activeFilter)]}
      resizeMode="contain"
      accessibilityLabel={t('feed.selectedMedia') || 'Selected media'}
    />
  );
}

function renderMediaItem(item, isWeb, activeFilter, colors, t, idx) {
  if (item.type === 'video') {
    if (isWeb) {
      return (
        <video
          src={item.uri + '#t=0.1'}
          style={{
            width: '100%', height: '100%', objectFit: 'contain', backgroundColor: '#000',
            filter: activeFilter !== 'Normal' ? FILTERS.find(f => f.name === activeFilter)?.css || '' : undefined,
          }}
          controls playsInline preload="auto"
        />
      );
    }
    try {
      const { Video } = require('expo-av');
      return <Video source={{ uri: item.uri }} style={StyleSheet.absoluteFill} resizeMode="contain" useNativeControls shouldPlay={false} positionMillis={1} />;
    } catch {
      return (
        <>
          <CachedImage source={{ uri: item.thumbnail || item.uri }} style={[StyleSheet.absoluteFill, getNativeFilterStyle(activeFilter)]} resizeMode="contain" />
          <View style={gs.previewVideoBadge}><Text style={gs.previewVideoBadgeText}>VIDEO</Text></View>
        </>
      );
    }
  }
  if (isWeb) {
    return (
      <img
        src={item.uri}
        style={{
          width: '100%', height: '100%', objectFit: 'contain',
          filter: activeFilter !== 'Normal' ? FILTERS.find(f => f.name === activeFilter)?.css || '' : undefined,
        }}
        alt={`${t('feed.selectedMedia') || 'Media'} ${idx + 1}`}
      />
    );
  }
  return (
    <Image
      source={{ uri: item.uri }}
      style={[StyleSheet.absoluteFill, getNativeFilterStyle(activeFilter)]}
      resizeMode="contain"
      accessibilityLabel={`${t('feed.selectedMedia') || 'Media'} ${idx + 1}`}
    />
  );
}

// ===========================================================================
// STYLES
// ===========================================================================
const gs = StyleSheet.create({
  container: { flex: 1 },

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingTop: Platform.OS === 'ios' ? 56 : Platform.OS === 'web' ? 16 : 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: { padding: 6, width: 80 },
  headerTitle: { fontSize: 18, fontWeight: '700', textAlign: 'center', flex: 1, letterSpacing: 0.1 },
  publishBtn: { paddingHorizontal: 18, paddingVertical: 9, borderRadius: 20, minWidth: 80, alignItems: 'center' },
  publishText: { color: '#fff', fontWeight: '700', fontSize: 14 },

  // Step 1
  step1Wrap: { flex: 1 },

  // Preview strip (selected media at top)
  previewStrip: {
    paddingVertical: 12, paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(128,128,128,0.15)',
  },
  previewStripContent: { paddingHorizontal: 12, gap: 8 },
  previewStripItem: { width: 80, height: 80, borderRadius: 10, overflow: 'hidden', position: 'relative' },
  previewStripThumb: { width: '100%', height: '100%', borderRadius: 10 },
  previewStripDuration: {
    position: 'absolute', bottom: 4, left: 4,
    backgroundColor: 'rgba(0,0,0,0.7)', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1,
  },
  previewStripDurationText: { color: '#fff', fontSize: 9, fontWeight: '700' },
  previewStripRemove: {
    position: 'absolute', top: 4, right: 4,
    width: 20, height: 20, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center', justifyContent: 'center',
  },
  previewStripIndex: {
    position: 'absolute', top: 4, left: 4,
    width: 20, height: 20, borderRadius: 10, backgroundColor: 'rgba(124,58,237,0.9)',
    alignItems: 'center', justifyContent: 'center',
  },
  previewStripIndexText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  previewStripCount: { textAlign: 'right', paddingRight: 16, marginTop: 6, fontSize: 12, fontWeight: '600' },
  reorderBtns: {
    position: 'absolute', bottom: 4, right: 4,
    flexDirection: 'row', gap: 2,
  },
  reorderBtn: {
    width: 18, height: 18, borderRadius: 9, backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center', justifyContent: 'center',
  },
  reorderBtnText: { color: '#fff', fontSize: 10, fontWeight: '700' },

  // Action buttons row
  actionRow: {
    flexDirection: 'row', paddingVertical: 12, paddingHorizontal: 16, gap: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  actionBtn: { alignItems: 'center', gap: 4 },
  actionIcon: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  actionLabel: { fontSize: 11, fontWeight: '600' },

  // Web empty state
  webEmptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  webEmptyCard: {
    alignItems: 'center', padding: 44, borderRadius: 24,
    borderWidth: 2, borderStyle: 'dashed', width: '100%', maxWidth: 420,
  },
  iconCircle: { width: 88, height: 88, borderRadius: 44, alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  webEmptyTitle: { fontSize: 20, fontWeight: '700', marginBottom: 6, textAlign: 'center' },
  webEmptySubtitle: { fontSize: 14, marginBottom: 24, textAlign: 'center' },
  webBtnRow: { flexDirection: 'row', gap: 12 },
  webBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: ACCENT, paddingHorizontal: 24, paddingVertical: 13, borderRadius: 26,
  },
  webBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },

  // Gallery grid
  galleryEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  galleryEmptyText: { fontSize: 15, textAlign: 'center' },
  galleryItem: { position: 'relative' },
  galleryThumb: { width: '100%', height: '100%' },
  galleryDuration: {
    position: 'absolute', bottom: 4, right: 4,
    backgroundColor: 'rgba(0,0,0,0.7)', borderRadius: 3, paddingHorizontal: 4, paddingVertical: 1,
  },
  galleryDurationText: { color: '#fff', fontSize: 10, fontWeight: '600' },
  gallerySel: {
    position: 'absolute', top: 6, right: 6,
    width: 24, height: 24, borderRadius: 12, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
  },
  gallerySelText: { color: '#fff', fontSize: 11, fontWeight: '700' },

  // Floating error
  floatingError: {
    position: 'absolute', bottom: 30, left: 20, right: 20,
    backgroundColor: 'rgba(239,68,68,0.9)', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 12,
  },
  floatingErrorText: { color: '#fff', fontSize: 14, fontWeight: '500', textAlign: 'center' },

  // Step 2
  step2Scroll: { flex: 1 },
  previewContainer: { backgroundColor: '#000' },
  previewImage: { width: '100%', aspectRatio: 1, backgroundColor: '#000' },
  previewVideoBadge: {
    position: 'absolute', top: 14, left: 14,
    backgroundColor: 'rgba(0,0,0,0.7)', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3,
  },
  previewVideoBadgeText: { color: '#fff', fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  previewDuration: {
    position: 'absolute', bottom: 14, right: 14,
    backgroundColor: 'rgba(0,0,0,0.7)', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3,
  },
  previewDurationText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  previewCounter: {
    position: 'absolute', top: 14, right: 14,
    backgroundColor: 'rgba(0,0,0,0.7)', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4,
  },
  previewCounterText: { color: '#fff', fontSize: 12, fontWeight: '600', letterSpacing: 0.5 },
  dotRow: {
    flexDirection: 'row', justifyContent: 'center', gap: 4, paddingVertical: 10,
    position: 'absolute', bottom: 0, left: 0, right: 0,
  },
  dot: {},

  // Filter bar
  filterSection: { borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 12 },
  filterScrollContent: { paddingHorizontal: 12, gap: 12 },
  filterItem: { alignItems: 'center', width: 72 },
  filterItemActive: {},
  filterThumb: {
    width: 60, height: 60, borderRadius: 30, overflow: 'hidden', backgroundColor: '#222',
    borderWidth: 2, borderColor: 'transparent', marginBottom: 5,
  },
  filterThumbImage: { width: '100%', height: '100%', borderRadius: 30 },
  filterName: { fontSize: 11, textAlign: 'center', letterSpacing: 0.1 },

  // Caption section
  captionSection: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8, borderTopWidth: StyleSheet.hairlineWidth },
  captionHeader: { flexDirection: 'row', alignItems: 'flex-start' },
  captionWrap: { flex: 1 },
  captionInput: {
    fontSize: 16, lineHeight: 22, minHeight: 60, maxHeight: 160, textAlignVertical: 'top',
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  captionFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
  charCount: { fontSize: 12, fontVariant: ['tabular-nums'] },

  // AI suggest button
  aiBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16,
  },
  aiBtnText: { color: '#a855f7', fontSize: 13, fontWeight: '600' },

  // Mention dropdown
  mentionDrop: {
    borderRadius: 12, borderWidth: 1, marginTop: 4, maxHeight: 240, overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 12 },
      android: { elevation: 6 },
      default: {},
    }),
  },
  mentionItem: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10 },
  mentionName: { fontSize: 14, fontWeight: '600' },
  mentionEmail: { fontSize: 12, marginTop: 1 },

  // Option rows
  optionRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 15, borderTopWidth: StyleSheet.hairlineWidth, gap: 14,
  },
  optionInput: {
    flex: 1, fontSize: 15, paddingVertical: 0,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  optionLabel: { flex: 1, fontSize: 15 },

  // Schedule picker
  scheduleRow: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 52, paddingBottom: 10, gap: 10,
  },
  scheduleInput: {
    flex: 1, fontSize: 15, paddingVertical: 0,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },

  // Error
  errorRow: { paddingHorizontal: 16, paddingVertical: 10 },
  errorText: { color: '#ef4444', fontSize: 14, fontWeight: '500' },

  // Audience modal
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  audienceSheet: {
    borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingBottom: 40, paddingTop: 20,
  },
  audienceTitle: { fontSize: 18, fontWeight: '700', textAlign: 'center', marginBottom: 16 },
  audienceRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, gap: 14 },
  audienceIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  audienceLabel: { fontSize: 16, fontWeight: '600' },
  audienceDesc: { fontSize: 13, marginTop: 2 },

  // Tag people modal
  tagModal: { flex: 1, paddingTop: Platform.OS === 'ios' ? 56 : 16 },
  tagHeader: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, gap: 12,
  },
  tagTitle: { flex: 1, fontSize: 18, fontWeight: '700' },
  tagDoneBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 18 },
  tagDoneText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  tagSearchRow: { marginHorizontal: 16, marginVertical: 10, borderRadius: 12, paddingHorizontal: 14 },
  tagSearchInput: {
    fontSize: 15, paddingVertical: 10,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  tagChipScroll: { paddingVertical: 8 },
  tagChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16 },
  tagChipText: { fontSize: 13, fontWeight: '600' },
  tagResultRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  tagResultName: { fontSize: 15, fontWeight: '600' },
  tagResultEmail: { fontSize: 13, marginTop: 1 },
  tagCheckbox: {
    width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: 'rgba(128,128,128,0.3)',
    alignItems: 'center', justifyContent: 'center',
  },
});
