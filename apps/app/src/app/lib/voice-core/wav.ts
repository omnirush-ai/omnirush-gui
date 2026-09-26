import { VOICE_SAMPLE_RATE } from "./types";

/** A RIFF/WAVE file holding `samples` as 16-bit PCM, mono. */
export function encodeWav(samples: Int16Array, sampleRate = VOICE_SAMPLE_RATE): Uint8Array {
  const dataBytes = samples.length * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < samples.length; index += 1) view.setInt16(44 + index * 2, samples[index]!, true);
  return bytes;
}

export type DecodedWav = {
  sampleRate: number;
  /** Mono, -1..1 (channels averaged). */
  samples: Float32Array;
};

/**
 * Reads a PCM WAV file: 8/16/24/32-bit integer or 32-bit float, any channel
 * count and sample rate. Used by the file input override, never on mic audio.
 */
export function decodeWav(input: Uint8Array): DecodedWav {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const tag = (offset: number) => String.fromCharCode(...input.subarray(offset, offset + 4));
  if (input.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Not a WAV file");
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let offset = 12;
  while (offset + 8 <= input.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 26) format = view.getUint16(body + 24, true);
    } else if (id === "data") {
      if (!channels || !sampleRate || !bits) throw new Error("WAV data before its format");
      const end = Math.min(input.byteLength, body + size);
      const width = bits / 8;
      const frames = Math.floor((end - body) / (width * channels));
      const samples = new Float32Array(frames);
      for (let frame = 0; frame < frames; frame += 1) {
        let sum = 0;
        for (let channel = 0; channel < channels; channel += 1) {
          const at = body + (frame * channels + channel) * width;
          sum += readSample(view, at, format, bits);
        }
        samples[frame] = sum / channels;
      }
      return { sampleRate, samples };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV file has no data");
}

function readSample(view: DataView, at: number, format: number, bits: number): number {
  if (format === 3 && bits === 32) return view.getFloat32(at, true);
  if (format !== 1) throw new Error(`Unsupported WAV format ${format}`);
  switch (bits) {
    case 8:
      return (view.getUint8(at) - 128) / 128;
    case 16:
      return view.getInt16(at, true) / 32768;
    case 24: {
      const value = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16);
      return value / 8388608;
    }
    case 32:
      return view.getInt32(at, true) / 2147483648;
    default:
      throw new Error(`Unsupported WAV bit depth ${bits}`);
  }
}
