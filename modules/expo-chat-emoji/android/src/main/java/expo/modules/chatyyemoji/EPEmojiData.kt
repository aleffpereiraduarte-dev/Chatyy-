package expo.modules.chatyyemoji

import android.content.Context
import android.graphics.Paint
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * [2026-10-15 native-emoji] Dados de emoji (res/raw/chatyy_emoji_data.txt):
 *   cat \t emoji \t tone(0|1) \t ver*10 \t nome-em-inglês
 * cat 0..7 = smileys&people, animals, food, activity, travel, objects, symbols, flags.
 * Carregado UMA vez por processo numa thread de fundo (parse + Paint.hasGlyph
 * p/ esconder o que a fonte do aparelho não desenha).
 */
internal class EPEmoji(val cat: Int, val emoji: String, val tone: Boolean, val name: String) {
  val words: List<String> = name.lowercase().split(' ', '-', ':', ',', '.').filter { it.isNotEmpty() }
}

internal object EPEmojiData {
  const val CATEGORY_COUNT = 8
  private const val TAG = "ChatyyEmojiPanel"
  private val TONES = intArrayOf(0x1F3FB, 0x1F3FC, 0x1F3FD, 0x1F3FE, 0x1F3FF)

  @Volatile var all: List<EPEmoji>? = null
    private set
  private var byCat: List<List<EPEmoji>> = emptyList()
  private val waiters = mutableListOf<() -> Unit>()
  private var loading = false
  private val main = Handler(Looper.getMainLooper())
  private val exec = Executors.newSingleThreadExecutor()

  fun category(i: Int): List<EPEmoji> = byCat.getOrNull(i) ?: emptyList()

  /** cb sempre na main. */
  fun load(context: Context, cb: () -> Unit) {
    if (all != null) { cb(); return }
    waiters.add(cb)
    if (loading) return
    loading = true
    val app = context.applicationContext
    exec.execute {
      val list = ArrayList<EPEmoji>(2000)
      try {
        val paint = Paint()
        app.resources.openRawResource(R.raw.chatyy_emoji_data).bufferedReader(Charsets.UTF_8).useLines { lines ->
          for (line in lines) {
            if (line.isEmpty()) continue
            val p = line.split('\t')
            if (p.size < 5) continue
            val cat = p[0].toIntOrNull() ?: continue
            val e = p[1]
            val ok = try { paint.hasGlyph(e) } catch (_: Throwable) { true }
            if (!ok) continue
            list.add(EPEmoji(cat, e, p[2] == "1", p[4]))
          }
        }
      } catch (t: Throwable) {
        Log.w(TAG, "emoji data: ${t.message}")
      }
      val cats = (0 until CATEGORY_COUNT).map { c -> list.filter { it.cat == c } }
      main.post {
        all = list
        byCat = cats
        loading = false
        val ws = waiters.toList()
        waiters.clear()
        for (w in ws) try { w() } catch (_: Throwable) {}
      }
    }
  }

  /** Variante com tom: tira FE0F logo após o 1º code point e insere o modificador ali. */
  fun toneVariant(base: String, toneIndex: Int): String {
    if (toneIndex !in 0..4) return base
    val cps = base.codePoints().toArray().toMutableList()
    if (cps.isEmpty()) return base
    if (cps.size > 1 && cps[1] == 0xFE0F) cps.removeAt(1)
    cps.add(1, TONES[toneIndex])
    val sb = StringBuilder()
    for (c in cps) sb.appendCodePoint(c)
    return sb.toString()
  }

  fun variants(base: String): List<String> = listOf(base) + (0..4).map { toneVariant(base, it) }

  fun search(q: String, limit: Int = 300): List<EPEmoji> {
    val src = all ?: return emptyList()
    val query = q.trim().lowercase()
    if (query.isEmpty()) return emptyList()
    val tokens = query.split(' ').filter { it.isNotEmpty() }
    val out = ArrayList<EPEmoji>()
    for (e in src) {
      val n = e.name.lowercase()
      val match = n.contains(query) || tokens.all { t -> e.words.any { it.startsWith(t) } }
      if (match) { out.add(e); if (out.size >= limit) break }
    }
    return out
  }
}

/** Recentes + tom preferido (SharedPreferences "chatyy_emoji_panel"). */
internal class EPPrefs(context: Context) {
  private val sp = context.applicationContext.getSharedPreferences("chatyy_emoji_panel", Context.MODE_PRIVATE)
  private val maxRecents = 32

  var recents: MutableList<String> = load()
    private set
  private val tones: MutableMap<String, String> = loadTones()

  private fun load(): MutableList<String> {
    return try {
      val a = JSONArray(sp.getString("recents", "[]") ?: "[]")
      MutableList(a.length()) { a.optString(it) }.filter { it.isNotEmpty() }.toMutableList()
    } catch (_: Throwable) { mutableListOf() }
  }

  private fun loadTones(): MutableMap<String, String> {
    return try {
      val o = JSONObject(sp.getString("tones", "{}") ?: "{}")
      val m = mutableMapOf<String, String>()
      val it = o.keys()
      while (it.hasNext()) { val k = it.next(); m[k] = o.optString(k) }
      m
    } catch (_: Throwable) { mutableMapOf() }
  }

  fun preferred(base: String): String = tones[base] ?: base

  fun setPreferred(base: String, variant: String) {
    if (variant == base) tones.remove(base) else tones[base] = variant
    try { sp.edit().putString("tones", JSONObject(tones as Map<*, *>).toString()).apply() } catch (_: Throwable) {}
  }

  fun pushRecent(emoji: String) {
    recents.remove(emoji)
    recents.add(0, emoji)
    while (recents.size > maxRecents) recents.removeAt(recents.size - 1)
    try { sp.edit().putString("recents", JSONArray(recents).toString()).apply() } catch (_: Throwable) {}
  }
}
