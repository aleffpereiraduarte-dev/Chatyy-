package expo.modules.chatyyconversationlist

// [2026-10-15 native-apps] Modelos do CALENDÁRIO nativo (ChatyyCalendarView):
// visão mês + agenda do dia (app/calendar.js via components/native/
// NativeCalendarView.js). Mesmo contrato do iOS (ios/CAModels.swift).
// Linhas PLANAS da agenda (patches por id via createPatcher):
//   cabeçalho do dia → { id, k: 'h', t, sb, top? }
//   evento           → { id, k: 'e', t, tm, rel, loc, rr, mt, jn, cal, ac, cc, sy, rm, sw }
//   vazio            → { id, k: 'n', t, sb, b }
// Marcadores do mês (prop `marks`): { "YYYY-MM-DD": { c: [ARGB ≤3], n, lv, st: [{ c, f, l }] } }

import android.graphics.Color
import java.util.Calendar
import java.util.Locale

internal data class CARow(
  val id: String = "",
  val kind: String = "e",
  val title: String = "",
  val sub: String = "",
  val top: Boolean = false,
  val time: String = "",
  val rel: String = "",
  val location: String = "",
  val recurrence: String = "",
  val meeting: String = "",
  val join: String = "",
  val calendar: String = "",
  val accent: Int? = null,
  val calColor: Int? = null,
  val synced: Boolean = false,
  val reminder: Boolean = false,
  val swipe: Boolean = false,
  val button: String = ""
) {
  companion object {
    fun from(m: Map<String, Any?>): CARow = CARow(
      id = CLVal.str(m["id"]),
      kind = CLVal.str(m["k"]).ifEmpty { "e" },
      title = CLVal.str(m["t"]),
      sub = CLVal.str(m["sb"]),
      top = CLVal.bool(m["top"]),
      time = CLVal.str(m["tm"]),
      rel = CLVal.str(m["rel"]),
      location = CLVal.str(m["loc"]),
      recurrence = CLVal.str(m["rr"]),
      meeting = CLVal.str(m["mt"]),
      join = CLVal.str(m["jn"]),
      calendar = CLVal.str(m["cal"]),
      accent = CTColor.of(m["ac"]),
      calColor = CTColor.of(m["cc"]),
      synced = CLVal.bool(m["sy"]),
      reminder = CLVal.bool(m["rm"]),
      swipe = CLVal.bool(m["sw"]),
      button = CLVal.str(m["b"])
    )
  }
}

internal data class CAStripe(val color: Int, val first: Boolean, val last: Boolean)

internal class CAMark(v: Any?) {
  val dots = ArrayList<Int>()
  var count = 0
  var live = false
  val stripes = ArrayList<CAStripe>()

  init {
    if (v is Number) {
      count = maxOf(0, v.toInt())
    } else {
      val m = CLVal.map(v)
      if (m != null) {
        CLVal.list(m["c"])?.take(3)?.forEach { c -> CTColor.of(c)?.let { dots.add(it) } }
        count = if (m["n"] == null) dots.size else maxOf(0, CLVal.int(m["n"]))
        live = CLVal.bool(m["lv"])
        CLVal.list(m["st"])?.take(2)?.forEach { s ->
          val sm = CLVal.map(s) ?: return@forEach
          val col = CTColor.of(sm["c"]) ?: return@forEach
          stripes.add(CAStripe(col, CLVal.bool(sm["f"]), CLVal.bool(sm["l"])))
        }
      }
    }
  }
}

/** Cores da tela (+ superfície do cartão e fundo do dia selecionado). */
internal class CAStyle(m: Map<String, Any?>? = null) {
  val colors = CTColors(m)
  val card: Int = CTColor.of(m?.get("card")) ?: if (colors.dark) Color.parseColor("#111111") else Color.WHITE
  val selBg: Int = CTColor.of(m?.get("chipBg")) ?: if (colors.dark) Color.parseColor("#1C1C1E") else Color.parseColor("#F0F1F3")
}

internal class CALabels(m: Map<String, Any?>? = null) {
  val edit: String = CLVal.str(m?.get("edit")).ifEmpty { "Editar" }
  val delete: String = CLVal.str(m?.get("delete")).ifEmpty { "Apagar" }
  val months: List<String> = CLVal.list(m?.get("months"))?.map { CLVal.str(it) } ?: emptyList()
  val hint: String = CLVal.str(m?.get("hint"))

  fun month(i: Int): String = months.getOrNull(i) ?: (i + 1).toString()
}

internal data class CACell(val day: Int, val key: String, val current: Boolean, val year: Int, val month: Int)

internal object CAGrid {
  private fun norm(y: Int, m: Int): Pair<Int, Int> {
    var yy = y
    var mm = m
    while (mm < 0) { mm += 12; yy -= 1 }
    while (mm > 11) { mm -= 12; yy += 1 }
    return yy to mm
  }

  fun key(y: Int, m: Int, d: Int): String {
    val (yy, mm) = norm(y, m)
    return String.format(Locale.US, "%04d-%02d-%02d", yy, mm + 1, d)
  }

  fun daysIn(y: Int, m: Int): Int {
    val (yy, mm) = norm(y, m)
    val c = Calendar.getInstance()
    c.clear()
    c.set(yy, mm, 1)
    return c.getActualMaximum(Calendar.DAY_OF_MONTH)
  }

  /** Dia da semana do dia 1 (0 = domingo). */
  fun firstWeekday(y: Int, m: Int): Int {
    val c = Calendar.getInstance()
    c.clear()
    c.set(y, m, 1)
    return c.get(Calendar.DAY_OF_WEEK) - 1
  }

  /** 5 ou 6 semanas (como o CalendarGrid JS), começando em `firstWeekday`. */
  fun cells(year: Int, month: Int, firstWeekday: Int): List<CACell> {
    val fw = ((firstWeekday % 7) + 7) % 7
    val lead = ((firstWeekday(year, month) - fw) % 7 + 7) % 7
    val days = daysIn(year, month)
    val prevDays = daysIn(year, month - 1)
    val weeks = maxOf(5, Math.ceil((lead + days) / 7.0).toInt())
    val (py, pm) = norm(year, month - 1)
    val (ny, nm) = norm(year, month + 1)
    val out = ArrayList<CACell>(weeks * 7)
    for (i in 0 until weeks * 7) {
      if (i < lead) {
        val d = prevDays - lead + i + 1
        out.add(CACell(d, key(py, pm, d), false, py, pm))
      } else if (i - lead < days) {
        val d = i - lead + 1
        out.add(CACell(d, key(year, month, d), true, year, month))
      } else {
        val d = i - lead - days + 1
        out.add(CACell(d, key(ny, nm, d), false, ny, nm))
      }
    }
    return out
  }
}
