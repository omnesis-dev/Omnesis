// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeakerTest {
    private val engine = FakeSpeech()
    private var recording = false
    private val speaker = Speaker(engine) { recording }
    private val answer = "The plumber comes on Tuesday."

    @Test
    fun speaking_starts_at_the_beginning_and_follows_the_voice() {
        speaker.speak(answer)
        assertEquals(SpeakerState(answer, spokenUpTo = 0, isSpeaking = true), speaker.state.value)
        val id = engine.spoken.single().second
        engine.listener?.onRange(id, 11)
        assertEquals(11, speaker.state.value.spokenUpTo)
        engine.listener?.onDone(id)
        assertEquals(SpeakerState(answer, spokenUpTo = answer.length, isSpeaking = false), speaker.state.value)
    }

    @Test
    fun preparing_keeps_the_text_without_speaking_it() {
        speaker.prepare(answer)
        assertEquals(SpeakerState(answer), speaker.state.value)
        assertTrue(engine.spoken.isEmpty())
        speaker.replay()
        assertEquals(answer, engine.spoken.single().first)
    }

    @Test
    fun stopping_shows_the_whole_answer_as_read() {
        speaker.speak(answer)
        engine.listener?.onRange(engine.spoken.single().second, 4)
        speaker.stop()
        assertEquals(SpeakerState(answer, spokenUpTo = answer.length, isSpeaking = false), speaker.state.value)
        assertEquals(1, engine.stops)
    }

    @Test
    fun callbacks_from_a_superseded_utterance_are_ignored() {
        speaker.speak("First answer.")
        val first = engine.spoken.last().second
        speaker.speak(answer)
        val second = engine.spoken.last().second
        engine.listener?.onRange(first, 5)
        engine.listener?.onDone(first)
        engine.listener?.onStopped(first)
        assertEquals(SpeakerState(answer, spokenUpTo = 0, isSpeaking = true), speaker.state.value)
        engine.listener?.onRange(second, 3)
        assertEquals(3, speaker.state.value.spokenUpTo)
    }

    @Test
    fun an_utterance_that_could_not_be_spoken_ends_without_marking_it_read() {
        speaker.speak(answer)
        engine.listener?.onStopped(engine.spoken.single().second)
        assertFalse(speaker.isSpeaking)
        assertEquals(0, speaker.state.value.spokenUpTo)
    }

    @Test
    fun nothing_is_spoken_while_the_microphone_is_open() {
        recording = true
        speaker.speak(answer)
        assertTrue(engine.spoken.isEmpty())
        assertEquals(SpeakerState(answer, spokenUpTo = answer.length, isSpeaking = false), speaker.state.value)
        recording = false
        speaker.replay()
        assertTrue(speaker.isSpeaking)
    }

    @Test
    fun an_empty_text_is_not_spoken() {
        speaker.speak("")
        assertTrue(engine.spoken.isEmpty())
        assertFalse(speaker.isSpeaking)
    }

    @Test
    fun a_range_past_the_end_is_held_to_the_text() {
        speaker.speak(answer)
        engine.listener?.onRange(engine.spoken.single().second, 500)
        assertEquals(answer.length, speaker.state.value.spokenUpTo)
    }

    // Read-along.

    @Test
    fun nothing_spoken_yet_gives_no_split() {
        assertNull(ReadAlong.split(answer, 0))
        assertNull(ReadAlong.split("", 3))
        assertNull(ReadAlong.split(answer, SpeakerState(answer, spokenUpTo = 0, isSpeaking = true)))
    }

    @Test
    fun the_split_follows_the_spoken_offset_and_stops_at_the_end() {
        assertEquals(11, ReadAlong.split(answer, 11))
        assertEquals(answer.length, ReadAlong.split(answer, answer.length))
        assertEquals(answer.length, ReadAlong.split(answer, answer.length + 40))
    }

    @Test
    fun an_offset_inside_a_surrogate_pair_rounds_down_to_its_start() {
        val text = "Ok 🚀 go"
        assertEquals(3, ReadAlong.split(text, 4))
        assertEquals(5, ReadAlong.split(text, 5))
    }

    @Test
    fun an_offset_between_a_letter_and_its_combining_accent_rounds_down() {
        val text = "café au lait"
        assertEquals(3, ReadAlong.split(text, 4))
        assertEquals(5, ReadAlong.split(text, 5))
    }

    @Test
    fun another_text_than_the_one_being_spoken_is_not_split() {
        val speaking = SpeakerState("Something else.", spokenUpTo = 6, isSpeaking = true)
        assertNull(ReadAlong.split(answer, speaking))
        assertEquals(6, ReadAlong.split("Something else.", speaking))
    }

    // The level the halo follows.

    @Test
    fun the_level_attacks_faster_than_it_releases_and_stays_in_range() {
        var level = 0f
        repeat(40) { level = CaptureLevel.next(level, 0f) }
        assertTrue(level > 0.99f && level <= 1f)
        val rising = CaptureLevel.next(0.2f, -15f) - 0.2f
        val falling = 0.8f - CaptureLevel.next(0.8f, -15f - 40f)
        assertTrue(rising > 0)
        assertTrue(falling > 0)
        assertEquals(0.32f, rising / 0.8f, 0.001f)
        assertEquals(0.14f, falling / 0.8f, 0.001f)
        assertEquals(0f, CaptureLevel.next(0f, -90f), 0f)
    }
}
