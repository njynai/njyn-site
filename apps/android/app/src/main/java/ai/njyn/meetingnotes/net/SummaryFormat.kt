package ai.njyn.meetingnotes.net

import org.json.JSONArray
import org.json.JSONObject

/**
 * The summarising prompt, and how the model's answer becomes markdown.
 *
 * Deliberately free of Android dependencies so it can be exercised on a plain
 * JVM - see tools/jvm-selftest.
 */
object SummaryFormat {

    /** Kept identical to the desktop prompt so notes read the same on both. */
    const val PROMPT = """You are a meeting scribe. You are given a raw, unedited transcript of a meeting. It comes from automatic speech recognition, so expect misheard words, missing punctuation, and no reliable speaker labels.

Produce notes for someone who did not attend.

Return ONLY a JSON object, no code fences and no commentary, with exactly this shape:

{
  "title": "short descriptive title for the meeting, max 8 words",
  "summary": ["exactly 5 bullets"],
  "decisions": ["each decision that was actually settled"],
  "actions": [{"task": "what must be done", "owner": "who owns it", "due": "when, or empty string"}]
}

Rules:
- "summary" must contain exactly 5 bullets. Each is one sentence covering what was discussed and why it mattered. Do not pad with filler; if the meeting was short, make the bullets narrower rather than inventing content.
- "decisions" lists only things that were settled. If something was debated and left open, it is not a decision. Return an empty array if nothing was decided.
- "actions" lists concrete commitments. Set "owner" to the name used in the transcript. If no owner was named, use "Unassigned" - never guess a person. Set "due" to "" if no date was mentioned.
- Never invent names, numbers, dates, or commitments that are not in the transcript. If the transcript is too garbled or too short to support a field, return an empty array for it.
- Write in plain, direct language. No preamble."""

    /** Pull a JSON object out of a response that may be fenced or chatty. */
    fun extractJson(text: String): JSONObject? {
        val fence = Regex("```(?:json)?\\s*([\\s\\S]*?)```").find(text)
        val candidate = fence?.groupValues?.get(1) ?: text

        val start = candidate.indexOf('{')
        val end = candidate.lastIndexOf('}')
        if (start == -1 || end <= start) return null

        return try {
            JSONObject(candidate.substring(start, end + 1))
        } catch (_: Exception) {
            null
        }
    }

    fun render(parsed: JSONObject): String {
        val summary = parsed.optJSONArray("summary").toStringList().take(5)
        val decisions = parsed.optJSONArray("decisions").toStringList()

        return buildString {
            appendLine("## Summary")
            appendLine(bullets(summary, "No summary could be produced from this transcript."))
            appendLine()
            appendLine("## Decisions")
            appendLine(bullets(decisions, "No decisions were recorded."))
            appendLine()
            appendLine("## Action items")
            append(renderActions(parsed.optJSONArray("actions")))
        }
    }

    private fun bullets(items: List<String>, empty: String): String =
        if (items.isEmpty()) "_${empty}_" else items.joinToString("\n") { "- ${it.trim()}" }

    private fun renderActions(actions: JSONArray?): String {
        if (actions == null || actions.length() == 0) return NO_ACTIONS

        return (0 until actions.length()).mapNotNull { i ->
            val item = actions.optJSONObject(i) ?: return@mapNotNull null
            val task = item.optString("task").trim()
            if (task.isEmpty()) return@mapNotNull null

            // An unnamed owner stays unnamed. Guessing who owns an action item
            // is worse than admitting nobody was assigned.
            val owner = item.optString("owner").trim().ifBlank { "Unassigned" }
            val due = item.optString("due").trim()

            "- **$owner** — $task" + if (due.isNotEmpty()) " _(due $due)_" else ""
        }.joinToString("\n").ifBlank { NO_ACTIONS }
    }

    private fun JSONArray?.toStringList(): List<String> {
        if (this == null) return emptyList()
        return (0 until length()).mapNotNull { optString(it).takeIf { s -> s.isNotBlank() } }
    }

    private const val NO_ACTIONS = "_No action items were assigned._"
}
