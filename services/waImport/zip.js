// [2026-10-10 wa-import] Leitor de .zip com acesso aleatório e memória limitada.
//
// Lê só o diretório central (fim do arquivo) e, depois, cada entrada sob demanda,
// em pedaços (stored = cópia; deflate = fflate.Inflate em streaming). Assim um
// export de 1 GB nunca é carregado inteiro na memória do JS — só o pedaço atual.
//
// source = { size:number, read(offset, length) → Promise<Uint8Array> }
// (ver source.js: Blob no web, expo-file-system FileHandle no nativo).

import { Inflate } from './vendor/fflate';
import { utf8Decode } from './parser';

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function u64(b, o) { return u32(b, o) + u32(b, o + 4) * 0x100000000; }

export async function isZip(source) {
  try {
    if (!source || source.size < 22) return false;
    const h = await source.read(0, 4);
    return u32(h, 0) === SIG_LOC || u32(h, 0) === SIG_EOCD;
  } catch { return false; }
}

function cp437(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/**
 * Lista as entradas do zip: [{ name, method, compSize, size, localOffset, isDir }]
 */
export async function listZipEntries(source) {
  const size = source.size;
  const tailLen = Math.min(size, 65557);
  const tail = await source.read(size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip_no_eocd');
  let count = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOff = u32(tail, eocd + 16);
  // ZIP64
  if ((cdOff === 0xffffffff || count === 0xffff || cdSize === 0xffffffff) && eocd >= 20 && u32(tail, eocd - 20) === SIG_EOCD64_LOC) {
    const e64off = u64(tail, eocd - 20 + 8);
    const e64 = await source.read(e64off, 56);
    if (u32(e64, 0) === SIG_EOCD64) {
      count = u64(e64, 32);
      cdSize = u64(e64, 40);
      cdOff = u64(e64, 48);
    }
  }
  if (cdSize > 64 * 1024 * 1024) throw new Error('zip_cd_too_big');
  const cd = await source.read(cdOff, cdSize);
  const out = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.length; n++) {
    if (u32(cd, p) !== SIG_CEN) break;
    const flags = u16(cd, p + 8);
    const method = u16(cd, p + 10);
    let compSize = u32(cd, p + 20);
    let usize = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    let localOffset = u32(cd, p + 42);
    const nameBytes = cd.subarray(p + 46, p + 46 + nameLen);
    const name = (flags & 0x0800) ? utf8Decode(nameBytes) : guessName(nameBytes);
    // ZIP64 extra
    let q = p + 46 + nameLen;
    const qEnd = q + extraLen;
    while (q + 4 <= qEnd) {
      const id = u16(cd, q); const len = u16(cd, q + 2);
      if (id === 0x0001) {
        let r = q + 4;
        if (usize === 0xffffffff) { usize = u64(cd, r); r += 8; }
        if (compSize === 0xffffffff) { compSize = u64(cd, r); r += 8; }
        if (localOffset === 0xffffffff) { localOffset = u64(cd, r); r += 8; }
      }
      q += 4 + len;
    }
    out.push({ name, method, compSize, size: usize, localOffset, isDir: name.endsWith('/'), encrypted: !!(flags & 1) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function guessName(bytes) {
  // Muitos zips gravam UTF-8 sem o bit 11 — tenta UTF-8 e cai em CP437 se inválido.
  const s = utf8Decode(bytes);
  return s.includes('�') ? cp437(bytes) : s;
}

async function dataOffset(source, entry) {
  const lh = await source.read(entry.localOffset, 30);
  if (u32(lh, 0) !== SIG_LOC) throw new Error('zip_bad_local_header');
  return entry.localOffset + 30 + u16(lh, 26) + u16(lh, 28);
}

/**
 * Extrai uma entrada em pedaços: onChunk(Uint8Array) (pode ser async).
 * onProgress(bytesLidos, total) opcional.
 */
export async function extractZipEntry(source, entry, onChunk, { chunkSize = 512 * 1024, onProgress } = {}) {
  if (entry.encrypted) throw new Error('zip_encrypted');
  if (entry.method !== 0 && entry.method !== 8) throw new Error('zip_method_' + entry.method);
  const start = await dataOffset(source, entry);
  const total = entry.compSize;
  let pos = 0;
  if (entry.method === 0) {
    while (pos < total) {
      const n = Math.min(chunkSize, total - pos);
      const buf = await source.read(start + pos, n);
      pos += n;
      await onChunk(buf);
      if (onProgress) onProgress(pos, total);
    }
    return;
  }
  const pending = [];
  const inf = new Inflate((data) => { if (data && data.length) pending.push(data); });
  while (pos < total) {
    const n = Math.min(chunkSize, total - pos);
    const buf = await source.read(start + pos, n);
    pos += n;
    inf.push(buf, pos >= total);
    while (pending.length) await onChunk(pending.shift());
    if (onProgress) onProgress(pos, total);
  }
  if (total === 0) inf.push(new Uint8Array(0), true);
  while (pending.length) await onChunk(pending.shift());
}

/** Lê uma entrada inteira para a memória (só para arquivos pequenos: _chat.txt). */
export async function readZipEntryBytes(source, entry, maxBytes = 64 * 1024 * 1024) {
  if (entry.size > maxBytes) throw new Error('zip_entry_too_big');
  const parts = [];
  let len = 0;
  await extractZipEntry(source, entry, (c) => { parts.push(c); len += c.length; });
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of parts) { out.set(c, o); o += c.length; }
  return out;
}
