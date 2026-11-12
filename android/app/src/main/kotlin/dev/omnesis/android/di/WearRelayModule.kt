// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.di

import android.content.Context
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import dev.omnesis.android.assistant.VoiceAskRunner
import dev.omnesis.android.notes.NotesRepository
import dev.omnesis.android.notes.VoiceNoteFiles
import dev.omnesis.android.notifications.FcmPushManager
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.voice.SpeechVocabulary
import dev.omnesis.android.wear.GatePublisher
import dev.omnesis.android.wear.HandledRefs
import dev.omnesis.android.wear.OnDeviceFileTranscriber
import dev.omnesis.android.wear.PlayServicesWearGateway
import dev.omnesis.android.wear.PreferencesRelayStateStore
import dev.omnesis.android.wear.QueuedRelayHandler
import dev.omnesis.android.wear.RecordingInbox
import dev.omnesis.android.wear.RecordingPipeline
import dev.omnesis.android.wear.RelayStateStore
import dev.omnesis.android.wear.RepositoryWatchNoteSaver
import dev.omnesis.android.wear.RunnerWatchAsker
import dev.omnesis.android.wear.SessionCaptureBackend
import dev.omnesis.android.wear.SystemRelayNotifier
import dev.omnesis.android.wear.TextAskRelay
import dev.omnesis.android.wear.TextNoteRelay
import dev.omnesis.android.wear.WearGateway
import dev.omnesis.android.wear.WearRelay
import dev.omnesis.android.wear.WearRelayScope
import dev.omnesis.android.wear.WorkManagerRelayScheduler
import dev.omnesis.android.wear.gateKnowledge
import java.io.File
import javax.inject.Singleton
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/** The watch relay: pure orchestrators wired to the Data Layer, the gateway session and the note pipeline. */
@Module
@InstallIn(SingletonComponent::class)
object WearRelayModule {

    /** Relay work outlives the service callback that starts it, so it runs in a scope the app owns. */
    @Provides
    @Singleton
    @WearRelayScope
    fun provideRelayScope(): CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Provides
    @Singleton
    fun providePlayServicesWearGateway(@ApplicationContext context: Context): PlayServicesWearGateway =
        PlayServicesWearGateway(context)

    @Provides
    fun provideWearGateway(gateway: PlayServicesWearGateway): WearGateway = gateway

    @Provides
    @Singleton
    fun provideRelayStateStore(@ApplicationContext context: Context): RelayStateStore =
        PreferencesRelayStateStore(context)

    @Provides
    @Singleton
    fun provideOnDeviceFileTranscriber(
        @ApplicationContext context: Context,
        vocabulary: SpeechVocabulary,
    ): OnDeviceFileTranscriber = OnDeviceFileTranscriber(context, vocabulary)

    @Provides
    @Singleton
    fun provideWearRelay(
        @ApplicationContext context: Context,
        @WearRelayScope scope: CoroutineScope,
        gateway: WearGateway,
        store: RelayStateStore,
        sessions: SessionManager,
        runner: VoiceAskRunner,
        notesRepository: NotesRepository,
        voiceNoteFiles: VoiceNoteFiles,
        transcriber: OnDeviceFileTranscriber,
        push: FcmPushManager,
    ): WearRelay {
        val clock = System::currentTimeMillis
        val handled = HandledRefs(store)
        val asker = RunnerWatchAsker(runner)
        val notes = RepositoryWatchNoteSaver(notesRepository, voiceNoteFiles)
        val notifier = SystemRelayNotifier(push)
        val scheduler = WorkManagerRelayScheduler(context)
        return WearRelay(
            scope = scope,
            gateway = gateway,
            gate = GatePublisher(gateway, store, clock),
            asks = TextAskRelay(gateway, asker, handled),
            notes = TextNoteRelay(notes, handled),
            queued = QueuedRelayHandler(gateway, asker, notes, handled, notifier, clock),
            recordings = RecordingPipeline(
                // No-backup storage: the person's voice never goes to a cloud backup.
                inbox = RecordingInbox(File(context.noBackupFilesDir, "watch-recordings"), clock),
                gateway = gateway,
                backend = SessionCaptureBackend(sessions),
                transcriber = transcriber,
                notes = notes,
                asker = asker,
                notifier = notifier,
                retry = scheduler,
                now = clock,
            ),
            state = store,
            keepAlive = scheduler,
            knowledge = { gateKnowledge(sessions) },
        )
    }
}
