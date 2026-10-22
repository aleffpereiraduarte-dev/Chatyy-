import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import FastImage from './FastImage'; // [2026-10-09 expo-image]
import { GridSkeleton, ListSkeleton } from './SkeletonLoader';
import {
  View, Text, TouchableOpacity, FlatList, Modal, Image, ActivityIndicator,
  Platform, StyleSheet, Alert,
} from 'react-native';
import { IconX, IconDownload, IconFileText, IconImage, IconFilm, IconMusic, IconPlay, IconPause, IconLink, IconMessageSquare } from './Icons';
import * as api from '../services/api';
import { BASE_URL } from '../services/api';
import ChatMediaViewer from './ChatMediaViewer';
// [2026-10-16 native-media-grid] Fotos/Vídeos em grade NATIVA (seções por mês,
// 1º quadro + duração do vídeo, seleção) — kill __chatyy_native_media_grid.
import NativeMediaGrid, { isNativeMediaGridAvailable, nativeMediaGridApi } from './media/NativeMediaGrid';
import { useLanguage } from '../context/LanguageContext';

// [busca-conversa 2026-10-16] + 'link' (servidor chat_shared_items, paginado).
// [2026-10-18 tg-viewer] Abas do Telegram: Mídia (fotos + vídeos juntos, seções
// por mês) / Links / Docs / Áudio. 'image'/'video' de quem chama → 'media'.
const TABS = ['media', 'link', 'file', 'audio'];
const PAGE = 60;
const _normTab = (x) => (x === 'image' || x === 'video' ? 'media' : (TABS.includes(x) ? x : 'media'));
const _isVid = (it) => !!it && (it.type === 'video' || it.type === 'video_note');
const _isVisual = (it) => !!it && !!(it.file_url || it._e5) && (it.type === 'image' || _isVid(it) || it.type === 'photo'); // [2026-10-22 galeria-e2ee] _e5 = mídia cifrada (arquivo local)
// [2026-10-22 galeria-e2ee] conversa cifrada: itens montados do aparelho (services/e2ee/e2ee5Gallery)
function _e5G() { try { return require('../services/e2ee/e2ee5Gallery'); } catch { return null; } }

// Chatyy brand purple. The whole screen reads as ONE coherent purple set —
// the active-pill, empty-state circle, list icons and accents are all the
// brand color. Per-type is still distinguishable via the icon (Image/Film/
// Music/FileText), not via clashing hues.
const BRAND = '#111111';
const BRAND_SOFT = 'rgba(17, 17, 17,0.12)';
const TAB_THEME = {
  media: { color: BRAND, soft: BRAND_SOFT, Icon: IconImage },
  image: { color: BRAND, soft: BRAND_SOFT, Icon: IconImage },
  video: { color: BRAND, soft: BRAND_SOFT, Icon: IconFilm },
  audio: { color: BRAND, soft: BRAND_SOFT, Icon: IconMusic },
  file:  { color: BRAND, soft: BRAND_SOFT, Icon: IconFileText },
  link:  { color: BRAND, soft: BRAND_SOFT, Icon: IconLink },
};
const _itemKey = (it) => (it && it.url ? `${it.id}|${it.url}` : String(it && it.id));

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function resolveUrl(url) {
  if (!url) return url;
  if (/^(file|content|blob|data):/i.test(url)) return url; // [2026-10-22 galeria-e2ee] arquivo local (decifrado)
  const absolute = url.startsWith('http') ? url : api.getMediaUrl(url);
  // Prefer local cached file (disk) for instant render — falls back to remote
  if (Platform.OS !== 'web') {
    try {
      const { getLocalUriSyncJs } = require('../services/mediaCache');
      const local = getLocalUriSyncJs(absolute);
      if (local) return local;
    } catch {}
  }
  return absolute;
}

function formatDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

// [2026-10-16 native-media-grid] cor do tema → "#RRGGBB" p/ o nativo.
function _hex(c, fallback) {
  if (typeof c !== 'string') return fallback;
  const v = c.trim();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return v;
  const m = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) return '#' + [m[1], m[2], m[3]].map((x) => Math.max(0, Math.min(255, Number(x))).toString(16).padStart(2, '0')).join('');
  return fallback;
}

function _ts(d) {
  if (!d) return 0;
  try {
    const dt = api.parseServerDate ? api.parseServerDate(d) : new Date(d);
    const n = dt && dt.getTime ? dt.getTime() : NaN;
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}

function _nativeItems(items, type) {
  return (items || []).filter(it => it && (it.file_url || it._e5)).map((it) => {
    if (it._e5) { // [2026-10-22 galeria-e2ee] miniatura/pôster decifrados locais; vídeo sem pôster ainda → arquivo local
      const vid = _isVid(it);
      const th = it._e5Thumb || (!vid ? it.file_url : '') || '';
      return vid
        ? { k: String(it.id), u: th, vu: th ? '' : (it.file_url || ''), v: true, ad: !th && !!it.file_url, tr: 'video', t: _ts(it.created_at), a: it.file_name || '' }
        : { k: String(it.id), u: th, t: _ts(it.created_at), a: it.file_name || '' };
    }
    const url = resolveUrl(it.file_url);
    const isVideo = type === 'video' || _isVid(it); // [2026-10-18 tg-viewer] aba Mídia mista
    return isVideo
      ? { k: String(it.id), u: '', vu: url, v: true, ad: true, tr: 'video', t: _ts(it.created_at), a: it.file_name || '' }
      : { k: String(it.id), u: url, t: _ts(it.created_at), a: it.file_name || '' };
  });
}

function EmptyState({ type, colors, t }) {
  const { Icon } = TAB_THEME[type] || TAB_THEME.file;
  // [2026-10-18 tg-viewer] P&B que segue o tema (antes #111 fixo: sumia no escuro).
  const color = colors.text;
  const soft = colors.surface;
  const _tr = (k, fb) => { try { const v = t && t(k); return v && v !== k ? v : fb; } catch { return fb; } };
  const emptyLabel = type === 'link' ? _tr('chat.noLinksYet', 'Nenhum link ainda')
    : type === 'media' ? _tr('chat.noMediaYet', 'Nenhuma mídia ainda')
    : type === 'image' ? _tr('chat.noPhotosYet', 'Nenhuma foto ainda')
    : type === 'video' ? _tr('chat.noVideosYet', 'Nenhum vídeo ainda')
    : type === 'audio' ? _tr('chat.noAudioYet', 'Nenhum áudio ainda')
    : _tr('chat.noDocsYet', 'Nenhum documento ainda');
  const emptyHint = type === 'link' ? _tr('chat.noLinksHint', 'Os links compartilhados nesta conversa aparecem aqui.')
    : type === 'media' ? _tr('chat.noMediaHint', 'As fotos e os vídeos desta conversa aparecem aqui.')
    : type === 'image' ? _tr('chat.noPhotosHint', 'As fotos enviadas nesta conversa aparecem aqui.')
    : type === 'video' ? _tr('chat.noVideosHint', 'Os vídeos enviados nesta conversa aparecem aqui.')
    : type === 'audio' ? _tr('chat.noAudioHint', 'As mensagens de voz e áudios aparecem aqui.')
    : _tr('chat.noDocsHint', 'Os PDFs e documentos compartilhados aparecem aqui.');
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 }}>
      <View style={{
        width: 92, height: 92, borderRadius: 46, backgroundColor: soft,
        alignItems: 'center', justifyContent: 'center', marginBottom: 18,
        borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
      }}>
        <Icon size={38} color={color} />
      </View>
      <Text style={{ color: colors.text, fontSize: 18, fontWeight: '700', marginBottom: 6, letterSpacing: -0.3 }}>
        {emptyLabel}
      </Text>
      <Text style={{ color: colors.textTertiary, fontSize: 13.5, textAlign: 'center', lineHeight: 20, maxWidth: 260 }}>
        {emptyHint}
      </Text>
    </View>
  );
}

// [busca-conversa 2026-10-16] Linha de link: prévia (imagem OG ou favicon) do cache
// do servidor; sem cache → ícone + domínio. Toque abre; botão à direita = mensagem.
function LinkRow({ item, colors, t, onOpen, onJump }) {
  const [imgOk, setImgOk] = useState(true);
  const [favOk, setFavOk] = useState(true);
  const thumb = imgOk && item.image ? item.image : null;
  const fav = favOk && item.favicon ? item.favicon : null;
  const title = (item.title || item.site_name || item.host || item.url || '').trim();
  return (
    <TouchableOpacity
      onPress={() => onOpen(item)}
      activeOpacity={0.7}
      accessibilityRole="link"
      accessibilityLabel={title + (item.host ? `, ${item.host}` : '')}
      style={{
        flexDirection: 'row', alignItems: 'center', paddingVertical: 11, paddingHorizontal: 12,
        borderRadius: 16, backgroundColor: colors.surface,
        borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
      }}
    >
      <View style={{ width: 52, height: 52, borderRadius: 12, overflow: 'hidden', backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
        {thumb ? (
          <FastImage source={{ uri: thumb }} style={{ width: '100%', height: '100%' }} resizeMode="cover" onError={() => setImgOk(false)} />
        ) : fav ? (
          <FastImage source={{ uri: fav }} style={{ width: 24, height: 24 }} resizeMode="contain" onError={() => setFavOk(false)} />
        ) : (
          <IconLink size={20} color={colors.text} />
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600', letterSpacing: -0.2 }} numberOfLines={2}>{title}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 6 }}>
          {fav && thumb ? <FastImage source={{ uri: fav }} style={{ width: 14, height: 14 }} resizeMode="contain" onError={() => setFavOk(false)} /> : null}
          <Text style={{ flex: 1, color: colors.textTertiary, fontSize: 12.5 }} numberOfLines={1}>
            {[item.host, formatDate(item.created_at)].filter(Boolean).join('  ·  ')}
          </Text>
        </View>
      </View>
      {onJump ? (
        <TouchableOpacity
          onPress={() => onJump(item)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={(t && t('chat.showInChat') !== 'chat.showInChat' && t('chat.showInChat')) || 'Mostrar na conversa'}
          style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, marginLeft: 8 }}
        >
          <IconMessageSquare size={16} color={colors.textTertiary} />
        </TouchableOpacity>
      ) : null}
    </TouchableOpacity>
  );
}

function ListFooter({ busy, colors }) {
  return busy ? <View style={{ paddingVertical: 18 }}><ActivityIndicator size="small" color={colors.textTertiary} /></View> : null;
}

function _monthTitle(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const same = d.getFullYear() === new Date().getFullYear();
    const s = d.toLocaleDateString(undefined, same ? { month: 'long' } : { month: 'long', year: 'numeric' });
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  } catch { return ''; }
}

function _gridRows(items, cols) {
  const rows = [];
  let curKey = null;
  let row = null;
  for (const it of items || []) {
    if (!it || !(it.file_url || it._e5)) continue;
    const ts = _ts(it.created_at);
    const d = ts ? new Date(ts) : null;
    const mk = d ? `${d.getFullYear()}-${d.getMonth()}` : '';
    if (mk !== curKey) {
      curKey = mk;
      rows.push({ k: `h|${mk}|${rows.length}`, header: _monthTitle(ts) });
      row = null;
    }
    if (!row || row.items.length >= cols) {
      row = { k: `r|${it.id}`, items: [] };
      rows.push(row);
    }
    row.items.push(it);
  }
  return rows;
}

function SectionedMediaGrid({ items, type, colors, onView, onEndReached, loadingMore }) {
  const COLS = 3;
  const rows = useMemo(() => _gridRows(items, COLS), [items]);
  return (
    <FlatList
      key={`grid-${type}`}
      data={rows}
      keyExtractor={(r) => r.k}
      contentContainerStyle={{ paddingBottom: 28 }}
      showsVerticalScrollIndicator={false}
      onEndReached={onEndReached}
      onEndReachedThreshold={0.6}
      removeClippedSubviews={Platform.OS === 'android'}
      windowSize={7}
      initialNumToRender={10}
      ListFooterComponent={<ListFooter busy={loadingMore} colors={colors} />}
      renderItem={({ item: r }) => (r.header !== undefined ? (
        <Text style={{ color: colors.text, fontSize: 13, fontWeight: '700', letterSpacing: 0.2, paddingHorizontal: 14, paddingTop: 16, paddingBottom: 8 }} numberOfLines={1}>
          {r.header}
        </Text>
      ) : (
        <View style={{ flexDirection: 'row', paddingHorizontal: 1 }}>
          {r.items.map((it) => (
            <TouchableOpacity key={String(it.id)} onPress={() => onView(it)} activeOpacity={0.85}
              style={{ width: `${100 / COLS}%`, aspectRatio: 1, padding: 1 }}>
              <View style={{ flex: 1, overflow: 'hidden', backgroundColor: colors.surface }}>
                {_isVid(it) ? (
                  <View style={{ flex: 1, backgroundColor: '#000' }} />
                ) : (
                  <FastImage source={{ uri: resolveUrl(it.thumbnail_url || it.file_url || (it._e5 && it.thumb_b64 ? `data:image/jpeg;base64,${it.thumb_b64}` : '')) /* [2026-10-20 tg2] grade: versão de tela, não o original · [2026-10-22 galeria-e2ee] LQIP até decifrar */ }} style={{ width: '100%', height: '100%' }}
                    resizeMode="cover" recyclingKey={it.file_url || String(it.id)} />
                )}
                {_isVid(it) ? (
                  <View style={{ position: 'absolute', right: 5, bottom: 4, flexDirection: 'row', alignItems: 'center' }}>
                    <IconPlay size={11} color="#fff" />
                  </View>
                ) : null}
              </View>
            </TouchableOpacity>
          ))}
        </View>
      ))}
    />
  );
}

// [2026-10-20 media-wa] aba Áudio: toque TOCA ali mesmo (player global da voz —
// mini player, velocidade, ponto azul) em vez de abrir o visualizador de tela cheia.
function AudioRowGlyph({ id, color }) {
  let st = { active: false, playing: false };
  try { st = require('../services/voiceNotePlayer').useVoiceBubbleState(id); } catch {}
  return st.active && st.playing ? <IconPause size={20} color={color} /> : <IconPlay size={20} color={color} />;
}

function MediaGrid({ items, type, colors, onView, onEndReached, loadingMore, t, onOpenLink, onJump, onPlayAudio }) {
  if (items.length === 0) return <EmptyState type={type} colors={colors} t={t} />;

  if (type === 'link') {
    return (
      <FlatList
        key="list-link"
        data={items}
        keyExtractor={_itemKey}
        contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 28 }}
        ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
        showsVerticalScrollIndicator={false}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.6}
        ListFooterComponent={<ListFooter busy={loadingMore} colors={colors} />}
        renderItem={({ item }) => <LinkRow item={item} colors={colors} t={t} onOpen={onOpenLink} onJump={onJump} />}
      />
    );
  }

  if (type === 'media' || type === 'image' || type === 'video') {
    // [2026-10-18 tg-viewer] Fallback JS (web / binário sem a grade nativa): seções
    // por mês (como a nativa) + linhas de 3; células quadradas sem cantos (Telegram).
    return <SectionedMediaGrid items={items} type={type} colors={colors} onView={onView}
      onEndReached={onEndReached} loadingMore={loadingMore} />;
  }

  // List view for audio and files
  const accent = colors.text;
  const accentBg = colors.background;
  return (
    <FlatList
      key={`list-${type}`}
      data={items}
      keyExtractor={item => String(item.id)}
      contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 28 }}
      ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
      showsVerticalScrollIndicator={false}
      onEndReached={onEndReached}
      onEndReachedThreshold={0.6}
      ListFooterComponent={<ListFooter busy={loadingMore} colors={colors} />}
      renderItem={({ item, index }) => {
        const isAudio = type === 'audio';
        const ext = (item.file_name || '').split('.').pop()?.toLowerCase() || '';
        // Friendly title — strip the raw `audio_<timestamp>.m4a` filenames the
        // recorder uses and replace with a sequential "Mensagem de voz #N"
        // label. Documents keep their real filename.
        const rawName = (item.file_name || '').trim();
        const title = isAudio
          ? (/^audio_\d{10,}\.[a-z0-9]+$/i.test(rawName) || rawName === ''
              ? `Mensagem de voz ${index + 1}`
              : rawName.replace(/\.[a-z0-9]+$/i, ''))
          : (rawName || 'Documento');
        const extLabel = isAudio
          ? (ext.toUpperCase() || 'AUDIO')
          : (ext.toUpperCase() || 'FILE');
        return (
          <TouchableOpacity
            onPress={() => (isAudio && onPlayAudio ? onPlayAudio(item) : onView(item))}
            style={{
              flexDirection: 'row', alignItems: 'center',
              paddingVertical: 13, paddingHorizontal: 13,
              borderRadius: 16, backgroundColor: colors.surface,
              borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
            }}
            activeOpacity={0.7}
          >
            <View style={{
              width: 46, height: 46, borderRadius: 14, backgroundColor: accentBg,
              alignItems: 'center', justifyContent: 'center', marginRight: 13,
            }}>
              {isAudio ? <AudioRowGlyph id={item.id} color={accent} /> : <IconFileText size={20} color={accent} />}
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600', letterSpacing: -0.2 }} numberOfLines={1}>
                {title}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 5 }}>
                <View style={{
                  paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5,
                  backgroundColor: accentBg,
                }}>
                  <Text style={{ fontSize: 9.5, fontWeight: '800', color: accent, letterSpacing: 0.4 }}>
                    {extLabel}
                  </Text>
                </View>
                <Text style={{ color: colors.textTertiary, fontSize: 12, marginLeft: 8 }} numberOfLines={1}>
                  {[formatSize(item.file_size), formatDate(item.created_at)].filter(Boolean).join('  ·  ')}
                </Text>
              </View>
            </View>
            {onJump ? (
              <TouchableOpacity
                onPress={() => onJump(item)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={(t && t('chat.showInChat') !== 'chat.showInChat' && t('chat.showInChat')) || 'Mostrar na conversa'}
                style={{ width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, marginRight: 6 }}
              >
                <IconMessageSquare size={16} color={colors.textTertiary} />
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              onPress={() => onView(item)}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={(t && t('gallery.openFile') !== 'gallery.openFile' && t('gallery.openFile')) || 'Abrir'}
              style={{
                width: 34, height: 34, borderRadius: 17,
                alignItems: 'center', justifyContent: 'center',
                backgroundColor: colors.background,
              }}>
              <IconDownload size={17} color={colors.textTertiary} />
            </TouchableOpacity>
          </TouchableOpacity>
        );
      }}
    />
  );
}

export default function MediaGallery({ visible, onClose, conversationId, colors, t, initialTab, onJumpToMessage, senderNameOf, getLocalRows }) {
  const [activeTab, setActiveTab] = useState(_normTab(initialTab));
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  // [busca-conversa 2026-10-16] paginação no servidor (chat_shared_items, cursor).
  const cursorRef = useRef(null);
  const moreBusyRef = useRef(false);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => { if (visible && initialTab) setActiveTab(_normTab(initialTab)); }, [visible, initialTab]);
  const [viewerItem, setViewerItem] = useState(null);
  // Guards against a slow request for a previous tab resolving after the user
  // switched tabs (stale response would overwrite the active tab's items).
  const loadSeqRef = useRef(0);
  const { language } = useLanguage() || {};
  // [2026-10-16 native-media-grid] grade nativa p/ Fotos/Vídeos + seleção.
  const gridRef = useRef(null);
  const useNativeGrid = (activeTab === 'media' || activeTab === 'image' || activeTab === 'video') && isNativeMediaGridAvailable();
  const [sel, setSel] = useState({ active: false, keys: [], count: 0 });
  const [selBusy, setSelBusy] = useState(false);
  // [2026-10-21 viewer-audit] retorno do "Salvar" em lote (WhatsApp: "N salvos")
  // — antes sucesso saía calado e falha/permissão negada mostrava só "Erro".
  const [saveNote, setSaveNote] = useState(null);
  const saveNoteTimer = useRef(null);
  useEffect(() => () => { if (saveNoteTimer.current) clearTimeout(saveNoteTimer.current); }, []);
  const flashSaveNote = useCallback((msg) => {
    if (saveNoteTimer.current) clearTimeout(saveNoteTimer.current);
    setSaveNote(msg);
    saveNoteTimer.current = setTimeout(() => { saveNoteTimer.current = null; setSaveNote(null); }, 2200);
  }, []);
  const nativeItems = useMemo(() => (useNativeGrid ? _nativeItems(items, activeTab) : []), [useNativeGrid, items, activeTab]);
  const itemsById = useMemo(() => {
    const m = new Map();
    for (const it of items || []) m.set(String(it.id), it);
    return m;
  }, [items]);
  const gridTheme = useMemo(() => ({
    bg: _hex(colors?.background, '#FFFFFF'),
    placeholder: _hex(colors?.surface, '#8E8E93'),
    sectionText: _hex(colors?.text, '#111111'),
  }), [colors?.background, colors?.surface, colors?.text]);
  useEffect(() => {
    // trocou de aba / fechou → sai da seleção
    setSel({ active: false, keys: [], count: 0 });
    try { gridRef.current?.clearSelection?.(); } catch {}
  }, [activeTab, visible]);

  const _tl = (k, fb) => { try { const v = t && t(k); return v && v !== k ? v : fb; } catch { return fb; } };
  const tabLabels = {
    media: _tl('chat.mediaTab', 'Mídia'),
    audio: _tl('chat.audioTab', 'Áudio'),
    // [wave14a 2026-10-16] rótulo curto: 5 abas não cabem "Documentos" (truncava).
    file: _tl('chat.docsShort', 'Docs'),
    link: _tl('chat.nprofile.links', 'Links'),
  };
  const tabA11y = { ...tabLabels, file: _tl('chat.documents', 'Documentos') };

  useEffect(() => {
    if (visible && conversationId) loadMedia(activeTab);
  }, [visible, activeTab, conversationId]);
  // [2026-10-22 galeria-e2ee] miniatura/arquivo cifrado ficou pronto no aparelho → remonta os itens locais
  useEffect(() => {
    const G = _e5G();
    if (!visible || !conversationId || !G || !G.isE2eeConv(conversationId)) return undefined;
    let tm = null;
    const off = G.onMediaReady((ev) => {
      if (ev && ev.conv != null && String(ev.conv) !== String(conversationId)) return;
      if (tm) return;
      tm = setTimeout(() => {
        tm = null;
        const seq = loadSeqRef.current;
        const tab = activeTab;
        let rows = [];
        try { rows = typeof getLocalRows === 'function' ? (getLocalRows() || []) : []; } catch { rows = []; }
        G.localSharedItems(conversationId, tab, rows).then((loc) => { if (seq === loadSeqRef.current && Array.isArray(loc)) setItems(loc); }).catch(() => {});
      }, 400);
    });
    return () => { try { off && off(); } catch {} if (tm) clearTimeout(tm); };
  }, [visible, activeTab, conversationId]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMedia = async (type) => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    cursorRef.current = null;
    moreBusyRef.current = false;
    setLoadingMore(false);
    try {
      // [2026-10-22 galeria-e2ee] conversa cifrada: o servidor só tem ciphertext → itens do que já
      // está decifrado no aparelho (fotos/vídeos/docs/áudios do anexo cifrado, links do texto decifrado).
      const G = _e5G();
      if (G && G.isE2eeConv(conversationId)) {
        let rows = [];
        try { rows = typeof getLocalRows === 'function' ? (getLocalRows() || []) : []; } catch { rows = []; }
        const loc = await G.localSharedItems(conversationId, type, rows);
        if (seq !== loadSeqRef.current) return;
        setItems(loc || []);
        setLoading(false);
        return;
      }
      // [busca-conversa 2026-10-16] servidor paginado; servidor velho (ação
      // desconhecida) → galeria antiga (até 300, sem links).
      let r = null;
      try { r = await api.chatSharedItems?.(conversationId, type, '', PAGE); } catch { r = null; }
      if (seq !== loadSeqRef.current) return;
      if (r && r.success) {
        cursorRef.current = r.data?.has_more ? (r.data?.next_cursor || null) : null;
      } else if (type === 'media') {
        // servidor velho: fotos + vídeos em duas chamadas, mais recentes primeiro.
        const [a, b] = await Promise.all([
          api.chatMediaGallery(conversationId, 'image').catch(() => null),
          api.chatMediaGallery(conversationId, 'video').catch(() => null),
        ]);
        if (seq !== loadSeqRef.current) return;
        const all = [...((a && a.success && a.data?.items) || []), ...((b && b.success && b.data?.items) || [])];
        all.sort((x, y) => _ts(y.created_at) - _ts(x.created_at));
        r = { success: true, data: { items: all } };
      } else if (type !== 'link') {
        r = await api.chatMediaGallery(conversationId, type);
        if (seq !== loadSeqRef.current) return;
      }
      setItems(r && r.success ? (r.data?.items || []) : []);
    } catch (e) {
      if (seq !== loadSeqRef.current) return;
      console.warn('MediaGallery loadMedia error:', e);
      setItems([]);
    }
    setLoading(false);
  };

  const loadMore = async () => {
    const cur = cursorRef.current;
    if (!cur || moreBusyRef.current || loading) return;
    moreBusyRef.current = true;
    setLoadingMore(true);
    const seq = loadSeqRef.current;
    const type = activeTab;
    try {
      const r = await api.chatSharedItems(conversationId, type, cur, PAGE);
      if (seq !== loadSeqRef.current) return;
      if (r && r.success) {
        cursorRef.current = r.data?.has_more ? (r.data?.next_cursor || null) : null;
        const add = r.data?.items || [];
        setItems((prev) => {
          const seen = new Set(prev.map(_itemKey));
          const out = prev.slice();
          for (const it of add) { const k = _itemKey(it); if (!seen.has(k)) { seen.add(k); out.push(it); } }
          return out;
        });
      }
    } catch {} finally {
      if (seq === loadSeqRef.current) { moreBusyRef.current = false; setLoadingMore(false); }
    }
  };
  const openLinkItem = (item) => {
    try { require('../services/openLink').openLink(item.url, { colors }); } catch {}
  };
  const jumpFromLink = onJumpToMessage ? (item) => { try { onJumpToMessage(item.id); } catch {} } : null;
  const playAudioItem = (item) => {
    if (item && item._e5 && !item.file_url) { // [2026-10-22 galeria-e2ee] baixa+decifra e toca o arquivo local
      const G = _e5G();
      if (G) G.ensureItemFile(item).then((u) => { if (u) playAudioItem({ ...item, file_url: u }); }).catch(() => {});
      return;
    }
    if (!item || !item.file_url) return;
    try {
      const VN = require('../services/voiceNotePlayer');
      const st = VN.getVoiceState();
      if (st.item && String(st.item.messageId) === String(item.id)) { VN.toggleVoiceNote({ messageId: item.id }); return; }
      let uri = String(item.file_url);
      if (uri.startsWith('/')) uri = `${BASE_URL}${uri}`;
      try { uri = require('../services/mediaCache').playableAudioUrl(uri) || uri; } catch {}
      VN.playVoiceNote({
        messageId: item.id, url: item.file_url, uri, conversationId,
        durationMs: Math.max(0, (Number(item.duration) || 0) * 1000),
      }).catch(() => {});
    } catch {}
  };

  // [2026-10-18 tg-viewer] Mídia: o viewer recebe TODAS as fotos/vídeos carregados
  // da aba (paginação horizontal + faixa de miniaturas) e abre/fecha voando da/para
  // a célula da grade nativa (frameOfKey, grade apiVersion >= 2).
  const heroHintRef = useRef(null);
  const handleView = (item, pressRect) => {
    if (item && item._e5 && !item.file_url) { // [2026-10-22 galeria-e2ee] abre o arquivo DECIFRADO local (nunca a URL cifrada)
      const G = _e5G();
      if (G) G.ensureItemFile(item).then((u) => { if (u) handleView({ ...item, file_url: u }, pressRect); }).catch(() => {});
      return;
    }
    if (!item?.file_url) return;
    const _name = (it) => {
      try { return typeof senderNameOf === 'function' ? (senderNameOf(it.sender_email) || '') : String(it.sender_email || '').split('@')[0]; } catch { return ''; }
    };
    const base = {
      fileUrl: item.file_url,
      fileName: item.file_name || 'media',
      fileSize: item.file_size || 0,
      type: _isVid(item) ? 'video' : (item.type || activeTab),
      messageId: item.id || item.message_id || 0,
      senderName: _name(item),
      senderEmail: item.sender_email || '',
      createdAt: item.created_at || null,
    };
    let mediaList = null;
    let initialIndex = 0;
    if (activeTab === 'media' && _isVisual(item)) {
      const vis = (items || []).map((x) => (String(x.id) === String(item.id) ? item : x)).filter((x) => _isVisual(x) && x.file_url); // [2026-10-22 galeria-e2ee] cifrada ainda não decifrada fica fora do deslizar
      const idx = vis.findIndex(x => String(x.id) === String(item.id));
      if (vis.length > 1 && idx >= 0) {
        mediaList = vis.map((it) => {
          const c = String(it.content || '').trim();
          return {
            fileUrl: it.file_url,
            fileName: it.file_name || (_isVid(it) ? 'video.mp4' : 'image.jpg'),
            fileSize: it.file_size || 0,
            type: _isVid(it) ? 'video' : 'image',
            messageId: it.id,
            createdAt: it.created_at || null,
            senderName: _name(it),
            caption: (c && c !== (it.file_name || '') && !/^https?:\/\//i.test(c) && !/^\{/.test(c)) ? c : '',
          };
        });
        initialIndex = idx;
      }
    }
    heroHintRef.current = pressRect && Platform.OS === 'ios' ? { key: String(item.id), rect: pressRect, at: Date.now() } : null;
    setViewerItem({ ...base, mediaList, initialIndex });
  };
  const _gridHeroOn = useNativeGrid && nativeMediaGridApi() >= 2;
  const heroMeasure = useCallback((mid) => {
    const key = String(mid);
    const h = heroHintRef.current;
    if (h && h.key === key && Date.now() - h.at < 2000) {
      heroHintRef.current = null;
      return Promise.resolve(h.rect);
    }
    if (!_gridHeroOn || !gridRef.current?.frameOfKey) return Promise.resolve(null);
    return gridRef.current.frameOfKey(key, true);
  }, [_gridHeroOn]);
  const heroRadiusOf = useCallback(() => 0, []);

  const onNativePress = useCallback((e) => {
    const it = itemsById.get(String(e?.key));
    const r = (e && e.width > 1 && e.height > 1) ? { x: e.x, y: e.y, width: e.width, height: e.height } : null;
    if (it) handleView(it, r);
  }, [itemsById, activeTab, items, senderNameOf]);
  const onNativeLongPress = useCallback((e) => {
    if (e?.key == null || e?.selectionActive) return;
    try { gridRef.current?.beginSelection?.(String(e.key)); } catch {}
  }, []);
  const onNativeSelection = useCallback((e) => {
    setSel({ active: !!e?.active, keys: Array.isArray(e?.keys) ? e.keys : [], count: Number(e?.count) || 0 });
  }, []);
  const exitSelection = useCallback(() => {
    try { gridRef.current?.clearSelection?.(); } catch {}
    setSel({ active: false, keys: [], count: 0 });
  }, []);
  const selectedItems = () => sel.keys.map(k => itemsById.get(String(k))).filter(Boolean);
  const saveSelected = async () => {
    if (selBusy) return;
    const list = selectedItems();
    if (!list.length) return;
    setSelBusy(true);
    let ok = 0;
    let denied = false;
    try {
      const ML = require('expo-media-library');
      // true = só gravar (iOS "Adicionar apenas"), igual ao visualizador
      const perm = await ML.requestPermissionsAsync(true);
      if (perm?.status === 'granted' || perm?.accessPrivileges === 'all' || perm?.accessPrivileges === 'limited') {
        const { ensureLocalFile } = require('../utils/mediaNativeActions');
        for (const it of list) {
          try {
            // eslint-disable-next-line no-await-in-loop
            const _src = it._e5 ? await (_e5G()?.ensureItemFile(it) || null) : resolveUrl(it.file_url); // [2026-10-22 galeria-e2ee]
            if (!_src) continue;
            // eslint-disable-next-line no-await-in-loop
            const f = await ensureLocalFile(_src, it.file_name || '');
            // eslint-disable-next-line no-await-in-loop
            if (f) { await ML.saveToLibraryAsync(f); ok++; }
          } catch {}
        }
      } else denied = true;
    } catch {}
    setSelBusy(false);
    // (dentro de <Modal>: o ToastHost global fica atrás → aviso próprio da folha)
    if (denied) {
      try {
        Alert.alert(
          _tl('common.permission', 'Permissão necessária'),
          _tl('viewer.photosPermissionHint', 'Vá em Ajustes > Chatyy > Fotos e selecione "Todas as fotos".'),
        );
      } catch {}
      return;
    }
    if (ok > 0) {
      exitSelection();
      try { require('../services/haptics').success?.(); } catch {}
      flashSaveNote(ok === list.length
        ? (ok === 1 ? _tl('gallery.savedOne', 'Salvo na galeria') : _tl('gallery.savedMany', '{n} itens salvos na galeria').replace('{n}', String(ok)))
        : _tl('gallery.savedPartial', '{ok} de {n} salvos na galeria').replace('{ok}', String(ok)).replace('{n}', String(list.length)));
    } else {
      try { Alert.alert(_tl('mediaViewer.saveErrorTitle', 'Erro ao salvar'), _tl('drive.downloadFailed', 'Não foi possível baixar o arquivo. Tente novamente.')); } catch {}
    }
  };
  const shareSelected = async () => {
    const list = selectedItems();
    if (list.length !== 1 || selBusy) return;
    setSelBusy(true);
    try {
      const { shareMediaFile } = require('../utils/mediaNativeActions');
      const _src = list[0]._e5 ? await (_e5G()?.ensureItemFile(list[0]) || null) : resolveUrl(list[0].file_url); // [2026-10-22 galeria-e2ee]
      if (_src) await shareMediaFile({ url: _src, fileName: list[0].file_name || '' });
    } catch {}
    setSelBusy(false);
  };

  if (!visible) return null;


  return (
    // [2026-10-17 drag-dismiss] iOS pageSheet = arrasto NATIVO p/ baixo de qualquer
    // ponto (lista no topo) → onRequestClose. Folha começa abaixo da status bar.
    <Modal visible={visible} animationType="slide" transparent={false} presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : undefined} allowSwipeDismissal={!sel.active} /* RN 0.83: sem isso o pageSheet NÃO desce interativo; em seleção o arrasto só sai da seleção */ onRequestClose={sel.active ? exitSelection : onClose}>
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        {/* Header */}
        <View style={{
          flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16,
          paddingTop: Platform.OS === 'web' ? 18 : Platform.OS === 'ios' ? 16 : 56, paddingBottom: 14,
          backgroundColor: colors.surface,
        }}>
          <TouchableOpacity
            onPress={sel.active ? exitSelection : onClose}
            accessibilityRole="button"
            accessibilityLabel={sel.active ? (t?.('common.cancel') || 'Cancelar') : (t?.('common.close') || 'Fechar')}
            style={{
              width: 38, height: 38, borderRadius: 19,
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: colors.background,
              marginRight: 14,
            }}
            activeOpacity={0.6}
          >
            <IconX size={20} color={colors.text} />
          </TouchableOpacity>
          {sel.active ? (
            <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ flex: 1, fontSize: 19, fontWeight: '800', color: colors.text, letterSpacing: -0.4 }} numberOfLines={1}>
                {(t?.('chat.selected') || '{count} selecionada(s)').replace('{count}', String(sel.count))}
              </Text>
              {sel.count === 1 && (
                <TouchableOpacity onPress={shareSelected} disabled={selBusy} accessibilityRole="button"
                  style={{ paddingHorizontal: 12, paddingVertical: 8, opacity: selBusy ? 0.5 : 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text }}>{t?.('common.share') || 'Compartilhar'}</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={saveSelected} disabled={selBusy || sel.count === 0} accessibilityRole="button"
                style={{ paddingHorizontal: 12, paddingVertical: 8, opacity: (selBusy || sel.count === 0) ? 0.5 : 1 }}>
                {selBusy
                  ? <ActivityIndicator size="small" color={colors.text} />
                  : <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text }}>{t?.('common.save') || 'Salvar'}</Text>}
              </TouchableOpacity>
            </View>
          ) : (
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textTertiary, letterSpacing: 0.6, textTransform: 'uppercase' }}>
              {t?.('chat.sharedInChat') || 'Compartilhado nesta conversa'}
            </Text>
            <Text style={{ fontSize: 21, fontWeight: '800', color: colors.text, letterSpacing: -0.5, marginTop: 1 }}>
              {t?.('chatConv.mediaLinksDocs') || 'Mídia, links e docs'}
            </Text>
          </View>
          )}
        </View>

        {/* [2026-10-18 tg-viewer] Abas estilo Telegram: texto + traço sob a ativa (P&B do tema). */}
        <View style={{
          flexDirection: 'row', paddingHorizontal: 8,
          backgroundColor: colors.surface,
          borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
        }}>
          {TABS.map(tab => {
            const active = activeTab === tab;
            return (
              <TouchableOpacity
                key={tab}
                onPress={() => setActiveTab(tab)}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                accessibilityLabel={tabA11y[tab]}
                style={{ flex: 1, alignItems: 'center', paddingTop: 10 }}
                activeOpacity={0.7}
              >
                <Text style={{
                  fontSize: 14.5, fontWeight: active ? '700' : '600',
                  color: active ? colors.text : colors.textTertiary,
                  letterSpacing: -0.2, paddingBottom: 10,
                }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
                  {tabLabels[tab]}
                </Text>
                <View style={{
                  height: 2.5, borderTopLeftRadius: 2, borderTopRightRadius: 2,
                  alignSelf: 'stretch', marginHorizontal: 14,
                  backgroundColor: active ? colors.text : 'transparent',
                }} />
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Content */}
        {loading ? (
          // [2026-10-20 ux] skeleton com a FORMA do conteúdo (grade p/ mídia, linhas p/ links/docs/áudio)
          (activeTab === 'media' || activeTab === 'image' || activeTab === 'video')
            ? <View style={{ flex: 1 }}><GridSkeleton count={15} columns={3} /></View>
            : <View style={{ flex: 1, paddingTop: 8 }}><ListSkeleton count={7} /></View>
        ) : (useNativeGrid && nativeItems.length > 0) ? (
          <NativeMediaGrid
            ref={gridRef}
            items={nativeItems}
            sections
            spacing={2}
            locale={language || ''}
            theme={gridTheme}
            contentInsetBottom={28}
            onItemPress={onNativePress}
            onItemLongPress={onNativeLongPress}
            onSelectionChange={onNativeSelection}
            onEndReached={loadMore}
          />
        ) : (
          <MediaGrid items={items} type={activeTab} colors={colors} onView={handleView}
            onEndReached={loadMore} loadingMore={loadingMore} t={t}
            onOpenLink={openLinkItem} onJump={jumpFromLink} onPlayAudio={playAudioItem} />
        )}
      </View>
      {saveNote ? (
        <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 48, alignItems: 'center' }}>
          <View accessibilityLiveRegion="polite" style={{ paddingHorizontal: 16, paddingVertical: 10, borderRadius: 20, backgroundColor: 'rgba(20,20,22,0.92)' }}>
            <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>{saveNote}</Text>
          </View>
        </View>
      ) : null}
      <ChatMediaViewer
        visible={!!viewerItem}
        fileUrl={viewerItem?.fileUrl}
        fileName={viewerItem?.fileName}
        fileSize={viewerItem?.fileSize}
        type={viewerItem?.type}
        mediaList={viewerItem?.mediaList || undefined}
        initialIndex={viewerItem?.initialIndex || 0}
        senderName={viewerItem?.senderName}
        senderEmail={viewerItem?.senderEmail}
        createdAt={viewerItem?.createdAt}
        heroMeasure={heroMeasure}
        heroRadiusOf={heroRadiusOf}
        onClose={() => setViewerItem(null)}
        colors={colors}
        t={t}
        conversationId={conversationId}
        messageId={viewerItem?.messageId || 0}
      />
    </Modal>
  );
}
