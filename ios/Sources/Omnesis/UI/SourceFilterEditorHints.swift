// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

@available(iOS 17.0, *)
extension SourceFilterEditorView {
    var visibleLabelHints: [ScopePreview.Item] {
        if let openedClient, (try? openedClient.authorized(for: store.access)) == nil { return [] }
        return labelHints
    }

    func adoptPickerSession(_ value: ScopePickerSession) {
        guard (try? openedClient?.authorized(for: store.access)) != nil else { pickerSession = .init()
            return
        }
        pickerSession = value
        labelHints = mergingScopeLabelHints(labelHints, scopeCatalogueLabelHints(value, sourceId: source.id), preserveMissing: true)
    }

    func resolveDisplayHints() async {
        guard policy.editable, !refs.isEmpty,
              refs.contains(where: { scopeLabelHint(for: $0, in: visibleLabelHints) == nil }) else { return }
        guard let client = try? parentClient?.authorized(for: store.access) else { return }
        let requested = policy
        do {
            let value = try await client.scopePreview(requested)
            guard !Task.isCancelled, (try? client.authorized(for: store.access)) != nil,
                  requested == policy, value.sourceId == source.id else { return }
            labelHints = mergingScopeLabelHints(labelHints, value.items)
        } catch { /* Names are optional display hints; count validation remains separate. */ }
    }

    func previewItem(_ index: Int) -> ScopePreview.Item? {
        guard !loading, error == nil, previewedPolicy == policy, preview?.sourceId == source.id,
              refs.indices.contains(index), let items = preview?.items else { return nil }
        return scopeLabelHint(for: refs[index], in: items)
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
