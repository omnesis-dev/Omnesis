// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.assist

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.feature.recording.OpusDecoder
import dev.omnesis.android.feature.recording.SpeechDetector
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.nio.file.Files
import java.util.concurrent.Executors

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AssistRuntimeTest {
    private object Plain : dev.omnesis.android.pairing.PrefsCipher {
        override fun seal(plaintext: String) = plaintext
        override fun open(token: String) = token
    }

    private val dir: File = Files.createTempDirectory("runtime").toFile()
    private val settings = AssistSettings(
        ApplicationProvider.getApplicationContext<Context>().getSharedPreferences("runtime-test", Context.MODE_PRIVATE),
        Plain,
    )
    private val models = WakeWordModelStore(dir, OkHttpClient(), validate = {})
    private val phoneAllowed = MutableStateFlow(false)

    private val runtime = AssistRuntime(
        settings = settings,
        models = models,
        commands = VoiceCommands(
            decoders = { object : OpusDecoder { override fun decode(frame: ByteArray) = ShortArray(0); override fun close() = Unit } },
            wakeDetectors = { error("not started in this test") },
            speechDetectors = { object : SpeechDetector { override fun reset() = Unit; override fun probability(frame: FloatArray) = 0f } },
            send = { _, _ -> AssistOutcome.Done(null) },
            scope = CoroutineScope(Dispatchers.Unconfined),
            workers = { Executors.newSingleThreadExecutor() },
        ),
        phoneAllowed = phoneAllowed,
    )

    /** Every catalogue model, as if downloaded. */
    private fun installAll() {
        (WakeWordModelCatalog.shared.map { it.fileName } + WakeWordModelCatalog.words.map { it.fileName })
            .forEach { File(dir, it).writeBytes(byteArrayOf(1)) }
    }

    private val phone = CommandRoute("phone", WakeWordModelCatalog.ALEXA.id, Destination.PhoneAction)
    private val hook = CommandRoute("hook", WakeWordModelCatalog.HEY_MYCROFT.id, Destination.Webhook("https://hooks.example.com/a"))

    @Test fun aPhoneRouteIsHeardOnlyOnceTheAppMayStartTheClock() {
        installAll()
        settings.setRoutes(listOf(phone, hook))
        assertEquals(listOf("hook"), runtime.activeRoutes().map { it.route.id })
        phoneAllowed.value = true
        assertEquals(listOf("phone", "hook"), runtime.activeRoutes().map { it.route.id })
    }

    @Test fun aRouteWhoseModelIsMissingIsNotHeard() {
        settings.setRoutes(listOf(hook))
        phoneAllowed.value = true
        assertEquals(emptyList<String>(), runtime.activeRoutes().map { it.route.id })
        installAll()
        assertEquals(listOf("hook"), runtime.activeRoutes().map { it.route.id })
    }

    @Test fun grantingThePermissionIsAChangeTheLinkServiceHears() = runBlocking {
        val seen = mutableListOf<Unit>()
        val job = launch { runtime.changes.take(2).toList(seen) }
        runtime.changes.first()
        yield()
        phoneAllowed.value = true
        job.join()
        assertEquals(2, seen.size)
    }
}
