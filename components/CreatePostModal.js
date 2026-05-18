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
// Wave 15: structured location picker — same WhatsApp-style sheet used
// for sharing GPS in chat. Returns { latitude, longitude, address } so
// we can post `location_lat / _lon / _name` alongside the free-text.
import LocationPickerSheet from './LocationPickerSheet';
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
export default function CreatePostModal({
  visible, colors, isDark, t, user, onClose, onPostCreated, initialFiles, repostOf, originalPost,
  // Reels P0 — Duet / Stitch / preset sound entrypoints.
  // - duetOf:    parent post id to record a side-by-side companion clip for.
  // - stitchOf:  parent post id to trim 1-5s from then append our own clip.
  // - presetSoundId / presetSoundLabel: pre-fill the sound picker so a reel
  //   posted from "Use this sound" already has the right audio attached.
  duetOf, stitchOf, presetSoundId, presetSoundLabel,
}) {
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

  // Reels P0 — Duet / Stitch metadata fetched from the parent post once on open.
  // duetParent is the result of chat_reels_duet_init / chat_reels_stitch_init
  // (video_url, thumbnail, sound_id, etc.). Used to:
  //   • render a parent-clip preview pill in the composer
  //   • inherit the parent's sound_id when no override is provided
  //   • POST media to /api/duet-compose.php for server-side ffmpeg compose
  //   • forward parent_post_id + duet_type to feed_create_post
  const [duetParent, setDuetParent] = useState(null);
  // Stitch trim window — [start_ms, end_ms]. TikTok-style 1-5s budget.
  const [stitchTrim, setStitchTrim] = useState({ start: 0, end: 3000 });
  // Selected sound (from picker OR preset OR parent inherited).
  const [selectedSound, setSelectedSound] = useState(
    presetSoundId ? { id: presetSoundId, label: presetSoundLabel || '' } : null
  );
  const [showSoundPicker, setShowSoundPicker] = useState(false);
  const [savedSounds, setSavedSounds] = useState([]);
  const [savedSoundsLoading, setSavedSoundsLoading] = useState(false);
  // Reels — Pixabay catalog + tab state for the music picker. The
  // bottom sheet has three tabs: "Catálogo" (Pixabay royalty-free),
  // "Meus salvos" (chat_user_saved_sounds), and "Original" (no sound).
  // Catalog rows are { id: "pixabay/<n>", title, artist, preview_url,
  // duration_sec, image_url }.
  const [soundPickerTab, setSoundPickerTab] = useState('catalog');
  const [catalogSounds, setCatalogSounds] = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogQuery, setCatalogQuery] = useState('');
  const duetMode = duetOf ? 'split' : (stitchOf ? 'stitch' : null);

  // Bootstrap the parent-post payload when Duet/Stitch mode is active.
  useEffect(() => {
    if (!visible) return;
    const parentId = duetOf || stitchOf;
    if (!parentId) { setDuetParent(null); return; }
    let alive = true;
    (async () => {
      try {
        const r = duetOf
          ? await api.chatReelsDuetInit(parentId)
          : await api.chatReelsStitchInit(parentId);
        if (!alive) return;
        if (r?.success && r.data) {
          setDuetParent(r.data);
          // Skip the gallery step — the user picks "Record" on step 2.
          setStep(2);
          // Inherit the parent's sound unless caller already supplied one.
          if (!selectedSound && r.data.sound_id) {
            setSelectedSound({ id: r.data.sound_id, label: r.data.sound_label || '' });
          }
          // Default stitch trim to the first 3s of the parent.
          if (stitchOf) setStitchTrim({ start: 0, end: Math.min(3000, Math.max(1500, r.data.duration_ms || 3000)) });
        } else {
          setError(r?.error || (duetOf ? 'Duet desativado pelo autor' : 'Stitch desativado pelo autor'));
        }
      } catch { /* non-fatal */ }
    })();
    return () => { alive = false; };
  }, [visible, duetOf, stitchOf]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lazy-load saved sounds (per-user favorites from chat_user_saved_sounds).
  // Hits the new reels_sound_favorite_list endpoint, falls back to the old
  // chat_status_music_search ('saved' source) so users with no migrated
  // favorites still see their legacy Status music picks.
  const loadSavedSounds = useCallback(async () => {
    if (savedSoundsLoading) return;
    setSavedSoundsLoading(true);
    try {
      let r = null;
      try { r = await api.reelsSoundFavoriteList?.(); } catch {}
      if (!r?.success || !Array.isArray(r?.data?.tracks) || r.data.tracks.length === 0) {
        try { r = await api.apiCall?.('chat_status_music_search', { source: 'saved' }, 'POST'); } catch {}
      }
      if (r?.success && r.data?.tracks) setSavedSounds(r.data.tracks);
      else if (Array.isArray(r?.data)) setSavedSounds(r.data);
    } catch {}
    setSavedSoundsLoading(false);
  }, [savedSoundsLoading]);

  // Lazy-load Pixabay catalog (royalty-free music). When a query is set
  // (search mode) we hit reels_music_search; otherwise the catalog feed
  // (order=popular). 1h backend cache means hot queries are free.
  const loadCatalogSounds = useCallback(async (q = '') => {
    if (catalogLoading) return;
    setCatalogLoading(true);
    try {
      const r = q
        ? await api.reelsMusicSearch?.(q)
        : await api.reelsMusicCatalog?.();
      if (r?.success && Array.isArray(r.data?.tracks)) {
        setCatalogSounds(r.data.tracks);
      } else {
        setCatalogSounds([]);
      }
    } catch { setCatalogSounds([]); }
    setCatalogLoading(false);
  }, [catalogLoading]);

  // Open the picker → hydrate the active tab.
  useEffect(() => {
    if (!showSoundPicker) return;
    if (soundPickerTab === 'catalog' && catalogSounds.length === 0 && !catalogLoading) loadCatalogSounds('');
    if (soundPickerTab === 'saved'  && savedSounds.length   === 0 && !savedSoundsLoading) loadSavedSounds();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSoundPicker, soundPickerTab]);
  const [caption, setCaption] = useState('');
  const [location, setLocation] = useState('');
  // Wave 15: structured location coords (lat/lon). Set by the
  // LocationPickerSheet — kept separate from `location` so users can
  // also free-type a name without losing the coords (or vice-versa).
  const [locationCoords, setLocationCoords] = useState(null);
  const [showLocationSheet, setShowLocationSheet] = useState(false);
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
  // Cross-post toggles ("Compartilhar também em" — placeholder mock).
  // Selecting them just toggles UI; actual fan-out lands when the platform
  // bridges (Status/Stories/Twitter) are wired up server-side.
  const [crossPosts, setCrossPosts] = useState({ status: false, stories: false, twitter: false });
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
    setLocationCoords(null);
    setShowLocationSheet(false);
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
    setCrossPosts({ status: false, stories: false, twitter: false });
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
      // Reels P0 — Duet / Stitch: when the user is in either mode, the raw
      // captured clip flows through /api/duet-compose.php first so ffmpeg can
      // hstack (duet) or concat-trim (stitch) it with the parent. We then
      // publish the composed media via feed_create_post's media_url= path
      // (no double-upload — the composer left the file on the server).
      let composedMedia = null;
      if (duetMode && duetParent?.post_id && mediaFiles.length > 0) {
        const dfd = new FormData();
        dfd.append('parent_post_id', String(duetParent.post_id));
        dfd.append('duet_type', duetMode);
        if (duetMode === 'stitch') {
          dfd.append('clip_start_ms', String(stitchTrim.start || 0));
          dfd.append('clip_end_ms', String(stitchTrim.end || 3000));
        }
        const item = mediaFiles[0];
        if (isWeb) dfd.append('media', item.file, item.file.name);
        else dfd.append('media', item.file);
        const cr = await api.duetCompose(dfd);
        if (!cr?.success) {
          setError(cr?.error || (duetMode === 'split' ? 'Duet compose failed' : 'Stitch compose failed'));
          setPublishing(false);
          return;
        }
        composedMedia = cr.data;
      }

      const formData = new FormData();
      formData.append('caption', caption.trim());
      if (location.trim()) formData.append('location', location.trim());
      // Wave 15: structured location coords + name. The picker fills
      // these; we also fall back to free-typed `location` when only a
      // name is available.
      if (locationCoords?.latitude != null && locationCoords?.longitude != null) {
        formData.append('location_lat', String(locationCoords.latitude));
        formData.append('location_lon', String(locationCoords.longitude));
      }
      if ((locationCoords?.address || location).trim()) {
        formData.append('location_name', (locationCoords?.address || location).trim());
      }
      if (audience !== AUDIENCE_EVERYONE) formData.append('audience', audience);
      if (scheduleDate) formData.append('scheduled_at', scheduleDate);
      if (taggedPeople.length > 0) formData.append('tagged', JSON.stringify(taggedPeople.map(p => p.email)));
      if (repostOf) formData.append('repost_of', String(repostOf));

      // Reels P0 — sound + duet/stitch metadata on the new post.
      if (selectedSound?.id) {
        formData.append('sound_id', String(selectedSound.id));
        if (selectedSound.label) formData.append('sound_label', selectedSound.label);
      }
      if (duetMode && duetParent?.post_id) {
        formData.append('parent_post_id', String(duetParent.post_id));
        formData.append('duet_type', duetMode);
      }

      const hasVideo = mediaFiles.some(m => m.type === 'video') || !!composedMedia;
      formData.append('media_type', hasVideo ? 'video' : 'image');
      if ((postAsReel && hasVideo) || duetMode) formData.append('is_reel', '1');
      if (activeFilter && activeFilter !== 'Normal') {
        formData.append('filter', activeFilter);
      }

      if (composedMedia?.media_url) {
        // Composed flow: ffmpeg already produced the final clip on disk;
        // hand the URL to feed_create_post instead of re-uploading bytes.
        formData.append('media_url', composedMedia.media_url);
      } else {
        for (let i = 0; i < mediaFiles.length; i++) {
          const item = mediaFiles[i];
          if (isWeb) {
            formData.append('media[]', item.file, item.file.name);
          } else {
            formData.append('media[]', item.file);
          }
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
  }, [publishing, mediaFiles, caption, location, locationCoords, audience, scheduleDate, taggedPeople, isWeb, handleClose, onPostCreated, t, activeFilter, repostOf, postAsReel, duetMode, duetParent, stitchTrim, selectedSound]);

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
              {/* Floating "Editar" pill — placeholder; surfaces feedback if PhotoEditor isn't wired */}
              {mediaFiles.some(m => m.type === 'image') ? (
                <TouchableOpacity
                  style={gs.editFab}
                  activeOpacity={0.85}
                  onPress={() => {
                    setError(t('post.editorComingSoon') || 'Editor de foto em breve');
                    setTimeout(() => setError(''), 2200);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={t('post.edit') || 'Editar'}
                >
                  <IconSparkles size={14} color="#fff" />
                  <Text style={gs.editFabText}>{t('post.edit') || 'Editar'}</Text>
                </TouchableOpacity>
              ) : null}
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
                  {`${caption.length}/${MAX_CAPTION}`}
                </Text>
              </View>
            </View>

            {/* ---- OPTIONS ---- */}

            {/* Location — Wave 15: tapping opens LocationPickerSheet to
                grab GPS coords; the user can still free-type the label
                via the inline TextInput when offline / no GPS. */}
            <View
              style={[gs.optionRow, { borderTopColor: borderColor }]}
            >
              <TouchableOpacity
                onPress={() => setShowLocationSheet(true)}
                hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                accessibilityRole="button"
                accessibilityLabel={t('post.addLocation') || 'Adicionar local'}
              >
                <IconMapPin size={22} color={locationCoords ? ACCENT : colors.textSecondary} />
              </TouchableOpacity>
              <TextInput
                style={[gs.optionInput, { color: colors.text }]}
                placeholder={t('post.addLocation') || 'Adicionar local'}
                placeholderTextColor={colors.textTertiary}
                value={location}
                onChangeText={setLocation}
                maxLength={100}
                accessibilityLabel={t('post.addLocation') || 'Adicionar local'}
              />
              {(location || locationCoords) ? (
                <TouchableOpacity
                  onPress={() => { setLocation(''); setLocationCoords(null); }}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <IconX size={16} color={colors.textTertiary} />
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  onPress={() => setShowLocationSheet(true)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <IconChevronRight size={18} color={colors.textTertiary} />
                </TouchableOpacity>
              )}
            </View>

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

            {/* Reels P0 — Add music / sound picker.
                Opens a bottom sheet with the user's saved tracks +
                "Original sound" option. If presetSoundId / a parent-inherited
                sound is already set, that row is highlighted. The list is
                intentionally NOT a music catalog — we don't have rights
                clearance for arbitrary tracks (Epidemic Sound deal pending),
                so users pick from sounds they've previously saved or use the
                creator's original audio (mic-only). */}
            <TouchableOpacity
              style={[gs.optionRow, { borderTopColor: borderColor }]}
              activeOpacity={0.7}
              onPress={() => { setShowSoundPicker(true); loadSavedSounds(); }}
            >
              <IconMusic size={22} color={colors.textSecondary} />
              <Text style={[gs.optionLabel, { color: selectedSound ? colors.text : colors.textTertiary }]}>
                {selectedSound
                  ? (selectedSound.label || (t('post.musicSelected') || 'Som selecionado'))
                  : (t('post.addMusic') || 'Add music')}
              </Text>
              {selectedSound ? (
                <TouchableOpacity hitSlop={8} onPress={(e) => { e.stopPropagation && e.stopPropagation(); setSelectedSound(null); }}>
                  <IconX size={16} color={colors.textTertiary} />
                </TouchableOpacity>
              ) : (
                <IconChevronRight size={18} color={colors.textTertiary} />
              )}
            </TouchableOpacity>

            {/* Reels P0 — Duet / Stitch banner. When the user is composing
                a duet or stitch, show the parent thumbnail + mode so they
                see what they're recording against. */}
            {duetMode && duetParent ? (
              <View
                style={[gs.optionRow, {
                  borderTopColor: borderColor,
                  backgroundColor: isDark ? 'rgba(124,58,237,0.10)' : 'rgba(124,58,237,0.06)',
                }]}
              >
                <View style={{ width: 32, height: 44, borderRadius: 4, overflow: 'hidden', backgroundColor: '#000' }}>
                  {duetParent.thumbnail_url ? (
                    <Image source={{ uri: duetParent.thumbnail_url }} style={{ width: 32, height: 44 }} />
                  ) : null}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: ACCENT, fontSize: 11, fontWeight: '700' }}>
                    {duetMode === 'split' ? (t('feed.duet') || 'Duet') : (t('feed.stitch') || 'Stitch')}
                  </Text>
                  <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>
                    @{duetParent.author_name || duetParent.author_email?.split('@')[0]}
                  </Text>
                </View>
              </View>
            ) : null}

            {/* Audience */}
            <TouchableOpacity
              style={[gs.optionRow, { borderTopColor: borderColor }]}
              activeOpacity={0.7}
              onPress={() => setShowAudienceModal(true)}
              accessibilityRole="button"
              accessibilityLabel={t('post.audience') || 'Audience'}
            >
              <AudienceIcon size={22} color={colors.textSecondary} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.textTertiary, fontSize: 12, fontWeight: '500' }}>
                  {t('post.whoCanSee') || 'Quem pode ver'}
                </Text>
                <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600', marginTop: 1 }}>
                  {audienceLabel}
                </Text>
              </View>
              <IconChevronRight size={18} color={colors.textTertiary} />
            </TouchableOpacity>

            {/* Cross-post pills ("Compartilhar também em") */}
            <View style={[gs.crossPostRow, { borderTopColor: borderColor }]}>
              <Text style={[gs.crossPostLabel, { color: colors.textSecondary }]}>
                {t('post.alsoShareIn') || 'Compartilhar também em'}
              </Text>
              <View style={gs.crossPostPills}>
                {[
                  { key: 'status', label: t('post.status') || 'Status' },
                  { key: 'stories', label: t('post.stories') || 'Stories' },
                  { key: 'twitter', label: 'Twitter' },
                ].map(({ key, label }) => {
                  const active = !!crossPosts[key];
                  return (
                    <TouchableOpacity
                      key={key}
                      style={[
                        gs.crossPostPill,
                        active
                          ? { backgroundColor: ACCENT, borderColor: ACCENT }
                          : { borderColor: isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.12)' },
                      ]}
                      onPress={() => setCrossPosts(prev => ({ ...prev, [key]: !prev[key] }))}
                      activeOpacity={0.75}
                      accessibilityRole="switch"
                      accessibilityState={{ checked: active }}
                      accessibilityLabel={label}
                    >
                      <Text style={[
                        gs.crossPostPillText,
                        { color: active ? '#fff' : colors.text },
                      ]}>
                        {label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

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

            <View style={{ height: 24 }} />
          </ScrollView>
        )}

        {/* ---- BOTTOM SHARE BUTTON (Step 2 only) ---- */}
        {step === 2 ? (
          <View style={[gs.bottomShareWrap, { borderTopColor: borderColor, backgroundColor: bgColor }]}>
            <TouchableOpacity
              onPress={publish}
              disabled={publishing || mediaFiles.length === 0}
              activeOpacity={0.85}
              style={[
                gs.bottomShareBtn,
                { backgroundColor: ACCENT },
                (publishing || mediaFiles.length === 0) && gs.bottomShareBtnDisabled,
              ]}
              accessibilityRole="button"
              accessibilityLabel={t('post.share') || 'Share'}
            >
              {publishing ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={gs.bottomShareText}>
                  {scheduleDate ? (t('post.schedule') || 'Agendar') : (t('post.share') || 'Compartilhar')}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        ) : null}
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

      {/* Wave 15: WhatsApp-style location sheet. Returns coords + a
          reverse-geocoded address. We store both — coords go to
          location_lat/_lon, address to location_name + the visible
          textbox so the user can edit before posting. */}
      <LocationPickerSheet
        visible={showLocationSheet}
        onClose={() => setShowLocationSheet(false)}
        onSend={({ latitude, longitude, address }) => {
          setLocationCoords({ latitude, longitude, address: address || '' });
          if (address) setLocation(address);
          setShowLocationSheet(false);
        }}
        colors={colors}
        t={t}
      />

      {/* Reels P0 — Sound picker (3 tabs: Catálogo / Meus salvos / Original).
          Catálogo proxies Pixabay's royalty-free music endpoint via
          reels_music_catalog / reels_music_search. Meus salvos lists the
          user's chat_user_saved_sounds. Original = no sound_id (backend
          synthesizes "<email>/<post_id>" for the creator's audio). */}
      <Modal
        visible={showSoundPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowSoundPicker(false)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }}
          onPress={() => setShowSoundPicker(false)}
        >
          <Pressable
            style={{
              backgroundColor: isDark ? '#0f172a' : '#fff',
              borderTopLeftRadius: 18,
              borderTopRightRadius: 18,
              paddingBottom: 28,
              maxHeight: SCREEN_HEIGHT * 0.78,
            }}
            onPress={(e) => e.stopPropagation && e.stopPropagation()}
          >
            <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: isDark ? 'rgba(255,255,255,0.20)' : 'rgba(0,0,0,0.18)', alignSelf: 'center', marginVertical: 10 }} />
            <Text style={{ color: colors.text, fontSize: 18, fontWeight: '700', paddingHorizontal: 20, marginBottom: 8 }}>
              {t('post.chooseSound') || 'Escolha um som'}
            </Text>

            {/* Tabs */}
            <View style={{ flexDirection: 'row', paddingHorizontal: 16, gap: 8, marginBottom: 8 }}>
              {[
                { key: 'catalog', label: t('post.catalog') || 'Catálogo' },
                { key: 'saved',   label: t('post.mySaved') || 'Meus salvos' },
                { key: 'original',label: t('post.originalSound') || 'Original' },
              ].map(tb => {
                const active = soundPickerTab === tb.key;
                return (
                  <TouchableOpacity
                    key={tb.key}
                    onPress={() => setSoundPickerTab(tb.key)}
                    activeOpacity={0.75}
                    style={{
                      paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999,
                      borderWidth: StyleSheet.hairlineWidth,
                      borderColor: active ? ACCENT : (isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)'),
                      backgroundColor: active ? (isDark ? 'rgba(124,58,237,0.22)' : 'rgba(124,58,237,0.10)') : 'transparent',
                    }}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: active }}
                  >
                    <Text style={{ color: active ? ACCENT : colors.text, fontWeight: active ? '700' : '500', fontSize: 13 }}>
                      {tb.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Catalog (Pixabay royalty-free) */}
            {soundPickerTab === 'catalog' && (
              <>
                <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, marginBottom: 8, gap: 8 }}>
                  <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)', borderRadius: 10, paddingHorizontal: 10 }}>
                    <IconMusic size={16} color={colors.textSecondary} />
                    <TextInput
                      style={{ flex: 1, color: colors.text, fontSize: 14, paddingVertical: 8, marginLeft: 6, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) }}
                      placeholder={t('post.searchSounds') || 'Buscar sons…'}
                      placeholderTextColor={colors.textTertiary}
                      value={catalogQuery}
                      onChangeText={setCatalogQuery}
                      onSubmitEditing={() => loadCatalogSounds(catalogQuery.trim())}
                      returnKeyType="search"
                      autoCorrect={false}
                      autoCapitalize="none"
                    />
                  </View>
                </View>
                {catalogLoading ? (
                  <View style={{ paddingVertical: 18, alignItems: 'center' }}>
                    <ActivityIndicator size="small" color={ACCENT} />
                  </View>
                ) : catalogSounds.length === 0 ? (
                  <View style={{ paddingVertical: 18, paddingHorizontal: 20 }}>
                    <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
                      {t('post.noCatalogSounds') || 'Sem resultados. Tente outra busca.'}
                    </Text>
                  </View>
                ) : (
                  <FlatList
                    data={catalogSounds}
                    keyExtractor={(it) => String(it.id)}
                    renderItem={({ item: trk }) => {
                      const trackId = String(trk.id);
                      const label = `${trk.title || ''} — ${trk.artist || ''}`.replace(/^ — /, '').replace(/ — $/, '');
                      const active = selectedSound?.id === trackId;
                      return (
                        <TouchableOpacity
                          style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 10, gap: 12 }}
                          activeOpacity={0.7}
                          onPress={() => {
                            setSelectedSound({ id: trackId, label });
                            setShowSoundPicker(false);
                          }}
                        >
                          {trk.image_url ? (
                            <Image source={{ uri: trk.image_url }} style={{ width: 40, height: 40, borderRadius: 4 }} />
                          ) : (
                            <View style={{ width: 40, height: 40, borderRadius: 4, backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)', alignItems: 'center', justifyContent: 'center' }}>
                              <IconMusic size={20} color={colors.textSecondary} />
                            </View>
                          )}
                          <View style={{ flex: 1 }}>
                            <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }} numberOfLines={1}>
                              {trk.title || 'Untitled'}
                            </Text>
                            <Text style={{ color: colors.textSecondary, fontSize: 12 }} numberOfLines={1}>
                              {trk.artist || 'Pixabay'} · {trk.duration_sec || 30}s
                            </Text>
                          </View>
                          {active ? <IconCheck size={20} color={ACCENT} /> : null}
                        </TouchableOpacity>
                      );
                    }}
                  />
                )}
              </>
            )}

            {/* Saved tab */}
            {soundPickerTab === 'saved' && (
              savedSoundsLoading ? (
                <View style={{ paddingVertical: 18, alignItems: 'center' }}>
                  <ActivityIndicator size="small" color={ACCENT} />
                </View>
              ) : savedSounds.length === 0 ? (
                <View style={{ paddingVertical: 18, paddingHorizontal: 20 }}>
                  <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
                    {t('post.noSavedSounds') || 'Sem sons salvos ainda. Toque "Salvar som" nos reels que você curtir.'}
                  </Text>
                </View>
              ) : (
                <FlatList
                  data={savedSounds}
                  keyExtractor={(it) => String(it.id || it.sound_id || it.track_id)}
                  renderItem={({ item: trk }) => {
                    const trackId = String(trk.id || trk.sound_id || trk.track_id);
                    const active = selectedSound?.id === trackId;
                    const label = trk.sound_label || `${trk.title || ''} — ${trk.artist || ''}`.replace(/^ — /, '').replace(/ — $/, '');
                    const img = trk.image_url || trk.artwork_url;
                    return (
                      <TouchableOpacity
                        style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 12, gap: 12 }}
                        activeOpacity={0.7}
                        onPress={() => {
                          setSelectedSound({ id: trackId, label });
                          setShowSoundPicker(false);
                        }}
                      >
                        {img ? (
                          <Image source={{ uri: img }} style={{ width: 40, height: 40, borderRadius: 4 }} />
                        ) : (
                          <View style={{ width: 40, height: 40, borderRadius: 4, backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)', alignItems: 'center', justifyContent: 'center' }}>
                            <IconMusic size={20} color={colors.textSecondary} />
                          </View>
                        )}
                        <View style={{ flex: 1 }}>
                          <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }} numberOfLines={1}>
                            {trk.title || label || 'Sem título'}
                          </Text>
                          <Text style={{ color: colors.textSecondary, fontSize: 12 }} numberOfLines={1}>
                            {trk.artist || ''}
                          </Text>
                        </View>
                        {active ? <IconCheck size={20} color={ACCENT} /> : null}
                      </TouchableOpacity>
                    );
                  }}
                />
              )
            )}

            {/* Original (Reels P0 — no sound_id, backend uses creator's
                mic-only audio and synthesizes "<email>/<post_id>"). */}
            {soundPickerTab === 'original' && (
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, gap: 12 }}
                activeOpacity={0.7}
                onPress={() => { setSelectedSound(null); setShowSoundPicker(false); }}
              >
                <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: ACCENT, alignItems: 'center', justifyContent: 'center' }}>
                  <IconMusic size={20} color="#fff" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>
                    {t('post.originalSound') || 'Som original do criador'}
                  </Text>
                  <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
                    {t('post.originalSoundHint') || 'Áudio gravado com o vídeo'}
                  </Text>
                </View>
                {!selectedSound ? <IconCheck size={20} color={ACCENT} /> : null}
              </TouchableOpacity>
            )}
          </Pressable>
        </Pressable>
      </Modal>
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
  publishBtn: {
    paddingHorizontal: 18, paddingVertical: 9, borderRadius: 22, minWidth: 84,
    alignItems: 'center', justifyContent: 'center',
    ...Platform.select({
      ios: { shadowColor: ACCENT, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.28, shadowRadius: 8 },
      android: { elevation: 3 },
      default: { boxShadow: '0 3px 8px rgba(124,58,237,0.28)' },
    }),
  },
  publishText: { color: '#fff', fontWeight: '700', fontSize: 14, letterSpacing: 0.2 },

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
    width: 26, height: 26, borderRadius: 13, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.25, shadowRadius: 2 },
      android: { elevation: 2 },
      default: { boxShadow: '0 1px 2px rgba(0,0,0,0.25)' },
    }),
  },
  gallerySelText: { color: '#fff', fontSize: 12, fontWeight: '700', letterSpacing: 0.2 },

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
  captionSection: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 10, borderTopWidth: StyleSheet.hairlineWidth },
  captionHeader: { flexDirection: 'row', alignItems: 'flex-start' },
  captionWrap: { flex: 1 },
  captionInput: {
    fontSize: 16, lineHeight: 23, minHeight: 78, maxHeight: 200, textAlignVertical: 'top',
    paddingTop: 2, paddingBottom: 2,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  captionFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 },
  charCount: { fontSize: 12, fontWeight: '500', fontVariant: ['tabular-nums'], letterSpacing: 0.2 },

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

  // Cross-post pills row
  crossPostRow: {
    paddingHorizontal: 16, paddingTop: 14, paddingBottom: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  crossPostLabel: { fontSize: 13, fontWeight: '600', marginBottom: 10, letterSpacing: 0.1 },
  crossPostPills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  crossPostPill: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1,
  },
  crossPostPillText: { fontSize: 13, fontWeight: '700', letterSpacing: 0.1 },

  // Bottom share button (full-width 56pt purple pill)
  bottomShareWrap: {
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: Platform.OS === 'ios' ? 32 : 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  bottomShareBtn: {
    height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center',
    flexDirection: 'row', gap: 8,
    ...Platform.select({
      ios: { shadowColor: ACCENT, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.32, shadowRadius: 14 },
      android: { elevation: 6 },
      default: { boxShadow: '0 6px 14px rgba(124,58,237,0.32)' },
    }),
  },
  bottomShareBtnDisabled: {
    ...Platform.select({
      ios: { shadowOpacity: 0 },
      android: { elevation: 0 },
      default: { boxShadow: 'none' },
    }),
    opacity: 0.55,
  },
  bottomShareText: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: 0.3 },

  // Editar floating pill on carousel
  editFab: {
    position: 'absolute', bottom: 14, right: 14,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.62)',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4 },
      android: { elevation: 3 },
      default: { boxShadow: '0 2px 6px rgba(0,0,0,0.3)' },
    }),
  },
  editFabText: { color: '#fff', fontSize: 13, fontWeight: '700', letterSpacing: 0.2 },

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
