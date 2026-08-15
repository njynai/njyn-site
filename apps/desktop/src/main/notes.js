"use strict";

/**
 * Where notes live on disk and what they look like.
 *
 * One meeting produces two files that sit next to each other:
 *   ~/MeetingNotes/2026-08-15-1430.md
 *   ~/MeetingNotes/2026-08-15-1430.wav
 */

const fs = require("fs");
const path = require("path");

function pad(n) {
  return String(n).padStart(2, "0");
}

/** Local-time stamp, YYYY-MM-DD-HHMM. */
function stampFor(date) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

/**
 * Reserve the file names for a recording that starts now. Two meetings started
 * in the same minute get -2, -3 suffixes rather than overwriting each other.
 */
function sessionPaths(notesDir, date = new Date()) {
  fs.mkdirSync(notesDir, { recursive: true });

  const base = stampFor(date);
  let stamp = base;
  let n = 2;
  while (
    fs.existsSync(path.join(notesDir, `${stamp}.md`)) ||
    fs.existsSync(path.join(notesDir, `${stamp}.wav`))
  ) {
    stamp = `${base}-${n}`;
    n += 1;
  }

  return {
    stamp,
    startedAt: date,
    mdPath: path.join(notesDir, `${stamp}.md`),
    wavPath: path.join(notesDir, `${stamp}.wav`),
  };
}

/**
 * Inverse of stampFor. Returns null for anything that is not one of our names,
 * so a stray .wav in the folder cannot be mistaken for a meeting.
 */
function parseStamp(stamp) {
  const match = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(?:-\d+)?$/.exec(stamp);
  if (!match) return null;

  const [, year, month, day, hour, minute] = match.map(Number);
  const date = new Date(year, month - 1, day, hour, minute);

  // Date silently rolls over out-of-range parts - month 13 becomes January of
  // the next year - so confirm it round-trips rather than trusting it.
  const roundTrips =
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute;

  return roundTrips ? date : null;
}

function formatDuration(seconds) {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${pad(m)}m ${pad(s)}s` : `${m}m ${pad(s)}s`;
}

function formatWhen(date) {
  return date.toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Assemble the note: front matter, the summary, a divider, then the full
 * transcript verbatim. Nothing is dropped - if summarising failed, the reason
 * is written in place of the summary and the transcript is still saved.
 */
function buildMarkdown({
  stamp,
  startedAt,
  durationSeconds,
  title,
  summaryMarkdown,
  summaryError,
  transcript,
  transcriptEngine,
  llmModel,
  audioFile,
}) {
  const frontMatter = [
    "---",
    `date: ${stamp}`,
    `started: ${startedAt.toISOString()}`,
    `duration: ${formatDuration(durationSeconds)}`,
    audioFile ? `audio: ${audioFile}` : "audio: not kept",
    `transcription: ${transcriptEngine}`,
    `summary_model: ${llmModel || "none"}`,
    "---",
    "",
  ].join("\n");

  const heading = `# ${title ? `${title}` : "Meeting notes"}\n_${formatWhen(startedAt)} · ${formatDuration(durationSeconds)}_\n`;

  const body = summaryError
    ? `## Summary\n\n> Summary unavailable: ${summaryError}\n>\n> The full transcript is below and can be summarised later.`
    : summaryMarkdown;

  return [
    frontMatter,
    heading,
    body,
    "",
    "---",
    "",
    "## Transcript",
    "",
    transcript || "_No speech was transcribed._",
    "",
  ].join("\n");
}

function writeNote(mdPath, markdown) {
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  fs.writeFileSync(mdPath, markdown, "utf8");
  return mdPath;
}

module.exports = {
  sessionPaths,
  buildMarkdown,
  writeNote,
  stampFor,
  parseStamp,
  formatDuration,
};
