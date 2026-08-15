package ai.njyn.meetingnotes

import ai.njyn.meetingnotes.data.NoteStore
import ai.njyn.meetingnotes.data.Settings
import ai.njyn.meetingnotes.record.RecorderState
import ai.njyn.meetingnotes.record.RecordingService
import ai.njyn.meetingnotes.ui.HomeScreen
import ai.njyn.meetingnotes.ui.NjynTheme
import ai.njyn.meetingnotes.ui.SettingsScreen
import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle

/**
 * The only screen. Handles the permission dance, hands off to the recording
 * service, and shows what came back.
 */
class MainActivity : ComponentActivity() {

    private lateinit var settings: Settings
    private lateinit var noteStore: NoteStore

    /** Bumped after each recording so the notes list re-queries MediaStore. */
    private var notesVersion by mutableStateOf(0)
    private var showSettings by mutableStateOf(false)

    private val requestPermissions =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
            if (granted[Manifest.permission.RECORD_AUDIO] == true) {
                beginRecording()
            } else {
                toast("Microphone permission is required to record a meeting.")
            }
        }

    /**
     * Screen-capture consent. Declining is not fatal - we fall back to
     * microphone-only, which is the right answer for an in-person meeting.
     */
    private val requestProjection =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            if (result.resultCode == Activity.RESULT_OK && result.data != null) {
                RecordingService.start(this, result.resultCode, result.data)
            } else {
                toast("Recording microphone only.")
                RecordingService.start(this, 0, null)
            }
        }

    private val importEnv =
        registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            if (uri == null) return@registerForActivityResult
            val applied = settings.importEnv(uri)
            toast(
                if (applied > 0) {
                    "Imported $applied setting${if (applied == 1) "" else "s"}."
                } else {
                    "No recognised keys in that file."
                },
            )
            notesVersion++ // forces the engine block to re-read settings
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        settings = Settings(this)
        noteStore = NoteStore(this)

        setContent {
            NjynTheme {
                val state by RecorderState.state.collectAsStateWithLifecycle()

                // Re-query MediaStore whenever a recording finishes.
                val notes = androidx.compose.runtime.remember(state.lastNoteName, notesVersion) {
                    noteStore.recentNotes(limit = 12)
                }

                if (showSettings) {
                    SettingsScreen(
                        settings = settings,
                        onImportEnv = { importEnv.launch(arrayOf("*/*")) },
                        onBack = { showSettings = false },
                        modifier = Modifier.systemBarsPadding(),
                    )
                } else {
                    HomeScreen(
                        state = state,
                        settings = settings,
                        notes = notes,
                        onStart = ::onStartClicked,
                        onStop = { RecordingService.stop(this) },
                        onOpenNote = ::openNote,
                        onOpenSettings = { showSettings = true },
                        modifier = Modifier.systemBarsPadding(),
                    )
                }
            }
        }
    }

    /* ------------------------------------------------------------ actions */

    private fun onStartClicked() {
        RecorderState.clearError()

        val needed = buildList {
            if (!hasPermission(Manifest.permission.RECORD_AUDIO)) add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                !hasPermission(Manifest.permission.POST_NOTIFICATIONS)
            ) {
                // Not fatal, but without it the Stop control is invisible.
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }

        if (needed.isNotEmpty()) {
            requestPermissions.launch(needed.toTypedArray())
            return
        }
        beginRecording()
    }

    private fun beginRecording() {
        if (!settings.captureSystemAudio) {
            RecordingService.start(this, 0, null)
            return
        }
        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        requestProjection.launch(manager.createScreenCaptureIntent())
    }

    private fun openNote(note: NoteStore.Note) {
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(note.uri, "text/plain")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        runCatching { startActivity(intent) }
            .onFailure { toast("No app on this phone can open a markdown file.") }
    }

    private fun hasPermission(permission: String) =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun toast(message: String) =
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
}
