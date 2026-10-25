// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The documents a task refers to, under its title: each its source's icon
/// then its title, opening the document when tapped. A long list shows the
/// first few and a "+N more" that reveals the rest.
///
/// The store is optional so a row renders where none is injected; without
/// one there is no icon to look up, and the title alone still names the
/// document.
@available(iOS 17.0, *)
struct TaskDocumentsList: View {
    let task: TaskRecord
    var onOpen: (TaskDocument) -> Void = { _ in }
    @Environment(AppStore.self) private var store: AppStore?
    @State private var showAll = false

    var body: some View {
        let list = TaskJournal.documents(task, showAll: showAll)
        if !list.shown.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(list.shown) { document in
                    Button { onOpen(document) } label: { row(document) }
                        .buttonStyle(.plain)
                        .accessibilityLabel(document.title.isEmpty ? "Untitled document" : document.title)
                        .accessibilityHint("Opens the document")
                }
                if list.hidden > 0 {
                    Button("+\(list.hidden) more") { showAll = true }
                        .buttonStyle(.plain)
                        .font(.footnote)
                        .foregroundStyle(Theme.textMuted)
                        .frame(minHeight: 28, alignment: .leading)
                        .accessibilityLabel("Show \(list.hidden) more documents")
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("tasks.documents")
        }
    }

    private func row(_ document: TaskDocument) -> some View {
        HStack(spacing: 6) {
            if let store {
                SourceIconView(sourceId: document.sourceId, store: store, size: 14)
            }
            Text(document.title.isEmpty ? "Untitled document" : document.title)
                .font(.footnote)
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .frame(minHeight: 28, alignment: .leading)
        .contentShape(Rectangle())
    }
}

#endif
