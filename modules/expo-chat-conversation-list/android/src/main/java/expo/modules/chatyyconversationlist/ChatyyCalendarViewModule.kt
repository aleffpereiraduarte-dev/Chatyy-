package expo.modules.chatyyconversationlist

// [2026-10-15 native-apps] CALENDÁRIO nativo (mês + agenda do dia). Contrato
// em ios/ChatyyCalendarViewModule.swift e components/native/NativeCalendarView.js.

import android.view.View
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ChatyyCalendarViewModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyCalendarView")

    Function("apiVersion") { 1 }

    View(ChatyyCalendarViewView::class) {
      Events(
        "onSelectDate",
        "onLongPressDate",
        "onMonthChange",
        "onRowPress",
        "onRowAction",
        "onRefresh",
        "onResync",
        "onFirstPaint",
        "onNativeError"
      )

      Prop("month") { view: ChatyyCalendarViewView, v: Map<String, Any?>? -> view.setMonthProp(v) }
      Prop("selected") { view: ChatyyCalendarViewView, v: String? -> view.setSelectedProp(v) }
      Prop("today") { view: ChatyyCalendarViewView, v: String? -> view.setTodayProp(v) }
      Prop("firstWeekday") { view: ChatyyCalendarViewView, v: Double? -> view.setFirstWeekdayProp((v ?: 0.0).toInt()) }
      Prop("marks") { view: ChatyyCalendarViewView, v: Map<String, Any?>? -> view.setMarksProp(v) }
      Prop("showGrid") { view: ChatyyCalendarViewView, v: Boolean? -> view.setShowGridProp(v ?: true) }
      Prop("rowsPatch") { view: ChatyyCalendarViewView, v: Map<String, Any?>? -> view.setRowsPatch(v) }
      Prop("colors") { view: ChatyyCalendarViewView, v: Map<String, Any?>? -> view.setColorsProp(v) }
      Prop("labels") { view: ChatyyCalendarViewView, v: Map<String, Any?>? -> view.setLabelsProp(v) }
      Prop("refreshing") { view: ChatyyCalendarViewView, v: Boolean? -> view.setRefreshingProp(v ?: false) }
      Prop("bottomInset") { view: ChatyyCalendarViewView, v: Double? -> view.setBottomInset(v ?: 0.0) }

      OnViewDidUpdateProps { view: ChatyyCalendarViewView -> view.commitProps() }

      GroupView<ChatyyCalendarViewView> {
        AddChildView { parent, child: View, index -> parent.addRnChild(child, index) }
        GetChildCount { parent -> parent.rnChildCount() }
        GetChildViewAt { parent, index -> parent.rnChildAt(index) }
        RemoveChildView { parent, child: View -> parent.removeRnChild(child) }
        RemoveChildViewAt { parent, index -> parent.removeRnChildAt(index) }
      }
    }
  }
}
