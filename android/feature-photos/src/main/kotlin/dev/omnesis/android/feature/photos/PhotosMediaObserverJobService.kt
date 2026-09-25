// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Log
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.Operation
import androidx.work.WorkManager
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executor

private const val TAG = "Omnesis:photos"

/**
 * The "live" path: a `JobScheduler` content-trigger job that fires — even if
 * the app process is dead — when `MediaStore.Images` changes, re-arms
 * itself, then kicks a prompt sync. This exists SOLELY to promptly pick up
 * new arrivals (a real, valuable low-latency win, the Android analogue of
 * iOS's `PHPhotoLibraryChangeObserver`) — it plays no role in deletion
 * detection, since a content-trigger job carries no delta (it can't say
 * what changed, or whether it was an insert/update/delete); see
 * `PhotosSyncCoordinator.reconcileIfDue`'s doc comment for where deletions
 * are actually handled.
 *
 * Content-trigger jobs are one-shot per registration and best-effort/
 * batchable by the OS (Android may coalesce or delay delivery). [onStartJob]
 * enqueues a one-time drain and keeps the job active until WorkManager has
 * durably accepted it. Only then do we re-arm the same job ID. Android carries
 * changes observed while the job is active into the replacement registration.
 * Drains form a serial, failure-tolerant chain so a second notification cannot
 * join an already-enumerating scan or be lost after an earlier sync failure.
 */
class PhotosMediaObserverJobService : android.app.job.JobService() {

    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface Deps {
        fun photosSettings(): PhotosSettings
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val activeJobs = ConcurrentHashMap<Int, JobParameters>()

    override fun onStartJob(params: JobParameters?): Boolean {
        val currentJobId = requireNotNull(params).jobId
        if (!photosEnabled(applicationContext)) return false

        activeJobs[currentJobId] = params
        return try {
            val operation = queueTriggeredSync(applicationContext)
            operation.result.addListener({
                val error = runCatching { operation.result.get() }.exceptionOrNull()
                if (activeJobs.remove(currentJobId, params)) {
                    if (error != null) {
                        Log.w(TAG, "Could not queue Photos media-change sync: $error")
                        jobFinished(params, true)
                    } else {
                        synchronized(observerLock) {
                            if (!photosEnabled(applicationContext)) {
                                jobFinished(params, false)
                            } else if (!arm(applicationContext)) {
                                jobFinished(params, true)
                            }
                        }
                    }
                }
            }, Executor { command -> mainHandler.post(command) })
            true
        } catch (e: Exception) {
            activeJobs.remove(currentJobId, params)
            Log.w(TAG, "Could not queue Photos media-change sync: $e")
            mainHandler.post { jobFinished(params, true) }
            true
        }
    }

    override fun onStopJob(params: JobParameters?): Boolean {
        params?.let { activeJobs.remove(it.jobId, it) }
        return true
    }

    companion object {
        internal const val JOB_ID = 0x504F544F // "POTO"
        internal const val TRIGGERED_WORK_TAG = "photos-media-change"
        internal const val TRIGGERED_WORK_NAME = "photos-media-change-drain"
        private val observerLock = Any()

        private fun photosEnabled(context: Context): Boolean = runCatching {
            EntryPointAccessors.fromApplication(context, Deps::class.java)
                .photosSettings().photosEnabled
        }.onFailure { Log.w(TAG, "Could not check Photos background-sync state: $it") }
            .getOrDefault(false)

        internal fun queueTriggeredSync(context: Context): Operation {
            return WorkManager.getInstance(context).enqueueUniqueWork(
                TRIGGERED_WORK_NAME,
                ExistingWorkPolicy.APPEND_OR_REPLACE,
                OneTimeWorkRequestBuilder<PhotosSyncWorker>()
                    .addTag(TRIGGERED_WORK_TAG)
                    .build(),
            )
        }

        /** Arms the first content-trigger job when the source is enabled. */
        fun install(context: Context) {
            synchronized(observerLock) {
                val scheduler = context.getSystemService(JobScheduler::class.java) ?: return
                if (scheduler.getPendingJob(JOB_ID) != null) return
                arm(context)
            }
        }

        private fun arm(context: Context): Boolean {
            val scheduler = context.getSystemService(JobScheduler::class.java) ?: return false
            val job = JobInfo.Builder(JOB_ID, ComponentName(context, PhotosMediaObserverJobService::class.java))
                .addTriggerContentUri(
                    JobInfo.TriggerContentUri(
                        MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                        JobInfo.TriggerContentUri.FLAG_NOTIFY_FOR_DESCENDANTS,
                    ),
                )
                .build()
            return scheduler.schedule(job) == JobScheduler.RESULT_SUCCESS
        }

        fun uninstall(context: Context) {
            WorkManager.getInstance(context).cancelAllWorkByTag(TRIGGERED_WORK_TAG)
            synchronized(observerLock) {
                context.getSystemService(JobScheduler::class.java)?.cancel(JOB_ID)
            }
        }
    }
}
