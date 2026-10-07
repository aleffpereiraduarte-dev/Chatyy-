import ExpoModulesCore
import UIKit
import BackgroundTasks

/// [2026-10-07 bgsync] Registers the chat BGAppRefreshTask
/// (`com.onemundo.mail.chat.refresh`) — Apple requires
/// `BGTaskScheduler.register` BEFORE didFinishLaunching returns (iOS 18 kills
/// the app otherwise; see BackgroundUploadAppDelegateSubscriber). The
/// identifier MUST be listed in Info.plist BGTaskSchedulerPermittedIdentifiers
/// (plugins/with-bg-chat-sync.js) or `register` raises — guarded below.
/// Scheduling happens on every background transition (when JS enabled it via
/// bgSyncSchedule(true)); the handler re-schedules itself.
public class ChatBgSyncAppDelegateSubscriber: ExpoAppDelegateSubscriber {
    private static var didRegister = false

    public func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        Self.registerOnce()
        return true
    }

    public func applicationDidEnterBackground(_ application: UIApplication) {
        guard Self.didRegister else { return }
        ChatBgJournal.scheduleRefresh()
    }

    static func registerOnce() {
        guard !didRegister else { return }
        // register() throws an ObjC exception if the id is not permitted in
        // Info.plist — check first so a binary built without the plugin can
        // never crash at launch.
        let permitted = (Bundle.main.object(forInfoDictionaryKey: "BGTaskSchedulerPermittedIdentifiers") as? [String]) ?? []
        guard permitted.contains(ChatBgJournal.refreshTaskId) else { return }
        didRegister = BGTaskScheduler.shared.register(forTaskWithIdentifier: ChatBgJournal.refreshTaskId, using: nil) { task in
            guard let t = task as? BGAppRefreshTask else { task.setTaskCompleted(success: false); return }
            ChatBgJournal.handleRefresh(t)
        }
    }

    static var isRegistered: Bool { didRegister }
}
