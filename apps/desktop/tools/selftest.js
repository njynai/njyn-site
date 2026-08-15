#!/usr/bin/env node
/**
 * Self-test for the parts of the app that do not need Electron: the WAV
 * writer/splitter, the chunk stitcher, note formatting, config resolution and
 * the summary renderer.
 *
 * Run with: npm run selftest
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { WavWriter, readWavInfo, splitWav } = require("../src/main/wav");
const { stitch } = require("../src/main/transcribe");
const { renderNotes, extractJson } = require("../src/main/summarize");
const {
  sessionPaths,
  buildMarkdown,
  stampFor,
  parseStamp,
  formatDuration,
} = require("../src/main/notes");
const { parseEnv, buildConfig } = require("../src/main/config");
const { scanRecordings } = require("../src/main/pipeline");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "njyn-selftest-"));
let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
}

/** A second of 440 Hz tone as Int16 mono at 16 kHz. */
function tone(seconds, sampleRate = 16000) {
  const samples = Math.floor(seconds * sampleRate);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000), i * 2);
  }
  return buf;
}

console.log("\nwav");

test("writes a header a decoder can read back", () => {
  const file = path.join(tmp, "a.wav");
  const w = new WavWriter(file, { sampleRate: 16000, channels: 1 });
  w.write(tone(2));
  assert.ok(Math.abs(w.durationSeconds - 2) < 0.001, "duration tracked while writing");
  w.close();

  const info = readWavInfo(file);
  assert.strictEqual(info.sampleRate, 16000);
  assert.strictEqual(info.channels, 1);
  assert.strictEqual(info.bitsPerSample, 16);
  assert.strictEqual(info.dataBytes, 16000 * 2 * 2);
  assert.ok(Math.abs(info.durationSeconds - 2) < 0.001);

  // File length must equal header + data exactly, or players report garbage.
  assert.strictEqual(fs.statSync(file).size, 44 + info.dataBytes);
});

test("RIFF size field matches the file", () => {
  const file = path.join(tmp, "b.wav");
  const w = new WavWriter(file);
  w.write(tone(0.5));
  w.close();

  const head = fs.readFileSync(file).subarray(0, 44);
  assert.strictEqual(head.toString("ascii", 0, 4), "RIFF");
  assert.strictEqual(head.toString("ascii", 8, 12), "WAVE");
  assert.strictEqual(head.readUInt32LE(4), fs.statSync(file).size - 8);
});

test("streams many small writes without loss", () => {
  const file = path.join(tmp, "c.wav");
  const w = new WavWriter(file);
  const block = tone(0.01);
  for (let i = 0; i < 300; i++) w.write(block);
  w.close();
  assert.strictEqual(readWavInfo(file).dataBytes, block.length * 300);
});

test("abort removes the file", () => {
  const file = path.join(tmp, "d.wav");
  const w = new WavWriter(file);
  w.write(tone(0.2));
  w.abort();
  assert.ok(!fs.existsSync(file));
});

test("splits a long recording into playable chunks", () => {
  const file = path.join(tmp, "long.wav");
  const w = new WavWriter(file);
  w.write(tone(30));
  w.close();

  const outDir = fs.mkdtempSync(path.join(tmp, "chunks-"));
  const parts = splitWav(file, outDir, { chunkSeconds: 10, overlapSeconds: 2 });

  assert.ok(parts.length >= 3, `expected several chunks, got ${parts.length}`);
  for (const part of parts) {
    const info = readWavInfo(part);
    assert.strictEqual(info.sampleRate, 16000);
    assert.ok(info.durationSeconds <= 10.001, "chunk stays within the limit");
    assert.strictEqual(fs.statSync(part).size, 44 + info.dataBytes, "chunk header is consistent");
  }

  // Chunks must cover the whole recording, overlap included.
  const covered = parts.reduce((sum, p) => sum + readWavInfo(p).durationSeconds, 0);
  assert.ok(covered >= 30, `chunks cover the full 30s (got ${covered.toFixed(2)}s)`);
});

test("short files are not split", () => {
  const file = path.join(tmp, "short.wav");
  const w = new WavWriter(file);
  w.write(tone(5));
  w.close();
  assert.deepStrictEqual(splitWav(file, tmp, { chunkSeconds: 600 }), [file]);
});

console.log("\ntranscript stitching");

test("drops the duplicated overlap between chunks", () => {
  const joined = stitch([
    "we should ship the beta on friday and tell the team",
    "and tell the team about the pricing change",
  ]);
  assert.strictEqual(
    joined,
    "we should ship the beta on friday and tell the team about the pricing change",
  );
});

test("keeps both halves when nothing overlaps", () => {
  const joined = stitch(["first part here", "second part here"]);
  assert.strictEqual(joined, "first part here second part here");
});

test("handles a single chunk and empty pieces", () => {
  assert.strictEqual(stitch(["only one"]), "only one");
  assert.strictEqual(stitch(["", "  ", "real"]), "real");
  assert.strictEqual(stitch([]), "");
});

console.log("\nsummary rendering");

test("renders summary, decisions and owners", () => {
  const md = renderNotes({
    summary: ["a", "b", "c", "d", "e"],
    decisions: ["ship friday"],
    actions: [{ task: "update pricing page", owner: "Dana", due: "Aug 20" }],
  });
  assert.ok(md.includes("## Summary"));
  assert.ok(md.includes("## Decisions"));
  assert.ok(md.includes("## Action items"));
  assert.ok(md.includes("**Dana** — update pricing page"));
  assert.ok(md.includes("_(due Aug 20)_"));
});

test("caps the summary at five bullets", () => {
  const md = renderNotes({ summary: ["a", "b", "c", "d", "e", "f", "g"], decisions: [], actions: [] });
  assert.strictEqual(md.split("\n").filter((l) => l.startsWith("- ")).length, 5);
});

test("says so plainly when a section is empty", () => {
  const md = renderNotes({ summary: [], decisions: [], actions: [] });
  assert.ok(md.includes("_No decisions were recorded._"));
  assert.ok(md.includes("_No action items were assigned._"));
});

test("an action with no owner reads Unassigned, never a guess", () => {
  const md = renderNotes({ summary: [], decisions: [], actions: [{ task: "book the venue" }] });
  assert.ok(md.includes("**Unassigned** — book the venue"));
});

test("extracts JSON from fenced or chatty responses", () => {
  assert.deepStrictEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepStrictEqual(extractJson('Sure! {"a":2} hope that helps'), { a: 2 });
  assert.strictEqual(extractJson("no json at all"), null);
  assert.strictEqual(extractJson("{ broken: "), null);
});

console.log("\nnotes on disk");

test("names files YYYY-MM-DD-HHMM", () => {
  assert.strictEqual(stampFor(new Date(2026, 7, 15, 14, 30)), "2026-08-15-1430");
  assert.strictEqual(stampFor(new Date(2026, 0, 2, 9, 5)), "2026-01-02-0905");
});

test("keeps audio beside the note", () => {
  const dir = path.join(tmp, "MeetingNotes");
  const s = sessionPaths(dir, new Date(2026, 7, 15, 14, 30));
  assert.strictEqual(path.basename(s.mdPath), "2026-08-15-1430.md");
  assert.strictEqual(path.basename(s.wavPath), "2026-08-15-1430.wav");
  assert.strictEqual(path.dirname(s.mdPath), path.dirname(s.wavPath));
});

test("does not overwrite a meeting from the same minute", () => {
  const dir = path.join(tmp, "MeetingNotes");
  const when = new Date(2026, 7, 15, 16, 0);
  const first = sessionPaths(dir, when);
  fs.writeFileSync(first.mdPath, "x");
  const second = sessionPaths(dir, when);
  assert.notStrictEqual(first.mdPath, second.mdPath);
  assert.ok(second.stamp.endsWith("-2"));
});

test("summary sits above the divider and the transcript below", () => {
  const md = buildMarkdown({
    stamp: "2026-08-15-1430",
    startedAt: new Date(2026, 7, 15, 14, 30),
    durationSeconds: 1830,
    title: "Pricing review",
    summaryMarkdown: renderNotes({ summary: ["a"], decisions: ["b"], actions: [] }),
    summaryError: null,
    transcript: "THE FULL TRANSCRIPT TEXT",
    transcriptEngine: "whisper.cpp (ggml-medium.bin), offline",
    llmModel: "anthropic/claude-sonnet-5",
    audioFile: "2026-08-15-1430.wav",
  });

  const divider = md.indexOf("\n---\n", md.indexOf("## Summary"));
  assert.ok(divider > -1, "there is a divider after the summary");
  assert.ok(md.indexOf("## Summary") < divider, "summary is above the divider");
  assert.ok(md.indexOf("THE FULL TRANSCRIPT TEXT") > divider, "transcript is below it");
  assert.ok(md.includes("audio: 2026-08-15-1430.wav"), "front matter points at the audio");
  assert.ok(md.includes("# Pricing review"));
  assert.ok(md.includes("30m 30s"));
});

test("a failed summary still saves the transcript", () => {
  const md = buildMarkdown({
    stamp: "2026-08-15-1430",
    startedAt: new Date(2026, 7, 15, 14, 30),
    durationSeconds: 60,
    title: null,
    summaryMarkdown: "",
    summaryError: "no API key",
    transcript: "STILL HERE",
    transcriptEngine: "whisper.cpp",
    llmModel: null,
    audioFile: "x.wav",
  });
  assert.ok(md.includes("Summary unavailable: no API key"));
  assert.ok(md.includes("STILL HERE"));
});

test("formats durations", () => {
  assert.strictEqual(formatDuration(45), "0m 45s");
  assert.strictEqual(formatDuration(1830), "30m 30s");
  assert.strictEqual(formatDuration(3725), "1h 02m 05s");
});

console.log("\nrecovery");

/** Build a notes folder with a recording and, optionally, its note. */
function seedRecording(dir, stamp, note) {
  fs.mkdirSync(dir, { recursive: true });
  const w = new WavWriter(path.join(dir, `${stamp}.wav`));
  w.write(tone(2));
  w.close();
  if (note !== undefined) fs.writeFileSync(path.join(dir, `${stamp}.md`), note);
}

test("parseStamp is the inverse of stampFor", () => {
  const when = new Date(2026, 7, 15, 14, 30);
  const parsed = parseStamp(stampFor(when));
  assert.strictEqual(parsed.getTime(), when.getTime());
});

test("parseStamp handles the same-minute suffix and rejects junk", () => {
  assert.strictEqual(parseStamp("2026-08-15-1430-2").getHours(), 14);
  assert.strictEqual(parseStamp("some-other-recording"), null);
  assert.strictEqual(parseStamp("2026-13-99-9999"), null);
});

test("a recording with no note needs attention", () => {
  const dir = path.join(tmp, "recovery-a");
  seedRecording(dir, "2026-08-15-1000");

  const found = scanRecordings(dir);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].needsAttention, true);
  assert.strictEqual(found[0].hasNote, false);
  assert.match(found[0].reason, /no note/);
  assert.ok(found[0].durationSeconds > 1.9, "reads the duration off the wav");
});

test("a note written after a failure needs attention", () => {
  const dir = path.join(tmp, "recovery-b");
  seedRecording(
    dir,
    "2026-08-15-1100",
    buildMarkdown({
      stamp: "2026-08-15-1100",
      startedAt: new Date(2026, 7, 15, 11, 0),
      durationSeconds: 120,
      title: null,
      summaryMarkdown: "",
      summaryError: "the API key was rejected",
      transcript: "kept anyway",
      transcriptEngine: "failed",
      llmModel: null,
      audioFile: "2026-08-15-1100.wav",
    }),
  );

  const [found] = scanRecordings(dir);
  assert.strictEqual(found.needsAttention, true);
  assert.match(found.reason, /failed/);
});

test("a good note is left alone", () => {
  const dir = path.join(tmp, "recovery-c");
  seedRecording(
    dir,
    "2026-08-15-1200",
    buildMarkdown({
      stamp: "2026-08-15-1200",
      startedAt: new Date(2026, 7, 15, 12, 0),
      durationSeconds: 120,
      title: "All good",
      summaryMarkdown: "## Summary\n- it worked",
      summaryError: null,
      transcript: "words",
      transcriptEngine: "whisper.cpp",
      llmModel: "anthropic/claude-sonnet-5",
      audioFile: "2026-08-15-1200.wav",
    }),
  );

  const [found] = scanRecordings(dir);
  assert.strictEqual(found.needsAttention, false);
  assert.strictEqual(found.reason, null);
});

test("scans newest first and survives a missing folder", () => {
  const dir = path.join(tmp, "recovery-d");
  seedRecording(dir, "2026-08-13-0900");
  seedRecording(dir, "2026-08-15-0900");
  seedRecording(dir, "2026-08-14-0900");

  assert.deepStrictEqual(
    scanRecordings(dir).map((entry) => entry.stamp),
    ["2026-08-15-0900", "2026-08-14-0900", "2026-08-13-0900"],
  );
  assert.deepStrictEqual(scanRecordings(path.join(tmp, "does-not-exist")), []);
});

console.log("\nconfig");

test("parses .env, quotes and comments included", () => {
  const env = parseEnv(
    ['# comment', 'OPENAI_API_KEY="sk-test-123"', "GROQ_API_KEY='g-456'", "", "export FOO=bar", "BAD_LINE"].join(
      "\n",
    ),
  );
  assert.strictEqual(env.OPENAI_API_KEY, "sk-test-123");
  assert.strictEqual(env.GROQ_API_KEY, "g-456");
  assert.strictEqual(env.FOO, "bar");
  assert.ok(!("BAD_LINE" in env));
});

test("keys in an equals-bearing value survive intact", () => {
  assert.strictEqual(parseEnv("K=abc=def==").K, "abc=def==");
});

test("picks a hosted engine only when there is no local one", () => {
  const dir = fs.mkdtempSync(path.join(tmp, "cfg-"));
  fs.writeFileSync(path.join(dir, ".env"), "GROQ_API_KEY=g-key\nANTHROPIC_API_KEY=a-key\n");

  const cfg = buildConfig(dir);
  // The test machine has no whisper.cpp, so it must fall back to Groq.
  assert.strictEqual(cfg.localReady, false);
  assert.strictEqual(cfg.transcribeMode, "groq");
  assert.strictEqual(cfg.llmProvider, "anthropic");
  assert.strictEqual(cfg.llmModel, "claude-sonnet-5");
  assert.ok(cfg.notesDir.endsWith("MeetingNotes"));
});

test("TRANSCRIBE_PROVIDER=local wins even with keys present", () => {
  const dir = fs.mkdtempSync(path.join(tmp, "cfg2-"));
  fs.writeFileSync(path.join(dir, ".env"), "GROQ_API_KEY=g\nTRANSCRIBE_PROVIDER=local\n");
  assert.strictEqual(buildConfig(dir).transcribeMode, "local");
});

test("NOTES_DIR expands a leading tilde", () => {
  const dir = fs.mkdtempSync(path.join(tmp, "cfg3-"));
  fs.writeFileSync(path.join(dir, ".env"), "NOTES_DIR=~/Elsewhere\n");
  const cfg = buildConfig(dir);
  assert.strictEqual(cfg.notesDir, path.join(os.homedir(), "Elsewhere"));
  assert.ok(!cfg.notesDir.includes("~"));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(
  `\n${passed} passed${process.exitCode ? ", with failures above" : ""}\n`,
);
