// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.briefs

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.transport.dto.BriefDismissReasonDto
import dev.omnesis.android.transport.dto.BriefPageDto
import dev.omnesis.android.transport.dto.BriefRecordDto
import dev.omnesis.android.transport.dto.OpenBriefThreadDto
import dev.omnesis.android.ui.capture.joinUtterances
import dev.omnesis.android.ui.voice.DictationFailureNotice
import dev.omnesis.android.ui.voice.VoiceRecording
import dev.omnesis.android.voice.Endpointing
import dev.omnesis.android.voice.VoiceInput
import dev.omnesis.android.voice.VoiceInputEnd
import dev.omnesis.android.voice.VoiceInputs
import dev.omnesis.android.ui.common.CursorPagingState
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class BriefsUiState(
    val loading: Boolean = true,
    val feed: BriefsFeedState = BriefsFeedState(),
    val loadError: Throwable? = null,
    val paging: CursorPagingState = CursorPagingState(),
    /** Set when a dismiss failed and the row was put back, so the screen can say so. */
    val dismissError: String? = null,
    /** The brief whose talk-back thread is being opened, if any. */
    val openingThreadBriefId: String? = null,
    val threadError: String? = null,
    /** The brief whose row is currently the recording strip; null when the mic is idle. */
    val dictatingBriefId: String? = null,
    /** Committed utterances plus the in-flight partial, as the strip displays them. */
    val dictationText: String = "",
    val dictationPartial: String = "",
    /** Set when the mic cannot run at all, so the strip can say why instead of hanging. */
    val dictationUnavailable: String? = null,
    /** A gateway dictation's recording, transcription or failure; empty for the phone's recognizer. */
    val dictationProgress: BriefDictationProgress = BriefDictationProgress(),
) {
    /** What the strip shows: everything heard so far, including the in-flight guess. */
    val dictationDisplayText: String
        get() = joinUtterances(dictationText, dictationPartial)
}

/** Where a gateway dictation at a brief stands: at most one field is set. */
data class BriefDictationProgress(
    /** Recording for the gateway's transcriber. */
    val recording: VoiceRecording? = null,
    /** The recording is with the gateway; the words, and the send, follow. */
    val transcribing: Boolean = false,
    val failure: DictationFailureNotice? = null,
)

/** Generation token preventing a cancelled thread request from navigating on a late reply. */
internal class BriefThreadRequestGate {
    private var generation = 0L

    fun start(): Long = ++generation
    fun owns(request: Long): Boolean = request == generation
    fun runIfCurrent(request: Long, action: () -> Unit): Boolean {
        if (!owns(request)) return false
        action()
        return true
    }
    fun invalidate() {
        generation++
    }
}

/** Narrow transport boundary so feed and microphone lifecycle can be tested together. */
internal interface BriefsGateway {
    suspend fun feed(cursor: String? = null): BriefPageDto
    suspend fun markRead(briefId: String)
    suspend fun dismiss(
        briefId: String,
        reason: BriefDismissReasonDto,
        feedback: String?,
        snoozeUntil: String?,
    )
    suspend fun openThread(briefId: String): OpenBriefThreadDto
}

private class SessionBriefsGateway(private val session: SessionManager) : BriefsGateway {
    override suspend fun feed(cursor: String?): BriefPageDto =
        session.requireSession().briefs.feed(cursor = cursor)

    override suspend fun markRead(briefId: String) =
        session.requireSession().briefs.markRead(briefId)

    override suspend fun dismiss(
        briefId: String,
        reason: BriefDismissReasonDto,
        feedback: String?,
        snoozeUntil: String?,
    ) = session.requireSession().briefs.dismiss(briefId, reason, feedback, snoozeUntil)

    override suspend fun openThread(briefId: String): OpenBriefThreadDto =
        session.requireSession().briefs.openThread(briefId)
}

/**
 * The Briefs feed. Fetched on first appearance and by pull-to-refresh — briefs already
 * exist server-side, maintained by the Cognition Steward, so there is nothing to push.
 *
 * Every route 404s unless the gateway reports the feature active, which is why the menu
 * entry is gated too: a screen that could only ever say "not found" is worse than no
 * screen at all.
 */
@HiltViewModel
class BriefsViewModel internal constructor(
    private val voiceInputs: VoiceInputs,
    private val sourceCatalog: SourceCatalog,
    private val gateway: BriefsGateway,
) : ViewModel() {
    @Inject constructor(
        session: SessionManager,
        voiceInputs: VoiceInputs,
        sourceCatalog: SourceCatalog,
    ) : this(voiceInputs, sourceCatalog, SessionBriefsGateway(session))

    private val _state = MutableStateFlow(BriefsUiState())
    val state = _state.asStateFlow()
    private val threadRequestGate = BriefThreadRequestGate()
    private var openThreadJob: Job? = null

    init {
        load()
        voiceInputs.refreshStatus(viewModelScope)
    }

    /** Generic gateway-declared source art for brief citations. */
    fun iconFor(sourceId: String): SourceIconModel = sourceCatalog.iconModel(sourceId)

    /**
     * Fetch the first page. [showLoadingIndicator] is false for pull-to-refresh, where
     * the native spinner is the only cue and the current content should stay put.
     */
    fun load(showLoadingIndicator: Boolean = true) {
        val started = _state.value.paging.beginRefresh()
        _state.value = _state.value.copy(
            loading = showLoadingIndicator,
            loadError = null,
            paging = started.state,
        )
        viewModelScope.launch {
            try {
                val page = gateway.feed()
                // `owns` is what makes a slow first request harmless: if a refresh has
                // started since, this reply belongs to a generation nobody is waiting on.
                if (!_state.value.paging.owns(started.request)) return@launch
                val before = _state.value
                val replacement = replaceBriefFeed(
                    current = before.feed,
                    incoming = page.briefs,
                    dictatingBriefId = before.dictatingBriefId,
                )
                if (before.dictatingBriefId != null && replacement.discardedDictation) {
                    releaseVoice()
                    buffer = DictationBuffer()
                }
                _state.value = before.copy(
                    loading = false,
                    loadError = null,
                    feed = replacement.feed,
                    paging = before.paging.finishRefresh(started.request, page.nextCursor),
                    dictatingBriefId = replacement.retainedDictatingBriefId,
                    dictationText = if (replacement.discardedDictation) "" else before.dictationText,
                    dictationPartial = if (replacement.discardedDictation) "" else before.dictationPartial,
                    dictationProgress = if (replacement.discardedDictation) {
                        BriefDictationProgress()
                    } else {
                        before.dictationProgress
                    },
                )
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                _state.value = _state.value.copy(
                    loading = false,
                    loadError = error,
                    paging = _state.value.paging.failRefresh(started.request, error),
                )
            }
        }
    }

    fun loadMore() {
        val started = _state.value.paging.beginLoadMore() ?: return
        _state.value = _state.value.copy(paging = started.state)
        viewModelScope.launch {
            try {
                val page = gateway.feed(cursor = started.request.cursor)
                val before = _state.value.feed.briefs.size
                val grown = _state.value.feed.appending(page.briefs)
                _state.value = _state.value.copy(
                    feed = grown,
                    paging = _state.value.paging.finishLoadMore(
                        started.request,
                        page.nextCursor,
                        // A page of ids we already hold is not progress: paging stops
                        // rather than spinning on a cursor that never advances.
                        madeProgress = grown.briefs.size > before,
                    ),
                )
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                _state.value = _state.value.copy(
                    paging = _state.value.paging.failLoadMore(started.request, error),
                )
            }
        }
    }

    /**
     * Mark a brief seen. Fire-and-forget: read-marking is bookkeeping that only affects
     * sort order on a future visit, so a failure never interrupts reading.
     */
    fun markViewed(brief: BriefRecordDto) {
        val next = _state.value.feed.markingViewed(brief.id) ?: return
        _state.value = _state.value.copy(feed = next)
        viewModelScope.launch {
            runCatching { gateway.markRead(brief.id) }
        }
    }

    /**
     * Clear a brief. The row leaves immediately — the feed is a triage surface and a
     * cleared brief should stop occupying it — and goes back where it was if the gateway
     * refuses.
     */
    fun dismiss(
        brief: BriefRecordDto,
        reason: BriefDismissReasonDto,
        feedback: String? = null,
        snoozeUntil: String? = null,
    ) {
        val removed = _state.value.feed.removing(brief.id)
        if (removed != null) {
            _state.value = _state.value.copy(feed = removed.first, dismissError = null)
        }
        viewModelScope.launch {
            try {
                gateway.dismiss(brief.id, reason, feedback, snoozeUntil)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                _state.value = _state.value.copy(
                    feed = removed?.second?.let { _state.value.feed.restoring(it) } ?: _state.value.feed,
                    dismissError = error.message ?: "Couldn't clear that brief",
                )
            }
        }
    }

    fun clearDismissError() {
        _state.value = _state.value.copy(dismissError = null)
    }

    fun clearThreadError() {
        _state.value = _state.value.copy(threadError = null)
    }

    /**
     * Open the brief's talk-back thread and hand the conversation id back, so the caller
     * can bring the agent surface forward and resume it.
     */
    fun openThread(brief: BriefRecordDto, onOpened: (String) -> Unit) {
        if (_state.value.openingThreadBriefId != null) return
        val request = threadRequestGate.start()
        _state.value = _state.value.copy(openingThreadBriefId = brief.id, threadError = null)
        openThreadJob = viewModelScope.launch {
            try {
                val result = gateway.openThread(brief.id)
                threadRequestGate.runIfCurrent(request) {
                    _state.value = _state.value.copy(openingThreadBriefId = null)
                    onOpened(result.conversationId)
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                threadRequestGate.runIfCurrent(request) {
                    _state.value = _state.value.copy(
                        openingThreadBriefId = null,
                        threadError = error.message ?: "Couldn't open that thread",
                    )
                }
            } finally {
                if (threadRequestGate.owns(request)) openThreadJob = null
            }
        }
    }

    /** Cancel a detail-owned request so closing its sheet cannot navigate on a late reply. */
    fun cancelOpenThread(briefId: String? = null) {
        val openingId = _state.value.openingThreadBriefId
        if (briefId != null && openingId != briefId) return
        if (openingId == null) return
        threadRequestGate.invalidate()
        openThreadJob?.cancel()
        openThreadJob = null
        _state.value = _state.value.copy(openingThreadBriefId = null)
    }

    // --- Dictation -------------------------------------------------------------

    /** The running dictation, or a failed gateway one whose recording awaits a retry. */
    private var voice: VoiceInput? = null

    /** Where a gateway transcript goes once it arrives: the stop-and-send it was stopped for. */
    private var pendingSend: ((conversationId: String, spoken: String) -> Unit)? = null

    /** The words heard so far, kept in the shape [DictationBuffer] defines the rules for. */
    private var buffer = DictationBuffer()

    /** Start dictating at a brief: its row becomes the recording strip. */
    fun startDictation(brief: BriefRecordDto) = beginDictation(brief.id, voiceInputs.preferred(viewModelScope))

    /** After a failed gateway transcription: dictate to the same brief on the phone's recognizer. */
    fun dictateOnDevice() {
        val briefId = _state.value.dictatingBriefId ?: return
        beginDictation(briefId, voiceInputs.onDevice())
    }

    private fun beginDictation(briefId: String, input: VoiceInput) {
        releaseVoice()
        buffer = DictationBuffer()
        if (!input.isAvailable()) {
            _state.value = _state.value.copy(
                dictatingBriefId = null,
                dictationText = "",
                dictationPartial = "",
                dictationProgress = BriefDictationProgress(),
                dictationUnavailable = "Dictation isn't available on this device.",
            )
            return
        }
        voice = input
        _state.value = _state.value.copy(
            dictatingBriefId = briefId,
            dictationText = "",
            dictationPartial = "",
            dictationProgress = BriefDictationProgress(),
            dictationUnavailable = null,
        )
        input.start(Endpointing.MANUAL, listenerFor(input))
    }

    /**
     * The user finished speaking. What was heard goes to the brief's thread as its first
     * message: at once from the phone's recognizer, which already showed the words, or
     * once the gateway has transcribed the recording.
     *
     * Nothing is sent for an empty transcript — a tap that caught no words should leave
     * the feed exactly as it was, not open a thread saying nothing.
     */
    fun stopDictationAndSend(onOpened: (conversationId: String, spoken: String) -> Unit) {
        val current = _state.value
        val briefId = current.dictatingBriefId ?: return
        val progress = current.dictationProgress
        if (progress.transcribing || progress.failure != null) return
        if (progress.recording != null) {
            pendingSend = onOpened
            voice?.stop()
            return
        }
        val text = current.dictationDisplayText.trim()
        releaseVoice()
        clearDictation()
        send(briefId, text, onOpened)
    }

    /** Sends the kept recording to the gateway again; the thread opens when it succeeds. */
    fun retryTranscription() {
        if (_state.value.dictationProgress.failure?.canRetry != true) return
        _state.value = _state.value.copy(dictationProgress = BriefDictationProgress())
        voice?.retry()
    }

    /**
     * Abandon a recording without sending — leaving the section, or opening another
     * brief. Releases the mic rather than leaving a live session with no owner.
     */
    fun discardDictation() {
        if (_state.value.dictatingBriefId == null) return
        releaseVoice()
        clearDictation()
    }

    fun clearDictationUnavailable() {
        _state.value = _state.value.copy(dictationUnavailable = null)
    }

    private fun send(briefId: String, text: String, onOpened: (conversationId: String, spoken: String) -> Unit) {
        val brief = _state.value.feed.briefs.firstOrNull { it.id == briefId }
        if (brief == null || text.isEmpty()) return
        // The spoken text rides with the callback rather than being parked in a field:
        // the thread opens asynchronously, and a field would have to be read back at a
        // moment nothing guarantees.
        openThread(brief) { conversationId -> onOpened(conversationId, text) }
    }

    private fun releaseVoice() {
        voice?.cancel()
        voice = null
        pendingSend = null
    }

    private fun clearDictation() {
        buffer = DictationBuffer()
        _state.value = _state.value.copy(
            dictatingBriefId = null,
            dictationText = "",
            dictationPartial = "",
            dictationProgress = BriefDictationProgress(),
        )
    }

    private fun publish(buffer: DictationBuffer) {
        this.buffer = buffer
        _state.value = _state.value.copy(
            dictationText = buffer.committed,
            dictationPartial = buffer.partial,
        )
    }

    private fun listenerFor(input: VoiceInput) = object : VoiceInput.Listener {
        private fun current() = voice === input

        override fun onPartial(text: String) {
            if (current()) publish(buffer.withPartial(text))
        }

        override fun onText(text: String) {
            if (current()) publish(buffer.withFinal(text))
        }

        override fun onRecording(level: Float, elapsedMs: Long) {
            if (!current()) return
            _state.value = _state.value.copy(
                dictationProgress = BriefDictationProgress(recording = VoiceRecording(level, elapsedMs)),
            )
        }

        override fun onTranscribing() {
            if (current()) _state.value = _state.value.copy(dictationProgress = BriefDictationProgress(transcribing = true))
        }

        override fun onEnded(end: VoiceInputEnd) {
            if (!current()) return
            val briefId = _state.value.dictatingBriefId
            val failure = (end as? VoiceInputEnd.Failed)?.failure
            if (failure?.retryable != true) voice = null
            val fatal = when (end) {
                VoiceInputEnd.Denied -> "Microphone access is off for Omnesis."
                VoiceInputEnd.LanguageNotDownloaded -> "Dictation runs on-device; install your language pack to use it."
                VoiceInputEnd.LanguageNotSupported -> "Dictation isn't available for this language."
                VoiceInputEnd.Unavailable -> "Dictation isn't available on this device."
                else -> null
            }
            when {
                // None of these clear by retrying, so say what is wrong rather than
                // holding the strip open while nothing can be heard.
                fatal != null -> {
                    pendingSend = null
                    _state.value = _state.value.copy(
                        dictatingBriefId = null,
                        dictationProgress = BriefDictationProgress(),
                        dictationUnavailable = fatal,
                    )
                }
                failure != null -> _state.value = _state.value.copy(
                    dictationProgress = BriefDictationProgress(
                        failure = DictationFailureNotice.of(failure, voiceInputs.onDeviceAvailable()),
                    ),
                )
                else -> {
                    val onOpened = pendingSend
                    pendingSend = null
                    if (onOpened != null && briefId != null) {
                        val text = buffer.display.trim()
                        clearDictation()
                        send(briefId, text, onOpened)
                    } else {
                        // Ended without a stop-and-send (a recording cap): the words stay on
                        // the strip, and tapping it sends them.
                        _state.value = _state.value.copy(dictationProgress = BriefDictationProgress())
                    }
                }
            }
        }
    }

    override fun onCleared() {
        super.onCleared()
        releaseVoice()
    }
}
