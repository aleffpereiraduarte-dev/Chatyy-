import UIKit

// [reply-v2 2026-10-15] "Citar trecho" (Telegram): o usuário escolhe PARTE do
// texto da mensagem e responde citando só aquele trecho. Chamado pelo JS
// (ref.showQuotePicker) depois que o menu de contexto nativo fecha; devolve o
// trecho escolhido ("" = cancelou). Estética P&B, sem emoji.
//
// payload: { text, title, hint, confirm, cancel, dark: 0|1, max: 240 }
final class CMLQuotePicker: UIView, UITextViewDelegate {
  private static weak var current: CMLQuotePicker?

  private let dim = UIView()
  private let card = UIView()
  private let titleLabel = UILabel()
  private let hintLabel = UILabel()
  private let textView = UITextView()
  private let cancelBtn = UIButton(type: .system)
  private let confirmBtn = UIButton(type: .system)
  private let previewLabel = UILabel()
  private var done: ((String) -> Void)?
  private let fullText: String
  private let maxLen: Int
  private let dark: Bool
  private var finished = false
  private var kbH: CGFloat = 0

  static func present(in window: UIWindow, payload: [String: Any], completion: @escaping (String) -> Void) {
    current?.finish("")
    let text = (payload["text"] as? String) ?? ""
    if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { completion(""); return }
    let p = CMLQuotePicker(payload: payload, text: text)
    p.done = completion
    p.frame = window.bounds
    p.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    window.addSubview(p)
    current = p
    p.animateIn()
  }

  private init(payload: [String: Any], text: String) {
    fullText = text
    maxLen = max(20, (payload["max"] as? NSNumber)?.intValue ?? 240)
    dark = ((payload["dark"] as? NSNumber)?.boolValue) ?? false
    super.init(frame: .zero)
    let ink: UIColor = dark ? .white : .black
    let sub: UIColor = dark ? UIColor(white: 1, alpha: 0.6) : UIColor(white: 0, alpha: 0.55)
    let cardBg: UIColor = dark ? UIColor(white: 0.12, alpha: 1) : .white

    dim.backgroundColor = UIColor.black.withAlphaComponent(dark ? 0.55 : 0.35)
    dim.alpha = 0
    dim.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(cancelTapped)))
    addSubview(dim)

    card.backgroundColor = cardBg
    card.layer.cornerRadius = 22
    card.layer.cornerCurve = .continuous
    card.layer.shadowColor = UIColor.black.cgColor
    card.layer.shadowOpacity = dark ? 0.4 : 0.16
    card.layer.shadowRadius = 24
    card.layer.shadowOffset = CGSize(width: 0, height: 8)
    addSubview(card)

    titleLabel.text = (payload["title"] as? String) ?? "Citar trecho"
    titleLabel.font = .systemFont(ofSize: 17, weight: .semibold)
    titleLabel.textColor = ink
    titleLabel.textAlignment = .center
    card.addSubview(titleLabel)

    hintLabel.text = (payload["hint"] as? String) ?? ""
    hintLabel.font = .systemFont(ofSize: 13)
    hintLabel.textColor = sub
    hintLabel.textAlignment = .center
    hintLabel.numberOfLines = 2
    card.addSubview(hintLabel)

    textView.text = text
    textView.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: .systemFont(ofSize: 16), maximumPointSize: 26)
    textView.textColor = ink
    textView.backgroundColor = dark ? UIColor(white: 1, alpha: 0.06) : UIColor(white: 0, alpha: 0.04)
    textView.layer.cornerRadius = 14
    textView.textContainerInset = UIEdgeInsets(top: 12, left: 10, bottom: 12, right: 10)
    textView.isEditable = false
    textView.isSelectable = true
    textView.dataDetectorTypes = []
    textView.tintColor = ink
    textView.delegate = self
    card.addSubview(textView)

    previewLabel.font = .systemFont(ofSize: 13, weight: .medium)
    previewLabel.textColor = sub
    previewLabel.numberOfLines = 1
    previewLabel.lineBreakMode = .byTruncatingMiddle
    card.addSubview(previewLabel)

    cancelBtn.setTitle((payload["cancel"] as? String) ?? "Cancelar", for: .normal)
    cancelBtn.titleLabel?.font = .systemFont(ofSize: 16, weight: .regular)
    cancelBtn.setTitleColor(ink, for: .normal)
    cancelBtn.backgroundColor = dark ? UIColor(white: 1, alpha: 0.10) : UIColor(white: 0, alpha: 0.06)
    cancelBtn.layer.cornerRadius = 14
    cancelBtn.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
    card.addSubview(cancelBtn)

    confirmBtn.setTitle((payload["confirm"] as? String) ?? "Citar", for: .normal)
    confirmBtn.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
    confirmBtn.setTitleColor(dark ? .black : .white, for: .normal)
    confirmBtn.backgroundColor = ink
    confirmBtn.layer.cornerRadius = 14
    confirmBtn.addTarget(self, action: #selector(confirmTapped), for: .touchUpInside)
    card.addSubview(confirmBtn)

    isAccessibilityElement = false
    accessibilityViewIsModal = true
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  private var cardFrame: CGRect {
    let W = bounds.width
    let safe = window?.safeAreaInsets ?? .zero
    let w = min(W - 24, 520)
    let x = (W - w) / 2
    let maxTextH = max(120, (bounds.height - safe.top - safe.bottom) * 0.42)
    let tw = w - 32
    let fit = textView.sizeThatFits(CGSize(width: tw, height: .greatestFiniteMagnitude)).height
    let textH = min(maxTextH, max(64, ceil(fit)))
    let hintH: CGFloat = (hintLabel.text ?? "").isEmpty ? 0 : ceil(hintLabel.sizeThatFits(CGSize(width: tw, height: 60)).height) + 4
    let h = 18 + 22 + 4 + hintH + 12 + textH + 10 + 18 + 14 + 48 + 16
    let bottom = max(safe.bottom + 12, kbH + 12)
    return CGRect(x: x, y: bounds.height - bottom - h, width: w, height: h)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    dim.frame = bounds
    let f = cardFrame
    card.bounds = CGRect(origin: .zero, size: f.size)
    card.center = CGPoint(x: f.midX, y: f.midY)
    let tw = f.width - 32
    var y: CGFloat = 18
    titleLabel.frame = CGRect(x: 16, y: y, width: tw, height: 22); y += 26
    if !(hintLabel.text ?? "").isEmpty {
      let hh = ceil(hintLabel.sizeThatFits(CGSize(width: tw, height: 60)).height)
      hintLabel.frame = CGRect(x: 16, y: y, width: tw, height: hh); y += hh + 4
    }
    y += 12
    let textH = f.height - y - 10 - 18 - 14 - 48 - 16
    textView.frame = CGRect(x: 16, y: y, width: tw, height: textH); y += textH + 10
    previewLabel.frame = CGRect(x: 16, y: y, width: tw, height: 18); y += 18 + 14
    let bw = (tw - 10) / 2
    cancelBtn.frame = CGRect(x: 16, y: y, width: bw, height: 48)
    confirmBtn.frame = CGRect(x: 16 + bw + 10, y: y, width: bw, height: 48)
    card.layer.shadowPath = UIBezierPath(roundedRect: card.bounds, cornerRadius: 22).cgPath
  }

  private func animateIn() {
    layoutIfNeeded()
    let reduce = UIAccessibility.isReduceMotionEnabled
    card.alpha = 0
    card.transform = reduce ? .identity : CGAffineTransform(translationX: 0, y: 60).scaledBy(x: 0.96, y: 0.96)
    UIView.animate(withDuration: 0.42, delay: 0, usingSpringWithDamping: 0.8, initialSpringVelocity: 0.3, options: [.allowUserInteraction], animations: {
      self.dim.alpha = 1
      self.card.alpha = 1
      self.card.transform = .identity
    }, completion: { _ in
      // Começa com TUDO selecionado: o usuário só arrasta as alças até o trecho.
      _ = self.textView.becomeFirstResponder()
      self.textView.selectedRange = NSRange(location: 0, length: (self.fullText as NSString).length)
      self.updatePreview()
    })
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    updatePreview()
  }

  func textViewDidChangeSelection(_ textView: UITextView) { updatePreview() }

  private func selectedText() -> String {
    let ns = fullText as NSString
    let r = textView.selectedRange
    var out = fullText
    if r.location != NSNotFound, r.length > 0, r.location + r.length <= ns.length {
      out = ns.substring(with: r)
    }
    out = out.trimmingCharacters(in: .whitespacesAndNewlines)
    if out.count > maxLen { out = String(out.prefix(maxLen)) }
    return out
  }

  private func updatePreview() {
    let s = selectedText().replacingOccurrences(of: "\n", with: " ")
    previewLabel.text = s.isEmpty ? "" : "\u{201C}" + s + "\u{201D}"
    confirmBtn.isEnabled = !s.isEmpty
    confirmBtn.alpha = s.isEmpty ? 0.4 : 1
  }

  @objc private func cancelTapped() { finish("") }

  @objc private func confirmTapped() {
    UISelectionFeedbackGenerator().selectionChanged()
    finish(selectedText())
  }

  func finish(_ result: String) {
    guard !finished else { return }
    finished = true
    let cb = done
    done = nil
    cb?(result)
    textView.selectedRange = NSRange(location: 0, length: 0)
    _ = textView.resignFirstResponder()
    UIView.animate(withDuration: 0.22, delay: 0, options: [.curveEaseIn, .beginFromCurrentState], animations: {
      self.dim.alpha = 0
      self.card.alpha = 0
      self.card.transform = CGAffineTransform(translationX: 0, y: 40)
    }, completion: { _ in self.removeFromSuperview() })
  }

  override func willMove(toWindow newWindow: UIWindow?) {
    super.willMove(toWindow: newWindow)
    if newWindow == nil, !finished { finished = true; let cb = done; done = nil; cb?("") }
  }
}
