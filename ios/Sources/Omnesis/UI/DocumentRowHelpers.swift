// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Parse a string as a URL the system can hand off to another app.
/// Accepts http/https (Gmail, Drive, Notion …) and any custom-scheme
/// deep-link a provider published (Things `things:///show?id=…`,
/// Obsidian `obsidian://open?vault=…`, etc.). Excludes a small blocklist
/// of schemes that obviously aren't doc launchers (`file`, `data`,
/// `javascript`, `about`).
func externalDocURL(_ value: String?) -> URL? {
    guard let value, !value.isEmpty else { return nil }
    guard let url = URL(string: value), let scheme = url.scheme?.lowercased() else { return nil }
    let blocked: Set = ["file", "data", "javascript", "about"]
    return blocked.contains(scheme) ? nil : url
}

/// The links that open a document outside the app, in preference order:
/// the native-app deep link (`appUrl`) before the web link (`sourceUrl`).
/// A source publishes one set of links for every platform, and its app
/// link may name an app this phone doesn't have, so the caller opens
/// them in turn until one is accepted. Checking up front with
/// `canOpenURL` would need every scheme listed in
/// `LSApplicationQueriesSchemes`, which defeats the "any source can
/// publish any deep link" contract.
func docOpenURLs(appUrl: String?, sourceUrl: String?) -> [URL] {
    var urls: [URL] = []
    for url in [externalDocURL(appUrl), externalDocURL(sourceUrl)].compactMap({ $0 })
    where !urls.contains(url) {
        urls.append(url)
    }
    return urls
}

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The two ways to delete a document, explained once for every delete prompt.
/// "For good" writes the gateway's durable tombstone; "this copy" leaves the
/// source free to bring the document back.
let documentDeleteExplanation =
    "Delete for good: removed, and a later sync or capture will not add it back. Delete this copy: removed now, but a later sync or capture may add it again."

/// Map a `documentType` string (from doc metadata or search results) to a
/// user-facing label. Mirrors the portal's `docTypeLabel()` helper —
/// keeps the iOS view code from spelling these out inline.
func docTypeLabel(_ type: String?) -> String? {
    guard let type, !type.isEmpty else { return nil }
    switch type {
    case "email": return "Email"
    case "event": return "Event"
    case "conversation": return "Conversation"
    case "note": return "Note"
    case "page": return "Page"
    case "task": return "Task"
    case "reminder": return "Reminder"
    case "contact": return "Contact"
    case "bookmark": return "Bookmark"
    case "history": return "History"
    case "message": return "Message"
    case "activity": return "Activity"
    case "file", "document": return "Document"
    default:
        // For unknown types capitalise the first letter so it still
        // looks like a label rather than a raw enum value.
        return type.prefix(1).uppercased() + type.dropFirst()
    }
}

/// Format an ISO-8601 timestamp as a compact phrase: "12s ago", "5m ago",
/// "3h ago", "2d ago", or "5/12/26" for older dates. Returns the input
/// unchanged if it can't be parsed so something useful still renders.
func formatTimeAgo(_ iso: String?) -> String? {
    guard let iso else { return nil }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    var date = formatter.date(from: iso)
    if date == nil {
        formatter.formatOptions = [.withInternetDateTime]
        date = formatter.date(from: iso)
    }
    guard let date else { return iso }
    let diff = Date().timeIntervalSince(date)
    if diff < 0 { return "just now" }
    if diff < 60 { return "\(Int(diff))s ago" }
    if diff < 3600 { return "\(Int(diff / 60))m ago" }
    if diff < 86400 { return "\(Int(diff / 3600))h ago" }
    if diff < 86400 * 30 { return "\(Int(diff / 86400))d ago" }
    let df = DateFormatter()
    df.dateStyle = .short
    return df.string(from: date)
}

/// Strip a trailing `:account` suffix from a sourceId, returning just the
/// type. e.g. "gmail:user@gmail.com" → "gmail".
func sourceTypeFromId(_ sourceId: String) -> String {
    sourceTypeOf(sourceId)
}

/// Tappable wrapper around an `AgentDocRef`. Always pushes the in-app
/// `AgentDocumentDetailView` — the document viewer is the single entry
/// point to the original source (via its "Open in source" toolbar
/// button). Wraps any `View` content via the trailing-closure builder
/// so the caller renders the card body.
@available(iOS 17.0, *)
struct DocumentLink<Content: View>: View {
    let ref: AgentDocRef
    @ViewBuilder let content: () -> Content
    @State private var pushDocumentId: String?

    var body: some View {
        // A plain `Button` toggling `.navigationDestination(item:)`
        // rather than a `NavigationLink`: `NavigationLink` — even under
        // `.buttonStyle(.plain)`, `.tint`, and explicit
        // `.foregroundStyle` overrides — desaturates its label content
        // (both text and images), which would dim the card relative to
        // its neighbours. Driving the push from Button-toggled state
        // keeps the tap target's render path free of link styling.
        Button {
            // See #625 — opens by documentId only; a destructive resync re-mints
            // the id and this dead-ends. ref.url/appUrl is a partial fallback, but
            // url-less sources need a (sourceId, externalId) resolver.
            pushDocumentId = ref.documentId
        } label: {
            content()
        }
        .buttonStyle(.plain)
        .navigationDestination(item: $pushDocumentId) { id in
            AgentDocumentDetailView(documentId: id)
        }
    }
}

/// Same in-app push as `DocumentLink` but for `SearchResultItem` rows in
/// the Search tab. Always opens the in-app `DocumentDetailView`. Uses the
/// same plain-Button + `.navigationDestination` pattern as `DocumentLink`
/// for the same label-rendering reasons.
@available(iOS 17.0, *)
struct SearchResultLink<Content: View>: View {
    let item: SearchResultItem
    let store: AppStore
    @ViewBuilder let content: () -> Content
    @State private var pushDocumentId: String?

    var body: some View {
        Button {
            pushDocumentId = item.documentId
        } label: {
            content()
        }
        .buttonStyle(.plain)
        .navigationDestination(item: $pushDocumentId) { id in
            DocumentDetailView(documentId: id, presetTitle: item.title)
        }
    }
}

/// Reusable 22pt source icon — prefers per-account art, falls back to
/// type-level art, then to an SF Symbol. The store hands back either a
/// hosted URL (`https://…`) or a data URI (`data:image/…;base64,…`); we
/// render hosted URLs through `AsyncImage` (which caches automatically)
/// and decode data URIs directly into a `UIImage`.
@available(iOS 17.0, *)
struct SourceIconView: View {
    let sourceId: String
    let store: AppStore
    var size: CGFloat = 22

    var body: some View {
        let type = sourceTypeFromId(sourceId)
        let src = store.sourceIconById[sourceId] ?? store.sourceIconByType[type]
        if let src, let url = URL(string: src), src.hasPrefix("http") {
            AsyncImage(url: url) { phase in
                if let image = phase.image {
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                } else {
                    placeholder
                }
            }
            .frame(width: size, height: size)
        } else if let src, src.hasPrefix("data:"),
                  let bytes = decodeDataUri(src),
                  let image = UIImage(data: bytes) {
            Image(uiImage: image)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: size, height: size)
        } else {
            placeholder
        }
    }

    private var placeholder: some View {
        Image(systemName: "doc.text")
            .font(.system(size: size * 0.65))
            .frame(width: size, height: size)
            .foregroundStyle(.secondary)
    }

    /// Pull the bytes out of a `data:<mime>;base64,<payload>` URI.
    /// Supports both PNG and SVG payloads — UIImage on iOS 17+ renders
    /// SVGs through Core Graphics' embedded SVG support.
    private func decodeDataUri(_ uri: String) -> Data? {
        guard let comma = uri.firstIndex(of: ","),
              uri[uri.startIndex ..< comma].contains(";base64") else { return nil }
        let payload = uri[uri.index(after: comma)...]
        return Data(base64Encoded: String(payload))
    }
}

/// A trimmed string, or nil when it holds nothing but whitespace.
///
/// Shared rather than file-scoped: a merge rule's canonical name and a
/// document's title both fall back to a placeholder when blank, and a
/// `fileprivate` copy in one screen is what stopped the other from compiling.
extension String {
    var nilIfBlank: String? {
        trimmingCharacters(in: .whitespaces).isEmpty ? nil : self
    }
}

#endif
