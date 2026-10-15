package expo.modules.chatyyconversationlist

// [2026-10-15 native-notes] Modelos da lista de NOTAS nativa (ChatyyNotesList,
// app/notes.js via components/native/NativeNotesList.js). Mesmo contrato do
// iOS (ios/NTModels.swift). Linhas PLANAS de components/native/notesListAdapter.js:
//   seção → { id, k: 's', t }                      (t vazio = só espaço)
//   nota  → { id, k: 'n', t, p, d, c, pn, ar, tg, nb, rm, ro, rr, ph, a11y }

import android.graphics.Color

internal data class NTRow(
  val id: String = "",
  val kind: String = "n",
  val title: String = "",
  val preview: String = "",
  val date: String = "",
  val color: Int? = null,
  val pinned: Boolean = false,
  val archived: Boolean = false,
  val tags: List<String> = emptyList(),
  val notebook: String = "",
  val reminder: String = "",
  val reminderOverdue: Boolean = false,
  val reminderRepeat: Boolean = false,
  val placeholder: String = "",
  val a11y: String = ""
) {
  val isSection: Boolean get() = kind == "s"

  companion object {
    fun from(m: Map<String, Any?>): NTRow {
      val tags = CLVal.list(m["tg"])?.take(4)?.map { CLVal.str(it) }?.filter { it.isNotEmpty() } ?: emptyList()
      return NTRow(
        id = CLVal.str(m["id"]),
        kind = CLVal.str(m["k"]).ifEmpty { "n" },
        title = CLVal.str(m["t"]),
        preview = CLVal.str(m["p"]),
        date = CLVal.str(m["d"]),
        color = CTColor.of(m["c"]),
        pinned = CLVal.bool(m["pn"]),
        archived = CLVal.bool(m["ar"]),
        tags = tags,
        notebook = CLVal.str(m["nb"]),
        reminder = CLVal.str(m["rm"]),
        reminderOverdue = CLVal.bool(m["ro"]),
        reminderRepeat = CLVal.bool(m["rr"]),
        placeholder = CLVal.str(m["ph"]),
        a11y = CLVal.str(m["a11y"])
      )
    }
  }
}

/** Item do menu do toque longo (prop `menu`). */
internal class NTMenuItem(m: Map<String, Any?>) {
  val action: String = CLVal.str(m["a"])
  val title: String = CLVal.str(m["t"])
  val altTitle: String = CLVal.str(m["t2"])
  val glyph: String = CLVal.str(m["g"])
  val destructive: Boolean = CLVal.bool(m["x"])

  fun titleFor(row: NTRow): String {
    if (altTitle.isEmpty()) return title
    if (action == "pin") return if (row.pinned) altTitle else title
    if (action == "archive") return if (row.archived) altTitle else title
    return title
  }
}

internal class NTStyle(
  val colors: CTColors = CTColors(),
  val card: Int = Color.WHITE,
  val cardBorder: Int = Color.argb(10, 0, 0, 0),
  val tokens: List<String> = emptyList(),
  val grid: Boolean = false
)

/** Medidas (dp) — espelham os StyleSheets de app/notes.js e ios/NTModels.swift. */
internal object NTMetrics {
  const val outerH = 10f
  const val cellPadH = 5f
  const val cellPadV = 5f
  const val radius = 16f
  const val strip = 5f
  const val padTop = 14f
  const val padLeft = 12f
  const val padRight = 14f
  const val padBottom = 14f
  const val titleGap = 4f
  const val rowGap = 8f
  const val chipH = 20f
  const val gridHeight = 188f
  const val sectionH = 34f
  const val spacerH = 12f
}
