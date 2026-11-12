// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.notes

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException

/**
 * Delivers the offline note queue without the app open: a note captured from the
 * Assistant or the Quick Settings tile while the gateway was unreachable reaches it once
 * the network is back, instead of waiting for the next visit to the app.
 *
 * Plain (non-Hilt) worker: the repository resolves through a Hilt [EntryPoint] against
 * the application component, which also works when WorkManager cold-starts the process
 * with no activity ever created. It is the same singleton the foreground uses, so this
 * drain and a foreground one share its mutex. Delivery is idempotent — every queued note
 * carries its own key — so a run WorkManager repeats or interrupts cannot duplicate one.
 */
class PendingNotesDrainWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface Deps {
        fun notesRepository(): NotesRepository
    }

    override suspend fun doWork(): Result {
        val notes = EntryPointAccessors.fromApplication(applicationContext, Deps::class.java).notesRepository()
        return try {
            resultFor(notes.drain())
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            Log.w(TAG, "Background note drain failed: ${error.javaClass.simpleName}")
            Result.retry()
        }
    }

    internal companion object {
        private const val TAG = "Omnesis:notes"

        /**
         * Only a transient failure is retried with backoff. What a settled drain leaves
         * behind waits on the user, and opening the app drains again.
         */
        fun resultFor(outcome: DrainOutcome): Result = when (outcome) {
            DrainOutcome.SETTLED -> Result.success()
            DrainOutcome.RETRY_LATER -> Result.retry()
        }
    }
}

/** Enqueues the unique one-off [PendingNotesDrainWorker]. */
object PendingNotesDrainScheduler {
    const val UNIQUE_WORK_NAME = "pending-notes-drain"

    /**
     * Asks for a background drain once the device has a network. KEEP: a drain already
     * waiting, backing off or running is the one this request wants, and replacing it
     * would reset its backoff on every queued note. A request that lands in the instant a
     * running drain is finishing is not lost for long — the next foreground drains too.
     */
    fun schedule(context: Context) {
        WorkManager.getInstance(context.applicationContext)
            .enqueueUniqueWork(UNIQUE_WORK_NAME, ExistingWorkPolicy.KEEP, request())
    }

    internal fun request(): OneTimeWorkRequest =
        OneTimeWorkRequestBuilder<PendingNotesDrainWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, INITIAL_BACKOFF_SECONDS, TimeUnit.SECONDS)
            .build()

    private const val INITIAL_BACKOFF_SECONDS = 30L
}
