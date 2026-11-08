// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.sources

import dev.omnesis.android.designsystem.components.SourceIconModel
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SourceMetadataSeparatorTest {

    private fun row(
        count: Int? = null,
        unit: String? = null,
        countLabel: String? = null,
        percentIndexed: Double? = null,
    ) = SourceRowUi(
        sourceId = "fictional-source:local", label = "Fictional Source", accountId = "local",
        icon = SourceIconModel(fallbackInitial = "F"), countLabel = countLabel,
        syncState = "idle", percentIndexed = percentIndexed, hostDevice = "Maya's Pixel",
        lastActivity = null, progressPercent = null, progressMessage = null,
        count = count, unit = unit,
    )

    @Test fun a_host_alone_has_nothing_to_be_separated_from() {
        assertFalse(row().hostFollowsMetadata())
    }

    @Test fun a_host_after_a_count_a_label_or_an_index_share_is_separated() {
        assertTrue(row(count = 3, unit = "calls").hostFollowsMetadata())
        assertTrue(row(countLabel = "3 calls").hostFollowsMetadata())
        assertTrue(row(percentIndexed = 100.0).hostFollowsMetadata())
    }

    @Test fun a_count_without_its_unit_is_not_drawn_so_it_does_not_lead() {
        assertFalse(row(count = 3).hostFollowsMetadata())
    }
}
