package expo.modules.chatyyconversationlist

// [2026-10-15 native-pins] Menu do toque longo (PopupMenu) compartilhado entre
// a lista (ChatyyConversationListView) e a fileira de fixados
// (ChatyyPinnedStripView). Equivalente ao UIMenu do iOS (CLMenuBuilder.swift):
// ações rápidas, submenus (silenciar por…, listas, mais) e destrutivas em
// vermelho. A confirmação das destrutivas = handlers JS existentes.

import android.content.Context
import android.view.Gravity
import android.view.Menu
import android.view.View
import android.widget.PopupMenu

internal object CLMenu {
  /** Item extra logo depois de Fixar/Desafixar (ex.: "Reorganizar fixados"). */
  class Extra(val action: String, val title: String)

  /** Mostra o menu; devolve false se não deu para abrir (o chamador cai no JS). */
  fun show(
    context: Context,
    anchor: View,
    id: String,
    row: CLRow,
    L: CLLabels,
    folders: List<CLFolder>,
    afterPin: List<Extra> = emptyList(),
    emit: (Map<String, Any>) -> Unit
  ): Boolean {
    val actions = ArrayList<Map<String, Any?>>()
    fun reg(action: String, extra: Map<String, Any?> = emptyMap()): Int {
      val m = HashMap<String, Any?>(extra)
      m["id"] = id
      m["action"] = action
      m["source"] = "menu"
      actions.add(m)
      return actions.size - 1
    }
    fun red(text: String): CharSequence {
      val sp = android.text.SpannableString(text)
      sp.setSpan(android.text.style.ForegroundColorSpan(CLTheme.SWIPE_DELETE), 0, sp.length, 0)
      return sp
    }
    return try {
      val pm = PopupMenu(context, anchor, Gravity.END)
      val menu = pm.menu
      var order = 0
      menu.add(Menu.NONE, reg("toggleRead"), order++, if (row.unread > 0) L.get("markRead", "Marcar como lida") else L.get("markUnread", "Marcar como não lida"))
      menu.add(Menu.NONE, reg("pin"), order++, if (row.pinned) L.get("unpin", "Desafixar") else L.get("pin", "Fixar"))
      for (x in afterPin) menu.add(Menu.NONE, reg(x.action), order++, x.title)
      if (row.muted) {
        menu.add(Menu.NONE, reg("mute"), order++, L.get("unmute", "Reativar som"))
      } else {
        val now = System.currentTimeMillis() / 1000.0
        val sub = menu.addSubMenu(Menu.NONE, Menu.NONE, order++, L.get("mute", "Silenciar"))
        sub.add(Menu.NONE, reg("mute", mapOf("until" to Math.floor(now) + 8 * 3600)), 0, L.get("muteFor8h", "Silenciar por 8 horas"))
        sub.add(Menu.NONE, reg("mute", mapOf("until" to Math.floor(now) + 7 * 86400)), 1, L.get("muteFor1w", "Silenciar por 1 semana"))
        sub.add(Menu.NONE, reg("mute", mapOf("until" to 4070908800.0)), 2, L.get("muteForever", "Silenciar sempre"))
      }
      menu.add(Menu.NONE, reg("archive"), order++, if (row.archived) L.get("unarchive", "Desarquivar") else L.get("archive", "Arquivar"))
      menu.add(Menu.NONE, reg("lock"), order++, if (row.lockOn) L.get("unlockChat", "Destrancar conversa") else L.get("lockChat", "Trancar conversa"))
      val lists = menu.addSubMenu(Menu.NONE, Menu.NONE, order++, L.get("addToList", "Adicionar à lista"))
      folders.forEachIndexed { i, f ->
        val item = lists.add(Menu.NONE, reg("list", mapOf("folderId" to f.id)), i, f.name)
        item.isCheckable = true
        item.isChecked = f.ids.contains(id)
      }
      lists.add(Menu.NONE, reg("listNew"), folders.size, L.get("createNewList", "Criar nova lista"))
      val more = menu.addSubMenu(Menu.NONE, Menu.NONE, order++, L.get("moreMenu", "Mais"))
      more.add(Menu.NONE, reg("select"), 0, L.get("select", "Selecionar várias"))
      more.add(Menu.NONE, reg("clear"), 1, L.get("clearChat", "Limpar conversa"))
      if (row.blockLabel.isNotEmpty()) menu.add(Menu.NONE, reg("block"), order++, red(row.blockLabel))
      menu.add(Menu.NONE, reg("report"), order++, red(L.get("report", "Denunciar")))
      menu.add(Menu.NONE, reg("delete"), order++, red(L.get("delete", "Apagar")))
      pm.setOnMenuItemClickListener { mi ->
        if (mi.hasSubMenu()) return@setOnMenuItemClickListener false
        val body = actions.getOrNull(mi.itemId)
        if (body != null) emit(body.entries.mapNotNull { (k, v) -> v?.let { k to it } }.toMap())
        true
      }
      pm.show()
      true
    } catch (_: Throwable) {
      false
    }
  }
}
