package ai.njyn.meetingnotes.ui

import ai.njyn.meetingnotes.data.NoteStore
import ai.njyn.meetingnotes.data.Settings
import ai.njyn.meetingnotes.record.RecorderState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.sin
import kotlinx.coroutines.delay

/**
 * The whole app UI: what is happening, one big button, and where the notes went.
 */
@Composable
fun HomeScreen(
    state: RecorderState.State,
    settings: Settings,
    notes: List<NoteStore.Note>,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onOpenNote: (NoteStore.Note) -> Unit,
    onOpenSettings: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val recording = state.phase == RecorderState.Phase.RECORDING
    val processing = state.phase == RecorderState.Phase.PROCESSING

    // Recompute the clock once a second while recording.
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(recording) {
        while (recording) {
            now = System.currentTimeMillis()
            delay(500)
        }
    }
    val elapsed = if (recording && state.startedAtMs > 0) (now - state.startedAtMs) / 1000 else 0L

    Column(
        modifier
            .fillMaxSize()
            .background(Njyn.Obsidian)
            .verticalScroll(rememberScrollState()),
    ) {
        Header(onOpenSettings)

        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            Stage(
                recording = recording,
                processing = processing,
                elapsed = elapsed,
                level = state.level,
                stage = state.stage,
                percent = state.percent,
                micOn = state.micOn,
                systemOn = state.systemOn,
                onStart = onStart,
                onStop = onStop,
            )

            state.lastError?.let { Notice(it, Njyn.Red) }

            if (!settings.isConfigured) {
                Notice(
                    "No transcription key yet. Open Settings and add a Groq or OpenAI key, " +
                        "or import the .env you already use on the desktop.",
                    Njyn.Gold,
                )
            }

            EngineBlock(settings)
            NotesBlock(notes, onOpenNote)
        }
    }
}

/* ------------------------------------------------------------------ header */

@Composable
private fun Header(onOpenSettings: () -> Unit) {
    Column {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            HexMark(Modifier.size(26.dp))
            Spacer(Modifier.width(10.dp))
            Text(
                "NJYN",
                style = DisplayStyle,
                fontSize = 16.sp,
                color = Njyn.Text,
            )
            Text(".AI", style = DisplayStyle, fontSize = 16.sp, color = Njyn.Gold)
            Spacer(Modifier.weight(1f))
            Text(
                "SETTINGS",
                style = LabelStyle,
                color = Njyn.Muted,
                modifier = Modifier
                    .clickable(onClick = onOpenSettings)
                    .padding(8.dp),
            )
        }
        HorizontalDivider(color = Njyn.Gold.copy(alpha = 0.2f))
    }
}

/** The njyn mark: a hexagon outline with a gold core. */
@Composable
fun HexMark(modifier: Modifier = Modifier, coreColor: Color = Njyn.Gold) {
    androidx.compose.foundation.Canvas(modifier) {
        val radius = size.minDimension / 2f
        val center = Offset(size.width / 2f, size.height / 2f)

        val path = Path()
        for (i in 0 until 6) {
            // Flat-top hexagon, matching the logo on the website.
            val angle = PI / 3.0 * i - PI / 2.0
            val x = center.x + radius * cos(angle).toFloat()
            val y = center.y + radius * sin(angle).toFloat()
            if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
        }
        path.close()

        drawPath(path, Njyn.Text, style = Stroke(width = radius * 0.16f))
        drawCircle(coreColor, radius = radius * 0.26f, center = center)
    }
}

/* ------------------------------------------------------------------- stage */

@Composable
private fun Stage(
    recording: Boolean,
    processing: Boolean,
    elapsed: Long,
    level: Float,
    stage: String?,
    percent: Int?,
    micOn: Boolean,
    systemOn: Boolean,
    onStart: () -> Unit,
    onStop: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(Njyn.Obsidian2)
            .border(1.dp, Njyn.Gold.copy(alpha = 0.2f))
            .padding(horizontal = 20.dp, vertical = 22.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (recording) {
                Box(
                    Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(Njyn.Red),
                )
                Spacer(Modifier.width(7.dp))
            }
            Text(
                when {
                    recording -> "RECORDING"
                    processing -> buildString {
                        append(stage?.uppercase() ?: "WORKING")
                        percent?.let { append(" · $it%") }
                    }
                    else -> "IDLE"
                },
                style = LabelStyle,
                color = if (recording) Njyn.Red else Njyn.Muted,
            )
        }

        Spacer(Modifier.height(6.dp))

        Text(
            if (recording) formatClock(elapsed) else if (processing) "—" else "00:00",
            fontSize = 34.sp,
            fontWeight = FontWeight.Medium,
            fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
            color = if (recording) Njyn.Text else Njyn.Muted,
        )

        Spacer(Modifier.height(14.dp))

        // Level meter. The curve keeps quiet speech visible.
        Box(
            Modifier
                .fillMaxWidth()
                .height(3.dp)
                .background(Njyn.Text.copy(alpha = 0.08f)),
        ) {
            val width = if (recording) level.coerceIn(0f, 1f).pow(0.6f) else 0f
            Box(
                Modifier
                    .fillMaxWidth(width)
                    .height(3.dp)
                    .background(Njyn.Gold),
            )
        }

        Spacer(Modifier.height(18.dp))

        Button(
            onClick = if (recording) onStop else onStart,
            enabled = !processing,
            shape = androidx.compose.ui.graphics.RectangleShape,
            colors = ButtonDefaults.buttonColors(
                containerColor = if (recording) Njyn.Red else Njyn.Gold,
                contentColor = if (recording) Njyn.Text else Njyn.Obsidian,
                disabledContainerColor = Njyn.Muted.copy(alpha = 0.25f),
                disabledContentColor = Njyn.Muted,
            ),
            modifier = Modifier
                .fillMaxWidth()
                .height(52.dp),
        ) {
            Text(
                when {
                    processing -> "WORKING…"
                    recording -> "STOP RECORDING"
                    else -> "START RECORDING"
                },
                style = DisplayStyle,
                fontSize = 14.sp,
            )
        }

        Spacer(Modifier.height(14.dp))

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Chip("MIC", recording && micOn)
            Chip("SYSTEM AUDIO", recording && systemOn)
        }
    }
}

@Composable
private fun Chip(label: String, on: Boolean) {
    Row(
        Modifier
            .border(1.dp, if (on) Njyn.Gold.copy(alpha = 0.55f) else Njyn.Muted.copy(alpha = 0.3f))
            .padding(horizontal = 9.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(6.dp)
                .clip(CircleShape)
                .background(if (on) Njyn.Green else Njyn.Muted.copy(alpha = 0.5f)),
        )
        Spacer(Modifier.width(6.dp))
        Text(label, style = LabelStyle, fontSize = 10.sp, color = if (on) Njyn.Gold2 else Njyn.Muted)
    }
}

/* ------------------------------------------------------------------ blocks */

@Composable
private fun SectionHeading(text: String) {
    Column {
        Text(text, style = LabelStyle, color = Njyn.Muted)
        Spacer(Modifier.height(8.dp))
        HorizontalDivider(color = Njyn.Gold.copy(alpha = 0.4f))
    }
}

@Composable
private fun InfoRow(key: String, value: String, ok: Boolean) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 7.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(key, fontSize = 13.sp, color = Njyn.Muted)
        Spacer(Modifier.width(12.dp))
        Text(
            value,
            fontSize = 11.sp,
            fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
            color = if (ok) Njyn.Gold2 else Njyn.Red,
            textAlign = TextAlign.End,
        )
    }
}

@Composable
private fun EngineBlock(settings: Settings) {
    Column {
        SectionHeading("ENGINE")
        val stt = settings.transcribeProvider
        InfoRow("Transcription", stt?.let { "$it whisper (hosted)" } ?: "none", stt != null)
        InfoRow(
            "Summary",
            settings.llmProvider?.let { "$it · ${settings.llmModel}" } ?: "none",
            settings.llmProvider != null,
        )
        InfoRow("Works offline", "no · needs network", false)
        InfoRow("Saved to", "Documents/MeetingNotes", true)
    }
}

@Composable
private fun NotesBlock(notes: List<NoteStore.Note>, onOpen: (NoteStore.Note) -> Unit) {
    Column {
        SectionHeading("RECENT NOTES")
        if (notes.isEmpty()) {
            Text(
                "No meetings recorded yet.",
                fontSize = 13.sp,
                color = Njyn.Muted,
                modifier = Modifier.padding(vertical = 8.dp),
            )
        } else {
            notes.forEach { note ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable { onOpen(note) }
                        .padding(vertical = 9.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        note.name.removeSuffix(".md"),
                        fontSize = 12.sp,
                        fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                        color = Njyn.Text,
                    )
                    Text("→", fontSize = 12.sp, color = Njyn.Muted)
                }
                HorizontalDivider(color = Njyn.Text.copy(alpha = 0.05f))
            }
        }
    }
}

@Composable
private fun Notice(text: String, accent: Color) {
    Text(
        text,
        fontSize = 13.sp,
        color = Njyn.Text,
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, accent.copy(alpha = 0.4f))
            .background(accent.copy(alpha = 0.06f))
            .padding(14.dp),
    )
}

private fun formatClock(seconds: Long): String {
    val h = seconds / 3600
    val m = (seconds % 3600) / 60
    val s = seconds % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%02d:%02d".format(m, s)
}
