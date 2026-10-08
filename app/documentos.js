import ErrorBoundary from "../components/ErrorBoundary";
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, ActivityIndicator,
  Modal, Pressable, FlatList, TextInput, Alert, RefreshControl, ScrollView,
  BackHandler,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { BorderRadius, FontSize, Spacing, haptic } from '../constants/theme';
// [2026-10-08 apps-native] header nativo, células nativas, skeleton + empty canônicos
import { USE_NATIVE_HEADER, nativeHeaderOptions, HeaderBackButton, nativeScrollInsetProps, NativeInsetView, IOS_NATIVE_INSET } from '../components/nativeHeader'; // inset [2026-10-08 header-inset-all]
import PressableRow from '../components/PressableRow';
import PressableScale from '../components/PressableScale';
import ScreenEmptyState from '../components/ScreenEmptyState';
import { ListSkeleton } from '../components/SkeletonLoader';
import {
  IconArrowLeft, IconPlus, IconFileText, IconGrid, IconMonitor, IconStickyNote, IconPenTool, IconTrash,
  IconEdit, IconCopy, IconShare, IconSearch, IconMoreVert, IconFolder,
  IconX, IconRefresh, IconSparkles,
} from '../components/Icons';
import { docsList, docsCreate, docsRename, docsTrash, docsDuplicate, docsGet, getToken } from '../services/api';
import { getCached, setCache } from '../services/cache';
import SwipeableRow from '../components/SwipeableRow';
import BrandFab from '../components/BrandFab';

// Docs subpath is served by the same origin as the API (chatyy.com.br primary).
// mail.onemundo.com.br was the legacy hostname — new hostname is chatyy.com.br
// on every platform.
const DOCS_BASE = 'https://chatyy.com.br/docs/';

function formatDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    // Guard NaN — without this, an unparseable ISO would render the literal
    // "Invalid Date" string in the user's docs list.
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return ''; }
}

function formatSize(bytes) {
  if (!bytes || bytes === 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// [2026-10-08 header-inset-all] Ícones de tipo MONOCROMÁTICOS (padrão do app
// preto&branco): tile neutro + ícone na cor do texto; o tipo se distingue
// pelo glifo (texto / grade / monitor / nota / caneta), não por cor.
const DOC_TYPE_GLYPH = {
  document: IconFileText,
  spreadsheet: IconGrid,
  presentation: IconMonitor,
  markdown: IconStickyNote,
  drawing: IconPenTool,
};
function useNeutralTile() {
  const { colors, isDark } = useTheme();
  return {
    bg: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.045)',
    fg: colors.text,
  };
}
function TypeTile({ Icon, tile = 44, iconSize }) {
  const n = useNeutralTile();
  return (
    <View style={[iconStyles.badge, { width: tile, height: tile, borderRadius: Math.round(tile * 0.27), backgroundColor: n.bg }]}>
      <Icon size={iconSize || Math.round(tile * 0.45)} color={n.fg} />
    </View>
  );
}
function DocTypeIcon({ type, tile = 44 }) {
  return <TypeTile Icon={DOC_TYPE_GLYPH[type] || IconFileText} tile={tile} />;
}

// Meta "data · tamanho" montado SÓ com as partes presentes (antes: " · 1.6 KB"
// com ponto solto quando o doc vinha sem updated_at).
function docMetaText(item) {
  return [formatDate(item?.updated_at), item?.file_size > 0 ? formatSize(item.file_size) : '']
    .filter(Boolean)
    .join(' \u00B7 ');
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
  // [2026-10-08 apps-native] searchInput = o que o usuário digita; searchQuery
  // = valor com debounce (300ms) que dispara a busca. Antes cada tecla fazia
  // um docs_list no servidor (e piscava o spinner de tela cheia).
  const [searchInput, setSearchInput] = useState('');
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
    } else if (!isRefresh && !documents.length) {
      // [2026-10-08 apps-native] busca não apaga mais a lista atual com
      // loading de tela cheia — os resultados substituem quando chegam.
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

  useEffect(() => {
    const v = searchInput.trim();
    if (v === searchQuery) return undefined;
    const id = setTimeout(() => setSearchQuery(v), v ? 300 : 0);
    return () => clearTimeout(id);
  }, [searchInput, searchQuery]);

  // tr(): t() devolve a própria chave quando falta tradução → fallback legível.
  const tr = useCallback((k, fb) => { const v = t(k); return v && v !== k ? v : fb; }, [t]);

  // Actions
  const handleOpenDoc = useCallback((doc) => {
    const docId = doc.doc_id || doc.id;
    let page = 'editor.html';
    if (doc.type === 'spreadsheet') page = 'spreadsheet.html';
    else if (doc.type === 'presentation') page = 'presentation.html';
    else if (doc.type === 'markdown') page = 'markdown.html';
    else if (doc.type === 'drawing') page = 'drawing.html';
    const tk = getToken();
    const url = `${DOCS_BASE}${page}?id=${encodeURIComponent(docId)}${tk ? `&token=${encodeURIComponent(tk)}` : ''}`;
    if (Platform.OS === 'web') {
      window.open(url, '_blank');
    } else {
      router.push({ pathname: '/documentos-viewer', params: { url } });
    }
  }, [router]);

  const handleCreateDoc = useCallback(async (type) => {
    setShowCreateMenu(false);
    haptic.light();
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
          const tk = getToken();
          const url = `${DOCS_BASE}${pageMap[type] || 'editor.html'}?id=${encodeURIComponent(docId)}${tk ? `&token=${encodeURIComponent(tk)}` : ''}`;
          if (Platform.OS === 'web') {
            window.open(url, '_blank');
          } else {
            router.push({ pathname: '/documentos-viewer', params: { url } });
          }
        }
        fetchDocs();
      } else {
        // [2026-06-04] cacada R2: criar falhava em silencio.
        const m = res?.message || (t('common.error') || 'Erro');
        if (Platform.OS === 'web') window.alert(m); else Alert.alert(t('common.error') || 'Erro', m);
      }
    } catch (e) {
      const m = String(e?.message || e);
      if (Platform.OS === 'web') window.alert(m); else Alert.alert(t('common.error') || 'Erro', m);
    }
  }, [currentFolder, fetchDocs, t]);

  const handleTrash = useCallback(async (doc) => {
    setContextDoc(null);
    const doIt = async () => {
      try {
        await docsTrash(doc.doc_id);
        haptic.success();
        fetchDocs();
      } catch (e) {
        // [2026-06-04] cacada R2: lixeira falhava em silencio.
        const m = String(e?.message || e);
        if (Platform.OS === 'web') window.alert(m); else Alert.alert(t('common.error') || 'Erro', m);
      }
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
    // [2026-06-04] cacada R2: modal fechava como se tivesse salvo mesmo em
    // falha (offline/500) — agora so fecha no sucesso; em erro mantem aberto
    // e avisa.
    try {
      const r = await docsRename(renameDoc.doc_id, renameText.trim());
      if (r && r.success === false) {
        const m = r.message || (t('common.error') || 'Erro');
        if (Platform.OS === 'web') window.alert(m); else Alert.alert(t('common.error') || 'Erro', m);
        return;
      }
      fetchDocs();
      setRenameDoc(null);
      setRenameText('');
    } catch (e) {
      const m = String(e?.message || e);
      if (Platform.OS === 'web') window.alert(m); else Alert.alert(t('common.error') || 'Erro', m);
    }
  }, [renameDoc, renameText, fetchDocs, t]);

  const handleDuplicate = useCallback(async (doc) => {
    setContextDoc(null);
    try {
      await docsDuplicate(doc.doc_id);
      fetchDocs();
    } catch (e) {
      // [2026-06-04] cacada R2: duplicar falhava em silencio.
      const m = String(e?.message || e);
      if (Platform.OS === 'web') window.alert(m); else Alert.alert(t('common.error') || 'Erro', m);
    }
  }, [fetchDocs, t]);

  const handleShare = useCallback((doc) => {
    setContextDoc(null);
    const docId = doc.doc_id || doc.id;
    const pageMap = { spreadsheet: 'spreadsheet.html', presentation: 'presentation.html', markdown: 'markdown.html', drawing: 'drawing.html' };
    const page = pageMap[doc.type] || 'editor.html';
    const tk = getToken();
    const url = `${DOCS_BASE}${page}?id=${encodeURIComponent(docId)}&share=1${tk ? `&token=${encodeURIComponent(tk)}` : ''}`;
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

  // Open document in One AI for analysis.
  // Docs live in a separate SQLite DB (docs.db, accessed via docs_get) — NOT in drive_files.
  // So we can't use read_drive_file here. Fetch the doc content client-side and inline it
  // in the prompt so the AI receives it directly as part of the user message.
  const handleAnalyzeWithOne = useCallback(async (doc) => {
    setContextDoc(null);
    try {
      const docKey = doc.doc_id || doc.id;
      const title = doc.title || 'documento';
      // Fetch full doc content
      const r = await docsGet(docKey);
      let content = '';
      if (r?.success && r.data) {
        const raw = r.data.content || '';
        // Strip HTML tags from the editor content for clean text
        content = String(raw).replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
          .replace(/<br\s*\/?>(?!\n)/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        // Cap at ~16k chars to keep the prompt reasonable
        if (content.length > 16000) content = content.slice(0, 16000) + '\n\n[...conteúdo truncado]';
      }
      const intent = JSON.stringify({
        type: 'analyze_doc',
        doc_id: docKey,
        title,
        content,
      });
      const prefill = content
        ? `Analise esse documento: ${title}`
        : `Analise esse documento: ${title} (conteúdo indisponível)`;
      router.push({ pathname: '/one', params: { intent, prefill } });
    } catch (err) {
      console.warn('analyze with one failed:', err);
    }
  }, [router]);

  // Context menu items
  const contextMenuItems = [
    { key: 'analyze', label: tr('docs.analyzeWithBia', 'Analisar com a Bia'), icon: IconSparkles, color: colors.text, action: handleAnalyzeWithOne },
    { key: 'edit', label: t('common.edit'), icon: IconEdit, color: colors.text, action: openEdit },
    { key: 'rename', label: t('docs.rename'), icon: IconFileText, color: colors.text, action: openRename },
    { key: 'duplicate', label: t('docs.duplicate'), icon: IconCopy, color: colors.text, action: handleDuplicate },
    { key: 'share', label: t('docs.share'), icon: IconShare, color: colors.text, action: handleShare },
    { key: 'delete', label: t('common.delete'), icon: IconTrash, color: '#ea4335', action: handleTrash },
  ];

  // Render a single document row
  const renderDocItem = useCallback(({ item }) => {
    const row = (
      <PressableRow
        style={[s.docRow, { borderBottomColor: colors.border, backgroundColor: colors.background }]}
        onPress={() => handleOpenDoc(item)}
        onLongPress={() => { haptic.medium(); setContextDoc(item); }}
        delayLongPress={400}
        accessibilityLabel={item.title}
        accessibilityRole="button"
        {...(Platform.OS === 'web' ? { onContextMenu: (e) => { e?.preventDefault?.(); setContextDoc(item); } } : {})}
      >
        <DocTypeIcon type={item.type} />
        <View style={s.docInfo}>
          <Text style={[s.docTitle, { color: colors.text }]} numberOfLines={1}>
            {item.title || (t('docs.untitledDocument'))}
          </Text>
          {(() => {
            const meta = docMetaText(item);
            const shared = item.my_permission && item.my_permission !== 'owner';
            if (!meta && !shared) return null;
            return (
              <Text style={[s.docMetaLine, { color: colors.textSecondary }]} numberOfLines={1}>
                {meta}
                {shared ? (
                  <Text style={{ color: colors.text, fontWeight: '600' }}>
                    {meta ? ' \u00B7 ' : ''}{t('docs.shared')}
                  </Text>
                ) : null}
              </Text>
            );
          })()}
        </View>
        <TouchableOpacity
          style={s.moreBtn}
          onPress={() => setContextDoc(item)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <IconMoreVert size={20} color={colors.textSecondary} />
        </TouchableOpacity>
      </PressableRow>
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
    <PressableRow
      style={[s.docRow, { borderBottomColor: colors.border, backgroundColor: colors.background }]}
      onPress={() => openFolder(item)}
      accessibilityRole="button"
      accessibilityLabel={item.name}
    >
      <TypeTile Icon={IconFolder} />
      <View style={s.docInfo}>
        <Text style={[s.docTitle, { color: colors.text }]} numberOfLines={1}>{item.name}</Text>
      </View>
    </PressableRow>
  ), [colors, isDark, openFolder]);

  // Recent documents (last 5 edited, sorted by updated_at)
  const recentDocs = useMemo(() => {
    if (searchQuery || currentFolder) return [];
    return [...documents]
      .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0))
      .slice(0, 5);
  }, [documents, searchQuery, currentFolder]);

  const allItems = useMemo(() => [
    ...folders.map(f => ({ ...f, _type: 'folder' })),
    ...documents.map(d => ({ ...d, _type: 'doc' })),
  ], [folders, documents]);

  const renderItem = useCallback(({ item }) => {
    if (item._type === 'folder') return renderFolderItem({ item });
    return renderDocItem({ item });
  }, [renderFolderItem, renderDocItem]);

  const keyExtractor = useCallback((item) => {
    // doc_id é a chave real dos docs (alguns payloads não trazem `id` →
    // várias linhas "d-undefined" = keys duplicadas / reciclagem errada).
    return item._type === 'folder' ? `f-${item.id}` : `d-${item.doc_id || item.id}`;
  }, []);

  const EmptyState = () => (
    <ScreenEmptyState
      kind={searchQuery ? 'search' : 'files'}
      title={searchQuery ? t('docs.noResults') : t('docs.emptyTitle')}
      subtitle={searchQuery ? t('docs.noResultsDesc') : t('docs.emptyDesc')}
      cta={searchQuery ? undefined : { label: t('docs.createNew'), onPress: () => setShowCreateMenu(true) }}
    />
  );

  // Back contextual: dentro de pasta → sobe; senão fecha a tela.
  const handleContextBack = useCallback(() => {
    if (currentFolder) { goBackFolder(); return true; }
    return false;
  }, [currentFolder, goBackFolder]);
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', handleContextBack);
    return () => { try { sub?.remove?.(); } catch {} };
  }, [handleContextBack]);
  const headerTitleText = currentFolder
    ? (folderStack[folderStack.length - 1]?.name || t('sidebar.documents'))
    : t('sidebar.documents');

  return (
    <View style={[s.container, { backgroundColor: colors.background, paddingTop: USE_NATIVE_HEADER ? 0 : insets.top }]}>
      {/* [2026-10-08 apps-native] Nativo: header do sistema + busca NATIVA
          (UISearchController / SearchView). Pull-to-refresh substitui o botão
          de recarregar. Dentro de pasta o back sobe um nível. Web: header antigo. */}
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={(() => {
          const o = nativeHeaderOptions({
            colors,
            title: headerTitleText,
            headerLeft: currentFolder
              ? () => <HeaderBackButton onPress={goBackFolder} color={colors.text} accessibilityLabel={t('common.back')} />
              : undefined,
            search: {
              placeholder: t('common.search'),
              onChangeText: (e) => setSearchInput(e?.nativeEvent?.text ?? ''),
              onSearchButtonPress: (e) => setSearchQuery(String(e?.nativeEvent?.text ?? searchInput).trim()),
              onCancelButtonPress: () => { setSearchInput(''); setSearchQuery(''); },
              onClose: () => { setSearchInput(''); setSearchQuery(''); },
            },
          });
          if (!currentFolder) { o.headerLeft = undefined; o.headerBackVisible = true; }
          o.gestureEnabled = !currentFolder;
          return o;
        })()} />
      ) : (
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
              value={searchInput}
              onChangeText={setSearchInput}
              placeholder={t('common.search')}
              placeholderTextColor={colors.textSecondary}
              autoFocus
              returnKeyType="search"
              onSubmitEditing={() => setSearchQuery(searchInput.trim())}
            />
            <TouchableOpacity onPress={() => { setShowSearch(false); setSearchInput(''); setSearchQuery(''); }}>
              <IconX size={18} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <Text style={[s.headerTitle, { color: colors.text }]}>
              {headerTitleText}
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
      )}

      {/* Document list */}
      {loading && !refreshing ? (
        <NativeInsetView><ListSkeleton count={8} /></NativeInsetView>
      ) : error ? (
        <NativeInsetView>
          <ScreenEmptyState
            kind="files"
            title={t('common.error')}
            subtitle={error}
            cta={{ label: tr('common.retry', 'Tentar novamente'), onPress: () => { haptic.light(); fetchDocs(); } }}
          />
        </NativeInsetView>
      ) : (
        <FlatList
          // [2026-10-08 header-inset-all] iOS: header translúcido (busca nativa)
          // → UIKit ajusta o inset (status+nav+busca); sem paddingTop manual.
          {...nativeScrollInsetProps()}
          key={currentFolder ? `f-${currentFolder}` : 'root'}
          data={allItems}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          contentContainerStyle={allItems.length === 0 ? { flexGrow: 1 } : { paddingBottom: 96 + (IOS_NATIVE_INSET ? 0 : insets.bottom) }}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          initialNumToRender={14}
          maxToRenderPerBatch={12}
          windowSize={9}
          removeClippedSubviews={Platform.OS === 'android'}
          ListHeaderComponent={!searchQuery && !currentFolder ? (
            <>
              {/* Quick Create — card-style buttons */}
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.quickCreateRow} contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}>
                {[
                  { type: 'document', label: t('docs.newDocument') || 'Documento' },
                  { type: 'spreadsheet', label: t('docs.newSpreadsheet') || 'Planilha' },
                  { type: 'presentation', label: t('docs.newPresentation') || 'Apresentação' },
                  { type: 'markdown', label: t('docs.newMarkdown') || 'Nota' },
                ].map(item => (
                  <PressableScale
                    key={item.type}
                    style={[s.quickCreateBtn, {
                      backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : '#fff',
                      borderColor: isDark ? 'rgba(255,255,255,0.08)' : '#e5e7eb',
                    }]}
                    onPress={() => handleCreateDoc(item.type)}
                    accessibilityRole="button"
                    accessibilityLabel={item.label}
                  >
                    <DocTypeIcon type={item.type} tile={36} />
                    <Text style={[s.quickCreateText, { color: colors.text }]} numberOfLines={1}>{item.label}</Text>
                  </PressableScale>
                ))}
              </ScrollView>

              {/* Recent Documents Section */}
              {recentDocs.length > 0 && (
                <View style={s.recentSection}>
                  <Text style={[s.recentTitle, { color: colors.textSecondary }]}>
                    {t('docs.recentDocuments') || 'Recent'}
                  </Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}>
                    {recentDocs.map(doc => (
                      <PressableScale
                        key={doc.doc_id || doc.id}
                        style={[s.recentCard, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#f9fafb', borderColor: isDark ? 'rgba(255,255,255,0.08)' : '#e5e7eb' }]}
                        onPress={() => handleOpenDoc(doc)}
                        onLongPress={() => { haptic.medium(); setContextDoc(doc); }}
                        accessibilityRole="button"
                        accessibilityLabel={doc.title || t('docs.untitledDocument')}
                      >
                        <DocTypeIcon type={doc.type} tile={36} />
                        {/* [2026-10-08 header-inset-all] card de largura/altura FIXAS:
                            título em até 2 linhas com reticências + meta sempre na
                            base (cards alinhados mesmo sem data). */}
                        <Text style={[s.recentCardTitle, { color: colors.text }]} numberOfLines={2} ellipsizeMode="tail">
                          {doc.title || t('docs.untitledDocument')}
                        </Text>
                        <Text style={[s.recentCardDate, { color: colors.textSecondary }]} numberOfLines={1}>
                          {formatDate(doc.updated_at) || formatSize(doc.file_size) || ' '}
                        </Text>
                      </PressableScale>
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

      {/* FAB - Create new (Telegram-grade glass orb, blue tint) */}
      <BrandFab
        style={{ position: 'absolute', bottom: insets.bottom + 16, right: 16 }}
        size={56}
        color={isDark ? '#ffffff' : '#111111'}
        onPress={() => setShowCreateMenu(true)}
        accessibilityLabel={t('docs.createNew')}
      >
        <IconPlus size={24} color={isDark ? '#111111' : '#ffffff'} />
      </BrandFab>

      {/* Create menu modal */}
      <Modal visible={showCreateMenu} animationType="fade" transparent onRequestClose={() => setShowCreateMenu(false)}>
        <Pressable style={s.overlay} onPress={() => setShowCreateMenu(false)}>
          <View style={[s.menuCard, {
            backgroundColor: colors.surface,
            ...(Platform.OS === 'web' ? { boxShadow: '0 8px 32px rgba(0,0,0,0.15)' } : {}),
          }]}>
            <Text style={[s.menuTitle, { color: colors.text }]}>{t('docs.createNew')}</Text>
            <PressableRow
              style={[s.menuItem, { borderBottomColor: colors.border }]}
              onPress={() => handleCreateDoc('document')}
            >
              <DocTypeIcon type="document" />
              <View style={{ flex: 1 }}>
                <Text style={[s.menuItemTitle, { color: colors.text }]}>{t('docs.newDocument')}</Text>
                <Text style={[s.menuItemSub, { color: colors.textSecondary }]}>{t('docs.newDocumentDesc')}</Text>
              </View>
            </PressableRow>
            <PressableRow
              style={[s.menuItem, { borderBottomColor: colors.border }]}
              onPress={() => handleCreateDoc('spreadsheet')}
            >
              <DocTypeIcon type="spreadsheet" />
              <View style={{ flex: 1 }}>
                <Text style={[s.menuItemTitle, { color: colors.text }]}>{t('docs.newSpreadsheet')}</Text>
                <Text style={[s.menuItemSub, { color: colors.textSecondary }]}>{t('docs.newSpreadsheetDesc')}</Text>
              </View>
            </PressableRow>
            <PressableRow
              style={[s.menuItem, { borderBottomColor: colors.border }]}
              onPress={() => handleCreateDoc('presentation')}
            >
              <DocTypeIcon type="presentation" />
              <View style={{ flex: 1 }}>
                <Text style={[s.menuItemTitle, { color: colors.text }]}>{t('docs.newPresentation')}</Text>
                <Text style={[s.menuItemSub, { color: colors.textSecondary }]}>{t('docs.newPresentationDesc')}</Text>
              </View>
            </PressableRow>
            <PressableRow
              style={[s.menuItem, { borderBottomColor: colors.border }]}
              onPress={() => handleCreateDoc('markdown')}
            >
              <DocTypeIcon type="markdown" />
              <View style={{ flex: 1 }}>
                <Text style={[s.menuItemTitle, { color: colors.text }]}>{t('docs.newMarkdown')}</Text>
                <Text style={[s.menuItemSub, { color: colors.textSecondary }]}>{t('docs.newMarkdownDesc')}</Text>
              </View>
            </PressableRow>
            <PressableRow
              style={s.menuItem}
              onPress={() => handleCreateDoc('drawing')}
            >
              <DocTypeIcon type="drawing" />
              <View style={{ flex: 1 }}>
                <Text style={[s.menuItemTitle, { color: colors.text }]}>{t('docs.newDrawing')}</Text>
                <Text style={[s.menuItemSub, { color: colors.textSecondary }]}>{t('docs.newDrawingDesc')}</Text>
              </View>
            </PressableRow>
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
                  <PressableRow
                    key={item.key}
                    style={[s.contextItem, { borderTopColor: colors.border }]}
                    onPress={() => item.action(contextDoc)}
                    accessibilityRole="button"
                  >
                    <item.icon size={20} color={item.color} />
                    <Text style={[s.contextLabel, { color: item.color }]}>{item.label}</Text>
                  </PressableRow>
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
                style={[s.renameBtn, { backgroundColor: colors.text }]}
                onPress={handleRename}
              >
                <Text style={{ color: colors.background, fontWeight: '600' }}>{t('docs.save')}</Text>
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
  // Why: bumped weight + tighter letter-spacing on the title and a slightly
  // larger / airier subtitle line-height makes the empty state feel less
  // utilitarian and more like a friendly "let's create something" moment.
  emptyTitle: { fontSize: 20, fontWeight: '700', marginTop: 18, marginBottom: 8, letterSpacing: -0.3 },
  emptySubtitle: { fontSize: 14.5, textAlign: 'center', lineHeight: 22, fontWeight: '500', maxWidth: 320 },
  retryBtn: {
    paddingHorizontal: 24, paddingVertical: 10, borderRadius: BorderRadius.md, marginTop: 16,
  },
  retryText: { color: '#fff', fontWeight: '600', fontSize: FontSize.md },
  quickCreateRow: {
    paddingVertical: 14,
  },
  quickCreateBtn: {
    flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'space-between',
    width: 132, height: 96,
    paddingHorizontal: 14, paddingVertical: 12,
    borderRadius: 18, borderWidth: StyleSheet.hairlineWidth,
    ...(Platform.OS === 'web' ? { boxShadow: '0 1px 4px rgba(0,0,0,0.04)', cursor: 'pointer', transition: 'transform 0.15s ease, box-shadow 0.15s ease' } : {}),
  },
  quickCreateIconWrap: {
    width: 36, height: 36, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  quickCreateText: { fontSize: 13, fontWeight: '700', letterSpacing: 0.1 },
  recentSection: { paddingTop: 4, paddingBottom: 12 },
  recentTitle: {
    fontSize: 11, fontWeight: '800', textTransform: 'uppercase',
    letterSpacing: 1, paddingHorizontal: 16, marginBottom: 10,
  },
  recentCard: {
    // [2026-10-08 header-inset-all] largura E altura fixas (título 2 linhas
    // c/ reticências; meta ancorada embaixo) → fileira alinhada.
    width: 148, height: 132, padding: 12, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth,
    gap: 8, overflow: 'hidden',
    ...(Platform.OS === 'web' ? { boxShadow: '0 1px 6px rgba(0,0,0,0.05)', cursor: 'pointer', transition: 'transform 0.15s ease' } : {}),
  },
  recentCardTitle: { fontSize: 14, fontWeight: '600', lineHeight: 18, flexShrink: 1 },
  recentCardDate: { fontSize: 11.5, fontWeight: '500', marginTop: 'auto' },
  sectionLabel: {
    fontSize: 12, fontWeight: '700', textTransform: 'uppercase',
    letterSpacing: 0.5, paddingHorizontal: 16, paddingVertical: 8,
  },
  docRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
    backgroundColor: 'transparent',
    // Why: doc rows on web feel inert without a hover affordance — the
    // transition lets touch/click states tween smoothly, and cursor:pointer
    // makes the entire row read as a tappable target (not just the title).
    ...(Platform.OS === 'web' ? { transition: 'background-color 160ms ease', cursor: 'pointer' } : {}),
  },
  docInfo: { flex: 1 },
  docTitle: { fontSize: 15, fontWeight: '600', letterSpacing: -0.15 },
  docMeta: { flexDirection: 'row', alignItems: 'center', marginTop: 3 },
  docMetaLine: { fontSize: 12.5, marginTop: 3 },
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
