# njyn Meeting Notes — Android

The same idea as the desktop app, on a phone. Records a meeting, transcribes it,
and writes a markdown note with a five-bullet summary, the decisions, and the
action items with owners — full transcript below a divider, audio kept next to
it.

```
Documents/MeetingNotes/
  2026-08-15-1430.md
  2026-08-15-1430.wav
```

Files go to **Documents/MeetingNotes** through MediaStore, so they appear in the
Files app and any markdown editor, and they survive uninstalling the app.

No account, no cloud storage, no telemetry. Keys live in this app's private
preferences and are used only for the calls a recording triggers.

---

## Read this first: two honest limitations

**1. Android cannot record VoIP call audio.** The platform refuses to capture
audio tagged `USAGE_VOICE_COMMUNICATION`, which is what Meet, Zoom, Teams and
the dialler use. This is a deliberate OS restriction, not something an app can
work around. System-audio capture here picks up *media playback* — a recorded
talk, a video, a podcast.

For **in-person meetings** the microphone captures everyone in the room, which
is the case this app is genuinely good at. For a video call on your phone, put
it on speaker and record with the microphone.

**2. There is no offline transcription on Android.** whisper.cpp on Android
means an NDK build shipped inside the APK, which this app does not do — audio is
sent to Groq or OpenAI. If you need transcription that never leaves the device,
use the desktop app. The desktop app runs whisper.cpp fully offline.

The recording itself is always local. Only transcription and summarising are
network calls.

---

## Build

Needs the Android SDK (API 35) and JDK 17. Android Studio ships both.

```
cd apps/android
./gradlew assembleDebug
./gradlew installDebug     # to a connected device
```

`minSdk` is 29, because `AudioPlaybackCapture` — the only way to record system
audio on Android — arrived in Android 10.

There is a harness that compiles and exercises the platform-independent core
(WAV writer and splitter, the PCM drift queue, the transcript stitcher, note and
summary formatting, and the multipart upload against a local server) on a plain
JVM with no Android SDK:

```
./gradlew -p tools/jvm-selftest run
```

---

## Permissions you need to grant

The app requests these at the moment it needs them, not at install.

| Permission | Prompt | What happens without it |
|---|---|---|
| **Microphone** | On the first Start Recording | Nothing is recorded. This one is required. |
| **Notifications** | On the first Start Recording | Recording still works, but the ongoing notification — which carries the **Stop** control — is invisible. Grant this. |
| **Screen capture** | A system dialog each time you start, if *Capture system audio* is on | Falls back to microphone only, with a toast saying so. |

Android has no menu bar, so the **ongoing notification is this app's tray icon**:
it stays visible for the whole meeting and holds the Stop button.

The screen-capture dialog says the app will "start capturing everything
displayed on your screen". That wording is the platform's; this app requests a
screen-capture token solely to open the audio-playback capture stream, never
records video, and never writes an image anywhere.

Nothing here needs a storage permission — MediaStore handles Documents.

---

## Configure

**Settings → Import .env file** reads the same `.env` the desktop app uses.
Copy it to the phone and pick it. Only `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GROQ_API_KEY` and `KEEP_AUDIO` are read; everything else in the file is
ignored.

Or paste keys directly in Settings.

| Key | Transcription | Summary |
|---|---|---|
| `GROQ_API_KEY` | ✅ fastest | ✅ |
| `OPENAI_API_KEY` | ✅ | ✅ |
| `ANTHROPIC_API_KEY` | — | ✅ preferred |

You need at least one of Groq or OpenAI for transcription. Without an LLM key
the note is still written with the full transcript and a line explaining why
there is no summary.

Two switches:

- **Capture system audio** — off skips the screen-capture prompt entirely and
  records the microphone alone. Worth turning off for in-person meetings.
- **Keep the audio file** — off deletes the `.wav` once the note is written.

---

## How it works

The microphone and, when granted, system audio are captured as separate
`AudioRecord` streams at 16 kHz mono, mixed, and appended to a WAV in app
storage as they arrive. The two streams are clocked independently, so system
audio is buffered and resynchronised against the microphone rather than
allowed to drift.

On stop, the service drops the microphone and projection service types,
continues in the foreground as a data-sync job while transcription finishes,
then publishes the note and audio to Documents and clears itself.

Recordings over about twelve minutes exceed the hosted upload limit, so they are
split into overlapping chunks and the transcripts stitched back together with
the duplicated overlap removed.

If transcription or summarising fails, the note is still written — with the
reason in place of the summary and the transcript intact. A failed API call
never costs you the record of the meeting.
