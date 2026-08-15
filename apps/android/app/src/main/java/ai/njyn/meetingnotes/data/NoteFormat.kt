package ai.njyn.meetingnotes.data

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * What a saved note looks like: front matter, the summary, a divider, then the
 * full transcript verbatim. Matches the desktop app byte for byte in structure,
 * so notes from a laptop and a phone sit in the same folder and read the same.
 *
 * Deliberately free of Android dependencies so it can be exercised on a plain
 * JVM - see tools/jvm-selftest.
 */
object NoteFormat {

    private val STAMP_FORMAT = SimpleDateFormat("yyyy-MM-dd-HHmm", Locale.US)
    private val WHEN_FORMAT = SimpleDateFormat("EEE d MMM yyyy, HH:mm", Locale.getDefault())
    private val ISO_FORMAT = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssZ", Locale.US)

    /** Local-time stamp, YYYY-MM-DD-HHMM - the note's file name. */
    fun stampFor(date: Date): String = STAMP_FORMAT.format(date)

    fun formatDuration(seconds: Double): String {
        val total = seconds.toInt()
        val h = total / 3600
        val m = (total % 3600) / 60
        val s = total % 60
        return if (h > 0) "%dh %02dm %02ds".format(h, m, s) else "%dm %02ds".format(m, s)
    }

    /**
     * If summarising failed, the reason is written in place of the summary and
     * the transcript is still saved - a failed API call must never cost you the
     * record of the meeting.
     */
    fun buildMarkdown(
        stamp: String,
        startedAt: Date,
        durationSeconds: Double,
        title: String?,
        summaryMarkdown: String,
        summaryError: String?,
        transcript: String,
        transcriptEngine: String,
        llmModel: String?,
        audioFile: String?,
    ): String = buildString {
        appendLine("---")
        appendLine("date: $stamp")
        appendLine("started: ${ISO_FORMAT.format(startedAt)}")
        appendLine("duration: ${formatDuration(durationSeconds)}")
        appendLine("audio: ${audioFile ?: "not kept"}")
        appendLine("transcription: $transcriptEngine")
        appendLine("summary_model: ${llmModel ?: "none"}")
        appendLine("device: android")
        appendLine("---")
        appendLine()

        appendLine("# ${title ?: "Meeting notes"}")
        appendLine("_${WHEN_FORMAT.format(startedAt)} · ${formatDuration(durationSeconds)}_")
        appendLine()

        if (summaryError != null) {
            appendLine("## Summary")
            appendLine()
            appendLine("> Summary unavailable: $summaryError")
            appendLine(">")
            appendLine("> The full transcript is below and can be summarised later.")
        } else {
            appendLine(summaryMarkdown)
        }

        appendLine()
        appendLine("---")
        appendLine()
        appendLine("## Transcript")
        appendLine()
        appendLine(transcript.ifBlank { "_No speech was transcribed._" })
    }
}
