import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Original score for the Jianjian film: 24 bars, 120 BPM, six 8-second scenes.
// No recordings, downloads, plug-ins or platform audio APIs are required.
const TAU = Math.PI * 2;
const midiHz = (note) => 440 * 2 ** ((note - 69) / 12);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/** Render the original 48-second arrangement into stereo floating-point PCM. */
export function synthesizeScore({ sampleRate = 48000, duration = 48 } = {}) {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new RangeError('sampleRate must be an integer between 8000 and 192000');
  }
  if (!Number.isFinite(duration) || duration <= 0 || duration > 300) {
    throw new RangeError('duration must be greater than 0 and no more than 300 seconds');
  }
  const length = Math.round(sampleRate * duration);
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  const sendLeft = new Float32Array(length);
  const sendRight = new Float32Array(length);
  let seed = 0x4a49414e;
  const noise = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 2147483648 - 1;
  };

  function voice(start, seconds, gain, pan, wet, sample) {
    const first = Math.max(0, Math.round(start * sampleRate));
    const last = Math.min(length, Math.round((start + seconds) * sampleRate));
    const l = Math.cos((pan + 1) * Math.PI / 4) * gain;
    const r = Math.sin((pan + 1) * Math.PI / 4) * gain;
    for (let i = first; i < last; i++) {
      const value = sample((i - first) / sampleRate);
      left[i] += value * l;
      right[i] += value * r;
      sendLeft[i] += value * l * wet;
      sendRight[i] += value * r * wet;
    }
  }

  function pad(start, notes, seconds = 2.5, gain = 0.085) {
    notes.forEach((note, index) => {
      const hz = midiHz(note);
      const pan = (index / Math.max(1, notes.length - 1) - 0.5) * 1.35;
      voice(start, seconds, gain / Math.sqrt(notes.length), pan, 0.65, (t) => {
        const attack = 1 - Math.exp(-t * 7);
        const release = clamp((seconds - t) / 0.7, 0, 1);
        const p = TAU * hz * t;
        const breath = 0.9 + 0.1 * Math.sin(TAU * 0.23 * t + index);
        return attack * release * breath * (
          Math.sin(p) * 0.58 + Math.sin(p * 1.0021 + 0.4) * 0.22 +
          Math.sin(p * 0.9983 + 0.9) * 0.16 + Math.sin(p * 2) * 0.08 +
          Math.sin(p * 3) * 0.025
        );
      });
    });
  }

  function pluck(start, note, gain = 0.115, pan = 0, seconds = 1.1) {
    const hz = midiHz(note);
    voice(start, seconds, gain, pan, 0.6, (t) => {
      const env = (1 - Math.exp(-t * 300)) * Math.exp(-t * 4.1) *
        clamp((seconds - t) / 0.07, 0, 1);
      const p = TAU * hz * t;
      const bell = Math.sin(p + Math.sin(p * 2) * 0.75 * Math.exp(-t * 9));
      return env * (bell * 0.8 + Math.sin(p * 2.002) * 0.14 + Math.sin(p * 3) * 0.035);
    });
  }

  function bass(start, note, seconds = 0.38, gain = 0.17) {
    const hz = midiHz(note);
    voice(start, seconds, gain, 0, 0.035, (t) => {
      const p = TAU * hz * t;
      const env = (1 - Math.exp(-t * 125)) * Math.exp(-t * 1.8) *
        clamp((seconds - t) / 0.065, 0, 1);
      return env * (Math.sin(p) + Math.sin(p * 2) * 0.24 + Math.sin(p * 3) * 0.06);
    });
  }

  function kick(start, gain = 0.35) {
    voice(start, 0.46, gain, 0, 0.01, (t) => {
      // Integrating the exponentially falling frequency keeps the transient clean.
      const phase = TAU * (47 * t + 4.5 * (1 - Math.exp(-t * 35)));
      const body = Math.sin(phase) * Math.exp(-t * 10.5);
      const tick = Math.sin(TAU * 1550 * t) * Math.exp(-t * 180) * 0.07;
      return (body + tick) * (1 - Math.exp(-t * 900)) *
        clamp((0.46 - t) / 0.03, 0, 1);
    });
  }

  function snare(start, gain = 0.1, pan = 0.05) {
    let previous = 0;
    let low = 0;
    voice(start, 0.22, gain, pan, 0.16, (t) => {
      const n = noise();
      const high = n - previous * 0.8;
      previous = n;
      low += 0.3 * (high - low);
      const env = (1 - Math.exp(-t * 850)) * Math.exp(-t * 24);
      return (low * 1.5 + Math.sin(TAU * 188 * t) * Math.exp(-t * 40) * 0.65) *
        env * clamp((0.22 - t) / 0.03, 0, 1);
    });
  }

  function hat(start, gain = 0.027, pan = 0.25, open = false) {
    let previous = 0;
    let filtered = 0;
    const seconds = open ? 0.24 : 0.09;
    voice(start, seconds, gain, pan, 0.09, (t) => {
      const n = noise();
      const high = n - previous;
      previous = n;
      filtered += 0.64 * (high - filtered);
      return filtered * Math.exp(-t * (open ? 20 : 65)) *
        (1 - Math.exp(-t * 1200)) * clamp((seconds - t) / 0.015, 0, 1);
    });
  }

  function air(start, seconds, gain, rising = true) {
    let low = 0;
    voice(start, seconds, gain, -0.1, 0.9, (t) => {
      low += 0.065 * (noise() - low);
      const progress = t / seconds;
      const shape = Math.sin(Math.PI * progress) ** 2;
      const contour = rising ? progress : 1 - progress;
      return low * shape * (0.3 + contour * 0.7);
    });
  }

  const harmony = [
    { root: 38, notes: [50, 57, 60, 64, 69], arp: [74, 77, 81, 76] }, // Dm9
    { root: 34, notes: [46, 53, 57, 62, 65], arp: [74, 77, 81, 77] }, // Bbmaj7
    { root: 41, notes: [53, 57, 60, 64, 67], arp: [72, 77, 79, 76] }, // Fmaj9
    { root: 36, notes: [48, 55, 58, 62, 67], arp: [74, 79, 82, 79] }, // C9sus
  ];
  const melody = [
    [[0, 74], [0.75, 77], [1.25, 81], [1.75, 79]],
    [[0.25, 77], [1, 74], [1.5, 72]],
    [[0, 72], [0.75, 77], [1.25, 79], [1.75, 76]],
    [[0.25, 74], [1, 72], [1.5, 69]],
  ];
  const bars = Math.ceil(Math.min(duration, 48) / 2);

  for (let bar = 0; bar < bars; bar++) {
    const start = bar * 2;
    const scene = Math.floor(bar / 4);
    const phrase = bar % 4;
    const chord = bar >= 22 ? harmony[0] : harmony[phrase];
    const finalBar = bar === 23;

    pad(start, chord.notes, finalBar ? 2 : 2.7, scene === 0 ? 0.095 : 0.075);
    if (scene === 0) {
      // A soft three-note identity gradually acquires a pulse.
      if (bar < 2) {
        pluck(start + 0.12, 74, 0.11, -0.25, 1.7);
        pluck(start + 0.87, 81, 0.08, 0.3, 1.4);
      } else {
        melody[phrase].forEach(([offset, note], i) =>
          pluck(start + offset, note, 0.105, (i % 2 ? 1 : -1) * 0.23));
        kick(start, 0.19);
        bass(start, chord.root, 0.7, 0.13);
        for (let beat = 0; beat < 4; beat++) hat(start + beat * 0.5 + 0.25, 0.013);
      }
      continue;
    }

    if (scene === 4) {
      // The private-server scene opens a quieter, wider space before the reprise.
      kick(start, 0.255);
      if (phrase > 1) kick(start + 1, 0.24);
      bass(start, chord.root, 1.25, 0.18);
      snare(start + 1, 0.07, -0.08);
      pluck(start + 0.12, chord.arp[0] - 12, 0.13, -0.38, 1.6);
      pluck(start + 1.12, chord.arp[2] - 12, 0.095, 0.4, 1.4);
      for (let beat = 0; beat < 4; beat++) hat(start + beat * 0.5 + 0.25, 0.018);
      continue;
    }

    if (!finalBar) {
      for (let beat = 0; beat < 4; beat++) {
        kick(start + beat * 0.5, scene === 5 ? 0.27 : 0.31);
        bass(start + beat * 0.5 + 0.07,
          chord.root + (beat === 3 && scene === 3 ? 12 : 0), 0.32, 0.145);
        if (beat % 2 === 1) snare(start + beat * 0.5, 0.11);
        hat(start + beat * 0.5 + 0.25, 0.034, beat % 2 ? -0.3 : 0.35,
          scene === 3 && beat === 3);
        if (scene === 2 || scene === 3) {
          hat(start + beat * 0.5, 0.017, -0.4);
          hat(start + beat * 0.5 + 0.375, 0.012, 0.45);
        }
      }
    } else {
      kick(start, 0.23);
      bass(start, 38, 1.5, 0.13);
    }

    const motif = bar === 22 ? [[0, 77], [0.75, 76], [1.25, 74]] :
      finalBar ? [[0.04, 74], [0.06, 81], [0.08, 86]] : melody[phrase];
    motif.forEach(([offset, note], i) =>
      pluck(start + offset, note, scene === 3 ? 0.135 : 0.115,
        (i % 2 ? 1 : -1) * 0.18, finalBar ? 1.85 : 1.25));

    if ((scene === 2 || scene === 3) && !finalBar) {
      for (let eighth = 0; eighth < 8; eighth++) {
        const note = chord.arp[eighth % 4] - 12;
        pluck(start + eighth * 0.25 + 0.125, note,
          eighth % 2 ? 0.034 : 0.041, eighth % 2 ? -0.6 : 0.6, 0.6);
      }
    }
  }

  [6.7, 14.7, 22.7, 30.7, 38.7].forEach((time) => air(time, 1.3, 0.12));
  [8, 16, 24, 32, 40].forEach((time) => air(time, 1.8, 0.065, false));

  // Stereo taps provide a restrained, tempo-related ambience. Cross-feeding the
  // channels makes the musical echoes diffuse without obscuring the kick/bass.
  const taps = [
    [0.1875, 0.16, false], [0.375, 0.24, true], [0.5625, 0.13, false],
    [0.753, 0.12, true], [1.127, 0.065, false], [1.491, 0.036, true],
  ];
  for (const [seconds, gain, cross] of taps) {
    const delay = Math.round(seconds * sampleRate);
    let smoothL = 0;
    let smoothR = 0;
    const alpha = 1 - Math.exp(-TAU * 3700 / sampleRate);
    for (let i = delay; i < length; i++) {
      smoothL += alpha * ((cross ? sendRight : sendLeft)[i - delay] - smoothL);
      smoothR += alpha * ((cross ? sendLeft : sendRight)[i - delay] - smoothR);
      left[i] += smoothL * gain;
      right[i] += smoothR * gain;
    }
  }

  let peak = 0;
  let dcL = 0;
  let dcR = 0;
  const dcAlpha = 1 - Math.exp(-TAU * 18 / sampleRate);
  for (let i = 0; i < length; i++) {
    const time = i / sampleRate;
    const fadeIn = clamp(time / 0.035, 0, 1);
    const fadeOut = clamp((duration - time) / Math.min(2.4, duration / 3), 0, 1);
    const envelope = fadeIn * Math.sin(fadeOut * Math.PI / 2) ** 2;
    dcL += dcAlpha * (left[i] - dcL);
    dcR += dcAlpha * (right[i] - dcR);
    left[i] = Math.tanh((left[i] - dcL) * 1.7) * envelope;
    right[i] = Math.tanh((right[i] - dcR) * 1.7) * envelope;
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  }
  const master = peak > 0 ? 0.9 / peak : 1;
  for (let i = 0; i < length; i++) {
    left[i] *= master;
    right[i] *= master;
  }
  return { sampleRate, channels: [left, right] };
}

/** Encode stereo samples as a standard little-endian 16-bit PCM WAVE file. */
export function encodeWav({ sampleRate, channels }) {
  if (!Number.isInteger(sampleRate) || sampleRate < 1 ||
      !Array.isArray(channels) || channels.length !== 2 ||
      !(channels[0] instanceof Float32Array) || !(channels[1] instanceof Float32Array) ||
      channels[0].length !== channels[1].length) {
    throw new TypeError('Expected a sampleRate and two equal-length Float32Array channels');
  }
  const frames = channels[0].length;
  const dataBytes = frames * 4;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames; i++) {
    for (let channel = 0; channel < 2; channel++) {
      const value = channels[channel][i];
      if (!Number.isFinite(value)) throw new RangeError('Audio samples must be finite');
      const sample = clamp(value, -1, 1);
      buffer.writeInt16LE(Math.round(sample * (sample < 0 ? 32768 : 32767)),
        44 + i * 4 + channel * 2);
    }
  }
  return buffer;
}

/** Synchronously render and save the score; return the absolute output path. */
export function writeScore(outputPath, options) {
  const destination = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, encodeWav(synthesizeScore(options)));
  return destination;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputPath = process.argv[2] ?? 'test-results/mv-score.wav';
  console.log(writeScore(outputPath));
}
