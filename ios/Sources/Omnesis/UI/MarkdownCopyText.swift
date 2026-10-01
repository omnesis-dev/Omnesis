// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Completed Markdown only: unlike the streaming display cache, this parser
/// never supplies synthetic closing delimiters to create a copyable value.
enum MarkdownCopyContent {
    static func isPlainFence(_ language: String) -> Bool {
        ["", "text", "plain", "plaintext", "txt"].contains(language.lowercased())
    }

    static func fencedDisplay(_ value: String) -> String {
        var display = value
        while display.hasSuffix("\n") {
            display.removeLast()
        }
        return display
    }

    static func inline(_ raw: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: raw, options: options)) ?? AttributedString(raw)
    }

    static func values(in raw: String) -> [String] {
        var values: [String] = []
        var current: String?
        let parsed = inline(raw)
        for run in parsed.runs {
            if run.inlinePresentationIntent?.contains(.code) == true {
                current = (current ?? "") + String(parsed[run.range].characters)
            } else if let value = current {
                values.append(value)
                current = nil
            }
        }
        if let value = current { values.append(value) }
        return values
    }
}

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import UIKit

/// A selectable text view keeps emphasis, links and line wrapping together.
/// Attachment slots reserve inline space for real, separately accessible
/// buttons, without making clipboard actions masquerade as hyperlinks.
@available(iOS 17.0, *)
struct MarkdownCopyText: UIViewRepresentable {
    let raw: String
    /// Literal multiline display with one trailing button for the full payload.
    var wholeValue: String?
    var font: UIFont = .systemFont(ofSize: 14)
    var color: Color = Theme.textPrimary

    func makeUIView(context _: Context) -> MarkdownCopyTextView {
        let view = MarkdownCopyTextView()
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }

    func updateUIView(_ view: MarkdownCopyTextView, context: Context) {
        let category = context.environment.dynamicTypeSize.uiContentSizeCategory
        let traits = UITraitCollection(preferredContentSizeCategory: category)
        let scaledFont = UIFontMetrics(forTextStyle: .body).scaledFont(for: font, compatibleWith: traits)
        view.update(raw: raw, wholeValue: wholeValue, font: scaledFont, color: UIColor(color))
        view.semanticContentAttribute = context.environment.layoutDirection == .rightToLeft
            ? .forceRightToLeft : .forceLeftToRight
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: MarkdownCopyTextView, context _: Context) -> CGSize? {
        uiView.sizeThatFits(CGSize(width: proposal.width ?? 220, height: .greatestFiniteMagnitude))
    }
}

@available(iOS 17.0, *)
final class MarkdownCopyTextView: UIView {
    let textView = UITextView()
    private static let spacerImage: UIImage = {
        let format = UIGraphicsImageRendererFormat()
        format.opaque = false
        return UIGraphicsImageRenderer(size: CGSize(width: 1, height: 1), format: format).image { _ in }
    }()

    override init(frame: CGRect) {
        super.init(frame: frame)
        textView.isEditable = false
        textView.isScrollEnabled = false
        textView.backgroundColor = .clear
        textView.textContainerInset = .zero
        textView.textContainer.lineFragmentPadding = 0
        addSubview(textView)
    }

    required init?(coder: NSCoder) {
        nil
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        textView.sizeThatFits(size)
    }

    private struct CopySlot {
        let range: NSRange
        let button: UIButton
    }

    private var slots: [CopySlot] = []
    private var renderedKey: String = ""

    func update(raw: String, wholeValue: String? = nil, font: UIFont, color: UIColor) {
        let key = "\(raw)\u{0}\(wholeValue ?? "")\u{0}\(font.fontName)\(font.pointSize)\(color)"
        guard key != renderedKey else { return }
        renderedKey = key
        slots.forEach { $0.button.removeFromSuperview() }
        slots.removeAll()
        let parsed = wholeValue == nil ? MarkdownCopyContent.inline(raw) : AttributedString(raw)
        let result = NSMutableAttributedString(string: "")
        var codeValue: String?

        func appendButton() {
            guard let value = codeValue else { return }
            let attachment = NSTextAttachment()
            attachment.image = Self.spacerImage
            attachment.bounds = CGRect(x: 0, y: -8, width: 44, height: max(font.lineHeight, 28))
            let range = NSRange(location: result.length, length: 1)
            result.append(NSAttributedString(attachment: attachment))
            let button = UIButton(type: .system)
            button.setPreferredSymbolConfiguration(UIImage.SymbolConfiguration(pointSize: 13), forImageIn: .normal)
            button.setImage(UIImage(systemName: "square.on.square"), for: .normal)
            button.tintColor = UIColor(Theme.textMuted)
            button.accessibilityLabel = "Copy \(value)"
            button.accessibilityHint = "Copies this value to the clipboard"
            button.addAction(UIAction { [weak button] _ in
                UIPasteboard.general.string = value
                button?.setImage(UIImage(systemName: "checkmark"), for: .normal)
                button?.accessibilityLabel = "Copied \(value)"
                UIAccessibility.post(notification: .announcement, argument: "Copied")
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak button] in
                    button?.setImage(UIImage(systemName: "square.on.square"), for: .normal)
                    button?.accessibilityLabel = "Copy \(value)"
                }
            }, for: .touchUpInside)
            addSubview(button)
            slots.append(CopySlot(range: range, button: button))
            codeValue = nil
        }

        for run in parsed.runs {
            let value = String(parsed[run.range].characters)
            let intent = run.inlinePresentationIntent ?? []
            let isCode = intent.contains(.code)
            if !isCode { appendButton() }
            var runFont = isCode ? UIFont.monospacedSystemFont(ofSize: font.pointSize, weight: .regular) : font
            var traits = runFont.fontDescriptor.symbolicTraits.union(font.fontDescriptor.symbolicTraits)
            if intent.contains(.stronglyEmphasized) { traits.insert(.traitBold) }
            if intent.contains(.emphasized) { traits.insert(.traitItalic) }
            if let descriptor = runFont.fontDescriptor.withSymbolicTraits(traits) {
                runFont = UIFont(descriptor: descriptor, size: font.pointSize)
            }
            var attributes: [NSAttributedString.Key: Any] = [.font: runFont, .foregroundColor: color]
            if intent.contains(.strikethrough) { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            if let link = run.link { attributes[.link] = link }
            result.append(NSAttributedString(string: value, attributes: attributes))
            if isCode { codeValue = (codeValue ?? "") + value }
        }
        if let wholeValue { codeValue = wholeValue }
        appendButton()
        textView.attributedText = result
        textView.linkTextAttributes = [.foregroundColor: UIColor(Theme.accent)]
        accessibilityElements = [textView] + slots.map(\.button)
        setNeedsLayout()
        invalidateIntrinsicContentSize()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        textView.frame = bounds
        textView.layoutManager.ensureLayout(for: textView.textContainer)
        for slot in slots {
            let glyphRange = textView.layoutManager.glyphRange(forCharacterRange: slot.range, actualCharacterRange: nil)
            let rect = textView.layoutManager.boundingRect(forGlyphRange: glyphRange, in: textView.textContainer)
            slot.button.frame = CGRect(x: rect.minX, y: rect.midY - 22, width: 44, height: 44)
        }
    }
}

extension DynamicTypeSize {
    fileprivate var uiContentSizeCategory: UIContentSizeCategory {
        switch self {
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
}

@available(iOS 17.0, *)
struct MarkdownCodeCopyButton: View {
    let value: String
    @State private var copied = false

    var body: some View {
        Button {
            UIPasteboard.general.string = value
            copied = true
            UIAccessibility.post(notification: .announcement, argument: "Copied")
        } label: {
            Image(systemName: copied ? "checkmark" : "square.on.square")
                .font(.system(size: 13))
                .frame(width: 44, height: 44)
        }
        .buttonStyle(.plain)
        .foregroundStyle(Theme.textMuted)
        .accessibilityLabel(copied ? "Copied code block" : "Copy code block")
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(2))
            if !Task.isCancelled { copied = false }
        }
    }
}

#if DEBUG
#Preview("Copyable Markdown — inline wrapping") {
    MarkdownCopyText(raw: PreviewMocks.copyableMarkdownInline)
        .padding()
        .background(Theme.bgPrimary)
}

#Preview("Copyable Markdown — multiline block") {
    MarkdownCopyText(
        raw: MarkdownCopyContent.fencedDisplay(PreviewMocks.copyableMarkdownBlock),
        wholeValue: PreviewMocks.copyableMarkdownBlock
    )
    .padding()
    .background(Theme.bgPrimary)
}
#endif
#endif
