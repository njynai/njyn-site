package ai.njyn.meetingnotes.selftest

import ai.njyn.meetingnotes.data.NoteFormat
import ai.njyn.meetingnotes.net.SummaryFormat
import ai.njyn.meetingnotes.record.PcmQueue
import ai.njyn.meetingnotes.record.TranscriptStitcher
import ai.njyn.meetingnotes.record.WavFile
import java.io.File
import java.nio.file.Files
import java.util.Calendar
import java.util.Date
import kotlin.math.sin
import org.json.JSONObject

internal var passed = 0
internal var failed = 0

internal fun test(name: String, body: () -> Unit) {
    try {
        body()
        passed++
        println("  ok   $name")
    } catch (e: Throwable) {
        failed++
        println("  FAIL $name\n       ${e.message}")
    }
}

internal fun check(condition: Boolean, message: String) {
    if (!condition) throw AssertionError(message)
}

internal fun <T> checkEquals(expected: T, actual: T) {
    if (expected != actual) throw AssertionError("expected <$expected> but was <$actual>")
}

/** A tone as Int16 mono at 16 kHz, so the WAV under test contains real audio. */
internal fun tone(seconds: Double): ByteArray {
    val samples = (seconds * WavFile.SAMPLE_RATE).toInt()
    val out = ByteArray(samples * 2)
    for (i in 0 until samples) {
        val value = (sin(2.0 * Math.PI * 440.0 * i / WavFile.SAMPLE_RATE) * 12000).toInt()
        out[i * 2] = (value and 0xFF).toByte()
        out[i * 2 + 1] = ((value shr 8) and 0xFF).toByte()
    }
    return out
}

private fun readHeader(file: File): Map<String, Int> {
    val head = file.readBytes().copyOfRange(0, WavFile.HEADER_BYTES)
    fun le32(at: Int) = (head[at].toInt() and 0xFF) or
        ((head[at + 1].toInt() and 0xFF) shl 8) or
        ((head[at + 2].toInt() and 0xFF) shl 16) or
        ((head[at + 3].toInt() and 0xFF) shl 24)
    fun le16(at: Int) = (head[at].toInt() and 0xFF) or ((head[at + 1].toInt() and 0xFF) shl 8)

    return mapOf(
        "riffSize" to le32(4),
        "channels" to le16(22),
        "sampleRate" to le32(24),
        "bitsPerSample" to le16(34),
        "dataBytes" to le32(40),
    )
}

fun main() {
    val tmp = Files.createTempDirectory("njyn-android-selftest").toFile()

    println("\nwav")

    test("writes a header a decoder can read back") {
        val file = File(tmp, "a.wav")
        WavFile.Writer(file).use { writer ->
            writer.write(tone(2.0), WavFile.SAMPLE_RATE * 2 * 2)
            check(
                Math.abs(writer.durationSeconds - 2.0) < 0.001,
                "duration tracked while writing, got ${writer.durationSeconds}",
            )
        }

        val header = readHeader(file)
        checkEquals(WavFile.SAMPLE_RATE, header["sampleRate"])
        checkEquals(1, header["channels"])
        checkEquals(16, header["bitsPerSample"])
        checkEquals(WavFile.SAMPLE_RATE * 2 * 2, header["dataBytes"])
        checkEquals((file.length() - 8).toInt(), header["riffSize"])
        checkEquals(WavFile.HEADER_BYTES + header["dataBytes"]!!, file.length().toInt())
    }

    test("streams many small writes without loss") {
        val file = File(tmp, "b.wav")
        val block = tone(0.01)
        WavFile.Writer(file).use { writer ->
            repeat(300) { writer.write(block, block.size) }
        }
        checkEquals(block.size * 300, readHeader(file)["dataBytes"])
    }

    test("reports duration of a file on disk") {
        val file = File(tmp, "c.wav")
        WavFile.Writer(file).use { it.write(tone(3.0), WavFile.SAMPLE_RATE * 3 * 2) }
        check(
            Math.abs(WavFile.durationSecondsOf(file) - 3.0) < 0.01,
            "expected ~3s, got ${WavFile.durationSecondsOf(file)}",
        )
    }

    test("splits a long recording into playable chunks that cover it all") {
        val file = File(tmp, "long.wav")
        WavFile.Writer(file).use { it.write(tone(30.0), WavFile.SAMPLE_RATE * 30 * 2) }

        val outDir = File(tmp, "chunks").apply { mkdirs() }
        val parts = WavFile.split(file, outDir, chunkSeconds = 10, overlapSeconds = 2)

        check(parts.size >= 3, "expected several chunks, got ${parts.size}")

        var covered = 0.0
        for (part in parts) {
            val header = readHeader(part)
            checkEquals(WavFile.SAMPLE_RATE, header["sampleRate"])
            checkEquals(
                WavFile.HEADER_BYTES + header["dataBytes"]!!,
                part.length().toInt(),
            )
            val seconds = header["dataBytes"]!!.toDouble() / WavFile.BYTES_PER_SECOND
            check(seconds <= 10.001, "chunk stays within the limit, got $seconds")
            covered += seconds
        }
        check(covered >= 30.0, "chunks cover the whole recording, got $covered")
    }

    test("short recordings are not split") {
        val file = File(tmp, "short.wav")
        WavFile.Writer(file).use { it.write(tone(5.0), WavFile.SAMPLE_RATE * 5 * 2) }
        checkEquals(listOf(file), WavFile.split(file, tmp, chunkSeconds = 600))
    }

    println("\npcm drift queue")

    test("returns what was written, in order") {
        val queue = PcmQueue(1024)
        queue.write(byteArrayOf(1, 2, 3, 4), 4)

        val out = ByteArray(4)
        checkEquals(4, queue.read(out, 4))
        checkEquals(listOf<Byte>(1, 2, 3, 4), out.toList())
        checkEquals(0, queue.size)
    }

    test("a short read is reported so the caller can pad with silence") {
        val queue = PcmQueue(1024)
        queue.write(byteArrayOf(9, 9), 2)
        checkEquals(2, queue.read(ByteArray(100), 100))
        checkEquals(0, queue.read(ByteArray(100), 100))
    }

    test("drops the oldest audio rather than drifting without bound") {
        val queue = PcmQueue(100)
        repeat(10) { round ->
            queue.write(ByteArray(50) { round.toByte() }, 50)
        }
        check(queue.size <= 100, "queue stays bounded, got ${queue.size}")

        // What survives must be the most recent audio, not the oldest.
        val out = ByteArray(100)
        val read = queue.read(out, 100)
        checkEquals(9.toByte(), out[read - 1])
    }

    test("survives interleaved reads and writes without corrupting data") {
        val queue = PcmQueue(WavFile.BYTES_PER_SECOND * 2)
        var next = 0
        var checked = 0
        val block = ByteArray(3200)
        val out = ByteArray(3200)

        repeat(200) {
            for (i in block.indices) block[i] = ((next + i) % 251).toByte()
            queue.write(block, block.size)
            next += block.size

            val read = queue.read(out, out.size)
            for (i in 0 until read) {
                checkEquals(((checked + i) % 251).toByte(), out[i])
            }
            checked += read
        }
        checkEquals(next, checked)
    }

    println("\ntranscript stitching")

    test("drops the duplicated overlap between chunks") {
        checkEquals(
            "we should ship the beta on friday and tell the team about the pricing change",
            TranscriptStitcher.stitch(
                listOf(
                    "we should ship the beta on friday and tell the team",
                    "and tell the team about the pricing change",
                ),
            ),
        )
    }

    test("keeps both halves when nothing overlaps") {
        checkEquals(
            "first part here second part here",
            TranscriptStitcher.stitch(listOf("first part here", "second part here")),
        )
    }

    test("handles a single chunk and empty pieces") {
        checkEquals("only one", TranscriptStitcher.stitch(listOf("only one")))
        checkEquals("real", TranscriptStitcher.stitch(listOf("", "  ", "real")))
        checkEquals("", TranscriptStitcher.stitch(emptyList()))
    }

    println("\nsummary rendering")

    test("renders summary, decisions and owners") {
        val md = SummaryFormat.render(
            JSONObject(
                """
                {"summary":["a","b","c","d","e"],
                 "decisions":["ship friday"],
                 "actions":[{"task":"update pricing page","owner":"Dana","due":"Aug 20"}]}
                """.trimIndent(),
            ),
        )
        check(md.contains("## Summary"), "has a summary heading")
        check(md.contains("## Decisions"), "has a decisions heading")
        check(md.contains("## Action items"), "has an action items heading")
        check(md.contains("**Dana** — update pricing page"), "names the owner")
        check(md.contains("_(due Aug 20)_"), "keeps the due date")
    }

    test("caps the summary at five bullets") {
        val md = SummaryFormat.render(
            JSONObject("""{"summary":["a","b","c","d","e","f","g"],"decisions":[],"actions":[]}"""),
        )
        checkEquals(5, md.lines().count { it.startsWith("- ") })
    }

    test("says so plainly when a section is empty") {
        val md = SummaryFormat.render(JSONObject("""{"summary":[],"decisions":[],"actions":[]}"""))
        check(md.contains("_No decisions were recorded._"), "admits there were no decisions")
        check(md.contains("_No action items were assigned._"), "admits there were no actions")
    }

    test("an action with no owner reads Unassigned, never a guess") {
        val md = SummaryFormat.render(
            JSONObject("""{"summary":[],"decisions":[],"actions":[{"task":"book the venue"}]}"""),
        )
        check(md.contains("**Unassigned** — book the venue"), "owner defaults to Unassigned")
    }

    test("extracts JSON from fenced or chatty responses") {
        checkEquals(1, SummaryFormat.extractJson("```json\n{\"a\":1}\n```")?.optInt("a"))
        checkEquals(2, SummaryFormat.extractJson("Sure! {\"a\":2} hope that helps")?.optInt("a"))
        checkEquals(null, SummaryFormat.extractJson("no json at all"))
        checkEquals(null, SummaryFormat.extractJson("{ broken: "))
    }

    println("\nnote formatting")

    test("names files YYYY-MM-DD-HHMM") {
        val calendar = Calendar.getInstance().apply { set(2026, Calendar.AUGUST, 15, 14, 30, 0) }
        checkEquals("2026-08-15-1430", NoteFormat.stampFor(calendar.time))
    }

    test("formats durations") {
        checkEquals("0m 45s", NoteFormat.formatDuration(45.0))
        checkEquals("30m 30s", NoteFormat.formatDuration(1830.0))
        checkEquals("1h 02m 05s", NoteFormat.formatDuration(3725.0))
    }

    test("summary sits above the divider and the transcript below") {
        val md = NoteFormat.buildMarkdown(
            stamp = "2026-08-15-1430",
            startedAt = Date(),
            durationSeconds = 1830.0,
            title = "Pricing review",
            summaryMarkdown = SummaryFormat.render(
                JSONObject("""{"summary":["a"],"decisions":["b"],"actions":[]}"""),
            ),
            summaryError = null,
            transcript = "THE FULL TRANSCRIPT TEXT",
            transcriptEngine = "groq whisper-large-v3",
            llmModel = "anthropic/claude-sonnet-5",
            audioFile = "2026-08-15-1430.wav",
        )

        val divider = md.indexOf("\n---\n", md.indexOf("## Summary"))
        check(divider > -1, "there is a divider after the summary")
        check(md.indexOf("## Summary") < divider, "summary is above the divider")
        check(md.indexOf("THE FULL TRANSCRIPT TEXT") > divider, "transcript is below it")
        check(md.contains("audio: 2026-08-15-1430.wav"), "front matter points at the audio")
        check(md.contains("# Pricing review"), "uses the model's title")
        check(md.contains("30m 30s"), "records the duration")
    }

    test("a failed summary still saves the transcript") {
        val md = NoteFormat.buildMarkdown(
            stamp = "2026-08-15-1430",
            startedAt = Date(),
            durationSeconds = 60.0,
            title = null,
            summaryMarkdown = "",
            summaryError = "no API key",
            transcript = "STILL HERE",
            transcriptEngine = "failed",
            llmModel = null,
            audioFile = "x.wav",
        )
        check(md.contains("Summary unavailable: no API key"), "explains what went wrong")
        check(md.contains("STILL HERE"), "keeps the transcript regardless")
    }

    println("\nhttp")
    runHttpTests(tmp)

    tmp.deleteRecursively()

    println("\n$passed passed, $failed failed\n")
    if (failed > 0) kotlin.system.exitProcess(1)
}
