import ExpoModulesCore
import UIKit

// [2026-10-10 paste-image] Colar foto/GIF/figurinha no campo de mensagem.
//
// O TextInput do RN (RCTUITextView / RCTUITextField) só aceita texto: "Colar"
// nem aparece no menu quando a área de transferência tem só imagem. Aqui:
//   • canPerformAction(paste:) → true quando há imagem (só nos campos ligados);
//   • paste: com imagem e SEM texto → grava o arquivo cru (GIF/WebP/PNG/JPEG)
//     em tmp e emite onImagePasted { uri, mimeType, width, height, size, viewTag }.
// Texto continua no caminho original (IMP antiga chamada sempre que não tratamos).
//
// O swizzle é por CLASSE (uma vez), mas o comportamento só vale para as
// instâncias marcadas via attach(viewTag) (objeto associado) — os outros
// TextInputs do app seguem idênticos. iOS 15.1+: nada aqui exige API nova.

private var kChatyyPasteTagKey: UInt8 = 0

public class ChatyyImagePasteModule: Module {
  fileprivate static weak var shared: ChatyyImagePasteModule?
  private static var swizzled = false

  public func definition() -> ModuleDefinition {
    Name("ChatyyImagePaste")
    Events("onImagePasted")

    OnCreate {
      ChatyyImagePasteModule.shared = self
    }

    Function("isSupported") { () -> Bool in
      return true
    }

    AsyncFunction("attach") { (viewTag: Int) -> Bool in
      ChatyyImagePasteModule.shared = self
      guard let root = self.appContext?.findView(withTag: viewTag, ofType: UIView.self),
            let input = Self.findTextInput(in: root, depth: 0) else {
        return false
      }
      Self.installSwizzlesOnce()
      objc_setAssociatedObject(input, &kChatyyPasteTagKey, NSNumber(value: viewTag), .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
      return true
    }.runOnQueue(.main)

    AsyncFunction("detach") { (viewTag: Int) -> Bool in
      guard let root = self.appContext?.findView(withTag: viewTag, ofType: UIView.self),
            let input = Self.findTextInput(in: root, depth: 0) else {
        return false
      }
      objc_setAssociatedObject(input, &kChatyyPasteTagKey, nil, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
      return true
    }.runOnQueue(.main)
  }

  // MARK: - View lookup

  private static func findTextInput(in view: UIView, depth: Int) -> UIView? {
    if view is UITextView || view is UITextField { return view }
    if depth > 4 { return nil }
    for sub in view.subviews {
      if let found = findTextInput(in: sub, depth: depth + 1) { return found }
    }
    return nil
  }

  fileprivate static func pasteTag(of obj: AnyObject) -> NSNumber? {
    return objc_getAssociatedObject(obj, &kChatyyPasteTagKey) as? NSNumber
  }

  // MARK: - Swizzle (RCTUITextView / RCTUITextField)

  private static func installSwizzlesOnce() {
    if swizzled { return }
    swizzled = true
    for name in ["RCTUITextView", "RCTUITextField"] {
      if let cls = NSClassFromString(name) { ChatyyImagePasteModule.swizzle(cls) }
    }
  }

  private static func swizzle(_ cls: AnyClass) {
    let canSel = #selector(UIResponder.canPerformAction(_:withSender:))
    let pasteSel = #selector(UIResponderStandardEditActions.paste(_:))
    guard let canM = class_getInstanceMethod(cls, canSel),
          let pasteM = class_getInstanceMethod(cls, pasteSel) else { return }
    let origCan = method_getImplementation(canM)
    let origPaste = method_getImplementation(pasteM)
    typealias CanFn = @convention(c) (AnyObject, Selector, Selector, AnyObject?) -> Bool
    typealias PasteFn = @convention(c) (AnyObject, Selector, AnyObject?) -> Void

    let canBlock: @convention(block) (AnyObject, Selector, AnyObject?) -> Bool = { obj, action, sender in
      if action == pasteSel, ChatyyImagePasteModule.pasteTag(of: obj) != nil, UIPasteboard.general.hasImages {
        return true
      }
      return unsafeBitCast(origCan, to: CanFn.self)(obj, canSel, action, sender)
    }
    let pasteBlock: @convention(block) (AnyObject, AnyObject?) -> Void = { obj, sender in
      if let tag = ChatyyImagePasteModule.pasteTag(of: obj),
         UIPasteboard.general.hasImages,
         !UIPasteboard.general.hasStrings,
         ChatyyImagePasteModule.handleImagePaste(viewTag: tag) {
        return
      }
      unsafeBitCast(origPaste, to: PasteFn.self)(obj, pasteSel, sender)
    }
    class_replaceMethod(cls, canSel, imp_implementationWithBlock(canBlock), method_getTypeEncoding(canM))
    class_replaceMethod(cls, pasteSel, imp_implementationWithBlock(pasteBlock), method_getTypeEncoding(pasteM))
  }

  // MARK: - Paste → arquivo

  private static func handleImagePaste(viewTag: NSNumber) -> Bool {
    let pb = UIPasteboard.general
    var data: Data?
    var ext = "png"
    var mime = "image/png"
    if let d = pb.data(forPasteboardType: "com.compuserve.gif") {
      data = d; ext = "gif"; mime = "image/gif"
    } else if let d = pb.data(forPasteboardType: "org.webmproject.webp") {
      data = d; ext = "webp"; mime = "image/webp"
    } else if let d = pb.data(forPasteboardType: "public.png") {
      data = d
    } else if let d = pb.data(forPasteboardType: "public.jpeg") {
      data = d; ext = "jpg"; mime = "image/jpeg"
    } else if let img = pb.image, let d = img.jpegData(compressionQuality: 0.92) {
      data = d; ext = "jpg"; mime = "image/jpeg"
    }
    guard let bytes = data, !bytes.isEmpty, bytes.count <= 40 * 1024 * 1024 else { return false }
    let name = "colado_\(Int(Date().timeIntervalSince1970 * 1000)).\(ext)"
    let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(name)
    do {
      try bytes.write(to: url, options: .atomic)
    } catch {
      return false
    }
    var width = 0
    var height = 0
    if let img = UIImage(data: bytes) {
      width = Int(img.size.width * img.scale)
      height = Int(img.size.height * img.scale)
    }
    guard let module = shared else { return false }
    module.sendEvent("onImagePasted", [
      "uri": url.absoluteString,
      "mimeType": mime,
      "width": width,
      "height": height,
      "size": bytes.count,
      "viewTag": viewTag.intValue,
    ])
    return true
  }
}
