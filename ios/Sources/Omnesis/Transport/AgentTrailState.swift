// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

// MARK: - Trail aggregation state

//
// Mirrors the portal reducer's `trailAnnotations` shape (see
// `packages/gateway/portal/js/views/agent-reducer.js`). The Citations
// drawer reads these to render the Timeline tab — fed ONLY by the
// agent's explicit `annotate` / `cite_record` citations, never by the
// raw output of a `trace_connections` graph walk.

/// A single quote + optional "why this matters" note. Multiple
/// `annotate(documentId, quote, ...)` calls with the same `documentId`
/// accumulate as multiple `AgentQuoteEntry`s in the slot below.
public struct AgentQuoteEntry: Sendable, Equatable, Hashable {
    public let quote: String
    public let note: String?
    public let quoteAuthor: String?
    /// True when the quoted words are the user's own — the gateway sets
    /// `quoteIsSelf` on the `agent.citation` / `annotate.recorded`
    /// payload when the cited author resolves to self. The Timeline
    /// renders self-authored chat quotes as a right-aligned "sent"
    /// bubble.
    public let quoteIsSelf: Bool

    public init(
        quote: String,
        note: String?,
        quoteAuthor: String?,
        quoteIsSelf: Bool = false
    ) {
        self.quote = quote
        self.note = note
        self.quoteAuthor = quoteAuthor
        self.quoteIsSelf = quoteIsSelf
    }
}

/// Annotation bucket for one document — fed by `annotate(documentId, …)`
/// results. `note` is the doc-level caption (last-write wins); the
/// `quotes` array accumulates verbatim excerpts. `ref` is captured
/// from the first `annotate.recorded` for that documentId — the
/// unified Timeline reads it to synthesise the document's row.
public struct AgentDocAnnotations: Sendable, Equatable, Hashable {
    public var ref: AgentDocRef?
    public var note: String?
    public var quotes: [AgentQuoteEntry]

    public init(
        ref: AgentDocRef? = nil,
        note: String? = nil,
        quotes: [AgentQuoteEntry] = []
    ) {
        self.ref = ref
        self.note = note
        self.quotes = quotes
    }
}

/// Live aggregate of every annotation the agent has recorded in the
/// current conversation. The Timeline view projects these onto
/// matching doc rows; the Citations view derives its doc-keyed
/// rollup from the same bucket.
public struct AgentTrailAnnotations: Sendable, Equatable, Hashable {
    public var byDoc: [String: AgentDocAnnotations]

    public init(byDoc: [String: AgentDocAnnotations] = [:]) {
        self.byDoc = byDoc
    }

    /// Empty starting state used by the coordinator on reset / new
    /// conversation / first construction.
    public static let empty = AgentTrailAnnotations()

    // MARK: - Mutation helpers

    /// Apply one `annotate.recorded` tool result to the byDoc bucket.
    /// The `ref` is captured on the first call for each documentId so
    /// the unified Timeline can synthesise the document's row.
    public mutating func applyDocAnnotation(
        documentId: String,
        ref: AgentDocRef?,
        quote: String?,
        note: String?,
        quoteAuthor: String? = nil,
        quoteIsSelf: Bool = false
    ) {
        var slot = byDoc[documentId] ?? AgentDocAnnotations()
        if let ref, slot.ref == nil {
            slot.ref = ref
        }
        if let quote {
            slot.quotes.append(AgentQuoteEntry(
                quote: quote,
                note: note,
                quoteAuthor: quoteAuthor,
                quoteIsSelf: quoteIsSelf
            ))
        } else if let note {
            slot.note = note
        }
        byDoc[documentId] = slot
    }
}

// MARK: - Unified Timeline builder

/// Compute the unified Timeline event list from the doc-level annotation
/// bucket (`annotate.recorded`) + the directly-cited record bucket
/// (`cite_record.recorded`). These are the ONLY inputs — a
/// `trace_connections` graph walk's raw output never reaches the Timeline;
/// the agent must deliberately cite what its answer rests on.
///
/// Algorithm (matches the portal's `buildUnifiedTimeline` so portal +
/// iOS render identical rows):
///
///   1. For each `cite_record.recorded` record, synthesise a record-only
///      `AgentTrailEvent` (eventId = the recordKey, at = semanticTime, the
///      `AgentTrailRecord` in `record`, nil doc, empty
///      attachments/people/related). Deduped by `recordKey`, first
///      occurrence wins.
///   2. For each documentId in `byDoc` with a captured `ref`, synthesise a
///      bare `AgentTrailEvent`:
///        eventId   = "synth:doc:<documentId>"
///        at        = ref.ts (epoch ms) → ISO 8601 (or nil)
///        kind      = "document"
///        doc       = AgentTrailEventDoc mapped from ref
///        people, attachments, related = []
///   3. Sort by `at` ascending; events with nil `at` go to the bottom in
///      deterministic (entity id) order so the visual order is stable
///      across renders.
///
/// The view treats synthesised document rows and record rows identically.
public enum AgentTimelineBuilder {
    public static func buildUnifiedTimeline(
        byDoc: [String: AgentDocAnnotations],
        records: [AgentTrailRecord] = []
    )
        -> [AgentTrailEvent] {
        var eventOrder: [String] = []
        var eventByEntityId: [String: AgentTrailEvent] = [:]
        // Directly-cited analytics rows (`cite_record`): one
        // record-only event each, deduped by recordKey (first wins).
        for record in records {
            let key = record.recordKey
            if eventByEntityId[key] != nil { continue }
            eventOrder.append(key)
            eventByEntityId[key] = synthesisedRecordEvent(record: record)
        }
        // Annotated documents (`annotate`): one synthesised doc row per
        // annotated documentId. This is the ONLY way a document reaches the
        // Timeline.
        for (documentId, slot) in byDoc {
            guard let ref = slot.ref else { continue }
            if eventByEntityId[documentId] == nil {
                eventOrder.append(documentId)
            }
            eventByEntityId[documentId] = synthesisedTrailEvent(documentId: documentId, ref: ref)
        }
        let events = eventOrder.compactMap { eventByEntityId[$0] }
        return events.sorted(by: compareTrailEventsByAt)
    }

    /// Build a record-only event for a directly-cited row. The
    /// row's `semanticTime` (always present on a recorded citation) drives
    /// `at` so the row interleaves chronologically with document events.
    private static func synthesisedRecordEvent(
        record: AgentTrailRecord
    )
        -> AgentTrailEvent {
        AgentTrailEvent(
            eventId: "cite:\(record.recordKey)",
            at: record.semanticTime,
            kind: "record",
            doc: nil,
            record: record,
            attachments: [],
            people: [],
            related: []
        )
    }

    private static func synthesisedTrailEvent(
        documentId: String,
        ref: AgentDocRef
    )
        -> AgentTrailEvent {
        // `AgentDocRef.ts` is epoch milliseconds; `AgentTrailEvent.at`
        // is ISO-8601. Convert so synthesised rows sort cleanly
        // alongside real trail events.
        let atIso: String? = {
            guard let ts = ref.ts else { return nil }
            let date = Date(timeIntervalSince1970: ts / 1000.0)
            return Self.isoFormatter.string(from: date)
        }()
        let doc = AgentTrailEventDoc(
            documentId: documentId,
            title: ref.title ?? "",
            sourceId: ref.sourceId,
            sourceUrl: ref.url,
            appUrl: ref.appUrl,
            documentType: ref.documentType,
            mimeType: ref.mimeType
        )
        return AgentTrailEvent(
            eventId: "synth:doc:\(documentId)",
            at: atIso,
            kind: "document",
            doc: doc,
            attachments: [],
            people: [],
            related: []
        )
    }

    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static func compareTrailEventsByAt(
        _ a: AgentTrailEvent,
        _ b: AgentTrailEvent
    )
        -> Bool {
        switch (a.at, b.at) {
        case (nil, nil):
            a.entityId < b.entityId
        case (nil, _):
            false
        case (_, nil):
            true
        case (let lhs?, let rhs?):
            // Tiebreak on entityId when timestamps are equal: `byDoc` is an
            // unordered dictionary and Swift's `sorted(by:)` is not stable, so
            // without this two same-timestamp rows would order nondeterministically.
            lhs == rhs ? a.entityId < b.entityId : lhs < rhs
        }
    }
}

public enum AgentTrailLinkFormat {
    private static let duplicateLikeLinkTypes: Set<String> = [
        "duplicate-content", "same-resource", "near-duplicate",
    ]

    public static func isDuplicateLike(_ linkType: String) -> Bool {
        duplicateLikeLinkTypes.contains(linkType)
    }

    public static func phrase(linkType: String, direction: String) -> String {
        if linkType == "url", direction == "in" { return "cited by" }
        switch linkType {
        case "attachment": return "attached to"
        case "email-thread": return "in same thread as"
        case "intra-source": return "links to"
        case "calendar-event": return "matches event"
        case "url": return "cites"
        case "duplicate-content": return "duplicate of"
        case "same-resource": return "another representation of"
        case "near-duplicate": return "near-duplicate of"
        default: return linkType
        }
    }
}
