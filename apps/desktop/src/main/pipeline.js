"use strict";

/**
 * Audio file -> saved note.
 *
 * The same path runs for a meeting that just ended and for one being
 * re-processed after a failure, so a recording whose transcription died on a
 * bad key or a dropped connection can be recovered later. The .wav is the
 * source of truth; the .md is derived from it and safe to rewrite.
 */

const fs = require("fs");
const path = require("path");

const { transcribe } = require("./transcribe");
const { summarize } = require("./summarize");
const { buildMarkdown, writeNote } = require("./notes");
const { readWavInfo } = require("./wav");

/**
 * @param {object} options
 * @param {object} options.config      resolved config
 * @param {string} options.wavPath     recording to process
 * @param {string} options.stamp       YYYY-MM-DD-HHMM identity for this meeting
 * @param {Date}   options.startedAt   when the meeting began
 * @param {number} options.durationSeconds
 * @param {string} options.mdPath      note to write
 * @param {(stage: string, percent: number|null) => void} [options.onProgress]
 * @param {boolean} [options.keepAudio]
 *
 * @returns {Promise<{mdPath: string, title: string|null, summaryError: string|null,
 *                    transcriptEngine: string, hadTranscript: boolean}>}
 */
async function processAudio({
  config,
  wavPath,
  stamp,
  startedAt,
  durationSeconds,
  mdPath,
  onProgress = () => {},
  keepAudio = true,
}) {
  let transcript = "";
  let transcriptEngine = "unknown";
  let summaryMarkdown = "";
  let summaryError = null;
  let title = null;
  let llmModel = null;

  try {
    onProgress("Transcribing", 0);
    const result = await transcribe(config, wavPath, (percent) =>
      onProgress("Transcribing", percent),
    );
    transcript = result.text;
    transcriptEngine = result.engine;
  } catch (err) {
    // Without a transcript there is nothing to summarise, but the audio is
    // still on disk and the note records why - so this is recoverable.
    transcriptEngine = "failed";
    summaryError = `transcription failed - ${err.message}`;
  }

  if (transcript) {
    try {
      onProgress("Summarising", null);
      const summary = await summarize(config, transcript);
      summaryMarkdown = summary.markdown;
      title = summary.title;
      llmModel = summary.model;
    } catch (err) {
      summaryError = err.message;
    }
  }

  writeNote(
    mdPath,
    buildMarkdown({
      stamp,
      startedAt,
      durationSeconds,
      title,
      summaryMarkdown,
      summaryError,
      transcript,
      transcriptEngine,
      llmModel,
      audioFile: keepAudio ? path.basename(wavPath) : null,
    }),
  );

  if (!keepAudio) {
    try {
      fs.unlinkSync(wavPath);
    } catch {
      /* already gone */
    }
  }

  return {
    mdPath,
    title,
    summaryError,
    transcriptEngine,
    hadTranscript: Boolean(transcript),
  };
}

/**
 * Everything recoverable in the notes folder.
 *
 * A recording "needs attention" when it has no note at all, or when its note
 * carries the marker that summarising or transcription failed. Those are
 * exactly the ones worth offering a retry for.
 */
function scanRecordings(notesDir) {
  let entries;
  try {
    entries = fs.readdirSync(notesDir);
  } catch {
    return [];
  }

  return entries
    .filter((name) => name.endsWith(".wav"))
    .map((name) => {
      const stamp = name.slice(0, -4);
      const wavPath = path.join(notesDir, name);
      const mdPath = path.join(notesDir, `${stamp}.md`);

      let note = null;
      try {
        note = fs.readFileSync(mdPath, "utf8");
      } catch {
        /* no note yet */
      }

      let durationSeconds = 0;
      try {
        durationSeconds = readWavInfo(wavPath).durationSeconds;
      } catch {
        /* unreadable or truncated */
      }

      const reason = !note
        ? "no note was written"
        : note.includes("Summary unavailable:")
          ? "transcription or summary failed"
          : null;

      return {
        stamp,
        wavPath,
        mdPath,
        durationSeconds,
        hasNote: Boolean(note),
        needsAttention: Boolean(reason),
        reason,
      };
    })
    .sort((a, b) => b.stamp.localeCompare(a.stamp));
}

module.exports = { processAudio, scanRecordings };
