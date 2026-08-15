package ai.njyn.meetingnotes.record

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * The single source of truth for what the recorder is doing, shared between the
 * foreground service that owns the microphone and whatever UI happens to be on
 * screen. Nothing here is persisted or transmitted.
 */
object RecorderState {

    enum class Phase { IDLE, RECORDING, PROCESSING }

    data class State(
        val phase: Phase = Phase.IDLE,
        val startedAtMs: Long = 0L,
        /** Peak level of the mixed signal, 0..1, for the meter. */
        val level: Float = 0f,
        val micOn: Boolean = false,
        val systemOn: Boolean = false,
        val stage: String? = null,
        val percent: Int? = null,
        val lastNoteName: String? = null,
        val lastError: String? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state

    fun update(transform: (State) -> State) {
        _state.value = transform(_state.value)
    }

    fun recordingStarted(micOn: Boolean, systemOn: Boolean, startedAtMs: Long) = update {
        State(
            phase = Phase.RECORDING,
            startedAtMs = startedAtMs,
            micOn = micOn,
            systemOn = systemOn,
            lastNoteName = it.lastNoteName,
        )
    }

    fun processing(stage: String, percent: Int? = null) = update {
        it.copy(phase = Phase.PROCESSING, stage = stage, percent = percent, level = 0f)
    }

    fun finished(noteName: String?, error: String?) = update {
        State(phase = Phase.IDLE, lastNoteName = noteName ?: it.lastNoteName, lastError = error)
    }

    fun clearError() = update { it.copy(lastError = null) }
}
