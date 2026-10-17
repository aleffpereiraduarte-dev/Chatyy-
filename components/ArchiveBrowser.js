// [2026-10-17 drive-archive] Conteúdo de um arquivo compactado do Cloud dentro do app.
// [abridores 2026-10-17] Também anexo do chat (`chatMessageId`): o servidor
// confere a participação na conversa e devolve a permissão `dl` junto da lista.
// Formatos: ZIP/APK/JAR/IPA, RAR/RAR5, 7z, TAR(.gz/.bz2/.xz/.zst/.lz), ISO, CAB,
// ARJ, LZH, DMG, WIM e GZ/BZ2/XZ/ZST/LZ/LZMA soltos (1 item).
//
// O servidor (drive.php → drive-archive.php) lista, entrega UM item por vez
// (permissão curta `dl`, nunca o bearer na URL) e extrai para uma pasta do
// Cloud. Aqui: navegação por pastas, toque no item = pré-visualização
// (renderEntry vem do FileViewer: imagem/PDF/texto/vídeo/áudio/doc) e botão
// "Extrair para o Cloud". Visual P&B, fundo do visualizador (preto).
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { View, Text, TouchableOpacity, FlatList, ActivityIndicator, StyleSheet, BackHandler, Platform } from 'react-native';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import { IconFolder, IconFileText, IconImage, IconFilm, IconMusic, IconPackage, IconChevronRight, IconChevronLeft, IconLock } from './Icons';

const FG = '#ffffff';
const FG2 = 'rgba(255,255,255,0.6)';
const FG3 = 'rgba(255,255,255,0.4)';
const TILE = 'rgba(255,255,255,0.08)';
const LINE = 'rgba(255,255,255,0.08)';

const ERR_KEYS = {
  archive_encrypted: ['archive.encrypted', 'Arquivo protegido por senha'],
  archive_format_unsupported: ['archive.unsupported', 'Este formato ainda não pode ser aberto no app'],
  archive_source_unsupported: ['archive.unsupported', 'Este formato ainda não pode ser aberto no app'],
  archive_too_large: ['archive.tooLarge', 'Arquivo grande demais para abrir no app'],
  archive_too_many_entries: ['archive.tooMany', 'Arquivo com itens demais para abrir no app'],
  archive_bomb: ['archive.suspicious', 'Este arquivo compactado parece inválido ou perigoso'],
  archive_corrupt: ['archive.corrupt', 'Arquivo compactado danificado'],
  archive_empty: ['archive.empty', 'Arquivo vazio'],
  file_unavailable: ['fileViewer.unavailableHint', 'Este arquivo não está mais no servidor. Envie de novo a partir do aparelho onde ele está salvo.'],
  quota_exceeded: ['archive.quota', 'Sem espaço no Cloud para extrair'],
  extract_in_progress: ['archive.busy', 'Outra extração está em andamento'],
  entry_too_large: ['archive.itemTooLarge', 'Item grande demais para pré-visualizar'],
};

export const ARCHIVE_EXTS = [
  'zip', 'zipx', 'apk', 'jar', 'ipa', 'rar', '7z', 'tar', 'tgz', 'tbz', 'tbz2', 'txz', 'tzst', 'tlz',
  'gz', 'bz2', 'xz', 'zst', 'lz', 'lzma', 'iso', 'cab', 'arj', 'lzh', 'lha', 'dmg', 'wim', 'xar', 'cpio',
];

export function isArchiveName(name) { return ARCHIVE_EXTS.includes(extOf(name)); }

function tt(t, k, fb, vars) {
  let v = t(k, vars);
  if (!v || v === k) {
    v = fb;
    if (vars) for (const n of Object.keys(vars)) v = v.split('{' + n + '}').join(String(vars[n]));
  }
  return v;
}

export function fmtBytes(b) {
  const n = Number(b) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

function extOf(name) { return String(name || '').split('.').pop().toLowerCase(); }

function iconFor(name) {
  const e = extOf(name);
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif'].includes(e)) return IconImage;
  if (['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'].includes(e)) return IconFilm;
  if (['mp3', 'm4a', 'aac', 'wav', 'ogg', 'flac'].includes(e)) return IconMusic;
  if (ARCHIVE_EXTS.includes(e)) return IconPackage;
  return IconFileText;
}

function errText(t, code) {
  const k = ERR_KEYS[code];
  return k ? tt(t, k[0], k[1]) : tt(t, 'archive.loadFailed', 'Não foi possível abrir o conteúdo');
}

// entries planos → { dir: { folders: [{name, path, count}], files: [entry] } }
function buildTree(entries) {
  const dirs = new Map();
  const ensure = (d) => {
    if (!dirs.has(d)) dirs.set(d, { folders: new Map(), files: [] });
    return dirs.get(d);
  };
  ensure('');
  const addDir = (p) => {
    const parts = p.split('/');
    let cur = '';
    for (const seg of parts) {
      const parent = cur;
      cur = cur ? cur + '/' + seg : seg;
      const node = ensure(parent);
      if (!node.folders.has(seg)) node.folders.set(seg, { name: seg, path: cur });
      ensure(cur);
    }
  };
  for (const e of entries || []) {
    if (e.dir) { addDir(e.path); continue; }
    const i = e.path.lastIndexOf('/');
    const d = i > 0 ? e.path.slice(0, i) : '';
    if (d) addDir(d);
    ensure(d).files.push({ ...e, name: e.path.slice(i + 1) });
  }
  const out = {};
  for (const [d, node] of dirs) {
    const folders = [...node.folders.values()].map((f) => {
      const c = dirs.get(f.path);
      return { ...f, count: c ? c.folders.size + c.files.length : 0 };
    }).sort((a, b) => a.name.localeCompare(b.name));
    const files = node.files.sort((a, b) => a.name.localeCompare(b.name));
    out[d] = { folders, files };
  }
  return out;
}

export default function ArchiveBrowser({ file, chatMessageId, renderEntry, onExtracted, header }) {
  const chatMid = chatMessageId != null && /^\d+$/.test(String(chatMessageId)) ? String(chatMessageId) : null;
  const srcKey = chatMid ? 'm:' + chatMid : (file?.id != null ? 'f:' + file.id : '');
  const { t } = useLanguage();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const [cwd, setCwd] = useState('');
  const [entry, setEntry] = useState(null); // { name, url }
  const [opening, setOpening] = useState(null); // path em preparação
  const [extracting, setExtracting] = useState(false);
  const [note, setNote] = useState(null);
  const grantRef = useRef(null);
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  useEffect(() => {
    let alive = true;
    setData(null); setErr(null); setCwd(''); setEntry(null); setNote(null);
    grantRef.current = null;
    if (!srcKey) { setErr('archive_source_unsupported'); return undefined; }
    (chatMid ? api.driveArchiveChatList(chatMid) : api.driveArchiveList(file.id)).then((r) => {
      if (!alive) return;
      if (r?.success && r?.data?.entries) {
        if (chatMid && r.data.dl) grantRef.current = { token: r.data.dl, expires: Number(r.data.dl_expires) || 0 };
        setData(r.data);
      } else setErr(r?.data?.error || 'load_failed');
    }).catch(() => { if (alive) setErr('load_failed'); });
    return () => { alive = false; };
  }, [srcKey, attempt]);

  const tree = useMemo(() => buildTree(data?.entries), [data]);
  const node = tree[cwd] || { folders: [], files: [] };
  const rows = useMemo(() => [
    ...node.folders.map((f) => ({ key: 'd:' + f.path, kind: 'dir', ...f })),
    ...node.files.map((f) => ({ key: 'f:' + f.path, kind: 'file', ...f })),
  ], [node]);

  const goUp = useCallback(() => {
    if (entry) { setEntry(null); return true; }
    if (!cwd) return false;
    const i = cwd.lastIndexOf('/');
    setCwd(i > 0 ? cwd.slice(0, i) : '');
    return true;
  }, [cwd, entry]);

  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', goUp);
    return () => sub.remove();
  }, [goUp]);

  const openEntry = async (e) => {
    if (e.enc) { setNote(tt(t, 'archive.encrypted', 'Arquivo protegido por senha')); return; }
    if (e.size > 300 * 1024 * 1024) { setNote(tt(t, 'archive.itemTooLarge', 'Item grande demais para pré-visualizar')); return; }
    setNote(null);
    let g = grantRef.current;
    const now = Date.now() / 1000;
    if (!g || (g.expires && g.expires - now < 120)) {
      setOpening(e.path);
      if (chatMid) {
        const r = await api.driveArchiveChatList(chatMid).catch(() => null);
        g = r?.success && r?.data?.dl ? { token: r.data.dl, expires: Number(r.data.dl_expires) || 0 } : null;
      } else {
        g = await api.driveDlGrant(file.id);
      }
      if (!aliveRef.current) return;
      setOpening(null);
      if (!g) { setNote(tt(t, 'archive.loadFailed', 'Não foi possível abrir o conteúdo')); return; }
      grantRef.current = g;
    }
    const url = chatMid ? api.driveArchiveChatEntryUrl(chatMid, e.path, g.token) : api.driveArchiveEntryUrl(file.id, e.path, g.token);
    setEntry({ name: e.name, path: e.path, size: e.size, url });
  };

  const extract = async () => {
    if (extracting) return;
    setExtracting(true); setNote(null);
    try {
      const r = chatMid ? await api.driveArchiveChatExtract(chatMid) : await api.driveArchiveExtract(file.id);
      if (!aliveRef.current) return;
      if (r?.success && r?.data?.folder) {
        const d = r.data;
        const parts = [tt(t, 'archive.extracted', 'Extraído na pasta "{name}"', { name: d.folder.name })];
        const miss = (Number(d.failed) || 0) + (Number(d.remaining) || 0);
        if (miss > 0) parts.push(tt(t, 'archive.extractIncomplete', '{n} arquivos não foram extraídos', { n: miss }));
        if (Number(d.blocked) > 0) parts.push(tt(t, 'archive.blockedSome', '{n} arquivos bloqueados por segurança', { n: d.blocked }));
        setNote(parts.join(' · '));
        try { onExtracted && onExtracted(d.folder, d); } catch {}
      } else {
        setNote(errText(t, r?.data?.error));
      }
    } catch {
      if (aliveRef.current) setNote(tt(t, 'archive.loadFailed', 'Não foi possível abrir o conteúdo'));
    } finally {
      if (aliveRef.current) setExtracting(false);
    }
  };

  if (entry) {
    return (
      <View style={st.fill}>
        <View style={st.entryBar}>
          <TouchableOpacity onPress={() => setEntry(null)} style={st.iconBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button">
            <IconChevronLeft size={22} color={FG} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={st.entryTitle} numberOfLines={1}>{entry.name}</Text>
            <Text style={st.entrySub} numberOfLines={1}>{fmtBytes(entry.size)}</Text>
          </View>
        </View>
        <View style={st.fill}>{renderEntry ? renderEntry({ url: entry.url, name: entry.name, size: entry.size }) : null}</View>
      </View>
    );
  }

  const crumbs = cwd ? cwd.split('/') : [];
  const listHeader = (
    <View>
      {header}
      <View style={st.sectionRow}>
        {cwd ? (
          <TouchableOpacity onPress={goUp} style={st.backRow} accessibilityRole="button">
            <IconChevronLeft size={18} color={FG} />
            <Text style={st.sectionTitle} numberOfLines={1}>{crumbs[crumbs.length - 1]}</Text>
          </TouchableOpacity>
        ) : (
          <Text style={st.sectionTitle}>{tt(t, 'archive.contents', 'Conteúdo')}</Text>
        )}
        {data ? (
          <Text style={st.sectionSub} numberOfLines={1}>
            {tt(t, 'archive.summary', '{files} arquivos · {size}', { files: data.files, size: fmtBytes(data.total_size) })}
          </Text>
        ) : null}
      </View>
      {data?.truncated ? <Text style={st.hint}>{tt(t, 'archive.truncated', 'Mostrando os primeiros {n} itens', { n: data.entries.length })}</Text> : null}
      {data?.encrypted ? (
        <View style={st.notice}><IconLock size={14} color={FG2} /><Text style={st.noticeText}>{tt(t, 'archive.encrypted', 'Arquivo protegido por senha')}</Text></View>
      ) : null}
    </View>
  );

  if (err || !data) {
    return (
      <View style={st.fill}>
        {header}
        <View style={st.center}>
          {err ? (
            <>
              <Text style={st.errText}>{errText(t, err)}</Text>
              {!ERR_KEYS[err] || err === 'archive_corrupt' ? (
                <TouchableOpacity style={st.btnGhost} onPress={() => setAttempt((n) => n + 1)} accessibilityRole="button">
                  <Text style={st.btnGhostText}>{tt(t, 'common.retry', 'Tentar novamente')}</Text>
                </TouchableOpacity>
              ) : null}
            </>
          ) : (
            <>
              <ActivityIndicator color={FG} />
              <Text style={st.hint}>{tt(t, 'archive.loading', 'Abrindo arquivo compactado…')}</Text>
            </>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={st.fill}>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.key}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={<Text style={[st.hint, { textAlign: 'center', marginTop: 24 }]}>{tt(t, 'archive.empty', 'Arquivo vazio')}</Text>}
        contentContainerStyle={{ paddingBottom: 16 }}
        renderItem={({ item }) => {
          const isDir = item.kind === 'dir';
          const Ic = isDir ? IconFolder : iconFor(item.name);
          return (
            <TouchableOpacity
              style={st.row}
              activeOpacity={0.6}
              onPress={() => (isDir ? setCwd(item.path) : openEntry(item))}
              accessibilityRole="button"
              accessibilityLabel={item.name}
            >
              <View style={st.rowIcon}><Ic size={20} color={isDir ? FG : FG2} /></View>
              <View style={st.rowText}>
                <Text style={st.rowName} numberOfLines={1}>{item.name}</Text>
                <Text style={st.rowSub} numberOfLines={1}>
                  {isDir ? tt(t, 'archive.folderItems', '{n} itens', { n: item.count }) : fmtBytes(item.size)}
                </Text>
              </View>
              {opening === item.path ? <ActivityIndicator size="small" color={FG2} />
                : item.enc ? <IconLock size={16} color={FG3} />
                : isDir ? <IconChevronRight size={18} color={FG3} /> : null}
            </TouchableOpacity>
          );
        }}
      />
      {note ? <Text style={st.note} numberOfLines={3}>{note}</Text> : null}
      {data.can_extract ? (
        <View style={st.footer}>
          <TouchableOpacity style={[st.btnPrimary, extracting && { opacity: 0.7 }]} onPress={extract} disabled={extracting} accessibilityRole="button">
            {extracting ? <ActivityIndicator size="small" color="#000" /> : null}
            <Text style={st.btnPrimaryText}>{extracting ? tt(t, 'archive.extracting', 'Extraindo…') : tt(t, 'archive.extract', 'Extrair para o Cloud')}</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

const st = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 14 },
  errText: { color: FG2, fontSize: 15, textAlign: 'center', lineHeight: 21 },
  hint: { color: FG3, fontSize: 13, marginHorizontal: 20, marginTop: 6 },
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 6, gap: 12 },
  backRow: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 },
  sectionTitle: { color: FG, fontSize: 15, fontWeight: '600', flexShrink: 1 },
  sectionSub: { color: FG3, fontSize: 13, flexShrink: 0 },
  notice: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 20, marginTop: 6 },
  noticeText: { color: FG2, fontSize: 13 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 10, gap: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: LINE },
  rowIcon: { width: 40, height: 40, borderRadius: 10, backgroundColor: TILE, alignItems: 'center', justifyContent: 'center' },
  rowText: { flex: 1, minWidth: 0 },
  rowName: { color: FG, fontSize: 15 },
  rowSub: { color: FG3, fontSize: 12, marginTop: 2 },
  note: { color: FG2, fontSize: 13, textAlign: 'center', paddingHorizontal: 20, paddingTop: 10 },
  footer: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 },
  btnPrimary: { height: 48, borderRadius: 14, backgroundColor: '#ffffff', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  btnPrimaryText: { color: '#000000', fontSize: 16, fontWeight: '600' },
  btnGhost: { paddingHorizontal: 22, paddingVertical: 11, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' },
  btnGhostText: { color: FG, fontSize: 15, fontWeight: '600' },
  entryBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: LINE },
  iconBtn: { padding: 6 },
  entryTitle: { color: FG, fontSize: 15, fontWeight: '600' },
  entrySub: { color: FG3, fontSize: 12, marginTop: 1 },
});
