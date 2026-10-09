import ExpoModulesCore
import QuickLook
import UIKit

// [2026-10-09 native-docs] System document preview (JS: utils/openDocument.js).
//
//   canPreview(path)          → QLPreviewController.canPreview for a LOCAL file
//   preview(path, title)      → presents QLPreviewController (QuickLook) over the
//                               top-most view controller (works over RN Modals).
//                               Resolves true once presented, false if the file
//                               is missing / not previewable.
//
// QuickLook renders PDF, Word, Excel, PowerPoint, Pages, Numbers, Keynote, RTF,
// CSV, images, audio/video — fully on-device, offline, with the system share /
// markup / "Open in…" chrome. Replaces the docs.google.com viewer (which also
// received the attachment URL, sometimes with the auth token).
//
// Only file:// paths are accepted: JS downloads to the Caches dir first.

private final class ChatyyPreviewItem: NSObject, QLPreviewItem {
  let previewItemURL: URL?
  let previewItemTitle: String?
  init(url: URL, title: String?) {
    self.previewItemURL = url
    self.previewItemTitle = title
  }
}

private final class ChatyyPreviewSource: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
  let item: ChatyyPreviewItem
  var onDismiss: (() -> Void)?
  init(item: ChatyyPreviewItem) { self.item = item }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
    item
  }

  func previewControllerDidDismiss(_ controller: QLPreviewController) {
    onDismiss?()
  }
}

public class ExpoChatyyDocPreviewModule: Module {
  // QLPreviewController holds its dataSource/delegate weakly → keep it alive here.
  private var activeSource: ChatyyPreviewSource?

  static func fileURL(_ path: String) -> URL? {
    if path.isEmpty { return nil }
    if path.hasPrefix("file://") {
      guard let u = URL(string: path) else { return nil }
      return u.isFileURL ? u : nil
    }
    if path.hasPrefix("/") { return URL(fileURLWithPath: path) }
    return nil
  }

  public func definition() -> ModuleDefinition {
    Name("ExpoChatyyDocPreview")

    Function("canPreview") { (path: String) -> Bool in
      guard let url = ExpoChatyyDocPreviewModule.fileURL(path),
            FileManager.default.fileExists(atPath: url.path) else { return false }
      return QLPreviewController.canPreview(url as NSURL)
    }

    AsyncFunction("preview") { (path: String, title: String?) -> Bool in
      guard let url = ExpoChatyyDocPreviewModule.fileURL(path),
            FileManager.default.fileExists(atPath: url.path),
            QLPreviewController.canPreview(url as NSURL) else { return false }
      guard let presenter = self.appContext?.utilities?.currentViewController() else { return false }

      let cleanTitle = (title?.isEmpty == false) ? title : url.lastPathComponent
      let source = ChatyyPreviewSource(item: ChatyyPreviewItem(url: url, title: cleanTitle))
      source.onDismiss = { [weak self, weak source] in
        guard let self = self else { return }
        if self.activeSource === source { self.activeSource = nil }
      }
      self.activeSource = source

      let ql = QLPreviewController()
      ql.dataSource = source
      ql.delegate = source
      ql.modalPresentationStyle = .fullScreen
      presenter.present(ql, animated: true, completion: nil)
      return true
    }.runOnQueue(.main)
  }
}
