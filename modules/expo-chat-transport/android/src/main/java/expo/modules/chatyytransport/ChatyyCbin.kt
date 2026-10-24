// [cbin 2026-10-24] "cbin v1" — fio binário compacto do Chatyy (estilo FunXMPP do WhatsApp), lado Android.
// Porta 1:1 do Go chatyy-ws/cbin (/root/cbin-2026-10-24/go/cbin): transcodifica SEM PERDA texto JSON ↔ bytes.
// encode(json) → ByteArray? (null = mande o JSON: surrogate solto, UTF-8 inválido, JSON inválido, profundidade)
// decode(bytes) → String? (JSON canônico; null = frame inválido). Dicionário: ChatyyCbinDict (gerado, versionado).
// Contrato: /root/cbin-2026-10-24/CBIN.md. Só é usado depois do cbin_hello → cbin_ok (ChatTransport), flag do JS.
package expo.modules.chatyytransport

import java.io.ByteArrayOutputStream
import java.math.BigInteger

object ChatyyCbin {
  private const val T_NULL = 0x00; private const val T_FALSE = 0x01; private const val T_TRUE = 0x02
  private const val T_UINT = 0x03; private const val T_NEG = 0x04; private const val T_NUMLIT = 0x05
  private const val T_STR = 0x06; private const val T_VAL = 0x07; private const val T_DEC = 0x08
  private const val T_B64 = 0x09; private const val T_B64URL = 0x0A; private const val T_HEX = 0x0B
  private const val T_UUID = 0x0C; private const val T_ARR = 0x0D; private const val T_OBJ = 0x0E
  private const val T_EMAIL = 0x0F; private const val T_JSONSTR = 0x10; private const val T_TIME = 0x11
  private const val T_PFX = 0x12; private const val T_B64RAW = 0x13
  private const val T_SHORT = 0x20; private const val T_SMALL = 0x40; private const val T_VALINL = 0x80
  private const val MAX_FRAME = 1 shl 20
  private const val MAX_DEPTH = 64

  const val VERSION = ChatyyCbinDict.VERSION
  const val DICT_HASH = ChatyyCbinDict.HASH

  private fun index(a: Array<String>): HashMap<String, Int> { val m = HashMap<String, Int>(a.size * 2); a.forEachIndexed { i, s -> if (!m.containsKey(s)) m[s] = i }; return m }
  private val typeIdx by lazy { index(ChatyyCbinDict.TYPES) }
  private val keyIdx by lazy { index(ChatyyCbinDict.KEYS) }
  private val valIdx by lazy { index(ChatyyCbinDict.VALS) }
  private val domIdx by lazy { index(ChatyyCbinDict.DOMS) }
  private val U64_MAX = BigInteger("18446744073709551615")

  private class Bad : Exception() { override fun fillInStackTrace(): Throwable = this }
  private fun bad(): Nothing = throw Bad()

  // ── JSON → árvore plana (preordem), igual ao json.go ──
  private const val K_NULL = 0; private const val K_FALSE = 1; private const val K_TRUE = 2
  private const val K_NUM = 3; private const val K_STR = 4; private const val K_ARR = 5; private const val K_OBJ = 6

  private class Nodes {
    var k = IntArray(64); var a = IntArray(64); var b = IntArray(64); var n = IntArray(64); var size = IntArray(64); var esc = BooleanArray(64); var len = 0
    fun add(kind: Int, aa: Int, bb: Int, e: Boolean): Int {
      if (len == k.size) { val L = len * 2; k = k.copyOf(L); a = a.copyOf(L); b = b.copyOf(L); n = n.copyOf(L); size = size.copyOf(L); esc = esc.copyOf(L) }
      k[len] = kind; a[len] = aa; b[len] = bb; n[len] = 0; size[len] = 1; esc[len] = e; return len++
    }
  }

  private class Parser(val s: ByteArray) {
    var i = 0
    val nd = Nodes()
    fun ws() { while (i < s.size && (s[i] == ' '.code.toByte() || s[i] == '\t'.code.toByte() || s[i] == '\n'.code.toByte() || s[i] == '\r'.code.toByte())) i++ }
    fun all() { ws(); value(0); ws(); if (i != s.size) bad() }
    fun ch(): Int = if (i < s.size) s[i].toInt() and 0xff else bad()
    fun value(depth: Int) {
      if (depth > MAX_DEPTH) bad()
      when (val c = ch()) {
        '{'.code -> {
          val idx = nd.add(K_OBJ, 0, 0, false); i++; ws(); var cnt = 0
          if (ch() == '}'.code) i++ else while (true) {
            ws(); if (ch() != '"'.code) bad(); str(); ws(); if (ch() != ':'.code) bad(); i++; ws(); value(depth + 1); cnt++; ws()
            val d = ch(); i++
            if (d == ','.code) continue
            if (d == '}'.code) break
            bad()
          }
          nd.n[idx] = cnt; nd.size[idx] = nd.len - idx
        }
        '['.code -> {
          val idx = nd.add(K_ARR, 0, 0, false); i++; ws(); var cnt = 0
          if (ch() == ']'.code) i++ else while (true) {
            ws(); value(depth + 1); cnt++; ws()
            val d = ch(); i++
            if (d == ','.code) continue
            if (d == ']'.code) break
            bad()
          }
          nd.n[idx] = cnt; nd.size[idx] = nd.len - idx
        }
        '"'.code -> str()
        't'.code -> lit("true", K_TRUE)
        'f'.code -> lit("false", K_FALSE)
        'n'.code -> lit("null", K_NULL)
        else -> if (c == '-'.code || (c >= '0'.code && c <= '9'.code)) num() else bad()
      }
    }
    fun lit(w: String, k: Int) { if (s.size - i < w.length) bad(); for (j in w.indices) if (s[i + j].toInt() != w[j].code) bad(); nd.add(k, 0, 0, false); i += w.length }
    fun digits(): Int { val st = i; while (i < s.size && s[i] >= '0'.code.toByte() && s[i] <= '9'.code.toByte()) i++; return i - st }
    fun num() {
      val a = i
      if (s[i] == '-'.code.toByte()) i++
      if (i >= s.size) bad()
      if (s[i] == '0'.code.toByte()) i++ else if (s[i] >= '1'.code.toByte() && s[i] <= '9'.code.toByte()) digits() else bad()
      if (i < s.size && s[i] == '.'.code.toByte()) { i++; if (digits() == 0) bad() }
      if (i < s.size && (s[i] == 'e'.code.toByte() || s[i] == 'E'.code.toByte())) { i++; if (i < s.size && (s[i] == '+'.code.toByte() || s[i] == '-'.code.toByte())) i++; if (digits() == 0) bad() }
      nd.add(K_NUM, a, i, false)
    }
    fun str() {
      i++; val a = i; var esc = false
      while (true) {
        if (i >= s.size) bad()
        val c = s[i].toInt() and 0xff
        if (c == '"'.code) break
        if (c < 0x20) bad()
        if (c == '\\'.code) {
          esc = true; i++; if (i >= s.size) bad()
          when (s[i].toInt().toChar()) {
            '"', '\\', '/', 'b', 'f', 'n', 'r', 't' -> i++
            'u' -> { if (s.size - i < 5) bad(); for (j in 1..4) if (hexv(s[i + j].toInt() and 0xff) < 0) bad(); i += 5 }
            else -> bad()
          }
          continue
        }
        i++
      }
      nd.add(K_STR, a, i, esc); i++
    }
  }

  private fun hexv(c: Int): Int = when (c) { in 48..57 -> c - 48; in 97..102 -> c - 87; in 65..70 -> c - 55; else -> -1 }

  private fun validUtf8(b: ByteArray, a: Int, e: Int): Boolean {
    var i = a
    while (i < e) {
      val c = b[i].toInt() and 0xff
      if (c < 0x80) { i++; continue }
      val n: Int; var cp: Int
      when {
        c in 0xC2..0xDF -> { n = 1; cp = c and 0x1f }
        c in 0xE0..0xEF -> { n = 2; cp = c and 0x0f }
        c in 0xF0..0xF4 -> { n = 3; cp = c and 0x07 }
        else -> return false
      }
      if (i + n >= e) return false
      for (k in 1..n) { val cc = b[i + k].toInt() and 0xff; if (cc and 0xC0 != 0x80) return false; cp = (cp shl 6) or (cc and 0x3f) }
      if ((n == 2 && (cp < 0x800 || cp in 0xD800..0xDFFF)) || (n == 3 && (cp < 0x10000 || cp > 0x10FFFF))) return false
      i += n + 1
    }
    return true
  }

  private fun appendRune(o: ByteArrayOutputStream, r: Int) {
    when {
      r < 0x80 -> o.write(r)
      r < 0x800 -> { o.write(0xC0 or (r shr 6)); o.write(0x80 or (r and 63)) }
      r < 0x10000 -> { o.write(0xE0 or (r shr 12)); o.write(0x80 or ((r shr 6) and 63)); o.write(0x80 or (r and 63)) }
      else -> { o.write(0xF0 or (r shr 18)); o.write(0x80 or ((r shr 12) and 63)); o.write(0x80 or ((r shr 6) and 63)); o.write(0x80 or (r and 63)) }
    }
  }

  /** conteúdo decodificado da string (UTF-8 válido) ou Bad */
  private fun strBytes(src: ByteArray, nd: Nodes, j: Int): ByteArray {
    val a = nd.a[j]; val e = nd.b[j]
    if (!nd.esc[j]) { if (!validUtf8(src, a, e)) bad(); return src.copyOfRange(a, e) }
    val o = ByteArrayOutputStream(e - a)
    var i = a
    while (i < e) {
      val c = src[i].toInt() and 0xff
      if (c != '\\'.code) { o.write(c); i++; continue }
      i++
      when (src[i].toInt().toChar()) {
        '"' -> o.write('"'.code); '\\' -> o.write('\\'.code); '/' -> o.write('/'.code)
        'b' -> o.write(8); 'f' -> o.write(12); 'n' -> o.write(10); 'r' -> o.write(13); 't' -> o.write(9)
        'u' -> {
          var r = (hexv(src[i + 1].toInt()) shl 12) or (hexv(src[i + 2].toInt()) shl 8) or (hexv(src[i + 3].toInt()) shl 4) or hexv(src[i + 4].toInt())
          i += 4
          if (r in 0xD800..0xDBFF) {
            if (i + 6 < e && src[i + 1] == '\\'.code.toByte() && src[i + 2] == 'u'.code.toByte()) {
              val lo = (hexv(src[i + 3].toInt()) shl 12) or (hexv(src[i + 4].toInt()) shl 8) or (hexv(src[i + 5].toInt()) shl 4) or hexv(src[i + 6].toInt())
              if (lo in 0xDC00..0xDFFF) { r = 0x10000 + ((r - 0xD800) shl 10) + (lo - 0xDC00); i += 6; appendRune(o, r); i++; continue }
            }
            bad()
          }
          if (r in 0xDC00..0xDFFF) bad()
          appendRune(o, r)
        }
      }
      i++
    }
    val out = o.toByteArray()
    if (!validUtf8(out, 0, out.size)) bad()
    return out
  }

  // ── escritor canônico (JSON.stringify) ──
  private const val HEXD = "0123456789abcdef"
  private fun appendJSONString(o: ByteArrayOutputStream, s: ByteArray) {
    o.write('"'.code)
    for (b in s) {
      val c = b.toInt() and 0xff
      if (c >= 0x20 && c != '"'.code && c != '\\'.code) { o.write(c); continue }
      when (c) {
        '"'.code -> { o.write('\\'.code); o.write('"'.code) }
        '\\'.code -> { o.write('\\'.code); o.write('\\'.code) }
        8 -> { o.write('\\'.code); o.write('b'.code) }
        12 -> { o.write('\\'.code); o.write('f'.code) }
        10 -> { o.write('\\'.code); o.write('n'.code) }
        13 -> { o.write('\\'.code); o.write('r'.code) }
        9 -> { o.write('\\'.code); o.write('t'.code) }
        else -> { o.write('\\'.code); o.write('u'.code); o.write('0'.code); o.write('0'.code); o.write(HEXD[c shr 4].code); o.write(HEXD[c and 15].code) }
      }
    }
    o.write('"'.code)
  }

  private fun canonInt(s: ByteArray, a: Int, e: Int): Boolean {
    var i = a
    if (i < e && s[i] == '-'.code.toByte()) { i++; if (e - i == 1 && s[i] == '0'.code.toByte()) return false }
    val n = e - i
    if (n == 0 || n > 20) return false
    if (s[i] == '0'.code.toByte() && n > 1) return false
    for (k in i until e) if (s[k] < '0'.code.toByte() || s[k] > '9'.code.toByte()) return false
    return n < 20 || BigInteger(String(s, i, n, Charsets.US_ASCII)) <= U64_MAX
  }

  private fun canonical(o: ByteArrayOutputStream, src: ByteArray, nd: Nodes, i0: Int): Int {
    when (nd.k[i0]) {
      K_NULL -> { o.write("null".toByteArray()); return i0 + 1 }
      K_FALSE -> { o.write("false".toByteArray()); return i0 + 1 }
      K_TRUE -> { o.write("true".toByteArray()); return i0 + 1 }
      K_NUM -> { o.write(src, nd.a[i0], nd.b[i0] - nd.a[i0]); return i0 + 1 }
      K_STR -> { appendJSONString(o, strBytes(src, nd, i0)); return i0 + 1 }
      K_ARR -> { o.write('['.code); var j = i0 + 1; for (c in 0 until nd.n[i0]) { if (c > 0) o.write(','.code); j = canonical(o, src, nd, j) }; o.write(']'.code); return j }
      else -> { o.write('{'.code); var j = i0 + 1; for (c in 0 until nd.n[i0]) { if (c > 0) o.write(','.code); appendJSONString(o, strBytes(src, nd, j)); o.write(':'.code); j = canonical(o, src, nd, j + 1) }; o.write('}'.code); return j }
    }
  }

  // ── saída ──
  private class Out { val o = ByteArrayOutputStream(256)
    fun byte(x: Int) = o.write(x)
    fun uvar(v: Long) { var u = v; while (u and 0x7fL.inv() != 0L) { o.write(((u and 0x7f) or 0x80).toInt()); u = u ushr 7 }; o.write(u.toInt()) }
    fun str(b: ByteArray) { uvar(b.size.toLong()); o.write(b) }
  }

  private fun parseU64(s: ByteArray, a: Int, e: Int): Long = java.lang.Long.parseUnsignedLong(String(s, a, e - a, Charsets.US_ASCII))

  private class Enc(val out: Out)

  private fun encKey(o: Out, src: ByteArray, nd: Nodes, j: Int) {
    val kb = strBytes(src, nd, j)
    val ki = keyIdx[String(kb, Charsets.UTF_8)]
    if (ki != null) o.uvar((ki + 1).toLong()) else { o.byte(0); o.str(kb) }
  }

  private fun encValue(o: Out, src: ByteArray, nd: Nodes, i0: Int, depth: Int): Int {
    if (depth > MAX_DEPTH) bad()
    when (nd.k[i0]) {
      K_NULL -> o.byte(T_NULL)
      K_FALSE -> o.byte(T_FALSE)
      K_TRUE -> o.byte(T_TRUE)
      K_NUM -> encNum(o, src, nd.a[i0], nd.b[i0])
      K_STR -> encStr(o, strBytes(src, nd, i0), depth)
      K_ARR -> { o.byte(T_ARR); o.uvar(nd.n[i0].toLong()); var j = i0 + 1; for (c in 0 until nd.n[i0]) j = encValue(o, src, nd, j, depth + 1); return j }
      K_OBJ -> { o.byte(T_OBJ); o.uvar(nd.n[i0].toLong()); var j = i0 + 1; for (c in 0 until nd.n[i0]) { encKey(o, src, nd, j); j = encValue(o, src, nd, j + 1, depth + 1) }; return j }
    }
    return i0 + 1
  }

  private fun encNum(o: Out, s: ByteArray, a: Int, e: Int) {
    if (canonInt(s, a, e)) {
      if (s[a] == '-'.code.toByte()) { val u = parseU64(s, a + 1, e); o.byte(T_NEG); o.uvar(u - 1); return }
      val u = parseU64(s, a, e)
      if (u in 0..63) o.byte(T_SMALL + u.toInt()) else { o.byte(T_UINT); o.uvar(u) }
      return
    }
    o.byte(T_NUMLIT); o.str(s.copyOfRange(a, e))
  }

  private fun isDecCanon(s: ByteArray): Boolean { if (s[0] == '0'.code.toByte()) return false; for (c in s) if (c < '0'.code.toByte() || c > '9'.code.toByte()) return false; return s.size < 20 || BigInteger(String(s, Charsets.US_ASCII)) <= U64_MAX }
  private fun isLowerHex(s: ByteArray): Boolean { for (b in s) { val c = b.toInt(); if (!((c in 48..57) || (c in 97..102))) return false }; return true }
  private fun isUUID(s: ByteArray): Boolean { for (i in s.indices) { val c = s[i].toInt(); if (i == 8 || i == 13 || i == 18 || i == 23) { if (c != '-'.code) return false } else if (!((c in 48..57) || (c in 97..102))) return false }; return true }
  private fun hexBytes(s: ByteArray, a: Int, e: Int): ByteArray { val r = ByteArray((e - a) / 2); for (k in r.indices) r[k] = ((hexv(s[a + 2 * k].toInt()) shl 4) or hexv(s[a + 2 * k + 1].toInt())).toByte(); return r }
  private fun startsWith(s: ByteArray, p: ByteArray): Boolean { if (p.size > s.size) return false; for (k in p.indices) if (s[k] != p[k]) return false; return true }
  private val pfxBytes by lazy { ChatyyCbinDict.PFX.map { it.toByteArray(Charsets.UTF_8) } }

  private const val B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  private const val B64U = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
  private fun b64enc(b: ByteArray, a: Int, e: Int, alpha: String, pad: Boolean): ByteArray {
    val o = ByteArrayOutputStream(((e - a) + 2) / 3 * 4); var i = a
    while (i + 2 < e) { val v = ((b[i].toInt() and 0xff) shl 16) or ((b[i + 1].toInt() and 0xff) shl 8) or (b[i + 2].toInt() and 0xff); o.write(alpha[v shr 18].code); o.write(alpha[(v shr 12) and 63].code); o.write(alpha[(v shr 6) and 63].code); o.write(alpha[v and 63].code); i += 3 }
    val r = e - i
    if (r == 1) { val v = (b[i].toInt() and 0xff) shl 16; o.write(alpha[v shr 18].code); o.write(alpha[(v shr 12) and 63].code); if (pad) { o.write('='.code); o.write('='.code) } }
    else if (r == 2) { val v = ((b[i].toInt() and 0xff) shl 16) or ((b[i + 1].toInt() and 0xff) shl 8); o.write(alpha[v shr 18].code); o.write(alpha[(v shr 12) and 63].code); o.write(alpha[(v shr 6) and 63].code); if (pad) o.write('='.code) }
    return o.toByteArray()
  }
  /** sem '=' ; null se char fora do alfabeto */
  private fun b64dec(s: ByteArray, n: Int, alpha: String): ByteArray? {
    val o = ByteArrayOutputStream(n * 3 / 4); var acc = 0; var bits = 0
    for (k in 0 until n) { val v = alpha.indexOf((s[k].toInt() and 0xff).toChar()); if (v < 0) return null; acc = (acc shl 6) or v; bits += 6; if (bits >= 8) { bits -= 8; o.write((acc shr bits) and 0xff) }; acc = acc and ((1 shl bits) - 1) }
    return o.toByteArray()
  }

  private fun encStr(o: Out, s: ByteArray, depth: Int) {
    val str = String(s, Charsets.UTF_8)
    valIdx[str]?.let { vi -> if (vi < 128) o.byte(T_VALINL + vi) else { o.byte(T_VAL); o.uvar(vi.toLong()) }; return }
    val n = s.size
    if (n in 2..20 && isDecCanon(s)) { o.byte(T_DEC); o.uvar(java.lang.Long.parseUnsignedLong(str)); return }
    if (n in 19..35 && s[4] == '-'.code.toByte()) { val t = encTime(s); if (t != null) { o.o.write(t); return } }
    if (n >= 3) {
      var at = -1; for (k in n - 1 downTo 0) if (s[k] == '@'.code.toByte()) { at = k; break }
      if (at > 0) { val di = domIdx[String(s, at + 1, n - at - 1, Charsets.UTF_8)]; if (di != null) { o.byte(T_EMAIL); o.str(s.copyOfRange(0, at)); o.uvar(di.toLong()); return } }
    }
    if (n >= 8 && (s[0] == 'h'.code.toByte() || s[0] == '/'.code.toByte())) {
      var best = -1; var bl = 0
      pfxBytes.forEachIndexed { i, p -> if (p.size > bl && startsWith(s, p)) { best = i; bl = p.size } }
      if (best >= 0) { o.byte(T_PFX); o.uvar(best.toLong()); o.str(s.copyOfRange(bl, n)); return }
    }
    if (n == 36 && isUUID(s)) { o.byte(T_UUID); val h = ByteArrayOutputStream(); for (r in arrayOf(0 to 8, 9 to 13, 14 to 18, 19 to 23, 24 to 36)) h.write(hexBytes(s, r.first, r.second)); o.o.write(h.toByteArray()); return }
    if (n >= 8 && n % 2 == 0 && isLowerHex(s)) { o.byte(T_HEX); o.uvar((n / 2).toLong()); o.o.write(hexBytes(s, 0, n)); return }
    if (n >= 8 && (s[0] == '{'.code.toByte() || s[0] == '['.code.toByte()) && depth < 8) {
      try {
        val p = Parser(s); p.all()
        if (p.nd.k[0] == K_OBJ || p.nd.k[0] == K_ARR) {
          val c = ByteArrayOutputStream(n); canonical(c, s, p.nd, 0)
          if (c.toByteArray().contentEquals(s)) {
            val sub = Out(); sub.byte(T_JSONSTR); encValue(sub, s, p.nd, 0, depth + 1)
            o.o.write(sub.o.toByteArray()); return
          }
        }
      } catch (_: Bad) {}
    }
    if (n >= 12) {
      var ascii = true; for (b in s) if (b < 0) { ascii = false; break }
      if (ascii) {
        if (n % 4 == 0) {
          var m = n; while (m > 0 && s[m - 1] == '='.code.toByte() && n - m < 2) m--
          val raw = b64dec(s, m, B64)
          if (raw != null && b64enc(raw, 0, raw.size, B64, true).contentEquals(s)) { o.byte(T_B64); o.str(raw); return }
        }
        if (n % 4 != 0 && n % 4 != 1 && n >= 16 && s[n - 1] != '='.code.toByte()) {
          val raw = b64dec(s, n, B64)
          if (raw != null && b64enc(raw, 0, raw.size, B64, false).contentEquals(s)) { o.byte(T_B64RAW); o.str(raw); return }
        }
        if (n % 4 != 1 && n >= 16) {
          val raw = b64dec(s, n, B64U)
          if (raw != null && b64enc(raw, 0, raw.size, B64U, false).contentEquals(s)) { o.byte(T_B64URL); o.str(raw); return }
        }
      }
    }
    if (n < 32) { o.byte(T_SHORT + n); o.o.write(s) } else { o.byte(T_STR); o.str(s) }
  }

  // ── datas ──
  private fun daysFromCivil(y0: Int, m: Int, d: Int): Long { val y = if (m <= 2) y0 - 1 else y0; val era = Math.floorDiv(y, 400); val yoe = y - era * 400; val mp = (m + 9) % 12; val doy = (153 * mp + 2) / 5 + d - 1; val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; return era.toLong() * 146097 + doe - 719468 }
  private fun civilFromDays(z0: Long): IntArray { val z = z0 + 719468; val era = Math.floorDiv(z, 146097L); val doe = z - era * 146097; val yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; var y = yoe + era * 400; val doy = doe - (365 * yoe + yoe / 4 - yoe / 100); val mp = (5 * doy + 2) / 153; val d = doy - (153 * mp + 2) / 5 + 1; var m = mp + 3; if (m > 12) m -= 12; if (m <= 2) y++; return intArrayOf(y.toInt(), m.toInt(), d.toInt()) }
  private fun d2(s: ByteArray, i: Int): Int { val a = s[i] - '0'.code.toByte(); val b = s[i + 1] - '0'.code.toByte(); return if (a in 0..9 && b in 0..9) a * 10 + b else -1 }
  private fun zz(v: Long): Long = (v shl 1) xor (v shr 63)
  private fun unzz(u: Long): Long = (u ushr 1) xor -(u and 1)

  private fun encTime(s: ByteArray): ByteArray? {
    if (s[4] != '-'.code.toByte() || s[7] != '-'.code.toByte() || (s[10] != 'T'.code.toByte() && s[10] != ' '.code.toByte()) || s[13] != ':'.code.toByte() || s[16] != ':'.code.toByte()) return null
    val y1 = d2(s, 0); val y2 = d2(s, 2); val mo = d2(s, 5); val dd = d2(s, 8); val hh = d2(s, 11); val mi = d2(s, 14); val ss = d2(s, 17)
    if (y1 < 0 || y2 < 0 || mo < 0 || dd < 0 || hh < 0 || mi < 0 || ss < 0) return null
    val y = y1 * 100 + y2
    if (y < 1970 || mo < 1 || mo > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59 || ss > 59) return null
    var i = 19; var fd = 0; var frac = 0L
    if (i < s.size && s[i] == '.'.code.toByte()) { i++; while (i < s.size && s[i] >= '0'.code.toByte() && s[i] <= '9'.code.toByte() && fd < 10) { frac = frac * 10 + (s[i] - '0'.code.toByte()); fd++; i++ }; if (fd == 0 || fd > 9) return null }
    var zk = 0; var zmin = 0
    if (i < s.size) {
      when (s[i].toInt().toChar()) {
        'Z' -> { zk = 1; i++ }
        '+', '-' -> {
          if (s.size - i < 3) return null
          val zh = d2(s, i + 1); if (zh < 0) return null
          val sign = if (s[i] == '-'.code.toByte()) -1 else 1
          if (s.size - i == 3) { zk = 2; zmin = sign * zh * 60; i += 3 }
          else if (s.size - i == 6 && s[i + 3] == ':'.code.toByte()) { val zm = d2(s, i + 4); if (zm < 0 || zm > 59) return null; zk = 3; zmin = sign * (zh * 60 + zm); i += 6 }
          else return null
        }
        else -> return null
      }
    }
    if (i != s.size) return null
    val days = daysFromCivil(y, mo, dd); val c = civilFromDays(days)
    if (c[0] != y || c[1] != mo || c[2] != dd) return null
    val secs = days * 86400 + hh * 3600 + mi * 60 + ss
    var desc = (fd shl 1) or (zk shl 5); if (s[10] == 'T'.code.toByte()) desc = desc or 1
    val o = Out(); o.byte(T_TIME); o.uvar(secs); o.byte(desc); if (fd > 0) o.uvar(frac); if (zk >= 2) o.uvar(zz(zmin.toLong()))
    val enc = o.o.toByteArray()
    val back = try { decTime(Rd(enc, 1)) } catch (_: Bad) { null }
    return if (back != null && back.contentEquals(s)) enc else null
  }

  private fun p2(o: ByteArrayOutputStream, v: Int) { o.write('0'.code + v / 10); o.write('0'.code + v % 10) }

  private fun decTime(r: Rd): ByteArray {
    val secs = r.uvar(); if (secs < 0 || secs > 253402300799L) bad()
    val desc = r.u8(); val fd = (desc shr 1) and 15; val zk = (desc shr 5) and 3
    if (fd > 9 || desc and 0x80 != 0) bad()
    val frac = if (fd > 0) r.uvar() else 0L
    var zmin = 0L
    if (zk >= 2) { zmin = unzz(r.uvar()); if (zmin <= -6000 || zmin >= 6000 || (zk == 2 && zmin % 60 != 0L)) bad() }
    val days = secs / 86400; val rem = (secs % 86400).toInt(); val c = civilFromDays(days)
    val o = ByteArrayOutputStream(40)
    val y = c[0]; o.write('0'.code + y / 1000); o.write('0'.code + y / 100 % 10); o.write('0'.code + y / 10 % 10); o.write('0'.code + y % 10); o.write('-'.code)
    p2(o, c[1]); o.write('-'.code); p2(o, c[2]); o.write(if (desc and 1 != 0) 'T'.code else ' '.code)
    p2(o, rem / 3600); o.write(':'.code); p2(o, rem / 60 % 60); o.write(':'.code); p2(o, rem % 60)
    if (fd > 0) { if (frac < 0) bad(); val f = frac.toString(); if (f.length > fd) bad(); o.write('.'.code); repeat(fd - f.length) { o.write('0'.code) }; o.write(f.toByteArray()) }
    when (zk) { 1 -> o.write('Z'.code); 2, 3 -> { var z = zmin; if (z < 0) { o.write('-'.code); z = -z } else o.write('+'.code); p2(o, (z / 60).toInt()); if (zk == 3) { o.write(':'.code); p2(o, (z % 60).toInt()) } } }
    return o.toByteArray()
  }

  /** JSON (texto) → cbin. null = mande o JSON. */
  @JvmStatic fun encode(json: String): ByteArray? {
    val src = json.toByteArray(Charsets.UTF_8)
    if (src.size > MAX_FRAME) return null
    return try {
      val p = Parser(src); p.all()
      val nd = p.nd; val o = Out()
      var done = false
      if (nd.k[0] == K_OBJ) {
        var j = 1; var typeAt = -1; var ti = 0
        for (c in 0 until nd.n[0]) {
          val kb = strBytes(src, nd, j)
          if (typeAt < 0 && kb.size == 4 && String(kb, Charsets.UTF_8) == "type" && nd.k[j + 1] == K_STR) {
            typeIdx[String(strBytes(src, nd, j + 1), Charsets.UTF_8)]?.let { typeAt = j; ti = it }
          }
          j += 1 + nd.size[j + 1]
        }
        if (typeAt >= 0) {
          o.uvar((ti + 1).toLong()); j = 1
          for (c in 0 until nd.n[0]) { val next = j + 1 + nd.size[j + 1]; if (j != typeAt) { encKey(o, src, nd, j); encValue(o, src, nd, j + 1, 0) }; j = next }
          done = true
        }
      }
      if (!done) { o.byte(0); encValue(o, src, nd, 0, 0) }
      o.o.toByteArray()
    } catch (_: Bad) { null } catch (_: NumberFormatException) { null } catch (_: IndexOutOfBoundsException) { null }
  }

  private class Rd(val b: ByteArray, var p: Int = 0) {
    fun u8(): Int { if (p >= b.size) bad(); return b[p++].toInt() and 0xff }
    fun uvar(): Long { var x = 0L; var s = 0; var i = 0; while (true) { if (p >= b.size || i >= 10) bad(); val c = b[p++].toInt() and 0xff; if (i == 9 && c > 1) bad(); x = x or ((c and 0x7f).toLong() shl s); s += 7; i++; if (c and 0x80 == 0) return x } }
    fun len(): Int { val n = uvar(); if (n < 0 || n > (b.size - p).toLong()) bad(); return n.toInt() }
    fun raw(): ByteArray { val n = len(); val r = b.copyOfRange(p, p + n); p += n; return r }
    fun str(): ByteArray { val r = raw(); if (!validUtf8(r, 0, r.size)) bad(); return r }
  }

  private fun decKey(r: Rd, o: ByteArrayOutputStream) {
    val k = r.uvar()
    if (k == 0L) { appendJSONString(o, r.str()); return }
    if (k < 0 || k > ChatyyCbinDict.KEYS.size) bad()
    appendJSONString(o, ChatyyCbinDict.KEYS[(k - 1).toInt()].toByteArray(Charsets.UTF_8))
  }

  private fun ustr(u: Long): String = java.lang.Long.toUnsignedString(u)

  private fun decValue(r: Rd, o: ByteArrayOutputStream, depth: Int) {
    if (depth > MAX_DEPTH + 8) bad()
    val t = r.u8()
    when {
      t >= T_VALINL -> { val i = t - T_VALINL; if (i >= ChatyyCbinDict.VALS.size) bad(); appendJSONString(o, ChatyyCbinDict.VALS[i].toByteArray(Charsets.UTF_8)); return }
      t >= T_SMALL -> { o.write((t - T_SMALL).toString().toByteArray()); return }
      t >= T_SHORT -> { val n = t - T_SHORT; if (n > r.b.size - r.p) bad(); val s = r.b.copyOfRange(r.p, r.p + n); r.p += n; if (!validUtf8(s, 0, n)) bad(); appendJSONString(o, s); return }
    }
    when (t) {
      T_NULL -> o.write("null".toByteArray())
      T_FALSE -> o.write("false".toByteArray())
      T_TRUE -> o.write("true".toByteArray())
      T_UINT -> { val u = r.uvar(); if (u in 0..63) bad(); o.write(ustr(u).toByteArray()) }
      T_NEG -> { val u = r.uvar(); if (u == -1L) bad(); o.write('-'.code); o.write(ustr(u + 1).toByteArray()) }
      T_NUMLIT -> { val s = r.raw(); try { val p = Parser(s); p.i = 0; p.num(); if (p.i != s.size) bad() } catch (_: IndexOutOfBoundsException) { bad() }; o.write(s) }
      T_STR -> appendJSONString(o, r.str())
      T_VAL -> { val i = r.uvar(); if (i < 0 || i >= ChatyyCbinDict.VALS.size) bad(); appendJSONString(o, ChatyyCbinDict.VALS[i.toInt()].toByteArray(Charsets.UTF_8)) }
      T_DEC -> { o.write('"'.code); o.write(ustr(r.uvar()).toByteArray()); o.write('"'.code) }
      T_B64, T_B64URL, T_B64RAW, T_HEX -> {
        val s = r.raw(); o.write('"'.code)
        when (t) {
          T_B64 -> o.write(b64enc(s, 0, s.size, B64, true))
          T_B64URL -> o.write(b64enc(s, 0, s.size, B64U, false))
          T_B64RAW -> o.write(b64enc(s, 0, s.size, B64, false))
          else -> for (b in s) { o.write(HEXD[(b.toInt() and 0xff) shr 4].code); o.write(HEXD[b.toInt() and 15].code) }
        }
        o.write('"'.code)
      }
      T_UUID -> {
        if (r.b.size - r.p < 16) bad(); o.write('"'.code)
        for (k in 0 until 16) { if (k == 4 || k == 6 || k == 8 || k == 10) o.write('-'.code); val b = r.b[r.p + k].toInt() and 0xff; o.write(HEXD[b shr 4].code); o.write(HEXD[b and 15].code) }
        r.p += 16; o.write('"'.code)
      }
      T_ARR -> { val n = r.uvar(); if (n < 0 || n > (r.b.size - r.p).toLong()) bad(); o.write('['.code); for (i in 0 until n.toInt()) { if (i > 0) o.write(','.code); decValue(r, o, depth + 1) }; o.write(']'.code) }
      T_OBJ -> { val n = r.uvar(); if (n < 0 || n > ((r.b.size - r.p) / 2).toLong()) bad(); o.write('{'.code); for (i in 0 until n.toInt()) { if (i > 0) o.write(','.code); decKey(r, o); o.write(':'.code); decValue(r, o, depth + 1) }; o.write('}'.code) }
      T_EMAIL -> { val loc = r.str(); val di = r.uvar(); if (di < 0 || di >= ChatyyCbinDict.DOMS.size) bad(); val s = ByteArrayOutputStream(); s.write(loc); s.write('@'.code); s.write(ChatyyCbinDict.DOMS[di.toInt()].toByteArray(Charsets.UTF_8)); appendJSONString(o, s.toByteArray()) }
      T_PFX -> { val pi = r.uvar(); val rest = r.str(); if (pi < 0 || pi >= pfxBytes.size) bad(); val s = ByteArrayOutputStream(); s.write(pfxBytes[pi.toInt()]); s.write(rest); appendJSONString(o, s.toByteArray()) }
      T_JSONSTR -> { val sub = ByteArrayOutputStream(); decValue(r, sub, depth + 1); appendJSONString(o, sub.toByteArray()) }
      T_TIME -> appendJSONString(o, decTime(r))
      else -> bad()
    }
  }

  /** cbin → JSON canônico (texto). null = frame inválido. */
  @JvmStatic fun decode(b: ByteArray): String? {
    if (b.isEmpty() || b.size > MAX_FRAME) return null
    return try {
      val r = Rd(b); val o = ByteArrayOutputStream(b.size * 3)
      val t = r.uvar()
      if (t == 0L) decValue(r, o, 0)
      else {
        if (t < 0 || t > ChatyyCbinDict.TYPES.size) bad()
        o.write("{\"type\":".toByteArray()); appendJSONString(o, ChatyyCbinDict.TYPES[(t - 1).toInt()].toByteArray(Charsets.UTF_8))
        while (r.p < b.size) { o.write(','.code); decKey(r, o); o.write(':'.code); decValue(r, o, 1) }
        o.write('}'.code)
      }
      if (r.p != b.size) bad()
      String(o.toByteArray(), Charsets.UTF_8)
    } catch (_: Bad) { null } catch (_: IndexOutOfBoundsException) { null } catch (_: NumberFormatException) { null }
  }

  /** frames que NUNCA vão em cbin (auth*, cbin_*) — mesma regra do servidor (cbinJSONOnly). */
  @JvmStatic fun jsonOnly(text: String): Boolean = text.contains("\"auth_") || text.contains("\"cbin_") || text.contains("\"type\":\"auth\"")

  @JvmStatic fun helloFrame(): String = "{\"type\":\"cbin_hello\",\"v\":[$VERSION],\"dh\":\"$DICT_HASH\"}"
}
