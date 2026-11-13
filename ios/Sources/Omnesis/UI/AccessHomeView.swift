// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The Access page: every access level with what it allows and the connections that use it.
@available(iOS 17.0, *)
struct AccessHomeView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var overview: AccessOverview?
    @State private var error: Error?
    @State private var creating = false
    @State private var connecting = false
    @State private var menuOpen = false
    @State private var editingLevelId: String?
    @State private var deletion: AccessLevelDeletionPrompt?
    @State private var deleting = false

    /// `previewDeleting` opens the delete dialog of that level: its confirmation, or why it is still in use.
    init(previewOverview: AccessOverview? = nil, previewDeleting: AccessLevelSummary? = nil, previewMenuOpen: Bool = false) {
        _overview = State(initialValue: previewOverview)
        _menuOpen = State(initialValue: previewMenuOpen)
        _deletion = State(initialValue: previewOverview.flatMap { overview in
            previewDeleting.map { AccessLevelDeletionPrompt(level: $0, overview: overview) }
        })
    }

    var body: some View {
        AccessFrame {
            AccessTopBar(title: "Access") { AccessBarButton("Back") { dismiss() } } trailing: {
                Button { menuOpen.toggle() } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(Theme.accent)
                        .frame(width: 44, height: 44, alignment: .trailing)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Access actions")
                .disabled(overview == nil)
            }
        } content: {
            if let overview {
                AccessScroll { levels(overview) }.refreshable { await load() }.disabled(deleting)
            } else if let error {
                GatewayErrorView(context: "load access levels", error: error, onRetry: { Task { await load() } })
            } else {
                ProgressView("Loading access…").padding(.top, 24)
            }
        } footer: {
            EmptyView()
        }
        .overlay {
            if menuOpen {
                AccessMenu(items: [
                    .init(title: AccessConnectionCopy.newLevel, symbol: "plus") { creating = true },
                    .init(title: AccessConnectionCopy.connectAgent, symbol: "link") { connecting = true },
                ]) { menuOpen = false }
            }
        }
        .overlay { if let deletion { dialog(deletion) } }
        .task { if overview == nil { await load() } }
        .navigationDestination(item: $editingLevelId) { id in
            if let overview, let level = overview.levels.first(where: { $0.id == id }) {
                AccessLevelEditorView(level: level, overview: overview, saved: { Task { await load() } })
            }
        }
        .sheet(isPresented: $creating) {
            if let overview {
                NavigationStack { AccessLevelEditorView(level: nil, overview: overview, saved: { Task { await load() } }) }
            }
        }
        .sheet(isPresented: $connecting) { AccessAuthorizationSheet() }
    }

    @ViewBuilder private func levels(_ overview: AccessOverview) -> some View {
        let listed = accessLevelsByName(overview)
        ForEach(Array(listed.enumerated()), id: \.element.id) { index, level in
            levelGroup(level, overview: overview)
            if index < listed.count - 1 { AccessDivider() }
        }
        Text(overview.levels.isEmpty ? "No access levels yet." : "Touch and hold an access level to delete it.")
            .accessText(.caption, color: AccessUI.muted)
            .fontWeight(.regular)
            .padding(.top, 8)
    }

    private func levelGroup(_ level: AccessLevelSummary, overview: AccessOverview) -> some View {
        let usage = AccessLevelUsage(level: level, overview: overview)
        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(level.name).accessText(.heading)
                    AccessCapabilityPills(holdings: accessCapabilityHoldings(rules: level.rules))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(AccessUI.muted)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 10) {
                AccessLevelUsageNames(usage: usage)
                if usage.connections.isEmpty, usage.integrations.isEmpty {
                    Text(AccessConnectionCopy.connectionCount(0)).accessText(.subtitle, color: AccessUI.muted)
                }
            }
            .padding(.leading, 14)
            .overlay(alignment: .leading) { Rectangle().fill(AccessUI.divider).frame(width: 2) }
        }
        .padding(.vertical, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
        .onTapGesture { editingLevelId = level.id }
        .onLongPressGesture { deletion = AccessLevelDeletionPrompt(level: level, overview: overview) }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(named: "Delete access level") { deletion = AccessLevelDeletionPrompt(level: level, overview: overview) }
    }

    private func dialog(_ prompt: AccessLevelDeletionPrompt) -> some View {
        AccessDialog(
            title: prompt.title,
            message: prompt.refusal ?? "This cannot be undone.",
            actions: prompt.refusal == nil
                ? [
                    .init(title: "Cancel") { deletion = nil },
                    .init(title: "Delete", destructive: true) {
                        deletion = nil
                        Task { await delete(prompt.level) }
                    },
                ]
                : [.init(title: "OK") { deletion = nil }]
        )
    }

    private func delete(_ level: AccessLevelSummary) async {
        guard let client = store.access, !deleting else { return }
        deleting = true
        defer { deleting = false }
        do {
            try await client.deleteLevel(id: level.id)
        } catch {
            guard client.isCurrent(store.access) else { return }
            if let refusal = accessLevelDeletionFailureMessage(error) {
                deletion = AccessLevelDeletionPrompt(
                    level: level,
                    refusal: refusal,
                    inUse: accessLevelMutationCode(error) == "level-in-use"
                )
            }
        }
        await load()
    }

    private func load() async {
        guard let client = store.access else { return }
        do {
            let value = try await client.overview()
            try Task.checkCancellation()
            guard client.isCurrent(store.access) else { return }
            overview = value
            error = nil
        } catch is CancellationError {} catch { self.error = error }
    }
}

/// What the delete dialog of an access level says: a confirmation, or why the level was kept.
struct AccessLevelDeletionPrompt {
    let level: AccessLevelSummary
    var refusal: String?
    var inUse = false

    init(level: AccessLevelSummary, refusal: String? = nil, inUse: Bool = false) {
        self.level = level
        self.refusal = refusal
        self.inUse = inUse
    }

    /// Asks for confirmation when nothing uses the level, and names what still does otherwise.
    init(level: AccessLevelSummary, overview: AccessOverview) {
        let block = AccessLevelUsage(level: level, overview: overview).deletionBlock
        self.init(level: level, refusal: block, inUse: block != nil)
    }

    var title: String {
        guard refusal != nil else { return "Delete “\(level.name)”?" }
        return inUse ? "This access level is still in use" : "This access level was not deleted"
    }
}

#if DEBUG
#Preview("Access") {
    NavigationStack { AccessHomeView(previewOverview: PreviewMocks.accessCanonicalOverview) }.environment(AppStore.preview())
}

#Preview("Access menu") {
    NavigationStack { AccessHomeView(previewOverview: PreviewMocks.accessCanonicalOverview, previewMenuOpen: true) }
        .environment(AppStore.preview())
}

#Preview("Delete an access level") {
    let overview = PreviewMocks.accessCanonicalOverview
    NavigationStack { AccessHomeView(previewOverview: overview, previewDeleting: overview.levels[1]) }.environment(AppStore.preview())
}

#Preview("Access level still in use") {
    let overview = PreviewMocks.accessCanonicalOverview
    NavigationStack { AccessHomeView(previewOverview: overview, previewDeleting: overview.levels[0]) }.environment(AppStore.preview())
}
#endif

#endif
