// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Observation

/// Watch deep links. Both legacy links enter the unified complication
/// recorder; in-app controls use these cases to retain their explicit flows.
/// Shared with the widget extension so link validation stays identical.
public enum WatchComplication: String, CaseIterable, Sendable {
    /// Ask Omnesis a question; the answer is shown and spoken on the wrist.
    case ask
    /// Tell Omnesis something to remember.
    case note

    public static let scheme = "omnesis-watch"

    /// `omnesis-watch://ask` or `omnesis-watch://note`.
    public var url: URL {
        // Built from constants, so it cannot fail.
        URL(string: "\(Self.scheme)://\(rawValue)")!
    }

    /// The complication a received link names, or nil for anything else.
    /// Strict: a link with anything beyond the scheme and host — a path,
    /// query, fragment, user or port — is not one this app produces, and
    /// acting on it would start dictation nobody asked for.
    public init?(url: URL) {
        guard url.scheme?.lowercased() == Self.scheme,
              let host = url.host?.lowercased(),
              let complication = WatchComplication(rawValue: host),
              url.path.isEmpty, url.query == nil, url.fragment == nil,
              url.user == nil, url.password == nil, url.port == nil
        else {
            return nil
        }
        self = complication
    }
}

/// Foreground controls can arrive before the watch's scene exists. Keep the
/// request until that scene consumes it, and merge repeated taps into one launch.
@available(iOS 17.0, macOS 14.0, watchOS 10.0, *)
@MainActor @Observable
final class WatchControlRouter {
    static let shared = WatchControlRouter()
    private(set) var requestCount = 0
    private var consumedCount = 0
    private var requestedAt: Date?
    static let freshnessWindow: TimeInterval = 30

    func requestCapture(at date: Date = Date()) {
        requestedAt = date
        requestCount += 1
    }

    func consume(asOf now: Date = Date()) -> Bool {
        guard requestCount > consumedCount else { return false }
        consumedCount = requestCount
        guard let requestedAt else { return false }
        return now.timeIntervalSince(requestedAt) < Self.freshnessWindow
    }
}

#if os(watchOS)
import AppIntents

@available(watchOS 26.0, *)
enum WatchControlDestination: String, AppEnum {
    case capture

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Omnesis"
    static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .capture: DisplayRepresentation(title: "Voice input"),
    ]
}

/// Dual membership with the watch app and its WidgetKit extension lets the
/// system execute this opening intent in the app, where its scene handles it.
@available(watchOS 26.0, *)
struct OpenWatchCaptureControlIntent: OpenIntent {
    static let title: LocalizedStringResource = "Speak to Omnesis"
    static let isDiscoverable = false
    static let openAppWhenRun = true

    @Parameter(title: "Target")
    var target: WatchControlDestination

    init() {
        target = .capture
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        WatchControlRouter.shared.requestCapture()
        return .result()
    }
}
#endif
