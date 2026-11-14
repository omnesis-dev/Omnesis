// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// "Who can read this?": for one document, every access level with the agents on it, and whether its Answer and its
/// Direct can read the document, each with the gateway's reason. Owner only; the gateway runs the same check an
/// agent's read runs.
@available(iOS 17.0, *)
struct DocumentAccessView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let documentId: String
    @State private var audit: DocumentAccessAudit?
    @State private var error: Error?
    @State private var attempt = 0

    init(documentId: String, previewAudit: DocumentAccessAudit? = nil) {
        self.documentId = documentId
        _audit = State(initialValue: previewAudit)
    }

    var body: some View {
        AccessFrame {
            AccessTopBar(title: "") { AccessBarButton("Back") { dismiss() } }
        } content: {
            AccessScroll {
                AccessHeader(title: DocumentAccessCopy.title) {
                    if let audit { DocumentAccessSubject(audit: audit) }
                }
                if let audit {
                    content(audit)
                } else if let error {
                    GatewayErrorView(context: "check who can read this document", error: error, onRetry: { attempt += 1 })
                } else {
                    SourceFilterLoadingLine()
                }
            }
        } footer: {
            EmptyView()
        }
        .task(id: attempt) { if audit == nil { await load() } }
    }

    @ViewBuilder private func content(_ audit: DocumentAccessAudit) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(audit.notes.answer)
            Text(audit.notes.owner)
        }
        .accessText(.caption, color: AccessUI.secondary)
        .fontWeight(.regular)
        .fixedSize(horizontal: false, vertical: true)
        if audit.levels.isEmpty {
            Text(DocumentAccessCopy.noLevels)
                .accessText(.rowSecondary, color: AccessUI.secondary)
                .padding(.top, AccessUI.sectionGap)
        }
        ForEach(audit.levels) { level in DocumentAccessLevelSection(level: level) }
    }

    private func load() async {
        guard let client = store.access else { return }
        do {
            let value = try await client.documentAccess(documentId: documentId)
            guard client.isCurrent(store.access) else { return }
            audit = value
            error = nil
        } catch is CancellationError {} catch {
            self.error = error
        }
    }
}

/// The words of the "Who can read this?" page that are the app's own; every reason is the gateway's.
enum DocumentAccessCopy {
    static let title = "Who can read this?"
    static let noLevels = "There are no access levels, so no agent can read this document."
    static let noConnections = "No connections"
    static let canRead = "Can read"
    static let cannotRead = "Can’t read"
}

/// The document the page is about: its source's icon, its title, and the account it comes from.
@available(iOS 17.0, *)
private struct DocumentAccessSubject: View {
    let audit: DocumentAccessAudit

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            AccessSourceIcon(source: AccessSourceInstance(id: audit.sourceId, name: audit.sourceName), size: 20)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 2) {
                Text(audit.title).accessText(.subtitle).fixedSize(horizontal: false, vertical: true)
                Text(audit.sourceLine).accessText(.subtitle, color: AccessUI.secondary).lineLimit(1).truncationMode(.middle)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// One access level: its name, the agents on it, and its two verdicts.
@available(iOS 17.0, *)
private struct DocumentAccessLevelSection: View {
    let level: DocumentAccessAudit.Level

    var body: some View {
        AccessSectionHeading(level.name)
        VStack(alignment: .leading, spacing: 6) {
            let usage = AccessLevelUsage(agents: level.agents)
            if usage.inUse {
                AccessLevelUsageNames(usage: usage)
            } else {
                Text(DocumentAccessCopy.noConnections).accessText(.subtitle, color: AccessUI.muted)
            }
        }
        .padding(.bottom, 4)
        DocumentAccessVerdictRow(capability: .answer, verdict: level.answer, last: false)
        DocumentAccessVerdictRow(capability: .direct, verdict: level.direct, last: true)
    }
}

/// One capability's verdict: its pill, in its colour when the level grants the capability and muted when it does
/// not, a mark and words that say whether it can read the document, and the gateway's reason under them.
@available(iOS 17.0, *)
struct DocumentAccessVerdictRow: View {
    let capability: AccessCapability
    let verdict: DocumentAccessVerdict
    let last: Bool

    var body: some View {
        AccessRow(last: last) {
            HStack(alignment: .firstTextBaseline, spacing: AccessUI.iconGap) {
                AccessCapabilityPill(capability: capability, held: verdict.code != DocumentAccessVerdict.notGranted)
                    .frame(width: 64, alignment: .leading)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Image(systemName: verdict.readable ? "checkmark" : "xmark")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(verdict.readable ? Theme.success : AccessUI.secondary)
                            .accessibilityHidden(true)
                        Text(verdict.readable ? DocumentAccessCopy.canRead : DocumentAccessCopy.cannotRead)
                            .accessText(.rowTitle, color: verdict.readable ? Theme.success : Theme.textPrimary)
                    }
                    Text(verdict.text)
                        .accessText(.rowSecondary, color: AccessUI.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(capability.label): \(verdict.readable ? DocumentAccessCopy.canRead : DocumentAccessCopy.cannotRead). \(verdict.text)"
        )
    }
}

/// The owner's view of a document's access, at the top of its inspector: the way to "Who can read this?" and what a
/// filter can see on the document. Shown only once the gateway has given the filter details, which only the paired
/// owner's credential can read.
@available(iOS 17.0, *)
struct DocumentAccessSection: View {
    @Environment(AppStore.self) private var store
    let documentId: String
    @State private var details: DocumentFilterDetails?
    private let previewing: Bool

    init(documentId: String, previewDetails: DocumentFilterDetails? = nil) {
        self.documentId = documentId
        _details = State(initialValue: previewDetails)
        previewing = previewDetails != nil
    }

    var body: some View {
        // Shown once the details arrive: a gateway that cannot answer for them cannot say who reads the document.
        Group { if let details { owner(details) } }
            .task(id: documentId) { await load() }
    }

    @ViewBuilder private func owner(_ details: DocumentFilterDetails) -> some View {
        NavigationLink { DocumentAccessView(documentId: documentId) } label: {
            HStack(spacing: 10) {
                Image(systemName: "lock.shield").font(.system(size: 16)).accessibilityHidden(true)
                Text(DocumentAccessCopy.title).font(.system(size: 15, weight: .medium))
                Spacer(minLength: 8)
                Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.textSecondary)
            }
            .foregroundStyle(Theme.accent)
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .padding(.top, Theme.Spacing.sm)
        FlatSection("Filter details") {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(documentFilterDetailRows(details), id: \.key) { row in InspectorKeyValue(key: row.key, value: row.value) }
            }
        }
    }

    private func load() async {
        guard !previewing, let client = store.access else { return }
        details = try? await client.documentFilterDetails(documentId: documentId)
    }
}

/// The account a document comes from, as the inspector names it: "WhatsApp · +1 (555) 010-0123".
@available(iOS 17.0, *)
@MainActor
func documentSourceLine(_ sourceId: String, store: AppStore) -> String {
    let name = store.sourceLabel(forSourceId: sourceId) ?? humanName(for: sourceTypeFromId(sourceId))
    let account = store.sources.first { $0.id == sourceId }?.accountId ?? sourceAccountOf(sourceId)
    return account.isEmpty ? name : name + " · " + account
}

/// A name and its value on one line of the document inspector.
struct InspectorKeyValue: View {
    let key: String
    let value: String
    var mono = false

    var body: some View {
        HStack(alignment: .top) {
            Text(key)
                .font(.system(size: 12))
                .foregroundStyle(Theme.textSecondary)
            Spacer(minLength: 12)
            Text(value)
                .font(mono ? Theme.monospace(size: 11) : .system(size: 12))
                .foregroundStyle(Theme.textPrimary)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
    }
}

#if DEBUG
#Preview("Who can read this") {
    DocumentAccessView(documentId: PreviewMocks.accessDocumentId, previewAudit: PreviewMocks.accessDocumentAudit)
        .environment(AppStore.preview())
}

#Preview("Loading") {
    DocumentAccessView(documentId: PreviewMocks.accessDocumentId).environment(AppStore.preview())
}

#Preview("No access levels") {
    var audit = PreviewMocks.accessDocumentAudit
    audit.levels = []
    return DocumentAccessView(documentId: PreviewMocks.accessDocumentId, previewAudit: audit).environment(AppStore.preview())
}
#endif
#endif
