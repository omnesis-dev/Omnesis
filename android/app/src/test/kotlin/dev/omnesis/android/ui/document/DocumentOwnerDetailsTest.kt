// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.document

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.DocumentFilterDetails
import dev.omnesis.android.transport.dto.DocumentFilterField
import dev.omnesis.android.transport.dto.DocumentFilterItem
import dev.omnesis.android.transport.dto.FilterNoun
import dev.omnesis.android.ui.common.Loadable
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** What the owner sees of a document's filter details, and the page that says which access levels can read it. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class DocumentOwnerDetailsTest {
    @get:Rule val compose = createComposeRule()

    @Test fun eachFieldIsNamedForHowManyItemsItHoldsThenTheSourceVersion() {
        assertEquals(
            listOf(FilterDetailLine("Chat", "Workshop planning"), FilterDetailLine("People", "Maya Reeves, Jamie Lopez"), FilterDetailLine("Source version", "1")),
            DocumentFixtures.filterDetails.lines(),
        )
    }

    @Test fun aFieldWithNoItemsTooOldOrUnknownSaysSoInPlainWords() {
        val labels = FilterNoun("label", "labels")
        val details = DocumentFilterDetails("doc-example", 0, listOf(
            DocumentFilterField("extra.labelIds", labels, DocumentFilterField.PRESENT),
            DocumentFilterField("extra.folderId", FilterNoun("folder", "folders"), DocumentFilterField.TOO_OLD, "Too old to carry its folders. Resync Drive to add them."),
            DocumentFilterField("extra.projectDir", FilterNoun("project folder", "project folders"), DocumentFilterField.UNKNOWN),
            DocumentFilterField("extra.repositoryId", FilterNoun("repository", "repositories"), DocumentFilterField.PRESENT,
                items = listOf(DocumentFilterItem("5201", "5201", listed = false))),
        ))
        assertEquals(listOf(
            FilterDetailLine("Labels", NO_FILTER_ITEMS),
            FilterDetailLine("Folders", "Too old to carry its folders. Resync Drive to add them."),
            FilterDetailLine("Project folders", "Not recorded"),
            FilterDetailLine("Repository", "5201"),
            FilterDetailLine("Source version", "0"),
        ), details.lines())
    }

    @Test fun theOwnersDetailsListTheFilterDetailsAndLeadToWhoCanReadIt() {
        var opened = 0
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            InspectorContent(DocumentFixtures.bundle(SourceIconModel(fallbackInitial = "W")), onDone = {}, onOpenAccess = { opened++ })
        } } }
        compose.onNodeWithText("Maya Reeves, Jamie Lopez").performScrollTo().assertExists()
        compose.onNodeWithText("Source version").performScrollTo().assertExists()
        compose.onNodeWithText(WHO_CAN_READ_TITLE).performClick()
        assertEquals(1, opened)
    }

    @Test fun anotherDevicesDetailsHaveNoEntryToWhoCanReadIt() {
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            InspectorContent(DocumentFixtures.bundle(SourceIconModel(fallbackInitial = "W")).copy(owner = false, filterDetails = null), onDone = {})
        } } }
        compose.onNodeWithText(WHO_CAN_READ_TITLE).assertDoesNotExist()
        compose.onNodeWithText("Filter details", substring = true, ignoreCase = true).assertDoesNotExist()
    }

    @Test fun theAccessPageListsEveryLevelWithAReadableMarkThatIsNotOnlyAColour() {
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            DocumentAccessContent(Loadable.Content(DocumentFixtures.audit), iconFor = { SourceIconModel(fallbackInitial = "W") }, onBack = {}, onRetry = {})
        } } }
        compose.onNodeWithText(WHO_CAN_READ_TITLE).assertExists()
        compose.onNodeWithText("Workshop planning — 14 March").assertExists()
        compose.onNodeWithText("WhatsApp · +1 (555) 010-0123").assertExists()
        listOf("Family helper", "Notes capture", "Research assistant").forEach { compose.onNodeWithText(it).performScrollTo().assertExists() }
        compose.onNodeWithContentDescription("Answer: Can read. This account is shared with all content").performScrollTo().assertExists()
        compose.onNodeWithContentDescription("Answer: Can’t read. Hidden by: chat Workshop planning").performScrollTo().assertExists()
        compose.onNodeWithContentDescription("Direct: Can’t read. This account is not shared").performScrollTo().assertExists()
        compose.onNodeWithText("Kitchen speaker").performScrollTo().assertExists()
        compose.onNodeWithText("INTEGRATION").assertExists()
    }

    @Test fun theAccessPageSaysWhenItCannotLoadAndAsksAgain() {
        var retries = 0
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            DocumentAccessContent(Loadable.Error(IllegalStateException("offline")), iconFor = { SourceIconModel() }, onBack = {}, onRetry = { retries++ })
        } } }
        compose.onNodeWithText("Try again").performClick()
        assertEquals(1, retries)
    }
}
