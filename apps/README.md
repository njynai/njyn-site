# njyn Meeting Notes

Local-first meeting notes. Record a meeting, get a markdown file with a
five-bullet summary, the decisions, the action items with owners, and the full
transcript below a divider. The audio stays next to the note.

No account. No cloud storage. No telemetry. The only outbound traffic is the API
calls you configure with your own keys — and on desktop, with whisper.cpp
installed, transcription happens entirely on your machine.

| | [desktop](desktop/) | [android](android/) |
|---|---|---|
| **Platform** | Windows (also macOS, Linux) | Android 10+ |
| **Control** | System tray, Start/Stop | Ongoing notification, Start/Stop |
| **Microphone** | ✅ | ✅ |
| **System audio** | ✅ loopback | ⚠️ media only — the OS blocks VoIP call audio |
| **Offline transcription** | ✅ whisper.cpp, medium model, one-click install | ❌ hosted only |
| **Retry a failed note** | ✅ rebuilds from the kept audio | ❌ |
| **Start at login** | ✅ | n/a |
| **Notes go to** | `~/MeetingNotes` | `Documents/MeetingNotes` |

Both write the identical note format and read the same `.env`, so a meeting
recorded on either device lands in the same shape.

**Start with the desktop app.** It is the one that does everything asked of it:
tray control, real system-audio capture, and fully offline transcription. The
Android app is the same product shaped to what the platform actually permits —
read [its two limitations](android/README.md#read-this-first-two-honest-limitations)
before relying on it for a video call.

Each app's README covers installing dependencies and the exact permissions to
grant.

## What a note looks like

```markdown
---
date: 2026-08-15-1430
duration: 47m 12s
audio: 2026-08-15-1430.wav
transcription: whisper.cpp (ggml-medium.bin), offline
summary_model: anthropic/claude-sonnet-5
---

# Q3 pricing review
_Sat 15 Aug 2026, 14:30 · 47m 12s_

## Summary
- ...five bullets...

## Decisions
- Ship the new tiers on 1 September.

## Action items
- **Dana** — rewrite the pricing page copy _(due Aug 20)_
- **Unassigned** — confirm the annual discount with finance

---

## Transcript

...every word, verbatim...
```

Owners are never guessed. If nobody was named, the action item says
`Unassigned`.
