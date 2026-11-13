// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

@available(iOS 17.0, *)
extension SourceFilterEditorView {
    var visibleLabelHints: [ScopeItemHint] {
        if let openedClient, (try? openedClient.authorized(for: store.access)) == nil { return [] }
        return labelHints
    }

    /// The names the editor learnt, each with the source's word for its kind, as the host keeps them.
    var namedHints: [ScopeItemHint] {
        visibleLabelHints.map { hint in
            var named = hint
            if named.noun == nil { named.noun = scopeFieldNoun(hint.ref, fields: editor?.fields ?? []) }
            return named
        }
    }

    /// What the screens know about one selected item, with the editor's word for its kind when nothing named it yet.
    func hint(for ref: ScopeRef) -> ScopeItemHint? {
        scopeLabelHint(for: ref, in: namedHints)
    }

    func adoptPickerSession(_ value: ScopePickerSession) {
        guard (try? openedClient?.authorized(for: store.access)) != nil else { pickerSession = .init()
            return
        }
        pickerSession = value
        let fields = editor?.fields ?? []
        labelHints = mergingScopeLabelHints(
            labelHints,
            scopeCatalogueLabelHints(value, sourceId: source.id, fields: fields),
            preserveMissing: true
        )
    }

    func resolveDisplayHints() async {
        guard policy.editable, !refs.isEmpty,
              refs.contains(where: { scopeLabelHint(for: $0, in: visibleLabelHints) == nil }) else { return }
        guard let client = try? parentClient?.authorized(for: store.access) else { return }
        let requested = policy
        do {
            guard let value = try await scopeSettledPreview(requested, client: client) else { return }
            guard !Task.isCancelled, (try? client.authorized(for: store.access)) != nil,
                  requested == policy, value.sourceId == source.id else { return }
            labelHints = mergingScopeLabelHints(labelHints, scopeItemHints(value, fields: editor?.fields ?? []))
        } catch { /* Names are optional display hints; count validation remains separate. */ }
    }

    func previewItem(_ index: Int) -> ScopePreview.Item? {
        guard error == nil, previewedPolicy == policy, preview?.sourceId == source.id,
              refs.indices.contains(index), let items = preview?.items else { return nil }
        return items.first { scopeRefIdentityMatches($0.ref, refs[index]) }
    }
}

#if DEBUG
#Preview("Named filter") {
    NavigationStack {
        PreviewMocks.accessFilterEditor(PreviewMocks.accessWhatsApp, policy: PreviewMocks.accessWhatsAppPolicy, step: .matches)
    }.environment(AppStore.preview())
}
#endif
#endif
