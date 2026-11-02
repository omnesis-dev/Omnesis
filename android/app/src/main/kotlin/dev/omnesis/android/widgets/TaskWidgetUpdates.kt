// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.widgets

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import dev.omnesis.android.pairing.EncryptedPreferencesStore
import dev.omnesis.android.pairing.PairingService
import java.util.concurrent.TimeUnit

/** Application lifecycle and task mutations publish through this narrow widget entrypoint. */
object TaskWidgetUpdates {
    private val publications = TaskWidgetPublicationGate()
    internal const val TAG = "omnesis-task-widgets"
    private const val PERIODIC = "omnesis-task-widget-periodic"
    private const val REFRESH = "omnesis-task-widget-refresh"

    internal fun pairing(context: Context) = PairingService(EncryptedPreferencesStore(context)).current()
    internal fun ids(context: Context): IntArray = AppWidgetManager.getInstance(context)
        .getAppWidgetIds(ComponentName(context, TasksWidgetProvider::class.java))

    fun pairingChanged(context: Context) {
        val app = context.applicationContext
        val store = TaskWidgetStore(app)
        val authority = runCatching { pairing(app)?.let(TaskWidgetRepository::authority) }.getOrNull()
        if (store.reconcile(authority)) runCatching { TaskWidgetCache(app).clear() }
        renderAll(app)
        if (authority != null && ids(app).isNotEmpty()) refresh(app)
    }

    fun refresh(context: Context) {
        val app = context.applicationContext
        if (ids(app).isEmpty()) return
        ensurePeriodic(app)
        WorkManager.getInstance(app).enqueueUniqueWork(
            REFRESH,
            ExistingWorkPolicy.REPLACE,
            OneTimeWorkRequestBuilder<TaskWidgetWorker>().addTag(TAG).build(),
        )
    }

    internal fun complete(context: Context, id: Int, taskId: String, authority: String) {
        if (taskId.isBlank() || taskId.length > 200 || authority.length != 64) return
        WorkManager.getInstance(context).enqueueUniqueWork(
            "omnesis-task-widget-complete:$authority:$taskId",
            ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<TaskWidgetWorker>()
                .setInputData(workDataOf(TaskWidgetIntents.ID to id, TaskWidgetIntents.TASK to taskId,
                    TaskWidgetIntents.AUTHORITY to authority))
                .addTag(TAG).build(),
        )
    }

    internal fun ensurePeriodic(context: Context) {
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            PERIODIC,
            ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<TaskWidgetWorker>(30, TimeUnit.MINUTES).addTag(TAG).build(),
        )
    }

    internal fun disable(context: Context) {
        WorkManager.getInstance(context).cancelAllWorkByTag(TAG)
        runCatching { TaskWidgetCache(context).clear() }
    }

    internal fun renderAll(context: Context) = publications.publish {
        val manager = AppWidgetManager.getInstance(context)
        val widgets = ids(context)
        if (widgets.isEmpty()) return@publish
        val store = TaskWidgetStore(context)
        val authority = runCatching { pairing(context)?.let(TaskWidgetRepository::authority) }.getOrNull()
        if (store.reconcile(authority)) runCatching { TaskWidgetCache(context).clear() }
        val snapshot = authority?.let { runCatching { TaskWidgetCache(context).read(it) }.getOrNull() }
        val status = if (authority == null) TaskWidgetStatus.UNPAIRED else store.status()
        widgets.forEach { id ->
            manager.updateAppWidget(id, TaskWidgetRenderer.render(
                context, id, store.state(id), snapshot, status, authority, manager.getAppWidgetOptions(id),
            ))
        }
    }
}
