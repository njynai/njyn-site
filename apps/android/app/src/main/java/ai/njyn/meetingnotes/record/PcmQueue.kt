package ai.njyn.meetingnotes.record

/**
 * A small byte queue used to absorb the timing difference between the two audio
 * sources.
 *
 * The microphone and the system-audio capture are separate AudioRecord streams
 * clocked independently, so they never deliver exactly the same number of bytes
 * per read. The microphone drives the mixing loop and system audio is buffered
 * here until it is needed. If the buffer grows past [maxBytes] - which means
 * system audio is running ahead and would otherwise drift further and further
 * behind the mic - the oldest audio is dropped to resynchronise.
 */
class PcmQueue(private val maxBytes: Int) {

    private var buffer = ByteArray(maxBytes.coerceAtLeast(8192))
    private var head = 0
    private var tail = 0

    val size: Int get() = tail - head

    fun write(source: ByteArray, length: Int) {
        if (length <= 0) return

        compactIfNeeded(length)
        if (tail + length > buffer.size) {
            buffer = buffer.copyOf(maxOf(buffer.size * 2, tail + length))
        }

        System.arraycopy(source, 0, buffer, tail, length)
        tail += length

        // Drop the oldest audio if we have fallen too far behind.
        if (size > maxBytes) head = tail - maxBytes
    }

    /**
     * Copy up to [length] bytes into [destination], returning how many were
     * available. The caller treats anything short as silence.
     */
    fun read(destination: ByteArray, length: Int): Int {
        val available = minOf(length, size)
        if (available <= 0) return 0

        System.arraycopy(buffer, head, destination, 0, available)
        head += available
        return available
    }

    fun clear() {
        head = 0
        tail = 0
    }

    private fun compactIfNeeded(incoming: Int) {
        if (head == 0) return
        if (tail + incoming <= buffer.size) return

        System.arraycopy(buffer, head, buffer, 0, size)
        tail = size
        head = 0
    }
}
