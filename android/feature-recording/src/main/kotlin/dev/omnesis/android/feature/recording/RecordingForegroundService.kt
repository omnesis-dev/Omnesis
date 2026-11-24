// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent
import java.io.File
import java.util.Optional
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Records a conversation with the screen off: a foreground service with a
 * persistent notification showing the elapsed time and Pause/Resume/Stop.
 * With the phone's microphone it is of type microphone and only ever started
 * from a visible screen (the platform requires that, and the app never
 * records silently). With a [WearableAudio] input it is of type
 * connectedDevice and may also be started by the wearable's own button; a
 * wearable that drops its link pauses the recording, which resumes when it
 * comes back, or is stopped after [WEARABLE_GONE_MS]. Either stops on its own
 * after [RecordingSettings.MAX_SESSION_MS].
 *
 * A wearable capturing all day ([RecordingSettings.alwaysOn]) records
 * ambient episodes: each closes once the controller finds it
 * [RecordingController.EPISODE_QUIET_MS] without speech (or at the length
 * limit) and the next opens at once. The wearable's button then marks a
 * moment ([RecordingController.markMoment]), whose clip is saved as a note
 * through the [MarkedMomentSink]. Stop on its notification turns all-day
 * capture off. A recording the owner starts takes the episode's place.
 *
 * One recording at a time: a Start while one is starting, running or closing
 * is ignored, unless it replaces an ambient episode, and a Stop during a
 * start runs once the start settles. Every method runs on the main thread;
 * the outbox writes go to the controller's queue.
 */
class RecordingForegroundService : Service() {

    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface Deps {
        fun recordingController(): RecordingController
        fun wearableAudio(): Optional<WearableAudio>
        fun markedMoments(): Optional<MarkedMomentSink>
        fun recordingSettings(): RecordingSettings
    }

    /** A start waiting for the recording before it to be filed. */
    private data class PendingStart(val title: String?, val input: RecordingInput, val ambient: Boolean)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var controller: RecordingController
    private var wearable: WearableAudio? = null
    private var markedMoments: MarkedMomentSink? = null
    private lateinit var settings: RecordingSettings
    private var recorder: ChunkRecorder? = null
    private var input = RecordingInput.PHONE
    /** The running session is an ambient episode of all-day capture. */
    private var ambient = false
    /** What to start once the recording being stopped is filed. */
    private var pendingStart: PendingStart? = null
    /** Waits for a lost wearable to come back and resumes, or gives the recording up. */
    private var reconnect: WearableReconnect? = null
    private var sessionId: String? = null
    /** A start is opening the session and the microphone. */
    private var starting = false
    /** A Stop arrived during the start; it runs once the start settles. */
    private var stopWhenStarted = false
    /** The recorder stopped and the session's close is being filed. */
    private var stopping = false
    private val maxLength = Runnable { if (ambient) nextEpisode() else stopRecording() }
    private val handler by lazy { android.os.Handler(mainLooper) }

    override fun onCreate() {
        super.onCreate()
        val deps = EntryPointAccessors.fromApplication(applicationContext, Deps::class.java)
        controller = deps.recordingController()
        wearable = deps.wearableAudio().orElse(null)
        markedMoments = deps.markedMoments().orElse(null)
        settings = deps.recordingSettings()
        scope.launch {
            controller.episodesOver.collect { id -> if (ambient && id == sessionId) nextEpisode() }
        }
        reconnect = wearable?.let { source ->
            WearableReconnect(
                ready = source.ready,
                scope = scope,
                goneAfterMs = WEARABLE_GONE_MS,
                // Resume only a pause the link caused, never one the user chose meanwhile.
                pausedByLoss = { (controller.state.value as? RecordingState.Active)?.micLost == true },
                resume = ::resumeRecording,
                giveUp = {
                    Log.w(TAG, "The wearable did not come back; stopping")
                    stopRecording()
                },
            )
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startRecording(
                intent.getStringExtra(EXTRA_TITLE),
                intent.getStringExtra(EXTRA_INPUT)?.let { runCatching { RecordingInput.valueOf(it) }.getOrNull() } ?: RecordingInput.PHONE,
                intent.getBooleanExtra(EXTRA_AMBIENT, false),
            )
            ACTION_PAUSE -> pauseRecording()
            ACTION_RESUME -> resumeRecording()
            ACTION_STOP -> {
                // Stopping an episode would only see the next one open: it turns all-day capture off.
                if (ambient) settings.setAlwaysOn(false)
                stopRecording()
            }
            // Restarted by the system without an intent: the recording it held is gone.
            else -> if (recorder == null && !starting && !stopping) stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun startRecording(title: String?, requested: RecordingInput, requestedAmbient: Boolean = false) {
        ensureChannel(this)
        val busy = recorder != null || starting || stopping
        if (!busy) {
            input = requested
            ambient = requestedAmbient && requested == RecordingInput.WEARABLE
        }
        // Every start command must reach the foreground, even one that is ignored.
        val foreground = startInForeground(currentNotification())
        if (busy) {
            // A recording the owner starts takes the place of an ambient episode.
            if (ambient && !requestedAmbient && recorder != null && !stopping) {
                pendingStart = PendingStart(title, requested, ambient = false)
                stopRecording()
            } else if (stopping && !requestedAmbient && pendingStart?.ambient == true) {
                // Between two episodes: the owner's recording opens instead of the next one.
                pendingStart = PendingStart(title, requested, ambient = false)
            }
            return
        }
        if (!foreground) {
            stopSelf()
            return
        }
        val source = wearable
        if (input == RecordingInput.WEARABLE && (source == null || !source.ready.value)) {
            Log.w(TAG, "The wearable is not linked; recording not started")
            stopSelfCleanly()
            return
        }
        starting = true
        val id = UUID.randomUUID().toString()
        scope.launch {
            val active = try {
                controller.begin(title, id, input, ambient)
            } catch (e: CancellationException) {
                // The service is going away mid-start; the queue still opens the session.
                controller.discard(id)
                throw e
            }
            starting = false
            if (active == null) {
                Log.w(TAG, "A recording is still closing; not started")
                if (recorder == null && !stopping) stopSelfCleanly()
                return@launch
            }
            val r: ChunkRecorder = when (input) {
                RecordingInput.PHONE -> ChunkedAudioRecorder(
                    context = this@RecordingForegroundService,
                    directory = controller.directoryFor(id),
                    onChunk = { chunk -> controller.chunkClosed(id, chunk) },
                    onMicrophoneLost = ::onMicrophoneLost,
                )
                RecordingInput.WEARABLE -> FrameAudioRecorder(
                    directory = controller.directoryFor(id),
                    input = source!!,
                    onChunk = { chunk -> controller.chunkClosed(id, chunk) },
                    onInputLost = ::onWearableLost,
                    clipper = if (ambient) clipperFor(id) else null,
                )
            }
            if (!r.start()) {
                Log.w(TAG, "$input input unavailable; recording not started")
                r.stop()
                controller.discard(id)
                stopWhenStarted = false
                stopSelfCleanly()
                return@launch
            }
            recorder = r
            sessionId = id
            if (r is FrameAudioRecorder && ambient) controller.setMarker(r::markMoment)
            handler.postDelayed(maxLength, RecordingSettings.MAX_SESSION_MS)
            if (stopWhenStarted) {
                stopWhenStarted = false
                stopRecording()
            }
        }
    }

    /** Cuts marked moments out of episode [sessionId] and saves each as a note. */
    private fun clipperFor(sessionId: String): MomentClipper {
        val dir = File(noBackupFilesDir, CLIPS_DIR)
        return MomentClipper(
            newFile = { dir.mkdirs(); File(dir, "moment-${UUID.randomUUID()}.m4a") },
            encoders = PcmChunkEncoderFactory(::MediaCodecAacChunkEncoder),
            detectors = {
                SileroSpeechDetector { assets.open(SileroSpeechDetector.MODEL_ASSET).use { it.readBytes() } }
            },
            onClip = { clip ->
                val sink = markedMoments
                if (sink == null) {
                    clip.file.delete()
                } else {
                    // The note outlives this service: saving it is not tied to the service's scope.
                    MARK_SCOPE.launch {
                        try {
                            sink.save(clip, sessionId)
                        } catch (e: Exception) {
                            Log.w(TAG, "Could not save a marked moment: ${e.message}")
                            clip.file.delete()
                        }
                    }
                }
            },
        )
    }

    /** Close the ambient episode and open the next at once. */
    private fun nextEpisode() {
        if (!ambient || recorder == null || stopping) return
        Log.i(TAG, "Ambient episode over; opening the next")
        pendingStart = PendingStart(null, RecordingInput.WEARABLE, ambient = true)
        stopRecording()
    }

    private fun pauseRecording() {
        val r = recorder ?: return
        reconnect?.cancel()
        if (!r.isRecording) {
            // Paused by a lost input: the user's pause makes it theirs.
            controller.onPaused()
            refreshNotification()
            return
        }
        r.pause()
        controller.onPaused()
        refreshNotification()
    }

    private fun resumeRecording() {
        val r = recorder ?: return
        if (r.isRecording) return
        if (r.start()) {
            reconnect?.cancel()
            controller.onResumed()
        } else {
            controller.onPaused(micLost = true)
            if (input == RecordingInput.WEARABLE) reconnect?.await()
        }
        refreshNotification()
    }

    /** The wearable's link dropped mid-recording: pause, and resume once it is back. */
    private fun onWearableLost() {
        if (recorder == null) return
        controller.onPaused(micLost = true)
        refreshNotification()
        reconnect?.await()
    }

    /** The recorder could not reopen the microphone at a chunk boundary: show it paused. */
    private fun onMicrophoneLost() {
        controller.onPaused(micLost = true)
        refreshNotification()
    }

    private fun stopRecording() {
        if (starting) {
            stopWhenStarted = true
            return
        }
        val r = recorder ?: run {
            if (!stopping) stopSelfCleanly()
            return
        }
        val id = sessionId ?: return
        recorder = null
        sessionId = null
        stopping = true
        controller.setMarker(null)
        handler.removeCallbacks(maxLength)
        reconnect?.cancel()
        r.stop()
        // Every chunk the recorder reported is filed before the session closes.
        controller.stopped(id, r.chunksRecorded) { scope.launch { afterStop() } }
    }

    /** The stopped recording is filed: start what waited for it, or go. */
    private fun afterStop() {
        stopping = false
        val next = pendingStart
        pendingStart = null
        if (next != null) startRecording(next.title, next.input, next.ambient) else stopSelfCleanly()
    }

    private fun stopSelfCleanly() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        val r = recorder
        val id = sessionId
        if (r != null && id != null) {
            // Destroyed while recording (the system reclaimed us): keep what was recorded.
            recorder = null
            sessionId = null
            controller.setMarker(null)
            r.stop()
            controller.stopped(id, r.chunksRecorded)
        }
        handler.removeCallbacks(maxLength)
        reconnect?.cancel()
        scope.cancel()
        super.onDestroy()
    }

    private fun refreshNotification() {
        if (controller.state.value !is RecordingState.Active) return
        getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION_ID, currentNotification())
    }

    private fun currentNotification(): Notification {
        val active = controller.state.value as? RecordingState.Active
            ?: return notification(paused = false, micLost = false, elapsedMs = 0)
        return notification(active.paused, active.micLost, active.elapsedMs(System.currentTimeMillis()))
    }

    /**
     * False when the platform refuses the foreground here: a start from the
     * background without the exemptions the type needs (a wearable whose
     * association was removed, a microphone start with no screen showing).
     */
    private fun startInForeground(notification: Notification): Boolean {
        val type = if (input == RecordingInput.WEARABLE && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        } else {
            0
        }
        return try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
            true
        } catch (e: RuntimeException) {
            Log.w(TAG, "Not allowed to record in the foreground now: ${e.message}")
            false
        }
    }

    private fun notification(paused: Boolean, micLost: Boolean, elapsedMs: Long): Notification {
        val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_recording_mic)
            .setContentTitle(
                when {
                    paused -> "Recording paused"
                    ambient -> "Capturing conversations"
                    else -> "Recording conversation"
                },
            )
            .setContentText(
                when {
                    micLost && input == RecordingInput.WEARABLE -> "The ${inputName()} is not connected. Recording resumes when it is back"
                    micLost -> "The microphone is in use elsewhere. Tap Resume to try again"
                    paused -> "Tap Resume to continue"
                    ambient -> "Omnesis keeps what the ${inputName()} hears. Tap the ${inputName()} to mark a moment"
                    else -> "Omnesis is recording with the ${inputName()}"
                },
            )
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(open)
        if (!paused) {
            builder.setUsesChronometer(true).setWhen(System.currentTimeMillis() - elapsedMs).setShowWhen(true)
            builder.addAction(0, "Pause", actionIntent(ACTION_PAUSE))
        } else {
            builder.setShowWhen(false)
            builder.addAction(0, "Resume", actionIntent(ACTION_RESUME))
        }
        builder.addAction(0, if (ambient) "Turn off" else "Stop", actionIntent(ACTION_STOP))
        return builder.build()
    }

    private fun inputName(): String = if (input == RecordingInput.WEARABLE) wearable?.name ?: "wearable" else "microphone"

    private fun actionIntent(action: String): PendingIntent =
        PendingIntent.getService(
            this,
            action.hashCode(),
            Intent(this, RecordingForegroundService::class.java).setAction(action),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

    companion object {
        private const val TAG = "Omnesis:Recording"
        const val CHANNEL_ID = "omnesis_recording"
        private const val NOTIFICATION_ID = 0x7EC0
        const val ACTION_START = "dev.omnesis.android.recording.START"
        const val ACTION_PAUSE = "dev.omnesis.android.recording.PAUSE"
        const val ACTION_RESUME = "dev.omnesis.android.recording.RESUME"
        const val ACTION_STOP = "dev.omnesis.android.recording.STOP"
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_INPUT = "input"
        private const val EXTRA_AMBIENT = "ambient"
        private const val CLIPS_DIR = "marked-moments"
        private val MARK_SCOPE = CoroutineScope(SupervisorJob() + Dispatchers.IO)

        /** How long a wearable may stay unlinked before its recording is stopped and filed. */
        const val WEARABLE_GONE_MS = 10 * 60 * 1000L

        /**
         * Start recording. With [RecordingInput.PHONE], call only from a
         * visible screen, after RECORD_AUDIO is granted; a wearable may be
         * started by its own button.
         */
        fun start(context: Context, title: String?, input: RecordingInput = RecordingInput.PHONE) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, RecordingForegroundService::class.java)
                    .setAction(ACTION_START)
                    .putExtra(EXTRA_TITLE, title)
                    .putExtra(EXTRA_INPUT, input.name),
            )
        }

        /** Start all-day capture with the wearable: ambient episodes, one after another. */
        fun startAmbient(context: Context) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, RecordingForegroundService::class.java)
                    .setAction(ACTION_START)
                    .putExtra(EXTRA_INPUT, RecordingInput.WEARABLE.name)
                    .putExtra(EXTRA_AMBIENT, true),
            )
        }

        fun send(context: Context, action: String) {
            context.startService(Intent(context, RecordingForegroundService::class.java).setAction(action))
        }

        /**
         * Low importance: the notification is a standing indicator, not an
         * alert. A channel's importance cannot be lowered after creation, so
         * it starts low.
         */
        fun ensureChannel(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val manager = context.getSystemService(NotificationManager::class.java) ?: return
            if (manager.getNotificationChannel(CHANNEL_ID) != null) return
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Conversation recording", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Shown while Omnesis records a conversation"
                    setShowBadge(false)
                },
            )
        }
    }
}
