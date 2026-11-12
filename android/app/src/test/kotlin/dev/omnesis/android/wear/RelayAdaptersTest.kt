// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import android.Manifest
import android.app.Application
import android.app.NotificationManager
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.MainActivity
import dev.omnesis.android.notes.NotesGateway
import dev.omnesis.android.notes.NotesRepository
import dev.omnesis.android.notes.PendingNotesStore
import dev.omnesis.android.notes.VoiceNoteFiles
import dev.omnesis.android.notifications.FcmPushManager
import dev.omnesis.android.transport.client.NotesClient
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.http.GatewayHttp
import dev.omnesis.android.wearprotocol.DictationGate
import dev.omnesis.android.wearprotocol.NoteOutcome
import dev.omnesis.android.wearprotocol.RecentRefs
import java.io.File
import java.time.ZoneId
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** A watch note through the phone's real note pipeline, against a MockWebServer gateway. */
@RunWith(RobolectricTestRunner::class)
class RepositoryWatchNoteSaverTest {
    @get:Rule
    val folder = TemporaryFolder()

    private lateinit var server: MockWebServer
    private lateinit var baseUrl: String
    private val ref = "5F0C3B1E-8A47-4F6E-9D2B-7C1A2E3F4B5D"
    private val entry = """
        {"id":"n1","day":"2026-03-14","capturedAt":"2026-03-14T09:30:00.000Z",
         "updatedAt":"2026-03-14T09:30:00.000Z","text":"Buy oat milk"}
    """.trimIndent()

    @Before fun setUp() {
        server = MockWebServer()
        server.start()
        baseUrl = server.url("/").toString()
    }

    @After fun tearDown() { runCatching { server.shutdown() } }

    private fun saver(): RepositoryWatchNoteSaver {
        val files = VoiceNoteFiles(File(folder.root, "voice-notes"))
        val repository = NotesRepository(
            store = PendingNotesStore(ApplicationProvider.getApplicationContext()),
            gateway = {
                NotesGateway(NotesClient(GatewayHttp(OkHttpClient(), baseUrl, "tok")), "dev-1")
            },
            audioFiles = files,
            language = { "fr-FR" },
            timeZone = { ZoneId.of("Asia/Tokyo") },
        )
        return RepositoryWatchNoteSaver(repository, files)
    }

    @Test
    fun a_text_note_is_posted_as_the_watch_surface_under_its_ref_and_capture_time() = runTest {
        server.enqueue(MockResponse().setResponseCode(201).setBody(entry))

        assertEquals(NoteOutcome.SAVED, saver().save("Buy oat milk", CAPTURE_TIME, ref, audio = null, locale = null))

        val request = server.takeRequest()
        assertEquals("/notes", request.path)
        val body = OmnesisJson.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals(ref.lowercase(), body["id"]?.jsonPrimitive?.content)
        assertEquals("2026-03-14T09:30:00Z", body["capturedAt"]?.jsonPrimitive?.content)
        assertEquals("android-watch", body["surface"]?.jsonPrimitive?.content)
        assertEquals("Buy oat milk", body["text"]?.jsonPrimitive?.content)
        // The watch's zone, not the phone's.
        assertEquals("Europe/Lisbon", body["capturedTimeZoneId"]?.jsonPrimitive?.content)
        assertEquals("0", body["capturedUtcOffsetSeconds"]?.jsonPrimitive?.content)
    }

    @Test
    fun a_zone_the_gateway_would_reject_falls_back_to_the_phones() = runTest {
        for (unusable in listOf("GMT+02:00", "Nowhere/Invented")) {
            server.enqueue(MockResponse().setResponseCode(201).setBody(entry))
            val captureTime = CAPTURE_TIME.copy(timeZoneId = unusable, utcOffsetSeconds = 7_200)

            assertEquals(NoteOutcome.SAVED, saver().save("Buy oat milk", captureTime, ref, audio = null, locale = null))

            val body = OmnesisJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
            assertEquals(unusable, "Asia/Tokyo", body["capturedTimeZoneId"]?.jsonPrimitive?.content)
            assertEquals(unusable, "32400", body["capturedUtcOffsetSeconds"]?.jsonPrimitive?.content)
        }
    }

    @Test
    fun a_voice_note_uploads_a_copy_and_leaves_the_recording_where_it_was() = runTest {
        server.enqueue(MockResponse().setResponseCode(202).setBody("""{"id":"n1","transcription":"pending"}"""))
        val recording = folder.newFile("recording.m4a").apply { writeBytes(byteArrayOf(1, 2, 3)) }

        assertEquals(NoteOutcome.SAVED, saver().save("", CAPTURE_TIME, ref, recording, locale = "en-GB"))

        val request = server.takeRequest()
        assertEquals("/notes/voice", request.path)
        val body = request.body.readUtf8()
        assertTrue(body.contains(""""surface":"android-watch""""))
        assertTrue(body.contains(""""id":"${ref.lowercase()}""""))
        assertTrue(body.contains("audio/mp4"))
        // Transcribed in the language the watch recorded it under, and filed in the watch's zone.
        assertTrue(body.contains(""""language":"en-GB""""))
        assertTrue(body.contains(""""capturedTimeZoneId":"Europe/Lisbon""""))
        assertTrue(body.contains(""""capturedUtcOffsetSeconds":0"""))
        assertTrue("the inbox keeps its recording until the note is known to be kept", recording.isFile)
        assertTrue("the uploaded copy is gone", File(folder.root, "voice-notes").listFiles().isNullOrEmpty())
    }

    @Test
    fun a_voice_note_whose_watch_named_no_language_is_sent_under_the_phones() = runTest {
        server.enqueue(MockResponse().setResponseCode(202).setBody("""{"id":"n1","transcription":"pending"}"""))
        val recording = folder.newFile("recording.m4a").apply { writeBytes(byteArrayOf(1, 2, 3)) }

        assertEquals(NoteOutcome.SAVED, saver().save("", CAPTURE_TIME, ref, recording, locale = null))

        assertTrue(server.takeRequest().body.readUtf8().contains(""""language":"fr-FR""""))
    }

    @Test
    fun an_unreachable_gateway_queues_the_note_on_the_phone() = runTest {
        server.shutdown()
        assertEquals(NoteOutcome.QUEUED_ON_PHONE, saver().save("Buy oat milk", CAPTURE_TIME, ref, audio = null, locale = null))
    }

    @Test
    fun a_note_the_gateway_will_never_take_is_rejected() = runTest {
        server.enqueue(MockResponse().setResponseCode(422).setBody("""{"error":"Invalid note"}"""))
        assertEquals(NoteOutcome.REJECTED, saver().save("Buy oat milk", CAPTURE_TIME, ref, audio = null, locale = null))
    }

    @Test
    fun audio_the_gateway_will_not_transcribe_with_no_text_to_fall_back_on_is_not_kept() = runTest {
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":"Dictation disabled"}"""))
        val recording = folder.newFile("recording.m4a").apply { writeBytes(byteArrayOf(1, 2, 3)) }

        assertEquals(NoteOutcome.CAPTURE_FAILED, saver().save("", CAPTURE_TIME, ref, recording, locale = "en-GB"))
        assertTrue(recording.isFile)
    }
}

/** What the relay remembers, across the instances a process death makes. */
@RunWith(RobolectricTestRunner::class)
class PreferencesRelayStateStoreTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()

    @Test
    fun the_published_gate_survives_the_process() {
        assertNull(PreferencesRelayStateStore(context).loadGate())
        val gate = DictationGate(active = true, maxAudioBytes = 4_000_000, updatedAt = CAPTURED_AT, decisionGate = true, captureSupported = true)
        PreferencesRelayStateStore(context).saveGate(gate)
        assertEquals(gate, PreferencesRelayStateStore(context).loadGate())
    }

    @Test
    fun a_ref_handled_by_one_process_is_a_duplicate_in_the_next() {
        assertTrue(HandledRefs(PreferencesRelayStateStore(context)).claim("ref-1"))
        val next = HandledRefs(PreferencesRelayStateStore(context))
        assertFalse(next.claim("ref-1"))
        assertTrue(next.claim("ref-2"))
        assertTrue("a relay without a ref is always new", next.claim(null) && next.claim(null))
    }

    @Test
    fun only_the_most_recent_refs_are_kept() {
        val refs = HandledRefs(PreferencesRelayStateStore(context))
        repeat(RecentRefs.CAPACITY + 1) { refs.claim("ref-$it") }

        val stored = PreferencesRelayStateStore(context).loadHandledRefs()
        assertEquals(RecentRefs.CAPACITY, stored.size)
        assertEquals("ref-1", stored.first())
        assertTrue("the oldest ref fell out of the window", HandledRefs(PreferencesRelayStateStore(context)).claim("ref-0"))
    }

    @Test
    fun a_watch_once_seen_stays_known() {
        assertFalse(PreferencesRelayStateStore(context).watchKnown())
        PreferencesRelayStateStore(context).markWatchKnown()
        assertTrue(PreferencesRelayStateStore(context).watchKnown())
    }
}

/** Relay notices as the system notifications they become. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [32])
class SystemRelayNotifierTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private val system get() = shadowOf(context.getSystemService(NotificationManager::class.java))
    private fun notifier() = SystemRelayNotifier(FcmPushManager(context))

    @Test
    fun an_answer_notice_opens_its_conversation_from_the_agent_channel() {
        notifier().post(RelayNotice("Answer ready", "Tuesday at ten", "conversation_example"))

        val notification = system.allNotifications.single()
        assertEquals("Answer ready", notification.extras.getString("android.title"))
        assertEquals("Tuesday at ten", notification.extras.getString("android.text"))
        assertEquals(FcmPushManager.AGENT_CHANNEL_ID, notification.channelId)
        val intent = shadowOf(notification.contentIntent).savedIntent
        assertEquals(MainActivity.ACTION_AGENT_CONVERSATION, intent.action)
        assertEquals("conversation_example", intent.getStringExtra(MainActivity.EXTRA_CONVERSATION_ID))
    }

    @Test
    fun capture_notices_replace_each_other_and_open_the_app() {
        notifier().post(RelayNotice.captureDelayed)
        notifier().post(RelayNotice.captureExpired)

        val notification = system.allNotifications.single()
        assertEquals(RelayNotice.captureExpired.body, notification.extras.getString("android.text"))
        assertEquals(FcmPushManager.NOTIFICATION_CHANNEL_ID, notification.channelId)
        assertNull(shadowOf(notification.contentIntent).savedIntent.action)
    }

    @Test
    fun notices_without_a_slot_each_stand_on_their_own() {
        notifier().post(RelayNotice.voiceNoteFailed)
        notifier().post(RelayNotice.questionExpired)
        assertEquals(
            setOf("Couldn't save your voice note", "Your watch question wasn't asked"),
            system.allNotifications.map { it.extras.getString("android.title") }.toSet(),
        )
    }

    @Test
    fun a_phone_with_notifications_switched_off_drops_the_notice() {
        system.setNotificationsEnabled(false)
        notifier().post(RelayNotice.captureDelayed)
        assertTrue(system.allNotifications.isEmpty())
    }

    @Test
    @Config(sdk = [33])
    fun without_the_notification_permission_nothing_is_posted_and_nothing_fails() {
        shadowOf(context as Application).denyPermissions(Manifest.permission.POST_NOTIFICATIONS)
        notifier().post(RelayNotice("Answer ready", "Tuesday at ten", "conversation_example"))
        assertTrue(system.allNotifications.isEmpty())

        shadowOf(context as Application).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        notifier().post(RelayNotice("Answer ready", "Tuesday at ten", "conversation_example"))
        assertEquals(1, system.allNotifications.size)
    }
}
