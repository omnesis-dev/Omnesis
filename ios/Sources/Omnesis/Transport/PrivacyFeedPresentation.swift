// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The questions an operator asks when narrowing the privacy activity feed.
enum PrivacyFeedFilter: String, CaseIterable, Identifiable, Sendable {
    case all
    case shared
    case notShared = "not_shared"
    case failed
    case waiting

    var id: String {
        rawValue
    }

    var label: String {
        switch self {
        case .all: "All"
        case .shared: "Shared"
        case .notShared: "Not shared"
        case .failed: "Failed"
        case .waiting: "Waiting"
        }
    }
}

/// Whether an exchange belongs under one filter. An outcome introduced by a
/// newer gateway remains visible under every filter rather than disappearing.
func privacyFeedFilterMatches(
    _ filter: PrivacyFeedFilter,
    exchange: PrivacyExchangePresentation
)
    -> Bool {
    guard filter != .all else { return true }
    let bucket: PrivacyFeedFilter? = switch exchange.outcome {
    case .shared, .sharedWithReductions:
        .shared
    case .notShared, .canceled:
        .notShared
    case .failed:
        .failed
    case .checking, .ready, .needsReview:
        .waiting
    case .unknown:
        nil
    }
    return bucket == nil || bucket == filter
}

/// Feed rows already name the caller, so their compact outcome does not repeat
/// it. Detail screens continue to use `privacyExchangeOutcomeDisplay`.
func privacyFeedOutcomeDisplay(
    _ exchange: PrivacyExchangePresentation
)
    -> PrivacyOutcomeDisplay {
    let display = privacyExchangeOutcomeDisplay(exchange)
    switch exchange.outcome {
    case .ready:
        return PrivacyOutcomeDisplay(tone: display.tone, label: "Approved, waiting")
    case .shared:
        return PrivacyOutcomeDisplay(tone: display.tone, label: "Shared")
    case .sharedWithReductions:
        return PrivacyOutcomeDisplay(tone: display.tone, label: "Shared, details removed")
    case .unknown:
        return PrivacyOutcomeDisplay(tone: .waiting, label: "Outcome not recognised")
    default:
        return display
    }
}

/// Outcomes quiet enough to render as a labelled mark. A review, failure, or
/// unknown outcome keeps the stronger chip treatment.
func privacyFeedOutcomeIsQuiet(_ outcome: PrivacyExchangeOutcome) -> Bool {
    switch outcome {
    case .checking, .ready, .shared, .sharedWithReductions, .notShared, .canceled:
        true
    case .needsReview, .failed, .unknown:
        false
    }
}

struct PrivacyFeedDay: Identifiable, Equatable, Sendable {
    let id: String
    let heading: String
    var exchanges: [PrivacyExchangePresentation]
}

/// Groups feed rows into local calendar days, preserving each day's first
/// position and the order of rows inside it.
func privacyFeedDays(
    _ exchanges: [PrivacyExchangePresentation],
    now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
)
    -> [PrivacyFeedDay] {
    var result: [PrivacyFeedDay] = []
    var indexByKey: [String: Int] = [:]
    for exchange in exchanges {
        let at = exchange.presentationTimestamp
        let key = at > 0 ? privacyDayKey(at) : "unknown"
        if let index = indexByKey[key] {
            result[index].exchanges.append(exchange)
        } else {
            indexByKey[key] = result.count
            result.append(
                PrivacyFeedDay(
                    id: key,
                    heading: privacyFeedDayHeading(at, now: now),
                    exchanges: [exchange]
                )
            )
        }
    }
    return result
}

func privacyFeedDayHeading(_ millis: Int64, now: Int64) -> String {
    guard millis > 0 else { return "Date unknown" }
    if privacyDayKey(millis) == privacyDayKey(now) { return "Today" }

    let calendar = Calendar.current
    let nowDate = Date(timeIntervalSince1970: Double(now) / 1000)
    if let yesterday = calendar.date(byAdding: .day, value: -1, to: nowDate),
       privacyDayKey(millis) == privacyDayKey(Int64(yesterday.timeIntervalSince1970 * 1000)) {
        return "Yesterday"
    }

    let date = Date(timeIntervalSince1970: Double(millis) / 1000)
    if calendar.component(.year, from: date) == calendar.component(.year, from: nowDate) {
        return date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
    }
    return date.formatted(
        .dateTime.weekday(.abbreviated).month(.abbreviated).day().year()
    )
}
