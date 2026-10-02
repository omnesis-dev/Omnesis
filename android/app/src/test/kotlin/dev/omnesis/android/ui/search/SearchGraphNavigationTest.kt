// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.search

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.click
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.SearchGraphDocument
import dev.omnesis.android.transport.dto.SearchProvenance
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class SearchGraphNavigationTest {
    @get:Rule val compose = createComposeRule()

    @Test fun icon_and_title_open_the_related_document() {
        val opened = mutableListOf<String>()
        compose.setContent {
            OmnesisTheme {
                Column(Modifier.width(300.dp)) {
                    SearchGraphContext(
                        SearchProvenance(copies = listOf(SearchGraphDocument("related-document", "files:example", "Schedule.pdf"))),
                        "root", SourceCatalog(), opened::add,
                    )
                }
            }
        }
        val node = compose.onNodeWithText("Schedule.pdf", substring = true)
        lateinit var layout: TextLayoutResult
        node.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { action ->
            val results = mutableListOf<TextLayoutResult>()
            action(results)
            layout = results.single()
        }
        val titleOffset = layout.layoutInput.text.text.indexOf("Schedule.pdf")
        node.performTouchInput { click(layout.getBoundingBox(titleOffset).center) }
        val iconOffset = layout.layoutInput.text.text.indexOf('\uFFFC')
        node.performTouchInput { click(layout.getBoundingBox(iconOffset).center) }
        assertEquals(listOf("related-document", "related-document"), opened)
    }
}
