// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.people

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MergeRulesSummaryTest {

    /**
     * The four counts are independent readings of the same loaded page, so the fixture keeps
     * them all different: a group carrying both kinds counts under each, which is why the kind
     * counts can outnumber the groups and never sum to the rules.
     */
    @Test
    fun summary_counts_groups_rules_and_each_trigger_kind() {
        val summary = mergeRulesSummary(
            identities = listOf(
                identity("group-one", kinds = setOf("user"), sources = listOf(source("r1"), source("r2"))),
                identity("group-two", kinds = setOf("system"), sources = listOf(source("r3"))),
                identity(
                    "group-three",
                    kinds = setOf("user", "system"),
                    sources = listOf(source("r4"), source("r5"), source("r6")),
                ),
            ),
            partial = false,
        )

        assertEquals(3, summary.groupCount)
        assertEquals(6, summary.ruleCount)
        assertEquals(2, summary.userCount)
        assertEquals(2, summary.systemCount)
        assertFalse(summary.partial)
    }

    @Test
    fun summary_reports_a_partially_loaded_page() {
        val summary = mergeRulesSummary(
            identities = listOf(identity("group-one", kinds = setOf("user"), sources = listOf(source("r1")))),
            partial = true,
        )

        assertTrue(summary.partial)
    }

    @Test
    fun summary_of_nothing_loaded_is_all_zeroes() {
        val summary = mergeRulesSummary(identities = emptyList(), partial = false)

        assertEquals(0, summary.groupCount)
        assertEquals(0, summary.ruleCount)
        assertEquals(0, summary.userCount)
        assertEquals(0, summary.systemCount)
    }

    private fun identity(
        id: String,
        kinds: Set<String>,
        sources: List<MergeIdentity.Source>,
    ): MergeIdentity = MergeIdentity(
        id = id,
        person = null,
        name = id,
        canonicalEmail = null,
        latest = null,
        kinds = kinds,
        sources = sources,
    )

    private fun source(id: String): MergeIdentity.Source = MergeIdentity.Source(
        ruleId = id,
        alias = "$id@example.com",
        aliasType = "email",
        name = null,
        sourceIds = emptyList(),
        reason = null,
    )
}
