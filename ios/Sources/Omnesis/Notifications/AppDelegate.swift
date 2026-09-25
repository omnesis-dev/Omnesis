// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(UIKit)
import Foundation
import OSLog
import UIKit
import UserNotifications

/// `UIApplicationDelegateAdaptor`-bridged delegate. Owns the two
/// callbacks SwiftUI alone cannot offer:
///
///   1. `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`
///      — fires once iOS has minted an APNs device token. We hand it
///      to `PushRegistrar` (set externally by the app on pair) which
///      POSTs the token to the gateway.
///
///   2. `userNotificationCenter(_:didReceive:withCompletionHandler:)`
///      — fires when the user taps an Omnesis push. We parse the
///      `omnesis` custom-data dict and write the target into the
///      shared `NotificationRouter` so the SwiftUI tree picks it up.
///
/// Foreground presentation is also handled here: when a push arrives
/// while the app is already open we tell iOS to render the banner +
/// play the sound anyway. Without this, foreground pushes are
/// silently swallowed.
@available(iOS 17.0, *)
public final class OmnesisAppDelegate: NSObject, UIApplicationDelegate {
    /// Closure invoked when iOS hands back the APNs device token.
    /// The app wires this to a closure that calls
    /// `PushRegistrar.report(...)`.
    public var onDidRegisterToken: (@Sendable (Data) -> Void)?

    /// Closure invoked when iOS fails to register for remote
    /// notifications (no entitlement, no network, etc.). The app
    /// usually just logs this — registration retries on next launch.
    public var onDidFailRegister: (@Sendable (Error) -> Void)?

    /// Relay enrolment challenges are data-only background pushes. Persist one
    /// arriving during cold launch until `AppStore` binds the coordinator.
    /// The callback returns true only after verification and gateway storage;
    /// otherwise the nonce remains durable for the next launch retry.
    public var onDidReceiveRelayChallenge: (@Sendable (String) async -> Bool)? {
        didSet {
            guard let callback = onDidReceiveRelayChallenge,
                  let nonce = try? relayChallengeStore.get(relayChallengeKey),
                  !nonce.isEmpty else { return }
            Task { [weak self] in
                if await callback(nonce) {
                    try? self?.relayChallengeStore.delete(self?.relayChallengeKey ?? "")
                }
            }
        }
    }

    /// Closure invoked when the user taps an Omnesis push and the
    /// payload's `omnesis` dict parses into a known target. iOS
    /// delivers `didReceive` very early at cold-start — before
    /// SwiftUI's `.task` runs and `AppStore.bindAppDelegate` wires
    /// the closure. We buffer any pre-bind target in
    /// `bufferedTarget`; the property's `didSet` drains it as soon
    /// as the callback is wired.
    public var onDidReceiveTarget: (@Sendable (PushTarget) -> Void)? {
        didSet {
            guard let cb = onDidReceiveTarget, let target = bufferedTarget else { return }
            bufferedTarget = nil
            cb(target)
        }
    }

    /// Pre-bind buffer for notification-tap targets. Set by
    /// `didReceive` when no callback is wired yet; drained by the
    /// `onDidReceiveTarget` setter as soon as one is.
    private var bufferedTarget: PushTarget?
    private let relayChallengeStore = Keychain(service: "dev.omnesis.ios.push-registration")
    private let relayChallengeKey = "push.registration.challenge-nonce.v1"

    public func application(
        _: UIApplication,
        didFinishLaunchingWithOptions _: [UIApplication.LaunchOptionsKey: Any]?
    )
        -> Bool {
        // Hook the notification-center delegate so we get the tap
        // callback. Permission is requested only when the user turns
        // notifications on (see AppStore.requestNotificationPermission).
        UNUserNotificationCenter.current().delegate = self
        #if DEBUG
        PushSpikeInspector.runIfRequested()
        #endif
        return true
    }

    public func application(
        _: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        onDidRegisterToken?(deviceToken)
    }

    public func application(
        _: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        onDidFailRegister?(error)
    }

    public func application(
        _: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        guard let payload = userInfo["omnesis"] as? [String: Any],
              payload["kind"] as? String == "relay-enrol-challenge",
              let nonce = payload["nonce"] as? String,
              !nonce.isEmpty,
              nonce.count <= 4096
        else {
            completionHandler(.noData)
            return
        }
        // Commit before scheduling asynchronous verification. If iOS suspends
        // this process after the fetch callback, the next launch can resume.
        try? relayChallengeStore.set(nonce, forKey: relayChallengeKey)
        guard let callback = onDidReceiveRelayChallenge else {
            completionHandler(.newData)
            return
        }
        Task { [weak self] in
            if await callback(nonce) {
                try? self?.relayChallengeStore.delete(self?.relayChallengeKey ?? "")
            }
            completionHandler(.newData)
        }
    }
}

@available(iOS 17.0, *)
extension OmnesisAppDelegate: UNUserNotificationCenterDelegate {
    /// Foreground presentation: when the app is in the foreground
    /// and APNs delivers a push, iOS would otherwise silently drop
    /// it. Request both immediate banner presentation and Notification Center
    /// placement, matching the surfaces accepted by the claim policy.
    public func userNotificationCenter(
        _: UNUserNotificationCenter,
        willPresent _: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler(NotificationPresentationPolicy.foregroundOptions)
    }

    /// User tapped (or interacted with) a notification.
    public func userNotificationCenter(
        _: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        defer { completionHandler() }
        handleNotificationTap(userInfo: response.notification.request.content.userInfo)
    }

    /// Parse the tapped notification's `omnesis` dict; fire the target
    /// callback if we recognise it. Every branch logs — a tap that goes
    /// nowhere must be visible in Console, not a silent normal launch.
    ///
    /// Separate from the `didReceive` delegate callback so the push-tap
    /// harness (`PushTapDemoRoot`) can drive the exact production path
    /// with a crafted payload — a `UNNotificationResponse` cannot be
    /// constructed in tests.
    ///
    /// Log privacy: the target KIND is `.public`; the full target
    /// (which carries ids — the privacy-approval id in particular is
    /// payload data) stays default-redacted outside debug Console use.
    func handleNotificationTap(userInfo: [AnyHashable: Any]) {
        let log = AppLog.make(category: "push")
        guard let target = PushTarget.fromUserInfo(userInfo) else {
            // Non-Omnesis or malformed payload: the tap falls through to
            // a normal app open. An `omnesis` dict that was present but
            // didn't parse is a payload-contract break worth flagging.
            if userInfo["omnesis"] != nil {
                log.warning("Notification tap carried an unrecognised omnesis payload — opening normally")
            }
            return
        }
        if let cb = onDidReceiveTarget {
            log.info("Notification tap → \(target.kindName, privacy: .public)")
            cb(target)
        } else {
            // Pre-bind cold start — the callback hasn't been
            // wired yet (SwiftUI's `.task` runs slightly after
            // `didReceive`). Buffer; the setter drains it.
            log.info("Notification tap pre-bind → buffered \(target.kindName, privacy: .public)")
            bufferedTarget = target
        }
    }
}
#endif
