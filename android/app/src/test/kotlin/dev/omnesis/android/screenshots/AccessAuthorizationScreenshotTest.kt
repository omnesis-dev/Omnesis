// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.unit.Density
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.AccessAuthorizationRequest
import dev.omnesis.android.transport.dto.AccessOverview
import dev.omnesis.android.transport.dto.AccessGrantRule
import dev.omnesis.android.transport.dto.AccessGrantSummary
import dev.omnesis.android.transport.dto.AccessPolicyFamilySummary
import dev.omnesis.android.transport.dto.AccessCredentialSummary
import dev.omnesis.android.transport.dto.AccessConnectionMatch
import dev.omnesis.android.transport.dto.AccessConnectionProposal
import dev.omnesis.android.transport.dto.AccessLevelSummary
import dev.omnesis.android.transport.dto.AccessPrincipalSummary
import dev.omnesis.android.transport.dto.AccessAnswerRelease
import dev.omnesis.android.transport.dto.AccessSourceBoundary
import dev.omnesis.android.transport.dto.AccessSourceMode
import dev.omnesis.android.transport.dto.AccessSourceInstance
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Modifier
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.dto.PrivacyPolicyDocument
import dev.omnesis.android.ui.access.AccessAuthorizationContent
import dev.omnesis.android.ui.access.AccessPolicyPreview
import dev.omnesis.android.ui.access.AccessPolicySheetBody
import dev.omnesis.android.ui.access.AccessAuthorizationCompletion
import dev.omnesis.android.ui.access.AccessAuthorizationForm
import dev.omnesis.android.ui.access.AccessAuthorizationStep
import dev.omnesis.android.ui.access.AccessAuthorizationUiState
import dev.omnesis.android.ui.access.AccessAnswerReleaseChoice
import dev.omnesis.android.ui.access.AccessSourceSelectionState
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class AccessAuthorizationScreenshotTest {
    @Test fun code_light() = capture("access_authorization_code_light", false) { content(AccessAuthorizationUiState()) }
    @Test fun code_dark() = capture("access_authorization_code_dark", true) { content(AccessAuthorizationUiState()) }

    @Test fun scanned_code_loading_light() = capture("access_authorization_scanned_loading_light", false) {
        content(AccessAuthorizationUiState(code = "ABCD-EFGH", loading = true))
    }

    @Test fun scanned_code_loading_dark() = capture("access_authorization_scanned_loading_dark", true) {
        content(AccessAuthorizationUiState(code = "ABCD-EFGH", loading = true))
    }

    @Test fun scanned_code_error_light() = capture("access_authorization_scanned_error_light", false) {
        content(AccessAuthorizationUiState(
            code = "ABCD-EFGH",
            lookupError = "No pending authorization matches that code.",
        ))
    }

    @Test fun scanned_code_error_dark() = capture("access_authorization_scanned_error_dark", true) {
        content(AccessAuthorizationUiState(
            code = "ABCD-EFGH",
            lookupError = "No pending authorization matches that code.",
        ))
    }

    @Test fun approval_confirmation_light() = capture("access_authorization_approved_light", false) {
        content(readyState().copy(completion = AccessAuthorizationCompletion.APPROVED))
    }

    @Test fun approval_confirmation_dark() = capture("access_authorization_approved_dark", true) {
        content(readyState().copy(completion = AccessAuthorizationCompletion.APPROVED))
    }

    @Test fun denial_confirmation_light() = capture("access_authorization_denied_light", false) {
        content(readyState().copy(completion = AccessAuthorizationCompletion.DENIED))
    }

    @Test fun denial_confirmation_dark() = capture("access_authorization_denied_dark", true) {
        content(readyState().copy(completion = AccessAuthorizationCompletion.DENIED))
    }

    @Test fun expired_request_light() = capture("access_authorization_expired_light", false) {
        content(expiredState(), AccessAuthorizationStep.REVIEW, configuredForm())
    }

    @Test fun expired_request_dark() = capture("access_authorization_expired_dark", true) {
        content(expiredState(), AccessAuthorizationStep.REVIEW, configuredForm())
    }

    @Test fun data_and_privacy_light() = capture("access_authorization_data_light", false) {
        content(readyState(), AccessAuthorizationStep.DATA, configuredForm())
    }

    @Test fun data_and_privacy_dark() = capture("access_authorization_data_dark", true) {
        content(readyState(), AccessAuthorizationStep.DATA, configuredForm())
    }

    /**
     * The reviewed release, with its policy list and the affordance that reads the chosen
     * policy without unwinding the wizard. A tall viewport because that block sits below the
     * source list on a phone-height render.
     */
    @Test
    @Config(sdk = [34], qualifiers = "w411dp-h1400dp-xxhdpi")
    fun reviewed_release_offers_the_policy_text() =
        capture("access_authorization_reviewed_policy_light", false) {
            content(
                readyState(),
                AccessAuthorizationStep.DATA,
                configuredForm().copy(directEnabled = false),
            )
        }

    /* ── The policy sheet's body: the chosen policy read without leaving the wizard ── */

    @Test fun policy_sheet_light() = capture("access_authorization_policy_sheet_light", false) {
        sheet(loadedPolicy)
    }

    @Test fun policy_sheet_dark() = capture("access_authorization_policy_sheet_dark", true) {
        sheet(loadedPolicy)
    }

    @Test fun policy_sheet_loading_light() = capture("access_authorization_policy_sheet_loading_light", false) {
        sheet(AccessPolicyPreview(familyId = "policy_example", name = "Everyday privacy"))
    }

    @Test fun policy_sheet_loading_dark() = capture("access_authorization_policy_sheet_loading_dark", true) {
        sheet(AccessPolicyPreview(familyId = "policy_example", name = "Everyday privacy"))
    }

    @Test fun policy_sheet_error_light() = capture("access_authorization_policy_sheet_error_light", false) {
        sheet(unreadablePolicy)
    }

    @Test fun policy_sheet_error_dark() = capture("access_authorization_policy_sheet_error_dark", true) {
        sheet(unreadablePolicy)
    }

    @Test fun review_large_text() = capture("access_authorization_review_large_text", false, 1.5f) {
        content(readyState(), AccessAuthorizationStep.REVIEW, configuredForm())
    }

    @Test fun permissions_light() = capture("access_authorization_permissions_light", false) {
        content(readyState(), AccessAuthorizationStep.PERMISSIONS, configuredForm())
    }

    @Test fun notes_only_review_light() = capture("access_authorization_notes_only_review_light", false) {
        content(readyState(), AccessAuthorizationStep.REVIEW, configuredForm().copy(answerEnabled = false, directEnabled = false, notesEnabled = true))
    }

    @Test fun notes_only_review_dark() = capture("access_authorization_notes_only_review_dark", true) {
        content(readyState(), AccessAuthorizationStep.REVIEW, configuredForm().copy(answerEnabled = false, directEnabled = false, notesEnabled = true))
    }

    @Test fun permissions_dark() = capture("access_authorization_permissions_dark", true) {
        content(readyState(), AccessAuthorizationStep.PERMISSIONS, configuredForm())
    }

    /* ── The Connection step: the connection's name and the access level it uses ── */

    /**
     * No match: the connection name on its field's line, and a new access level whose name field
     * sits under its title inside the list, with the replace switch below the list.
     */
    @Test
    @Config(sdk = [34], qualifiers = "w411dp-h1400dp-xxhdpi")
    fun connection_new_level_light() = capture("access_authorization_connection_new_level_light", false) {
        content(readyState(), AccessAuthorizationStep.CONNECTION)
    }

    @Test
    @Config(sdk = [34], qualifiers = "w411dp-h1400dp-xxhdpi")
    fun connection_new_level_dark() = capture("access_authorization_connection_new_level_dark", true) {
        content(readyState(), AccessAuthorizationStep.CONNECTION)
    }

    /** The matched connection's level, first in the list, tagged and preselected; no level name asked. */
    @Test
    @Config(sdk = [34], qualifiers = "w411dp-h1400dp-xxhdpi")
    fun connection_existing_level_light() = capture("access_authorization_connection_existing_level_light", false) {
        content(stateFor(existingLevelProposal), AccessAuthorizationStep.CONNECTION)
    }

    @Test
    @Config(sdk = [34], qualifiers = "w411dp-h1400dp-xxhdpi")
    fun connection_existing_level_dark() = capture("access_authorization_connection_existing_level_dark", true) {
        content(stateFor(existingLevelProposal), AccessAuthorizationStep.CONNECTION)
    }

    /**
     * The agent is already connected on this device: replace mode under one heading, its
     * connection picked, tagged Suggested and saying so inside its row.
     */
    @Test
    @Config(sdk = [34], qualifiers = "w411dp-h1400dp-xxhdpi")
    fun connection_replace_suggested_light() =
        capture("access_authorization_connection_replace_suggested_light", false) {
            content(stateFor(replaceProposal), AccessAuthorizationStep.CONNECTION)
        }

    @Test
    @Config(sdk = [34], qualifiers = "w411dp-h1400dp-xxhdpi")
    fun connection_replace_suggested_dark() =
        capture("access_authorization_connection_replace_suggested_dark", true) {
            content(stateFor(replaceProposal), AccessAuthorizationStep.CONNECTION)
        }

    /** The suggestion stays on its connection when the operator picks another one. */
    @Test
    @Config(sdk = [34], qualifiers = "w411dp-h1400dp-xxhdpi")
    fun connection_replace_other_picked_light() =
        capture("access_authorization_connection_replace_other_picked_light", false) {
            content(replaceOtherPickedState(), AccessAuthorizationStep.CONNECTION)
        }

    @Test
    @Config(sdk = [34], qualifiers = "w411dp-h1400dp-xxhdpi")
    fun connection_replace_other_picked_dark() =
        capture("access_authorization_connection_replace_other_picked_dark", true) {
            content(replaceOtherPickedState(), AccessAuthorizationStep.CONNECTION)
        }

    /** Replace mode opened by hand: nothing picked yet, so Continue waits. */
    @Test
    @Config(sdk = [34], qualifiers = "w411dp-h1400dp-xxhdpi")
    fun connection_replace_picker_light() = capture("access_authorization_connection_replace_picker_light", false) {
        content(replacePickerState(), AccessAuthorizationStep.CONNECTION)
    }

    @Test
    @Config(sdk = [34], qualifiers = "w411dp-h1400dp-xxhdpi")
    fun connection_replace_picker_dark() = capture("access_authorization_connection_replace_picker_dark", true) {
        content(replacePickerState(), AccessAuthorizationStep.CONNECTION)
    }

    /**
     * A new level named like a live one, regardless of case: the refusal under the field and
     * Continue disabled, before the gateway is asked.
     */
    @Test
    @Config(sdk = [34], qualifiers = "w411dp-h1400dp-xxhdpi")
    fun level_name_clash_light() = capture("access_authorization_level_name_clash_light", false) {
        content(levelNameClashState(), AccessAuthorizationStep.CONNECTION)
    }

    @Test
    @Config(sdk = [34], qualifiers = "w411dp-h1400dp-xxhdpi")
    fun level_name_clash_dark() = capture("access_authorization_level_name_clash_dark", true) {
        content(levelNameClashState(), AccessAuthorizationStep.CONNECTION)
    }

    /**
     * The gateway refused the new level's name, taken since the choices were read: back on the
     * Connection step with the refusal on top.
     */
    @Test
    @Config(sdk = [34], qualifiers = "w411dp-h1400dp-xxhdpi")
    fun level_name_taken_light() = capture("access_authorization_level_name_taken_light", false) {
        content(levelNameTakenState(), AccessAuthorizationStep.CONNECTION)
    }

    @Test
    @Config(sdk = [34], qualifiers = "w411dp-h1400dp-xxhdpi")
    fun level_name_taken_dark() = capture("access_authorization_level_name_taken_dark", true) {
        content(levelNameTakenState(), AccessAuthorizationStep.CONNECTION)
    }

    /**
     * An agent that needs Answer: the Notes-only level, used by one connection, is dimmed and
     * says why, while the suggested level stays selectable.
     */
    @Test
    @Config(sdk = [34], qualifiers = "w411dp-h1400dp-xxhdpi")
    fun connection_requires_answer_light() = capture("access_authorization_connection_requires_answer_light", false) {
        content(requiresAnswerState(), AccessAuthorizationStep.CONNECTION)
    }

    @Test
    @Config(sdk = [34], qualifiers = "w411dp-h1400dp-xxhdpi")
    fun connection_requires_answer_dark() = capture("access_authorization_connection_requires_answer_dark", true) {
        content(requiresAnswerState(), AccessAuthorizationStep.CONNECTION)
    }

    /**
     * The level list on a narrow phone, where the level name and its Suggested tag share a line
     * and the connection name's label sits above its field.
     */
    @Test
    @Config(sdk = [34], qualifiers = "w320dp-h1400dp-xxhdpi")
    fun narrow_connection_light() = capture("access_authorization_narrow_connection_light", false) {
        content(stateFor(existingLevelProposal), AccessAuthorizationStep.CONNECTION)
    }

    /** A new level on a narrow phone: its name's label above the field, inside the list. */
    @Test
    @Config(sdk = [34], qualifiers = "w320dp-h1400dp-xxhdpi")
    fun narrow_connection_new_level_light() = capture("access_authorization_narrow_connection_new_level_light", false) {
        content(readyState(), AccessAuthorizationStep.CONNECTION)
    }

    @Test
    @Config(sdk = [34], qualifiers = "w320dp-h1400dp-xxhdpi")
    fun narrow_connection_new_level_dark() = capture("access_authorization_narrow_connection_new_level_dark", true) {
        content(readyState(), AccessAuthorizationStep.CONNECTION)
    }

    /** Large text: every name field's label moves above its field. */
    @Test
    @Config(sdk = [34], qualifiers = "w411dp-h1400dp-xxhdpi")
    fun connection_large_text() = capture("access_authorization_connection_large_text", false, 1.5f) {
        content(stateFor(existingLevelProposal), AccessAuthorizationStep.CONNECTION)
    }

    @Test
    @Config(sdk = [34], qualifiers = "w411dp-h1400dp-xxhdpi")
    fun connection_new_level_large_text() =
        capture("access_authorization_connection_new_level_large_text", false, 1.5f) {
            content(readyState(), AccessAuthorizationStep.CONNECTION)
        }

    /** Replace mode in large text, where the Suggested tag has to share the name's line. */
    @Test
    @Config(sdk = [34], qualifiers = "w411dp-h1400dp-xxhdpi")
    fun connection_replace_large_text() =
        capture("access_authorization_connection_replace_large_text", false, 1.5f) {
            content(stateFor(replaceProposal), AccessAuthorizationStep.CONNECTION)
        }

    /** A replacement: the connection taken over, what it replaces, and the level's other connection. */
    @Test fun replace_review_light() = capture("access_authorization_replace_review_light", false) {
        content(stateFor(replaceProposal), AccessAuthorizationStep.REVIEW)
    }

    @Test fun replace_review_dark() = capture("access_authorization_replace_review_dark", true) {
        content(stateFor(replaceProposal), AccessAuthorizationStep.REVIEW)
    }

    /** An existing level's own rules, and the footnote naming how many connections share it. */
    @Test fun existing_level_review_light() = capture("access_authorization_existing_level_review_light", false) {
        content(stateFor(existingLevelProposal), AccessAuthorizationStep.REVIEW)
    }

    @Test fun existing_level_review_dark() = capture("access_authorization_existing_level_review_dark", true) {
        content(stateFor(existingLevelProposal), AccessAuthorizationStep.REVIEW)
    }

    /** A new level's name marked new, and the permissions the form holds. */
    @Test fun new_level_review_light() = capture("access_authorization_new_level_review_light", false) {
        content(readyState(), AccessAuthorizationStep.REVIEW, configuredForm())
    }

    @Test fun new_level_review_dark() = capture("access_authorization_new_level_review_dark", true) {
        content(readyState(), AccessAuthorizationStep.REVIEW, configuredForm())
    }

    @Test
    @Config(sdk = [34], qualifiers = "w411dp-h1400dp-xxhdpi")
    fun unreviewed_warning_light() = capture("access_authorization_unreviewed_light", false) {
        content(
            readyState(),
            AccessAuthorizationStep.DATA,
            configuredForm().copy(
                directEnabled = false,
                answerRelease = AccessAnswerReleaseChoice.UNREVIEWED,
            ),
        )
    }

    /**
     * A narrow phone, where the three chips have to step down the density
     * ladder to share one line: the rung the wider captures never reach.
     */
    @Test
    @Config(sdk = [34], qualifiers = "w320dp-h1400dp-xxhdpi")
    fun narrow_step_row_light() = capture("access_authorization_narrow_steps_light", false) {
        content(readyState(), AccessAuthorizationStep.DATA, configuredForm())
    }

    /** The review's rows and footnote at the same narrow width, where long values have to wrap. */
    @Test
    @Config(sdk = [34], qualifiers = "w320dp-h1400dp-xxhdpi")
    fun narrow_review_light() = capture("access_authorization_narrow_review_light", false) {
        content(stateFor(existingLevelProposal), AccessAuthorizationStep.REVIEW)
    }

    /** One list standing for both capabilities — the default when Answer and Direct are both held. */
    @Test
    @Config(sdk = [34], qualifiers = "w411dp-h1400dp-xxhdpi")
    fun shared_source_boundary_light() = capture("access_authorization_shared_sources_light", false) {
        content(
            readyState(),
            AccessAuthorizationStep.DATA,
            configuredForm().copy(linkedSources = true),
        )
    }

    @Test
    @Config(sdk = [34], qualifiers = "w411dp-h1400dp-xxhdpi")
    fun shared_source_boundary_dark() = capture("access_authorization_shared_sources_dark", true) {
        content(
            readyState(),
            AccessAuthorizationStep.DATA,
            configuredForm().copy(linkedSources = true),
        )
    }

    /** The refusal an empty shared list earns, printed inside the list that earns it. */
    @Test
    @Config(sdk = [34], qualifiers = "w411dp-h1400dp-xxhdpi")
    fun empty_shared_source_boundary_names_both_capabilities() =
        capture("access_authorization_empty_shared_sources_light", false) {
            content(
                readyState(),
                AccessAuthorizationStep.DATA,
                configuredForm().copy(
                    linkedSources = true,
                    answerSources = AccessSourceSelectionState(),
                ),
            )
        }

    /** The review's badges, with Answer released without a review — amber, not Direct's red. */
    @Test fun unreviewed_review_badges_light() = capture("access_authorization_unreviewed_review_light", false) {
        content(
            readyState(),
            AccessAuthorizationStep.REVIEW,
            configuredForm().copy(
                notesEnabled = true,
                answerRelease = AccessAnswerReleaseChoice.UNREVIEWED,
            ),
        )
    }

    @Test fun unreviewed_review_badges_dark() = capture("access_authorization_unreviewed_review_dark", true) {
        content(
            readyState(),
            AccessAuthorizationStep.REVIEW,
            configuredForm().copy(
                notesEnabled = true,
                answerRelease = AccessAnswerReleaseChoice.UNREVIEWED,
            ),
        )
    }

    @Test fun all_sources_has_no_contradictory_bulk_controls() = capture("access_authorization_all_sources_light", false) {
        content(
            readyState(),
            AccessAuthorizationStep.DATA,
            configuredForm().copy(
                directEnabled = false,
                answerSources = AccessSourceSelectionState(mode = AccessSourceMode.ALL),
            ),
        )
    }

    @Composable
    private fun content(
        state: AccessAuthorizationUiState,
        step: AccessAuthorizationStep = AccessAuthorizationStep.PERMISSIONS,
        form: AccessAuthorizationForm? = null,
    ) {
        AccessAuthorizationContent(
            state = state.copy(step = step, form = form ?: state.form),
            onClose = {},
            onLookup = {},
            onDecide = { _, _ -> },
            onFormChange = {},
            onStepChange = {},
            clock = { REFERENCE_NOW },
        )
    }

    private fun readyState() = stateFor(newLevelProposal)

    private fun stateFor(
        proposal: AccessConnectionProposal,
        request: AccessAuthorizationRequest = this.request,
        overview: AccessOverview = this.overview,
    ) = AccessAuthorizationUiState(
        request = request,
        overview = overview,
        form = AccessAuthorizationForm.initial(request, overview, proposal, nowMillis = REFERENCE_NOW),
    )

    private fun requiresAnswerState() =
        stateFor(existingLevelProposal, request.copy(requiresAnswer = true), notesCaptureOverview)

    private fun replacePickerState(): AccessAuthorizationUiState {
        val ready = readyState()
        val form = requireNotNull(ready.form)
        return ready.copy(form = form.copy(connection = form.connection?.copy(replacing = true)))
    }

    private fun replaceOtherPickedState(): AccessAuthorizationUiState {
        val suggested = stateFor(replaceProposal)
        val form = requireNotNull(suggested.form)
        return suggested.copy(form = form.copy(connection = form.connection?.copy(connectionId = "principal_studio")))
    }

    /** "planning" against the live "Planning" level. */
    private fun levelNameClashState(): AccessAuthorizationUiState {
        val ready = readyState()
        val form = requireNotNull(ready.form)
        return ready.copy(form = form.copy(connection = form.connection?.copy(levelName = "planning")))
    }

    private fun levelNameTakenState() =
        readyState().copy(actionError = "An access level with that name already exists.", levelNameTaken = true)

    private fun expiredState() = readyState().copy(request = request.copy(expiresAt = 1))

    /** Answer and Direct on separate lists — the shape the second option produces. */
    private fun configuredForm(): AccessAuthorizationForm {
        val initial = AccessAuthorizationForm.initial(request, overview, newLevelProposal, nowMillis = REFERENCE_NOW)
        return initial.copy(
            directEnabled = true,
            linkedSources = false,
            answerSources = initial.answerSources.setAllowed("notes:fictional", true),
            directSources = initial.directSources.setAllowed("files:fictional", true),
        )
    }

    /** The sheet body on the page ground it is presented over, at the sheet's own width. */
    @Composable
    private fun sheet(preview: AccessPolicyPreview) {
        Box(Modifier.fillMaxSize().background(OmTheme.colors.bgPrimary)) {
            AccessPolicySheetBody(preview, Modifier.padding(top = OmSpacing.lg))
        }
    }

    private val loadedPolicy = AccessPolicyPreview(
        familyId = "policy_example",
        name = "Everyday privacy",
        loading = false,
        document = PrivacyPolicyDocument(
            policy = "# Everyday privacy\n\nAnswers may name upcoming events and their dates. " +
                "Exact addresses, account numbers and anything marked confidential stay inside " +
                "Omnesis and are held for your review.\n\n- Credentials are blocked outright.\n" +
                "- Health metrics are shared only as trends, never as readings.",
            revision = "revision-example",
        ),
    )

    private val unreadablePolicy = AccessPolicyPreview(
        familyId = "policy_example",
        name = "Everyday privacy",
        loading = false,
        error = "That policy is no longer published on this gateway.",
    )

    private fun capture(name: String, dark: Boolean, fontScale: Float = 1f, content: @Composable () -> Unit) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            val density = LocalDensity.current
            CompositionLocalProvider(
                LocalInspectionMode provides true,
                LocalDensity provides Density(density.density, fontScale),
            ) {
                OmnesisTheme(darkTheme = dark, content = content)
            }
        }
    }

    private val request = AccessAuthorizationRequest(
        id = "request_example",
        approvalId = "approval_example",
        status = "pending",
        clientId = "client_example",
        clientName = "Northstar Assistant",
        redirectOrigin = "http://127.0.0.1:10000",
        resource = "https://gateway.example.com/mcp",
        scope = "omnesis:access",
        expiresAt = REFERENCE_NOW + 540_000,
        requiresAnswer = false,
    )
    /** A level whose Answer and Direct read different sources, so its review lists two source rows. */
    private val researchRules = listOf(
        AccessGrantRule.answer(
            AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf("notes:fictional")),
            AccessAnswerRelease.reviewed("policy_example"),
        ),
        AccessGrantRule.direct(
            AccessSourceBoundary(AccessSourceMode.DENYLIST, listOf("calendar:fictional")),
        ),
    )

    private val planningRules = listOf(
        AccessGrantRule.answer(AccessSourceBoundary(AccessSourceMode.ALL, emptyList()), AccessAnswerRelease.unreviewed()),
        AccessGrantRule.notes(),
    )

    private val overview = AccessOverview(
        principals = listOf(
            connectionSummary("principal_laptop", "Northstar laptop", "level_research", researchRules, REFERENCE_NOW - 2 * 3_600_000L),
            connectionSummary("principal_studio", "Studio desktop", "level_research", researchRules, REFERENCE_NOW - 3 * 86_400_000L),
            connectionSummary("principal_tablet", "Aurora tablet", "level_planning", planningRules, null),
        ),
        sources = listOf(
            AccessSourceInstance("notes:fictional", "Fictional Notes"),
            AccessSourceInstance("files:fictional", "Project Files"),
            AccessSourceInstance("calendar:fictional", "Example Calendar"),
        ),
        policyFamilies = listOf(AccessPolicyFamilySummary("policy_example", "Everyday privacy", "4")),
        defaultPolicyFamilyId = "policy_example",
        levels = listOf(
            AccessLevelSummary("level_capture", "Notes capture", 1, listOf(AccessGrantRule.notes()), 0),
            AccessLevelSummary("level_planning", "Planning", 2, planningRules, 1),
            AccessLevelSummary("level_research", "Research", 3, researchRules, 2),
        ),
    )

    private fun connectionSummary(
        id: String,
        name: String,
        levelId: String,
        rules: List<AccessGrantRule>,
        lastUsedAt: Long?,
    ) = AccessPrincipalSummary(
        id = id,
        name = name,
        kind = "interactive",
        grants = listOf(
            AccessGrantSummary(
                id = "grant_$id",
                name = "$name access",
                revision = 5,
                rules = rules,
                credentials = listOf(AccessCredentialSummary("credential_$id", name, "active", lastUsedAt = lastUsedAt)),
                levelId = levelId,
            ),
        ),
    )

    private companion object {
        /**
         * The instant every capture is rendered at, so the deadline and "Last used" text read
         * the same on every recording.
         */
        const val REFERENCE_NOW = 1_782_000_000_000L
    }

    /** A request from an app the gateway has not seen before. */
    private val newLevelProposal = AccessConnectionProposal(
        defaultName = "Northstar Assistant",
        defaultLevelName = "Northstar Assistant",
    )

    /** The same app is already connected elsewhere, on the Research level. */
    private val existingLevelProposal = newLevelProposal.copy(
        match = AccessConnectionMatch(
            connectionId = "principal_laptop",
            connectionName = "Northstar laptop",
            matchedBy = "client",
            levelId = "level_research",
            grant = overview.principals.first().grants.first(),
        ),
        recommended = "existing-level",
    )

    /** The agent is already connected on this device, so replacing its sign-in is suggested. */
    private val replaceProposal = existingLevelProposal.copy(
        match = existingLevelProposal.match?.copy(matchedBy = "device"),
        recommended = "replace",
    )

    /** The overview with a connection named after the Notes-only level it uses. */
    private val notesCaptureOverview = overview.copy(
        principals = overview.principals + connectionSummary(
            "principal_notes",
            "Notes capture",
            "level_capture",
            listOf(AccessGrantRule.notes()),
            REFERENCE_NOW - 5 * 86_400_000L,
        ),
        levels = overview.levels.map { if (it.id == "level_capture") it.copy(connectionCount = 1) else it },
    )
}
