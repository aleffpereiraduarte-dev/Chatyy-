import ErrorBoundary from "../components/ErrorBoundary";
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, ActivityIndicator,
  Modal, Pressable, FlatList, TextInput, Alert, RefreshControl, ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { BorderRadius, FontSize, Spacing } from '../constants/theme';
import {
  IconArrowLeft, IconPlus, IconFileText, IconBarChart, IconTrash,
  IconEdit, IconCopy, IconShare, IconSearch, IconMoreVert, IconFolder,
  IconX, IconRefresh,
} from '../components/Icons';
import { docsList, docsCreate, docsRename, docsTrash, docsDuplicate } from '../services/api';
import { getCached, setCache } from '../services/cache';
import SwipeableRow from '../components/SwipeableRow';

const DOCS_BASE = Platform.OS === 'web' ? 'https://chatyy.com.br/docs/' : 'https://mail.onemundo.com.br/docs/';

function formatDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return ''; }
}

function formatSize(bytes) {
  if (!bytes || bytes === 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function DocTypeIcon({ type, size = 28 }) {
  if (type === 'spreadsheet') {
    return (
      <View style={[iconStyles.badge, { backgroundColor: '#e8f5e9' }]}>
        <IconBarChart size={size * 0.6} color="#34a853" />
      </View>
    );
  }
  if (type === 'presentation') {
    return (
      <View style={[iconStyles.badge, { backgroundColor: '#fff3e0' }]}>
        <IconFileText size={size * 0.6} color="#ff9800" />
      </View>
    );
  }
  if (type === 'markdown') {
    return (
      <View style={[iconStyles.badge, { backgroundColor: '#f3e5f5' }]}>
        <IconFileText size={size * 0.6} color="#9c27b0" />
      </View>
    );
  }
  if (type === 'drawing') {
    return (
      <View style={[iconStyles.badge, { backgroundColor: '#fce4ec' }]}>
        <IconEdit size={size * 0.6} color="#e91e63" />
      </View>
    );
  }
  return (
    <View style={[iconStyles.badge, { backgroundColor: '#e3f2fd' }]}>
      <IconFileText size={size * 0.6} color="#4285f4" />
    </View>
  );
}

const iconStyles = StyleSheet.create({
  badge: {
    width: 44, height: 44, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
});

function DocumentosScreenInner() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();

  const [documents, setDocuments] = useState([]);
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [contextDoc, setContextDoc] = useState(null);
  const [renameDoc, setRenameDoc] = useState(null);
  const [renameText, setRenameText] = useState('');
  const [currentFolder, setCurrentFolder] = useState(null);
  const [folderStack, setFolderStack] = useState([]);
  const searchRef = useRef(null);
  const docsRequestIdRef = useRef(0); // Race condition guard

  // Fetch documents
  const fetchDocs = useCallback(async (isRefresh = false) => {
    const requestId = ++docsRequestIdRef.current;
    if (isRefresh) setRefreshing(true);
    setError(null);

    // ALWAYS show cached docs instantly (cache-first pattern)
    if (!isRefresh && !searchQuery) {
      try {
        const cached = await getCached('docs_list_' + (currentFolder || 'root'));
        if (requestId !== docsRequestIdRef.current) return;
        if (cached) {
          setDocuments(cached.documents || []);
          setFolders(cached.folders || []);
          setLoading(false);
        } else {
          setLoading(true);
        }
      } catch {
        setLoading(true);
      }
    } else if (!isRefresh) {
      setLoading(true);
    }

    try {
      const params = {};
      if (searchQuery) params.q = searchQuery;
      if (currentFolder) params.folder_id = currentFolder;
      const res = await docsList(params);
      if (requestId !== docsRequestIdRef.current) return; // Stale request
      if (res?.success) {
        const docs = res.data?.documents || [];
        const flds = res.data?.folders || [];
        setDocuments(docs);
        setFolders(flds);
        // Cache for instant load next time
        if (!searchQuery) {
          setCache('docs_list_' + (currentFolder || 'root'), { documents: docs, folders: flds }, 7776000000).catch(() => {});
        }
      } else {
        // Only show error if no cached data
        if (!documents.length) setError(res?.message || t('docs.loadError'));
      }
    } catch (e) {
      if (!documents.length) setError(t('docs.loadError'));
    } finally {
      if (requestId === docsRequestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [searchQuery, currentFolder, t, documents.length]);

  useEffect(() => { fetchDocs(); }, [fetchDocs]);

  // Actions
  const handleOpenDoc = useCallback((doc) => {
    const docId = doc.doc_id || doc.id;
    let page = 'editor.html';
    if (doc.type === 'spreadsheet') page = 'spreadsheet.html';
    else if (doc.type === 'presentation') page = 'presentation.html';
    else if (doc.type === 'markdown') page = 'markdown.html';
    else if (doc.type === 'drawing') page = 'drawing.html';
    const url = `${DOCS_BASE}${page}?id=${docId}`;
    if (Platform.OS === 'web') {
      window.open(url, '_blank');
    } else {
      router.push({ pathname: '/documentos-viewer', params: { url } });
    }
  }, [router]);

  const handleCreateDoc = useCallback(async (type) => {
    setShowCreateMenu(false);
    const titleMap = {
      document: t('docs.untitledDocument') || 'Untitled Document',
      spreadsheet: t('docs.untitledSpreadsheet') || 'Untitled Spreadsheet',
      presentation: t('docs.untitledPresentation') || 'Untitled Presentation',
      markdown: t('docs.untitledMarkdown') || 'Untitled Markdown',
      drawing: t('docs.untitledDrawing') || 'Untitled Drawing',
    };
    const pageMap = {
      document: 'editor.html',
      spreadsheet: 'spreadsheet.html',
      presentation: 'presentation.html',
      markdown: 'markdown.html',
      drawing: 'drawing.html',
    };
    try {
      const res = await docsCreate({
        type,
        title: titleMap[type] || titleMap.document,
        folder_id: currentFolder || undefined,
      });
      if (res?.success) {
        const docId = res.data?.doc_id;
        if (docId) {
          const url = `${DOCS_BASE}${pageMap[type] || 'editor.html'}?id=${docId}`;
          if (Platform.OS === 'web') {
            window.open(url, '_blank');
          }
        }
        fetchDocs();
      }
    } catch {}
  }, [currentFolder, fetchDocs, t]);

  const handleTrash = useCallback(async (doc) => {
    setContextDoc(null);
    const doIt = async () => {
      try {
        await docsTrash(doc.doc_id);
        fetchDocs();
      } catch {}
    };
    if (Platform.OS === 'web') {
      if (window.confirm(t('docs.confirmDelete'))) doIt();
    } else {
      Alert.alert(
        t('common.delete'),
        t('docs.confirmDelete'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('common.delete'), style: 'destructive', onPress: doIt },
        ]
      );
    }
  }, [fetchDocs, t]);

  const handleRename = useCallback(async () => {
    if (!renameDoc || !renameText.trim()) return;
    try {
      await docsRename(renameDoc.doc_id, renameText.trim());
      fetchDocs();
    } catch {}
    setRenameDoc(null);
    setRenameText('');
  }, [renameDoc, renameText, fetchDocs]);

  const handleDuplicate = useCallback(async (doc) => {
    setContextDoc(null);
    try {
      await docsDuplicate(doc.doc_id);
      fetchDocs();
    } catch {}
  }, [fetchDocs]);

  const handleShare = useCallback((doc) => {
    setContextDoc(null);
    const docId = doc.doc_id || doc.id;
    const pageMap = { spreadsheet: 'spreadsheet.html', presentation: 'presentation.html', markdown: 'markdown.html', drawing: 'drawing.html' };
    const page = pageMap[doc.type] || 'editor.html';
    const url = `${DOCS_BASE}${page}?id=${docId}&share=1`;
    if (Platform.OS === 'web') {
      window.open(url, '_blank');
    } else {
      router.push({ pathname: '/documentos-viewer', params: { url } });
    }
  }, [router]);

  const openRename = useCallback((doc) => {
    setContextDoc(null);
    setRenameDoc(doc);
    setRenameText(doc.title || '');
  }, []);

  const openEdit = useCallback((doc) => {
    setContextDoc(null);
    handleOpenDoc(doc);
  }, [handleOpenDoc]);

  const openFolder = useCallback((folder) => {
    setFolderStack(prev => [...prev, { id: currentFolder, name: folder.name }]);
    setCurrentFolder(folder.id);
  }, [currentFolder]);

  const goBackFolder = useCallback(() => {
    const stack = [...folderStack];
    const prev = stack.pop();
    setFolderStack(stack);
    setCurrentFolder(prev?.id || null);
  }, [folderStack]);

  // Context menu items
  const contextMenuItems = [
    { key: 'edit', label: t('common.edit'), icon: IconEdit, color: colors.text, action: openEdit },
    { key: 'rename', label: t('docs.rename'), icon: IconFileText, color: colors.text, action: openRename },
    { key: 'duplicate', label: t('docs.duplicate'), icon: IconCopy, color: colors.text, action: handleDuplicate },
    { key: 'share', label: t('docs.share'), icon: IconShare, color: colors.text, action: handleShare },
    { key: 'delete', label: t('common.delete'), icon: IconTrash, color: '#ea4335', action: handleTrash },
  ];

  // Render a single document row
  const renderDocItem = useCallback(({ item }) => {
    const row = (
      <TouchableOpacity
        style={[s.docRow, { borderBottomColor: colors.border }]}
        onPress={() => handleOpenDoc(item)}
        onLongPress={() => setContextDoc(item)}
        delayLongPress={400}
        activeOpacity={0.7}
        accessibilityLabel={item.title}
        accessibilityRole="button"
      >
        <DocTypeIcon type={item.type} />
        <View style={s.docInfo}>
          <Text style={[s.docTitle, { color: colors.text }]} numberOfLines={1}>
            {item.title || (t('docs.untitledDocument'))}
          </Text>
          <View style={s.docMeta}>
            <Text style={[s.docDate, { color: colors.textSecondary }]}>
              {formatDate(item.updated_at)}
            </Text>
            {item.file_size > 0 && (
              <Text style={[s.docSize, { color: colors.textSecondary }]}>
                {' \u00B7 '}{formatSize(item.file_size)}
              </Text>
            )}
            {item.my_permission && item.my_permission !== 'owner' && (
              <Text style={[s.docShared, { color: colors.primary }]}>
                {' \u00B7 '}{t('docs.shared')}
              </Text>
            )}
          </View>
        </View>
        <TouchableOpacity
          style={s.moreBtn}
          onPress={() => setContextDoc(item)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <IconMoreVert size={20} color={colors.textSecondary} />
        </TouchableOpacity>
      </TouchableOpacity>
    );

    return (
      <SwipeableRow
        onDelete={() => handleTrash(item)}
        colors={colors}
      >
        {row}
      </SwipeableRow>
    );
  }, [colors, handleOpenDoc, handleTrash, t]);

  const renderFolderItem = useCallback(({ item }) => (
    <TouchableOpacity
      style={[s.docRow, { borderBottomColor: colors.border }]}
      onPress={() => openFolder(item)}
      activeOpacity={0.7}
    >
      <View style={[iconStyles.badge, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#f5f5f5' }]}>
        <IconFolder size={22} color={colors.textSecondary} />
      </View>
      <View style={s.docInfo}>
        <Text style={[s.docTitle, { color: colors.text }]} numberOfLines={1}>{item.name}</Text>
      </View>
    </TouchableOpacity>
  ), [colors, isDark, openFolder]);

  // Recent documents (last 5 edited, sorted by updated_at)
  const recentDocs = useMemo(() => {
    if (searchQuery || currentFolder) return [];
    return [...documents]
      .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0))
      .slice(0, 5);
  }, [documents, searchQuery, currentFolder]);

  const allItems = [
    ...folders.map(f => ({ ...f, _type: 'folder' })),
    ...documents.map(d => ({ ...d, _type: 'doc' })),
  ];

  const renderItem = useCallback(({ item }) => {
    if (item._type === 'folder') return renderFolderItem({ item });
    return renderDocItem({ item });
  }, [renderFolderItem, renderDocItem]);

  const keyExtractor = useCallback((item) => {
    return item._type === 'folder' ? `f-${item.id}` : `d-${item.id}`;
  }, []);

  const EmptyState = () => (
    <View style={s.emptyContainer}>
      <IconFileText size={48} color={colors.textSecondary} />
      <Text style={[s.emptyTitle, { color: colors.text }]}>
        {searchQuery ? t('docs.noResults') : t('docs.emptyTitle')}
      </Text>
      <Text style={[s.emptySubtitle, { color: colors.textSecondary }]}>
        {searchQuery ? t('docs.noResultsDesc') : t('docs.emptyDesc')}
      </Text>
    </View>
  );

  return (
    <View style={[s.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[s.header, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <TouchableOpacity
          onPress={currentFolder ? goBackFolder : () => router.back()}
          style={s.headerBtn}
        >
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        {showSearch ? (
          <View style={[s.searchBox, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#f0f0f0' }]}>
            <IconSearch size={16} color={colors.textSecondary} />
            <TextInput
              ref={searchRef}
              style={[s.searchInput, { color: colors.text }]}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder={t('common.search')}
              placeholderTextColor={colors.textSecondary}
              autoFocus
              returnKeyType="search"
              onSubmitEditing={() => fetchDocs()}
            />
            <TouchableOpacity onPress={() => { setShowSearch(false); setSearchQuery(''); }}>
              <IconX size={18} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <Text style={[s.headerTitle, { color: colors.text }]}>
              {currentFolder
                ? (folderStack[folderStack.length - 1]?.name || t('sidebar.documents'))
                : t('sidebar.documents')
              }
            </Text>
            <View style={{ flex: 1 }} />
            <TouchableOpacity onPress={() => setShowSearch(true)} style={s.headerBtn}>
              <IconSearch size={20} color={colors.textSecondary} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => fetchDocs(true)} style={s.headerBtn}>
              <IconRefresh size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </>
        )}
      </View>

      {/* Document list */}
      {loading && !refreshing ? (
        <View style={s.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <View style={s.emptyContainer}>
          <Text style={[s.emptyTitle, { color: colors.text }]}>{t('common.error')}</Text>
          <Text style={[s.emptySubtitle, { color: colors.textSecondary }]}>{error}</Text>
          <TouchableOpacity
            onPress={() => fetchDocs()}
            style={[s.retryBtn, { backgroundColor: colors.primary }]}
          >
            <Text style={s.retryText}>{t('common.retry') || 'Retry'}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={allItems}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          contentContainerStyle={allItems.length === 0 ? { flex: 1 } : undefined}
          ListHeaderComponent={!searchQuery && !currentFolder ? (
            <>
              {/* Quick Create Buttons */}
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.quickCreateRow} contentContainerStyle={{ paddingHorizontal: 12, gap: 8 }}>
                {[
                  { type: 'document', label: t('docs.newDocument') || 'Document', color: '#4285f4', bgColor: '#e3f2fd' },
                  { type: 'spreadsheet', label: t('docs.newSpreadsheet') || 'Spreadsheet', color: '#34a853', bgColor: '#e8f5e9' },
                  { type: 'presentation', label: t('docs.newPresentation') || 'Presentation', color: '#ff9800', bgColor: '#fff3e0' },
                  { type: 'markdown', label: t('docs.newMarkdown') || 'Note', color: '#9c27b0', bgColor: '#f3e5f5' },
                ].map(item => (
                  <TouchableOpacity
                    key={item.type}
                    style={[s.quickCreateBtn, { backgroundColor: isDark ? item.color + '18' : item.bgColor, borderColor: item.color + '30' }]}
                    onPress={() => handleCreateDoc(item.type)}
                    activeOpacity={0.7}
                  >
                    <IconPlus size={14} color={item.color} />
                    <Text style={[s.quickCreateText, { color: item.color }]}>{item.label}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              {/* Recent Documents Section */}
              {recentDocs.length > 0 && (
                <View style={s.recentSection}>
                  <Text style={[s.recentTitle, { color: colors.textSecondary }]}>
                    {t('docs.recentDocuments') || 'Recent'}
                  </Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, gap: 10 }}>
                    {recentDocs.map(doc => (
                      <TouchableOpacity
                        key={doc.id || doc.doc_id}
                        style={[s.recentCard, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#f9fafb', borderColor: isDark ? 'rgba(255,255,255,0.08)' : '#e5e7eb' }]}
                        onPress={() => handleOpenDoc(doc)}
                        activeOpacity={0.7}
                      >
                        <DocTypeIcon type={doc.type} size={24} />
                        <Text style={[s.recentCardTitle, { color: colors.text }]} numberOfLines={2}>
                          {doc.title || t('docs.untitledDocument')}
                        </Text>
                        <Text style={[s.recentCardDate, { color: colors.textSecondary }]}>
                          {formatDate(doc.updated_at)}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </View>
              )}

              {/* All Documents label */}
              {documents.length > 0 && (
                <Text style={[s.sectionLabel, { color: colors.textSecondary }]}>
                  {t('docs.allDocuments') || 'All Documents'}
                </Text>
              )}
            </>
          ) : null}
          ListEmptyComponent={EmptyState}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => fetchDocs(true)}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
        />
      )}

      {/* FAB - Create new */}
      <TouchableOpacity
        style={[s.fab, {
          backgroundColor: '#4285f4',
          ...(Platform.OS === 'web' ? { boxShadow: '0 4px 14px rgba(66,133,244,0.4)' } : {}),
        }]}
        onPress={() => setShowCreateMenu(true)}
        activeOpacity={0.8}
        accessibilityLabel={t('docs.createNew')}
        accessibilityRole="button"
      >
        <IconPlus size={24} color="#fff" />
      </TouchableOpacity>

      {/* Create menu modal */}
      <Modal visible={showCreateMenu} animationType="fade" transparent onRequestClose={() => setShowCreateMenu(false)}>
        <Pressable style={s.overlay} onPress={() => setShowCreateMenu(false)}>
          <View style={[s.menuCard, {
            backgroundColor: colors.surface,
            ...(Platform.OS === 'web' ? { boxShadow: '0 8px 32px rgba(0,0,0,0.15)' } : {}),
          }]}>
            <Text style={[s.menuTitle, { color: colors.text }]}>{t('docs.createNew')}</Text>
            <TouchableOpacity
              style={[s.menuItem, { borderBottomColor: colors.border }]}
              onPress={() => handleCreateDoc('document')}
              activeOpacity={0.7}
            >
              <View style={[iconStyles.badge, { backgroundColor: '#e3f2fd' }]}>
                <IconFileText size={20} color="#4285f4" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[s.menuItemTitle, { color: colors.text }]}>{t('docs.newDocument')}</Text>
                <Text style={[s.menuItemSub, { color: colors.textSecondary }]}>{t('docs.newDocumentDesc')}</Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.menuItem, { borderBottomColor: colors.border }]}
              onPress={() => handleCreateDoc('spreadsheet')}
              activeOpacity={0.7}
            >
              <View style={[iconStyles.badge, { backgroundColor: '#e8f5e9' }]}>
                <IconBarChart size={20} color="#34a853" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[s.menuItemTitle, { color: colors.text }]}>{t('docs.newSpreadsheet')}</Text>
                <Text style={[s.menuItemSub, { color: colors.textSecondary }]}>{t('docs.newSpreadsheetDesc')}</Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.menuItem, { borderBottomColor: colors.border }]}
              onPress={() => handleCreateDoc('presentation')}
              activeOpacity={0.7}
            >
              <View style={[iconStyles.badge, { backgroundColor: '#fff3e0' }]}>
                <IconFileText size={20} color="#ff9800" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[s.menuItemTitle, { color: colors.text }]}>{t('docs.newPresentation')}</Text>
                <Text style={[s.menuItemSub, { color: colors.textSecondary }]}>{t('docs.newPresentationDesc')}</Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.menuItem, { borderBottomColor: colors.border }]}
              onPress={() => handleCreateDoc('markdown')}
              activeOpacity={0.7}
            >
              <View style={[iconStyles.badge, { backgroundColor: '#f3e5f5' }]}>
                <IconFileText size={20} color="#9c27b0" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[s.menuItemTitle, { color: colors.text }]}>{t('docs.newMarkdown')}</Text>
                <Text style={[s.menuItemSub, { color: colors.textSecondary }]}>{t('docs.newMarkdownDesc')}</Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity
              style={s.menuItem}
              onPress={() => handleCreateDoc('drawing')}
              activeOpacity={0.7}
            >
              <View style={[iconStyles.badge, { backgroundColor: '#fce4ec' }]}>
                <IconEdit size={20} color="#e91e63" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[s.menuItemTitle, { color: colors.text }]}>{t('docs.newDrawing')}</Text>
                <Text style={[s.menuItemSub, { color: colors.textSecondary }]}>{t('docs.newDrawingDesc')}</Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.menuCancel, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#f5f5f5' }]}
              onPress={() => setShowCreateMenu(false)}
              activeOpacity={0.7}
            >
              <Text style={{ color: colors.textSecondary, fontSize: 15, fontWeight: '600' }}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>

      {/* Context menu (long press) */}
      <Modal visible={!!contextDoc} animationType="fade" transparent onRequestClose={() => setContextDoc(null)}>
        <Pressable style={s.overlay} onPress={() => setContextDoc(null)}>
          <View style={[s.menuCard, {
            backgroundColor: colors.surface,
            ...(Platform.OS === 'web' ? { boxShadow: '0 8px 32px rgba(0,0,0,0.15)' } : {}),
          }]}>
            {contextDoc && (
              <>
                <View style={s.contextHeader}>
                  <DocTypeIcon type={contextDoc.type} size={24} />
                  <Text style={[s.contextTitle, { color: colors.text }]} numberOfLines={2}>
                    {contextDoc.title}
                  </Text>
                </View>
                {contextMenuItems.map((item) => (
                  <TouchableOpacity
                    key={item.key}
                    style={[s.contextItem, { borderTopColor: colors.border }]}
                    onPress={() => item.action(contextDoc)}
                    activeOpacity={0.7}
                  >
                    <item.icon size={20} color={item.color} />
                    <Text style={[s.contextLabel, { color: item.color }]}>{item.label}</Text>
                  </TouchableOpacity>
                ))}
              </>
            )}
            <TouchableOpacity
              style={[s.menuCancel, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#f5f5f5' }]}
              onPress={() => setContextDoc(null)}
              activeOpacity={0.7}
            >
              <Text style={{ color: colors.textSecondary, fontSize: 15, fontWeight: '600' }}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>

      {/* Rename modal */}
      <Modal visible={!!renameDoc} animationType="fade" transparent onRequestClose={() => setRenameDoc(null)}>
        <Pressable style={s.overlay} onPress={() => setRenameDoc(null)}>
          <Pressable style={[s.renameCard, {
            backgroundColor: colors.surface,
            ...(Platform.OS === 'web' ? { boxShadow: '0 8px 32px rgba(0,0,0,0.15)' } : {}),
          }]} onPress={(e) => { e.stopPropagation?.(); }} onStartShouldSetResponder={() => true}>
            <Text style={[s.menuTitle, { color: colors.text }]}>{t('docs.rename')}</Text>
            <TextInput
              style={[s.renameInput, {
                color: colors.text,
                borderColor: colors.border,
                backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#f9f9f9',
              }]}
              value={renameText}
              onChangeText={setRenameText}
              autoFocus
              selectTextOnFocus
              returnKeyType="done"
              onSubmitEditing={handleRename}
            />
            <View style={s.renameActions}>
              <TouchableOpacity
                style={[s.renameBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#f5f5f5' }]}
                onPress={() => setRenameDoc(null)}
              >
                <Text style={{ color: colors.textSecondary, fontWeight: '600' }}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.renameBtn, { backgroundColor: '#4285f4' }]}
                onPress={handleRename}
              >
                <Text style={{ color: '#fff', fontWeight: '600' }}>{t('docs.save')}</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 56,
    paddingHorizontal: Spacing.sm,
    borderBottomWidth: 1,
  },
  headerBtn: { padding: Spacing.sm },
  headerTitle: { fontSize: FontSize.lg, fontWeight: '600', marginLeft: 4 },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    paddingHorizontal: 10,
    height: 38,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 0,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  loadingContainer: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
  },
  emptyContainer: {
    flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32,
  },
  emptyTitle: { fontSize: 18, fontWeight: '600', marginTop: 16, marginBottom: 8 },
  emptySubtitle: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  retryBtn: {
    paddingHorizontal: 24, paddingVertical: 10, borderRadius: BorderRadius.md, marginTop: 16,
  },
  retryText: { color: '#fff', fontWeight: '600', fontSize: FontSize.md },
  quickCreateRow: {
    paddingVertical: 12,
  },
  quickCreateBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: 20, borderWidth: 1,
  },
  quickCreateText: { fontSize: 13, fontWeight: '600' },
  recentSection: { paddingTop: 4, paddingBottom: 8 },
  recentTitle: {
    fontSize: 12, fontWeight: '700', textTransform: 'uppercase',
    letterSpacing: 0.5, paddingHorizontal: 16, marginBottom: 8,
  },
  recentCard: {
    width: 130, padding: 12, borderRadius: 12, borderWidth: 1,
    gap: 6,
  },
  recentCardTitle: { fontSize: 13, fontWeight: '600', lineHeight: 17 },
  recentCardDate: { fontSize: 11 },
  sectionLabel: {
    fontSize: 12, fontWeight: '700', textTransform: 'uppercase',
    letterSpacing: 0.5, paddingHorizontal: 16, paddingVertical: 8,
  },
  docRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
    backgroundColor: 'transparent',
  },
  docInfo: { flex: 1 },
  docTitle: { fontSize: 15, fontWeight: '500' },
  docMeta: { flexDirection: 'row', alignItems: 'center', marginTop: 3 },
  docDate: { fontSize: 12 },
  docSize: { fontSize: 12 },
  docShared: { fontSize: 12 },
  moreBtn: { padding: 6 },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 16,
    width: 56,
    height: 56,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 8 },
      android: { elevation: 6 },
      default: {},
    }),
  },
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.4)',
    padding: 16,
  },
  menuCard: {
    borderRadius: 20,
    overflow: 'hidden',
    paddingTop: 20,
    paddingBottom: 8,
  },
  menuTitle: {
    fontSize: 18,
    fontWeight: '700',
    paddingHorizontal: 20,
    marginBottom: 16,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 20,
    gap: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  menuItemTitle: { fontSize: 16, fontWeight: '600' },
  menuItemSub: { fontSize: 13, marginTop: 2 },
  menuCancel: {
    marginTop: 8,
    marginHorizontal: 12,
    marginBottom: 8,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  contextHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 14,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0,0,0,0.06)',
  },
  contextTitle: { flex: 1, fontSize: 16, fontWeight: '600' },
  contextItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 20,
    gap: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  contextLabel: { fontSize: 15, fontWeight: '500' },
  renameCard: {
    borderRadius: 20,
    overflow: 'hidden',
    padding: 20,
  },
  renameInput: {
    fontSize: 16,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 16,
  },
  renameActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
  },
  renameBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
  },
});

export default function DocumentosScreen() { return <ErrorBoundary><DocumentosScreenInner /></ErrorBoundary>; }
