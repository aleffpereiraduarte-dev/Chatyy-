import ExpoModulesCore
import UIKit
import BackgroundTasks

// [2026-10-15 photos-native] Registro dos BGTasks do backup de fotos (precisa
// acontecer antes de didFinishLaunching retornar) + relançamento do app para
// eventos das sessões background de upload. Só registra ids presentes no
// Info.plist (plugins/with-photos-backup.js) → binário/prebuild sem a chave
// nunca crasha no launch.
public class PhotosBackupAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  private static var registered = false

  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    PhotosBackupAppDelegateSubscriber.registerOnce()
    return true
  }

  static func registerOnce() {
    guard !registered else { return }
    registered = true
    if PBEngine.permitted(PBEngine.processingId) {
      BGTaskScheduler.shared.register(forTaskWithIdentifier: PBEngine.processingId, using: nil) { task in
        PBEngine.shared.handleBackgroundTask(task, budget: 25 * 60)
      }
    }
    if PBEngine.permitted(PBEngine.refreshId) {
      BGTaskScheduler.shared.register(forTaskWithIdentifier: PBEngine.refreshId, using: nil) { task in
        PBEngine.shared.handleBackgroundTask(task, budget: 25)
      }
    }
  }

  public func application(
    _ application: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    // Expo agrega o handler de TODOS os subscribers e só chama o do sistema quando
    // cada um respondeu → ids que não são nossos: confirma na hora.
    guard identifier == PBEngine.bgWifiId || identifier == PBEngine.bgCellId else { completionHandler(); return }
    PBEngine.shared.attachBackgroundEvents(identifier: identifier, completion: completionHandler)
  }
}
