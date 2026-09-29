// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.decodeFromString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * An exchange carries the citations beside each of its three answers, and an
 * approval the citations held beside its candidate. A gateway that predates
 * citations sends none of those fields, and the exchange still decodes with
 * every list empty. A list decodes one citation at a time: a malformed one is
 * skipped and never costs the exchange or approval it rides on.
 */
class PrivacyAnswerCitationDecodeTest {

    @Test
    fun an_exchange_decodes_the_citations_beside_each_answer() {
        val exchange = OmnesisJson.decodeFromString<PrivacyExchangePresentation>(
            """
            {
              "taskId": "task-example",
              "sharedAnswer": "The invented budget review is on Friday.",
              "sharedCitations": [
                {"documentId": "doc-1", "sourceType": "gmail", "title": "Q4 budget review",
                 "timestamp": "2026-09-12T09:30:00.000Z",
                 "sourceUrl": "https://mail.example.com/thread/1",
                 "appUrl": "examplemail://thread/1"}
              ],
              "draftCitations": [
                {"documentId": "doc-1", "sourceType": "gmail", "title": "Q4 budget review",
                 "timestamp": "2026-09-12T09:30:00.000Z",
                 "sourceUrl": "https://mail.example.com/thread/1",
                 "appUrl": "examplemail://thread/1"},
                {"documentId": "doc-2", "sourceType": "notion", "title": "Planning notes"}
              ],
              "pendingCitations": []
            }
            """.trimIndent(),
        )

        val shared = exchange.sharedCitations.single()
        assertEquals("doc-1", shared.documentId)
        assertEquals("gmail", shared.sourceType)
        assertEquals("Q4 budget review", shared.title)
        assertEquals("2026-09-12T09:30:00.000Z", shared.timestamp)
        assertEquals("https://mail.example.com/thread/1", shared.sourceUrl)
        assertEquals("examplemail://thread/1", shared.appUrl)
        assertEquals(listOf("doc-1", "doc-2"), exchange.draftCitations.map { it.documentId })
        assertTrue(exchange.pendingCitations.isEmpty())
    }

    @Test
    fun a_citation_whose_optional_fields_were_withheld_decodes_with_them_absent() {
        val exchange = OmnesisJson.decodeFromString<PrivacyExchangePresentation>(
            """{"taskId":"task-example","pendingCitations":[{"documentId":"doc-3","sourceType":"calendar"}]}""",
        )

        val citation = exchange.pendingCitations.single()
        assertEquals("doc-3", citation.documentId)
        assertEquals("calendar", citation.sourceType)
        assertNull(citation.title)
        assertNull(citation.timestamp)
        assertNull(citation.sourceUrl)
        assertNull(citation.appUrl)
    }

    @Test
    fun an_exchange_from_a_gateway_without_citations_decodes_with_every_list_empty() {
        val exchange = OmnesisJson.decodeFromString<PrivacyExchangePresentation>(
            """{"taskId":"task-example","sharedAnswer":"The invented review is planned."}""",
        )

        assertTrue(exchange.sharedCitations.isEmpty())
        assertTrue(exchange.draftCitations.isEmpty())
        assertTrue(exchange.pendingCitations.isEmpty())
    }

    @Test
    fun an_approval_decodes_the_citations_held_beside_its_candidate() {
        val detail = OmnesisJson.decodeFromString<PrivacyApprovalEnvelope>(
            """{"approval":{"id":"approval-example","status":"pending","candidateAnswer":"The review is on Friday.","candidateCitations":[{"documentId":"doc-1","sourceType":"gmail","title":"Q4 budget review","sourceUrl":"https://mail.example.com/thread/1"}]}}""",
        ).approval

        val citation = detail.candidateCitations.single()
        assertEquals("Q4 budget review", citation.title)
        assertEquals("https://mail.example.com/thread/1", citation.sourceUrl)
    }

    @Test
    fun an_approval_from_a_gateway_without_citations_decodes_with_none() {
        val detail = OmnesisJson.decodeFromString<PrivacyApprovalEnvelope>(
            """{"approval":{"id":"approval-example","status":"pending","candidateAnswer":"The review is on Friday."}}""",
        ).approval

        assertTrue(detail.candidateCitations.isEmpty())
    }

    @Test
    fun a_null_citation_list_decodes_as_empty() {
        val exchange = OmnesisJson.decodeFromString<PrivacyExchangePresentation>(
            """{"taskId":"task-example","sharedCitations":null,"draftCitations":null,"pendingCitations":null}""",
        )
        val detail = OmnesisJson.decodeFromString<PrivacyApprovalEnvelope>(
            """{"approval":{"id":"approval-example","candidateCitations":null}}""",
        ).approval

        assertEquals("task-example", exchange.taskId)
        assertTrue(exchange.sharedCitations.isEmpty())
        assertTrue(exchange.draftCitations.isEmpty())
        assertTrue(exchange.pendingCitations.isEmpty())
        assertTrue(detail.candidateCitations.isEmpty())
    }

    @Test
    fun a_list_that_is_not_an_array_decodes_as_empty() {
        val exchange = OmnesisJson.decodeFromString<PrivacyExchangePresentation>(
            """{"taskId":"task-example","sharedAnswer":"The review is on Friday.","sharedCitations":{"documentId":"doc-1"}}""",
        )

        assertEquals("The review is on Friday.", exchange.sharedAnswer)
        assertTrue(exchange.sharedCitations.isEmpty())
    }

    @Test
    fun a_citation_without_its_document_id_or_source_type_is_skipped() {
        val exchange = OmnesisJson.decodeFromString<PrivacyExchangePresentation>(
            """
            {
              "taskId": "task-example",
              "draftCitations": [
                {"sourceType": "gmail", "title": "No document id"},
                {"documentId": "doc-1", "title": "No source type"},
                {"documentId": "", "sourceType": "gmail"},
                {"documentId": "doc-2", "sourceType": 7},
                {"documentId": "doc-3", "sourceType": "notion", "title": "Planning notes"}
              ]
            }
            """.trimIndent(),
        )

        assertEquals(listOf("doc-3"), exchange.draftCitations.map { it.documentId })
    }

    @Test
    fun an_element_that_is_not_an_object_is_skipped() {
        val detail = OmnesisJson.decodeFromString<PrivacyApprovalEnvelope>(
            """{"approval":{"id":"approval-example","candidateCitations":[null,"doc-1",42,[],{"documentId":"doc-2","sourceType":"gmail"}]}}""",
        ).approval

        assertEquals(listOf("doc-2"), detail.candidateCitations.map { it.documentId })
    }

    @Test
    fun a_wrongly_typed_optional_field_reads_as_absent() {
        val exchange = OmnesisJson.decodeFromString<PrivacyExchangePresentation>(
            """
            {"taskId":"task-example","pendingCitations":[
              {"documentId":"doc-1","sourceType":"gmail","title":12,"timestamp":{"at":"x"},
               "sourceUrl":["https://mail.example.com/thread/1"],"appUrl":"examplemail://thread/1"}
            ]}
            """.trimIndent(),
        )

        val citation = exchange.pendingCitations.single()
        assertNull(citation.title)
        assertNull(citation.timestamp)
        assertNull(citation.sourceUrl)
        assertEquals("examplemail://thread/1", citation.appUrl)
    }
}
