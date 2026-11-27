// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording.ui

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.feature.recording.RecordingSessionProvider
import dev.omnesis.android.feature.recording.RecordingsGateway
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.NewParticipant
import dev.omnesis.android.transport.dto.PersonSummary
import dev.omnesis.android.transport.dto.RecordingParticipantDto
import dev.omnesis.android.transport.dto.RecordingSpeakerDto
import dev.omnesis.android.transport.dto.SpeakerMapping
import dev.omnesis.android.transport.dto.displayName
import javax.inject.Inject
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * The person picker for one speaker, or for someone present without a turn
 * ([ALSO_PRESENT]): a search over `/people?q=`.
 */
data class PersonPickerState(
    val speaker: Int,
    val query: String = "",
    val results: List<PersonSummary> = emptyList(),
    val searching: Boolean = true,
    val failed: Boolean = false,
)

data class RecordingSpeakersUiState(
    val title: String = "",
    val load: Load = Load.Loading,
    val speakers: List<RecordingSpeakerDto> = emptyList(),
    /** People present without a speaking turn of their own. */
    val participants: List<RecordingParticipantDto> = emptyList(),
    /** Speakers with a change on its way to the gateway; their actions wait. */
    val saving: Set<Int> = emptySet(),
    /** A change to who was present is on its way to the gateway; the others wait. */
    val savingParticipants: Boolean = false,
    /** A change that did not save, shown once. */
    val message: String? = null,
    val picker: PersonPickerState? = null,
) {
    sealed interface Load {
        data object Loading : Load
        data class Failed(val message: String) : Load
        data object Loaded : Load
    }
}

/**
 * Who spoke in one recording, and saying who each speaker is (experimental).
 * A change shows at once and is rolled back when the gateway refuses it; the
 * gateway's answer then replaces the list, so what shows is what it holds.
 */
@HiltViewModel
class RecordingSpeakersViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val sessions: RecordingSessionProvider,
) : ViewModel() {
    val recordingId: String = checkNotNull(savedStateHandle[ARG_RECORDING_ID]) { "recording id" }

    private val _state = MutableStateFlow(
        RecordingSpeakersUiState(title = savedStateHandle.get<String>(ARG_TITLE).orEmpty()),
    )
    val state: StateFlow<RecordingSpeakersUiState> = _state.asStateFlow()

    private var search: Job? = null

    init {
        load()
    }

    fun load() {
        _state.update { it.copy(load = RecordingSpeakersUiState.Load.Loading) }
        viewModelScope.launch {
            val gateway = sessions.gateway()
            if (gateway == null) {
                _state.update { it.copy(load = RecordingSpeakersUiState.Load.Failed(NOT_CONNECTED)) }
                return@launch
            }
            try {
                val answer = gateway.speakers(recordingId)
                _state.update {
                    it.copy(
                        load = RecordingSpeakersUiState.Load.Loaded,
                        speakers = answer.speakers,
                        participants = answer.participants,
                    )
                }
            } catch (_: GatewayException.NotFound) {
                _state.update {
                    it.copy(load = RecordingSpeakersUiState.Load.Failed("This recording is no longer on the gateway."))
                }
            } catch (_: GatewayException) {
                _state.update { it.copy(load = RecordingSpeakersUiState.Load.Failed("Speakers could not be loaded.")) }
            }
        }
    }

    fun setSelf(speaker: Int) =
        change(speaker, SpeakerMapping.Self) { it.copy(isSelf = true, personId = null, name = null) }

    fun choosePerson(speaker: Int, person: PersonSummary) {
        closePicker()
        if (speaker == ALSO_PRESENT) {
            addParticipant(NewParticipant.Person(person.id), person.displayName)
            return
        }
        change(speaker, SpeakerMapping.Person(person.id)) {
            it.copy(isSelf = false, personId = person.id, name = person.displayName)
        }
    }

    /** Give the speaker a name that is not one of the people Omnesis knows. */
    fun name(speaker: Int, raw: String) {
        val name = raw.trim()
        if (name.isEmpty() || name.length > SpeakerMapping.MAX_NAME_LENGTH) return
        if (speaker == ALSO_PRESENT) {
            addParticipant(NewParticipant.Name(name), name)
            return
        }
        change(speaker, SpeakerMapping.Name(name)) { it.copy(isSelf = false, personId = null, name = name) }
    }

    fun clear(speaker: Int) =
        change(speaker, SpeakerMapping.Clear) { it.copy(isSelf = false, personId = null, name = null) }

    /** Take someone off the people present without a turn. */
    fun removeParticipant(key: String) {
        val current = _state.value
        if (current.participants.none { it.key == key }) return
        changeParticipants(
            optimistic = current.participants.filterNot { it.key == key },
            notFound = "They were already removed on the gateway.",
            personRefused = null,
        ) { gateway -> gateway.removeParticipant(recordingId, key) }
    }

    fun dismissMessage() = _state.update { it.copy(message = null) }

    fun openPicker(speaker: Int) {
        _state.update { it.copy(picker = PersonPickerState(speaker)) }
        runSearch("", debounce = false)
    }

    fun closePicker() {
        search?.cancel()
        _state.update { it.copy(picker = null) }
    }

    fun onPickerQuery(query: String) {
        _state.update { s -> s.copy(picker = s.picker?.copy(query = query, searching = true, failed = false)) }
        runSearch(query, debounce = true)
    }

    private fun runSearch(query: String, debounce: Boolean) {
        search?.cancel()
        search = viewModelScope.launch {
            if (debounce) delay(SEARCH_DEBOUNCE_MS)
            val gateway = sessions.gateway()
            val results = try {
                gateway?.searchPeople(query.trim(), SEARCH_LIMIT)?.filterNot { it.isSelf }
            } catch (_: GatewayException) {
                null
            }
            _state.update { s ->
                val picker = s.picker ?: return@update s
                s.copy(
                    picker = picker.copy(
                        results = results ?: picker.results,
                        searching = false,
                        failed = results == null,
                    ),
                )
            }
        }
    }

    private fun change(
        speaker: Int,
        mapping: SpeakerMapping,
        optimistic: (RecordingSpeakerDto) -> RecordingSpeakerDto,
    ) {
        val current = _state.value
        if (speaker in current.saving) return
        val before = current.speakers.firstOrNull { it.speaker == speaker } ?: return
        _state.update { s ->
            s.copy(
                speakers = s.speakers.map { if (it.speaker == speaker) optimistic(it) else it },
                saving = s.saving + speaker,
                message = null,
            )
        }
        viewModelScope.launch {
            val failure = try {
                val gateway = sessions.gateway() ?: throw NotConnected()
                val answer = gateway.setSpeaker(recordingId, speaker, mapping)
                _state.update { s ->
                    // The answer is what the gateway holds now; a speaker whose own
                    // change is still in flight keeps showing that change.
                    val pending = s.speakers.filter { it.speaker in s.saving && it.speaker != speaker }
                        .associateBy { it.speaker }
                    s.copy(
                        speakers = answer.map { pending[it.speaker] ?: it },
                        saving = s.saving - speaker,
                    )
                }
                null
            } catch (_: NotConnected) {
                NOT_CONNECTED
            } catch (_: GatewayException.NotFound) {
                "This speaker is no longer on the gateway."
            } catch (e: GatewayException.ServerError) {
                if (e.status == 400 && mapping is SpeakerMapping.Person) {
                    "That person is no longer known to the gateway."
                } else {
                    SAVE_FAILED
                }
            } catch (_: GatewayException) {
                SAVE_FAILED
            }
            if (failure != null) {
                _state.update { s ->
                    s.copy(
                        speakers = s.speakers.map { if (it.speaker == speaker) before else it },
                        saving = s.saving - speaker,
                        message = failure,
                    )
                }
            }
        }
    }

    private fun addParticipant(participant: NewParticipant, displayName: String) {
        val current = _state.value
        if (current.participants.any { it.key == participant.key }) return
        val shown = RecordingParticipantDto(
            key = participant.key,
            personId = (participant as? NewParticipant.Person)?.personId,
            name = displayName,
        )
        changeParticipants(
            optimistic = current.participants + shown,
            notFound = "This recording is no longer on the gateway.",
            personRefused = "That person is no longer known to the gateway.".takeIf {
                participant is NewParticipant.Person
            },
        ) { gateway -> gateway.addParticipant(recordingId, participant) }
    }

    /**
     * One change to who was present at a time: it shows at once, the gateway's
     * answer replaces it, and a refusal puts the list back as it was.
     */
    private fun changeParticipants(
        optimistic: List<RecordingParticipantDto>,
        notFound: String,
        personRefused: String?,
        send: suspend (RecordingsGateway) -> List<RecordingParticipantDto>,
    ) {
        val before = _state.value
        if (before.savingParticipants) return
        _state.update { it.copy(participants = optimistic, savingParticipants = true, message = null) }
        viewModelScope.launch {
            val failure = try {
                val gateway = sessions.gateway() ?: throw NotConnected()
                val answer = send(gateway)
                _state.update { it.copy(participants = answer, savingParticipants = false) }
                null
            } catch (_: NotConnected) {
                NOT_CONNECTED
            } catch (_: GatewayException.NotFound) {
                notFound
            } catch (e: GatewayException.ServerError) {
                if (e.status == 400 && personRefused != null) personRefused else SAVE_FAILED
            } catch (_: GatewayException) {
                SAVE_FAILED
            }
            if (failure != null) {
                _state.update {
                    it.copy(participants = before.participants, savingParticipants = false, message = failure)
                }
            }
        }
    }

    private class NotConnected : Exception()

    companion object {
        /** The picker or name target that adds someone present without a turn; speakers start at 1. */
        const val ALSO_PRESENT = 0
        const val ARG_RECORDING_ID = "recordingId"
        const val ARG_TITLE = "title"
        const val SEARCH_DEBOUNCE_MS = 300L
        const val SEARCH_LIMIT = 20
        private const val NOT_CONNECTED = "Reconnect to the gateway and try again."
        private const val SAVE_FAILED = "The change could not be saved. Try again."
    }
}

/** A participant's name, or a stand-in for a person whose name the gateway does not know. */
internal fun participantLabel(participant: RecordingParticipantDto): String =
    participant.name?.takeIf { it.isNotBlank() } ?: "Someone from your people"

/** "You", the speaker's name, or "Speaker N". */
internal fun speakerLabel(speaker: RecordingSpeakerDto): String =
    if (speaker.isSelf) "You" else speaker.name?.takeIf { it.isNotBlank() } ?: "Speaker ${speaker.speaker}"

/** How long someone spoke: "Under a minute", "4 min", "1 h 5 min". */
internal fun formatTalkTime(ms: Long): String {
    val minutes = ((ms + 30_000) / 60_000).coerceAtLeast(0)
    return when {
        ms < 60_000 -> "Under a minute"
        minutes < 60 -> "$minutes min"
        minutes % 60 == 0L -> "${minutes / 60} h"
        else -> "${minutes / 60} h ${minutes % 60} min"
    }
}
