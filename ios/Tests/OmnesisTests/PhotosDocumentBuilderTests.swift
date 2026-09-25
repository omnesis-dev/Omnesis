// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class PhotosDocumentBuilderTests: XCTestCase {
    private func asset(
        localIdentifier: String = "local-1",
        externalId: String = "cloud-1",
        isScreenshot: Bool = false,
        date: Date = Date(timeIntervalSince1970: 1_710_000_000) // 2024-03-09
    )
        -> PhotoAssetRef {
        PhotoAssetRef(
            localIdentifier: localIdentifier,
            externalId: externalId,
            creationDate: date,
            modificationDate: date,
            isScreenshot: isScreenshot
        )
    }

    // MARK: - Title contract: never a bare filename or empty title

    func testTextlessPlacelessPhotoStillGetsANonEmptyTitle() {
        let doc = PhotosDocumentBuilder.build(
            asset: asset(),
            providerId: "photos:local",
            sourceId: "photos:local",
            fragment: PhotoAnalysisFragment()
        )
        XCTAssertFalse(doc.title.isEmpty)
        XCTAssertTrue(doc.title.hasPrefix("Photo ·"))
        XCTAssertFalse(doc.content.isEmpty, "content must never be empty — a document that chunks to nothing is invisible to the indexer")
    }

    func testScreenshotGetsScreenshotNounInTitle() {
        let doc = PhotosDocumentBuilder.build(
            asset: asset(isScreenshot: true),
            providerId: "photos:local",
            sourceId: "photos:local",
            fragment: PhotoAnalysisFragment()
        )
        XCTAssertTrue(doc.title.hasPrefix("Screenshot ·"))
        XCTAssertEqual(doc.metadata.documentType, "screenshot")
    }

    func testGeotaggedTextlessPhotoIsRetrievableByPlaceViaTitle() {
        let fragment = PhotoAnalysisFragment(placeName: "Paris")
        let doc = PhotosDocumentBuilder.build(
            asset: asset(),
            providerId: "photos:local",
            sourceId: "photos:local",
            fragment: fragment
        )
        XCTAssertTrue(doc.title.contains("Paris"), "title must fold in the place name so a text-less photo is reachable by place/date")
    }

    // MARK: - Serving rule: every signal folds into content/title/tags, never extra alone

    func testOcrTextFoldsIntoContent() {
        let fragment = PhotoAnalysisFragment(textLines: ["RECEIPT — Total $42.00"])
        let doc = PhotosDocumentBuilder.build(
            asset: asset(),
            providerId: "photos:local",
            sourceId: "photos:local",
            fragment: fragment
        )
        XCTAssertTrue(doc.content.contains("RECEIPT — Total $42.00"))
    }

    func testCaptionAndLabelsAndBarcodeFoldIntoContentAndTags() {
        let fragment = PhotoAnalysisFragment(
            textLines: ["A golden retriever running on a beach at sunset.", "https://example.com/promo"],
            tags: ["dog", "beach", "https://example.com/promo"],
            placeName: "Santa Monica"
        )
        let doc = PhotosDocumentBuilder.build(
            asset: asset(),
            providerId: "photos:local",
            sourceId: "photos:local",
            fragment: fragment
        )
        XCTAssertTrue(doc.content.contains("golden retriever"))
        XCTAssertTrue(doc.content.contains("Santa Monica"))
        XCTAssertEqual(Set(doc.metadata.tags ?? []), ["dog", "beach", "https://example.com/promo"])
    }

    func testRawExtraDataNeverSubstitutesForTagsOrContent() {
        // A label/barcode analyzer's raw confidences/payloads belong in
        // `extra` for rendering only — this test locks in that `extra`
        // alone is never sufficient; the same signal must ALSO appear in
        // tags/content (verified above). Here we just confirm `extra`
        // round-trips untouched alongside the served fields.
        let fragment = PhotoAnalysisFragment(
            tags: ["mountain"],
            extra: ["sceneLabelConfidence": .object(["mountain": .double(0.87)])]
        )
        let doc = PhotosDocumentBuilder.build(
            asset: asset(),
            providerId: "photos:local",
            sourceId: "photos:local",
            fragment: fragment
        )
        XCTAssertEqual(doc.metadata.tags, ["mountain"])
        XCTAssertEqual(doc.metadata.extra?["sceneLabelConfidence"], .object(["mountain": .double(0.87)]))
    }

    // MARK: - extractedContentHash

    func testExtractedContentHashIsNilWhenNoTextExtracted() {
        let doc = PhotosDocumentBuilder.build(
            asset: asset(),
            providerId: "photos:local",
            sourceId: "photos:local",
            fragment: PhotoAnalysisFragment(placeName: "Paris")
        )
        XCTAssertNil(doc.extractedContentHash, "no OCR/caption/barcode text — nothing to hash")
    }

    func testExtractedContentHashIsSha256OfExtractedText() {
        let fragment = PhotoAnalysisFragment(textLines: ["hello world"])
        let doc = PhotosDocumentBuilder.build(
            asset: asset(),
            providerId: "photos:local",
            sourceId: "photos:local",
            fragment: fragment
        )
        XCTAssertEqual(doc.extractedContentHash, DocumentInput.computeContentHash("hello world"))
    }

    // MARK: - lowSignal marker

    func testCasualTextlessTaglessPhotoIsMarkedLowSignal() {
        let doc = PhotosDocumentBuilder.build(
            asset: asset(),
            providerId: "photos:local",
            sourceId: "photos:local",
            fragment: PhotoAnalysisFragment()
        )
        XCTAssertEqual(doc.metadata.lowSignal, true)
    }

    func testGeotaggedPhotoWithNoOtherSignalIsNotLowSignal() {
        // A place name alone (no OCR/caption/labels) is still substantive
        // signal — a geotagged photo is worth waking on even without
        // other analysis.
        let doc = PhotosDocumentBuilder.build(
            asset: asset(),
            providerId: "photos:local",
            sourceId: "photos:local",
            fragment: PhotoAnalysisFragment(placeName: "Paris")
        )
        XCTAssertNil(doc.metadata.lowSignal)
    }

    func testPhotoWithOcrTextIsNotLowSignal() {
        let doc = PhotosDocumentBuilder.build(
            asset: asset(),
            providerId: "photos:local",
            sourceId: "photos:local",
            fragment: PhotoAnalysisFragment(textLines: ["some text"])
        )
        XCTAssertNil(doc.metadata.lowSignal)
    }

    func testPhotoWithOnlyLabelsIsNotLowSignal() {
        let doc = PhotosDocumentBuilder.build(
            asset: asset(),
            providerId: "photos:local",
            sourceId: "photos:local",
            fragment: PhotoAnalysisFragment(tags: ["beach"])
        )
        XCTAssertNil(doc.metadata.lowSignal)
    }

    // MARK: - externalId / providerId / sourceId plumbing

    func testExternalIdProviderIdSourceIdArePassedThrough() {
        let doc = PhotosDocumentBuilder.build(
            asset: asset(externalId: "icloud-abc123"),
            providerId: "photos:local",
            sourceId: "photos:local",
            fragment: PhotoAnalysisFragment()
        )
        XCTAssertEqual(doc.externalId, "icloud-abc123")
        XCTAssertEqual(doc.providerId, "photos:local")
        XCTAssertEqual(doc.sourceId, "photos:local")
    }
}
