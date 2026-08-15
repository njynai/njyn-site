package ai.njyn.meetingnotes.selftest

import ai.njyn.meetingnotes.net.Http
import ai.njyn.meetingnotes.record.WavFile
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.io.File
import java.net.InetSocketAddress

/**
 * Exercises the HTTP layer against a real local server.
 *
 * The multipart upload declares its own Content-Length up front
 * (setFixedLengthStreamingMode), so an off-by-one in that calculation would
 * either truncate the audio or hang the request. That is worth checking against
 * a socket rather than by reading the arithmetic.
 */

private class Captured {
    var method: String? = null
    var contentType: String? = null
    var contentLength: Int = -1
    var body: ByteArray = ByteArray(0)
    var authorization: String? = null
}

private fun serve(handler: (HttpExchange) -> Unit): HttpServer =
    HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
        createContext("/") { exchange ->
            try {
                handler(exchange)
            } finally {
                exchange.close()
            }
        }
        executor = null
        start()
    }

private fun HttpExchange.reply(status: Int, body: String) {
    val bytes = body.toByteArray()
    sendResponseHeaders(status, bytes.size.toLong())
    responseBody.write(bytes)
}

fun runHttpTests(tmp: File) {
    test("multipart upload sends the whole file with an exact Content-Length") {
        val wav = File(tmp, "upload.wav")
        WavFile.Writer(wav).use { it.write(tone(1.5), WavFile.SAMPLE_RATE * 3) }

        val captured = Captured()
        val server = serve { exchange ->
            captured.method = exchange.requestMethod
            captured.contentType = exchange.requestHeaders.getFirst("Content-Type")
            captured.authorization = exchange.requestHeaders.getFirst("Authorization")
            captured.contentLength =
                exchange.requestHeaders.getFirst("Content-Length")?.toInt() ?: -1
            captured.body = exchange.requestBody.readBytes()
            exchange.reply(200, "the transcript")
        }

        try {
            val response = Http.postMultipartFile(
                url = "http://127.0.0.1:${server.address.port}/v1/audio/transcriptions",
                headers = mapOf("Authorization" to "Bearer test-key"),
                file = wav,
                fields = mapOf("model" to "whisper-large-v3", "response_format" to "text"),
            )
            checkEquals("the transcript", response)
        } finally {
            server.stop(0)
        }

        checkEquals("POST", captured.method)
        checkEquals("Bearer test-key", captured.authorization)
        check(
            captured.contentType?.startsWith("multipart/form-data; boundary=") == true,
            "declares a multipart content type, got ${captured.contentType}",
        )

        // The declared length must match what actually arrived, exactly.
        checkEquals(captured.body.size, captured.contentLength)

        val text = captured.body.toString(Charsets.ISO_8859_1)
        check(text.contains("name=\"model\""), "sends the model field")
        check(text.contains("whisper-large-v3"), "sends the model name")
        check(text.contains("name=\"response_format\""), "sends the response format")
        check(text.contains("filename=\"upload.wav\""), "sends the file name")
        check(text.contains("Content-Type: audio/wav"), "declares the audio type")

        // Every byte of the WAV must survive the round trip, header included.
        val wavBytes = wav.readBytes()
        val marker = "Content-Type: audio/wav\r\n\r\n"
        val start = text.indexOf(marker) + marker.length
        val payload = captured.body.copyOfRange(start, start + wavBytes.size)
        check(payload.contentEquals(wavBytes), "the uploaded audio is byte-identical")
    }

    test("json post round-trips headers and body") {
        var receivedBody = ""
        var receivedKey: String? = null
        var receivedVersion: String? = null

        val server = serve { exchange ->
            receivedBody = exchange.requestBody.readBytes().toString(Charsets.UTF_8)
            receivedKey = exchange.requestHeaders.getFirst("X-Api-Key")
            receivedVersion = exchange.requestHeaders.getFirst("Anthropic-Version")
            exchange.reply(200, """{"ok":true}""")
        }

        try {
            val response = Http.postJson(
                "http://127.0.0.1:${server.address.port}/v1/messages",
                mapOf("x-api-key" to "sk-test", "anthropic-version" to "2023-06-01"),
                """{"model":"test"}""",
            )
            checkEquals("""{"ok":true}""", response)
        } finally {
            server.stop(0)
        }

        checkEquals("""{"model":"test"}""", receivedBody)
        checkEquals("sk-test", receivedKey)
        checkEquals("2023-06-01", receivedVersion)
    }

    test("a rejected key surfaces as an actionable failure, not a crash") {
        val server = serve { exchange ->
            exchange.reply(401, """{"error":{"message":"invalid api key"}}""")
        }

        try {
            Http.postJson("http://127.0.0.1:${server.address.port}/v1/messages", emptyMap(), "{}")
            throw AssertionError("expected an HttpFailure")
        } catch (e: Http.HttpFailure) {
            checkEquals(401, e.status)
            check(e.body.contains("invalid api key"), "keeps the provider's explanation")
        } finally {
            server.stop(0)
        }
    }
}
