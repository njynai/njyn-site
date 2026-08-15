package ai.njyn.meetingnotes.record

import ai.njyn.meetingnotes.MainActivity
import ai.njyn.meetingnotes.R
import ai.njyn.meetingnotes.data.NoteFormat
import ai.njyn.meetingnotes.data.NoteStore
import ai.njyn.meetingnotes.data.Settings
import ai.njyn.meetingnotes.net.Http
import ai.njyn.meetingnotes.net.Summarizer
import ai.njyn.meetingnotes.net.Transcriber
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import java.io.File
import java.util.Date
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking

/**
 * The recorder.
 *
 * Android has no menu bar, so this foreground service and its ongoing
 * notification play the same role as the desktop tray icon: it is always
 * visible while recording and carries the Stop control.
 *
 * It captures the microphone always, and system audio when you grant screen
 * capture. Note the platform limit: Android refuses to hand over audio tagged
 * USAGE_VOICE_COMMUNICATION, which is what Meet, Zoom and Teams use for call
 * audio. System capture therefore picks up media playback, not the far end of a
 * VoIP call. For in-person meetings the microphone gets everything anyway.
 */
class RecordingService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private var micRecord: AudioRecord? = null
    private var systemRecord: AudioRecord? = null
    private var projection: MediaProjection? = null
    private var captureJob: Job? = null

    @Volatile private var capturing = false

    private var writer: WavFile.Writer? = null
    private var stamp: String = ""
    private var startedAt: Date = Date()

    private lateinit var settings: Settings
    private lateinit var notes: NoteStore

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        settings = Settings(this)
        notes = NoteStore(this)
        createChannels()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> handleStart(intent)
            ACTION_STOP -> handleStop()
            else -> stopSelf()
        }
        return START_NOT_STICKY
    }

    /* --------------------------------------------------------------- start */

    private fun handleStart(intent: Intent) {
        if (capturing) return

        val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
        val resultData: Intent? =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
            } else {
                @Suppress("DEPRECATION")
                intent.getParcelableExtra(EXTRA_RESULT_DATA)
            }

        val wantsSystemAudio = resultData != null && settings.captureSystemAudio

        // Android 14 requires the foreground service to be running, with the
        // mediaProjection type declared, before the projection token is used.
        val types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
            if (wantsSystemAudio) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION else 0

        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildRecordingNotification(), types)

        stamp = notes.reserveStamp()
        startedAt = Date()

        val micStarted = startMicrophone()
        val systemStarted = if (wantsSystemAudio) startSystemAudio(resultCode, resultData!!) else false

        if (!micStarted && !systemStarted) {
            RecorderState.finished(
                noteName = null,
                error = "Could not open any audio source. Check the microphone permission.",
            )
            releaseAudio()
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            stopSelf()
            return
        }

        writer = WavFile.Writer(File(notes.scratchDir(), "$stamp.wav"))
        capturing = true
        RecorderState.recordingStarted(micStarted, systemStarted, System.currentTimeMillis())

        captureJob = scope.launch { captureLoop(micStarted, systemStarted) }
    }

    private fun startMicrophone(): Boolean = runCatching {
        val minBuffer = AudioRecord.getMinBufferSize(
            WavFile.SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        // VOICE_RECOGNITION leaves the signal closer to raw than the default
        // source does, which is what a speech model wants.
        val record = AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            WavFile.SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            (minBuffer * 4).coerceAtLeast(BUFFER_BYTES * 4),
        )
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            return false
        }
        record.startRecording()
        micRecord = record
        true
    }.getOrDefault(false)

    private fun startSystemAudio(resultCode: Int, resultData: Intent): Boolean = runCatching {
        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val mediaProjection = manager.getMediaProjection(resultCode, resultData) ?: return false

        // Required from API 34: a callback must be registered before use.
        mediaProjection.registerCallback(
            object : MediaProjection.Callback() {
                override fun onStop() {
                    // The user revoked the screen capture mid-meeting. Keep
                    // recording the microphone rather than dropping everything.
                    RecorderState.update { it.copy(systemOn = false) }
                }
            },
            Handler(Looper.getMainLooper()),
        )
        projection = mediaProjection

        // USAGE_VOICE_COMMUNICATION cannot be added here - the platform
        // forbids capturing call audio, by design.
        val config = AudioPlaybackCaptureConfiguration.Builder(mediaProjection)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
            .addMatchingUsage(AudioAttributes.USAGE_GAME)
            .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
            .build()

        val format = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(WavFile.SAMPLE_RATE)
            .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
            .build()

        val record = AudioRecord.Builder()
            .setAudioFormat(format)
            .setBufferSizeInBytes(BUFFER_BYTES * 8)
            .setAudioPlaybackCaptureConfig(config)
            .build()

        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            return false
        }
        record.startRecording()
        systemRecord = record
        true
    }.getOrDefault(false)

    /* ------------------------------------------------------------- capture */

    /**
     * The microphone drives the clock. Each pass reads one block from it, takes
     * however much system audio has arrived in the meantime, sums the two and
     * appends the result to the WAV.
     */
    private fun captureLoop(micOn: Boolean, systemOn: Boolean) {
        val micBuffer = ByteArray(BUFFER_BYTES)
        val systemBuffer = ByteArray(BUFFER_BYTES * 4)
        val systemPending = ByteArray(BUFFER_BYTES)
        val mixed = ByteArray(BUFFER_BYTES)

        // Hold at most two seconds of system audio before resynchronising.
        val queue = PcmQueue(WavFile.BYTES_PER_SECOND * 2)

        var peak = 0f

        while (capturing) {
            // Drain whatever system audio is ready without blocking the loop.
            systemRecord?.let { record ->
                while (true) {
                    val read = record.read(systemBuffer, 0, systemBuffer.size, AudioRecord.READ_NON_BLOCKING)
                    if (read <= 0) break
                    queue.write(systemBuffer, read)
                }
            }

            val micBytes = if (micOn) {
                micRecord?.read(micBuffer, 0, micBuffer.size) ?: 0
            } else {
                // No microphone: pace the loop off the system stream instead.
                micBuffer.fill(0)
                if (queue.size >= micBuffer.size) {
                    micBuffer.size
                } else {
                    Thread.sleep(10)
                    0
                }
            }
            if (micBytes <= 0) continue

            val systemBytes = if (systemOn) queue.read(systemPending, micBytes) else 0

            // Sum the two sources. Both are attenuated first so a loud room and
            // loud playback together do not clip.
            var i = 0
            while (i + 1 < micBytes) {
                val micSample = if (micOn) sampleAt(micBuffer, i) else 0
                val systemSample = if (i + 1 < systemBytes) sampleAt(systemPending, i) else 0

                var sum = (micSample * MIC_GAIN + systemSample * SYSTEM_GAIN).toInt()
                if (sum > Short.MAX_VALUE) sum = Short.MAX_VALUE.toInt()
                if (sum < Short.MIN_VALUE) sum = Short.MIN_VALUE.toInt()

                mixed[i] = (sum and 0xFF).toByte()
                mixed[i + 1] = ((sum shr 8) and 0xFF).toByte()

                val magnitude = kotlin.math.abs(sum) / 32768f
                if (magnitude > peak) peak = magnitude
                i += 2
            }

            writer?.write(mixed, micBytes)

            // One block is 0.1s, so this feeds the meter ten times a second.
            val level = peak
            RecorderState.update { it.copy(level = level) }
            peak = 0f
        }
    }

    private fun sampleAt(buffer: ByteArray, index: Int): Int =
        ((buffer[index].toInt() and 0xFF) or (buffer[index + 1].toInt() shl 8)).toShort().toInt()

    /* ---------------------------------------------------------------- stop */

    private fun handleStop() {
        if (!capturing) {
            // Already stopped. If the pipeline is still running, leave it be -
            // tearing the service down now would lose the note.
            if (RecorderState.state.value.phase != RecorderState.Phase.PROCESSING) stopSelf()
            return
        }
        capturing = false

        scope.launch {
            captureJob?.join()
            releaseAudio()

            val recording = writer
            writer = null
            val durationSeconds = recording?.durationSeconds ?: 0.0
            recording?.close()
            val wavFile = recording?.file

            // Capture is done, so the microphone and projection service types no
            // longer apply. The service stays in the foreground as a data-sync
            // job while transcription finishes, which can take a few minutes.
            ServiceCompat.startForeground(
                this@RecordingService,
                NOTIFICATION_ID,
                buildProgressNotification("Transcribing", null),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )

            if (wavFile == null || durationSeconds < 1.0) {
                wavFile?.delete()
                RecorderState.finished(null, "Recording was under a second - nothing was saved.")
                finish()
                return@launch
            }

            process(wavFile, durationSeconds)
            finish()
        }
    }

    private fun releaseAudio() {
        micRecord?.runCatching { stop(); release() }
        micRecord = null
        systemRecord?.runCatching { stop(); release() }
        systemRecord = null
        projection?.runCatching { stop() }
        projection = null
    }

    private fun finish() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    /* ------------------------------------------------------------ pipeline */

    private fun process(wavFile: File, durationSeconds: Double) {
        var transcript = ""
        var engine = "unknown"
        var summaryMarkdown = ""
        var summaryError: String? = null
        var title: String? = null
        var llmModel: String? = null

        try {
            RecorderState.processing("Transcribing", 0)
            updateProgressNotification("Transcribing", 0)

            val result = Transcriber(settings).transcribe(wavFile, notes.scratchDir()) { percent ->
                RecorderState.processing("Transcribing", percent)
                updateProgressNotification("Transcribing", percent)
            }
            transcript = result.text
            engine = result.engine
        } catch (e: Exception) {
            engine = "failed"
            summaryError = "transcription failed - ${describe(e)}"
        }

        if (transcript.isNotBlank()) {
            try {
                RecorderState.processing("Summarising")
                updateProgressNotification("Summarising", null)

                val summary = Summarizer(settings).summarize(transcript)
                summaryMarkdown = summary.markdown
                title = summary.title
                llmModel = summary.model
            } catch (e: Exception) {
                summaryError = describe(e)
            }
        }

        val keepAudio = settings.keepAudio
        val markdown = NoteFormat.buildMarkdown(
            stamp = stamp,
            startedAt = startedAt,
            durationSeconds = durationSeconds,
            title = title,
            summaryMarkdown = summaryMarkdown,
            summaryError = summaryError,
            transcript = transcript,
            transcriptEngine = engine,
            llmModel = llmModel,
            audioFile = if (keepAudio) "$stamp.wav" else null,
        )

        val noteUri = notes.publishText("$stamp.md", markdown)
        if (keepAudio) notes.publishAudio("$stamp.wav", wavFile)
        wavFile.delete()

        RecorderState.finished("$stamp.md", summaryError)
        notifyResult(
            title = if (summaryError == null) "Notes saved" else "Notes saved with a warning",
            text = if (summaryError == null) "$stamp.md" else "$stamp.md — $summaryError",
            saved = noteUri != null,
        )
    }

    /** Turn an exception into something a person can act on. */
    private fun describe(e: Exception): String = when (e) {
        is Http.HttpFailure -> when (e.status) {
            401, 403 -> "the API key was rejected (HTTP ${e.status}). Check it in Settings."
            429 -> "rate limited by the provider (HTTP 429). Try again shortly."
            else -> "HTTP ${e.status} from the provider."
        }
        is java.net.UnknownHostException, is java.net.SocketTimeoutException ->
            "no network reachable. The audio and transcript are kept - reopen the app when you are back online."
        else -> e.message ?: e::class.java.simpleName
    }

    /* -------------------------------------------------------- notification */

    private fun createChannels() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_RECORDING,
                "Recording",
                NotificationManager.IMPORTANCE_LOW,
            ).apply { description = "Shown while a meeting is being recorded or processed." },
        )
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_RESULT,
                "Saved notes",
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply { description = "Shown once a meeting note has been written." },
        )
    }

    private fun contentIntent(): PendingIntent = PendingIntent.getActivity(
        this,
        0,
        Intent(this, MainActivity::class.java),
        PendingIntent.FLAG_IMMUTABLE,
    )

    private fun buildRecordingNotification(): Notification {
        val stopIntent = PendingIntent.getService(
            this,
            1,
            Intent(this, RecordingService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE,
        )

        return NotificationCompat.Builder(this, CHANNEL_RECORDING)
            .setContentTitle("Recording meeting")
            .setContentText("njyn is recording. Tap Stop when the meeting ends.")
            .setSmallIcon(R.drawable.ic_stat_njyn)
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(contentIntent())
            .addAction(0, "Stop", stopIntent)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun buildProgressNotification(stage: String, percent: Int?): Notification =
        NotificationCompat.Builder(this, CHANNEL_RECORDING)
            .setContentTitle(stage)
            .setContentText(
                if (percent != null) "$percent%" else "Writing your notes…",
            )
            .setSmallIcon(R.drawable.ic_stat_njyn)
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(contentIntent())
            .setProgress(100, percent ?: 0, percent == null)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

    private fun updateProgressNotification(stage: String, percent: Int?) {
        getSystemService(NotificationManager::class.java)
            .notify(NOTIFICATION_ID, buildProgressNotification(stage, percent))
    }

    private fun notifyResult(title: String, text: String, saved: Boolean) {
        getSystemService(NotificationManager::class.java).notify(
            RESULT_NOTIFICATION_ID,
            NotificationCompat.Builder(this, CHANNEL_RESULT)
                .setContentTitle(title)
                .setContentText(if (saved) text else "$text (could not write to Documents)")
                .setStyle(NotificationCompat.BigTextStyle().bigText(text))
                .setSmallIcon(R.drawable.ic_stat_njyn)
                .setAutoCancel(true)
                .setContentIntent(contentIntent())
                .build(),
        )
    }

    override fun onDestroy() {
        capturing = false
        // Never lose audio on the way out.
        runBlocking { captureJob?.join() }
        releaseAudio()
        writer?.close()
        super.onDestroy()
    }

    companion object {
        const val ACTION_START = "ai.njyn.meetingnotes.START"
        const val ACTION_STOP = "ai.njyn.meetingnotes.STOP"
        const val EXTRA_RESULT_CODE = "result_code"
        const val EXTRA_RESULT_DATA = "result_data"

        private const val NOTIFICATION_ID = 1001
        private const val RESULT_NOTIFICATION_ID = 1002
        private const val CHANNEL_RECORDING = "recording"
        private const val CHANNEL_RESULT = "results"

        /** 0.1s of 16 kHz mono 16-bit audio. */
        private const val BUFFER_BYTES = WavFile.BYTES_PER_SECOND / 10

        private const val MIC_GAIN = 0.85f
        private const val SYSTEM_GAIN = 0.85f

        fun start(context: Context, resultCode: Int, resultData: Intent?) {
            val intent = Intent(context, RecordingService::class.java)
                .setAction(ACTION_START)
                .putExtra(EXTRA_RESULT_CODE, resultCode)
                .putExtra(EXTRA_RESULT_DATA, resultData)
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            context.startService(
                Intent(context, RecordingService::class.java).setAction(ACTION_STOP),
            )
        }
    }
}
