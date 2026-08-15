package ai.njyn.meetingnotes.net

import ai.njyn.meetingnotes.data.Settings
import ai.njyn.meetingnotes.record.TranscriptStitcher
import ai.njyn.meetingnotes.record.WavFile
import java.io.File

/**
 * Audio -> text, via a hosted Whisper endpoint.
 *
 * Unlike the desktop app there is no local path here: whisper.cpp on Android
 * means an NDK build shipped inside the APK, which this app does not do. If you
 * need transcription that never leaves the device, use the desktop app. The
 * README says so plainly rather than letting you discover it mid-meeting.
 */
class Transcriber(private val settings: Settings) {

    data class Result(val text: String, val engine: String)

    private data class Endpoint(val url: String, val model: String)

    /**
     * @param onProgress percent complete, 0..100
     */
    fun transcribe(wav: File, workDir: File, onProgress: (Int) -> Unit): Result {
        val provider = settings.transcribeProvider
            ?: throw IllegalStateException(
                "No transcription key. Add a Groq or OpenAI key in Settings, " +
                    "or import the .env you already use on the desktop.",
            )

        val endpoint = endpointFor(provider)
        val key = settings.keyFor(provider)

        val parts = if (wav.length() <= MAX_UPLOAD_BYTES) {
            listOf(wav)
        } else {
            WavFile.split(wav, workDir, chunkSeconds = CHUNK_SECONDS)
        }

        val pieces = mutableListOf<String>()
        try {
            parts.forEachIndexed { index, part ->
                pieces += upload(endpoint, key, part)
                onProgress(((index + 1) * 100) / parts.size)
            }
        } finally {
            // Chunks are scratch; the real recording lives elsewhere.
            parts.filter { it != wav }.forEach { it.delete() }
        }

        return Result(TranscriptStitcher.stitch(pieces), "$provider ${endpoint.model}")
    }

    private fun upload(endpoint: Endpoint, key: String, file: File): String =
        Http.postMultipartFile(
            url = endpoint.url,
            headers = mapOf("Authorization" to "Bearer $key"),
            file = file,
            fields = mapOf("model" to endpoint.model, "response_format" to "text"),
        ).trim()

    private fun endpointFor(provider: String) = when (provider) {
        "groq" -> Endpoint(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            "whisper-large-v3",
        )
        else -> Endpoint("https://api.openai.com/v1/audio/transcriptions", "whisper-1")
    }

    private companion object {
        const val MAX_UPLOAD_BYTES = 24L * 1024 * 1024
        const val CHUNK_SECONDS = 600
    }
}
