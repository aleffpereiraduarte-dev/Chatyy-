// CallIntentAppDelegateSubscriber.swift — [2026-10-09 recents-redial]
// Tapping a Chatyy entry in Phone.app Recents (includesCallsInRecents=true),
// a CarPlay/Siri redial or a Contacts "Chatyy" call action launches the app
// with an NSUserActivity carrying INStartCallIntent. Until now nothing
// handled it — the app just opened. We hand it to CallRecentsIntentStore,
// which resolves the CallKit handle back to a Chatyy account and notifies JS
// (onStartCallIntent / consumePendingStartCallIntent).
//
// Registered in expo-module.config.json → appDelegateSubscribers.

import ExpoModulesCore
import UIKit

public class CallIntentAppDelegateSubscriber: ExpoAppDelegateSubscriber {
    public func application(
        _ application: UIApplication,
        continue userActivity: NSUserActivity,
        restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
    ) -> Bool {
        let handled = CallRecentsIntentStore.handle(userActivity: userActivity)
        // ExpoAppDelegateSubscriberManager aggregates one handler call per
        // responding subscriber — always call it exactly once.
        restorationHandler(nil)
        return handled
    }
}
