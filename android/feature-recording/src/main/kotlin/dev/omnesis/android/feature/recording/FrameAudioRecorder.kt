// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import android.os.Handler
import android.os.Looper
import android.util.Log
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Records a [WearableAudio] stream into the same chunks the phone microphone
 * produces: each Opus frame is decoded to 16 kHz PCM and written to an AAC
 * chunk of [ChunkPolicy.TARGET_CHUNK_MS] of audio, so the speech check, the
 * outbox and the gateway see no difference.
 *
 * Audio time follows the wall clock. A wearable stops sending while it hears
 * nothing (its microphone sleeps) and loses a frame now and then; frames
 * arriving later than [PAD_AFTER_MS] past where the audio has got to are
 * preceded by silence up to their arrival, and a pause longer than
 * [GAP_CLOSE_MS] closes the chunk and is filed as an empty chunk of that
 * length, which the controller files as silent. A dropped link closes the
 * chunk as interrupted and reports [onInputLost]; [start] resumes.
 *
 * Decoding and encoding run on one worker thread; the public methods are
 * called from the service's main thread and wait for the worker where the
 * chunk count must be final.
 */
class FrameAudioRecorder(
    private val directory: File,
    private val input: WearableAudio,
    private val onChunk: (RecordedChunk) -> Unit,
    private val onInputLost: () -> Unit,
    private val decoders: () -> OpusDecoder = ::MediaCodecOpusDecoder,
    private val encoders: PcmChunkEncoderFactory = PcmChunkEncoderFactory(::MediaCodecAacChunkEncoder),
    private val worker: ExecutorService = Executors.newSingleThreadExecutor { Thread(it, "omnesis-wearable-audio") },
    private val postToMain: (Runnable) -> Unit = Handler(Looper.getMainLooper())::post,
    private val clock: () -> Long = System::currentTimeMillis,
) : ChunkRecorder {

    private class Open(val seq: Int, val file: File, val encoder: PcmChunkEncoder, val startedAtMs: Long) {
        var samples = 0L
        val endMs: Long get() = startedAtMs + samples * 1000 / ChunkPolicy.SAMPLE_RATE_HZ
    }

    // Worker-thread state.
    private var decoder: OpusDecoder? = null
    private var current: Open? = null
    /** End of the audio written so far in this run, wall clock; null before the first frame. */
    private var audioEndMs: Long? = null
    private var interrupted = false

    @Volatile private var streaming = false
    @Volatile private var nextSeq = 0
    /** Bumped on every start, so frames from a run that ended are dropped. */
    @Volatile private var run = 0

    override val chunksRecorded: Int get() = nextSeq
    override val isRecording: Boolean get() = streaming

    override fun start(): Boolean {
        if (streaming) return true
        val thisRun = ++run
        onWorker { decoder = decoders(); audioEndMs = null }
        streaming = true
        val sink = object : WearableAudio.FrameSink {
            override fun onFrame(frame: ByteArray, receivedAtMs: Long) {
                if (run == thisRun) post { if (run == thisRun) frame(frame, receivedAtMs) }
            }

            override fun onLinkLost() {
                if (run != thisRun) return
                post {
                    if (run != thisRun || !streaming) return@post
                    interrupted = true
                    endRun()
                    streaming = false
                    postToMain(Runnable { onInputLost() })
                }
            }
        }
        if (!input.startStreaming(sink)) {
            streaming = false
            onWorker { releaseDecoder() }
            return false
        }
        return true
    }

    override fun pause() {
        if (!streaming) {
            onWorker { } // a lost link may still be closing its chunk
            return
        }
        streaming = false
        input.stopStreaming()
        run++
        onWorker { endRun() }
    }

    override fun stop() {
        pause()
        worker.shutdown()
    }

    private fun frame(frame: ByteArray, receivedAtMs: Long) {
        val pcm = try {
            decoder?.decode(frame) ?: return
        } catch (e: Exception) {
            Log.w(TAG, "Dropped an undecodable frame: ${e.message}")
            return
        }
        if (pcm.isEmpty()) return
        // The frame's audio ends when it arrived.
        val startsAt = receivedAtMs - pcm.size * 1000L / ChunkPolicy.SAMPLE_RATE_HZ
        val end = audioEndMs
        val at = when {
            end == null -> startsAt
            startsAt - end > GAP_CLOSE_MS -> {
                closeCurrent()
                fileGap(end, startsAt)
                startsAt
            }
            startsAt - end > PAD_AFTER_MS -> {
                write(ShortArray(((startsAt - end) * ChunkPolicy.SAMPLE_RATE_HZ / 1000).toInt()), end)
                audioEndMs!!
            }
            else -> end
        }
        write(pcm, at)
    }

    /** Append [pcm] starting at [atMs], rotating chunks at the target length. */
    private fun write(pcm: ShortArray, atMs: Long) {
        var at = 0
        var time = atMs
        while (at < pcm.size) {
            val open = current ?: openChunk(time)
            val room = (TARGET_SAMPLES - open.samples).toInt()
            val n = minOf(room, pcm.size - at)
            open.encoder.write(if (at == 0 && n == pcm.size) pcm else pcm.copyOfRange(at, at + n))
            open.samples += n
            at += n
            time = open.endMs
            if (open.samples >= TARGET_SAMPLES) closeCurrent()
        }
        audioEndMs = time
    }

    private fun openChunk(atMs: Long): Open {
        val seq = nextSeq++
        val file = File(directory, ChunkPolicy.fileName(seq))
        return Open(seq, file, encoders.open(file), atMs).also { current = it }
    }

    private fun closeCurrent() {
        val open = current ?: return
        current = null
        try {
            open.encoder.finish()
        } catch (e: Exception) {
            Log.w(TAG, "Could not finish chunk ${open.seq}: ${e.message}")
            open.file.writeBytes(ByteArray(0))
        }
        Log.i(TAG, "Wearable chunk ${open.seq}: ${open.endMs - open.startedAtMs} ms, ${open.file.length()} bytes${if (interrupted) ", interrupted" else ""}")
        onChunk(RecordedChunk(open.seq, open.startedAtMs, open.endMs - open.startedAtMs, open.file, interrupted))
        interrupted = false
    }

    /** A stretch the wearable sent nothing for, filed as an empty chunk so the transcript shows it as silence. */
    private fun fileGap(fromMs: Long, toMs: Long) {
        val seq = nextSeq++
        val file = File(directory, ChunkPolicy.fileName(seq)).apply { writeBytes(ByteArray(0)) }
        Log.i(TAG, "Wearable sent nothing for ${toMs - fromMs} ms; filed as silence (chunk $seq)")
        onChunk(RecordedChunk(seq, fromMs, toMs - fromMs, file, interrupted = false))
    }

    private fun endRun() {
        closeCurrent()
        releaseDecoder()
        audioEndMs = null
    }

    private fun releaseDecoder() {
        decoder?.let { runCatching { it.close() } }
        decoder = null
    }

    /** Run on the worker without waiting; a callback that races [stop] is dropped. */
    private fun post(block: () -> Unit) {
        try {
            worker.execute(block)
        } catch (_: java.util.concurrent.RejectedExecutionException) {
        }
    }

    private fun onWorker(block: () -> Unit) {
        worker.submit(block).get()
    }

    companion object {
        private const val TAG = "Omnesis:Recording"
        private const val TARGET_SAMPLES = ChunkPolicy.TARGET_CHUNK_MS * ChunkPolicy.SAMPLE_RATE_HZ / 1000

        /** Lateness beyond the link's own jitter: the audio is padded with silence up to the frame. */
        const val PAD_AFTER_MS = 300L

        /** A pause long enough to close the chunk and file the pause on its own. */
        const val GAP_CLOSE_MS = 2_000L
    }
}
