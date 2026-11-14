// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.AgentDocRef
import dev.omnesis.android.transport.dto.SourceMetaEntry
import kotlinx.coroutines.runBlocking
import dev.omnesis.android.ui.agent.AgentCitation
import dev.omnesis.android.ui.agent.CitationsDrawer
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class CitationSourceLinkScreenshotTest {
    @Test fun light() = capture(false)
    @Test fun dark() = capture(true)

    private fun capture(dark: Boolean) {
        val catalog = SourceCatalog().apply {
            runBlocking {
                load({ emptyList() }, {
                    mapOf(
                        "google-drive" to SourceMetaEntry(label = "Google Drive", accentColor = "#FBBC04", bgColor = "#2D2410"),
                        "apple-notes" to SourceMetaEntry(label = "Apple Notes", accentColor = "#FFCC00", bgColor = "#2D2A10"),
                    )
                })
            }
        }
        val refs = listOf(
            AgentDocRef(documentId = "launch", sourceId = "google-drive:demo", title = "Launch checklist", url = "https://docs.google.com/document/d/example-launch/edit", appUrl = "unsupportednotes:launch"),
            AgentDocRef(documentId = "long-plan", sourceId = "google-drive:demo", title = "Launch checklist and release readiness review for the entire workshop team", url = "https://docs.google.com/document/d/example-review/edit"),
            AgentDocRef(documentId = "outline", sourceId = "apple-notes:demo", title = "Workshop outline", appUrl = "unsupportednotes:outline"),
            AgentDocRef(documentId = "summary", sourceId = "apple-notes:demo", title = "Weekly summary"),
        )
        captureRoboImage(filePath = "src/test/roborazzi/citation_source_${if (dark) "dark" else "light"}.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) {
                    CitationsDrawer(
                        open = true,
                        citations = refs.map { AgentCitation(documentId = it.documentId, ref = it) },
                        catalog = catalog, onClose = {}, onOpenDocument = {}, progressOverride = 1f,
                    )
                }
            }
        }
    }
}
