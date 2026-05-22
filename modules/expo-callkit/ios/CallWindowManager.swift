// CallWindowManager.swift
// WAVE 149 — 2026-05-22 — ROOT CAUSE FIX para "UI rica nunca aparece em outgoing".
//
// Histórico do bug:
// Builds 545–550 sempre apresentaram CallViewController via
// `topVC.present(callVC, animated:true)` — modal sobre a UIWindow normal do
// app (windowLevel = .normal = 0.0).
//
// Durante CXStartCallAction (outgoing ringing), o iOS injeta a UIWindow
// OWN do CallKit em windowLevel ≥ .alert (2000+). Nossa modal renderiza,
// mas fica DEBAIXO desse overlay. Quando o user toca o pill "Sara Zelle"
// no topo, iOS foregrounds o app — mas faz keyWindow = chat-conversation
// (a UIWindow normal do app), NÃO a UIWindow do CallView modal-presented.
// Resultado: chat-conversation aparece, CallView nunca.
//
// Padrão WhatsApp/Signal (8+ anos em produção):
// Criar UIWindow DEDICADA pra call UI em `windowLevel = .normal + 1`
// (acima de tudo do app normal, abaixo do .alert do CallKit por design —
// o CallKit pill fica visível como deveria, mas QUANDO o user volta pro
// app via tap-no-pill, NOSSA window já está key e visível, então o
// CallView aparece instantaneamente).
//
// Lifecycle:
// 1. WAVE 145 (line ~1002 do ExpoCallKitModule.swift) chama
//    CallWindowManager.shared.showCallUI(...) ao invés de
//    ProviderDelegate.presentOutgoingCallVC(...)
// 2. showCallUI cria UIWindow, root = new CallViewController, makeKey.
// 3. Idempotente: 2ª call com mesmo callId → no-op (substitui o WAVE 147
//    _activePresentedCallIds Set).
// 4. hideCallUI() é chamado em CXEndCallAction handler e em
//    handleHangup() do CallViewController quando o user toca End.
// 5. Ao destruir, libera a UIWindow + restaura a keyWindow original
//    (a UIWindow normal do RN/Expo).

import UIKit

@objc(CallWindowManager)
public final class CallWindowManager: NSObject {

  @objc public static let shared = CallWindowManager()

  // Strong ref ao window enquanto a call estiver ativa. ARC dropa o window
  // = window some da tela. Sempre nullify ANTES de dropar a ref.
  private var callWindow: UIWindow?
  private var currentCallId: String?
  private var previousKeyWindow: UIWindow?

  // Thread-safety: TODOS os métodos públicos rodam em main. Internal state
  // só acessa de main (UIKit invariant + simplifica reasoning).

  // MARK: - Public API

  /// Mostra o CallView em UIWindow dedicada.
  /// Idempotente: chamar com o mesmo callId é no-op.
  @objc public func showCallUI(
    callId: String,
    callerName: String,
    callerEmail: String,
    hasVideo: Bool,
    lkUrl: String?,
    lkToken: String?,
    isOutgoing: Bool,
    conversationId: String
  ) {
    let block = {
      // Idempotência: se já estamos mostrando esse callId, ignora.
      if self.currentCallId == callId, self.callWindow != nil {
        NSLog("[CallWindowManager] showCallUI no-op — callId=\(callId) já está visível")
        return
      }

      // Achar uma scene foreground pra criar a window. Em testes em iPad
      // multi-scene pode haver 2+; pegamos a mais provável (active ou
      // foregroundInactive).
      guard let scene = self.activeScene() else {
        NSLog("[CallWindowManager] showCallUI ABORT — nenhuma UIWindowScene ativa pra criar window. callId=\(callId)")
        return
      }

      // Salvar a keyWindow atual pra restaurar depois (caso o app tenha 1
      // só keyWindow — o normal do RN).
      if self.previousKeyWindow == nil {
        self.previousKeyWindow = scene.windows.first { $0.isKeyWindow }
      }

      // Construir o CallViewController.
      let callVC = CallViewController(
        callId: callId,
        callerName: callerName,
        callerEmail: callerEmail,
        hasVideo: hasVideo,
        lkUrl: lkUrl,
        lkToken: lkToken,
        isOutgoing: isOutgoing,
        conversationId: conversationId
      )

      // Criar a UIWindow dedicada.
      let window = UIWindow(windowScene: scene)
      // windowLevel = .normal + 1 fica acima do RN normal window mas
      // abaixo do CallKit (que usa .alert ≥ 2000). Isso é o que queremos:
      // durante ringing o CallKit pill fica no topo (correto), e quando o
      // user volta pro app via tap-no-pill, nossa window vira key e o
      // CallView aparece.
      window.windowLevel = UIWindow.Level(rawValue: UIWindow.Level.normal.rawValue + 1)
      window.backgroundColor = .black
      window.rootViewController = callVC
      window.makeKeyAndVisible()

      self.callWindow = window
      self.currentCallId = callId

      NSLog("[CallWindowManager] showCallUI DONE — callId=\(callId) window.level=\(window.windowLevel.rawValue) windowIsKey=\(window.isKeyWindow)")
    }
    if Thread.isMainThread { block() } else { DispatchQueue.main.async(execute: block) }
  }

  /// Esconde e libera a call window.
  /// Idempotente: chamar sem window ativa é no-op.
  @objc public func hideCallUI(callId: String? = nil) {
    let block = {
      // Se o callId não bate, NÃO esconde (call concurrente race-safe).
      if let cid = callId, let current = self.currentCallId, cid != current {
        NSLog("[CallWindowManager] hideCallUI no-op — callId=\(cid) não bate com current=\(current)")
        return
      }

      guard let window = self.callWindow else {
        // Já escondido ou nunca mostrado.
        return
      }

      NSLog("[CallWindowManager] hideCallUI START — currentCallId=\(self.currentCallId ?? "nil")")

      // Tear-down ordem importa: nullify rootVC ANTES de hide pra evitar
      // SwiftUI tentar re-layout numa window que vai morrer.
      window.rootViewController = nil
      window.isHidden = true

      // Drop strong ref → ARC libera a window.
      self.callWindow = nil
      self.currentCallId = nil

      // Restaurar a keyWindow original (RN root). Sem isso, o app pode
      // ficar com "no key window" e responder bizarro a touches.
      if let prev = self.previousKeyWindow {
        prev.makeKey()
        NSLog("[CallWindowManager] hideCallUI — restored previous keyWindow")
      }
      self.previousKeyWindow = nil

      NSLog("[CallWindowManager] hideCallUI DONE")
    }
    if Thread.isMainThread { block() } else { DispatchQueue.main.async(execute: block) }
  }

  /// Indica se uma call window está ativa.
  @objc public var isShowing: Bool {
    return callWindow != nil
  }

  /// Retorna o callId atualmente exibido (ou nil).
  @objc public var visibleCallId: String? {
    return currentCallId
  }

  // MARK: - Private

  private func activeScene() -> UIWindowScene? {
    // Preferência: foregroundActive. Fallback: foregroundInactive (durante
    // transição). Último recurso: qualquer scene.
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    if let active = scenes.first(where: { $0.activationState == .foregroundActive }) {
      return active
    }
    if let inactive = scenes.first(where: { $0.activationState == .foregroundInactive }) {
      return inactive
    }
    return scenes.first
  }
}
