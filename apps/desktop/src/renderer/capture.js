"use strict";

/**
 * Audio capture.
 *
 * Two streams go in - the microphone (you) and system loopback (everyone else
 * on the call) - and one mono 16 kHz PCM stream comes out, which is exactly the
 * format whisper.cpp expects. Doing the resample and downmix here in the Web
 * Audio graph means there is no ffmpeg dependency and no transcode step after
 * the meeting ends.
 */

const SAMPLE_RATE = 16000;

// Both sources are attenuated before summing so that a loud call plus a loud
// speaker does not clip the mix.
const MIC_GAIN = 0.85;
const SYSTEM_GAIN = 0.85;

/**
 * The worklet runs on the audio thread. It batches samples, converts to Int16
 * and hands finished blocks back, so the main thread never touches per-sample
 * work and the IPC fires ~4x a second instead of ~125x.
 */
const WORKLET_SOURCE = `
class PcmCollector extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(4096);
    this.offset = 0;
    this.peak = 0;
    this.blocksSinceLevel = 0;
    // Stopping disconnects this node, so the main thread asks for the last
    // partial block first - otherwise up to 0.25s of audio is dropped.
    this.port.onmessage = (event) => {
      if (event.data === 'flush') this.flush();
    };
  }

  flush() {
    if (this.offset === 0) return;
    const out = this.buffer.slice(0, this.offset);
    this.port.postMessage({ type: 'pcm', payload: out }, [out.buffer]);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channel = input[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      let sample = channel[i];
      if (sample > 1) sample = 1;
      else if (sample < -1) sample = -1;

      const magnitude = sample < 0 ? -sample : sample;
      if (magnitude > this.peak) this.peak = magnitude;

      this.buffer[this.offset++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      if (this.offset === this.buffer.length) this.flush();
    }

    // Report a level roughly 20x a second for the meter.
    if (++this.blocksSinceLevel >= 6) {
      this.port.postMessage({ type: 'level', payload: this.peak });
      this.peak = 0;
      this.blocksSinceLevel = 0;
    }
    return true;
  }
}
registerProcessor('pcm-collector', PcmCollector);
`;

let audioCtx = null;
let workletNode = null;
let micStream = null;
let systemStream = null;
let running = false;

/** Ask for system audio. Returns null (with a reason logged) if unavailable. */
async function getSystemStream() {
  try {
    // The video track is requested only because every platform ties system
    // audio to a screen-capture grant. It is kept at the smallest possible
    // size and frame rate, and never rendered - stopping it outright can tear
    // down the loopback session on some Windows audio stacks.
    return await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: { frameRate: 1, width: { max: 2 }, height: { max: 2 } },
    });
  } catch (err) {
    console.warn("System audio capture unavailable:", err.message);
    return null;
  }
}

/** Ask for the microphone. Returns null if the user or OS denied it. */
async function getMicStream() {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // Leave echo cancellation on: if the meeting is playing through
        // speakers, this stops the far end being recorded twice - once via
        // loopback and again through the microphone.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    console.warn("Microphone unavailable:", err.message);
    return null;
  }
}

async function start() {
  if (running) return;

  const [system, mic] = await Promise.all([getSystemStream(), getMicStream()]);

  const systemHasAudio = Boolean(system && system.getAudioTracks().length);
  const micHasAudio = Boolean(mic && mic.getAudioTracks().length);

  if (!systemHasAudio && !micHasAudio) {
    if (system) system.getTracks().forEach((t) => t.stop());
    if (mic) mic.getTracks().forEach((t) => t.stop());
    window.njyn.captureFailed(
      "Neither system audio nor the microphone could be captured.\n\n" +
        "On Windows, allow microphone access under Settings > Privacy & security > Microphone.\n" +
        "On macOS, grant Screen Recording and Microphone under System Settings > Privacy & Security.\n" +
        "On Linux, system audio needs PipeWire with the screen-cast portal installed.",
    );
    return;
  }

  systemStream = system;
  micStream = mic;

  // Asking for the context at 16 kHz makes Chromium resample both sources for
  // us on the audio thread.
  audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });

  const blobUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
  try {
    await audioCtx.audioWorklet.addModule(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }

  // Everything sums into one explicitly-mono node, so a stereo call and a mono
  // microphone end up in the same single channel.
  const mixer = new GainNode(audioCtx, {
    gain: 1,
    channelCount: 1,
    channelCountMode: "explicit",
    channelInterpretation: "speakers",
  });

  if (systemHasAudio) {
    new MediaStreamAudioSourceNode(audioCtx, { mediaStream: systemStream })
      .connect(new GainNode(audioCtx, { gain: SYSTEM_GAIN }))
      .connect(mixer);
  }
  if (micHasAudio) {
    new MediaStreamAudioSourceNode(audioCtx, { mediaStream: micStream })
      .connect(new GainNode(audioCtx, { gain: MIC_GAIN }))
      .connect(mixer);
  }

  workletNode = new AudioWorkletNode(audioCtx, "pcm-collector", {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
    channelCountMode: "explicit",
  });

  workletNode.port.onmessage = (event) => {
    const { type, payload } = event.data;
    if (type === "pcm") window.njyn.sendChunk(payload.buffer);
    else if (type === "level") window.njyn.sendLevel(payload);
  };

  mixer.connect(workletNode);

  // If the user revokes the screen share from the OS bar mid-meeting, keep
  // recording whatever is left rather than dropping the session.
  if (systemHasAudio) {
    systemStream.getAudioTracks()[0].addEventListener("ended", () => {
      console.warn("System audio track ended mid-recording.");
    });
  }

  running = true;
  window.njyn.captureStarted({ mic: micHasAudio, system: systemHasAudio });
}

async function stop() {
  if (!running) {
    window.njyn.captureStopped();
    return;
  }
  running = false;

  // Let the last partial block through before tearing the graph down.
  if (workletNode) {
    workletNode.port.postMessage("flush");
    await new Promise((resolve) => setTimeout(resolve, 80));
    workletNode.port.onmessage = null;
    workletNode.disconnect();
    workletNode = null;
  }

  for (const stream of [micStream, systemStream]) {
    if (stream) stream.getTracks().forEach((track) => track.stop());
  }
  micStream = null;
  systemStream = null;

  if (audioCtx) {
    await audioCtx.close();
    audioCtx = null;
  }

  window.njyn.sendLevel(0);
  window.njyn.captureStopped();
}

window.njyn.onStart(() => {
  start().catch((err) => window.njyn.captureFailed(err.message));
});
window.njyn.onStop(() => {
  stop().catch((err) => window.njyn.captureFailed(err.message));
});
