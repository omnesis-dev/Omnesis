// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The Watches tab: what each watch is for, whether it is running, and what it
/// has said.
///
/// Read-only, and that is the design rather than a first cut. A watch is
/// authored as an exact DSL document and installed at a terminal; the phone is
/// where you find out what one has been doing. Those are different jobs, and
/// putting a graph editor on a phone for a language whose value is its
/// precision would serve neither.
///
/// It exists because a notification needs somewhere to land. A watch that
/// interrupts someone and then offers nowhere to look is a dead end, and the
/// tap is the moment a person most wants the answer to "what did it find".
@available(iOS 17.0, *)
struct WatchesView: View {
    @Environment(AppStore.self) private var store
    @Environment(NotificationRouter.self) private var router

    @State private var watches: [WatchRecord] = []
    @State private var loading = true
    @State private var loadError: Error?
    @State private var path: [WatchesRoute] = []
    @Binding var menuOpen: Bool

    init(menuOpen: Binding<Bool>) {
        self._menuOpen = menuOpen
    }

    var body: some View {
        NavigationStack(path: $path) {
            WatchesListContent(
                watches: watches,
                loading: loading,
                loadError: loadError,
                onSelect: { path.append(.watch(watchId: $0, firingSeq: nil)) },
                onRetry: { Task { await load() } }
            )
            .navigationTitle("Watches")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    MenuToolbarButton(isOpen: $menuOpen)
                }
            }
            .toolbarBackground(Theme.bgPrimary, for: .navigationBar)
            .background(Theme.bgPrimary.ignoresSafeArea())
            .refreshable { await load() }
            .navigationDestination(for: WatchesRoute.self) { route in
                switch route {
                case .watch(let watchId, let firingSeq):
                    WatchDetailView(
                        watchId: watchId,
                        name: nameFor(watchId),
                        watch: watches.first { $0.id == watchId },
                        firingSeq: firingSeq
                    )
                }
            }
            .task { await load() }
            .onChange(of: router.pendingTarget) { _, target in consumeRouterTarget(target) }
            .onAppear { consumeRouterTarget(router.pendingTarget) }
        }
    }

    /// The watch's name if the listing has arrived, else its id.
    ///
    /// A deep link can land before the list does — the tap is what brought the
    /// app to the foreground — and a title that waited would be blank for the
    /// first second of the screen the person came to read.
    private func nameFor(_ watchId: String) -> String {
        watches.first { $0.id == watchId }?.name ?? watchId
    }

    private func consumeRouterTarget(_ target: PushTarget?) {
        guard let target else { return }
        switch target {
        case .watch(let watchId):
            router.consume()
            // Nothing marked on it: the agent said it installed or rewrote
            // this watch, and the person is here to read what it will do.
            path = [.watch(watchId: watchId, firingSeq: nil)]
        case .watchFiring(let watchId, let firingKey):
            router.consume()
            // Replace rather than append: repeated taps on banners from the
            // same watch should land on it once, not stack a chain of the same
            // screen behind the person.
            //
            // The key resolves to the firing the banner was about, so the
            // landing is that line rather than the watch in general. A key
            // this app cannot read still lands on the watch — a screen with
            // nothing marked on it, which is the honest answer, and the same
            // one someone gets by opening the watch themselves.
            path = [
                .watch(
                    watchId: watchId,
                    firingSeq: WatchFiringKey.seq(in: firingKey, forWatch: watchId)
                ),
            ]
        case .brief, .privacyApproval, .accessAuthorization, .agentAnswer, .sourcePermission:
            // Not ours — HomeView routes each push to its owning section, and
            // that section consumes it.
            break
        }
    }

    private func load() async {
        guard let client = store.watches else {
            loading = false
            // Nil during the brief unpair → re-pair gap. Routing through the
            // unreachable bucket gets the shared Retry / Open settings
            // affordances rather than a bare empty list.
            loadError = URLError(.cannotConnectToHost)
            return
        }
        loading = true
        defer { loading = false }
        do {
            watches = try await client.listWatches()
            loadError = nil
        } catch {
            loadError = error
        }
    }
}

@available(iOS 17.0, *)
enum WatchesRoute: Hashable {
    /// One watch's ledger. `firingSeq` is set when a notification tap brought
    /// the reader here and named which firing it was about; nil when they
    /// opened the watch themselves and no one line is the point.
    case watch(watchId: String, firingSeq: Int?)
}

/// The list, separated from the fetch so a preview can render every state
/// without a gateway. Same split as `TriggersListContent`, for the same reason:
/// a screen nobody can render is a screen nobody critiques.
@available(iOS 17.0, *)
struct WatchesListContent: View {
    let watches: [WatchRecord]
    let loading: Bool
    let loadError: Error?
    let onSelect: (String) -> Void
    let onRetry: () -> Void

    var body: some View {
        Group {
            if let loadError, watches.isEmpty {
                GatewayErrorView(context: "load watches", error: loadError, onRetry: onRetry)
            } else if loading, watches.isEmpty {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if watches.isEmpty {
                WatchesEmptyState()
            } else {
                List {
                    ForEach(orderedWatches(watches)) { watch in
                        Button { onSelect(watch.id) } label: { WatchRow(watch: watch) }
                            .listRowBackground(Theme.bgPrimary)
                            // The rule between two watches carries the same side insets as
                            // the row content, matching the Privacy activity feed. The list
                            // insets the row, so the row itself carries no horizontal padding.
                            .listRowInsets(
                                EdgeInsets(
                                    top: 0,
                                    leading: Theme.Spacing.lg,
                                    bottom: 0,
                                    trailing: Theme.Spacing.lg
                                )
                            )
                            .listRowSeparatorTint(Theme.borderLight)
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            }
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
    }
}

@available(iOS 17.0, *)
private struct WatchRow: View {
    let watch: WatchRecord

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(watch.name)
                    .font(.headline)
                    .foregroundStyle(Theme.textPrimary)
                Spacer(minLength: 8)
                WatchStatusChip(status: watch.status)
            }
            // What the watch is for, before how much it has said. A list of
            // slugs and counts tells a reader which watches exist and nothing
            // about which one they are looking for.
            if let request = watch.request {
                Text(request)
                    .font(.subheadline)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(2)
            }
            Text(watch.firings == 1 ? "1 firing" : "\(watch.firings) firings")
                .font(.caption)
                .foregroundStyle(Theme.textSecondary)
            // Who asked for it, and where a firing goes. Two indicators on the
            // row rather than two lists: a watch is a watch however it was
            // asked for, and two watches with the same name and the same status
            // can still differ in the one way that matters when one fires.
            //
            // Side by side while both fit, stacked when they do not: an
            // integration's name appears in each of them, and two long ones on
            // one line truncate to a pair of half-words that name nobody.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 6) {
                    WatchIndicator(text: watchAskedBy(watch))
                    WatchIndicator(text: watchDeliveryLabel(watch))
                }
                VStack(alignment: .leading, spacing: 4) {
                    WatchIndicator(text: watchAskedBy(watch))
                    WatchIndicator(text: watchDeliveryLabel(watch))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            // Only the verdicts there is something to do about. A mark on every
            // row makes the mark mean nothing, and makes an unmarked row read
            // as unknown rather than as well.
            if let verdict = watch.verdict, let label = verdict.mark {
                WatchVerdictMark(label: label, because: verdict.because)
            }
            // Only when there is one. A watch that is simply running has no
            // note, and a row that always carried a line of small print would
            // train the reader to skip the line that matters.
            if let note = watch.note, !note.isEmpty {
                Text(note)
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(2)
            }
        }
        // The list insets the row to match the Privacy feed, so the row carries
        // only its vertical padding.
        .padding(.vertical, Theme.Spacing.md)
    }
}

/// The one indicator on a row that carries a colour.
///
/// The indicators beside it are facts about the watch and are deliberately
/// quiet. This is not a fact but a request — the watch has been looking at
/// things for a week and admitting none of them, or it is waking an agent
/// through a record that is gone — and it carries the numbers that say so, so
/// the row states the case rather than merely labelling it.
@available(iOS 17.0, *)
struct WatchVerdictMark: View {
    let label: String
    let because: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption2)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(Theme.warning.opacity(0.14), in: Capsule())
                .foregroundStyle(Theme.warning)
            Text(because)
                .font(.caption2)
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One fact about a watch, small enough that two of them fit on a row.
///
/// Deliberately unstyled by state: neither who asked nor where a firing goes is
/// good or bad news, and colouring them would compete with the status chip,
/// which is the one thing on the row that does report a state.
@available(iOS 17.0, *)
struct WatchIndicator: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption2)
            .lineLimit(1)
            .truncationMode(.tail)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Theme.textSecondary.opacity(0.12), in: Capsule())
            .foregroundStyle(Theme.textSecondary)
    }
}

/// Running, held, or finished — coloured so the one that needs attention is the
/// one that draws the eye.
@available(iOS 17.0, *)
struct WatchStatusChip: View {
    let status: String

    var body: some View {
        Text(label)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(tint.opacity(0.18), in: Capsule())
            .foregroundStyle(tint)
    }

    private var label: String {
        switch status {
        case "active": "running"
        case "paused": "held"
        case "retired": "finished"
        default: status
        }
    }

    private var tint: Color {
        switch status {
        case "active": Theme.accent
        case "paused": Theme.warning
        default: Theme.textSecondary
        }
    }
}

@available(iOS 17.0, *)
private struct WatchesEmptyState: View {
    var body: some View {
        // Named as something to do rather than as an absence: this screen cannot create one,
        // so an empty state that only said "none" would leave the reader with nowhere to go.
        // Asking is also the route a reader holding a phone can actually take — installing a
        // DSL file from a terminal is the other way in, and not one available from here.
        Text("No watches yet. Ask Omnesis to keep an eye on something.")
            .font(.subheadline)
            .multilineTextAlignment(.center)
            .foregroundStyle(Theme.textSecondary)
            .padding(.horizontal, 32)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Previews

#if DEBUG

@available(iOS 17.0, *)
#Preview("WatchesListContent — populated") {
    NavigationStack {
        WatchesListContent(
            watches: PreviewMocks.watches,
            loading: false,
            loadError: nil,
            onSelect: { _ in },
            onRetry: {}
        )
        .navigationTitle("Watches")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bgPrimary, for: .navigationBar)
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("WatchesListContent — empty") {
    NavigationStack {
        WatchesListContent(
            watches: [],
            loading: false,
            loadError: nil,
            onSelect: { _ in },
            onRetry: {}
        )
        .navigationTitle("Watches")
        .navigationBarTitleDisplayMode(.inline)
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("WatchesListContent — error") {
    NavigationStack {
        WatchesListContent(
            watches: [],
            loading: false,
            loadError: URLError(.cannotConnectToHost),
            onSelect: { _ in },
            onRetry: {}
        )
        .navigationTitle("Watches")
        .navigationBarTitleDisplayMode(.inline)
    }
    .preferredColorScheme(.dark)
}
#endif
#endif
