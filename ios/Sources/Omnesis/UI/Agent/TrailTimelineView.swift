// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Handler a host installs so taps on a cited title / related row open
/// that document in the in-app viewer. `TrailTimelineView` renders in two
/// navigation contexts — the `CitationsDrawer` (an overlay with NO
/// `NavigationStack` ancestor) and the `DocumentInspectorSheet` Timeline
/// tab (inside a `NavigationStack`). The renderer therefore can't own the
/// navigation itself: the drawer presents the viewer as a sheet, the
/// inspector pushes it. Each host injects the right behavior here; the
/// default no-op is only hit by previews/snapshots, which don't navigate.
private struct OpenTrailDocumentKey: EnvironmentKey {
    static let defaultValue: (String) -> Void = { _ in }
}

extension EnvironmentValues {
    var openTrailDocument: (String) -> Void {
        get { self[OpenTrailDocumentKey.self] }
        set { self[OpenTrailDocumentKey.self] = newValue }
    }
}

/// SwiftUI port of the portal's `TimelineColumn` component. Renders a
/// chronological list of `AgentTrailEvent`s — the agent side-panel's
/// annotated citations, or a document's connection trail in the inspector —
/// with per-source-accent spines that fade between rows when the source
/// changes, transparent source dots, nested attachments with file-type
/// icons, and projected annotations from `annotate` calls.
///
/// Source-agnostic — the visual logic only consumes the closed
/// `kind` / `linkType` / `PersonRole` enums plus the source registry
/// helpers in `AppStore`. New sources light up here automatically as
/// soon as `defineSource()` publishes their accent + icon.
///
/// Two-column grid: spine / content. The spine column carries
/// a 1.5pt vertical line tinted with the event's source accent. When
/// the next row's source differs the bottom 20pt fades into that
/// accent; the first and last rows fade in from / out to transparent.
@available(iOS 17.0, *)
struct TrailTimelineView: View {
    let events: [AgentTrailEvent]
    let annotations: AgentTrailAnnotations
    /// When non-nil, each event row reports its frame (scroll-local
    /// + panel-local midpoint) up the view hierarchy via the
    /// `TrailEventFrameKey` preference. The `CitationsDrawer` opts in
    /// to drive its per-event sticky tabs off these frames; other
    /// hosts (previews, future debugger pages) leave them off so the
    /// timeline doesn't pay the GeometryReader cost.
    var scrollCoordinateSpace: String?
    var panelCoordinateSpace: String?
    /// Doc ids that are actually rendered as rows on this Timeline
    /// (top-level events + nested attachments). When non-nil, the
    /// renderer surfaces only those entries from `event.related[]`
    /// whose target documentId is in this set — i.e. relations that
    /// point at another row already on screen. `nil` means show every
    /// relation the trail surfaced (the /portal/graph debug page's
    /// mode). The drawer auto-computes the set; callers that want the
    /// drawer's behavior pass `inTimelineDocIds(of: events)`.
    var visibleDocIds: Set<String>?

    @Environment(AppStore.self) private var store

    /// Build color map for quote authors by scanning all annotations
    /// in first-seen order. Pure function — call once per render.
    private static func buildQuoteAuthorColorMap(
        events: [AgentTrailEvent],
        annotations: AgentTrailAnnotations
    )
        -> [String: Color] {
        var map: [String: Color] = [:]
        var nextIndex = 0
        func assignIfNeeded(_ author: String?) {
            guard let author, !author.isEmpty, map[author] == nil else { return }
            map[author] = quoteAuthorColors[nextIndex % quoteAuthorColors.count]
            nextIndex += 1
        }
        for event in events {
            if let docId = event.doc?.documentId, let docAnns = annotations.byDoc[docId] {
                for q in docAnns.quotes {
                    assignIfNeeded(q.quoteAuthor)
                }
            }
            for att in event.attachments {
                guard let attDocId = att.doc?.documentId else { continue }
                if let docAnns = annotations.byDoc[attDocId] {
                    for q in docAnns.quotes {
                        assignIfNeeded(q.quoteAuthor)
                    }
                }
            }
        }
        for (_, slot) in annotations.byDoc {
            for q in slot.quotes {
                assignIfNeeded(q.quoteAuthor)
            }
        }
        return map
    }

    var body: some View {
        if events.isEmpty {
            empty
        } else {
            let authorColors = Self.buildQuoteAuthorColorMap(events: events, annotations: annotations)
            let rows = rowsForRender()
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.element.id) { idx, row in
                    rowView(
                        row,
                        isFirst: idx == 0,
                        isLast: idx == rows.count - 1,
                        authorColors: authorColors
                    )
                    // New citations slide in from the trailing edge as the
                    // agent streams them. Only genuinely-new rows animate
                    // (stable `Row.id` identity); the initial batch renders
                    // in place because the controlling `.animation(_:value:)`
                    // fires on change, not on first appearance.
                    .transition(Self.newRowTransition)
                }
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 4)
            .animation(Self.newRowAnimation, value: rows.map(\.id))
        }
    }

    /// Snappy spring for streamed-in citation rows — a short response
    /// with a touch of overshoot reads as "the new evidence just slid in".
    private static let newRowAnimation: Animation = .spring(response: 0.42, dampingFraction: 0.82)
    /// New rows enter from the trailing edge with a fade; removals (rare —
    /// a new conversation clears the list) fade out without sliding.
    private static let newRowTransition: AnyTransition = .asymmetric(
        insertion: .move(edge: .trailing).combined(with: .opacity),
        removal: .opacity
    )

    @ViewBuilder
    private func rowView(
        _ row: Row,
        isFirst: Bool,
        isLast: Bool,
        authorColors: [String: Color]
    )
        -> some View {
        switch row {
        case .header(let date, let accent, let nextAccent):
            TrailTimelineDateHeader(
                date: date,
                accent: accent,
                nextAccent: nextAccent,
                isFirstRow: isFirst,
                isLastRow: isLast
            )
        case .event(let event, let eventIndex, let accent, let nextAccent):
            TrailTimelineRow(
                event: event,
                annotations: annotations,
                accent: accent,
                nextAccent: nextAccent,
                isFirstRow: isFirst,
                isLastRow: isLast,
                visibleDocIds: visibleDocIds,
                quoteAuthorColors: authorColors
            )
            .background(eventFrameReporter(eventIndex: eventIndex))
        }
    }

    /// GeometryReader background that captures each event row's frame
    /// in two coordinate spaces — the scroll's local space for the
    /// in-viewport visibility check and the panel's local space for
    /// the sticky tab's vertical anchor. Skipped (no-op `Color.clear`)
    /// when the host didn't opt into frame reporting.
    @ViewBuilder
    private func eventFrameReporter(eventIndex: Int) -> some View {
        if let scrollName = scrollCoordinateSpace, let panelName = panelCoordinateSpace {
            GeometryReader { proxy in
                let s = proxy.frame(in: .named(scrollName))
                let p = proxy.frame(in: .named(panelName))
                Color.clear.preference(
                    key: TrailEventFrameKey.self,
                    value: [eventIndex: TrailEventFrame(
                        scrollMinY: s.minY,
                        scrollMaxY: s.maxY,
                        // Tab anchors at the source-icon's vertical
                        // centre — same Y as the event's icon + time
                        // label, which sits at the row's top. Anchoring
                        // here (instead of at the row's mid-Y) lines
                        // the tab up with the row's identity row
                        // rather than floating in the middle of the
                        // body content.
                        tabAnchorY: p.minY + TrailTimelineLayout.tabAnchorOffset
                    )]
                )
            }
        } else {
            Color.clear
        }
    }

    private var empty: some View {
        VStack(spacing: 8) {
            Image(systemName: "point.3.connected.trianglepath.dotted")
                .font(.system(size: 30))
                .foregroundStyle(Theme.textMuted)
            Text("No events on this trail")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.textPrimary)
            Text("No connected events were found for this document.")
                .font(.system(size: 11))
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.top, 48)
    }

    // MARK: - Layout building

    private enum Row {
        case header(date: String?, accent: Color, nextAccent: Color)
        case event(event: AgentTrailEvent, eventIndex: Int, accent: Color, nextAccent: Color)

        /// Stable identity used by the `ForEach`. Keying on event id (and
        /// the header's date) rather than the row's ordinal lets SwiftUI
        /// recognise which rows are genuinely new as the agent streams in
        /// fresh citations — so only those animate in, not the whole list
        /// on every update.
        var id: String {
            switch self {
            case .header(let date, _, _): "header:\(date ?? "—")"
            case .event(let event, _, _, _): "event:\(event.eventId)"
            }
        }
    }

    /// Group events by calendar day and emit a date-header row above
    /// each group, then compute `nextAccent` for every row (the accent
    /// of the immediately-following row, used to drive the spine's
    /// bottom 20pt cross-fade gradient when the source changes).
    /// `eventIndex` on event rows is the row's position in the
    /// `events` array (skipping header rows) — used by the host's
    /// sticky-tab layer to key per-event frame reports back to a
    /// specific event.
    private func rowsForRender() -> [Row] {
        var partial: [(kind: PartialKind, accent: Color)] = []
        var currentDayKey: String?
        for (eventIndex, event) in events.enumerated() {
            let accent = sourceAccent(event.eventSourceId)
            let dayKey = TrailTimelineFormat.dayKey(event.at)
            if dayKey != currentDayKey {
                partial.append((.header(date: event.at), accent))
                currentDayKey = dayKey
            }
            partial.append((.event(event, eventIndex), accent))
        }
        var out: [Row] = []
        for (i, item) in partial.enumerated() {
            let nextAccent = i + 1 < partial.count ? partial[i + 1].accent : item.accent
            switch item.kind {
            case .header(let date):
                out.append(.header(date: date, accent: item.accent, nextAccent: nextAccent))
            case .event(let event, let eventIndex):
                out.append(.event(
                    event: event,
                    eventIndex: eventIndex,
                    accent: item.accent,
                    nextAccent: nextAccent
                ))
            }
        }
        return out
    }

    private enum PartialKind {
        case header(date: String?)
        case event(AgentTrailEvent, Int)
    }

    /// Look up the source's accent colour in the registry; fall back
    /// to a muted grey when the source descriptor hasn't yet
    /// advertised one (e.g. mid-bootstrap on a new install) or when the
    /// event carries no source id at all.
    private func sourceAccent(_ sourceId: String?) -> Color {
        guard let sourceId else { return Theme.textMuted }
        let type = sourceTypeFromId(sourceId)
        let hex = store.sourceAccentColorById[sourceId]
            ?? store.sourceAccentColorByType[type]
        if let hex, let color = Color(hex: hex) { return color }
        return Theme.textMuted
    }
}

// MARK: - Shared layout constants

@available(iOS 17.0, *)
enum TrailTimelineLayout {
    /// Width of the spine column. Wide enough to host
    /// the 19pt dot with the source icon centred on the line.
    static let spineColumnWidth: CGFloat = 28

    /// Diameter of the source dot. Matches the portal's `--graph-dot`
    /// 19px disc.
    static let dotDiameter: CGFloat = 19

    /// Vertical spacing between rows. The portal uses a `row-gap` of
    /// 28px; we render slightly tighter at 22pt to suit the narrower
    /// drawer width on phone.
    static let rowGap: CGFloat = 22

    /// Padding above and below the date label. Subtle: the previous
    /// event row already contributes `rowGap` (22pt) of bottom space
    /// above the date, so the date band's own TOP padding is zero —
    /// otherwise the gap above the date stacks to ~40pt and reads as
    /// far heavier than the gap below it. Bottom padding matches
    /// `rowGap` so the space below the date label equals the space
    /// above it (22pt on both sides). The first date in the timeline
    /// has no preceding event to supply the top gap, so the date
    /// header view special-cases `isFirstRow` and injects a 22pt
    /// top padding there only.
    static let dateHeaderTopPadding: CGFloat = 0
    static let dateHeaderBottomPadding: CGFloat = 22
    /// Top padding to use when the date header is the first row in
    /// the timeline (no preceding event provides the `rowGap` strip).
    /// Matches `rowGap` so the very first date band reads with the
    /// same 22pt-above / 22pt-below symmetry as every subsequent one.
    static let dateHeaderTopPaddingFirstRow: CGFloat = 22

    /// Length of the cross-accent gradient at the bottom of each spine
    /// segment. When the next row's accent matches, the gradient is a
    /// solid colour; when it differs, the bottom 20pt fades into that
    /// accent so the spine reads as one continuous line.
    static let spineFadeLength: CGFloat = 20

    /// Common spine line thickness.
    static let spineWidth: CGFloat = 1.5

    /// Opacity applied to the spine accent — matches the portal's
    /// `opacity: 0.55` so the source colour reads as a tint rather
    /// than a vivid stripe.
    static let spineOpacity: Double = 0.55

    /// Vertical offset from a row's top edge to the centre of the
    /// source-icon dot. The dot sits at the top of the spine column
    /// with `padding(.top, 2)` and a `dotDiameter` of 19pt, so its
    /// centre is at `2 + 19/2 = 11.5pt`. The sticky-tab layer pins
    /// each tab's vertical anchor here so the tab visually pairs
    /// with the event's icon + time, not with the centre of the
    /// row's variable-height body.
    static let tabAnchorOffset: CGFloat = 11.5
}

// MARK: - Spine column reusable view

/// A spine segment for one row. Renders a single vertical accent line
/// with: (a) a same-colour body, (b) a 20pt bottom gradient fading
/// into the next row's accent when the colour changes, and (c) an
/// optional fade-in / fade-out mask at the very top / bottom of the
/// timeline so the first/last rows blend into the surrounding panel
/// instead of stopping abruptly.
@available(iOS 17.0, *)
struct TrailSpineSegment: View {
    let accent: Color
    let nextAccent: Color
    let isFirstRow: Bool
    let isLastRow: Bool

    var body: some View {
        Rectangle()
            .fill(LinearGradient(
                stops: [
                    .init(color: accent.opacity(TrailTimelineLayout.spineOpacity), location: 0),
                    .init(color: accent.opacity(TrailTimelineLayout.spineOpacity), location: 0.0001),
                    // Hold the accent until the fade band — relative
                    // positioning since the row's height isn't known
                    // in advance.
                    .init(color: accent.opacity(TrailTimelineLayout.spineOpacity), location: 0.85),
                    .init(color: nextAccent.opacity(TrailTimelineLayout.spineOpacity), location: 1.0),
                ],
                startPoint: .top,
                endPoint: .bottom
            ))
            .frame(width: TrailTimelineLayout.spineWidth)
            .frame(maxHeight: .infinity)
            .mask(spineMask)
    }

    /// Fade-in at the top of the very first row, fade-out at the
    /// bottom of the very last row. Middle rows pass the full opacity
    /// through unchanged so neighbouring spines visually connect.
    @ViewBuilder
    private var spineMask: some View {
        if !isFirstRow, !isLastRow {
            Rectangle()
        } else {
            LinearGradient(
                stops: maskStops,
                startPoint: .top,
                endPoint: .bottom
            )
        }
    }

    private var maskStops: [Gradient.Stop] {
        var stops: [Gradient.Stop] = []
        if isFirstRow {
            stops.append(.init(color: .clear, location: 0))
            stops.append(.init(color: .black, location: 0.22))
        } else {
            stops.append(.init(color: .black, location: 0))
        }
        if isLastRow {
            stops.append(.init(color: .black, location: 0.78))
            stops.append(.init(color: .clear, location: 1.0))
        } else {
            stops.append(.init(color: .black, location: 1.0))
        }
        return stops
    }
}

// MARK: - Date header row

/// Renders one date band ("SAT · DEC 6, 2025"). Shares the same 2
/// column grid as event rows so the spine threads through it; the
/// header has no dot, just the line + the day label.
@available(iOS 17.0, *)
struct TrailTimelineDateHeader: View {
    let date: String?
    let accent: Color
    let nextAccent: Color
    let isFirstRow: Bool
    let isLastRow: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            ZStack(alignment: .top) {
                TrailSpineSegment(
                    accent: accent,
                    nextAccent: nextAccent,
                    isFirstRow: isFirstRow,
                    isLastRow: isLastRow
                )
            }
            .frame(width: TrailTimelineLayout.spineColumnWidth)
            Text(TrailTimelineFormat.dateHeaderLabel(date))
                .font(.system(size: 10, weight: .semibold))
                .textCase(.uppercase)
                .tracking(0.6)
                .foregroundStyle(Theme.textMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
                // Top padding is normally 0 — the previous event row's
                // own `rowGap` bottom padding already supplies the
                // 22pt strip above the date. The very first date in
                // the timeline has no preceding event, so it falls
                // back to a 22pt top padding to keep the above/below
                // symmetry consistent across every date band.
                .padding(
                    .top,
                    isFirstRow
                        ? TrailTimelineLayout.dateHeaderTopPaddingFirstRow
                        : TrailTimelineLayout.dateHeaderTopPadding
                )
                .padding(.bottom, TrailTimelineLayout.dateHeaderBottomPadding)
        }
    }
}

// MARK: - One timeline row

@available(iOS 17.0, *)
struct TrailTimelineRow: View {
    let event: AgentTrailEvent
    let annotations: AgentTrailAnnotations
    let accent: Color
    let nextAccent: Color
    let isFirstRow: Bool
    let isLastRow: Bool
    /// Restrict the per-event "cites X" / "cited by X" line list to
    /// relations whose target documentId is in this set. `nil` shows
    /// every relation; the drawer always passes the in-timeline set.
    var visibleDocIds: Set<String>?
    /// Author→color map built by the parent `TrailTimelineView` so
    /// chat-bubble quotes render author names with sticky colors.
    var quoteAuthorColors: [String: Color] = [:]

    @Environment(AppStore.self) private var store

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            // 1. Spine column — gradient line + transparent dot
            //    with the source icon centred on it.
            spineColumn

            // 2. Content column — title + time/people + annotations +
            //    attachments (nested rows), wrapped in a subtle card.
            VStack(alignment: .leading, spacing: 4) {
                TrailTimelineEventBody(
                    event: event,
                    isAttachment: false,
                    docLevelAnnotations: event.doc.flatMap { annotations.byDoc[$0.documentId] },
                    visibleDocIds: visibleDocIds,
                    store: store,
                    quoteAuthorColors: quoteAuthorColors
                )
                ForEach(event.attachments) { attachment in
                    TrailTimelineAttachment(
                        attachment: attachment,
                        docLevelAnnotations: attachment.doc.flatMap { annotations.byDoc[$0.documentId] },
                        visibleDocIds: visibleDocIds,
                        store: store,
                        quoteAuthorColors: quoteAuthorColors
                    )
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Theme.bgSecondary)
            )
            .padding(.bottom, TrailTimelineLayout.rowGap)
        }
    }

    private var spineColumn: some View {
        ZStack(alignment: .top) {
            TrailSpineSegment(
                accent: accent,
                nextAccent: nextAccent,
                isFirstRow: isFirstRow,
                isLastRow: isLastRow
            )
            // Background-coloured disk sits on top of the spine to
            // visually "cut" the line where the source icon mounts.
            // Slightly larger than the icon so the spine is fully
            // hidden behind it, producing the clean break between
            // segments the portal achieves with `background:
            // var(--bg-primary)` on `.graph-debug-event-dot`.
            Circle()
                .fill(Theme.bgPrimary)
                .frame(
                    width: TrailTimelineLayout.dotDiameter + 4,
                    height: TrailTimelineLayout.dotDiameter + 4
                )
                .padding(.top, 0)
            SourceIconView(
                sourceId: event.eventSourceId ?? "",
                store: store,
                size: TrailTimelineLayout.dotDiameter
            )
            .padding(.top, 2)
        }
        .frame(width: TrailTimelineLayout.spineColumnWidth, alignment: .top)
        .frame(maxHeight: .infinity, alignment: .top)
    }
}

// MARK: - Event body (title + people + annotations)

/// Renders one event's title row + people line + projected
/// annotations. `isAttachment` adds a paperclip prefix; without it,
/// the title is the event's primary doc.
@available(iOS 17.0, *)
struct TrailTimelineEventBody: View {
    let event: AgentTrailEvent
    let isAttachment: Bool
    /// Doc-level annotation from `byDoc` — quotes + optional note
    /// recorded by `annotate(documentId, …)`.
    let docLevelAnnotations: AgentDocAnnotations?
    /// When non-nil, the renderer keeps only those `related[]` entries
    /// whose target documentId is in the set. `nil` shows every
    /// relation. See `TrailTimelineView.visibleDocIds`.
    var visibleDocIds: Set<String>?
    let store: AppStore
    /// Author→color map for chat-bubble quote author labels.
    var quoteAuthorColors: [String: Color] = [:]

    /// Host-installed handler that opens a tapped document in the in-app
    /// viewer. The drawer presents it as a sheet, the inspector pushes it.
    @Environment(\.openTrailDocument) private var openTrailDocument

    /// Doc types that warrant a file-type icon next to the title.
    /// Mirrors the portal's `FILE_LIKE_DOC_TYPES` set.
    private static let fileLikeDocTypes: Set<String> = ["file", "attachment"]
    private var isFileLike: Bool {
        Self.fileLikeDocTypes.contains(event.doc?.documentType ?? "")
    }

    private var showFileIcon: Bool {
        isAttachment || isFileLike
    }

    /// Filter the event's related entries down to outbound pointers
    /// at docs the user can actually click through to on this
    /// Timeline. Two conjoined filters:
    ///   • `visibleDocIds` membership — the target row exists.
    ///   • `direction != "in"` — only the citing side of each pair
    ///     surfaces. A doc that appears as "cited by X" is always
    ///     present on the Timeline for an independent reason (seed,
    ///     attachment, separate annotation) so the inbound line is
    ///     redundant chrome; the citing doc's outbound "cites …"
    ///     line carries the same information already.
    /// When the caller didn't supply a set, surface every relation
    /// — matches the portal's debug-page behaviour.
    private var visibleRelated: [AgentTrailEventRelated] {
        guard let visible = visibleDocIds else { return event.related }
        return event.related.filter { rel in
            visible.contains(rel.documentId) && rel.direction != "in"
        }
    }

    var body: some View {
        // A record-only event (a bound DuckDB row with no
        // co-described document) has no `doc` to head the row — render
        // the record body instead. Records never nest as attachments, so
        // this only fires at top level.
        if event.doc == nil, let record = event.record {
            TrailTimelineRecordBody(record: record, time: event.at)
        } else {
            documentBody
        }
    }

    private var documentBody: some View {
        VStack(alignment: .leading, spacing: 4) {
            titleRow
            if !isAttachment {
                metadataRow
            } else if hasVisiblePeople {
                peopleRow
            }
            // A document that deduped with its same-entity row
            // (one timeline entity, not two) carries the row's derived
            // key fields inline. The record's title is already the doc
            // title — only the declared key columns add information, so
            // we surface those and never re-print the title.
            if !isAttachment, let record = event.record {
                TrailTimelineRecordKeyFields(keyFields: record.keyFields)
            }
            // "cites X" / "cited by X" lines for every related doc
            // that's ALSO a row on this Timeline. Lets a doc explain
            // why it shows up at all ("Omnesis TODO" cites the PDF
            // sitting two rows below).
            ForEach(Array(visibleRelated.enumerated()), id: \.0) { _, rel in
                relatedRow(rel)
            }
            if let docAnnotations = docLevelAnnotations,
               docAnnotations.note != nil || !docAnnotations.quotes.isEmpty {
                docAnnotationBlock(docAnnotations)
            }
        }
    }

    // MARK: - Title row

    /// Tappable title: always pushes the in-app `AgentDocumentDetailView`
    /// — the document viewer is the single entry point to the original
    /// source (via its "Open in source" button). Every cited document is
    /// reachable this way, including sources with no externally-
    /// addressable URL (WhatsApp, Apple Notes, Reminders, Health, …).
    ///
    /// Uses `.onTapGesture` rather than a `Button` because the drawer's
    /// horizontal-close drag gesture (a simultaneous `DragGesture(0)`)
    /// races with the button's permissive movement tolerance — a
    /// finger that lifts off after dragging right to close the panel
    /// would otherwise fire the button on touch-up and pop open the
    /// document under the finger. `TapGesture`'s strict
    /// no-significant-movement contract sidesteps that race.
    private var titleRow: some View {
        titleLabel
            .contentShape(Rectangle())
            .onTapGesture {
                if let docId = event.doc?.documentId {
                    openTrailDocument(docId)
                }
            }
    }

    private var titleLabel: some View {
        HStack(alignment: .top, spacing: 6) {
            if isAttachment {
                Image(systemName: "paperclip")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Theme.textMuted)
                    .padding(.top, 2)
            }
            if showFileIcon {
                FileTypeIcon(
                    mimeType: event.doc?.mimeType,
                    filename: event.doc?.title ?? "",
                    size: 12
                )
                .padding(.top, 1)
                // The file-type swatches (red PDF, blue DOCX,
                // green XLSX, …) read as too much icon density
                // next to the spine's source dots on the narrow
                // drawer width. 0.7 opacity lets the panel
                // background bleed through and quiets the strip
                // without washing the colour cue out.
                .opacity(0.7)
            }
            Text((event.doc?.title.isEmpty ?? true) ? "(untitled)" : (event.doc?.title ?? "(untitled)"))
                .font(.system(size: isAttachment ? 12 : 13, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
                // Strict one-line titles on phone: middle-truncate
                // so the extension stays visible
                // ("This is a long…document.pdf" rather than "This
                // is a long doc…"). The drawer's narrow width
                // can't carry multi-line wrapping gracefully —
                // the spine + time column leave too little room
                // and a two-line title makes every row feel twice
                // as heavy as it is.
                .lineLimit(1)
                .truncationMode(.middle)
                .multilineTextAlignment(.leading)
            Spacer(minLength: 0)
        }
    }

    // MARK: - Metadata row (time + people)

    /// Combined time + people line for top-level events. Shows the
    /// event time followed by people segments, all separated by " · ".
    /// Attachments skip this and fall through to the plain `peopleRow`.
    private var metadataRow: some View {
        let timeStr = TrailTimelineFormat.timeLabel(event.at)
        let peopleParts = visibleBuckets
            .filter { !$0.names.isEmpty }
            .map { bucket in
                let names = bucket.names.joined(separator: ", ")
                return "\(bucket.label) \(names)"
            }
        let parts = (timeStr.isEmpty ? [] : [timeStr]) + peopleParts
        return Text(parts.joined(separator: " · "))
            .font(.system(size: 11))
            .foregroundStyle(Theme.textSecondary)
            .lineLimit(2)
    }

    // MARK: - People row

    /// `by Alice · to Bob, Carol` style line (used for attachments only).
    private var peopleRow: some View {
        Text(TrailTimelineFormat.peopleLine(buckets: visibleBuckets))
            .font(.system(size: 11))
            .foregroundStyle(Theme.textSecondary)
            .lineLimit(2)
    }

    /// Buckets that will actually render — `groupPeopleByBucket` with
    /// "mentions" stripped (see peopleRow doc above).
    private var visibleBuckets: [(label: String, names: [String])] {
        TrailTimelineFormat
            .groupPeopleByBucket(event.people)
            .filter { $0.label != "mentions" }
    }

    private var hasVisiblePeople: Bool {
        visibleBuckets.contains(where: { !$0.names.isEmpty })
    }

    // MARK: - Related row

    /// One "cites X" / "cited by X" line — verb + source-icon prefix +
    /// linked title. Mirrors the portal's `.graph-debug-event-related`
    /// list. Tapping the title opens the source URL if the related
    /// item carries one (we don't have it on `AgentTrailEventRelated`
    /// — only the documentId / title / sourceId), so we fall back to
    /// the in-app `AgentDocumentDetailView`.
    private func relatedRow(_ rel: AgentTrailEventRelated) -> some View {
        let phrase = TrailTimelineFormat.phraseForLinkType(
            linkType: rel.linkType,
            direction: rel.direction
        )
        let isDup = TrailTimelineFormat.isDuplicateLikeLinkType(rel.linkType)
        return HStack(alignment: .top, spacing: 4) {
            if isDup {
                Image(systemName: "link")
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(Theme.textMuted)
                    .opacity(0.7)
                    .padding(.top, 2)
                    .accessibilityHidden(true)
            }
            Text(phrase)
                .font(.system(size: 11))
                .foregroundStyle(Theme.textMuted)
            SourceIconView(sourceId: rel.sourceId, store: store, size: 11)
                .padding(.top, 1)
                .accessibilityHidden(true)
            Text(rel.title.isEmpty ? "(untitled)" : rel.title)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(phrase) \(rel.title.isEmpty ? "untitled document" : rel.title)")
        .accessibilityAddTraits(.isButton)
        .onTapGesture {
            openTrailDocument(rel.documentId)
        }
    }

    // MARK: - Annotations

    private func docAnnotationBlock(_ annotations: AgentDocAnnotations) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let note = annotations.note {
                HStack(alignment: .top, spacing: 3) {
                    Image(systemName: "sparkle")
                        .font(.system(size: 8))
                        .foregroundStyle(Theme.textSecondary)
                        .opacity(0.5)
                        .padding(.top, 3)
                    Text(note)
                        .font(.system(size: 11).italic())
                        .foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            ForEach(Array(annotations.quotes.enumerated()), id: \.0) { _, entry in
                quoteBlock(entry)
            }
        }
        .padding(.top, 2)
    }

    /// Document types that represent chat conversations — quotes from
    /// these render as chat bubbles instead of the vertical-bar style.
    private static let conversationDocTypes: Set<String> = ["conversation"]

    private var isConversation: Bool {
        Self.conversationDocTypes.contains(event.doc?.documentType ?? "")
    }

    @ViewBuilder
    private func quoteBlock(_ entry: AgentQuoteEntry) -> some View {
        if isConversation {
            chatBubbleQuote(entry)
        } else {
            barQuote(entry)
        }
    }

    private func barQuote(_ entry: AgentQuoteEntry) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .top, spacing: 7) {
                Rectangle()
                    .fill(Theme.textMuted.opacity(0.4))
                    .frame(width: 5)
                VStack(alignment: .leading, spacing: 1) {
                    Text(entry.quote)
                        .font(.system(size: 11).italic())
                        .foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let author = entry.quoteAuthor {
                        Text("\u{2014} \(author)")
                            .font(.system(size: 11).italic())
                            .foregroundStyle(Theme.textSecondary)
                    }
                }
            }
            if let qNote = entry.note {
                annotationNoteLabel(qNote, font: .system(size: 10.5))
            }
        }
    }

    private static let bubbleTailWidth: CGFloat = 6

    @ViewBuilder
    private func chatBubbleQuote(_ entry: AgentQuoteEntry) -> some View {
        if entry.quoteIsSelf {
            selfChatBubbleQuote(entry)
        } else {
            otherChatBubbleQuote(entry)
        }
    }

    /// Incoming-style bubble: left-aligned, tail at the bottom-left,
    /// neutral `bgTertiary` fill. Used for quotes attributed to anyone
    /// other than the user.
    private func otherChatBubbleQuote(_ entry: AgentQuoteEntry) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                bubbleBody(entry, alignment: .leading)
                    .padding(.leading, 10 + Self.bubbleTailWidth)
                    .padding(.trailing, 10)
                    .padding(.vertical, 6)
                    .background(
                        ChatBubbleShape(
                            cornerRadius: 14,
                            tailWidth: Self.bubbleTailWidth,
                            tailSide: .left
                        )
                        .fill(Theme.bgTertiary)
                    )
                Spacer(minLength: 0)
            }
            if let qNote = entry.note {
                annotationNoteLabel(qNote, font: .system(size: 10.5))
            }
        }
    }

    /// Sent-style bubble: right-aligned, tail at the bottom-right, a
    /// subtle accent tint so the user's own words read as "mine" the
    /// way a sent message does in a chat client.
    private func selfChatBubbleQuote(_ entry: AgentQuoteEntry) -> some View {
        VStack(alignment: .trailing, spacing: 2) {
            HStack {
                Spacer(minLength: 0)
                bubbleBody(entry, alignment: .leading)
                    .padding(.leading, 10)
                    .padding(.trailing, 10 + Self.bubbleTailWidth)
                    .padding(.vertical, 6)
                    .background(
                        ChatBubbleShape(
                            cornerRadius: 14,
                            tailWidth: Self.bubbleTailWidth,
                            tailSide: .right
                        )
                        .fill(Theme.accent.opacity(0.18))
                    )
            }
            if let qNote = entry.note {
                annotationNoteLabel(qNote, font: .system(size: 10.5))
            }
        }
    }

    /// Shared inner content for both bubble variants — optional author
    /// label (coloured from the sticky palette) over the quote text.
    private func bubbleBody(
        _ entry: AgentQuoteEntry,
        alignment: HorizontalAlignment
    )
        -> some View {
        VStack(alignment: alignment, spacing: 2) {
            if let author = entry.quoteAuthor {
                Text(author)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(quoteAuthorColors[author] ?? Theme.textPrimary)
            }
            Text(entry.quote)
                .font(.system(size: 11))
                .foregroundStyle(Theme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// Reusable note label with the astroid (sparkle) glyph prefix.
    private func annotationNoteLabel(_ text: String, font: Font = .system(size: 10.5)) -> some View {
        HStack(alignment: .top, spacing: 3) {
            Image(systemName: "sparkle")
                .font(.system(size: 8))
                .foregroundStyle(Theme.textMuted)
                .opacity(0.5)
                .padding(.top, 2)
            Text(text)
                .font(font)
                .foregroundStyle(Theme.textMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

// MARK: - Record body

/// Renders a record-only trail event: a single DuckDB analytics
/// row surfaced as a point-in-time citation that binds no document.
/// SwiftUI port of the portal's `RecordBody`. The source icon/colour
/// come from the registry (resolved one level up via the spine's
/// `eventSourceId`); the title, table label, and key fields are all
/// derived gateway-side from the table's declared record-display
/// contract, so this renderer never learns a column name or branches on
/// a source.
///
/// When `record.boundDocumentId` is non-nil the title taps through to
/// that document via the shared `openTrailDocument` env-handler — the
/// SAME nav path document citations use, NOT a `NavigationLink` (which
/// is a no-op in the `CitationsDrawer` overlay, which has no
/// NavigationStack). When nil it renders
/// as plain text with no tap target — no dead link.
@available(iOS 17.0, *)
struct TrailTimelineRecordBody: View {
    let record: AgentTrailRecord
    let time: String?

    @Environment(\.openTrailDocument) private var openTrailDocument

    private var title: String {
        if !record.title.isEmpty { return record.title }
        if !record.tableDisplayName.isEmpty { return record.tableDisplayName }
        return "(record)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            titleRow
            metadataRow
            TrailTimelineRecordKeyFields(keyFields: record.keyFields)
        }
    }

    /// The record's database glyph + derived title. Tappable only when a
    /// bound document exists.
    @ViewBuilder
    private var titleRow: some View {
        if let boundDocId = record.boundDocumentId {
            titleLabel
                .contentShape(Rectangle())
                .onTapGesture { openTrailDocument(boundDocId) }
        } else {
            titleLabel
        }
    }

    private var titleLabel: some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "cylinder.split.1x2")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Theme.textMuted)
                .padding(.top, 2)
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(2)
                .truncationMode(.tail)
                .multilineTextAlignment(.leading)
            Spacer(minLength: 0)
        }
    }

    /// Time + table-display label, separated by " · " — mirrors the
    /// portal record body's people/metadata row.
    private var metadataRow: some View {
        let timeStr = TrailTimelineFormat.timeLabel(time)
        let parts = [timeStr, record.tableDisplayName].filter { !$0.isEmpty }
        return Text(parts.joined(separator: " · "))
            .font(.system(size: 11))
            .foregroundStyle(Theme.textSecondary)
            .lineLimit(2)
    }
}

/// The declared key columns of a record citation, rendered as a
/// label/value list. SwiftUI port of the portal's `RecordKeyFields`. The
/// gateway already redacted `sensitive` columns server-side (the value
/// arrives as the redaction placeholder), so this renderer prints values
/// verbatim and re-exposes nothing. A nil value shows an em-dash.
@available(iOS 17.0, *)
struct TrailTimelineRecordKeyFields: View {
    let keyFields: [AgentTrailRecordKeyField]

    var body: some View {
        if !keyFields.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(keyFields.enumerated()), id: \.0) { _, field in
                    HStack(alignment: .top, spacing: 6) {
                        Text(field.label)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(Theme.textMuted)
                        Text(field.value ?? "—")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                }
            }
            .padding(.top, 2)
        }
    }
}

// MARK: - Quote author color palette

/// Sticky palette for quote-author names in chat-bubble quotes.
/// Matches the portal's `QUOTE_AUTHOR_COLORS` so iOS and web render
/// the same author→color mapping.
@available(iOS 17.0, *)
extension TrailTimelineView {
    static let quoteAuthorColors: [Color] = [
        Color(red: 0x7A / 255, green: 0xAF / 255, blue: 0xCB / 255), // soft blue
        Color(red: 0xC4 / 255, green: 0xA4 / 255, blue: 0x6C / 255), // warm sand
        Color(red: 0xCB / 255, green: 0x8A / 255, blue: 0x72 / 255), // muted coral
        Color(red: 0x8B / 255, green: 0xB4 / 255, blue: 0x7A / 255), // sage green
        Color(red: 0xA7 / 255, green: 0x8B / 255, blue: 0xBF / 255), // soft purple
        Color(red: 0x6B / 255, green: 0xBF / 255, blue: 0xAE / 255), // teal
        Color(red: 0xBF / 255, green: 0x8B / 255, blue: 0xA7 / 255), // dusty rose
        Color(red: 0xA0 / 255, green: 0xA8 / 255, blue: 0x5C / 255), // olive gold
    ]
}

// MARK: - Chat bubble shape

/// Which side the tail sprouts from. `.left` is the WhatsApp-style
/// incoming bubble (tail at the bottom-left, body inset on the left);
/// `.right` mirrors it for outgoing / self-authored "sent" bubbles
/// (tail at the bottom-right, body inset on the right).
@available(iOS 17.0, *)
enum ChatBubbleTailSide {
    case left
    case right
}

/// Rounded rectangle with a small curved tail at one bottom corner,
/// mimicking a chat-message bubble. For `.left` the tail extends to the
/// LEFT from near the body's bottom-left corner (incoming message);
/// for `.right` it mirrors horizontally to the bottom-right (a sent
/// message). The body is inset by `tailWidth` on the tail's side to
/// make room; content should add matching padding on that side.
@available(iOS 17.0, *)
struct ChatBubbleShape: Shape {
    var cornerRadius: CGFloat = 14
    var tailWidth: CGFloat = 6
    var tailSide: ChatBubbleTailSide = .left

    func path(in rect: CGRect) -> Path {
        // Build the canonical left-tailed path, then for `.right` flip
        // every point horizontally across the rect's vertical centre so
        // the rounded body stays put and only the tail sliver moves to
        // the opposite edge.
        let p = leftTailedPath(in: rect)
        guard tailSide == .right else { return p }
        var flip = CGAffineTransform(scaleX: -1, y: 1)
        flip = flip.translatedBy(x: -rect.width, y: 0)
        return p.applying(flip)
    }

    private func leftTailedPath(in rect: CGRect) -> Path {
        let r = cornerRadius
        let tw = tailWidth
        let bodyLeft = rect.minX + tw
        let blCenter = CGPoint(x: bodyLeft + r, y: rect.maxY - r)

        // Midpoint of bottom-left arc (135°): the tail sprouts here
        let cos45 = CGFloat(0.7071)
        let arcMidX = blCenter.x - r * cos45
        let arcMidY = blCenter.y + r * cos45

        var p = Path()

        // Top-left corner
        p.move(to: CGPoint(x: bodyLeft + r, y: rect.minY))
        // Top edge
        p.addLine(to: CGPoint(x: rect.maxX - r, y: rect.minY))
        // Top-right corner
        p.addArc(
            center: CGPoint(x: rect.maxX - r, y: rect.minY + r),
            radius: r, startAngle: .degrees(-90), endAngle: .degrees(0), clockwise: false
        )
        // Right edge
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - r))
        // Bottom-right corner
        p.addArc(
            center: CGPoint(x: rect.maxX - r, y: rect.maxY - r),
            radius: r, startAngle: .degrees(0), endAngle: .degrees(90), clockwise: false
        )
        // Bottom edge
        p.addLine(to: CGPoint(x: bodyLeft + r, y: rect.maxY))
        // Bottom-left arc — only to the midpoint (135°)
        p.addArc(
            center: blCenter,
            radius: r, startAngle: .degrees(90), endAngle: .degrees(135), clockwise: false
        )
        // Tail: thin, pointy sliver from arc midpoint to tip (WSW)
        let tipX = rect.minX
        let tipY = arcMidY + 1
        p.addCurve(
            to: CGPoint(x: tipX, y: tipY),
            control1: CGPoint(x: arcMidX - tw * 0.4, y: arcMidY + 0.5),
            control2: CGPoint(x: tipX + tw * 0.15, y: tipY + 0.3)
        )
        // From tip, curve back with a concave top edge so the tail
        // pinches thinner in the middle before widening at the body.
        p.addCurve(
            to: CGPoint(x: bodyLeft, y: rect.maxY - r),
            control1: CGPoint(x: tipX + tw * 0.15, y: tipY - 0.5),
            control2: CGPoint(x: bodyLeft - tw * 0.3, y: arcMidY - 1)
        )
        // Left edge
        p.addLine(to: CGPoint(x: bodyLeft, y: rect.minY + r))
        // Top-left corner
        p.addArc(
            center: CGPoint(x: bodyLeft + r, y: rect.minY + r),
            radius: r, startAngle: .degrees(180), endAngle: .degrees(270), clockwise: false
        )
        p.closeSubpath()
        return p
    }
}

// MARK: - Attachment row (nested under a parent event)

@available(iOS 17.0, *)
struct TrailTimelineAttachment: View {
    let attachment: AgentTrailEvent
    let docLevelAnnotations: AgentDocAnnotations?
    var visibleDocIds: Set<String>?
    let store: AppStore
    var quoteAuthorColors: [String: Color] = [:]

    var body: some View {
        // Indent + hairline divider on top so attachments read as
        // nested children of the parent event row.
        VStack(alignment: .leading, spacing: 0) {
            Divider()
                .background(Theme.borderLight)
                .padding(.top, 6)
            TrailTimelineEventBody(
                event: attachment,
                isAttachment: true,
                docLevelAnnotations: docLevelAnnotations,
                visibleDocIds: visibleDocIds,
                store: store,
                quoteAuthorColors: quoteAuthorColors
            )
            .padding(.leading, 18)
            .padding(.top, 6)
        }
    }
}

// MARK: - Formatting helpers

@available(iOS 17.0, *)
enum TrailTimelineFormat {
    static func isDuplicateLikeLinkType(_ linkType: String) -> Bool {
        AgentTrailLinkFormat.isDuplicateLike(linkType)
    }

    /// YYYY-MM-DD prefix of an ISO-8601 timestamp; used to detect
    /// day boundaries between consecutive events.
    static func dayKey(_ iso: String?) -> String {
        guard let iso else { return "" }
        return String(iso.prefix(10))
    }

    /// "Mon · Apr 20, 2026" header label.
    static func dateHeaderLabel(_ iso: String?) -> String {
        guard let iso, let date = isoDate(iso) else { return "—" }
        let weekday = weekdayFormatter.string(from: date)
        let mdy = mdyFormatter.string(from: date)
        return "\(weekday) · \(mdy)"
    }

    /// "10:08" time label for the per-event time column.
    static func timeLabel(_ iso: String?) -> String {
        guard let iso, let date = isoDate(iso) else { return "" }
        return timeFormatter.string(from: date)
    }

    /// Verb phrase for a related-edge `linkType`. Mirrors the portal's
    /// `phraseForLinkType` in `lib/graph-timeline.js`. Direction-aware:
    /// `url` flips to "cited by" on inbound entries (the cited doc's
    /// perspective). Unknown link types fall back to the raw string so
    /// new edge kinds added on the server light up without an iOS
    /// change.
    static func phraseForLinkType(linkType: String, direction: String) -> String {
        AgentTrailLinkFormat.phrase(linkType: linkType, direction: direction)
    }

    /// Build the "by X · to Y" prose line from a list of people. Uses
    /// the same closed bucket enum the portal renderer relies on.
    static func peopleLine(buckets: [(label: String, names: [String])]) -> String {
        buckets
            .filter { !$0.names.isEmpty }
            .map { bucket in
                let names = bucket.names.joined(separator: ", ")
                return "\(bucket.label) \(names)"
            }
            .joined(separator: " · ")
    }

    /// Group people by role-bucket label ("by" / "to" / "with" /
    /// "mentions" / etc.). Source-agnostic — keyed on the closed
    /// `PersonRole` enum from `@omnesis/types/document`.
    static func groupPeopleByBucket(
        _ people: [AgentTrailEventPerson]
    )
        -> [(label: String, names: [String])] {
        var byBucket: [String: [String]] = [:]
        var order: [String] = []
        for person in people {
            let bucket = bucketForRole(person.role)
            if byBucket[bucket] == nil {
                byBucket[bucket] = []
                order.append(bucket)
            }
            byBucket[bucket]?.append(person.name)
        }
        return order.map { ($0, byBucket[$0] ?? []) }
    }

    private static func bucketForRole(_ role: String) -> String {
        switch role {
        case "sender", "author": "by"
        case "owner": "owned by"
        case "recipient", "attendee": "to"
        case "participant": "with"
        case "mentioned": "mentions"
        case "contact": "contact"
        case "editor": "edited by"
        default: "involves"
        }
    }

    // MARK: - Date parsers

    private static let isoParser: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoParserNoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static let weekdayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "EEE"
        return f
    }()

    private static let mdyFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "MMM d, yyyy"
        return f
    }()

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_GB")
        f.dateFormat = "HH:mm"
        return f
    }()

    private static func isoDate(_ s: String) -> Date? {
        if let d = isoParser.date(from: s) { return d }
        return isoParserNoFractional.date(from: s)
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("TrailTimelineView — voucher journey + annotations") {
    let store = AppStore.preview()
    return ScrollView {
        TrailTimelineView(
            events: PreviewMocks.trailVoucherJourney,
            annotations: PreviewMocks.trailVoucherAnnotations
        )
        .padding()
    }
    .background(Theme.bgPrimary)
    .environment(store)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("TrailTimelineView — long trail, no annotations") {
    let store = AppStore.preview()
    return ScrollView {
        TrailTimelineView(
            events: PreviewMocks.trailLong,
            annotations: .empty
        )
        .padding()
    }
    .background(Theme.bgPrimary)
    .environment(store)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("TrailTimelineView — URL representations") {
    let store = AppStore.preview()
    return ScrollView {
        TrailTimelineView(
            events: PreviewMocks.trailUrlRepresentations,
            annotations: .empty
        )
        .padding()
    }
    .frame(width: 320)
    .background(Theme.bgPrimary)
    .environment(store)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("TrailTimelineView — multi-author quotes") {
    let store = AppStore.preview()
    return ScrollView {
        TrailTimelineView(
            events: PreviewMocks.trailLong,
            annotations: PreviewMocks.trailLongMultiAuthorAnnotations
        )
        .padding()
    }
    .background(Theme.bgPrimary)
    .environment(store)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("TrailTimelineView — self vs other chat bubbles") {
    // A WhatsApp-style conversation event whose annotations carry a mix
    // of self-authored quotes (right-aligned sent bubbles) and quotes
    // from another participant (left-aligned incoming bubbles).
    let store = AppStore.preview()
    let convoDoc = AgentTrailEventDoc(
        documentId: "doc-convo-self",
        title: "Trip planning thread",
        sourceId: "whatsapp:demo",
        sourceUrl: nil,
        appUrl: nil,
        documentType: "conversation",
        mimeType: nil
    )
    let convoEvent = AgentTrailEvent(
        eventId: "evt-convo-self",
        at: "2026-04-20T10:08:00.000Z",
        kind: "seed",
        doc: convoDoc,
        attachments: [],
        people: [],
        related: []
    )
    var annotations = AgentTrailAnnotations()
    annotations.applyDocAnnotation(
        documentId: "doc-convo-self",
        ref: nil,
        quote: "Can you send me the booking link when you get a sec?",
        note: nil,
        quoteAuthor: "Maya Reeves",
        quoteIsSelf: false
    )
    annotations.applyDocAnnotation(
        documentId: "doc-convo-self",
        ref: nil,
        quote: "Just sent it — let me know if the dates still work for you.",
        note: "the user's own reply",
        quoteAuthor: "You",
        quoteIsSelf: true
    )
    annotations.applyDocAnnotation(
        documentId: "doc-convo-self",
        ref: nil,
        quote: "Dates are perfect, thank you!",
        note: nil,
        quoteAuthor: "Maya Reeves",
        quoteIsSelf: false
    )
    return ScrollView {
        TrailTimelineView(events: [convoEvent], annotations: annotations)
            .padding()
    }
    .background(Theme.bgPrimary)
    .environment(store)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("ChatBubbleShape — left vs right tail") {
    VStack(spacing: 20) {
        Text("Incoming bubble")
            .font(.system(size: 12))
            .padding(.leading, 10 + 6)
            .padding(.trailing, 10)
            .padding(.vertical, 8)
            .background(ChatBubbleShape(tailSide: .left).fill(Theme.bgTertiary))
            .frame(maxWidth: .infinity, alignment: .leading)
        Text("Sent bubble")
            .font(.system(size: 12))
            .padding(.leading, 10)
            .padding(.trailing, 10 + 6)
            .padding(.vertical, 8)
            .background(ChatBubbleShape(tailSide: .right).fill(Theme.accent.opacity(0.18)))
            .frame(maxWidth: .infinity, alignment: .trailing)
    }
    .padding(40)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("TrailTimelineView — record-only citation") {
    let store = AppStore.preview()
    return ScrollView {
        TrailTimelineView(
            events: PreviewMocks.trailRecordOnly,
            annotations: .empty
        )
        .padding()
    }
    .background(Theme.bgPrimary)
    .environment(store)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("TrailTimelineView — deduped doc+record") {
    let store = AppStore.preview()
    return ScrollView {
        TrailTimelineView(
            events: PreviewMocks.trailDocPlusRecord,
            annotations: .empty
        )
        .padding()
    }
    .background(Theme.bgPrimary)
    .environment(store)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("TrailTimelineView — mixed records, edge fields") {
    let store = AppStore.preview()
    return ScrollView {
        TrailTimelineView(
            events: PreviewMocks.trailMixedRecords,
            annotations: .empty
        )
        .padding()
    }
    .background(Theme.bgPrimary)
    .environment(store)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("TrailTimelineView — empty trail") {
    let store = AppStore.preview()
    return ScrollView {
        TrailTimelineView(events: [], annotations: .empty)
            .padding()
    }
    .background(Theme.bgPrimary)
    .environment(store)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("TrailTimelineView — single event with attachment + annotations") {
    let store = AppStore.preview()
    return ScrollView {
        TrailTimelineView(
            events: [PreviewMocks.trailVoucherJourney[0]],
            annotations: PreviewMocks.trailVoucherAnnotations
        )
        .padding()
    }
    .background(Theme.bgPrimary)
    .environment(store)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("TrailTimelineView — light mode sanity") {
    let store = AppStore.preview()
    return ScrollView {
        TrailTimelineView(
            events: PreviewMocks.trailVoucherJourney,
            annotations: PreviewMocks.trailVoucherAnnotations
        )
        .padding()
    }
    .background(Theme.bgPrimary)
    .environment(store)
    .preferredColorScheme(.light)
}
#endif

// MARK: - Per-event frame preference (sticky-tab driver)

/// Frame snapshot for one timeline event row. Reported by
/// `TrailTimelineView` when its host opts into per-event frame
/// tracking (passes `scrollCoordinateSpace` + `panelCoordinateSpace`).
/// `CitationsDrawer` consumes these to position one sticky tab per
/// event, vertically centred against the event row.
@available(iOS 17.0, *)
public struct TrailEventFrame: Equatable, Hashable {
    public let scrollMinY: CGFloat
    public let scrollMaxY: CGFloat
    /// Y position (in the panel's coordinate space) the sticky tab
    /// should anchor at — the centre of the event's source-icon dot
    /// at the row's top, so the tab pairs visually with the event's
    /// identity row rather than with the row's variable-height body.
    public let tabAnchorY: CGFloat
}

/// PreferenceKey that bubbles each timeline event row's frame up to
/// the host view. Mirrors the citations' `CardFrameKey` pattern —
/// the dict is keyed by the event's index in the trail's `events`
/// array so updates merge cleanly across LazyVStack re-render cycles.
@available(iOS 17.0, *)
public struct TrailEventFrameKey: PreferenceKey {
    public static let defaultValue: [Int: TrailEventFrame] = [:]
    public static func reduce(
        value: inout [Int: TrailEventFrame],
        nextValue: () -> [Int: TrailEventFrame]
    ) {
        value.merge(nextValue(), uniquingKeysWith: { _, new in new })
    }
}
#endif
