// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import UIKit

/// Plain facts flow with the result, with each document's icon and title sharing
/// an internal navigation link. Rich text wraps even very long document titles.
@available(iOS 17.0, *)
struct SearchBreadcrumbsView: View {
    let provenance: SearchProvenance
    let documentId: String
    let store: AppStore
    @State private var selectedDocument: String?

    var body: some View {
        let facts = SearchBreadcrumbFormatter.facts(provenance, documentId: documentId)
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(facts.enumerated()), id: \.offset) { _, fact in
                HStack(alignment: .top, spacing: 6) {
                    Text("•")
                        .foregroundStyle(Theme.textMuted)
                        .fixedSize()
                        .frame(width: 12, alignment: .leading)
                    BreadcrumbRichText(fact: fact, store: store) { selectedDocument = $0 }
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("search.breadcrumbs")
        .navigationDestination(item: $selectedDocument) { id in
            DocumentDetailView(documentId: id)
        }
    }
}

@available(iOS 17.0, *)
private struct BreadcrumbRichText: UIViewRepresentable {
    let fact: SearchBreadcrumbFact
    let store: AppStore
    let onOpen: (String) -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.colorScheme) private var colorScheme

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.adjustsFontForContentSizeCategory = true
        view.delegate = context.coordinator
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.onOpen = onOpen
        let font = UIFont.preferredFont(
            forTextStyle: .footnote,
            compatibleWith: UITraitCollection(preferredContentSizeCategory: contentSizeCategory)
        )
        let text = NSMutableAttributedString(string: "")
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font, .foregroundColor: UIColor(Theme.textSecondary),
        ]
        for fragment in fact.fragments {
            switch fragment {
            case .text(let value): text.append(NSAttributedString(string: value, attributes: attributes))
            case .document(let document):
                let start = text.length
                let attachment = NSTextAttachment()
                attachment.image = icon(document.sourceId)
                let size = font.capHeight
                attachment.bounds = CGRect(x: 0, y: (font.capHeight - size) / 2, width: size, height: size)
                text.append(NSAttributedString(attachment: attachment))
                let title = document.title.flatMap { $0.isEmpty ? nil : $0 } ?? "Untitled document"
                text.append(NSAttributedString(string: "\u{00A0}\(title)", attributes: attributes))
                if let url = SearchBreadcrumbNavigation.url(documentId: document.documentId) {
                    text.addAttribute(.link, value: url, range: NSRange(location: start, length: text.length - start))
                }
            }
        }
        view.linkTextAttributes = [.foregroundColor: UIColor(Theme.accent)]
        view.attributedText = text
        view.accessibilityLabel = fact.plainText
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        guard let width = proposal.width else { return nil }
        let fitted = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: width, height: fitted.height)
    }

    private var contentSizeCategory: UIContentSizeCategory {
        switch dynamicTypeSize {
        case .xSmall: .extraSmall
        case .small: .small
        case .medium: .medium
        case .large: .large
        case .xLarge: .extraLarge
        case .xxLarge: .extraExtraLarge
        case .xxxLarge: .extraExtraExtraLarge
        case .accessibility1: .accessibilityMedium
        case .accessibility2: .accessibilityLarge
        case .accessibility3: .accessibilityExtraLarge
        case .accessibility4: .accessibilityExtraExtraLarge
        case .accessibility5: .accessibilityExtraExtraExtraLarge
        @unknown default: .large
        }
    }

    private func icon(_ sourceId: String) -> UIImage? {
        let type = sourceTypeFromId(sourceId)
        let source = store.sourceIconById[sourceId] ?? store.sourceIconByType[type]
        if let source, source.hasPrefix("data:"), let comma = source.firstIndex(of: ","),
           let data = Data(base64Encoded: String(source[source.index(after: comma)...])),
           let image = UIImage(data: data) ?? ProviderSVGRenderer.render(data, colorScheme: colorScheme) { return image }
        return UIImage(systemName: "doc.text")?.withTintColor(UIColor(Theme.accent), renderingMode: .alwaysOriginal)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onOpen: onOpen)
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var onOpen: (String) -> Void
        init(onOpen: @escaping (String) -> Void) {
            self.onOpen = onOpen
        }

        func textView(
            _ textView: UITextView, shouldInteractWith URL: URL,
            in characterRange: NSRange, interaction: UITextItemInteraction
        )
            -> Bool {
            if let id = SearchBreadcrumbNavigation.documentId(URL) {
                onOpen(id)
            }
            return false
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Search — graph facts") {
    NavigationStack {
        SearchBreadcrumbsView(
            provenance: PreviewMocks.searchProvenance,
            documentId: "sample-root",
            store: AppStore.preview()
        ).padding().background(Theme.bgPrimary)
    }
}

@available(iOS 17.0, *)
#Preview("Search — graph facts, large text") {
    NavigationStack {
        SearchBreadcrumbsView(
            provenance: PreviewMocks.searchProvenance,
            documentId: "sample-root",
            store: AppStore.preview()
        ).padding().background(Theme.bgPrimary)
    }.environment(\.dynamicTypeSize, .accessibility3)
}
#endif
#endif
