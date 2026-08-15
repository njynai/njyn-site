package ai.njyn.meetingnotes.data

import android.content.Context
import android.net.Uri
import androidx.core.content.edit

/**
 * Configuration, stored in app-private preferences on this device.
 *
 * The desktop app reads a .env file. Android sandboxes app storage, so there is
 * no equivalent path to watch - but the same .env can be imported through the
 * document picker so one file configures both.
 */
class Settings(private val context: Context) {

    private val prefs = context.getSharedPreferences("njyn", Context.MODE_PRIVATE)

    var anthropicKey: String
        get() = prefs.getString(KEY_ANTHROPIC, "").orEmpty()
        set(value) = prefs.edit { putString(KEY_ANTHROPIC, value.trim()) }

    var openaiKey: String
        get() = prefs.getString(KEY_OPENAI, "").orEmpty()
        set(value) = prefs.edit { putString(KEY_OPENAI, value.trim()) }

    var groqKey: String
        get() = prefs.getString(KEY_GROQ, "").orEmpty()
        set(value) = prefs.edit { putString(KEY_GROQ, value.trim()) }

    /** Whether to also attempt system-audio capture alongside the microphone. */
    var captureSystemAudio: Boolean
        get() = prefs.getBoolean(KEY_CAPTURE_SYSTEM, true)
        set(value) = prefs.edit { putBoolean(KEY_CAPTURE_SYSTEM, value) }

    var keepAudio: Boolean
        get() = prefs.getBoolean(KEY_KEEP_AUDIO, true)
        set(value) = prefs.edit { putBoolean(KEY_KEEP_AUDIO, value) }

    /** Hosted Whisper provider. Android has no local whisper.cpp build. */
    val transcribeProvider: String?
        get() = when {
            groqKey.isNotBlank() -> "groq"
            openaiKey.isNotBlank() -> "openai"
            else -> null
        }

    /** Summariser provider, preferring Anthropic, then OpenAI, then Groq. */
    val llmProvider: String?
        get() = when {
            anthropicKey.isNotBlank() -> "anthropic"
            openaiKey.isNotBlank() -> "openai"
            groqKey.isNotBlank() -> "groq"
            else -> null
        }

    val llmModel: String
        get() = when (llmProvider) {
            "anthropic" -> "claude-sonnet-5"
            "openai" -> "gpt-4o-mini"
            else -> "llama-3.3-70b-versatile"
        }

    fun keyFor(provider: String): String = when (provider) {
        "anthropic" -> anthropicKey
        "openai" -> openaiKey
        "groq" -> groqKey
        else -> ""
    }

    val isConfigured: Boolean
        get() = transcribeProvider != null

    /**
     * Import the same .env the desktop app uses. Only the keys this app
     * understands are read; everything else in the file is ignored.
     *
     * @return the number of keys that were set.
     */
    fun importEnv(uri: Uri): Int {
        val text = context.contentResolver.openInputStream(uri)?.use {
            it.readBytes().toString(Charsets.UTF_8)
        } ?: return 0

        var applied = 0
        for (rawLine in text.lineSequence()) {
            val line = rawLine.trim()
            if (line.isEmpty() || line.startsWith("#")) continue

            val eq = line.indexOf('=')
            if (eq <= 0) continue

            val key = line.substring(0, eq).trim().removePrefix("export ").trim()
            var value = line.substring(eq + 1).trim()
            if (value.length > 1 &&
                ((value.startsWith("\"") && value.endsWith("\"")) ||
                    (value.startsWith("'") && value.endsWith("'")))
            ) {
                value = value.substring(1, value.length - 1)
            }
            if (value.isBlank()) continue

            when (key) {
                "ANTHROPIC_API_KEY" -> { anthropicKey = value; applied++ }
                "OPENAI_API_KEY" -> { openaiKey = value; applied++ }
                "GROQ_API_KEY" -> { groqKey = value; applied++ }
                "KEEP_AUDIO" -> { keepAudio = !value.equals("false", true); applied++ }
            }
        }
        return applied
    }

    private companion object {
        const val KEY_ANTHROPIC = "anthropic_key"
        const val KEY_OPENAI = "openai_key"
        const val KEY_GROQ = "groq_key"
        const val KEY_CAPTURE_SYSTEM = "capture_system"
        const val KEY_KEEP_AUDIO = "keep_audio"
    }
}
