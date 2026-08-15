package ai.njyn.meetingnotes.record

import java.io.File
import java.io.RandomAccessFile

/**
 * 16-bit PCM WAV writing and splitting.
 *
 * Audio is written at 16 kHz mono - the format Whisper wants - so nothing has
 * to be transcoded after the meeting ends.
 */
object WavFile {

    const val SAMPLE_RATE = 16_000
    const val CHANNELS = 1
    const val BITS_PER_SAMPLE = 16
    const val HEADER_BYTES = 44

    /** Bytes of PCM per second of audio. */
    const val BYTES_PER_SECOND = SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE / 8

    fun header(dataBytes: Int, sampleRate: Int = SAMPLE_RATE, channels: Int = CHANNELS): ByteArray {
        val byteRate = sampleRate * channels * BITS_PER_SAMPLE / 8
        val blockAlign = channels * BITS_PER_SAMPLE / 8
        val out = ByteArray(HEADER_BYTES)

        fun ascii(at: Int, text: String) {
            for (i in text.indices) out[at + i] = text[i].code.toByte()
        }
        fun le32(at: Int, value: Int) {
            out[at] = value.toByte()
            out[at + 1] = (value shr 8).toByte()
            out[at + 2] = (value shr 16).toByte()
            out[at + 3] = (value shr 24).toByte()
        }
        fun le16(at: Int, value: Int) {
            out[at] = value.toByte()
            out[at + 1] = (value shr 8).toByte()
        }

        ascii(0, "RIFF")
        le32(4, 36 + dataBytes)
        ascii(8, "WAVE")
        ascii(12, "fmt ")
        le32(16, 16)
        le16(20, 1) // PCM
        le16(22, channels)
        le32(24, sampleRate)
        le32(28, byteRate)
        le16(32, blockAlign)
        le16(34, BITS_PER_SAMPLE)
        ascii(36, "data")
        le32(40, dataBytes)
        return out
    }

    /**
     * Appends PCM to disk as it is captured, then patches the length fields on
     * close, so a two-hour meeting never has to fit in memory.
     */
    class Writer(val file: File) : AutoCloseable {
        private val raf = RandomAccessFile(file, "rw")
        var dataBytes: Int = 0
            private set
        private var closed = false

        init {
            file.parentFile?.mkdirs()
            raf.setLength(0)
            raf.write(header(0))
        }

        fun write(buffer: ByteArray, length: Int) {
            if (closed || length <= 0) return
            raf.write(buffer, 0, length)
            dataBytes += length
        }

        val durationSeconds: Double
            get() = dataBytes.toDouble() / BYTES_PER_SECOND

        override fun close() {
            if (closed) return
            closed = true
            raf.seek(0)
            raf.write(header(dataBytes))
            raf.close()
        }
    }

    fun durationSecondsOf(file: File): Double =
        ((file.length() - HEADER_BYTES).coerceAtLeast(0)).toDouble() / BYTES_PER_SECOND

    /**
     * Split a recording into standalone WAV files of at most [chunkSeconds].
     *
     * Hosted Whisper endpoints cap uploads at 25 MB, which at this bitrate is
     * about 12 minutes - so any real meeting needs splitting. Chunks overlap by
     * [overlapSeconds] so a word cut in half is still transcribed once; the
     * duplicate is removed when the pieces are stitched back together.
     */
    fun split(
        source: File,
        outDir: File,
        chunkSeconds: Int = 600,
        overlapSeconds: Int = 2,
    ): List<File> {
        val dataBytes = (source.length() - HEADER_BYTES).coerceAtLeast(0).toInt()
        val chunkBytes = align(chunkSeconds * BYTES_PER_SECOND)
        if (dataBytes <= chunkBytes) return listOf(source)

        val overlapBytes = align(overlapSeconds * BYTES_PER_SECOND)
        val step = (chunkBytes - overlapBytes).coerceAtLeast(align(BYTES_PER_SECOND))

        outDir.mkdirs()
        val parts = mutableListOf<File>()

        RandomAccessFile(source, "r").use { input ->
            var offset = 0
            var index = 0
            while (offset < dataBytes) {
                val length = minOf(chunkBytes, dataBytes - offset)
                val pcm = ByteArray(length)
                input.seek((HEADER_BYTES + offset).toLong())
                input.readFully(pcm)

                val part = File(outDir, "chunk-%03d.wav".format(index))
                part.outputStream().use { out ->
                    out.write(header(length))
                    out.write(pcm)
                }
                parts += part

                index++
                offset += step
            }
        }
        return parts
    }

    /** Round down to a whole 16-bit mono sample so chunks never split a sample. */
    private fun align(bytes: Int): Int = bytes - (bytes % (CHANNELS * BITS_PER_SAMPLE / 8))
}
