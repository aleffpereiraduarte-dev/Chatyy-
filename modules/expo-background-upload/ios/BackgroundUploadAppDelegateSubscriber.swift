import ExpoModulesCore
import UIKit

public class BackgroundUploadAppDelegateSubscriber: ExpoAppDelegateSubscriber {
    static var completionHandlers: [String: () -> Void] = [:]

    public func application(
        _ application: UIApplication,
        handleEventsForBackgroundURLSession identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        guard identifier.hasPrefix("com.onemundo.mail.bgUpload.") else { return }
        BackgroundUploadAppDelegateSubscriber.completionHandlers[identifier] = completionHandler
    }
}
