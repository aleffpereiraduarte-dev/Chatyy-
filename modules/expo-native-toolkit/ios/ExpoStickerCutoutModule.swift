// [2026-10-08 sticker-maker] Recorte automático do objeto (remoção de fundo)
// para o criador de figurinhas — igual ao "Criar figurinha" do WhatsApp.
//
// iOS 17+: Vision VNGenerateForegroundInstanceMaskRequest ("subject lifting",
// o mesmo do toque-longo na foto do app Fotos). Roda 100% no aparelho (Neural
// Engine), sem rede. iOS < 17 / simulador / falha → isSupported=false ou a
// promise rejeita, e o JS cai no recorte do servidor (chat_sticker_cutout).
//
// JS: requireOptionalNativeModule('ExpoStickerCutout') NA HORA da chamada
// (binários antigos não têm o módulo → null → fallback servidor).
//
//   isSupported(): Bool
//   liftSubject(uri: String, maxSide: Int) -> { uri, width, height } | null
//     uri  = file:// (ou caminho) da foto
//     saída = PNG RGBA recortado no contorno do objeto, lado máx maxSide
//     null  = nenhum objeto encontrado
import ExpoModulesCore
import UIKit
import CoreImage
import Vision

public class ExpoStickerCutoutModule: Module {
  private static let ciContext = CIContext(options: [.useSoftwareRenderer: false])

  public func definition() -> ModuleDefinition {
    Name("ExpoStickerCutout")

    Function("isSupported") { () -> Bool in
      #if targetEnvironment(simulator)
      return false
      #else
      if #available(iOS 17.0, *) { return true }
      return false
      #endif
    }

    AsyncFunction("liftSubject") { (uri: String, maxSide: Int, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          let out = try ExpoStickerCutoutModule.lift(uri: uri, maxSide: max(128, min(2048, maxSide)))
          promise.resolve(out)
        } catch {
          promise.reject("E_CUTOUT", "\(error.localizedDescription)")
        }
      }
    }
  }

  private enum CutErr: Error, LocalizedError {
    case unsupported, badImage, render, write
    var errorDescription: String? {
      switch self {
      case .unsupported: return "subject lifting requires iOS 17"
      case .badImage: return "could not read image"
      case .render: return "render failed"
      case .write: return "write failed"
      }
    }
  }

  private static func fileURL(from uri: String) -> URL? {
    if uri.hasPrefix("file://") { return URL(string: uri) }
    if uri.hasPrefix("/") { return URL(fileURLWithPath: uri) }
    return URL(string: uri)
  }

  private static func lift(uri: String, maxSide: Int) throws -> [String: Any]? {
    #if targetEnvironment(simulator)
    throw CutErr.unsupported
    #else
    guard #available(iOS 17.0, *) else { throw CutErr.unsupported }
    guard let url = fileURL(from: uri), url.isFileURL else { throw CutErr.badImage }
    // applyOrientationProperty → aplica o EXIF (foto da câmera em pé).
    guard var ci = CIImage(contentsOf: url, options: [.applyOrientationProperty: true]) else { throw CutErr.badImage }

    // Entrada limitada a 2048px: Vision não precisa mais que isso e poupa RAM.
    let ext = ci.extent
    let inMax: CGFloat = 2048
    let longest = max(ext.width, ext.height)
    if longest > inMax {
      let s = inMax / longest
      ci = ci.transformed(by: CGAffineTransform(scaleX: s, y: s))
    }
    ci = ci.transformed(by: CGAffineTransform(translationX: -ci.extent.origin.x, y: -ci.extent.origin.y))
    guard let cg = ciContext.createCGImage(ci, from: ci.extent) else { throw CutErr.render }

    let request = VNGenerateForegroundInstanceMaskRequest()
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    try handler.perform([request])
    guard let result = request.results?.first, !result.allInstances.isEmpty else { return nil }

    let buffer = try result.generateMaskedImage(
      ofInstances: result.allInstances, from: handler, croppedToInstancesExtent: true)
    var masked = CIImage(cvPixelBuffer: buffer)
    let mExt = masked.extent
    let mLongest = max(mExt.width, mExt.height)
    if mLongest < 8 { return nil }
    let target = CGFloat(maxSide)
    if mLongest > target {
      let s = target / mLongest
      masked = masked.transformed(by: CGAffineTransform(scaleX: s, y: s))
    }
    masked = masked.transformed(by: CGAffineTransform(translationX: -masked.extent.origin.x, y: -masked.extent.origin.y))
    guard let outCG = ciContext.createCGImage(masked, from: masked.extent, format: .RGBA8,
                                              colorSpace: CGColorSpace(name: CGColorSpace.sRGB)) else { throw CutErr.render }
    let img = UIImage(cgImage: outCG)
    guard let png = img.pngData() else { throw CutErr.write }
    let dest = FileManager.default.temporaryDirectory
      .appendingPathComponent("sticker-cutout-\(UUID().uuidString).png")
    do { try png.write(to: dest, options: .atomic) } catch { throw CutErr.write }
    return ["uri": dest.absoluteString, "width": outCG.width, "height": outCG.height]
    #endif
  }
}
