// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

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
