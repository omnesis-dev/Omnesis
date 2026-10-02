// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Optional bounded evidence. Unknown wire fields are ignored by Decodable.
/// Extracted-text matches do not establish identical file bytes.
public struct SearchProvenance: Decodable, Hashable, Sendable {
    public let copies: [Document]
    public let paths: [Path]
    public let stopReasons: [String]
    public let modelContext: ModelContext?

    public struct Document: Decodable, Hashable, Sendable {
        public let documentId: String
        public let sourceId: String
        public let title: String?
        public let deviceName: String?
        public let path: String?
    }

    public struct Path: Decodable, Hashable, Sendable {
        public let documentIds: [String]
        public let edges: [String]
        public let relations: [String]?
    }

    public struct ModelContext: Decodable, Hashable, Sendable {
        public let documents: [Document]
    }
}

/// Text fragments keep navigation identities out of visible copy and make
/// relation rendering testable without SwiftUI or a simulator.
struct SearchBreadcrumbFact: Equatable {
    enum Fragment: Equatable {
        case text(String)
        case document(SearchProvenance.Document)
    }

    let fragments: [Fragment]

    var plainText: String {
        fragments
            .map {
                switch $0 {
                case .text(let text): text
                case .document(let document): document.title.flatMap { $0.isEmpty ? nil : $0 } ?? "Untitled document"
                }
            }
            .joined()
    }
}

enum SearchBreadcrumbFormatter {
    private struct Step: Equatable {
        let documentId: String
        let edge: String
        let relation: String
    }

    private final class Node {
        let step: Step
        var children: [Node] = []
        init(_ step: Step) {
            self.step = step
        }
    }

    /// One panel per copy family, preserving the ordinary search order.
    static func visiblePanels(_ results: [SearchResultItem]) -> Set<String> {
        var shownCopies = Set<String>()
        var visible = Set<String>()
        for result in results {
            guard let provenance = result.provenance,
                  !facts(provenance, documentId: result.documentId).isEmpty else { continue }
            let family = Set(provenance.copies.map(\.documentId) + [result.documentId])
            if shownCopies.isDisjoint(with: family) { visible.insert(result.documentId) }
            shownCopies.formUnion(family)
        }
        return visible
    }

    static func facts(_ provenance: SearchProvenance, documentId: String) -> [SearchBreadcrumbFact] {
        var documents: [String: SearchProvenance.Document] = [:]
        for document in provenance.modelContext?.documents ?? [] {
            documents[document.documentId] = document
        }
        for copy in provenance.copies {
            documents[copy.documentId] = copy
        }
        func reference(_ id: String) -> SearchBreadcrumbFact.Fragment {
            if id == documentId { return .text("This document") }
            return .document(documents[id] ?? .init(
                documentId: id, sourceId: "", title: nil, deviceName: nil, path: nil
            ))
        }
        var facts: [SearchBreadcrumbFact] = []
        if let current = provenance.copies.first(where: { $0.documentId == documentId }),
           current.deviceName != nil || current.path != nil {
            facts.append(.init(fragments: [.text("This document is \(location(current)).")]))
        }
        if let copyFact = copiesFact(provenance, documentId: documentId) { facts.append(copyFact) }
        let roots = pathTrees(provenance.paths)
        func collect(_ node: Node, root: String, steps: [Step]) {
            guard !node.children.isEmpty else { return }
            if node.children.allSatisfy(\.children.isEmpty) {
                appendSentence(root: root, steps: steps, clauses: node.children.map(\.step))
            } else {
                for child in node.children {
                    if child.children.isEmpty {
                        appendSentence(root: root, steps: steps, clauses: [child.step])
                    } else {
                        collect(child, root: root, steps: steps + [child.step])
                    }
                }
            }
        }
        func appendSentence(root: String, steps: [Step], clauses: [Step]) {
            var fragments = [reference(root)]
            for (index, step) in steps.enumerated() {
                fragments.append(.text("\(index == 0 ? " " : ", which ")\(step.relation) "))
                fragments.append(reference(step.documentId))
            }
            fragments.append(.text(steps.isEmpty ? " " : ", which "))
            for (index, clause) in clauses.enumerated() {
                if index > 0 { fragments.append(.text(" and ")) }
                fragments.append(.text("\(clause.relation) "))
                fragments.append(reference(clause.documentId))
            }
            fragments.append(.text("."))
            facts.append(.init(fragments: fragments))
        }
        for root in roots {
            collect(root, root: root.step.documentId, steps: [])
        }
        if provenance.stopReasons.contains("hub") {
            facts.append(.init(fragments: [.text("This trail stops at highly connected documents.")]))
        } else if provenance.stopReasons.contains("depth") || provenance.stopReasons.contains("nodes") {
            facts.append(.init(fragments: [.text("This trail may be incomplete.")]))
        }
        return facts
    }

    private static func copiesFact(_ provenance: SearchProvenance, documentId: String) -> SearchBreadcrumbFact? {
        let copies = provenance.copies.filter { $0.documentId != documentId }
        if !copies.isEmpty {
            let minimum = (provenance.stopReasons.contains("copies") || provenance.stopReasons.contains("nodes")) ? "at least " : ""
            let noun = copies.count == 1 ? "document" : "documents"
            var fragments: [SearchBreadcrumbFact.Fragment] = [
                .text("The same text appears in \(minimum)\(copies.count) other \(noun): "),
            ]
            for (index, copy) in copies.prefix(5).enumerated() {
                if index > 0 { fragments.append(.text(", ")) }
                fragments.append(.document(copy))
                if copy.deviceName != nil || copy.path != nil {
                    fragments.append(.text(" (\(location(copy)))"))
                }
            }
            if copies.count > 5 { fragments.append(.text(", and \(copies.count - 5) more")) }
            fragments.append(.text("."))
            return .init(fragments: fragments)
        }
        return nil
    }

    private static func pathTrees(_ paths: [SearchProvenance.Path]) -> [Node] {
        var roots: [Node] = []
        for path in paths {
            guard path.documentIds.count == path.edges.count + 1, path.documentIds.count > 1,
                  Set(path.documentIds).count == path.documentIds.count,
                  let rootId = path.documentIds.first else { continue }
            let root: Node
            if let existing = roots.first(where: { $0.step.documentId == rootId }) {
                root = existing
            } else {
                root = Node(.init(documentId: rootId, edge: "", relation: ""))
                roots.append(root)
            }
            var node = root
            for index in path.edges.indices {
                let target = path.documentIds[index + 1]
                if target == path.documentIds[index] { continue }
                let supplied = path.relations.flatMap { index < $0.count ? $0[index] : nil }
                let phrase = supplied.flatMap { $0.isEmpty ? nil : $0 } ?? relation(path.edges[index])
                let step = Step(documentId: target, edge: path.edges[index], relation: phrase)
                if let existing = node.children.first(where: { $0.step == step }) {
                    node = existing
                } else {
                    let child = Node(step)
                    node.children.append(child)
                    node = child
                }
            }
        }
        return roots
    }

    private static func location(_ document: SearchProvenance.Document) -> String {
        let device = document.deviceName.map { "on \($0)" }
        let path = document.path.map { "at \($0)" }
        return [device, path].compactMap { $0 }.joined(separator: " ")
    }

    private static func relation(_ edge: String) -> String {
        let parts = edge.split(separator: ":", maxSplits: 1).map(String.init)
        let kind = parts.last ?? ""
        let inbound = parts.count == 2 && parts.first == "inbound"
        let outbound = parts.count == 2 && parts.first == "outbound"
        switch kind {
        case "url": return inbound ? "is linked from" : outbound ? "links to" : "has a link with"
        case "references": return inbound ? "is referenced by" : outbound ? "references" : "has a reference connection with"
        case "replies-to": return inbound ? "has a reply from" : outbound ? "replies to" : "has a reply connection with"
        case "part-of-thread": return "shares a thread with"
        case "calendar-event": return "has an event connection with"
        case "contains": return "has related content in"
        case "revision-of": return "is another version of"
        default: return "is connected to"
        }
    }
}

/// Only these internal links can push a breadcrumb document inspector.
enum SearchBreadcrumbNavigation {
    static func url(documentId: String) -> URL? {
        var components = URLComponents()
        components.scheme = "omnesis-document"
        components.host = "open"
        components.queryItems = [URLQueryItem(name: "id", value: documentId)]
        return components.url
    }

    static func documentId(_ url: URL) -> String? {
        guard url.scheme == "omnesis-document", url.host == "open" else { return nil }
        return URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "id" })?.value.flatMap { $0.isEmpty ? nil : $0 }
    }
}
