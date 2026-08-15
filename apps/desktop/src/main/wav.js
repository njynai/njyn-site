"use strict";

/**
 * Streaming 16-bit PCM WAV writer, plus a splitter for hosted-API uploads.
 *
 * The renderer hands us mono 16 kHz Int16 samples, which is exactly what
 * whisper.cpp wants, so the recording is written straight to its final format
 * with no transcode step and no ffmpeg dependency.
 */

const fs = require("fs");

const HEADER_BYTES = 44;

function buildHeader({ sampleRate, channels, dataBytes }) {
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  const h = Buffer.alloc(HEADER_BYTES);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + dataBytes, 4); // RIFF chunk size
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16); // fmt chunk size (PCM)
  h.writeUInt16LE(1, 20); // audio format: PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bitsPerSample, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/**
 * Appends PCM to disk as it arrives so a long meeting never sits in memory,
 * then patches the two length fields in the header on close.
 */
class WavWriter {
  constructor(filePath, { sampleRate = 16000, channels = 1 } = {}) {
    this.filePath = filePath;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.dataBytes = 0;
    this.closed = false;

    this.fd = fs.openSync(filePath, "w");
    // Placeholder header; sizes are rewritten in close().
    fs.writeSync(this.fd, buildHeader({ sampleRate, channels, dataBytes: 0 }));
  }

  write(buffer) {
    if (this.closed || !buffer || buffer.length === 0) return;
    fs.writeSync(this.fd, buffer);
    this.dataBytes += buffer.length;
  }

  /** Seconds of audio written so far. */
  get durationSeconds() {
    return this.dataBytes / (this.sampleRate * this.channels * 2);
  }

  close() {
    if (this.closed) return this.filePath;
    this.closed = true;

    const header = buildHeader({
      sampleRate: this.sampleRate,
      channels: this.channels,
      dataBytes: this.dataBytes,
    });
    fs.writeSync(this.fd, header, 0, header.length, 0);
    fs.closeSync(this.fd);
    return this.filePath;
  }

  /** Close and remove the file - used when a recording is discarded. */
  abort() {
    if (!this.closed) {
      this.closed = true;
      try {
        fs.closeSync(this.fd);
      } catch {
        /* already closed */
      }
    }
    try {
      fs.unlinkSync(this.filePath);
    } catch {
      /* nothing to remove */
    }
  }
}

/** Read just enough of a WAV header to know its shape. */
function readWavInfo(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const head = Buffer.alloc(HEADER_BYTES);
    fs.readSync(fd, head, 0, HEADER_BYTES, 0);
    const channels = head.readUInt16LE(22);
    const sampleRate = head.readUInt32LE(24);
    const bitsPerSample = head.readUInt16LE(34);
    const dataBytes = head.readUInt32LE(40);
    const bytesPerSecond = (sampleRate * channels * bitsPerSample) / 8;
    return {
      channels,
      sampleRate,
      bitsPerSample,
      dataBytes,
      durationSeconds: bytesPerSecond ? dataBytes / bytesPerSecond : 0,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Split a WAV into standalone WAV files of at most `chunkSeconds` each.
 *
 * Hosted Whisper endpoints cap uploads at 25 MB, which a long meeting blows
 * straight past. Splitting on a plain time boundary can clip a word in half, so
 * chunks overlap slightly and the transcripts are stitched back together by the
 * caller. Returns the list of files written into `outDir`.
 */
function splitWav(filePath, outDir, { chunkSeconds = 600, overlapSeconds = 2 } = {}) {
  const info = readWavInfo(filePath);
  const bytesPerSample = (info.bitsPerSample / 8) * info.channels;
  const bytesPerSecond = bytesPerSample * info.sampleRate;

  const chunkBytes = Math.floor(chunkSeconds * bytesPerSecond / bytesPerSample) * bytesPerSample;
  const overlapBytes =
    Math.floor((overlapSeconds * bytesPerSecond) / bytesPerSample) * bytesPerSample;

  if (info.dataBytes <= chunkBytes) return [filePath];

  const parts = [];
  const fd = fs.openSync(filePath, "r");
  try {
    let offset = 0;
    let index = 0;
    while (offset < info.dataBytes) {
      const length = Math.min(chunkBytes, info.dataBytes - offset);
      const pcm = Buffer.alloc(length);
      fs.readSync(fd, pcm, 0, length, HEADER_BYTES + offset);

      const partPath = `${outDir}/chunk-${String(index).padStart(3, "0")}.wav`;
      fs.writeFileSync(
        partPath,
        Buffer.concat([
          buildHeader({
            sampleRate: info.sampleRate,
            channels: info.channels,
            dataBytes: length,
          }),
          pcm,
        ]),
      );
      parts.push(partPath);

      index += 1;
      offset += chunkBytes - overlapBytes;
      if (chunkBytes <= overlapBytes) break; // guard against a pathological config
    }
  } finally {
    fs.closeSync(fd);
  }
  return parts;
}

module.exports = { WavWriter, readWavInfo, splitWav, HEADER_BYTES };
