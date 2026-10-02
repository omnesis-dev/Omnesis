// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class SearchBreadcrumbTests: XCTestCase {
    private func document(_ id: String, title: String? = nil) -> SearchProvenance.Document {
        .init(documentId: id, sourceId: "files:example", title: title ?? id, deviceName: nil, path: nil)
    }

    private func provenance(
        copies: [SearchProvenance.Document] = [], paths: [SearchProvenance.Path] = [], stopReasons: [String] = []
    )
        -> SearchProvenance {
        .init(
            copies: copies,
            paths: paths,
            stopReasons: stopReasons,
            modelContext: .init(documents: [document("root"), document("email"), document("map"), document("notes")])
        )
    }

    func testOnlyCurrentCopyHasNoRedundantFact() {
        XCTAssertTrue(SearchBreadcrumbFormatter.facts(provenance(copies: [document("root")]), documentId: "root").isEmpty)
    }

    func testCopyFactsExcludeCurrentAndLimitToFive() {
        let evidence = provenance(copies: [document("root")] + (1 ... 7).map { document("copy-\($0)") }, stopReasons: ["copies"])
        let facts = SearchBreadcrumbFormatter.facts(evidence, documentId: "root")
        XCTAssertEqual(facts.count, 1)
        XCTAssertEqual(
            facts[0].plainText,
            "The same text appears in at least 7 other documents: copy-1, copy-2, copy-3, copy-4, copy-5, and 2 more."
        )
        let linked = facts[0].fragments.compactMap { fragment -> String? in
            if case .document(let document) = fragment { return document.documentId }
            return nil
        }
        XCTAssertEqual(linked, ["copy-1", "copy-2", "copy-3", "copy-4", "copy-5"])
    }

    func testPhysicalLocationIsReadableAndSeparateFromCopies() {
        let copy = SearchProvenance.Document(
            documentId: "root",
            sourceId: "files:example",
            title: nil,
            deviceName: "Sample laptop",
            path: "~/Documents/permit.pdf"
        )
        XCTAssertEqual(
            SearchBreadcrumbFormatter.facts(provenance(copies: [copy]), documentId: "root").map(\.plainText),
            ["This document is on Sample laptop at ~/Documents/permit.pdf."]
        )
    }

    func testPrefixPathMergesButSiblingDocumentsAreNotChainedTogether() {
        let evidence = provenance(paths: [
            .init(documentIds: ["root", "email"], edges: ["inbound:contains"], relations: ["is attached to"]),
            .init(
                documentIds: ["root", "email", "map"],
                edges: ["inbound:contains", "outbound:url"],
                relations: ["is attached to", "links to"]
            ),
            .init(
                documentIds: ["root", "email", "notes"],
                edges: ["inbound:contains", "outbound:contains"],
                relations: ["is attached to", "has attachment"]
            ),
        ])
        XCTAssertEqual(
            SearchBreadcrumbFormatter.facts(evidence, documentId: "root").map(\.plainText),
            ["This document is attached to email, which links to map and has attachment notes."]
        )
    }

    func testDifferentRootsStaySeparateAndLegacyEdgeFallbackUsesProse() {
        let evidence = provenance(paths: [
            .init(documentIds: ["root", "email"], edges: ["inbound:url"], relations: nil),
            .init(documentIds: ["map", "notes"], edges: ["outbound:references"], relations: nil),
        ])
        XCTAssertEqual(
            SearchBreadcrumbFormatter.facts(evidence, documentId: "root").map(\.plainText),
            ["This document is linked from email.", "map references notes."]
        )
    }

    func testMissingDocumentTitleNeverLeaksRawIdentity() {
        let evidence = provenance(paths: [
            .init(documentIds: ["root", "private-identity"], edges: ["future-edge"], relations: nil),
        ])
        XCTAssertEqual(
            SearchBreadcrumbFormatter.facts(evidence, documentId: "root").map(\.plainText),
            ["This document is connected to Untitled document."]
        )
    }

    func testMalformedPathCannotInventConnectionsOrCrash() {
        let evidence = provenance(paths: [
            .init(documentIds: ["root", "email", "map"], edges: ["url"], relations: nil),
        ])
        XCTAssertTrue(SearchBreadcrumbFormatter.facts(evidence, documentId: "root").isEmpty)
    }

    func testHubOnlyEvidenceStillExplainsWhereTraversalStopped() {
        let facts = SearchBreadcrumbFormatter.facts(
            provenance(copies: [document("root")], stopReasons: ["hub"]),
            documentId: "root"
        )
        XCTAssertEqual(facts.map(\.plainText), ["This trail stops at highly connected documents."])
    }

    func testNodeBudgetUsesMinimumCopyCountAndIncompleteTrail() {
        let facts = SearchBreadcrumbFormatter.facts(provenance(
            copies: [document("root"), document("copy")],
            stopReasons: ["nodes"]
        ), documentId: "root")
        XCTAssertEqual(facts.map(\.plainText), [
            "The same text appears in at least 1 other document: copy.",
            "This trail may be incomplete.",
        ])
    }

    func testOverlappingPartialCopyInventoriesShowOnePanel() throws {
        let base = #"{"documentId":"root","sourceId":"files:example","documentType":"file","title":"Permit.pdf","#
            + #""sourceCreatedAt":"2026-01-01","chunkText":"Permit","score":0.9}"#
        let decoder = JSONDecoder()
        var first = try decoder.decode(SearchResultItem.self, from: Data(base.utf8))
        var second = try decoder.decode(SearchResultItem.self, from: Data(base.replacingOccurrences(of: "root", with: "copy").utf8))
        first.provenance = provenance(copies: [document("root"), document("shared")])
        second.provenance = provenance(copies: [document("copy"), document("shared")])
        XCTAssertEqual(SearchBreadcrumbFormatter.visiblePanels([first, second]), ["root"])
    }

    func testCyclicPathDoesNotProduceMisleadingProse() {
        let evidence = provenance(paths: [
            .init(documentIds: ["root", "email", "root"], edges: ["url", "url"], relations: nil),
        ])
        XCTAssertTrue(SearchBreadcrumbFormatter.facts(evidence, documentId: "root").isEmpty)
    }

    func testDocumentLinksPreserveOpaqueIdentityAndStayInternal() throws {
        let id = "doc with / punctuation? & #"
        let url = try XCTUnwrap(SearchBreadcrumbNavigation.url(documentId: id))
        XCTAssertEqual(SearchBreadcrumbNavigation.documentId(url), id)
        XCTAssertNil(try SearchBreadcrumbNavigation.documentId(XCTUnwrap(URL(string: "https://example.com/?id=wrong"))))
        XCTAssertNil(try SearchBreadcrumbNavigation.documentId(XCTUnwrap(URL(string: "omnesis-document://open?id="))))
    }
}
