// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The two Apple Watch complications, and the deep link each one opens.
///
/// A complication cannot listen by itself: a widget can only open its own
/// app. So each one opens the watch app at its link, and the app presents
/// the system dictation screen for that flow the moment it is on screen —
/// one tap to talking. The dictated words then take the same relay as the
/// matching Siri shortcut.
///
/// Pure and platform-free so the sim-less logic lane covers the link
/// contract, and so the widget extension (which builds the links) and the
/// watch app (which reads them) compile the same definition. The scheme is
/// also declared in the watch app's Info.plist.
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
