// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if DEBUG && canImport(SwiftUI) && canImport(UIKit)
import Foundation

/// The one WhatsApp day every render of a document's access draws: its record, what a filter can see on it, and
/// which access levels can read it. Every name is invented.
extension PreviewMocks {
    static let accessDocumentId = "0f6c2a1e-6b8d-4e43-9c2a-5d1e7b3f9a10"

    /// The WhatsApp account the day comes from, as the gateway lists it.
    static let accessDocumentSource = SourceRecord(
        id: "whatsapp-messages:+15550100123",
        type: "whatsapp-messages",
        accountId: "+1 (555) 010-0123",
        deviceId: "device-phone",
        config: [:],
        enabled: true,
        createdAt: 0,
        updatedAt: 0
    )

    /// The day's record. Its times carry no zone, so every render reads them the same in any time zone.
    static let accessDocumentDetail: DocumentDetail = {
        let json = """
        {
          "id": "0f6c2a1e-6b8d-4e43-9c2a-5d1e7b3f9a10",
          "provider_id": "whatsapp:+15550100123",
          "source_id": "whatsapp-messages:+15550100123",
          "external_id": "day:120363000000000001@g.us:2026-03-14",
          "title": "Workshop planning — 14 March",
          "content": "Maya Reeves: Can we move the workshop to the larger room?\\nJamie Lopez: Yes, I booked it for Thursday.",
          "content_hash": "sha256:workshop",
          "metadata": "{\\"documentType\\":\\"conversation\\"}",
          "source_created_at": "2026-03-14T09:12:00",
          "source_updated_at": "2026-03-14T18:40:00"
        }
        """
        do {
            return try JSONDecoder().decode(DocumentDetail.self, from: Data(json.utf8))
        } catch {
            preconditionFailure("The preview document does not decode: \(error)")
        }
    }()

    static let accessDocumentFilterDetails = DocumentFilterDetails(documentId: accessDocumentId, sourceVersion: 1, fields: [
        .init(
            field: "extra.chatJid",
            noun: .init(one: "chat", many: "chats"),
            items: [.init(id: "chat-workshop-planning", label: "Workshop planning")]
        ),
        .init(field: "$people", noun: .init(one: "person", many: "people"), items: [
            .init(id: "+15550100142", label: "Maya Reeves"), .init(id: "+15550100187", label: "Jamie Lopez"),
        ]),
    ])

    private static func verdict(_ readable: Bool, _ code: String, _ text: String) -> DocumentAccessVerdict {
        DocumentAccessVerdict(readable: readable, code: code, text: text)
    }

    /// Three levels in the gateway's order, by name: one that can read the day through Answer, one that only takes
    /// notes, and one whose filter hides the chat.
    static let accessDocumentAudit = DocumentAccessAudit(
        documentId: accessDocumentId,
        title: "Workshop planning — 14 March",
        sourceId: "whatsapp-messages:+15550100123",
        sourceName: "WhatsApp",
        sourceVersion: 1,
        notes: .init(
            answer: "“Can read” under Answer means Omnesis may use this document when answering that agent. "
                + "Whether an answer is then released is decided by the privacy policy’s review.",
            owner: "This page is for you, the owner. It is never available to an external agent."
        ),
        levels: [
            .init(
                id: "level-family-helper",
                name: "Family helper",
                agents: [],
                answer: verdict(true, "readable", "This account is shared with all content"),
                direct: verdict(false, "permission-not-granted", "Direct is not granted on this level")
            ),
            .init(
                id: "level-notes-capture",
                name: "Notes capture",
                agents: [],
                answer: verdict(false, "permission-not-granted", "Answer is not granted on this level"),
                direct: verdict(false, "permission-not-granted", "Direct is not granted on this level")
            ),
            .init(
                id: "level-research-assistant",
                name: "Research assistant",
                agents: [
                    .init(id: "grant-aurora", name: "Aurora Planner", kind: "connection"),
                    .init(id: "grant-northstar", name: "Northstar Assistant", kind: "connection"),
                    .init(id: "device-speaker", name: "Kitchen speaker", kind: "device"),
                ],
                answer: verdict(false, "hidden-by-item", "Hidden by: chat Workshop planning"),
                direct: verdict(false, "account-not-shared", "This account is not shared")
            ),
        ]
    )
}
#endif
