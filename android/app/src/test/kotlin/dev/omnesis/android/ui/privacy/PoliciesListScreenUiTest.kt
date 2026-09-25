// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.privacy

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.PrivacyPolicyFamilySummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.Locale

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class PoliciesListScreenUiTest {
    @get:Rule
    val compose = createComposeRule()

    private val defaultId = "family-everyday"

    private val families = listOf(
        PrivacyPolicyFamilySummary(
            id = "family-work",
            name = "Work updates",
            currentRevision = "fedcba9876543210fedcba98",
            currentVersion = 2,
            affectedGrantIds = listOf("grant-1"),
        ),
        PrivacyPolicyFamilySummary(
            id = defaultId,
            name = "Everyday policy",
            currentRevision = "0123456789abcdef0123456789abcdef",
            currentVersion = 4,
            affectedGrantIds = listOf("grant-2", "grant-3"),
        ),
        PrivacyPolicyFamilySummary(
            id = "family-archived",
            name = "Retired policy",
            currentRevision = "aaaaaaaaaaaaaaaa",
            archivedAt = 1_782_000_000_000,
            affectedGrantIds = listOf("grant-4"),
        ),
        PrivacyPolicyFamilySummary(
            id = "family-fresh",
            name = "Family plans",
            currentRevision = "bbbbbbbbbbbbbbbb",
        ),
    )

    /* ── Rows ── */

    @Test
    fun rowsLeaveOutArchivedFamiliesAndPutTheDefaultFirstThenTheRestByName() {
        val rows = policyFamilyRows(families, defaultId)

        assertEquals(listOf("Everyday policy", "Family plans", "Work updates"), rows.map { it.title })
        assertEquals(listOf(true, false, false), rows.map { it.isDefault })
        assertEquals("0123456789ab", rows[0].shortRevision)
    }

    @Test
    fun aFamilyWithNoIdIsLeftOutAndARepeatedIdKeepsItsFirstSummary() {
        val rows = policyFamilyRows(
            listOf(
                PrivacyPolicyFamilySummary(id = "", name = "Nameless id"),
                PrivacyPolicyFamilySummary(id = "   ", name = "Blank id"),
                PrivacyPolicyFamilySummary(id = "family-twice", name = "First copy"),
                PrivacyPolicyFamilySummary(id = " family-twice ", name = "Second copy"),
            ),
            defaultFamilyId = null,
        )

        assertEquals(listOf("family-twice"), rows.map { it.id })
        assertEquals(listOf("First copy"), rows.map { it.title })
    }

    @Test
    fun aFamilyWithABlankNameIsTitledPolicyAndCarriesNoName() {
        val rows = policyFamilyRows(
            listOf(PrivacyPolicyFamilySummary(id = "family-unnamed", name = "   ")),
            defaultFamilyId = null,
        )

        assertEquals("Policy", rows.single().title)
        assertNull(rows.single().name)
    }

    @Test
    fun namesSortWithoutRegardToTheDefaultLocaleAndTieOnId() {
        val previous = Locale.getDefault()
        Locale.setDefault(Locale("tr", "TR"))
        try {
            val rows = policyFamilyRows(
                listOf(
                    PrivacyPolicyFamilySummary(id = "family-b", name = "iy policy"),
                    PrivacyPolicyFamilySummary(id = "family-a", name = "Ix policy"),
                    PrivacyPolicyFamilySummary(id = "family-d", name = "Policy 2"),
                    PrivacyPolicyFamilySummary(id = "family-c", name = "Policy 10"),
                    PrivacyPolicyFamilySummary(id = "family-f", name = "same name"),
                    PrivacyPolicyFamilySummary(id = "family-e", name = "Same Name"),
                ),
                defaultFamilyId = null,
            )

            assertEquals(
                listOf("family-a", "family-b", "family-c", "family-d", "family-e", "family-f"),
                rows.map { it.id },
            )
        } finally {
            Locale.setDefault(previous)
        }
    }

    @Test
    fun theDefaultIsMarkedOnlyWhenTheOverviewNamesOne() {
        assertEquals(listOf(false, false, false), policyFamilyRows(families, null).map { it.isDefault })
        assertEquals(listOf(true, false, false), policyFamilyRows(families, " $defaultId ").map { it.isDefault })
    }

    @Test
    fun theDefaultMarkerFollowsASuccessfulOverviewAndSurvivesAFailedOne() {
        assertNull(defaultFamilyMarker(previous = null, overview = Result.failure(IllegalStateException("offline"))))
        assertEquals(defaultId, defaultFamilyMarker(previous = null, overview = Result.success(defaultId)))
        assertEquals(defaultId, defaultFamilyMarker(previous = defaultId, overview = Result.failure(IllegalStateException("offline"))))
        assertNull(defaultFamilyMarker(previous = defaultId, overview = Result.success(null)))
    }

    /* ── Screen ── */

    @Test
    fun everyLiveFamilyIsListedWithItsRevisionAndTheGrantsItGoverns() {
        show(PoliciesListUiState(loading = false, policies = policyFamilyRows(families, defaultId)))

        compose.onNodeWithText("Everyday policy").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Revision 0123456789ab · governs 2 grants").assertIsDisplayed()
        compose.onNodeWithText("Work updates").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Revision fedcba987654 · governs 1 grant").assertIsDisplayed()
        compose.onNodeWithText("Family plans").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Revision bbbbbbbbbbbb · governs no grant yet").assertIsDisplayed()
        compose.onNodeWithText("Retired policy").assertDoesNotExist()
    }

    @Test
    fun onlyTheDefaultFamilyCarriesTheDefaultCaption() {
        show(PoliciesListUiState(loading = false, policies = policyFamilyRows(families, defaultId)))

        compose.onNodeWithText("Default policy").assertIsDisplayed()
        compose.onNode(hasClickAction() and hasText("Everyday policy") and hasText("Default policy"))
            .assertIsDisplayed()
        compose.onNode(hasClickAction() and hasText("Work updates") and hasText("Default policy"))
            .assertDoesNotExist()
    }

    @Test
    fun tappingARowOpensThatFamilyByIdAndName() {
        val opened = mutableListOf<Pair<String, String?>>()
        show(
            PoliciesListUiState(loading = false, policies = policyFamilyRows(families, defaultId)),
            onOpenPolicy = { id, name -> opened += id to name },
        )

        compose.onNodeWithText("Work updates").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf("family-work" to "Work updates"), opened) }
    }

    @Test
    fun tappingANamelessRowOpensTheFamilyWithNoName() {
        val opened = mutableListOf<Pair<String, String?>>()
        val rows = policyFamilyRows(listOf(PrivacyPolicyFamilySummary(id = "family-unnamed", name = "")), null)
        show(PoliciesListUiState(loading = false, policies = rows), onOpenPolicy = { id, name -> opened += id to name })

        compose.onNodeWithText("Policy").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf("family-unnamed" to null), opened) }
    }

    @Test
    fun anEmptyGatewaySaysSoRatherThanShowingABlankPage() {
        show(PoliciesListUiState(loading = false))

        compose.onNodeWithText("No policies yet").assertIsDisplayed()
    }

    @Test
    fun theLeadingActionReturnsToSettings() {
        var backs = 0
        show(PoliciesListUiState(loading = false), onBack = { backs += 1 })

        compose.onNodeWithContentDescription("Back to Settings").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(1, backs) }
    }

    @Test
    fun anUnreachableGatewayWithNothingCachedOffersARetry() {
        var retries = 0
        show(
            PoliciesListUiState(loading = false, error = IllegalStateException("offline")),
            onRetry = { retries += 1 },
        )

        compose.onNodeWithText("No policies yet").assertDoesNotExist()
        compose.onNodeWithText("Retry").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(1, retries) }
    }

    /** A refresh that fails keeps what was already on screen and says so in one line. */
    @Test
    fun aFailedRefreshKeepsTheCachedRowsUnderABanner() {
        show(
            PoliciesListUiState(
                loading = false,
                policies = policyFamilyRows(families, defaultId),
                error = IllegalStateException("offline"),
            ),
        )

        compose.onNodeWithText("Could not refresh the policies", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Everyday policy").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Retry").assertDoesNotExist()
    }

    @Test
    fun aRefreshOverCachedRowsDoesNotReplaceThemWithASpinner() {
        show(
            PoliciesListUiState(
                loading = false,
                refreshing = true,
                policies = policyFamilyRows(families, defaultId),
            ),
        )

        compose.onNodeWithText("Everyday policy").performScrollTo().assertIsDisplayed()
    }

    private fun show(
        state: PoliciesListUiState,
        onBack: () -> Unit = {},
        onRetry: () -> Unit = {},
        onOpenPolicy: (String, String?) -> Unit = { _, _ -> },
    ) {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                PoliciesListContent(
                    state = state,
                    onBack = onBack,
                    onOpenPolicy = onOpenPolicy,
                    onRetry = onRetry,
                )
            }
        }
    }
}
