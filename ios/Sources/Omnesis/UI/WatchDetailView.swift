// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import UIKit

/// One watch: what it has said, most recent first.
///
/// This is where a notification tap lands, so it answers the question the
/// banner deliberately does not. The banner carries the operator's own words
/// and nothing about what was found — an APNs body renders on a locked screen
/// and reaches Apple in plaintext — and this screen is the other half of that
/// bargain: the detail lives on the device that already holds it.
@available(iOS 17.0, *)
struct WatchDetailView: View {
    let watchId: String
    let name: String
    /// The listing's own row, when the list arrived before the tap did. A deep
    /// link can land first — the tap is what brought the app to the foreground
    /// — and the screen renders without it rather than waiting.
    let watch: WatchRecord?
    /// The firing a notification named, when a notification is what brought the
    /// reader here. Nil when they opened the watch themselves.
    let firingSeq: Int?

    @Environment(AppStore.self) private var store
    @State private var firings: [WatchFiringRecord] = []
    @State private var loading = true
    @State private var loadError: Error?
    @State private var definition: String?
    @State private var definitionLoading = false
    @State private var definitionError: Error?
    @State private var askedForDefinition = false
    /// The record that authorises this watch to wake an agent, read in full.
    /// The listing carries only a summary of it — enough for a row — so the
    /// page that describes it reads it for itself.
    @State private var disclosure: WatchDisclosure?
    @State private var egress: [PrivacySubscriptionFiring] = []
    @State private var egressLoading = false
    @State private var egressError: Error?
    @State private var confirmRevoke = false
    @State private var revoking = false
    @State private var actionError: Error?

    var body: some View {
        WatchDetailContent(
            watch: watch,
            firings: firings,
            firingSeq: firingSeq,
            loading: loading,
            loadError: loadError,
            onRetry: { Task { await load() } },
            definition: definition,
            definitionLoading: definitionLoading,
            definitionError: definitionError,
            onShowDefinition: { Task { await loadDefinition() } },
            disclosure: disclosure,
            // The row's own summary decides whether the page states where
            // firings go: it is there from the first frame, so a watch that
            // wakes an agent never shows that sentence and then withdraws it
            // when the full record lands.
            disclosed: disclosure != nil || watch?.disclosure != nil,
            egress: egress,
            egressLoading: egressLoading,
            egressError: egressError,
            actionError: actionError,
            onRevoke: { confirmRevoke = true }
        )
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bgPrimary, for: .navigationBar)
        .background(Theme.bgPrimary.ignoresSafeArea())
        .refreshable { await load() }
        .confirmationDialog(
            "Revoke this watch's access?",
            isPresented: $confirmRevoke,
            titleVisibility: .visible
        ) {
            Button("Revoke", role: .destructive) { Task { await revoke() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "The watch stays, and stops waking the integration. Everything it has already "
                    + "sent is kept — an egress ledger with the record removed would describe "
                    + "disclosures nothing accounts for."
            )
        }
        .task { await load() }
    }

    /// Read the definition once, the first time it is opened.
    ///
    /// A failure clears the latch so a retry is possible by closing and
    /// reopening — the alternative is a disclosure permanently stuck on an
    /// error it will never re-attempt.
    private func loadDefinition() async {
        guard !askedForDefinition else { return }
        guard let client = store.watches else {
            definitionError = URLError(.cannotConnectToHost)
            return
        }
        askedForDefinition = true
        definitionLoading = true
        defer { definitionLoading = false }
        do {
            definition = try await client.fetchDefinition(watchId: watchId)
            definitionError = nil
        } catch {
            askedForDefinition = false
            definitionError = error
        }
    }

    private func load() async {
        guard let client = store.watches else {
            loading = false
            loadError = URLError(.cannotConnectToHost)
            return
        }
        loading = true
        defer { loading = false }
        do {
            async let history = client.listFirings(watchId: watchId)
            async let record = client.fetchDisclosure(watchId: watchId)
            let loaded = try await (history, record)
            firings = loaded.0
            disclosure = loaded.1
            loadError = nil
        } catch {
            loadError = error
        }
        await loadEgress()
    }

    /// Everything this watch has actually sent, when it wakes an agent.
    ///
    /// A separate read from the firings above, and deliberately so: those are
    /// what the runtime caught, these are what left the machine. A watch can
    /// catch something and fail to deliver it, and folding the two would hide
    /// exactly that.
    private func loadEgress() async {
        guard let subscriptionId = disclosure?.subscriptionId, let client = store.privacy else {
            egress = []
            egressError = nil
            return
        }
        egressLoading = true
        defer { egressLoading = false }
        do {
            egress = try await client.listSubscriptionFirings(subscriptionId: subscriptionId).firings
            egressError = nil
        } catch {
            egressError = error
        }
    }

    /// Stop the watch waking the integration, and re-read what it now says.
    ///
    /// Re-read rather than patched: the record's standing is the gateway's
    /// answer, and writing a status this screen computed would state a fact
    /// nothing verified.
    private func revoke() async {
        guard !revoking, let subscriptionId = disclosure?.subscriptionId else { return }
        guard let client = store.privacy else {
            actionError = URLError(.cannotConnectToHost)
            return
        }
        revoking = true
        actionError = nil
        defer { revoking = false }
        do {
            let outcome = try await revokeSubscriptionAndReconcile(
                revoke: { try await client.revokeSubscription(id: subscriptionId) },
                reload: { try await client.getSubscription(id: subscriptionId) }
            )
            switch outcome {
            case .accepted, .reconciled:
                await load()
            case .failed(let error, _):
                actionError = error
            }
        } catch is CancellationError {
            return
        } catch {
            actionError = error
        }
    }
}

/// Rendering split from the fetch so every state is previewable.
@available(iOS 17.0, *)
struct WatchDetailContent: View {
    let watch: WatchRecord?
    let firings: [WatchFiringRecord]
    /// The firing a notification named, marked and scrolled to. Nil when the
    /// reader arrived by hand, and no one line is the point.
    let firingSeq: Int?
    let loading: Bool
    let loadError: Error?
    let onRetry: () -> Void
    /// The watch as it is stored, once somebody has asked to see it.
    var definition: String?
    var definitionLoading: Bool = false
    var definitionError: Error?
    var onShowDefinition: () -> Void = {}
    /// Previews and snapshots render the open state without tapping.
    var definitionExpanded: Bool = false
    /// The record that authorises this watch to wake an agent, in full. Nil for
    /// a watch that wakes nobody — which is most of them, and a complete answer
    /// rather than a missing one.
    var disclosure: WatchDisclosure?
    /// Whether this watch discloses to anybody at all, known before the record
    /// itself arrives. It decides only whether the page states where firings
    /// go — the section below is what states it once the record is here.
    var disclosed: Bool = false
    /// What the record has actually sent.
    var egress: [PrivacySubscriptionFiring] = []
    var egressLoading: Bool = false
    var egressError: Error?
    var actionError: Error?
    var onRevoke: (() -> Void)?

    var body: some View {
        Group {
            if let loadError, firings.isEmpty {
                GatewayErrorView(context: "load firings", error: loadError, onRetry: onRetry)
            } else if loading, firings.isEmpty {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollViewReader { proxy in
                    List {
                        if let watch {
                            Section { WatchSummary(watch: watch, disclosed: disclosed) }
                                .listRowBackground(Theme.bgPrimary)
                        }
                        // Outside the block above on purpose: a notification tap
                        // can land before the listing does, and what a watch is
                        // allowed to say is the last thing that should wait on a
                        // row this screen does not need.
                        if let disclosure {
                            WatchDisclosureSections(
                                disclosure: disclosure,
                                actionError: actionError,
                                onRevoke: onRevoke
                            )
                        }
                        if watch != nil {
                            Section {
                                WatchDefinitionDisclosure(
                                    definition: definition,
                                    loading: definitionLoading,
                                    error: definitionError,
                                    onOpen: onShowDefinition,
                                    initiallyExpanded: definitionExpanded
                                )
                            }
                            .listRowBackground(Theme.bgPrimary)
                        }
                        Section {
                            if let egressError, rows.isEmpty {
                                Text(
                                    GatewayErrorView.classify(egressError)
                                        .detail(for: "load what it has sent")
                                )
                                .font(.caption)
                                .foregroundStyle(Theme.textSecondary)
                                .listRowBackground(Theme.bgPrimary)
                            } else if egressLoading, rows.isEmpty {
                                ProgressView()
                                    .frame(maxWidth: .infinity)
                                    .listRowBackground(Theme.bgPrimary)
                            } else if rows.isEmpty {
                                // Said plainly, because for most watches this
                                // is the correct and permanent state, and a
                                // screen that read like an error would make a
                                // working watch look broken.
                                Text("Nothing yet — this watch has not found anything to tell you about.")
                                    .font(.subheadline)
                                    .foregroundStyle(Theme.textSecondary)
                                    .listRowBackground(Theme.bgPrimary)
                            } else {
                                ForEach(rows) { row in
                                    // `firingSeq` is nil unless a notification
                                    // brought the reader here. Comparing two
                                    // optionals would make every row that
                                    // caught nothing the notified one.
                                    let notified = firingSeq != nil && row.caught?.seq == firingSeq
                                    WatchFiringRowView(row: row, fromNotification: notified)
                                        .listRowBackground(
                                            notified ? Theme.accent.opacity(0.12) : Theme.bgPrimary
                                        )
                                        .id(row.id)
                                }
                            }
                        } header: {
                            HStack {
                                Text("FIRINGS")
                                if !rows.isEmpty {
                                    Spacer()
                                    Text(rows.count.formatted())
                                }
                            }
                            .font(.caption)
                            .foregroundStyle(Theme.textSecondary)
                        }
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                    .onAppear { revealNotifiedFiring(proxy) }
                    // The ledger usually arrives after this view does — the tap
                    // is what woke the app — so the reveal has to run again
                    // when it lands, not only on the first render.
                    .onChange(of: firings) { _, _ in revealNotifiedFiring(proxy) }
                }
            }
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
    }

    /// Every firing, newest first, holding whichever of its two halves this
    /// install has: what the runtime caught, and what the record actually sent.
    private var rows: [WatchFiringRow] {
        mergeWatchFirings(caught: firings, sent: egress)
    }

    /// Bring the notified firing into view.
    ///
    /// Only when this page of the ledger actually holds it: a firing older than
    /// the page this screen reads is not on screen to scroll to, and asking
    /// anyway moves the list somewhere arbitrary. Ordinarily it is already the
    /// first row — a watch fires and speaks in the same moment — and the scroll
    /// earns its keep when the tap comes late, after later firings pushed it
    /// down.
    private func revealNotifiedFiring(_ proxy: ScrollViewProxy) {
        // Addressed by the row's own identity, which is what `.id` carries. A
        // bare sequence names nothing on this list.
        guard let firingSeq, let row = rows.first(where: { $0.caught?.seq == firingSeq })
        else { return }
        proxy.scrollTo(row.id, anchor: .center)
    }
}

/// The watch as it is actually stored.
///
/// Collapsed, and not fetched until opened: the definition is by far the
/// largest field a watch has, and this screen is about what the watch has said.
/// It is here for the moment a watch is not doing what you expected and you
/// want to see what it actually says — or to send it to someone who can.
@available(iOS 17.0, *)
private struct WatchDefinitionDisclosure: View {
    let definition: String?
    let loading: Bool
    let error: Error?
    let onOpen: () -> Void
    /// Previews and snapshots cannot tap, so they say what state to render.
    var initiallyExpanded = false

    @State private var expanded = false

    var body: some View {
        DisclosureGroup("Definition", isExpanded: $expanded) {
            if loading {
                ProgressView().padding(.vertical, 4)
            } else if let error {
                Text(GatewayErrorView.classify(error).detail(for: "load the definition"))
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
            } else if let definition {
                VStack(alignment: .leading, spacing: 8) {
                    // Horizontal scroll rather than wrapping: the shape of a
                    // definition is how it is read, and a wrapped brace tree is
                    // not the same document.
                    ScrollView(.horizontal, showsIndicators: true) {
                        Text(definition)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(Theme.textPrimary)
                            .textSelection(.enabled)
                    }
                    .menuRevealExcluded()
                    Button {
                        UIPasteboard.general.string = definition
                    } label: {
                        Label("Copy", systemImage: "doc.on.doc")
                            .font(.caption)
                    }
                    .buttonStyle(.borderless)
                }
                .padding(.vertical, 4)
            }
        }
        .font(.subheadline)
        .foregroundStyle(Theme.textPrimary)
        .onChange(of: expanded) { _, isOpen in
            if isOpen { onOpen() }
        }
        .onAppear { if initiallyExpanded { expanded = true } }
    }
}

/// What the watch is for, and whether it is running.
///
/// The reason this screen exists. The banner that led here carries the
/// operator's own words and nothing about what was found — an APNs body renders
/// on a locked screen and reaches Apple in plaintext — so a person arriving
/// needs the claim restated before a list of instants means anything.
@available(iOS 17.0, *)
private struct WatchSummary: View {
    let watch: WatchRecord
    /// Whether this watch has a disclosure. When it does, where its firings go
    /// is said once, in the section that also says what it was approved to send
    /// — stating it here as well would print one fact twice, under two different
    /// names for the same integration.
    let disclosed: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let request = watch.request {
                Text(request)
                    .font(.body)
                    .foregroundStyle(Theme.textPrimary)
            }
            if !disclosed {
                Text(watchDeliverySentence(watch))
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
            }
            HStack(spacing: 8) {
                WatchStatusChip(status: watch.status)
                if let note = watch.note, !note.isEmpty {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(Theme.textSecondary)
                }
            }
        }
        .padding(.vertical, 6)
    }
}

// MARK: - Previews

#if DEBUG

@available(iOS 17.0, *)
#Preview("WatchDetail — firings") {
    NavigationStack {
        WatchDetailContent(
            watch: PreviewMocks.watches[0],
            firings: PreviewMocks.watchFirings,
            firingSeq: nil,
            loading: false,
            loadError: nil,
            onRetry: {}
        )
        .navigationTitle("listing-unanswered")
        .navigationBarTitleDisplayMode(.inline)
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("WatchDetail — from a notification") {
    // Where a tap lands: the newest line, marked as the one that spoke.
    NavigationStack {
        WatchDetailContent(
            watch: PreviewMocks.watches[0],
            firings: PreviewMocks.watchFirings,
            firingSeq: PreviewMocks.watchFirings.last?.seq,
            loading: false,
            loadError: nil,
            onRetry: {}
        )
        .navigationTitle("listing-unanswered")
        .navigationBarTitleDisplayMode(.inline)
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("WatchDetail — from an older notification") {
    // A tap that came late, on a banner other firings have since buried. The
    // marked line is the oldest one, not the top of the list.
    NavigationStack {
        WatchDetailContent(
            watch: PreviewMocks.watches[0],
            firings: PreviewMocks.watchFirings,
            firingSeq: PreviewMocks.watchFirings.first?.seq,
            loading: false,
            loadError: nil,
            onRetry: {}
        )
        .navigationTitle("listing-unanswered")
        .navigationBarTitleDisplayMode(.inline)
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("WatchDetail — notified firing not on this page") {
    // A key this app could not place: the ledger renders, nothing is marked.
    NavigationStack {
        WatchDetailContent(
            watch: PreviewMocks.watches[0],
            firings: PreviewMocks.watchFirings,
            firingSeq: 1,
            loading: false,
            loadError: nil,
            onRetry: {}
        )
        .navigationTitle("listing-unanswered")
        .navigationBarTitleDisplayMode(.inline)
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("WatchDetail — what it sent is unreadable") {
    // A failed read of one half must not be reported as the other half being
    // empty: the ledger the runtime did return still renders beside the error.
    NavigationStack {
        WatchDetailContent(
            watch: PreviewMocks.watches[4],
            firings: PreviewMocks.watchFirings,
            firingSeq: nil,
            loading: false,
            loadError: nil,
            onRetry: {},
            disclosure: PreviewMocks.watchDisclosure,
            disclosed: true,
            egressError: URLError(.cannotConnectToHost),
            onRevoke: {}
        )
        .navigationTitle("invoice-due")
        .navigationBarTitleDisplayMode(.inline)
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("WatchDetail — still reading what it sent") {
    NavigationStack {
        WatchDetailContent(
            watch: PreviewMocks.watches[4],
            firings: [],
            firingSeq: nil,
            loading: false,
            loadError: nil,
            onRetry: {},
            disclosure: PreviewMocks.watchDisclosure,
            disclosed: true,
            egressLoading: true,
            onRevoke: {}
        )
        .navigationTitle("invoice-due")
        .navigationBarTitleDisplayMode(.inline)
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("WatchDetail — nothing yet") {
    NavigationStack {
        WatchDetailContent(
            watch: PreviewMocks.watches[1],
            firings: [],
            firingSeq: nil,
            loading: false,
            loadError: nil,
            onRetry: {}
        )
        .navigationTitle("large-payment")
        .navigationBarTitleDisplayMode(.inline)
    }
    .preferredColorScheme(.dark)
}

// MARK: - Definition previews

/// A definition in the shape the runtime stores, for the previews below.
/// Invented — nothing here comes from an indexed corpus.
@available(iOS 17.0, *)
private let previewDefinition = """
{
  "watch" : {
    "firing_policy" : "stays_active",
    "name" : "an-invoice-arrived",
    "nodes" : [
      {
        "filter" : {
          "documentType" : "email",
          "event" : [ "created" ],
          "source" : "gmail"
        },
        "id" : "invoice_email",
        "judge" : {
          "proposition" : "The message is an invoice asking for payment"
        },
        "type" : "source.document_event"
      }
    ]
  }
}
"""

@available(iOS 17.0, *)
#Preview("WatchDetail — definition open") {
    NavigationStack {
        WatchDetailContent(
            watch: PreviewMocks.watches[0],
            firings: PreviewMocks.watchFirings,
            firingSeq: nil,
            loading: false,
            loadError: nil,
            onRetry: {},
            definition: previewDefinition
        )
        .navigationTitle("listing-unanswered")
        .navigationBarTitleDisplayMode(.inline)
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("WatchDetail — definition loading") {
    NavigationStack {
        WatchDetailContent(
            watch: PreviewMocks.watches[0],
            firings: [],
            firingSeq: nil,
            loading: false,
            loadError: nil,
            onRetry: {},
            definitionLoading: true
        )
        .navigationTitle("listing-unanswered")
        .navigationBarTitleDisplayMode(.inline)
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("WatchDetail — definition unreadable") {
    NavigationStack {
        WatchDetailContent(
            watch: PreviewMocks.watches[0],
            firings: [],
            firingSeq: nil,
            loading: false,
            loadError: nil,
            onRetry: {},
            definitionError: URLError(.cannotConnectToHost)
        )
        .navigationTitle("listing-unanswered")
        .navigationBarTitleDisplayMode(.inline)
    }
    .preferredColorScheme(.dark)
}
#endif
#endif
