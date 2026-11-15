// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport

import dev.omnesis.android.transport.dto.ResyncMode

// What the Resync action of a source can do on the paired gateway, and which requests carry
// it out.

/** What the Resync action of one source can do on the paired gateway. */
sealed interface ResyncOffer {
    /** The source cannot be resynced: no Resync action is shown. */
    data object Unavailable : ResyncOffer

    /**
     * The gateway predates resync modes. Its resync always deletes first, so only that is
     * offered, behind a plain confirmation.
     */
    data object WipeOnly : ResyncOffer

    /** The gateway resyncs in any of [modes], listed in the order shown. */
    data class Choice(val modes: List<ResyncMode>) : ResyncOffer {
        /** The mode the choice opens on: in place when offered, since it deletes nothing. */
        val defaultMode: ResyncMode
            get() = if (ResyncMode.IN_PLACE in modes) ResyncMode.IN_PLACE else modes.first()
    }
}

/**
 * The offer for a source whose listing carries [resyncModes]: null from a gateway that
 * predates the field, empty for a source that cannot be resynced. A mode this build does not
 * know is not offered.
 */
fun resyncOffer(resyncModes: List<String>?): ResyncOffer {
    if (resyncModes == null) return ResyncOffer.WipeOnly
    val known = ResyncMode.entries.filter { it.wire in resyncModes }
    return if (known.isEmpty()) ResyncOffer.Unavailable else ResyncOffer.Choice(known)
}

/** One gateway request of a resync. */
sealed interface ResyncStep {
    /** `POST /admin/sources/:id/resync` with the mode. */
    data class Resync(val mode: ResyncMode) : ResyncStep

    /** `POST /documents/delete-all/source/:id`. */
    data object DeleteAll : ResyncStep

    /** `POST /admin/sources/:id/sync`. */
    data object Sync : ResyncStep
}

/** The gateway cannot resync this source the way that was asked. */
class ResyncNotOffered : IllegalStateException("This gateway cannot resync the source that way.")

/**
 * The requests that resync a source in [mode]. A gateway with resync modes takes the mode on
 * its resync route. One that predates them has no route that takes a mode, so it gets the
 * delete followed by a sync, and only for a resync from scratch: it cannot resync in place.
 */
fun resyncSteps(offer: ResyncOffer, mode: ResyncMode): List<ResyncStep> = when {
    offer is ResyncOffer.Choice && mode in offer.modes -> listOf(ResyncStep.Resync(mode))
    offer is ResyncOffer.WipeOnly && mode == ResyncMode.FROM_SCRATCH -> listOf(ResyncStep.DeleteAll, ResyncStep.Sync)
    else -> throw ResyncNotOffered()
}
