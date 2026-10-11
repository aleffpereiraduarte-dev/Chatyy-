package expo.modules.nativevideo

import android.util.Log
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Mp4FastStart — minimal qt-faststart in Kotlin (2026-10-11).
 *
 * MediaMuxer writes `ftyp … mdat … moov`; a player then has to download the
 * whole file before it can start. This moves `moov` right after `ftyp`, drops
 * top-level `free`/`skip` padding, and patches every `stco`/`co64` chunk
 * offset by the delta of the `mdat` box it points into.
 *
 * Contract: returns true when the file is (now) faststart, false when nothing
 * was changed. On ANY failure the original file is left untouched (the new
 * layout is written to a sibling temp file and only renamed over at the end).
 */
object Mp4FastStart {

  private const val TAG = "Mp4FastStart"
  private const val MAX_MOOV_BYTES = 64L shl 20 // sanity cap (64 MB)

  private class Atom(val type: String, val offset: Long, val size: Long)

  private val CONTAINERS = setOf("moov", "trak", "mdia", "minf", "stbl")

  fun apply(file: File): Boolean {
    if (!file.isFile || file.length() < 16) return false
    val atoms = RandomAccessFile(file, "r").use { readTopLevel(it) } ?: return false

    val moov = atoms.firstOrNull { it.type == "moov" } ?: return false
    val mdats = atoms.filter { it.type == "mdat" }
    if (mdats.isEmpty()) return false
    if (moov.offset < mdats.first().offset) return true // already faststart
    if (atoms.count { it.type == "moov" } != 1) return false
    if (moov.size > MAX_MOOV_BYTES) return false

    // New layout: [ftyp] moov [everything else except ftyp/moov/free/skip].
    val ftyp = atoms.firstOrNull { it.type == "ftyp" }
    val rest = atoms.filter { it !== ftyp && it !== moov && it.type != "free" && it.type != "skip" }
    val order = ArrayList<Atom>(rest.size + 2)
    if (ftyp != null) order.add(ftyp)
    order.add(moov)
    order.addAll(rest)

    val newOffset = HashMap<Atom, Long>()
    var cursor = 0L
    for (a in order) { newOffset[a] = cursor; cursor += a.size }

    // Load + patch moov in memory.
    val moovBytes = ByteArray(moov.size.toInt())
    RandomAccessFile(file, "r").use { raf ->
      raf.seek(moov.offset)
      raf.readFully(moovBytes)
    }
    val buf = ByteBuffer.wrap(moovBytes).order(ByteOrder.BIG_ENDIAN)
    val mdatRanges = mdats.map { Triple(it.offset, it.offset + it.size, newOffset[it]!! - it.offset) }
    if (!patchChunkOffsets(buf, 8, moovBytes.size, mdatRanges, 0)) return false

    // Write the new file next to the original, then atomically replace.
    val tmp = File(file.parentFile, file.name + ".fs.tmp")
    try {
      FileInputStream(file).channel.use { src ->
        FileOutputStream(tmp).channel.use { dst ->
          for (a in order) {
            if (a === moov) {
              val bb = ByteBuffer.wrap(moovBytes)
              while (bb.hasRemaining()) dst.write(bb)
            } else {
              var pos = a.offset
              var left = a.size
              while (left > 0) {
                val n = src.transferTo(pos, left, dst)
                if (n <= 0) throw RuntimeException("short copy")
                pos += n
                left -= n
              }
            }
          }
          dst.force(false)
        }
      }
      if (tmp.length() != cursor) throw RuntimeException("size mismatch ${tmp.length()} != $cursor")
      // Verify: moov now precedes mdat and the box chain covers the file.
      val check = RandomAccessFile(tmp, "r").use { readTopLevel(it) }
        ?: throw RuntimeException("verify: unparsable")
      val cm = check.indexOfFirst { it.type == "moov" }
      val cd = check.indexOfFirst { it.type == "mdat" }
      if (cm < 0 || cd < 0 || cm > cd) throw RuntimeException("verify: bad order")
      if (!tmp.renameTo(file)) throw RuntimeException("rename failed")
      Log.i(TAG, "faststart OK: moov ${moov.size}B moved to front, ${file.length()}B")
      return true
    } catch (t: Throwable) {
      Log.w(TAG, "faststart aborted, keeping original: ${t.message}")
      try { tmp.delete() } catch (_: Throwable) {}
      return false
    }
  }

  /** Top-level box list, or null if the chain is malformed. */
  private fun readTopLevel(raf: RandomAccessFile): List<Atom>? {
    val len = raf.length()
    val out = ArrayList<Atom>()
    var pos = 0L
    val hdr = ByteArray(16)
    while (pos < len) {
      if (len - pos < 8) return null
      raf.seek(pos)
      raf.readFully(hdr, 0, 8)
      val bb = ByteBuffer.wrap(hdr).order(ByteOrder.BIG_ENDIAN)
      var size = bb.getInt(0).toLong() and 0xFFFFFFFFL
      val type = String(hdr, 4, 4, Charsets.ISO_8859_1)
      if (size == 1L) {
        if (len - pos < 16) return null
        raf.readFully(hdr, 8, 8)
        size = bb.getLong(8)
        if (size < 16) return null
      } else if (size == 0L) {
        size = len - pos
      } else if (size < 8) {
        return null
      }
      if (pos + size > len) return null
      out.add(Atom(type, pos, size))
      pos += size
    }
    return out
  }

  /**
   * Walks boxes in [start,end) of [buf]; descends into containers and patches
   * stco/co64 entries. Returns false on malformed input / 32-bit overflow.
   */
  private fun patchChunkOffsets(
    buf: ByteBuffer, start: Int, end: Int, mdats: List<Triple<Long, Long, Long>>, depth: Int
  ): Boolean {
    if (depth > 12) return false
    var pos = start
    while (pos + 8 <= end) {
      var size = buf.getInt(pos).toLong() and 0xFFFFFFFFL
      val type = String(byteArrayOf(buf.get(pos + 4), buf.get(pos + 5), buf.get(pos + 6), buf.get(pos + 7)), Charsets.ISO_8859_1)
      var header = 8
      if (size == 1L) {
        if (pos + 16 > end) return false
        size = buf.getLong(pos + 8)
        header = 16
      } else if (size == 0L) {
        size = (end - pos).toLong()
      }
      if (size < header || pos + size > end) return false
      val boxEnd = (pos + size).toInt()
      when (type) {
        "stco", "co64" -> {
          val wide = type == "co64"
          val p = pos + header
          if (p + 8 > boxEnd) return false
          val count = buf.getInt(p + 4).toLong() and 0xFFFFFFFFL
          val entry = if (wide) 8 else 4
          if (p + 8 + count * entry > boxEnd) return false
          var e = p + 8
          for (i in 0 until count) {
            val old = if (wide) buf.getLong(e) else (buf.getInt(e).toLong() and 0xFFFFFFFFL)
            val range = mdats.firstOrNull { old >= it.first && old < it.second } ?: return false
            val nu = old + range.third
            if (nu < 0) return false
            if (wide) {
              buf.putLong(e, nu)
            } else {
              if (nu > 0xFFFFFFFFL) return false
              buf.putInt(e, nu.toInt())
            }
            e += entry
          }
        }
        else -> if (type in CONTAINERS) {
          if (!patchChunkOffsets(buf, pos + header, boxEnd, mdats, depth + 1)) return false
        }
      }
      pos = boxEnd
    }
    return true
  }
}
