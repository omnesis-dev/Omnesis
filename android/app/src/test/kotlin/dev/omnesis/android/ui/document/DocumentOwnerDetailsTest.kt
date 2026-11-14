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
            DocumentFilterField("extra.folderId", FilterNoun("folder", "folders"), DocumentFilterField.TOO_OLD, "Written before this source recorded its folders. Resync the source to add them."),
            DocumentFilterField("extra.projectDir", FilterNoun("project folder", "project folders"), DocumentFilterField.UNKNOWN),
            DocumentFilterField("extra.repositoryId", FilterNoun("repository", "repositories"), DocumentFilterField.PRESENT,
                items = listOf(DocumentFilterItem("5201", "5201", listed = false))),
        ))
        assertEquals(listOf(
            FilterDetailLine("Labels", NO_FILTER_ITEMS),
            FilterDetailLine("Folders", "Written before this source recorded its folders. Resync the source to add them."),
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

    @Test fun aSourceNoFilterCanUseShowsNoFilterDetailsButStillLeadsToWhoCanReadIt() {
        val bundle = DocumentFixtures.bundle(SourceIconModel(fallbackInitial = "W"))
        val noFields = bundle.copy(filterDetails = DocumentFixtures.filterDetails.copy(fields = emptyList()))
        assertEquals(emptyList<FilterDetailLine>(), noFields.filterDetails?.lines())
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            InspectorContent(noFields, onDone = {}, onOpenAccess = {})
        } } }
        compose.onNodeWithText(WHO_CAN_READ_TITLE).assertExists()
        compose.onNodeWithText("Filter details", substring = true, ignoreCase = true).assertDoesNotExist()
        compose.onNodeWithText("Source version").assertDoesNotExist()
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

    @Test fun theAuditsAccountLineIsTheSourceNameThenTheGatewaysAccountLabel() {
        // The raw id is E.164; the formatted label can only have come from the gateway.
        val audit = DocumentFixtures.audit
        assertEquals("whatsapp-messages:+15550100123", audit.sourceId)
        assertEquals("WhatsApp · +1 (555) 010-0123", audit.accountName().line)
        assertEquals("WhatsApp", audit.copy(accountLabel = null).accountName().line)
        assertEquals("Notes", audit.copy(sourceId = "notes", sourceName = "Notes", accountLabel = " ").accountName().line)
    }
}
