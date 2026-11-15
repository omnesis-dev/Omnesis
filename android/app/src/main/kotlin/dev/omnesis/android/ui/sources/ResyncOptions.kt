// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.sources

import dev.omnesis.android.transport.dto.LabFlags
import dev.omnesis.android.transport.dto.ResyncMode

// The words of a source's Resync sheet. The portal and iOS print the same strings.

/** One mode as the Resync sheet lists it; [note] is a caution shown under the body. */
data class ResyncOption(val mode: ResyncMode, val title: String, val body: String, val note: String?)

object ResyncCopy {
    const val CANCEL = "Cancel"
    const val FOOTNOTE =
        "In place never deletes, so it does not clear duplicate or stray records. From scratch is the tool for that."

    /** The confirmation on a gateway that predates resync modes, where a resync always deletes first. */
    const val WIPE_ONLY_TITLE = "Resync this source?"
    const val WIPE_ONLY_BODY = "This deletes the source's documents and refetches everything from scratch."
    const val WIPE_ONLY_CONFIRM = "Resync"

    fun title(sourceName: String): String = "Resync $sourceName"

    fun confirm(mode: ResyncMode): String = if (mode == ResyncMode.FROM_SCRATCH) "Delete and resync" else "Resync"

    /**
     * The sheet's entry for [mode]. [brainNote] says whether the gateway runs the Brain, so
     * that from scratch says what it does to what the Brain built.
     */
    fun option(mode: ResyncMode, sourceName: String, brainNote: Boolean): ResyncOption = when (mode) {
        ResyncMode.IN_PLACE -> ResyncOption(
            mode = mode,
            title = "In place",
            body = "Reads $sourceName again and updates what is already here. Your records keep their place, " +
                "anything you deleted stays deleted, and search keeps working meanwhile.",
            note = null,
        )
        ResyncMode.FROM_SCRATCH -> ResyncOption(
            mode = mode,
            title = "From scratch",
            body = "Deletes everything indexed from $sourceName, then imports it again. Search for this source " +
                "is empty until it finishes, and items you had deleted one by one come back.",
            note = if (brainNote) "What the Brain built from $sourceName will point at records that no longer exist." else null,
        )
    }

    /** The line under the options: shown when both modes are offered, since it tells them apart. */
    fun footnote(modes: List<ResyncMode>): String? =
        if (ResyncMode.IN_PLACE in modes && ResyncMode.FROM_SCRATCH in modes) FOOTNOTE else null
}

/**
 * Whether a from-scratch resync should say what it does to what the Brain built: only on an
 * experimental gateway with the Brain switched on.
 */
fun resyncBrainNote(experimental: Boolean, lab: LabFlags): Boolean = experimental && lab.brain
