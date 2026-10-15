import ExpoModulesCore
import UIKit

// [2026-10-15 native-apps] CALENDÁRIO nativo (mês + agenda do dia).
// Ver ChatyyCalendarViewView.swift e components/native/NativeCalendarView.js.
//
// Props:  month {y, m(0-11)}, selected "YYYY-MM-DD", today "YYYY-MM-DD",
//         firstWeekday (0 = domingo), marks {"YYYY-MM-DD": {c, n, lv, st}},
//         showGrid, rowsPatch {seq, base, reset?, upsert?, remove?, order?},
//         colors (ARGB), labels {edit, delete, months, hint}, refreshing,
//         bottomInset
// Events: onSelectDate {date}, onLongPressDate {date}, onMonthChange {dir},
//         onRowPress {id}, onRowAction {id, action, source}, onRefresh,
//         onResync {seq}, onFirstPaint {count}, onNativeError {message}
// Filho RN [0]: fica entre a grade e a agenda (rola junto).
public class ChatyyCalendarViewModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyCalendarView")

    Function("apiVersion") { () -> Int in
      return 1
    }

    View(ChatyyCalendarViewView.self) {
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

      Prop("month") { (view: ChatyyCalendarViewView, value: [String: Any]?) in
        view.setMonth(value)
      }
      Prop("selected") { (view: ChatyyCalendarViewView, value: String?) in
        view.setSelected(value ?? "")
      }
      Prop("today") { (view: ChatyyCalendarViewView, value: String?) in
        view.setToday(value ?? "")
      }
      Prop("firstWeekday") { (view: ChatyyCalendarViewView, value: Int?) in
        view.setFirstWeekday(value ?? 0)
      }
      Prop("marks") { (view: ChatyyCalendarViewView, value: [String: Any]?) in
        view.setMarks(value)
      }
      Prop("showGrid") { (view: ChatyyCalendarViewView, value: Bool?) in
        view.setShowGrid(value ?? true)
      }
      Prop("rowsPatch") { (view: ChatyyCalendarViewView, value: [String: Any]?) in
        view.setRowsPatch(value)
      }
      Prop("colors") { (view: ChatyyCalendarViewView, value: [String: Any]?) in
        view.setColors(value)
      }
      Prop("labels") { (view: ChatyyCalendarViewView, value: [String: Any]?) in
        view.setLabels(value)
      }
      Prop("refreshing") { (view: ChatyyCalendarViewView, value: Bool?) in
        view.setRefreshing(value ?? false)
      }
      Prop("bottomInset") { (view: ChatyyCalendarViewView, value: Double?) in
        view.setBottomInset(CGFloat(value ?? 0))
      }

      OnViewDidUpdateProps { (view: ChatyyCalendarViewView) in
        view.commitProps()
      }
    }
  }
}
