import ExpoModulesCore
import UIKit
import BackgroundTasks

/// Apple requires `BGTaskScheduler.shared.register(...)` to be called BEFORE
/// `application(_:didFinishLaunchingWithOptions:)` returns. iOS 18+ enforces
/// this strictly: register from anywhere later (e.g. ExpoModule's `OnCreate`)
/// and the app is killed with `NSInternalInconsistencyException` on launch.
/// To stay compliant we register both BG identifiers from the AppDelegate
/// hook here, and forward the tasks to the module via a static handler that
/// the module installs once it's instantiated.
public class BackgroundUploadAppDelegateSubscriber: ExpoAppDelegateSubscriber {
    static var completionHandlers: [String: () -> Void] = [:]

    /// Module fills these in during OnCreate. If iOS fires a task before the
    /// JS bridge / module is ready, we hold the task in `pendingTasks` and
    /// flush it as soon as a handler arrives.
    public static var refreshHandler: ((BGAppRefreshTask) -> Void)?
    public static var processingHandler: ((BGProcessingTask) -> Void)?
    private static var pendingRefreshTasks: [BGAppRefreshTask] = []
    private static var pendingProcessingTasks: [BGProcessingTask] = []

    private static var didRegisterBGTasks = false

    public func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        BackgroundUploadAppDelegateSubscriber.registerBGTasksOnce()
        return true
    }

    /// Idempotent BG task registration. Safe to call from multiple paths.
    static func registerBGTasksOnce() {
        guard !didRegisterBGTasks else { return }
        didRegisterBGTasks = true

        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: "com.onemundo.mail.backup.refresh",
            using: nil
        ) { task in
            guard let bgTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false); return
            }
            if let handler = BackgroundUploadAppDelegateSubscriber.refreshHandler {
                handler(bgTask)
            } else {
                BackgroundUploadAppDelegateSubscriber.pendingRefreshTasks.append(bgTask)
            }
        }

        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: "com.onemundo.mail.backup.processing",
            using: nil
        ) { task in
            guard let bgTask = task as? BGProcessingTask else {
                task.setTaskCompleted(success: false); return
            }
            if let handler = BackgroundUploadAppDelegateSubscriber.processingHandler {
                handler(bgTask)
            } else {
                BackgroundUploadAppDelegateSubscriber.pendingProcessingTasks.append(bgTask)
            }
        }
    }

    /// Called by the module once it's alive — flushes any tasks that fired
    /// before JS was ready.
    static func flushPendingTasks() {
        if let handler = refreshHandler {
            for task in pendingRefreshTasks { handler(task) }
            pendingRefreshTasks.removeAll()
        }
        if let handler = processingHandler {
            for task in pendingProcessingTasks { handler(task) }
            pendingProcessingTasks.removeAll()
        }
    }

    public func application(
        _ application: UIApplication,
        handleEventsForBackgroundURLSession identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        guard identifier == "com.onemundo.mail.bgUpload" else { return }
        BackgroundUploadAppDelegateSubscriber.completionHandlers[identifier] = completionHandler
    }
}
