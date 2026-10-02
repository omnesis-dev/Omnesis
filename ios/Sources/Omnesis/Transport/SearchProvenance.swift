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
    /// Outline level: a branch's facts sit one level under the fact ending with its colon.
    var depth = 0

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
        /// Same-named leaves folded into this one.
        var more = 0
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
        // The visible result is "This document", never a same-named copy to fold away.
        foldRepeatedLeaves(roots) { $0 == documentId ? nil : documents[$0]?.title }
        func ref(_ node: Node) -> [SearchBreadcrumbFact.Fragment] {
            [reference(node.step.documentId)]
                + (node.more > 0 ? [.text(" (and \(node.more) more with this name)")] : [])
        }
        func list(_ nodes: [Node]) -> [SearchBreadcrumbFact.Fragment] {
            nodes.enumerated().flatMap { index, node -> [SearchBreadcrumbFact.Fragment] in
                (index == 0 ? [] : [.text(index == nodes.count - 1 ? " and " : ", ")]) + ref(node)
            }
        }
        func groups(_ node: Node) -> [(relation: String, targets: [Node])] {
            var result: [(relation: String, targets: [Node])] = []
            for child in node.children {
                if let index = result.firstIndex(where: { $0.relation == child.step.relation }) {
                    result[index].targets.append(child)
                } else {
                    result.append((child.step.relation, [child]))
                }
            }
            return result
        }
        // A route is said once: a single branch continues inline, siblings that
        // share a relation read as one clause, and where a document branches its
        // fact ends with a colon and each branch follows one level deeper.
        func render(_ node: Node, prefix: [SearchBreadcrumbFact.Fragment], depth: Int) {
            let grouped = groups(node)
            guard !grouped.isEmpty else { return }
            if grouped.allSatisfy({ $0.targets.allSatisfy(\.children.isEmpty) }) {
                var fragments = prefix
                for (index, group) in grouped.enumerated() {
                    fragments.append(.text("\(index == 0 ? "" : " and") \(group.relation) "))
                    fragments += list(group.targets)
                }
                facts.append(.init(fragments: fragments + [.text(".")], depth: depth))
                return
            }
            if grouped.count == 1, grouped[0].targets.count == 1 {
                let target = grouped[0].targets[0]
                render(
                    target,
                    prefix: prefix + [.text(" \(grouped[0].relation) ")] + ref(target) + [.text(", which")],
                    depth: depth
                )
                return
            }
            facts.append(.init(fragments: prefix + [.text(":")], depth: depth))
            var leaves: [SearchBreadcrumbFact.Fragment] = []
            for group in grouped {
                let leafTargets = group.targets.filter(\.children.isEmpty)
                guard !leafTargets.isEmpty else { continue }
                leaves.append(.text("\(leaves.isEmpty ? "" : " and ")\(group.relation) "))
                leaves += list(leafTargets)
            }
            if !leaves.isEmpty { facts.append(.init(fragments: leaves + [.text(".")], depth: depth + 1)) }
            for group in grouped {
                for branch in group.targets where !branch.children.isEmpty {
                    render(branch, prefix: [.text("\(group.relation) ")] + ref(branch) + [.text(", which")], depth: depth + 1)
                }
            }
        }
        for root in roots {
            render(root, prefix: ref(root), depth: 0)
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

    /// Leaves sharing a relation and a title under different documents of one
    /// root's tree (an inline image repeated in every message of a thread) fold
    /// into the first one, which counts the rest. Siblings under one document
    /// stay listed, and a document `title` does not name never folds.
    private static func foldRepeatedLeaves(_ roots: [Node], title: (String) -> String?) {
        var first: [String: (leaf: Node, parent: Node)] = [:]
        func visit(_ node: Node) {
            node.children = node.children.filter { child in
                if !child.children.isEmpty {
                    visit(child)
                    return true
                }
                let name = (title(child.step.documentId) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                guard !name.isEmpty else { return true }
                let key = "\(child.step.relation)\u{0}\(name)"
                guard let kept = first[key] else {
                    first[key] = (child, node)
                    return true
                }
                guard kept.parent !== node, kept.leaf.step.documentId != child.step.documentId else { return true }
                kept.leaf.more += 1
                return false
            }
        }
        for root in roots {
            first = [:]
            visit(root)
        }
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
