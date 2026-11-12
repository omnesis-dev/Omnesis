// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import android.app.Application
import android.content.Context
import dev.omnesis.android.wear.core.WatchCore
import dev.omnesis.android.wear.core.WatchDevice
import dev.omnesis.android.wear.device.ActivityPresence
import dev.omnesis.android.wear.device.AndroidSpeechEngine
import dev.omnesis.android.wear.device.MediaAudioRecorder
import dev.omnesis.android.wear.device.MicPermissionGate
import dev.omnesis.android.wear.device.SystemEnvironment
import dev.omnesis.android.wear.device.VibratorHaptics
import dev.omnesis.android.wear.device.WorkManagerRetryScheduler
import dev.omnesis.android.wear.link.GmsPhoneLink
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.io.File

class WearApp : Application() {
    val container: WearContainer by lazy { WearContainer(this) }

    override fun onCreate() {
        super.onCreate()
        container.onMain { launched() }
    }
}

/**
 * The app's one object graph: the watch logic and the device services it
 * runs on. Process-wide, because the phone's messages arrive in a service
 * whether or not a screen exists.
 */
class WearContainer(context: Context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    val permission = MicPermissionGate(context)
    val presence = ActivityPresence(context)
    val haptics = VibratorHaptics(context)

    val core = WatchCore(
        WatchDevice(
            link = GmsPhoneLink(context, WearLog),
            recorder = MediaAudioRecorder(context),
            permission = permission,
            speech = AndroidSpeechEngine(context),
            haptics = haptics,
            screen = presence,
            retry = WorkManagerRetryScheduler(context, SystemEnvironment::now),
            environment = SystemEnvironment,
            log = WearLog,
            storage = File(context.noBackupFilesDir, "watch-relay"),
        ),
        scope,
    )

    /** Run [action] against the watch logic on the main thread, which owns it. */
    fun onMain(action: WatchCore.() -> Unit) {
        scope.launch { core.action() }
    }
}
