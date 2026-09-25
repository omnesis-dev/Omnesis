// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import OSLog

/// Minimal logger wrapping Apple's `os.Logger`. Gives us structured,
/// category-prefixed logs visible in Console.app and via `log stream
/// --predicate 'subsystem == "dev.omnesis.ios"'`.
///
/// Each Omnesis component grabs one of these with its own category:
///   let log = AppLog.make(category: "pairing")
///
/// # Privacy annotations
///
/// `os.Logger` redacts interpolated values to `<private>` by default on
/// release builds. Pick the right annotation per type so the macOS
/// Console app shows useful diagnostics without leaking PII.
///
/// - **`.public`** — non-PII identifiers and operational values: source
///   IDs (`"gmail:foo@bar.com"`), batch IDs, sync state strings, status
///   codes, byte counts, durations, type names, log levels.
/// - **`.private`** — PII or user content: email body, document title,
///   error message text, hostnames the user typed, account-resolved
///   emails. Use `.private(mask: .hash)` when you need stable
///   correlation across log lines without exposing the value.
/// - **default (no annotation)** — anything you're unsure about; the
///   runtime redacts to `<private>` on release builds, which is the
///   safer fallback.
///
/// Source IDs in this codebase happen to embed an account email
/// (`"gmail:foo@bar.com"`) and are still treated as `.public` because
/// they are operational identifiers the user is expected to see in the
/// portal / CLI. If a future source format puts free-form user content
/// in the ID, reconsider.
public enum AppLog {
    public static let subsystem = "dev.omnesis.ios"

    public static func make(category: String) -> Logger {
        Logger(subsystem: subsystem, category: category)
    }
}
