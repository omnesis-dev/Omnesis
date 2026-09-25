// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.setup.flow

/** Where a step's row sits on the Choose screen. */
enum class SetupGroup {
    /** A phone-hosted source: its data goes to the gateway. */
    SOURCE,

    /** A phone capability the flow also offers (notifications, background syncing). */
    ALSO,
}

/** Whether a step can be offered on this phone right now. */
sealed interface SetupAvailability {
    data object Available : SetupAvailability

    /** Shown but not selectable; [reason] replaces the row's value line. */
    data class Disabled(val reason: String) : SetupAvailability

    /** Not shown at all on this phone or edition. */
    data object Hidden : SetupAvailability
}

/** One Choose row as the flow sees it at a moment. The host refreshes these on every resume. */
data class SetupRow(
    val id: String,
    val group: SetupGroup,
    val availability: SetupAvailability,
    /** Already on for this device: shown as on, never selectable. */
    val on: Boolean,
) {
    val visible: Boolean get() = availability != SetupAvailability.Hidden
    val selectable: Boolean get() = availability == SetupAvailability.Available && !on
}

/** An option the gateway needs the user to pick before this phone can contribute: what it does, and what follows. */
data class SetupChoice(val id: String, val title: String, val detail: String)

/** How one step ended. Rendered in place of the step's ledger and actions. */
sealed interface SetupOutcome {
    val kind: SetupOutcomeKind

    data object On : SetupOutcome {
        override val kind = SetupOutcomeKind.ON
    }

    /** On, reading only what the user selected. A choice, not an error. */
    data object Limited : SetupOutcome {
        override val kind = SetupOutcomeKind.LIMITED
    }

    /** On, with some of what was asked for not allowed. */
    data object Partial : SetupOutcome {
        override val kind = SetupOutcomeKind.PARTIAL
    }

    data object NotAllowed : SetupOutcome {
        override val kind = SetupOutcomeKind.NOT_ALLOWED
    }

    /** Something this phone lacks; [actionLabel] names the step's own way to fix it. */
    data class Unavailable(val title: String, val body: String, val actionLabel: String?) : SetupOutcome {
        override val kind = SetupOutcomeKind.UNAVAILABLE
    }

    data class ChoiceRequired(val options: List<SetupChoice>) : SetupOutcome {
        override val kind = SetupOutcomeKind.CHOICE_REQUIRED
    }

    /** [message] is what the enable path said, already in words; null means nothing usable. */
    data class Failed(val message: String?) : SetupOutcome {
        override val kind = SetupOutcomeKind.FAILED
    }

    /** Declined on this page. Never rendered: the flow moves on. */
    data object Skipped : SetupOutcome {
        override val kind = SetupOutcomeKind.SKIPPED
    }

    /** The user kept the device that already sends this source. Never rendered: the flow moves on. */
    data object KeptOther : SetupOutcome {
        override val kind = SetupOutcomeKind.KEPT_OTHER
    }
}

enum class SetupOutcomeKind(val persisted: String) {
    ON("on"),
    LIMITED("limited"),
    PARTIAL("partial"),
    NOT_ALLOWED("notAllowed"),
    UNAVAILABLE("unavailable"),
    CHOICE_REQUIRED("choiceRequired"),
    FAILED("failed"),
    SKIPPED("skipped"),
    KEPT_OTHER("keptOther"),
    ;

    /** Whether a step that ended this way sends anything to the gateway. */
    val contributing: Boolean get() = this == ON || this == LIMITED || this == PARTIAL

    /** Whether the page moves straight on instead of showing this outcome. */
    val passesOver: Boolean get() = this == SKIPPED || this == KEPT_OTHER

    companion object {
        fun fromPersisted(value: String): SetupOutcomeKind? = entries.firstOrNull { it.persisted == value }
    }
}

/**
 * The outcome a persisted kind stands for before its step re-reads the phone.
 * Kinds whose detail is not persisted (an unavailable reason, a pending
 * choice) come back unresolved, so the page asks again rather than showing a
 * stale reason.
 */
fun SetupOutcomeKind.restored(): SetupOutcome? = when (this) {
    SetupOutcomeKind.ON -> SetupOutcome.On
    SetupOutcomeKind.LIMITED -> SetupOutcome.Limited
    SetupOutcomeKind.PARTIAL -> SetupOutcome.Partial
    SetupOutcomeKind.NOT_ALLOWED -> SetupOutcome.NotAllowed
    SetupOutcomeKind.FAILED -> SetupOutcome.Failed(null)
    SetupOutcomeKind.SKIPPED -> SetupOutcome.Skipped
    SetupOutcomeKind.KEPT_OTHER -> SetupOutcome.KeptOther
    SetupOutcomeKind.UNAVAILABLE, SetupOutcomeKind.CHOICE_REQUIRED -> null
}

/** What a page shows while a step's enable path runs. */
enum class SetupBusy {
    IDLE,

    /** Talking to the gateway or finishing the local enable. */
    WORKING,

    /** A system dialog or system settings screen is in front of the app. */
    WAITING_FOR_SYSTEM,
}
