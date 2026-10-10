// [2026-10-10 wa-import] Acesso a arquivos escolhidos/compartilhados, por pedaços.
//   web    → Blob/File (slice + arrayBuffer)
//   nativo → expo-file-system File/FileHandle (readBytes a partir de offset)
// e "sinks" para gravar uma entrada extraída do zip num arquivo temporário.
import { Platform } from 'react-native';

function _fs() { return require('expo-file-system'); }

/** item = { uri, name, mime, size, file? } → source { size, read(offset,len), close() } */
export async function openSource(item) {
  if (Platform.OS === 'web') {
    let blob = item.file || null;
    if (!blob && item.uri) blob = await fetch(item.uri).then((r) => r.blob());
    if (!blob) throw new Error('no_file');
    return {
      size: blob.size,
      read: async (o, n) => new Uint8Array(await blob.slice(o, o + n).arrayBuffer()),
      close: () => {},
      blob,
    };
  }
  const { File } = _fs();
  const f = new File(item.uri);
  const size = Number(f.size) || Number(item.size) || 0;
  let h = null;
  return {
    size,
    read: async (o, n) => {
      if (!h) h = f.open();
      h.offset = o;
      return h.readBytes(n);
    },
    close: () => { try { h?.close(); } catch {} h = null; },
  };
}

export async function readAllText(item) {
  const src = await openSource(item);
  try {
    const parts = [];
    let pos = 0;
    while (pos < src.size) {
      const n = Math.min(1024 * 1024, src.size - pos);
      parts.push(await src.read(pos, n));
      pos += n;
    }
    const out = new Uint8Array(pos);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  } finally { src.close(); }
}

let _seq = 0;
/**
 * Sink temporário: write(chunk) / finish() → { uri|file, cleanup() }
 */
export function createTempSink(name, mime) {
  if (Platform.OS === 'web') {
    const parts = [];
    return {
      write: async (c) => { parts.push(c); },
      finish: async () => {
        let file;
        try { file = new File(parts, name, { type: mime || 'application/octet-stream' }); }
        catch { file = new Blob(parts, { type: mime || 'application/octet-stream' }); }
        parts.length = 0;
        return { file, cleanup: () => {} };
      },
    };
  }
  const { File, Directory, Paths } = _fs();
  const dir = new Directory(Paths.cache, 'waimp');
  try { if (!dir.exists) dir.create({ intermediates: true, idempotent: true }); } catch {}
  const safe = String(name || 'file').replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
  const f = new File(dir, `${Date.now()}_${++_seq}_${safe}`);
  try { if (f.exists) f.delete(); } catch {}
  f.create();
  const h = f.open();
  return {
    write: async (c) => { h.writeBytes(c); },
    finish: async () => {
      try { h.close(); } catch {}
      return { uri: f.uri, cleanup: () => { try { f.delete(); } catch {} } };
    },
  };
}

/** Apaga temporários antigos de importações anteriores (best-effort). */
export function cleanupTemp() {
  if (Platform.OS === 'web') return;
  try {
    const { Directory, Paths } = _fs();
    const dir = new Directory(Paths.cache, 'waimp');
    if (dir.exists) dir.delete();
  } catch {}
}
