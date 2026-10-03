// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.capture

import android.content.Context
import android.content.Intent
import android.os.Build
import android.speech.RecognitionListener
import android.speech.RecognitionSupport
import android.speech.RecognitionSupportCallback
import android.speech.SpeechRecognizer

/** Production platform seam: tests can observe which provider receives each Intent. */
internal interface RecognizerBackend {
    fun listener(listener: RecognitionListener)
    fun start(intent: Intent)
    fun support(intent: Intent, result: (List<String>?) -> Unit)
    fun stop()
    fun cancel()
    fun destroy()
}

internal interface RecognizerFactory {
    fun available(): Boolean
    fun onDeviceAvailable(): Boolean
    fun default(): RecognizerBackend
    fun onDevice(): RecognizerBackend
}

internal class PlatformRecognizerFactory(private val context: Context) : RecognizerFactory {
    override fun available() = SpeechRecognizer.isRecognitionAvailable(context)
    override fun onDeviceAvailable() = Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
    override fun default(): RecognizerBackend = wrap(SpeechRecognizer.createSpeechRecognizer(context))
    override fun onDevice(): RecognizerBackend {
        check(Build.VERSION.SDK_INT >= 31)
        return wrap(SpeechRecognizer.createOnDeviceSpeechRecognizer(context))
    }
    private fun wrap(recognizer: SpeechRecognizer) = object : RecognizerBackend {
        override fun listener(listener: RecognitionListener) = recognizer.setRecognitionListener(listener)
        override fun start(intent: Intent) = recognizer.startListening(intent)
        override fun support(intent: Intent, result: (List<String>?) -> Unit) {
            check(Build.VERSION.SDK_INT >= 33)
            recognizer.checkRecognitionSupport(intent, context.mainExecutor, object : RecognitionSupportCallback {
                override fun onSupportResult(support: RecognitionSupport) = result(support.installedOnDeviceLanguages)
                override fun onError(error: Int) = result(null)
            })
        }
        override fun stop() = recognizer.stopListening()
        override fun cancel() = recognizer.cancel()
        override fun destroy() = recognizer.destroy()
    }
}
