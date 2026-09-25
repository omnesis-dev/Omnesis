// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos

import android.app.job.JobScheduler
import android.content.Context
import android.provider.MediaStore
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.WorkManager
import androidx.work.WorkInfo
import androidx.work.testing.WorkManagerTestInitHelper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.Before
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PhotosMediaObserverJobServiceTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val scheduler = context.getSystemService(JobScheduler::class.java)

    @Before fun setUp() {
        WorkManagerTestInitHelper.initializeTestWorkManager(context, Configuration.Builder().build())
    }

    @Test
    fun `observer registration watches MediaStore without replacing itself before durable handoff`() {
        val jobId = PhotosMediaObserverJobService.JOB_ID
        PhotosMediaObserverJobService.install(context)
        val original = scheduler.getPendingJob(jobId)
        assertNotNull(original)
        assertEquals(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            original?.triggerContentUris?.single()?.uri,
        )
        PhotosMediaObserverJobService.queueTriggeredSync(context).result.get()
        // Scheduling the same ID here would stop the active JobService before
        // WorkManager's enqueue acknowledgment. The callback owns re-arming.
        assertEquals(original, scheduler.getPendingJob(jobId))
    }

    @Test
    fun `disabling photos cancels the observer and its queued drains`() {
        PhotosMediaObserverJobService.install(context)
        PhotosMediaObserverJobService.queueTriggeredSync(context).result.get()
        assertEquals(1, queuedWorkCount())

        PhotosMediaObserverJobService.uninstall(context)

        assertNull(scheduler.getPendingJob(PhotosMediaObserverJobService.JOB_ID))
    }

    @Test
    fun `successive notifications enqueue serial drains even if the first is unfinished`() {
        PhotosMediaObserverJobService.install(context)
        PhotosMediaObserverJobService.queueTriggeredSync(context).result.get()
        assertEquals(1, queuedWorkCount())
        val firstDrainIds = queuedWorkIds().toSet()

        PhotosMediaObserverJobService.queueTriggeredSync(context).result.get()
        assertTrue(queuedWorkIds().any { it !in firstDrainIds })
        val work = WorkManager.getInstance(context)
            .getWorkInfosForUniqueWork(PhotosMediaObserverJobService.TRIGGERED_WORK_NAME).get()
        assertEquals(2, work.size)
        assertTrue("states=${work.map { it.state }}", work.any { it.state == WorkInfo.State.BLOCKED })
    }

    private fun queuedWorkCount(): Int = queuedWorkIds().size

    private fun queuedWorkIds() = WorkManager.getInstance(context)
        .getWorkInfosByTag(PhotosMediaObserverJobService.TRIGGERED_WORK_TAG)
        .get().map { it.id }
}
