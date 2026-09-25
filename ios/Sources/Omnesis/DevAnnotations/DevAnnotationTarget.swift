// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The entity a developer annotation points at — the iOS analogue of the
/// portal's `deriveDevTarget`. A detail view publishes its target into the
/// `AppStore` (`.devTarget(_:)`); shake-to-annotate reads whatever is current
/// and files a note against it. When no entity is in focus the composer files
/// a free-form `route` note instead, so a note can always be captured.
///
/// Pure `Foundation` (no UIKit/SwiftUI) so it compiles and unit-tests on the
/// sim-less macOS logic lane. The `type` strings mirror the gateway's
/// `DEV_ANNOTATION_TARGET_TYPES`.
public struct DevAnnotationTarget: Equatable, Sendable {
    public let type: String
    public let id: String?
    public let label: String

    public init(type: String, id: String?, label: String) {
        self.type = type
        self.id = id
        self.label = label
    }

    public static func document(_ id: String, label: String? = nil) -> DevAnnotationTarget {
        .init(type: "document", id: id, label: label ?? "Document \(id)")
    }

    public static func brief(_ id: String, label: String? = nil) -> DevAnnotationTarget {
        .init(type: "brief", id: id, label: label ?? "Brief \(id)")
    }

    public static func openLoop(_ id: String, label: String? = nil) -> DevAnnotationTarget {
        .init(type: "open_loop", id: id, label: label ?? "Loop \(id)")
    }

    public static func retiredLoop(_ id: String, label: String? = nil) -> DevAnnotationTarget {
        .init(type: "retired_loop", id: id, label: label ?? "Retired loop \(id)")
    }

    /// The singleton steward notes blob — no row id.
    public static func agentNotes(label: String = "Agent notes") -> DevAnnotationTarget {
        .init(type: "agent_notes", id: nil, label: label)
    }

    public static func agentRun(_ id: String, label: String? = nil) -> DevAnnotationTarget {
        .init(type: "agent_run", id: id, label: label ?? "Run \(id)")
    }

    public static func firing(_ id: String, label: String? = nil) -> DevAnnotationTarget {
        .init(type: "firing", id: id, label: label ?? "Firing \(id)")
    }

    public static func temporalAnnotation(_ id: String, label: String? = nil) -> DevAnnotationTarget {
        .init(type: "temporal_annotation", id: id, label: label ?? "Temporal annotation \(id)")
    }

    public static func conversation(_ id: String, label: String? = nil) -> DevAnnotationTarget {
        .init(type: "conversation", id: id, label: label ?? "Conversation \(id)")
    }

    /// Free-form note tagged with the current screen — the fallback when no
    /// addressable entity is in focus.
    public static func route(_ label: String) -> DevAnnotationTarget {
        .init(type: "route", id: nil, label: label)
    }
}
