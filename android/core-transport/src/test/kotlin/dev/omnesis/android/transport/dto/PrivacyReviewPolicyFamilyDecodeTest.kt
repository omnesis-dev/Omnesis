// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.decodeFromString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * A review record names the policy family it was judged under, on the exchange shape and on
 * the approval shape alike. Records written before families were recorded carry neither
 * field and decode with both absent.
 */
class PrivacyReviewPolicyFamilyDecodeTest {

    @Test
    fun an_exchange_review_carries_the_family_it_was_judged_under() {
        val exchange = OmnesisJson.decodeFromString<PrivacyExchangePresentation>(
            """{"taskId":"task-example","review":{"rationale":"Allowed.","policyRevision":"rev-1","policyFamilyId":"family-example","policyFamilyName":"Everyday policy"}}""",
        )
        assertEquals("family-example", exchange.review?.policyFamilyId)
        assertEquals("Everyday policy", exchange.review?.policyFamilyName)
        assertEquals("Allowed.", exchange.review?.rationale)
    }

    @Test
    fun an_exchange_review_without_a_family_decodes_with_both_fields_absent() {
        val exchange = OmnesisJson.decodeFromString<PrivacyExchangePresentation>(
            """{"taskId":"task-example","review":{"rationale":"Allowed.","findings":[]}}""",
        )
        assertNull(exchange.review?.policyFamilyId)
        assertNull(exchange.review?.policyFamilyName)
    }

    @Test
    fun an_approval_review_record_carries_the_family_it_was_judged_under() {
        val detail = OmnesisJson.decodeFromString<PrivacyApprovalEnvelope>(
            """{"approval":{"id":"approval-example","status":"pending","review":{"recipeVersion":"privacy-review-v1","policyRevision":"rev-1","rationale":"Needs approval.","policyFamilyId":"family-example","policyFamilyName":"Everyday policy"}}}""",
        ).approval
        assertEquals("family-example", detail.review.policyFamilyId)
        assertEquals("Everyday policy", detail.review.policyFamilyName)
    }

    @Test
    fun an_approval_review_record_without_a_family_decodes_with_both_fields_absent() {
        val detail = OmnesisJson.decodeFromString<PrivacyApprovalEnvelope>(
            """{"approval":{"id":"approval-example","status":"pending","review":{"recipeVersion":"privacy-review-v1","policyRevision":"rev-1","rationale":"Needs approval."}}}""",
        ).approval
        assertNull(detail.review.policyFamilyId)
        assertNull(detail.review.policyFamilyName)
    }
}
