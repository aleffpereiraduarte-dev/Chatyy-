import ExpoModulesCore
import UIKit

/// [2026-10-12 find-my] Ganchos de AppDelegate do Mapa de amigos (iOS).
///
/// 1. didFinishLaunching → FriendLocationAgent.onLaunch: quando o iOS relança
///    o app em 2º plano por mudança significativa de localização / visita
///    (launchOptions[.location]), recria o CLLocationManager e religa o
///    monitoramento para receber o evento — sem esperar o JS.
/// 2. didReceiveRemoteNotification (push silencioso, apns-push-type
///    background, content-available=1) com type=location_ping → pede UMA
///    posição (requestLocation) e publica em Swift. Qualquer outro push →
///    .noData imediato (o ExpoAppDelegateSubscriberManager agrega os
///    completionHandlers de todos os subscribers; cada um chama 1x).
public class FriendLocationAppDelegateSubscriber: ExpoAppDelegateSubscriber {

    public func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let forLocation = launchOptions?[UIApplication.LaunchOptionsKey.location] != nil
        FriendLocationAgent.shared.onLaunch(relaunchedForLocation: forLocation)
        return true
    }

    public func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        guard FriendLocationAgent.isPingPush(userInfo) else {
            completionHandler(.noData)
            return
        }
        NSLog("[FriendLocation] location_ping push")
        FriendLocationAgent.shared.handlePing { ok in
            completionHandler(ok ? .newData : .noData)
        }
    }
}
