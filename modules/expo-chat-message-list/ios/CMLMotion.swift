import UIKit

// [2026-10-16 motion-conv, apiVersion 7] Movimento "nível Telegram" da lista
// nativa. Prop `motion` {i, e, t, r, s, a} (0/1) vinda do JS
// (globalThis.__chatyy_motion_* — ver components/chat/nativeThreadList.js):
//   i  inserção com mola: a ENVIADA sai do composer (sobe 34 pt, escala .9 →
//      1 ancorada no canto direito-baixo, leve deslize da esquerda); a RECEBIDA
//      sobe 14 pt com escala .96 ancorada à esquerda. Desligado = fade+subida
//      antigos (UIKit padrão).
//   e  apagar / virar "mensagem apagada" / mudar altura (editar, reação,
//      tradução…) com mola: a bolha some encolhendo (.86), a vizinha assenta.
//      Desligado = troca seca (como antes).
//   t  ⏱ → ✓ → ✓✓ → lida animado (mesma coreografia do AnimatedCheckStatus JS).
//   r  reação NOVA de outra pessoa → "pop" do chip (a própria já pulava).
//   s  pílula de data flutuante entra/sai com escala + troca de texto em fade.
//   a  áudio: progresso da onda contínuo (extrapolado entre pulsos do player,
//      barra parcial) em vez de pular barra a barra.
// Reduzir Movimento → tudo desligado (checado na hora). Padrão: tudo ligado
// (JS antigo não manda a prop).
enum CMLMotion {
  static var insert = true
  static var edit = true
  static var ticks = true
  static var react = true
  static var sticky = true
  static var audio = true
  /// [2026-10-18 tg-list, apiVersion 11] `c`: ponteiros do relógio do pendente giram após ~300 ms
  static var clock = true

  static func apply(_ d: [String: Any]?) {
    let m = d ?? [:]
    func on(_ k: String) -> Bool {
      guard let v = m[k] else { return true }
      return CMLRow.bool(v)
    }
    insert = on("i")
    edit = on("e")
    ticks = on("t")
    react = on("r")
    sticky = on("s")
    audio = on("a")
    clock = on("c")
  }

  static var reduce: Bool { return UIAccessibility.isReduceMotionEnabled }

  // Mola do envio ≈ SPRING_SEND do JS (stiffness 340 / damping 28 → ζ≈0.76,
  // assenta em ~300 ms). UIKit: duração + amortecimento.
  static let insertDuration: TimeInterval = 0.46
  static let insertDamping: CGFloat = 0.8
  static let editDuration: TimeInterval = 0.42
  static let editDamping: CGFloat = 0.88
}

/// Alvo fraco p/ CADisplayLink (o link retém o alvo).
final class CMLWeakLink: NSObject {
  weak var target: AnyObject?
  let fire: (AnyObject) -> Void
  init(_ target: AnyObject, _ fire: @escaping (AnyObject) -> Void) {
    self.target = target
    self.fire = fire
  }
  @objc func tick(_ l: CADisplayLink) {
    if let t = target { fire(t) } else { l.invalidate() }
  }
}
