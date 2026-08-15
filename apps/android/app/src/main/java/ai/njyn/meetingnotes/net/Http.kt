package ai.njyn.meetingnotes.net

import java.io.File
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * The whole HTTP layer, built on the JDK client so the app ships no networking
 * dependency. Every request in this app goes through here, and every one of
 * them is a call you configured with your own API key.
 */
object Http {

    private const val CONNECT_TIMEOUT_MS = 30_000
    private const val READ_TIMEOUT_MS = 300_000 // long meetings take a while

    class HttpFailure(val status: Int, val body: String) :
        Exception("HTTP $status: ${body.take(400)}")

    fun postJson(url: String, headers: Map<String, String>, json: String): String {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
            headers.forEach { (k, v) -> setRequestProperty(k, v) }
        }
        return conn.use {
            it.outputStream.use { out -> out.write(json.toByteArray(Charsets.UTF_8)) }
            it.readBody()
        }
    }

    /**
     * Multipart upload of a WAV file plus simple text fields. Streams the file
     * off disk rather than buffering it, so a long recording does not have to
     * fit in memory twice.
     */
    fun postMultipartFile(
        url: String,
        headers: Map<String, String>,
        file: File,
        fields: Map<String, String>,
    ): String {
        val boundary = "----njyn${System.nanoTime()}"
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            doOutput = true
            setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
            headers.forEach { (k, v) -> setRequestProperty(k, v) }
            setFixedLengthStreamingMode(multipartLength(boundary, file, fields))
        }

        return conn.use {
            it.outputStream.buffered().use { out ->
                fields.forEach { (name, value) -> out.writeField(boundary, name, value) }
                out.writeFileHeader(boundary, file)
                file.inputStream().use { input -> input.copyTo(out) }
                out.writeAscii("\r\n--$boundary--\r\n")
            }
            it.readBody()
        }
    }

    /* ------------------------------------------------------------ plumbing */

    private fun OutputStream.writeAscii(text: String) = write(text.toByteArray(Charsets.UTF_8))

    private fun OutputStream.writeField(boundary: String, name: String, value: String) =
        writeAscii("--$boundary\r\nContent-Disposition: form-data; name=\"$name\"\r\n\r\n$value\r\n")

    private fun OutputStream.writeFileHeader(boundary: String, file: File) = writeAscii(
        "--$boundary\r\n" +
            "Content-Disposition: form-data; name=\"file\"; filename=\"${file.name}\"\r\n" +
            "Content-Type: audio/wav\r\n\r\n",
    )

    /** Exact byte count of the multipart body, needed for streaming mode. */
    private fun multipartLength(boundary: String, file: File, fields: Map<String, String>): Long {
        var total = 0L
        fields.forEach { (name, value) ->
            total += "--$boundary\r\nContent-Disposition: form-data; name=\"$name\"\r\n\r\n$value\r\n"
                .toByteArray(Charsets.UTF_8).size
        }
        total += (
            "--$boundary\r\nContent-Disposition: form-data; name=\"file\"; " +
                "filename=\"${file.name}\"\r\nContent-Type: audio/wav\r\n\r\n"
            ).toByteArray(Charsets.UTF_8).size
        total += file.length()
        total += "\r\n--$boundary--\r\n".toByteArray(Charsets.UTF_8).size
        return total
    }

    private fun HttpURLConnection.readBody(): String {
        val status = responseCode
        if (status !in 200..299) {
            val detail = errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
            throw HttpFailure(status, detail)
        }
        return inputStream.bufferedReader().use { it.readText() }
    }

    private inline fun <T> HttpURLConnection.use(block: (HttpURLConnection) -> T): T =
        try {
            block(this)
        } finally {
            disconnect()
        }
}
