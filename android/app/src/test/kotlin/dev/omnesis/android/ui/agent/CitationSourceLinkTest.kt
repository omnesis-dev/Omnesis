// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.AgentTrailEventDoc
import dev.omnesis.android.ui.document.openableDocUrls
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CitationSourceLinkTest {
    @get:Rule val compose = createComposeRule()

    @Test fun titleAndExternalActionHaveSeparateDestinations() {
        var document: String? = null
        var urls = emptyList<String>()
        compose.setContent {
            OmnesisTheme {
                TrailCitationTitle(
                    AgentTrailEventDoc(documentId = "plan", title = "Launch plan", appUrl = "exampledocs://plan", sourceUrl = "https://example.com/plan"),
                    isAttachment = false,
                    onOpenDocument = { document = it },
                    canOpenLink = { true },
                    onOpenLinks = { urls = it },
                )
            }
        }
        compose.onNodeWithContentDescription("Open in source").performClick()
        assertEquals(listOf("exampledocs://plan", "https://example.com/plan"), urls)
        assertEquals(null, document)
        compose.onNodeWithContentDescription("Launch plan").performClick()
        assertEquals("plan", document)
    }

    @Test fun unavailableNativeLinkHasNoExternalAction() {
        compose.setContent {
            OmnesisTheme {
                TrailCitationTitle(
                    AgentTrailEventDoc(documentId = "note", title = "Local note", appUrl = "applenotes:note-id"),
                    isAttachment = false, onOpenDocument = {}, canOpenLink = { false },
                )
            }
        }
        compose.onNodeWithContentDescription("Open in source").assertDoesNotExist()
    }

    @Test fun shortTitleKeepsExternalActionAdjacentAndVerticallyCentered() {
        assertTitleActionLayout("Launch plan", isAttachment = false, short = true)
    }

    @Test fun longAttachmentTitleReservesVisibleSpaceForTheCenteredExternalAction() {
        assertTitleActionLayout("Workshop launch checklist and release readiness review with complete budget summary.pdf", isAttachment = true, short = false)
    }

    private fun assertTitleActionLayout(title: String, isAttachment: Boolean, short: Boolean) {
        compose.setContent {
            OmnesisTheme {
                Box(Modifier.width(320.dp).testTag("titleHost")) {
                    TrailCitationTitle(
                        AgentTrailEventDoc(documentId = "plan", title = title, sourceUrl = "https://example.com/plan"),
                        isAttachment = isAttachment, onOpenDocument = {}, canOpenLink = { true },
                    )
                }
            }
        }
        val titleBounds = compose.onNodeWithContentDescription(title).fetchSemanticsNode().boundsInRoot
        val actionBounds = compose.onNodeWithContentDescription("Open in source").fetchSemanticsNode().boundsInRoot
        val hostBounds = compose.onNodeWithTag("titleHost").fetchSemanticsNode().boundsInRoot
        val gap = actionBounds.left - titleBounds.right
        val maxGap = with(compose.density) { 6.dp.toPx() }
        assertTrue("External action follows title without an expanding spacer", gap >= 0f && gap <= maxGap)
        assertEquals("Title and external action share a vertical center", titleBounds.center.y, actionBounds.center.y, 1f)
        assertTrue("External action remains within the available width", actionBounds.right <= hostBounds.right + 1f)
        assertTrue("Title remains visible", titleBounds.width > 0f)
        if (short) assertTrue("Short title keeps its intrinsic width", titleBounds.width < hostBounds.width / 2)
    }

    @Test fun emptyTitleWithoutLinkKeepsTheFullWidthAndAnInternalAction() {
        var document: String? = null
        compose.setContent {
            OmnesisTheme {
                Box(Modifier.width(320.dp).testTag("titleHost")) {
                    TrailCitationTitle(
                        AgentTrailEventDoc(documentId = "empty", title = ""),
                        isAttachment = false, onOpenDocument = { document = it }, canOpenLink = { true },
                    )
                }
            }
        }
        val title = compose.onNodeWithContentDescription("(untitled)")
        val bounds = title.fetchSemanticsNode().boundsInRoot
        val host = compose.onNodeWithTag("titleHost").fetchSemanticsNode().boundsInRoot
        assertEquals(host.width, bounds.width, 1f)
        assertTrue(bounds.height > 0f)
        compose.onNodeWithContentDescription("Open in source").assertDoesNotExist()
        title.performClick()
        assertEquals("empty", document)
    }

    @Test fun nativeLinkFallsBackToWebAndMalformedOrUnsafeLinksAreAbsent() {
        assertEquals(listOf("https://example.com/plan"), openableDocUrls("applenotes:note-id", "https://example.com/plan") { it.startsWith("https:") })
        listOf(null, "", "relative/path", "https:", "https:///path", "https://", "https://bad host", "javascript:alert(1)", "file:///tmp/plan", "data:text/plain,test").forEach {
            assertEquals(emptyList<String>(), openableDocUrls(it, null) { true })
        }
    }
}
