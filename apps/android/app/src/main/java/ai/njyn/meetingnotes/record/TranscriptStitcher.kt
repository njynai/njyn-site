package ai.njyn.meetingnotes.record

/**
 * Rejoins the transcripts of overlapping audio chunks.
 *
 * Long recordings are uploaded in pieces that deliberately overlap, so a word
 * landing on a chunk boundary is transcribed in full at least once. That leaves
 * a duplicated run of words where two pieces meet, which is what this removes.
 *
 * Deliberately free of Android dependencies so it can be exercised on a plain
 * JVM - see tools/jvm-selftest.
 */
object TranscriptStitcher {

    /** Longest run of words considered when looking for a duplicate. */
    private const val MAX_OVERLAP_WORDS = 20

    /** Shortest run that counts - below this, matches are coincidence. */
    private const val MIN_OVERLAP_WORDS = 3

    fun stitch(pieces: List<String>): String {
        val clean = pieces.map { it.trim() }.filter { it.isNotEmpty() }
        if (clean.size <= 1) return clean.joinToString(" ")

        var out = clean.first()
        for (i in 1 until clean.size) {
            val prevWords = out.split(WHITESPACE)
            val nextWords = clean[i].split(WHITESPACE)
            val window = minOf(MAX_OVERLAP_WORDS, prevWords.size, nextWords.size)

            var overlap = 0
            for (n in window downTo MIN_OVERLAP_WORDS) {
                val tail = prevWords.takeLast(n).joinToString(" ").lowercase()
                val head = nextWords.take(n).joinToString(" ").lowercase()
                if (tail == head) {
                    overlap = n
                    break
                }
            }
            out = (out + " " + nextWords.drop(overlap).joinToString(" ")).trim()
        }
        return out
    }

    private val WHITESPACE = Regex("\\s+")
}
