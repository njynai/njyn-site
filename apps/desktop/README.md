# njyn Meeting Notes — desktop

A tray app that records a meeting, transcribes it, and writes a markdown note.
Built for Windows; the same build runs on macOS and Linux.

Click **Start Recording** in the tray. Click **Stop Recording** when the meeting
ends. A minute or two later there is a file in `~/MeetingNotes` with a
five-bullet summary, the decisions, the action items with owners, and the full
transcript below a divider. The audio sits next to it.

```
~/MeetingNotes/
  2026-08-15-1430.md
  2026-08-15-1430.wav
```

There is no account, no cloud storage, and no telemetry. The app makes exactly
two kinds of outbound request, both to providers whose keys you supplied: the
transcription call (skipped entirely if whisper.cpp is installed) and the
summary call. Nothing else leaves the machine — not even a web font.

---

## 1. Install

### From an installer

Push a `desktop-v*` tag, or run the **Desktop release** workflow from the
Actions tab, and GitHub builds the installers on real Windows, macOS and Linux
runners and attaches them to a draft release.

```
git tag desktop-v1.0.0 && git push origin desktop-v1.0.0
```

The installers are **unsigned**, so Windows SmartScreen warns on first run
(*More info* → *Run anyway*) and macOS needs right-click → *Open*. Removing that
warning needs a code-signing certificate — around $200/year from a CA — added to
the workflow as `CSC_LINK` and `CSC_KEY_PASSWORD`. Worth it if other people
install this; not worth it if it is only you.

### From source

You need [Node.js 18+](https://nodejs.org).

```
cd apps/desktop
npm install
npm start
```

To build an installer locally, on the platform you are targeting:

```
npm run dist:win     # NSIS installer   -> dist/
npm run dist:mac     # dmg
npm run dist:linux   # AppImage
```

The tray and app icons are generated from source, with no image library, by
`npm run icons` (the `dist` scripts call it for you).

Run `npm run selftest` to exercise the WAV writer, the chunk splitter, the
transcript stitcher, note formatting and config resolution.

---

## 2. Permissions you need to grant

The app asks the OS for two things: your **microphone**, and **system audio**,
which every platform gates behind a screen-capture permission. Both are used
only while a recording is running.

### Windows

| What | Where |
|---|---|
| Microphone | Settings → Privacy & security → Microphone → **Let apps access your microphone** on, and `njyn Meeting Notes` allowed |
| System audio | No separate setting. Windows loopback capture works once the app is running. |

Windows will not show a screen-picker dialog — the app selects the primary
display itself and keeps only the audio.

### macOS

| What | Where |
|---|---|
| Microphone | System Settings → Privacy & Security → **Microphone** → enable `njyn Meeting Notes` |
| System audio | System Settings → Privacy & Security → **Screen & System Audio Recording** → enable `njyn Meeting Notes` |

macOS requires a restart of the app after granting Screen Recording the first
time.

Be aware that loopback capture is best supported on Windows and on Linux under
PipeWire. If the `SYSTEM AUDIO` chip stays dark on macOS after granting Screen
Recording, the platform declined the request and the app is recording the
microphone only — it says so in a notification rather than failing silently.

### Linux

| What | Where |
|---|---|
| Microphone | Granted by the desktop portal on first use |
| System audio | Needs **PipeWire** and `xdg-desktop-portal` with a screen-cast backend (`xdg-desktop-portal-gnome`, `-kde` or `-wlr`) |

On PulseAudio-only systems the microphone still records; system audio does not.

### If system audio is unavailable

The app records the microphone alone and tells you so, both in the panel (the
`SYSTEM AUDIO` chip stays dark) and in a notification. The meeting is still
captured — just your side of it, plus whatever the room microphone picks up
from your speakers.

---

## 3. Configure

Copy `.env.example` to **`~/.njyn/.env`** and fill in what you have. Every value
is optional.

```
mkdir -p ~/.njyn
cp .env.example ~/.njyn/.env
```

A single key is enough to be useful:

```env
ANTHROPIC_API_KEY=sk-ant-...
```

The panel's **ENGINE** block shows exactly what will run, and **Reload .env**
picks up changes without restarting.

### Which provider does what

| | Transcription | Summary |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | ✅ preferred |
| `OPENAI_API_KEY` | ✅ | ✅ |
| `GROQ_API_KEY` | ✅ fastest | ✅ |
| whisper.cpp | ✅ offline | — |

Summaries always need a hosted model — there is no local LLM in this app. With
no LLM key the app still records and transcribes, and writes a note containing
the full transcript plus a line explaining why there is no summary.

---

## 4. Offline transcription with whisper.cpp

Install whisper.cpp and the medium model, and the app stops sending audio
anywhere at all. It is picked automatically whenever a binary and a model are
both present — no configuration needed.

### One click

The setup screen has an **Install offline mode** button. It downloads the
medium model (~1.5 GB) from the official Hugging Face repo into
`~/.njyn/models`, and on **Windows** also fetches a prebuilt whisper.cpp from
the project's GitHub releases into `~/.njyn/whisper.cpp`. The model is
checked for the ggml magic bytes before it is accepted, so a truncated download
or an error page cannot masquerade as a working install.

On macOS and Linux there is no official prebuilt CLI, so the button downloads
the model only and the app says so — build the binary with the four commands
below and it gets picked up automatically.

### By hand

```bash
git clone https://github.com/ggerganov/whisper.cpp ~/whisper.cpp
cd ~/whisper.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j --config Release
sh ./models/download-ggml-model.sh medium      # ~1.5 GB
```

On Windows, use the same commands from a Developer Command Prompt (or install
via `winget install Kitware.CMake` first), and run
`models\download-ggml-model.cmd medium`.

The app looks for the binary in `~/.njyn/whisper.cpp`, `~/whisper.cpp`,
`~/src/whisper.cpp`, `./vendor/whisper.cpp` and on `PATH`, and for
`ggml-medium.bin` in `~/.njyn/models` and `~/whisper.cpp/models`. Point at them
directly if you keep them somewhere else:

```env
WHISPER_CPP_PATH=~/whisper.cpp/build/bin/whisper-cli
WHISPER_MODEL_PATH=~/.njyn/models/ggml-medium.bin
```

Expect roughly real-time transcription on a modern laptop CPU with the medium
model — a 45-minute meeting takes a few minutes. `WHISPER_MODEL=small` is about
three times faster and noticeably less accurate on names and jargon.

**Fully offline** means whisper.cpp installed *and* no LLM key configured, or
no network. You get the transcript; the summary section explains it could not
be written. Record, transcribe and save all work with the network off.

---

## 5. When something fails

**A failed transcription is recoverable.** If your key was wrong, the network
dropped, or the provider rate-limited you, the `.wav` is still on disk and the
note records what went wrong. The app notices, and the panel grows a **Needs
another go** section listing those recordings with a **Retry** button that
rebuilds the note from the audio. Nothing is lost but time.

You can also point it at any recording — tray → **Re-process a recording…** —
including a `.wav` from somewhere else, which gets copied into the notes folder
so the note and its audio stay together. Retrying is the same code path as a
live meeting, not a second, less-tested one.

This also makes a useful smoke test: record ten seconds, then retry it as many
times as you like while you get a key working.

## 6. Start at login

**Preferences → Start at login**, or the tray menu. It launches into the tray
without opening a window and without recording anything — a recorder you have
to remember to open is a recorder you forget to use.

Windows and macOS use the OS login-item API. Linux gets a
`~/.config/autostart/njyn-meeting-notes.desktop` entry. The toggle reflects
what the OS actually did, not what was asked, so it cannot end up lying to you.

## 7. How it works

| Step | What happens |
|---|---|
| Capture | A hidden Chromium window mixes the microphone and system loopback in the Web Audio graph and emits mono 16 kHz PCM — exactly Whisper's input format, so there is no transcode step and no ffmpeg dependency. |
| Write | PCM is appended to the `.wav` as it arrives, so a three-hour meeting never sits in memory. |
| Transcribe | whisper.cpp locally, or a hosted Whisper. Recordings over ~12 minutes are split into overlapping chunks for upload and stitched back together. |
| Summarise | One call, asking for JSON, rendered into markdown. |
| Save | Note and audio written side by side in `~/MeetingNotes`. |

Echo cancellation is left **on** for the microphone. If the meeting plays
through speakers, that stops the far end being recorded twice — once through
loopback and again through the microphone.

---

## 8. Troubleshooting

**The `SYSTEM AUDIO` chip never lights up.** The platform denied loopback. On
macOS check Screen & System Audio Recording and restart the app; on Linux check
that PipeWire and a desktop portal are installed.

**"whisper.cpp is not installed and no key was found."** Neither path is
available. Either follow section 4 or put a key in `~/.njyn/.env`.

**The summary says the key was rejected.** Fix the key, hit **Reload .env**, and
press **Retry** on that recording in *Needs another go*. See section 5.

**A meeting produced no note.** Recordings under one second are discarded — the
audio is deleted too, since a half-second of silence is not worth keeping.
Anything longer leaves a `.wav` behind that Retry can rebuild. Check the panel
for the last error.

**The offline install failed.** The model is verified before it is accepted, so
a bad download deletes itself rather than half-installing. Check disk space
(1.5 GB) and try again; the button is safe to press twice.

**Where do I find my notes?** Tray → *Open notes folder*, or `~/MeetingNotes`.
Set `NOTES_DIR` in `.env` to move it.
