import UIKit

// [2026-10-15 native-apps] Modelos do CALENDÁRIO nativo (ChatyyCalendarView):
// visão mês + agenda do dia (app/calendar.js via components/native/
// NativeCalendarView.js). Mesmo contrato do Android (CAModels.kt).
// Linhas PLANAS da agenda (patches por id via createPatcher):
//   cabeçalho do dia → { id, k: 'h', t, sb, top? }
//   evento           → { id, k: 'e', t, tm, rel, loc, rr, mt, jn, cal, ac, cc, sy, rm, sw }
//   vazio            → { id, k: 'n', t, sb, b }
// Marcadores do mês (prop `marks`): { "YYYY-MM-DD": { c: [ARGB ≤3], n, lv, st: [{ c, f, l }] } }

struct CARow {
  var id: String = ""
  var kind: String = "e"
  var title: String = ""
  var sub: String = ""
  var top = false
  var time: String = ""
  var rel: String = ""
  var location: String = ""
  var recurrence: String = ""
  var meeting: String = ""
  var join: String = ""
  var calendar: String = ""
  var accent: UIColor?
  var calColor: UIColor?
  var synced = false
  var reminder = false
  var swipe = false
  var button: String = ""

  init() {}

  init(_ d: [String: Any]) {
    id = CLVal.str(d["id"])
    kind = CLVal.str(d["k"])
    if kind.isEmpty { kind = "e" }
    title = CLVal.str(d["t"])
    sub = CLVal.str(d["sb"])
    top = CLVal.bool(d["top"])
    time = CLVal.str(d["tm"])
    rel = CLVal.str(d["rel"])
    location = CLVal.str(d["loc"])
    recurrence = CLVal.str(d["rr"])
    meeting = CLVal.str(d["mt"])
    join = CLVal.str(d["jn"])
    calendar = CLVal.str(d["cal"])
    accent = CTColor.of(d["ac"])
    calColor = CTColor.of(d["cc"])
    synced = CLVal.bool(d["sy"])
    reminder = CLVal.bool(d["rm"])
    swipe = CLVal.bool(d["sw"])
    button = CLVal.str(d["b"])
  }
}

struct CAStripe {
  var color: UIColor
  var first: Bool
  var last: Bool
}

struct CAMark {
  var dots: [UIColor] = []
  var count = 0
  var live = false
  var stripes: [CAStripe] = []

  init(_ v: Any?) {
    if let n = v as? NSNumber {
      count = max(0, n.intValue)
      return
    }
    guard let d = v as? [String: Any] else { return }
    if let cs = d["c"] as? [Any] {
      for c in cs.prefix(3) { if let col = CTColor.of(c) { dots.append(col) } }
    }
    count = d["n"] == nil ? dots.count : max(0, CLVal.int(d["n"]))
    live = CLVal.bool(d["lv"])
    if let st = d["st"] as? [Any] {
      for s in st.prefix(2) {
        guard let sd = s as? [String: Any], let col = CTColor.of(sd["c"]) else { continue }
        stripes.append(CAStripe(color: col, first: CLVal.bool(sd["f"]), last: CLVal.bool(sd["l"])))
      }
    }
  }
}

/// Cores da tela (+ superfície do cartão e fundo do dia selecionado).
struct CAStyle {
  var colors = CTColors()
  var card: UIColor = .white
  var selBg: UIColor = UIColor(clHex: 0xF0F1F3)

  init() {}

  init(_ d: [String: Any]?) {
    colors = CTColors(d)
    card = CTColor.of(d?["card"]) ?? (colors.dark ? UIColor(clHex: 0x111111) : .white)
    selBg = CTColor.of(d?["chipBg"]) ?? (colors.dark ? UIColor(clHex: 0x1C1C1E) : UIColor(clHex: 0xF0F1F3))
  }
}

struct CALabels {
  var edit = "Editar"
  var delete = "Apagar"
  var months: [String] = []
  var hint = ""

  init() {}

  init(_ d: [String: Any]?) {
    guard let d = d else { return }
    let e = CLVal.str(d["edit"]); if !e.isEmpty { edit = e }
    let x = CLVal.str(d["delete"]); if !x.isEmpty { delete = x }
    months = ((d["months"] as? [Any]) ?? []).map { CLVal.str($0) }
    hint = CLVal.str(d["hint"])
  }

  func month(_ m: Int) -> String {
    return m >= 0 && m < months.count ? months[m] : String(m + 1)
  }
}

/// Datas do grid (calendário gregoriano no fuso do aparelho, igual ao JS).
enum CADate {
  static let cal: Calendar = {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = TimeZone.current
    return c
  }()

  static func key(_ y: Int, _ m: Int, _ d: Int) -> String {
    // m 0-11 (como no JS); normaliza estouros (mês -1 / 12).
    var yy = y, mm = m
    while mm < 0 { mm += 12; yy -= 1 }
    while mm > 11 { mm -= 12; yy += 1 }
    return String(format: "%04d-%02d-%02d", yy, mm + 1, d)
  }

  static func daysIn(_ y: Int, _ m: Int) -> Int {
    var yy = y, mm = m
    while mm < 0 { mm += 12; yy -= 1 }
    while mm > 11 { mm -= 12; yy += 1 }
    guard let date = cal.date(from: DateComponents(year: yy, month: mm + 1, day: 1)),
          let r = cal.range(of: .day, in: .month, for: date) else { return 30 }
    return r.count
  }

  /// Dia da semana do dia 1 (0 = domingo).
  static func firstWeekday(_ y: Int, _ m: Int) -> Int {
    guard let date = cal.date(from: DateComponents(year: y, month: m + 1, day: 1)) else { return 0 }
    return cal.component(.weekday, from: date) - 1
  }
}

/// Uma célula da grade.
struct CACell {
  var day: Int
  var key: String
  var current: Bool
  var year: Int
  var month: Int
}

enum CAGrid {
  /// 5 ou 6 semanas (como o CalendarGrid JS), começando em `firstWeekday`.
  static func cells(year: Int, month: Int, firstWeekday: Int) -> [CACell] {
    let fw = ((firstWeekday % 7) + 7) % 7
    let lead = ((CADate.firstWeekday(year, month) - fw) % 7 + 7) % 7
    let days = CADate.daysIn(year, month)
    let prevDays = CADate.daysIn(year, month - 1)
    let weeks = max(5, Int(ceil(Double(lead + days) / 7.0)))
    var out: [CACell] = []
    out.reserveCapacity(weeks * 7)
    var py = year, pm = month - 1
    if pm < 0 { pm = 11; py -= 1 }
    var ny = year, nm = month + 1
    if nm > 11 { nm = 0; ny += 1 }
    for i in 0..<(weeks * 7) {
      if i < lead {
        let d = prevDays - lead + i + 1
        out.append(CACell(day: d, key: CADate.key(py, pm, d), current: false, year: py, month: pm))
      } else if i - lead < days {
        let d = i - lead + 1
        out.append(CACell(day: d, key: CADate.key(year, month, d), current: true, year: year, month: month))
      } else {
        let d = i - lead - days + 1
        out.append(CACell(day: d, key: CADate.key(ny, nm, d), current: false, year: ny, month: nm))
      }
    }
    return out
  }
}
