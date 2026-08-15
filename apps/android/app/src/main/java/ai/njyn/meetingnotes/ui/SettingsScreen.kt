package ai.njyn.meetingnotes.ui

import ai.njyn.meetingnotes.data.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Keys and switches. Everything here is stored in this app's private
 * preferences on this device and is sent nowhere except to the provider it
 * belongs to.
 */
@Composable
fun SettingsScreen(
    settings: Settings,
    onImportEnv: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var anthropic by remember { mutableStateOf(settings.anthropicKey) }
    var openai by remember { mutableStateOf(settings.openaiKey) }
    var groq by remember { mutableStateOf(settings.groqKey) }
    var captureSystem by remember { mutableStateOf(settings.captureSystemAudio) }
    var keepAudio by remember { mutableStateOf(settings.keepAudio) }

    Column(
        modifier
            .fillMaxSize()
            .background(Njyn.Obsidian)
            .verticalScroll(rememberScrollState()),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "← BACK",
                style = LabelStyle,
                color = Njyn.Muted,
                modifier = Modifier
                    .clickable(onClick = onBack)
                    .padding(end = 12.dp),
            )
            Spacer(Modifier.weight(1f))
            Text("SETTINGS", style = LabelStyle, color = Njyn.Gold)
        }
        HorizontalDivider(color = Njyn.Gold.copy(alpha = 0.2f))

        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(
                "Keys stay on this device. They are used only for the transcription " +
                    "and summary calls you trigger by recording a meeting.",
                fontSize = 13.sp,
                color = Njyn.Muted,
            )

            OutlinedButton(onClick = onImportEnv, modifier = Modifier.fillMaxWidth()) {
                Text("IMPORT .ENV FILE", style = LabelStyle, color = Njyn.Gold2)
            }

            KeyField("Anthropic API key", anthropic, "for summaries") {
                anthropic = it
                settings.anthropicKey = it
            }
            KeyField("Groq API key", groq, "transcription + summaries, fastest") {
                groq = it
                settings.groqKey = it
            }
            KeyField("OpenAI API key", openai, "transcription + summaries") {
                openai = it
                settings.openaiKey = it
            }

            HorizontalDivider(color = Njyn.Text.copy(alpha = 0.08f))

            ToggleRow(
                "Capture system audio",
                "Also record what the phone is playing. Android will ask for screen " +
                    "capture. It cannot capture VoIP call audio - see the README.",
                captureSystem,
            ) {
                captureSystem = it
                settings.captureSystemAudio = it
            }

            ToggleRow(
                "Keep the audio file",
                "Save the .wav next to the note in Documents/MeetingNotes.",
                keepAudio,
            ) {
                keepAudio = it
                settings.keepAudio = it
            }
        }
    }
}

@Composable
private fun KeyField(label: String, value: String, hint: String, onChange: (String) -> Unit) {
    Column {
        OutlinedTextField(
            value = value,
            onValueChange = onChange,
            label = { Text(label, fontSize = 13.sp) },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            textStyle = androidx.compose.ui.text.TextStyle(
                fontFamily = FontFamily.Monospace,
                fontSize = 12.sp,
            ),
            colors = TextFieldDefaults.colors(
                focusedContainerColor = Njyn.Obsidian2,
                unfocusedContainerColor = Njyn.Obsidian2,
                focusedIndicatorColor = Njyn.Gold,
                unfocusedIndicatorColor = Njyn.Muted.copy(alpha = 0.4f),
                focusedLabelColor = Njyn.Gold2,
                unfocusedLabelColor = Njyn.Muted,
                cursorColor = Njyn.Gold,
                focusedTextColor = Njyn.Text,
                unfocusedTextColor = Njyn.Text,
            ),
            modifier = Modifier.fillMaxWidth(),
        )
        Text(hint, style = LabelStyle, fontSize = 10.sp, color = Njyn.Muted, modifier = Modifier.padding(top = 4.dp))
    }
}

@Composable
private fun ToggleRow(
    title: String,
    description: String,
    checked: Boolean,
    onChange: (Boolean) -> Unit,
) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 14.sp, color = Njyn.Text)
            Spacer(Modifier.height(2.dp))
            Text(description, fontSize = 12.sp, color = Njyn.Muted)
        }
        Spacer(Modifier.width(12.dp))
        Switch(
            checked = checked,
            onCheckedChange = onChange,
            colors = SwitchDefaults.colors(
                checkedThumbColor = Njyn.Obsidian,
                checkedTrackColor = Njyn.Gold,
                uncheckedThumbColor = Njyn.Muted,
                uncheckedTrackColor = Njyn.Obsidian2,
            ),
        )
    }
}
