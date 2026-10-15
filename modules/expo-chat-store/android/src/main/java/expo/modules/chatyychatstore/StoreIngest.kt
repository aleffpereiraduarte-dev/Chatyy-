package expo.modules.chatyychatstore

import org.json.JSONArray
import org.json.JSONObject
import java.util.Calendar

/**
 * [2026-10-15 native-store fase 2b] Frames do hub → lote do store, SEM JS.
 *
 * Código PURO (só org.json + java.util): roda igual no Android e na JVM (teste
 * local com os frames reais do hub). Espelho: ChatyyStoreIngest.swift.
 *
 * Frames tratados (formato real capturado do hub Go, 2026-10-15):
 *   chat_message / chat_summary / edit / delete / reaction
 *       {type, data: <linha completa da mensagem>}   (data.message em alguns hubs)
 *   chat_read       {type, data: {conversation_id, email, last_read_id}}
 *   chat_delivered  {type, data: {conversation_id, email, delivered_at, message_ids[]}}
 *
 * Saída = lote no formato do applyBatch (messages/receipts/reactions) + chaves
 * internas do 2b: peer_reads, self_reads, delivs, conv_types, touch.
 */
object StoreIngest {
  private val NEEDLES = arrayOf(
    "\"type\":\"chat_message\"", "\"type\":\"chat_summary\"", "\"type\":\"edit\"", "\"type\":\"delete\"",
    "\"type\":\"reaction\"", "\"type\":\"chat_read\"", "\"type\":\"chat_delivered\"",
  )
  private val MSG_TYPES = setOf("chat_message", "chat_summary", "edit", "delete", "reaction")

  /** Pré-filtro barato no texto cru (sem parse). */
  fun wants(text: String): Boolean {
    if (text.length < 24) return false
    for (n in NEEDLES) if (text.contains(n)) return true
    return false
  }

  fun str(v: Any?): String = when (v) {
    null, JSONObject.NULL -> ""
    is String -> v
    is Double, is Float -> { val d = (v as Number).toDouble(); if (d == Math.floor(d) && !d.isInfinite()) d.toLong().toString() else d.toString() }
    is Number -> v.toString()
    else -> v.toString()
  }

  fun lng(v: Any?): Long = when (v) {
    is Number -> v.toLong()
    is String -> v.toLongOrNull() ?: (v.toDoubleOrNull()?.toLong() ?: 0L)
    is Boolean -> if (v) 1L else 0L
    else -> 0L
  }

  private fun truthy(v: Any?): Boolean = when (v) {
    null, JSONObject.NULL -> false
    is Boolean -> v
    is Number -> v.toDouble() != 0.0
    is String -> v.isNotEmpty() && v != "0" && v != "false" && v != "[]" && v != "null"
    is JSONArray -> v.length() > 0
    is JSONObject -> v.length() > 0
    else -> true
  }

  private val ISO = Regex("^(\\d{4})-(\\d{2})-(\\d{2})[T ](\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d+))?)?\\s*(Z|[+-]\\d{2}(?::?\\d{2})?)?$")

  /** Data do servidor → epoch ms (mesma regra do _ms do JS: sem fuso = UTC). 0 = inválida. */
  fun ms(v: Any?): Long {
    when (v) {
      null, JSONObject.NULL -> return 0L
      is Number -> { val d = v.toDouble(); return if (d > 1e12) d.toLong() else (d * 1000).toLong() }
    }
    val s = str(v).trim()
    if (s.isEmpty()) return 0L
    val m = ISO.matchEntire(s) ?: return 0L
    val g = m.groupValues
    val y = g[1].toLong(); val mo = g[2].toLong(); val d = g[3].toLong()
    val hh = g[4].toLong(); val mi = g[5].toLong(); val ss = if (g[6].isEmpty()) 0L else g[6].toLong()
    val frac = if (g[7].isEmpty()) 0L else (g[7] + "00").substring(0, 3).toLong()
    var offMin = 0L
    val tz = g[8]
    if (tz.isNotEmpty() && tz != "Z") {
      val sign = if (tz[0] == '-') -1L else 1L
      val digits = tz.substring(1).replace(":", "")
      val oh = digits.substring(0, 2).toLong()
      val om = if (digits.length >= 4) digits.substring(2, 4).toLong() else 0L
      offMin = sign * (oh * 60 + om)
    }
    // dias desde 1970-01-01 (algoritmo civil de H. Hinnant)
    val yy = if (mo <= 2) y - 1 else y
    val era = (if (yy >= 0) yy else yy - 399) / 400
    val yoe = yy - era * 400
    val mp = (mo + 9) % 12
    val doy = (153 * mp + 2) / 5 + d - 1
    val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    val days = era * 146097 + doe - 719468
    return ((days * 86400 + hh * 3600 + mi * 60 + ss) - offMin * 60) * 1000 + frac
  }

  /** Mesma chave do msgKeyExtractor/defaultKeyOf do JS. */
  fun keyOf(m: JSONObject): String {
    val cl = str(m.opt("client_message_id")).ifEmpty { str(m.opt("_client_id")) }
    val del = truthy(m.opt("deleted_at"))
    if (cl.isNotEmpty()) return if (del) "c:${cl}_d" else "c:$cl"
    val id = str(m.opt("id"))
    return if (del) "${id}_d" else id
  }

  private fun msgOf(o: JSONObject): JSONObject? {
    val d = o.optJSONObject("data") ?: return null
    return d.optJSONObject("message") ?: d
  }

  /**
   * frames → lote. null = nada a gravar. `me` = conta (minúsculas).
   */
  fun translate(me: String, frames: List<String>): JSONObject? {
    val msgs = LinkedHashMap<String, JSONObject>() // "conv|id" → mensagem (última vence)
    val kinds = HashMap<String, String>()
    val peerReads = HashMap<String, JSONObject>()
    val selfReads = HashMap<String, Long>()
    val delivs = JSONArray()
    val convTypes = JSONObject()
    for (f in frames) {
      val o = try { JSONObject(f) } catch (_: Throwable) { continue }
      val type = str(o.opt("type"))
      if (type in MSG_TYPES) {
        val m = msgOf(o) ?: continue
        val conv = str(m.opt("conversation_id")).ifEmpty { str(o.optJSONObject("data")?.opt("conversation_id")) }
        val id = lng(m.opt("id"))
        if (conv.isEmpty() || id <= 0) continue
        val k = "$conv|$id"
        msgs.remove(k); msgs[k] = m
        // "new" (chegou nesta leva) vence "upd": nova + editada no mesmo lote = nova
        kinds[k] = if (type == "chat_message" || type == "chat_summary") "new" else (kinds[k] ?: "upd")
        val ct = str(m.opt("conversation_type"))
        if (ct.isNotEmpty()) convTypes.put(conv, ct)
      } else if (type == "chat_read") {
        val d = o.optJSONObject("data") ?: continue
        val conv = str(d.opt("conversation_id")); val upTo = lng(d.opt("last_read_id"))
        val email = str(d.opt("email")).trim().lowercase()
        if (conv.isEmpty() || upTo <= 0 || email.isEmpty()) continue
        if (email == me) selfReads[conv] = maxOf(selfReads[conv] ?: 0L, upTo)
        else {
          val k = "$conv|$email"
          val prev = peerReads[k]
          if (prev == null || lng(prev.opt("upTo")) < upTo) peerReads[k] = JSONObject().put("conv", conv).put("email", email).put("upTo", upTo)
        }
      } else if (type == "chat_delivered") {
        val d = o.optJSONObject("data") ?: continue
        val conv = str(d.opt("conversation_id"))
        val email = str(d.opt("email")).trim().lowercase()
        if (conv.isEmpty() || email.isEmpty() || email == me) continue
        val ids = JSONArray()
        d.optJSONArray("message_ids")?.let { a -> for (i in 0 until a.length()) { val x = lng(a.opt(i)); if (x > 0) ids.put(x) } }
        if (ids.length() == 0) { val x = lng(d.opt("message_id")); if (x > 0) ids.put(x) }
        if (ids.length() == 0) continue
        val at = ms(d.opt("delivered_at")).let { if (it > 0) it else System.currentTimeMillis() }
        delivs.put(JSONObject().put("conv", conv).put("ids", ids).put("at", at))
      }
    }
    if (msgs.isEmpty() && peerReads.isEmpty() && selfReads.isEmpty() && delivs.length() == 0) return null
    val out = JSONObject().put("v", 1).put("src", "native")
    val messages = JSONArray(); val receipts = JSONArray(); val reactions = JSONArray(); val touch = JSONArray()
    for ((k, m) in msgs) {
      val conv = k.substringBefore('|'); val id = lng(m.opt("id"))
      val cl = str(m.opt("client_message_id")).ifEmpty { str(m.opt("_client_id")) }
      messages.put(JSONObject()
        .put("conv", conv).put("id", id)
        .put("ckey", if (cl.isNotEmpty()) "c:$cl" else id.toString())
        .put("client_id", cl)
        .put("sender", str(m.opt("sender_email")).lowercase())
        .put("type", str(m.opt("type")).ifEmpty { "text" })
        .put("created_at", ms(m.opt("created_at")))
        .put("edited_at", ms(m.opt("edited_at")))
        .put("deleted", if (truthy(m.opt("deleted_at"))) 1 else 0)
        .put("reply_to", lng(m.opt("reply_to_id")))
        .put("raw", m.toString()))
      val dl = ms(m.opt("delivered_at")); val rd = ms(m.opt("read_at"))
      if (dl > 0 || rd > 0) receipts.put(JSONObject().put("conv", conv).put("msg_id", id).put("delivered_at", dl).put("read_at", rd))
      val rx = m.optJSONArray("reactions")
      if (rx != null) {
        val set = JSONArray()
        for (i in 0 until rx.length()) {
          val r = rx.optJSONObject(i) ?: continue
          val emoji = str(r.opt("emoji")).ifEmpty { str(r.opt("reaction")) }
          if (emoji.isEmpty()) continue
          val users = JSONArray()
          when (val u = r.opt("users")) {
            is JSONArray -> for (j in 0 until u.length()) { val e = str(u.opt(j)).lowercase(); if (e.isNotEmpty()) users.put(e) }
            is String -> for (e in u.split(',')) { val x = e.trim().lowercase(); if (x.isNotEmpty()) users.put(x) }
          }
          set.put(JSONObject().put("emoji", emoji).put("users", users))
        }
        reactions.put(JSONObject().put("conv", conv).put("msg_id", id).put("set", set))
      }
      touch.put(JSONObject().put("conv", conv).put("id", id).put("kind", kinds[k] ?: "upd").put("msg", m))
    }
    if (messages.length() > 0) out.put("messages", messages)
    if (receipts.length() > 0) out.put("receipts", receipts)
    if (reactions.length() > 0) out.put("reactions", reactions)
    if (touch.length() > 0) out.put("touch", touch)
    if (peerReads.isNotEmpty()) out.put("peer_reads", JSONArray().also { a -> peerReads.values.forEach { a.put(it) } })
    if (selfReads.isNotEmpty()) out.put("self_reads", JSONArray().also { a -> selfReads.forEach { (c, u) -> a.put(JSONObject().put("conv", c).put("upTo", u)) } })
    if (delivs.length() > 0) out.put("delivs", delivs)
    if (convTypes.length() > 0) out.put("conv_types", convTypes)
    return out
  }

  // ─── RowBuilder nativo SÓ p/ texto simples (flag do JS; padrão desligado) ──

  /** Perfil de formato que o JS manda por conversa (setThreadProfile). */
  class TextProfile(o: JSONObject) {
    val rev = str(o.opt("rev"))
    val me = str(o.opt("me")).lowercase()
    val group = lng(o.opt("group")) != 0L
    val h24 = lng(o.opt("h24")) != 0L
    val am = str(o.opt("am")); val pm = str(o.opt("pm")); val join = str(o.opt("join"))
    val today = str(o.opt("today"))
    val todayLabel = str(o.opt("todayLabel"))
    val gapMs = lng(o.opt("gapMs")).let { if (it > 0) it else 60000L }
    val allow: Regex? = try { Regex(str(o.opt("allow"))) } catch (_: Throwable) { null }
    val deny: Regex? = try { str(o.opt("deny")).let { if (it.isEmpty()) null else Regex(it, RegexOption.IGNORE_CASE) } } catch (_: Throwable) { null }
    val ok = rev.isNotEmpty() && me.isNotEmpty() && today.isNotEmpty() && allow != null && str(o.opt("allow")).isNotEmpty() && (h24 || (am.isNotEmpty() && pm.isNotEmpty()))
  }

  /** Última linha da foto (para agrupar). */
  class Tail(val k: String, val id: Long, val sender: String, val ts: Long, val type: String, val day: String)

  /** "AAAA-M0-D" local (mesmo formato do _dayKey do JS: mês 0-based, sem zero à esquerda). */
  fun dayKey(ts: Long): String {
    val c = Calendar.getInstance(); c.timeInMillis = ts
    return "${c.get(Calendar.YEAR)}-${c.get(Calendar.MONTH)}-${c.get(Calendar.DAY_OF_MONTH)}"
  }

  fun timeLabel(p: TextProfile, ts: Long): String {
    val c = Calendar.getInstance(); c.timeInMillis = ts
    val h = c.get(Calendar.HOUR_OF_DAY); val m = c.get(Calendar.MINUTE)
    val mm = if (m < 10) "0$m" else "$m"
    if (p.h24) return (if (h < 10) "0$h" else "$h") + ":" + mm
    val h12 = if (h % 12 == 0) 12 else h % 12
    return (if (h12 < 10) "0$h12" else "$h12") + ":" + mm + p.join + (if (h < 12) p.am else p.pm)
  }

  /** Por que NÃO montar no nativo ('' = pode). Conservador: na dúvida, não. */
  fun textReason(p: TextProfile, m: JSONObject): String {
    if (!p.ok) return "profile"
    if (p.group) return "group"
    if (str(m.opt("type")).ifEmpty { "text" } != "text") return "type"
    val ct = str(m.opt("conversation_type"))
    if (ct.isNotEmpty() && ct != "direct") return "convtype"
    for (f in arrayOf("deleted_at", "edited_at", "reply_to_id", "reply_to", "forwarded_from", "mentions", "link_preview",
      "expires_at", "effect", "topic_id", "starred", "sealed", "is_view_once", "is_poll", "file_url", "pinned", "_failed", "translation")) {
      if (truthy(m.opt(f))) return "field:$f"
    }
    if (truthy(m.opt("edited"))) return "edited"
    val rx = m.optJSONArray("reactions"); if (rx != null && rx.length() > 0) return "reactions"
    val c = str(m.opt("content")).trimEnd()
    if (c.isEmpty() || c.length > 500) return "len"
    if (p.allow?.matches(c) != true) return "allow"
    if (p.deny?.containsMatchIn(c) == true) return "deny"
    return ""
  }

  /**
   * Operações na foto p/ UMA mensagem nova de texto simples. null = não monta
   * (o chamador marca a foto como desatualizada). `tail` = última linha da foto.
   */
  fun textOps(p: TextProfile, m: JSONObject, tail: Tail, nowDay: String): JSONArray? {
    if (textReason(p, m) != "") return null
    if (p.today != nowDay) return null // perfil de outro dia (rótulo "Hoje" velho)
    val id = lng(m.opt("id")); if (id <= tail.id) return null
    val ts = ms(m.opt("created_at")); if (ts <= 0) return null
    val day = dayKey(ts)
    val sender = str(m.opt("sender_email")).lowercase()
    val own = sender == p.me
    val rows = JSONArray()
    val ops = JSONArray()
    if (day != tail.day) {
      if (day != nowDay || p.todayLabel.isEmpty()) return null // separador de outro dia: deixa p/ o JS
      rows.put(JSONObject().put("k", "sep-$day").put("kind", "date").put("text", p.todayLabel))
    }
    val grouped = day == tail.day && tail.sender.isNotEmpty() && tail.sender == sender && tail.type != "system" &&
      tail.ts > 0 && ts - tail.ts in 0..p.gapMs
    if (grouped) ops.put(JSONObject().put("op", "set").put("k", tail.k).put("set", JSONObject().put("last", 0)))
    val row = JSONObject()
      .put("k", keyOf(m)).put("kind", "msg").put("id", id.toString())
      .put("own", if (own) 1 else 0).put("first", if (grouped) 0 else 1).put("last", 1)
      .put("time", timeLabel(p, ts))
      .put("text", str(m.opt("content")).trimEnd())
    if (own) row.put("st", 1)
    rows.put(row)
    ops.put(JSONObject().put("op", "append").put("after", tail.k).put("rows", rows))
    return ops
  }
}
