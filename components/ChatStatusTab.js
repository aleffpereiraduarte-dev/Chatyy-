import { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList, ScrollView, Platform,
  Modal, TextInput, Image, Animated, Dimensions, KeyboardAvoidingView,
  ActivityIndicator,
} from 'react-native';
import AvatarCircle from './AvatarCircle';
import { IconPlus, IconCamera, IconEdit, IconX, IconSearch, IconTrash } from './Icons';
import * as api from '../services/api';
import { BASE_URL } from '../services/api';

const SCREEN_WIDTH = Dimensions.get('window').width;
const STATUS_DURATION = 5000;

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const str = dateStr.endsWith('Z') || dateStr.includes('+') ? dateStr : dateStr + 'Z';
  const now = Date.now();
  const then = new Date(str).getTime();
  const diffMs = now - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'agora';
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

const TEXT_BG_COLORS = [
  '#075E54', '#128C7E', '#25D366', '#1A73E8', '#6B5CE7',
  '#E84393', '#D63031', '#E17055', '#FDCB6E', '#00B894',
];

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
  const progressAnim = useRef(new Animated.Value(0)).current;
  const timerRef = useRef(null);

  // Creator state
  const [creatorVisible, setCreatorVisible] = useState(false);
  const [creatorMode, setCreatorMode] = useState('text'); // 'text' | 'photo'
  const [textContent, setTextContent] = useState('');
  const [textBgColor, setTextBgColor] = useState(TEXT_BG_COLORS[0]);
  const [photoUri, setPhotoUri] = useState(null);
  const [photoFile, setPhotoFile] = useState(null);
  const [publishing, setPublishing] = useState(false);

  const currentEmail = user?.email || '';
  const currentName = user?.name || user?.email?.split('@')[0] || '';

  // Load statuses from API
  const loadStatuses = useCallback(async () => {
    try {
      const r = await api.statusList();
      if (r.success && r.data) {
        const mine = [];
        const others = [];
        for (const group of r.data) {
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

  // Split into viewed and recent (unviewed)
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
    setViewerIndex(0);
    setViewerVisible(true);
  }, []);

  const closeViewer = useCallback(() => {
    setViewerVisible(false);
    if (timerRef.current) clearTimeout(timerRef.current);
    progressAnim.stopAnimation();
    progressAnim.setValue(0);
  }, [progressAnim]);

  const advanceViewer = useCallback(() => {
    // Mark current as viewed via API
    const currentItem = viewerStatuses[viewerIndex];
    if (currentItem && !currentItem.viewed) {
      api.statusView(currentItem.id).catch(() => {});
      currentItem.viewed = true;
    }

    if (viewerIndex < viewerStatuses.length - 1) {
      setViewerIndex((prev) => prev + 1);
    } else {
      closeViewer();
      loadStatuses(); // Refresh to update viewed state
    }
  }, [viewerStatuses, viewerIndex, closeViewer, loadStatuses]);

  useEffect(() => {
    if (!viewerVisible || viewerStatuses.length === 0) return;

    progressAnim.setValue(0);
    const anim = Animated.timing(progressAnim, {
      toValue: 1,
      duration: STATUS_DURATION,
      useNativeDriver: false,
    });
    anim.start();

    timerRef.current = setTimeout(advanceViewer, STATUS_DURATION);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      anim.stop();
    };
  }, [viewerVisible, viewerIndex, viewerStatuses.length]);

  const handleViewerTap = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    progressAnim.stopAnimation();
    advanceViewer();
  }, [advanceViewer, progressAnim]);

  // ─── Creator Logic ───
  const openCreator = useCallback((mode = 'text') => {
    setTextContent('');
    setPhotoUri(null);
    setPhotoFile(null);
    setCreatorMode(mode);
    setTextBgColor(TEXT_BG_COLORS[Math.floor(Math.random() * TEXT_BG_COLORS.length)]);
    if (mode === 'photo') {
      // Open image picker
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
        // Upload image first, then publish
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

  // ─── My Status Section ───
  const hasMyStatus = myStatuses.length > 0;
  const myStatusGroup = hasMyStatus
    ? { ownerEmail: currentEmail, ownerName: currentName, items: myStatuses }
    : null;

  const titleLabel = t?.('status.title') || 'Status';
  const myStatusLabel = t?.('status.myStatus') || 'Meu status';
  const addStatusLabel = t?.('status.tapToAdd') || 'Toque para adicionar status';
  const disappearsLabel = t?.('status.disappears') || 'Desaparece após 24 horas';
  const recentLabel = t?.('status.recentUpdates') || 'Atualizações recentes';
  const viewedLabel = t?.('status.viewed') || 'Visualizados';
  const typePlaceholder = t?.('status.typeSomething') || 'Digite um status...';
  const emptyLabel = t?.('status.noUpdates') || 'Nenhuma atualização recente';

  const renderStatusRow = (statusGroup, showGreenRing) => {
    const latestItem = statusGroup.items[statusGroup.items.length - 1];
    const time = timeAgo(latestItem?.timestamp);

    return (
      <TouchableOpacity
        key={statusGroup.ownerEmail}
        style={[styles.statusRow, { borderBottomColor: colors.border }]}
        onPress={() => openViewer(statusGroup)}
        activeOpacity={0.7}
      >
        <View style={styles.avatarWrapper}>
          {showGreenRing && <View style={styles.greenRing} />}
          <AvatarCircle name={statusGroup.ownerName} email={statusGroup.ownerEmail} size={52} />
        </View>
        <View style={styles.statusInfo}>
          <Text style={[styles.statusName, { color: colors.text }]} numberOfLines={1}>
            {statusGroup.ownerName}
          </Text>
          <Text style={[styles.statusTime, { color: colors.textSecondary }]}>{time}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color="#25D366" />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>{titleLabel}</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity style={styles.headerBtn} onPress={() => setShowSearch(!showSearch)}>
            <IconSearch size={22} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
      </View>

      {showSearch && (
        <View style={[styles.searchBar, { backgroundColor: isDark ? colors.card : '#f0f2f5' }]}>
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
        </View>
      )}

      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        {/* My Status */}
        <TouchableOpacity
          style={[styles.myStatusRow, { borderBottomColor: colors.border }]}
          onPress={() => hasMyStatus ? openViewer(myStatusGroup) : openCreator()}
          activeOpacity={0.7}
        >
          <View style={styles.myAvatarWrapper}>
            {hasMyStatus && <View style={styles.greenRing} />}
            <AvatarCircle name={currentName} email={currentEmail} size={56} />
            {!hasMyStatus && (
              <View style={styles.plusBadge}>
                <IconPlus size={14} color="#fff" />
              </View>
            )}
          </View>
          <View style={styles.statusInfo}>
            <Text style={[styles.statusName, { color: colors.text, fontSize: 17 }]}>
              {myStatusLabel}
            </Text>
            <Text style={[styles.statusTime, { color: colors.textSecondary }]}>
              {hasMyStatus ? timeAgo(myStatuses[myStatuses.length - 1]?.timestamp) : addStatusLabel}
            </Text>
          </View>
          <View style={styles.myStatusActions}>
            {hasMyStatus && (
              <TouchableOpacity
                style={[styles.actionCircle, { backgroundColor: isDark ? '#2a2a2e' : '#fce4ec' }]}
                onPress={() => {
                  const last = myStatuses[myStatuses.length - 1];
                  if (last) deleteMyStatus(last.id);
                }}
              >
                <IconTrash size={18} color="#D63031" />
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[styles.actionCircle, { backgroundColor: isDark ? '#2a2a2e' : '#e8f5e9', marginLeft: hasMyStatus ? 10 : 0 }]}
              onPress={openCreator}
            >
              <IconEdit size={20} color="#25D366" />
            </TouchableOpacity>
          </View>
        </TouchableOpacity>

        {/* Recent Updates */}
        {recentStatuses.length > 0 && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>{recentLabel}</Text>
            {recentStatuses.map((s) => renderStatusRow(s, true))}
          </View>
        )}

        {/* Viewed */}
        {viewedStatuses.length > 0 && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>{viewedLabel}</Text>
            {viewedStatuses.map((s) => renderStatusRow(s, false))}
          </View>
        )}

        {/* Empty state */}
        {recentStatuses.length === 0 && viewedStatuses.length === 0 && (
          <View style={styles.emptyContainer}>
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>{emptyLabel}</Text>
            <Text style={[styles.emptySubtext, { color: colors.textSecondary }]}>{disappearsLabel}</Text>
          </View>
        )}
      </ScrollView>

      {/* FABs - camera + text */}
      <TouchableOpacity style={[styles.fabSecondary, { backgroundColor: isDark ? '#2a2a2e' : '#e8f5e9' }]} onPress={() => openCreator('photo')} activeOpacity={0.8}>
        <IconCamera size={22} color="#25D366" />
      </TouchableOpacity>
      <TouchableOpacity style={[styles.fab, { backgroundColor: '#25D366' }]} onPress={() => openCreator('text')} activeOpacity={0.8}>
        <IconEdit size={24} color="#fff" />
      </TouchableOpacity>

      {/* ─── Status Viewer Modal ─── */}
      <Modal visible={viewerVisible} animationType="fade" transparent={false} onRequestClose={closeViewer}>
        <View style={styles.viewerContainer}>
          <View style={styles.progressBarRow}>
            {viewerStatuses.map((item, idx) => (
              <View key={item.id} style={styles.progressBarTrack}>
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

          <View style={styles.viewerHeader}>
            <AvatarCircle name={viewerOwnerName} size={36} />
            <View style={styles.viewerHeaderInfo}>
              <Text style={styles.viewerName} numberOfLines={1}>{viewerOwnerName}</Text>
              <Text style={styles.viewerTime}>{timeAgo(viewerStatuses[viewerIndex]?.timestamp)}</Text>
            </View>
            <TouchableOpacity onPress={closeViewer} style={styles.viewerClose}>
              <IconX size={26} color="#fff" />
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={styles.viewerContent} activeOpacity={1} onPress={handleViewerTap}>
            {viewerStatuses[viewerIndex]?.type === 'text' ? (
              <View style={[styles.viewerTextCard, { backgroundColor: viewerStatuses[viewerIndex]?.bgColor || '#075E54' }]}>
                <Text style={styles.viewerText}>{viewerStatuses[viewerIndex]?.content}</Text>
              </View>
            ) : viewerStatuses[viewerIndex]?.type === 'image' ? (
              <View style={{ flex: 1, width: '100%', alignItems: 'center', justifyContent: 'center' }}>
                <Image
                  source={{ uri: (() => { const url = (viewerStatuses[viewerIndex]?.content || '').split('\n')[0]; return url.startsWith('/') ? BASE_URL + url : url; })() }}
                  style={styles.viewerImage}
                  resizeMode="contain"
                />
                {(viewerStatuses[viewerIndex]?.content || '').includes('\n') && (
                  <Text style={styles.viewerCaption}>
                    {(viewerStatuses[viewerIndex]?.content || '').split('\n').slice(1).join('\n')}
                  </Text>
                )}
              </View>
            ) : null}
          </TouchableOpacity>
        </View>
      </Modal>

      {/* ─── Status Creator Modal ─── */}
      <Modal visible={creatorVisible} animationType="slide" transparent={false} onRequestClose={() => setCreatorVisible(false)}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={[styles.creatorContainer, { backgroundColor: creatorMode === 'photo' ? '#000' : textBgColor }]}>
            <View style={styles.creatorHeader}>
              <TouchableOpacity onPress={() => setCreatorVisible(false)}>
                <IconX size={26} color="#fff" />
              </TouchableOpacity>
              <View style={{ flex: 1 }} />
              {creatorMode === 'text' && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.colorPicker}>
                  {TEXT_BG_COLORS.map((c) => (
                    <TouchableOpacity
                      key={c}
                      onPress={() => setTextBgColor(c)}
                      style={[styles.colorDot, { backgroundColor: c }, textBgColor === c && styles.colorDotSelected]}
                    />
                  ))}
                </ScrollView>
              )}
            </View>

            <View style={styles.creatorBody}>
              {creatorMode === 'photo' && photoUri ? (
                <Image source={{ uri: photoUri }} style={styles.creatorPhoto} resizeMode="contain" />
              ) : (
                <TextInput
                  style={styles.creatorInput}
                  placeholder={typePlaceholder}
                  placeholderTextColor="rgba(255,255,255,0.5)"
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
                  placeholderTextColor="rgba(255,255,255,0.5)"
                  value={textContent}
                  onChangeText={setTextContent}
                  maxLength={200}
                />
              )}
            </View>

            <View style={styles.creatorFooter}>
              <TouchableOpacity
                style={[styles.sendBtn, publishing && styles.sendBtnDisabled,
                  creatorMode === 'text' && !textContent.trim() && styles.sendBtnDisabled]}
                onPress={publishStatus}
                disabled={publishing || (creatorMode === 'text' && !textContent.trim())}
                activeOpacity={0.8}
              >
                {publishing ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.sendBtnText}>{t?.('status.publish') || 'Publicar'}</Text>
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
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { fontSize: 24, fontWeight: '700' },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  headerBtn: { padding: 6 },
  searchBar: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: 16, marginTop: 10, marginBottom: 4,
    borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8,
  },
  searchInput: {
    flex: 1, fontSize: 15, marginLeft: 8, marginRight: 8, paddingVertical: 0,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  scrollView: { flex: 1 },
  myStatusRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  myAvatarWrapper: { position: 'relative' },
  plusBadge: {
    position: 'absolute', bottom: 0, right: 0,
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: '#25D366', alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: '#fff',
  },
  myStatusActions: { flexDirection: 'row', alignItems: 'center' },
  actionCircle: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  statusRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  avatarWrapper: { position: 'relative' },
  greenRing: {
    position: 'absolute', top: -3, left: -3, right: -3, bottom: -3,
    borderRadius: 999, borderWidth: 2.5, borderColor: '#25D366', zIndex: 0,
  },
  statusInfo: { flex: 1, marginLeft: 14 },
  statusName: { fontSize: 16, fontWeight: '600' },
  statusTime: { fontSize: 13, marginTop: 2 },
  section: { marginTop: 6 },
  sectionTitle: {
    fontSize: 13, fontWeight: '600', textTransform: 'uppercase',
    letterSpacing: 0.5, paddingHorizontal: 20, paddingVertical: 10,
  },
  emptyContainer: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, paddingHorizontal: 40 },
  emptyText: { fontSize: 16, fontWeight: '500', textAlign: 'center' },
  emptySubtext: { fontSize: 13, marginTop: 6, textAlign: 'center' },
  fabSecondary: {
    position: 'absolute', bottom: 90, right: 24, width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    elevation: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2, shadowRadius: 4,
  },
  fab: {
    position: 'absolute', bottom: 24, right: 20, width: 56, height: 56, borderRadius: 28,
    alignItems: 'center', justifyContent: 'center',
    elevation: 6, shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25, shadowRadius: 5,
  },
  viewerContainer: { flex: 1, backgroundColor: '#000' },
  progressBarRow: {
    flexDirection: 'row', paddingHorizontal: 8,
    paddingTop: Platform.OS === 'ios' ? 54 : 12, gap: 3,
  },
  progressBarTrack: { flex: 1, height: 2.5, backgroundColor: 'rgba(255,255,255,0.3)', borderRadius: 2, overflow: 'hidden' },
  progressBarFill: { height: '100%', backgroundColor: '#fff', borderRadius: 2 },
  viewerHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10 },
  viewerHeaderInfo: { flex: 1, marginLeft: 10 },
  viewerName: { color: '#fff', fontSize: 16, fontWeight: '600' },
  viewerTime: { color: 'rgba(255,255,255,0.7)', fontSize: 12, marginTop: 1 },
  viewerClose: { padding: 6 },
  viewerContent: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  viewerTextCard: { width: '100%', flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  viewerText: { color: '#fff', fontSize: 28, fontWeight: '600', textAlign: 'center', lineHeight: 38 },
  viewerImage: { width: SCREEN_WIDTH, height: '100%' },
  viewerCaption: { color: '#fff', fontSize: 16, textAlign: 'center', paddingHorizontal: 20, paddingVertical: 12, backgroundColor: 'rgba(0,0,0,0.4)', position: 'absolute', bottom: 0, left: 0, right: 0 },
  creatorContainer: { flex: 1 },
  creatorHeader: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingTop: Platform.OS === 'ios' ? 54 : 16, paddingBottom: 10,
  },
  colorPicker: { flexDirection: 'row', maxWidth: 200 },
  colorDot: { width: 26, height: 26, borderRadius: 13, marginHorizontal: 4, borderWidth: 2, borderColor: 'transparent' },
  colorDotSelected: { borderColor: '#fff' },
  creatorBody: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  creatorInput: {
    color: '#fff', fontSize: 28, fontWeight: '600', textAlign: 'center', width: '100%', maxHeight: 250,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  creatorPhoto: { width: '100%', flex: 1, borderRadius: 8 },
  captionInput: {
    fontSize: 16, textAlign: 'center', width: '100%', paddingVertical: 12,
    borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.2)', marginTop: 8,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  creatorFooter: { paddingHorizontal: 20, paddingBottom: Platform.OS === 'ios' ? 40 : 24, alignItems: 'center' },
  sendBtn: { backgroundColor: 'rgba(255,255,255,0.25)', paddingHorizontal: 40, paddingVertical: 14, borderRadius: 28 },
  sendBtnDisabled: { opacity: 0.4 },
  sendBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
