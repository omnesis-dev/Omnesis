// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

// The Direct half of the Audit screen: raw corpus reads by external agents,
// grouped into transcript sessions. Unlike the Answer feed — reviewed releases
// — these rows are unreviewed reads, so the pane says so up front and never
// reuses the release vocabulary (shared, held, denied).
//
// Sessions arrive newest first; opening one lists its tool calls oldest first.
// Each call renders the same flat static card the portal shows — result rows
// with titles, tappable document/person links, SQL rowblocks — with the call's
// instant and full payload on the card's trailing affordances. Payloads load
// as rows appear. A gateway from before this boundary has no Direct routes:
// the tab says so instead of failing.

// MARK: - Unsupported state

/// A gateway from before the Direct boundary 404s its routes. That is version
/// skew, not a failure: the tab names the remedy and the Answer tab keeps
/// working untouched.
struct DirectUnsupportedError: Error, Equatable {}

// MARK: - Session row

/// One transcript session: who read, how the calls grouped, how many, and
/// when the latest ran.
@available(iOS 17.0, *)
struct DirectAuditSessionRow: View {
    let session: DirectAuditSessionSummary

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                Text(directAuditAgentName(session))
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                HStack(spacing: Theme.Spacing.xs) {
                    Text(directAuditSessionLabel(session))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Text("·")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textMuted)
                        .accessibilityHidden(true)
                    Text(directAuditCallCountLabel(session.eventCount))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Theme.textSecondary)
                    if directAuditSessionIsHeuristic(session) {
                        Text("heuristic")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(Theme.textMuted)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Theme.bgSecondary)
                            .clipShape(Capsule())
                            .accessibilityLabel(
                                "Heuristic grouping: no caller grouping key was sent; "
                                    + "calls grouped while idle gaps stay under an hour."
                            )
                    }
                }
            }
            Spacer(minLength: 0)
            Text(time)
                .font(.system(size: 11))
                .monospacedDigit()
                .foregroundStyle(Theme.textMuted)
                .lineLimit(1)
                .accessibilityLabel(privacyAbsoluteDate(session.lastEventAt))
            Image(systemName: "chevron.right")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.textMuted)
                .padding(.top, 7)
                .accessibilityHidden(true)
        }
        .padding(.vertical, Theme.Spacing.sm)
        .contentShape(Rectangle())
    }

    private var time: String {
        guard session.lastEventAt > 0 else { return "Unknown" }
        return Date(timeIntervalSince1970: Double(session.lastEventAt) / 1000)
            .formatted(date: .omitted, time: .shortened)
    }
}

// MARK: - Session list

/// The Direct session list: what the gateway grouped, newest first.
@available(iOS 17.0, *)
struct DirectAuditPane: View {
    @Environment(AppStore.self) private var store

    @State private var sessions: [DirectAuditSessionSummary] = []
    @State private var loading = true
    @State private var loadError: Error?
    @State private var unsupported = false
    @State private var loadGeneration = 0

    private let isPreview: Bool

    init() {
        self.isPreview = false
    }

    #if DEBUG
    init(
        previewSessions: [DirectAuditSessionSummary],
        previewLoading: Bool = false,
        previewLoadError: Error? = nil,
        previewUnsupported: Bool = false
    ) {
        self._sessions = State(initialValue: previewSessions)
        self._loading = State(initialValue: previewLoading)
        self._loadError = State(initialValue: previewLoadError)
        self._unsupported = State(initialValue: previewUnsupported)
        self.isPreview = true
    }
    #endif

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Theme.Spacing.md) {
                Text(
                    "Raw reads by external agents using Direct tools — not privacy reviewed. "
                        + "Anything an agent saw here left the machine as-is."
                )
                .font(.system(size: 13))
                .foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                content
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.bottom, Theme.Spacing.xl)
        }
        .refreshable { await load() }
        .task {
            guard !isPreview else { return }
            await load()
        }
        .onDisappear { loadGeneration += 1 }
    }

    @ViewBuilder
    private var content: some View {
        if loading, sessions.isEmpty {
            PrivacyLoadingRow(label: "Loading Direct sessions…")
        } else if unsupported, sessions.isEmpty {
            PrivacyEmptyState(
                symbol: "arrow.triangle.2.circlepath",
                title: "Direct transcripts need a newer gateway",
                detail: "This gateway predates Direct audit transcripts. "
                    + "Update it to see raw reads here — the Answer tab is unaffected."
            )
        } else if let loadError, sessions.isEmpty {
            GatewayErrorView(
                context: "load Direct sessions",
                error: loadError,
                onRetry: { Task { await load() } }
            )
            .frame(minHeight: GatewayErrorView.minScrollHeight)
        } else {
            if loadError != nil {
                PrivacyBanner(text: "Could not refresh Direct sessions.")
            }
            if sessions.isEmpty {
                PrivacyEmptyState(
                    symbol: "terminal",
                    title: "No Direct reads recorded",
                    detail: "Every Direct tool call an external agent makes appears here, "
                        + "grouped into sessions."
                )
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(sessions) { session in
                        NavigationLink(value: PrivacyRoute.directSession(session.id, session)) {
                            DirectAuditSessionRow(session: session)
                        }
                        .buttonStyle(.plain)
                        if session.id != sessions.last?.id {
                            Divider().background(Theme.borderLight)
                        }
                    }
                }
            }
        }
    }

    private func load() async {
        guard !isPreview else { return }
        loadGeneration += 1
        let generation = loadGeneration
        guard let client = store.privacy else {
            if generation == loadGeneration {
                loading = false
                loadError = URLError(.cannotConnectToHost)
            }
            return
        }
        loading = true
        defer {
            if generation == loadGeneration { loading = false }
        }
        do {
            let listed = try await client.listDirectSessions(limit: 50)
            guard generation == loadGeneration else { return }
            sessions = listed
            loadError = nil
            unsupported = false
        } catch {
            if generation == loadGeneration {
                if (error as? GatewayClient.Error) == .notFound {
                    unsupported = true
                    loadError = nil
                } else {
                    loadError = privacyRefreshFailure(previous: loadError, caught: error)
                }
            }
        }
    }
}

// MARK: - Transcript

/// One calendar day's separator inside a transcript: the date centered, with
/// room above and below. The first day's heading doubles as the transcript's
/// top date.
@available(iOS 17.0, *)
struct DirectTranscriptDayHeading: View {
    let heading: String

    var body: some View {
        Text(heading)
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(Theme.textMuted)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.top, Theme.Spacing.md)
            .padding(.bottom, Theme.Spacing.sm)
            .accessibilityAddTraits(.isHeader)
    }
}

/// One tool call in a transcript: the flat static card is the whole item —
/// the card is already the summary — with the call's instant and full
/// payload riding on its trailing affordances. No wrapper, no success chip:
/// only failures speak, through the shared error card, and a call without a
/// result reads "No result recorded." The payload loads when the row appears,
/// mirroring the portal's scroll-into-view fetch.
@available(iOS 17.0, *)
struct DirectTranscriptEventRow: View {
    let event: DirectAuditEventSummary
    var payload: JSONValue?
    var payloadLoading = false
    var payloadError: String?
    let onAppear: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            if let payloadError, payload == nil, !payloadLoading {
                PrivacyBanner(text: payloadError, tone: .error)
            } else if let payload {
                if directAuditPayloadIsTruncatedSentinel(payload) {
                    PrivacyBanner(
                        text: "A value exceeded the stored size cap, so only its digest was kept."
                    )
                }
                if directRecordHasResult(payload) {
                    // Batch calls project one card per child — the portal's
                    // per-item split — sharing this call's instant and payload.
                    ForEach(Array(directTranscriptCards(tool: toolName, record: payload).enumerated()), id: \.offset) { _, card in
                        DirectToolCardView(
                            tool: card.tool,
                            content: card.content,
                            timeText: time,
                            rawPayload: payload
                        )
                    }
                } else {
                    Text("No result recorded.")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textMuted)
                }
            } else {
                PrivacyLoadingRow(label: "Loading call…")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityLabel("\(toolName), \(time)")
        .onAppear(perform: onAppear)
    }

    private var time: String {
        guard event.createdAt > 0 else { return "Unknown" }
        return Date(timeIntervalSince1970: Double(event.createdAt) / 1000)
            .formatted(date: .omitted, time: .shortened)
    }

    private var toolName: String {
        event.tool.isEmpty ? "Unknown tool" : event.tool
    }
}

/// One transcript: the session's tool calls, oldest first. Reports back
/// through `onChanged` when the session is deleted so the host can re-read
/// the list. A delete that 404s was already deleted elsewhere — that counts
/// as deleted, not as a failure.
@available(iOS 17.0, *)
struct DirectTranscriptView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    let sessionId: String
    var session: DirectAuditSessionSummary?
    private let onChanged: () -> Void

    @State private var events: [DirectAuditEventSummary] = []
    @State private var payloads: [String: JSONValue] = [:]
    @State private var payloadLoading: Set<String> = []
    @State private var payloadErrors: [String: String] = [:]
    @State private var loading = true
    @State private var loadError: Error?
    @State private var unsupported = false
    @State private var loadGeneration = 0
    @State private var confirmDelete = false
    @State private var deleting = false
    @State private var deleteError: String?

    private let isPreview: Bool
    private let directEventLimit = 100

    private var nowMillis: Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }

    init(sessionId: String, session: DirectAuditSessionSummary? = nil, onChanged: @escaping () -> Void = {}) {
        self.sessionId = sessionId
        self.session = session
        self.onChanged = onChanged
        self.isPreview = false
    }

    #if DEBUG
    init(
        previewSession: DirectAuditSessionSummary,
        previewEvents: [DirectAuditEventSummary],
        previewPayloads: [String: JSONValue] = [:],
        previewPayloadErrors: [String: String] = [:],
        previewLoading: Bool = false,
        previewLoadError: Error? = nil,
        previewUnsupported: Bool = false,
        previewDeleteError: String? = nil
    ) {
        self.sessionId = previewSession.id
        self.session = previewSession
        self._events = State(initialValue: previewEvents)
        self._payloads = State(initialValue: previewPayloads)
        self._payloadErrors = State(initialValue: previewPayloadErrors)
        self._loading = State(initialValue: previewLoading)
        self._loadError = State(initialValue: previewLoadError)
        self._unsupported = State(initialValue: previewUnsupported)
        self._deleteError = State(initialValue: previewDeleteError)
        self.onChanged = {}
        self.isPreview = true
    }
    #endif

    var body: some View {
        content
            .navigationTitle("Direct transcript")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bgPrimary, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Delete transcript", role: .destructive) {
                            confirmDelete = true
                        }
                        .disabled(deleting)
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .accessibilityLabel("Transcript options")
                    }
                    .disabled(loading || loadError != nil)
                }
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .background(Theme.bgPrimary.ignoresSafeArea())
            .task {
                guard !isPreview else { return }
                await load()
            }
            .refreshable { await load() }
            .onDisappear { loadGeneration += 1 }
            .confirmationDialog(
                "Delete this transcript?",
                isPresented: $confirmDelete,
                titleVisibility: .visible
            ) {
                Button("Delete transcript", role: .destructive) {
                    Task { await deleteSession() }
                }
            } message: {
                Text(
                    "This removes the transcript of every tool call in this session. "
                        + "This cannot be undone."
                )
            }
    }

    @ViewBuilder
    private var content: some View {
        if loading, events.isEmpty {
            PrivacyLoadingRow(label: "Loading transcript…")
        } else if unsupported, events.isEmpty {
            PrivacyEmptyState(
                symbol: "arrow.triangle.2.circlepath",
                title: "Direct transcripts need a newer gateway",
                detail: "This gateway predates Direct audit transcripts. "
                    + "Update it to see this transcript — the Answer tab is unaffected."
            )
        } else if let loadError, events.isEmpty {
            GatewayErrorView(
                context: "load Direct transcript",
                error: loadError,
                onRetry: { Task { await load() } }
            )
            .frame(minHeight: GatewayErrorView.minScrollHeight)
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    header
                    if let deleteError {
                        PrivacyBanner(text: deleteError, tone: .error)
                    }
                    if events.isEmpty {
                        PrivacyEmptyState(
                            symbol: "terminal",
                            title: "No calls in this session",
                            detail: "The session was recorded without any tool calls."
                        )
                    } else {
                        // Calls group by local calendar day: the first day's
                        // heading is the transcript's top date, and a later
                        // day interleaves its heading before its first call.
                        ForEach(directTranscriptDays(events, now: nowMillis), id: \.id) { day in
                            DirectTranscriptDayHeading(heading: day.heading)
                            ForEach(day.events) { event in
                                DirectTranscriptEventRow(
                                    event: event,
                                    payload: payloads[event.id],
                                    payloadLoading: payloadLoading.contains(event.id),
                                    payloadError: payloadErrors[event.id],
                                    onAppear: { ensurePayload(event) }
                                )
                                .padding(.vertical, Theme.Spacing.xs)
                                if event.id != day.events.last?.id {
                                    Divider().background(Theme.borderLight)
                                }
                            }
                        }
                        if events.count >= directEventLimit {
                            // The gateway serves the oldest calls first, so a
                            // capped session shows the first page, not the
                            // latest calls.
                            Text("Showing the first \(directEventLimit) calls.")
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.textMuted)
                                .padding(.top, Theme.Spacing.md)
                        }
                    }
                }
                .padding(.bottom, Theme.Spacing.xl)
            }
        }
    }

    @ViewBuilder
    private var header: some View {
        if let session {
            VStack(alignment: .leading, spacing: 2) {
                Text(directAuditSessionLabel(session))
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                Text("\(directAuditAgentName(session)) · \(directAuditCallCountLabel(session.eventCount))")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textSecondary)
            }
            .padding(.bottom, Theme.Spacing.md)
        } else if !events.isEmpty {
            Text(directAuditCallCountLabel(events.count))
                .font(.system(size: 13))
                .foregroundStyle(Theme.textSecondary)
                .padding(.bottom, Theme.Spacing.md)
        }
    }

    /// Fetch one call's payload the first time its row appears, mirroring the
    /// portal's scroll-into-view fetch: a session holds up to a hundred calls
    /// and firing every fetch on mount thunders the gateway. A settled error
    /// stays put — the row shows it inline — until the transcript reloads.
    private func ensurePayload(_ event: DirectAuditEventSummary) {
        guard !isPreview,
              payloads[event.id] == nil,
              payloadErrors[event.id] == nil,
              !payloadLoading.contains(event.id),
              let client = store.privacy
        else { return }
        payloadLoading.insert(event.id)
        Task {
            do {
                let detail = try await client.getDirectEvent(id: event.id)
                payloads[event.id] = detail.payload
            } catch {
                payloadErrors[event.id] = GatewayErrorView.classify(error).title
            }
            payloadLoading.remove(event.id)
        }
    }

    private func load() async {
        guard !isPreview else { return }
        loadGeneration += 1
        let generation = loadGeneration
        guard let client = store.privacy else {
            if generation == loadGeneration {
                loading = false
                loadError = URLError(.cannotConnectToHost)
            }
            return
        }
        loading = true
        defer {
            if generation == loadGeneration { loading = false }
        }
        do {
            let listed = try await client.listDirectSessionEvents(
                sessionId: sessionId,
                limit: directEventLimit
            )
            guard generation == loadGeneration else { return }
            events = listed
            loadError = nil
            unsupported = false
        } catch {
            if generation == loadGeneration {
                if (error as? GatewayClient.Error) == .notFound {
                    unsupported = true
                    loadError = nil
                } else {
                    loadError = privacyRefreshFailure(previous: loadError, caught: error)
                }
            }
        }
    }

    private func deleteSession() async {
        guard !isPreview, !deleting, let client = store.privacy else { return }
        deleting = true
        defer { deleting = false }
        do {
            try await client.deleteDirectSession(id: sessionId)
            onChanged()
            dismiss()
        } catch {
            // Already gone elsewhere is gone — no error to show.
            if (error as? GatewayClient.Error) == .notFound {
                onChanged()
                dismiss()
                return
            }
            deleteError = GatewayErrorView.classify(error).title
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
private struct DirectAuditPaneHarness<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        NavigationStack { content }
            .background(Theme.bgPrimary)
            .environment(AppStore.preview())
            .omnesisColorScheme()
    }
}

#Preview("Direct audit — sessions") {
    DirectAuditPaneHarness {
        DirectAuditPane(previewSessions: PreviewMocks.directAuditSessions)
    }
}

#Preview("Direct audit — empty") {
    DirectAuditPaneHarness {
        DirectAuditPane(previewSessions: [])
    }
}

#Preview("Direct audit — loading") {
    DirectAuditPaneHarness {
        DirectAuditPane(previewSessions: [], previewLoading: true)
    }
}

#Preview("Direct audit — error") {
    DirectAuditPaneHarness {
        DirectAuditPane(
            previewSessions: [],
            previewLoadError: URLError(.cannotConnectToHost)
        )
    }
}

#Preview("Direct audit — gateway too old") {
    DirectAuditPaneHarness {
        DirectAuditPane(previewSessions: [], previewUnsupported: true)
    }
}

#Preview("Direct transcript — calls with cards") {
    DirectAuditPaneHarness {
        DirectTranscriptView(
            previewSession: PreviewMocks.directAuditSessions[0],
            previewEvents: PreviewMocks.directAuditSessionEvents,
            previewPayloads: PreviewMocks.directAuditPayloads
        )
    }
}

#Preview("Direct transcript — call error") {
    DirectAuditPaneHarness {
        DirectTranscriptView(
            previewSession: PreviewMocks.directAuditSessions[0],
            previewEvents: PreviewMocks.directAuditSessionEvents,
            previewPayloads: PreviewMocks.directAuditPayloads.filter { $0.key != "direct_event_preview_02" },
            previewPayloadErrors: ["direct_event_preview_02": "Couldn't connect to gateway."]
        )
    }
}

#Preview("Direct transcript — empty") {
    DirectAuditPaneHarness {
        DirectTranscriptView(
            previewSession: PreviewMocks.directAuditSessions[1],
            previewEvents: []
        )
    }
}

#Preview("Direct transcript — loading") {
    DirectAuditPaneHarness {
        DirectTranscriptView(
            previewSession: PreviewMocks.directAuditSessions[0],
            previewEvents: [],
            previewLoading: true
        )
    }
}

#Preview("Direct transcript — error") {
    DirectAuditPaneHarness {
        DirectTranscriptView(
            previewSession: PreviewMocks.directAuditSessions[0],
            previewEvents: [],
            previewLoadError: URLError(.cannotConnectToHost)
        )
    }
}

#Preview("Direct transcript — delete failed") {
    DirectAuditPaneHarness {
        DirectTranscriptView(
            previewSession: PreviewMocks.directAuditSessions[0],
            previewEvents: PreviewMocks.directAuditSessionEvents,
            previewDeleteError: "The transcript could not be deleted. Nothing changed."
        )
    }
}
#endif

#endif
