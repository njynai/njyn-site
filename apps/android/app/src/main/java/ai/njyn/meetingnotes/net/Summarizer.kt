package ai.njyn.meetingnotes.net

import ai.njyn.meetingnotes.data.Settings
import org.json.JSONArray
import org.json.JSONObject

/**
 * Transcript -> structured meeting notes.
 *
 * Same prompt as the desktop app, so a meeting recorded on either device
 * produces a note in the same shape.
 */
class Summarizer(private val settings: Settings) {

    data class Result(val title: String?, val markdown: String, val model: String)

    fun summarize(transcript: String): Result {
        val provider = settings.llmProvider
            ?: throw IllegalStateException(
                "No LLM key. Add an Anthropic, OpenAI or Groq key in Settings to get " +
                    "summaries. The transcript is saved either way.",
            )
        val model = settings.llmModel
        val key = settings.keyFor(provider)

        val raw = when (provider) {
            "anthropic" -> callAnthropic(key, model, transcript)
            "openai" -> callOpenAiCompatible(
                "https://api.openai.com/v1/chat/completions", key, model, transcript,
            )
            else -> callOpenAiCompatible(
                "https://api.groq.com/openai/v1/chat/completions", key, model, transcript,
            )
        }

        val parsed = SummaryFormat.extractJson(raw)
            // Model went off-script. Keep what it said rather than losing the work.
            ?: return Result(null, "## Summary\n\n$raw", "$provider/$model")

        return Result(
            title = parsed.optString("title").takeIf { it.isNotBlank() },
            markdown = SummaryFormat.render(parsed),
            model = "$provider/$model",
        )
    }

    /* ---------------------------------------------------------- providers */

    private fun callAnthropic(key: String, model: String, transcript: String): String {
        val body = JSONObject()
            .put("model", model)
            .put("max_tokens", 2000)
            .put("system", PROMPT)
            .put(
                "messages",
                JSONArray().put(
                    JSONObject()
                        .put("role", "user")
                        .put("content", "<transcript>\n$transcript\n</transcript>"),
                ),
            )

        val response = Http.postJson(
            "https://api.anthropic.com/v1/messages",
            mapOf("x-api-key" to key, "anthropic-version" to "2023-06-01"),
            body.toString(),
        )

        val content = JSONObject(response).optJSONArray("content") ?: return ""
        return buildString {
            for (i in 0 until content.length()) {
                append(content.optJSONObject(i)?.optString("text").orEmpty())
            }
        }.trim()
    }

    private fun callOpenAiCompatible(
        url: String,
        key: String,
        model: String,
        transcript: String,
    ): String {
        val messages = JSONArray()
            .put(JSONObject().put("role", "system").put("content", PROMPT))
            .put(
                JSONObject()
                    .put("role", "user")
                    .put("content", "<transcript>\n$transcript\n</transcript>"),
            )

        val body = JSONObject()
            .put("model", model)
            .put("max_tokens", 2000)
            .put("messages", messages)

        val response = Http.postJson(url, mapOf("Authorization" to "Bearer $key"), body.toString())

        return JSONObject(response)
            .optJSONArray("choices")
            ?.optJSONObject(0)
            ?.optJSONObject("message")
            ?.optString("content")
            .orEmpty()
            .trim()
    }

    private companion object {
        val PROMPT = SummaryFormat.PROMPT
    }
}
