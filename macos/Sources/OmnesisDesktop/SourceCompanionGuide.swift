// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
import SwiftUI

/// Guide declaration presence is significant: explicit null is malformed guide metadata, not absence.
@propertyWrapper
struct DeclaredSourceGuideField<Value: Decodable & Equatable>: Decodable, Equatable {
    let wrappedValue: Value?
    let projectedValue: Bool
    init() {
        wrappedValue = nil
        projectedValue = false
    }

    init(from decoder: Decoder) throws {
        projectedValue = true
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { wrappedValue = nil }
        else { wrappedValue = try Value(from: decoder) }
    }
}

extension KeyedDecodingContainer {
    func decode<Value: Decodable & Equatable>(
        _ type: DeclaredSourceGuideField<Value>.Type,
        forKey key: Key
    ) throws
        -> DeclaredSourceGuideField<Value> {
        guard contains(key) else { return DeclaredSourceGuideField() }
        return try DeclaredSourceGuideField(from: superDecoder(forKey: key))
    }
}

/// Provider-owned presentation only. Nothing here can register a source or grant a credential.
struct SourceCompanionGuide: Equatable {
    struct Link: Equatable { let label: String
        let url: String
    }

    struct Pairing: Equatable { let deviceKind: String
        let label: String
    }

    let version: Int
    let title: String
    let paragraphs: [String]
    let links: [Link]
    let note: String?
    let pairing: Pairing?

    static func read(_ descriptor: DesktopDescriptor) -> Self? {
        guard let marker = descriptor.setupGuide, validText(marker, limit: 128),
              case .object(let fields)? = descriptor.setupGuideContent,
              case .number(1)? = fields["version"],
              case .string(let title)? = fields["title"], validText(title, limit: 160),
              case .array(let rawParagraphs)? = fields["paragraphs"], (1 ... 8).contains(rawParagraphs.count),
              case .array(let rawLinks)? = fields["links"], rawLinks.count <= 4 else { return nil }
        var paragraphs = [String](), links = [Link]()
        for value in rawParagraphs {
            guard case .string(let text) = value, validText(text, limit: 2000) else { return nil }
            paragraphs.append(text)
        }
        for value in rawLinks {
            guard case .object(let link) = value,
                  case .string(let label)? = link["label"], validText(label, limit: 120),
                  case .string(let url)? = link["url"], safeURL(url) != nil else { return nil }
            links.append(Link(label: label, url: url))
        }
        var note: String?, pairing: Pairing?
        if let value = fields["note"], value != .null {
            guard case .string(let text) = value, validText(text, limit: 2000) else { return nil }
            note = text
        }
        if let value = fields["pairing"], value != .null {
            let kinds: Set = ["collector", "cli", "portal", "ios", "android", "agent", "browser", "integration"]
            guard case .object(let pair) = value,
                  case .string(let kind)? = pair["deviceKind"], kinds.contains(kind),
                  case .string(let label)? = pair["label"], validText(label, limit: 120) else { return nil }
            pairing = Pairing(deviceKind: kind, label: label)
        }
        return Self(version: 1, title: title, paragraphs: paragraphs, links: links, note: note, pairing: pairing)
    }

    private static func validText(_ value: String, limit: Int) -> Bool {
        value.utf8.prefix(limit + 1).count <= limit && !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    static func safeURL(_ value: String) -> URL? {
        guard validText(value, limit: 2048), value == value.trimmingCharacters(in: .whitespacesAndNewlines),
              value.lowercased().hasPrefix("https://"), !value.contains("\\"),
              !value.dropFirst(8).prefix(while: { $0 != "/" && $0 != "?" && $0 != "#" }).contains("@"),
              !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              var parts = URLComponents(string: value), parts.scheme?.lowercased() == "https",
              let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil else { return nil }
        parts.scheme = "https"
        guard let url = parts.url, url.absoluteString.utf8.prefix(2049).count <= 2048 else { return nil }
        return url
    }
}

struct SourceCompanionGuideView: View {
    let descriptor: DesktopDescriptor
    let openLink: (URL) -> Void
    let openPortal: () -> Void
    var body: some View {
        if let guide = SourceCompanionGuide.read(descriptor) {
            VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.regular) {
                Label { Text(verbatim: guide.title) } icon: { Image(systemName: "arrow.up.forward.app") }
                    .font(DesktopDesignTokens.Typography.section).accessibilityIdentifier("source-guide-title")
                    .accessibilityAddTraits(.isHeader)
                ForEach(Array(guide.paragraphs.enumerated()), id: \.offset) { _, paragraph in Text(verbatim: paragraph) }
                ForEach(Array(guide.links.enumerated()), id: \.offset) { index, link in
                    Button {
                        if let url = SourceCompanionGuide.safeURL(link.url) { openLink(url) }
                    } label: { Text(verbatim: link.label) }
                        .buttonStyle(DesktopButtonStyle(primary: index == 0))
                        .accessibilityIdentifier("source-guide-link-\(index)")
                }
                if let note = guide
                    .note { Text(verbatim: note).font(DesktopDesignTokens.Typography.secondary).foregroundStyle(DesktopTheme.secondary) }
                // This native action opens the portal home; it does not promise a pairing deep link.
                Button("Open web setup", action: openPortal).buttonStyle(DesktopButtonStyle())
                    .accessibilityIdentifier("source-guide-portal")
            }
        } else {
            VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.regular) {
                Text("Companion setup").font(DesktopDesignTokens.Typography.section).accessibilityIdentifier("source-guide-unavailable")
                    .accessibilityAddTraits(.isHeader)
                Text("This gateway does not provide a supported setup guide. Open web setup to continue.")
                    .foregroundStyle(DesktopTheme.secondary)
                Button("Open web setup", action: openPortal).buttonStyle(DesktopButtonStyle(primary: true))
                    .accessibilityIdentifier("source-guide-portal")
            }
        }
    }
}
