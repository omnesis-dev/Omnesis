// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.setup

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import dev.omnesis.android.setup.flow.SetupAvailability
import dev.omnesis.android.setup.flow.SetupBusy
import dev.omnesis.android.setup.flow.SetupChoice
import dev.omnesis.android.setup.flow.SetupGroup
import dev.omnesis.android.setup.flow.SetupOutcome
import java.text.NumberFormat
import java.util.Locale
import kotlinx.coroutines.flow.Flow

/**
 * One page of the phone setup flow, implemented beside what it sets up: each
 * phone-hosted source in its own feature module, notifications and background
 * syncing in the app. Contributed into a Hilt set, so the flow walks whatever
 * this build and edition provide without naming any of it.
 *
 * A step is a singleton that owns its enable for the life of the process, so
 * leaving its page, reopening it, or recreating the activity never starts a
 * second one or loses Android's answer.
 */
interface PhoneSetupStep {
    /** Stable id, persisted with the flow's position. */
    val id: String

    /** Position on Choose and in the walk; lower first. */
    val order: Int

    val group: SetupGroup

    /** The gateway source whose sync status the outcome and Finish rows show, if any. */
    val sourceId: String?

    /** Everything the page and the source's Settings disclosure say. */
    val copy: SetupStepCopy

    /** Re-reads anything [availability] and [isOn] depend on that can only be read asynchronously. */
    suspend fun refresh() {}

    fun availability(): SetupAvailability

    /** Already on for this device. */
    fun isOn(): Boolean

    /**
     * The outcome as the phone reads it now, given how the step last ended —
     * after the user changed something in system Settings, or when a killed
     * flow resumes. Null makes the step unresolved again.
     */
    suspend fun refreshOutcome(previous: SetupOutcome): SetupOutcome? = previous

    /** How this step's enable ended, as it happens; null makes the step unresolved again. */
    val outcomes: Flow<SetupOutcome?>

    /** The user declined this step's page. */
    fun notNow() {}

    /** The app came back to the foreground while this step's page is showing and unresolved. */
    fun resume() {}

    /**
     * The phone unpaired or started re-pairing: anything under way is
     * cancelled and nothing the user chose or agreed to on this page survives.
     */
    fun reset() {}

    /** Hosts this step's launchers for the page showing it. */
    @Composable
    fun rememberController(): SetupStepController

    /** A section the ledger shows between what is sent and what stays, when the step has one. */
    val extraSection: (@Composable () -> Unit)? get() = null

    /** An illustration shown above the ledger, when the step has one. */
    val illustration: (@Composable () -> Unit)? get() = null
}

/** What a step page asks of the step it shows. */
interface SetupStepController {
    val busy: SetupBusy

    /** False while the step's own input is incomplete (no Health category selected, say). */
    val primaryEnabled: Boolean

    /** Replaces the copy's fine print while the step has something to say about its input. */
    val fineNote: String?

    /** The page's primary action: ask for access and turn the step on. */
    fun agree()

    fun choose(option: SetupChoice)

    /** Opens the system screen where the grant can change, and re-reads it on return. */
    fun openSettings()

    fun retry()

    /** The step's own follow-up: installing a provider app, adding more photos. */
    fun secondaryAction()
}

/** The words, glyph and tint one step shows. One value per step, shared by the flow and Settings. */
@Immutable
data class SetupStepCopy(
    /** The step's title, matching its Settings card. */
    val name: String,
    val glyph: ImageVector,
    val tint: Color,
    /** The value line on Choose. */
    val row: String,
    /** The value line on the step page. */
    val value: String,
    /** An example question the step makes answerable. */
    val ask: String? = null,
    /** The prominent disclosure: what is read and sent, including while the app is closed. */
    val disclosure: String? = null,
    val ledger: SetupLedger? = null,
    /** Shown instead of a ledger by steps that send nothing. */
    val highlights: List<SetupHighlight> = emptyList(),
    val primaryLabel: String = "Agree & continue",
    val fine: String? = null,
    /** Names the grant in the "is off" outcome: "photo access", "usage access". */
    val permissionLabel: String,
    val onBody: String,
    val onTitle: String? = null,
    val limitedBody: String? = null,
    val limitedActionLabel: String? = null,
    val partialBody: String? = null,
    /** Where the "with limits" outcome sends the user; "Open Settings" when null. */
    val partialActionLabel: String? = null,
    val offTitle: String? = null,
    val offBody: String? = null,
    /** The noun for what the source sends, for "{count} {unit} processed". */
    val unit: SetupUnit? = null,
    /** Which setting to change, and where, shown above the button that opens it on an "off" or "with limits" outcome. */
    val settingsSteps: String? = null,
    /** What the primary button says while the enable runs without a system screen up; "Turning on {name}…" when null. */
    val workingLabel: String? = null,
)

/** What leaves the phone and what never does. */
@Immutable
data class SetupLedger(
    val sent: List<String>,
    /** Read-only extra grants the system also asks for. */
    val alsoAsked: List<String> = emptyList(),
    /** "Stays on this phone" or "Never". */
    val staysLabel: String,
    val stays: List<String>,
)

@Immutable
data class SetupHighlight(val icon: ImageVector, val text: String)

@Immutable
data class SetupUnit(val one: String, val many: String) {
    fun count(n: Long): String = "${NumberFormat.getIntegerInstance(Locale.US).format(n)} ${if (n == 1L) one else many}"
}

/** How a source's sync reads at a glance, and so which mark sits beside its line. */
enum class SetupStatusKind {
    SYNCING,
    UP_TO_DATE,
    NOT_SYNCED,

    /** Failed, paused or otherwise needing the user. */
    ATTENTION,
}

/** A source's live sync line: a count while a run reports one, otherwise a headline, with a fill while it runs. */
@Immutable
data class SetupStatusLine(val text: String, val kind: SetupStatusKind, val fraction: Float? = null) {
    companion object {
        /** What a source shows before its first status arrives. */
        val NotSyncedYet = SetupStatusLine("Not synced yet", SetupStatusKind.NOT_SYNCED)
    }
}
