// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.os.Build
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.core.content.ContextCompat
import dev.omnesis.android.ui.capture.PlatformRecognizerFactory
import dev.omnesis.android.ui.capture.RecognizerBackend
import dev.omnesis.android.ui.capture.RecognizerFactory
import dev.omnesis.android.voice.SpeechVocabulary
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.util.Locale
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.resume
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** A recording opened for decoding: its format, known before any sample is read. */
internal interface DecodedAudio : AutoCloseable {
    val sampleRateHz: Int
    val channels: Int

    /** Decodes the whole recording into [out] as 16-bit PCM. Blocks; fails with [IOException] once [out] is closed. */
    fun writeTo(out: OutputStream)
}

/** Opens a recording file for decoding, null when it holds no audio this phone can decode. */
internal fun interface AudioDecoder {
    fun open(file: File): DecodedAudio?
}

/**
 * Transcribes a recording file with the phone's on-device speech recognizer:
 * the transcript of a watch recording when the gateway does not transcribe.
 *
 * Only on-device recognition is used, so a recording the gateway was not asked
 * to hear never goes to a recognition service in the cloud; a language with no
 * on-device model yields nothing. The recognizer reads the recording as an
 * audio source instead of the microphone, which Android offers from version 13;
 * it is decoded from the watch's AAC to PCM as the recognizer reads. The
 * gateway's vocabulary hints are passed only once the recognizer has confirmed
 * the recording's language is installed on the device. Never prompts: it runs
 * in the background, so it works only with the microphone permission the
 * recognizer requires already granted.
 */
class OnDeviceFileTranscriber internal constructor(
    private val vocabulary: SpeechVocabulary,
    private val decoder: AudioDecoder,
    private val recognizers: RecognizerFactory,
    private val microphoneGranted: () -> Boolean,
    private val sdk: Int,
    private val timeout: Duration,
    /** Where the platform recognizer is created and driven: it accepts the main thread only. */
    private val main: CoroutineContext,
) : CaptureTranscriber {
    constructor(context: Context, vocabulary: SpeechVocabulary) : this(
        vocabulary = vocabulary,
        decoder = MediaCodecAudioDecoder,
        recognizers = PlatformRecognizerFactory(context),
        microphoneGranted = {
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
        },
        sdk = Build.VERSION.SDK_INT,
        timeout = TIMEOUT,
        main = Dispatchers.Main.immediate,
    )

    /** Where a recording is written into the recognizer's pipe, apart from the call that waits on the result. */
    private val feeds = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** Why this phone can or cannot transcribe a recording itself. */
    enum class Availability {
        READY,

        /** The recognizer requires the microphone permission, which has not been granted. */
        NEEDS_MICROPHONE,

        /** This Android version or this phone has no on-device recognizer that reads a file. */
        UNSUPPORTED,
    }

    fun availability(): Availability = when {
        sdk < Build.VERSION_CODES.TIRAMISU || !recognizers.onDeviceAvailable() -> Availability.UNSUPPORTED
        !microphoneGranted() -> Availability.NEEDS_MICROPHONE
        else -> Availability.READY
    }

    override suspend fun transcribe(audio: File, locale: String?): String? {
        if (availability() != Availability.READY) return null
        val language = languageTag(locale)
        val decoded = withContext(Dispatchers.IO) { decoder.open(audio) } ?: return null
        return decoded.use { withContext(main) { recognize(decoded, language) } }
    }

    private suspend fun recognize(audio: DecodedAudio, language: String): String? {
        val recognizer = recognizers.onDevice()
        var source: ParcelFileDescriptor? = null
        var feed: Job? = null
        val heard = CompletableDeferred<String?>()
        return try {
            val pipe = ParcelFileDescriptor.createPipe()
            source = pipe[0]
            val sink = ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])
            // Not a child of this call. A write into a full pipe cannot be cancelled, so a
            // recognizer that stops reading without closing its end would otherwise keep
            // this call, and the relay waiting on it, from ever returning.
            feed = feeds.launch {
                try {
                    sink.use(audio::writeTo)
                } catch (_: IOException) {
                    // The recognizer stopped reading before the recording ended.
                } catch (_: IllegalStateException) {
                    heard.complete(null)
                }
            }
            val installed = withTimeoutOrNull(SUPPORT_TIMEOUT) {
                suspendCancellableCoroutine<List<String>?> { continuation ->
                    recognizer.support(intent(language, emptyList(), null, audio)) { languages ->
                        if (continuation.isActive) continuation.resume(languages)
                    }
                }
            }
            val verified = installed?.any { it.equals(language, ignoreCase = true) } == true
            val hints = if (verified) vocabulary.cache.phrases(VOCABULARY_PURPOSE, language) else emptyList()
            recognizer.listener(Listener(heard))
            recognizer.start(intent(language, hints, source, audio))
            withTimeoutOrNull(timeout) { heard.await() }?.trim()?.ifEmpty { null }
        } finally {
            recognizer.cancel()
            recognizer.destroy()
            runCatching { source?.close() }
            feed?.let { writing ->
                writing.cancel()
                // With the pipe closed the feed ends at its next write. The caller closes the
                // decoder the feed reads from, so it is given a moment to get there first.
                withContext(NonCancellable) { withTimeoutOrNull(FEED_STOP_TIMEOUT) { writing.join() } }
            }
        }
    }

    /** Collects a session's segments; the session ends when the audio source does, or on an error. */
    private class Listener(private val heard: CompletableDeferred<String?>) : RecognitionListener {
        private val segments = mutableListOf<String>()

        override fun onSegmentResults(segmentResults: Bundle) {
            first(segmentResults)?.let(segments::add)
        }

        override fun onEndOfSegmentedSession() {
            heard.complete(segments.joinToString(" "))
        }

        // A recognizer that does not segment ends the session with one final result.
        override fun onResults(results: Bundle?) {
            first(results)?.let(segments::add)
            heard.complete(segments.joinToString(" "))
        }

        // What was heard before an error is still what was said; an error with nothing heard is no transcript.
        override fun onError(error: Int) {
            heard.complete(segments.joinToString(" ").ifEmpty { null })
        }

        override fun onPartialResults(partialResults: Bundle?) = Unit
        override fun onReadyForSpeech(params: Bundle?) = Unit
        override fun onBeginningOfSpeech() = Unit
        override fun onRmsChanged(rmsdB: Float) = Unit
        override fun onBufferReceived(buffer: ByteArray?) = Unit
        override fun onEndOfSpeech() = Unit
        override fun onEvent(eventType: Int, params: Bundle?) = Unit

        private fun first(bundle: Bundle?): String? =
            bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.takeIf { it.isNotBlank() }
    }

    companion object {
        /**
         * Longest a transcription may take before it is abandoned. A watch
         * recording is at most two minutes, and the recognizer reads it faster
         * than it was spoken.
         */
        val TIMEOUT: Duration = 90.seconds

        private val SUPPORT_TIMEOUT: Duration = 5.seconds

        /** How long a finished transcription waits for its audio feed to notice the pipe closed. */
        private val FEED_STOP_TIMEOUT: Duration = 2.seconds

        /** A recording is dictation whatever it turns out to be for. */
        private const val VOCABULARY_PURPOSE = "dictation"

        /** The recording's locale as a BCP 47 tag, or the phone's own when it names none. */
        internal fun languageTag(locale: String?): String {
            val tag = locale?.trim()?.replace('_', '-')?.takeIf { it.isNotEmpty() }
            val parsed = tag?.let(Locale::forLanguageTag)?.takeIf { it.language.isNotEmpty() }
            return (parsed ?: Locale.getDefault()).toLanguageTag()
        }

        /**
         * The recognition request for a recording. With [source] the recognizer
         * reads the recording and keeps the session open across pauses until it
         * ends; without, the intent only asks what the recognizer supports.
         */
        internal fun intent(language: String, hints: List<String>, source: ParcelFileDescriptor?, audio: DecodedAudio): Intent =
            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
                putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    if (hints.isNotEmpty()) {
                        putStringArrayListExtra(RecognizerIntent.EXTRA_BIASING_STRINGS, ArrayList(hints))
                    }
                    if (source != null) {
                        putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, source)
                        putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, audio.channels)
                        putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
                        putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, audio.sampleRateHz)
                        putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE)
                    }
                }
            }
    }
}

/** Decodes a compressed recording to PCM with the platform's extractor and codec. */
internal object MediaCodecAudioDecoder : AudioDecoder {
    override fun open(file: File): DecodedAudio? {
        val extractor = MediaExtractor()
        return try {
            extractor.setDataSource(file.absolutePath)
            val track = (0 until extractor.trackCount).firstOrNull {
                extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
            }
            if (track == null) {
                extractor.release()
                return null
            }
            extractor.selectTrack(track)
            Track(extractor, extractor.getTrackFormat(track))
        } catch (_: IOException) {
            extractor.release()
            null
        } catch (_: RuntimeException) {
            // A source the extractor rejects, or a track format without the fields decoding needs.
            extractor.release()
            null
        }
    }

    private class Track(private val extractor: MediaExtractor, private val format: MediaFormat) : DecodedAudio {
        override val sampleRateHz: Int = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        override val channels: Int = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)

        override fun writeTo(out: OutputStream) {
            val codec = MediaCodec.createDecoderByType(requireNotNull(format.getString(MediaFormat.KEY_MIME)))
            try {
                codec.configure(format, null, null, 0)
                codec.start()
                val info = MediaCodec.BufferInfo()
                var inputEnded = false
                var outputEnded = false
                while (!outputEnded) {
                    if (!inputEnded) {
                        val index = codec.dequeueInputBuffer(DEQUEUE_TIMEOUT_US)
                        if (index >= 0) {
                            val size = extractor.readSampleData(requireNotNull(codec.getInputBuffer(index)), 0)
                            if (size < 0) {
                                codec.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                                inputEnded = true
                            } else {
                                codec.queueInputBuffer(index, 0, size, extractor.sampleTime, 0)
                                extractor.advance()
                            }
                        }
                    }
                    val index = codec.dequeueOutputBuffer(info, DEQUEUE_TIMEOUT_US)
                    if (index >= 0) {
                        if (info.size > 0) {
                            val buffer = requireNotNull(codec.getOutputBuffer(index))
                            val samples = ByteArray(info.size)
                            buffer.position(info.offset)
                            buffer.get(samples)
                            out.write(samples)
                        }
                        codec.releaseOutputBuffer(index, false)
                        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) outputEnded = true
                    }
                }
            } finally {
                runCatching { codec.stop() }
                codec.release()
            }
        }

        override fun close() {
            extractor.release()
        }

        private companion object {
            const val DEQUEUE_TIMEOUT_US = 10_000L
        }
    }
}
