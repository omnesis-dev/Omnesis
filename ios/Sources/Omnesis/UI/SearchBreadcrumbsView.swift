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
        view.isAccessibilityElement = true
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
                text.append(NSAttributedString(string: "\u{00A0}\(document.displayTitle)", attributes: attributes))
                if let url = SearchBreadcrumbNavigation.url(documentId: document.documentId) {
                    text.addAttribute(.link, value: url, range: NSRange(location: start, length: text.length - start))
                }
            }
        }
        view.linkTextAttributes = [.foregroundColor: UIColor(Theme.accent)]
        view.attributedText = text
        // VoiceOver reads the fact as one sentence, without the icons, and
        // offers each linked document as its own action.
        view.accessibilityLabel = fact.plainText
        let coordinator = context.coordinator
        view.accessibilityCustomActions = fact.links.map { document in
            UIAccessibilityCustomAction(name: "Open \(document.displayTitle)") { _ in
                coordinator.onOpen(document.documentId)
                return true
            }
        }
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

        /// A tap on a breadcrumb link opens its document in place; any other
        /// link does nothing rather than leaving the app.
        func textView(
            _ textView: UITextView, primaryActionFor textItem: UITextItem, defaultAction: UIAction
        )
            -> UIAction? {
            guard let id = documentId(textItem, in: textView) else { return nil }
            return UIAction { [weak self] _ in self?.onOpen(id) }
        }

        /// A long-press offers only opening the document. The system menu
        /// (Open Link, Copy Link, a web preview) would act on the internal
        /// navigation URL, which nothing outside this view can open.
        func textView(
            _ textView: UITextView, menuConfigurationFor textItem: UITextItem, defaultMenu: UIMenu
        )
            -> UITextItem.MenuConfiguration? {
            guard let id = documentId(textItem, in: textView) else { return nil }
            let open = UIAction(title: "Open Document", image: UIImage(systemName: "doc.text")) { [weak self] _ in
                self?.onOpen(id)
            }
            return UITextItem.MenuConfiguration(menu: UIMenu(children: [open]))
        }

        /// The document a link names. The icon and the title share one link,
        /// so an item reported for the icon attachment reads the link
        /// attribute under it.
        private func documentId(_ textItem: UITextItem, in textView: UITextView) -> String? {
            if case .link(let url) = textItem.content {
                return SearchBreadcrumbNavigation.documentId(url)
            }
            let text = textView.attributedText ?? NSAttributedString()
            guard textItem.range.location < text.length,
                  let url = text.attribute(.link, at: textItem.range.location, effectiveRange: nil) as? URL
            else { return nil }
            return SearchBreadcrumbNavigation.documentId(url)
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
