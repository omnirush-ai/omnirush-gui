import { VOICE_SAMPLE_RATE } from "./types";

function toInt16(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value));
  return clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
}

/**
 * A streaming converter from float audio at `inputRate` to 16 kHz Int16.
 * Downsampling averages every input sample that falls inside an output
 * sample's window (a box filter: cheap, and enough against aliasing for
 * speech); upsampling interpolates linearly. State carries across calls, so
 * chunk boundaries leave no clicks.
 */
export class Downsampler {
  private readonly ratio: number;
  /** Position of the next output sample, in input samples from the start of the pending chunk. */
  private position = 0;
  private carry: Float32Array = new Float32Array(0);

  constructor(readonly inputRate: number, readonly outputRate = VOICE_SAMPLE_RATE) {
    if (!(inputRate > 0) || !(outputRate > 0)) throw new Error("Sample rates must be positive");
    this.ratio = inputRate / outputRate;
  }

  push(input: Float32Array): Int16Array {
    if (this.inputRate === this.outputRate) {
      const out = new Int16Array(input.length);
      for (let index = 0; index < input.length; index += 1) out[index] = toInt16(input[index]!);
      return out;
    }
    const data = new Float32Array(this.carry.length + input.length);
    data.set(this.carry);
    data.set(input, this.carry.length);
    const out: number[] = [];
    if (this.ratio >= 1) {
      while (this.position + this.ratio <= data.length) {
        const start = Math.floor(this.position);
        const end = Math.floor(this.position + this.ratio);
        let sum = 0;
        for (let index = start; index < end; index += 1) sum += data[index]!;
        out.push(toInt16(sum / Math.max(1, end - start)));
        this.position += this.ratio;
      }
    } else {
      while (this.position + 1 < data.length) {
        const index = Math.floor(this.position);
        const fraction = this.position - index;
        out.push(toInt16(data[index]! * (1 - fraction) + data[index + 1]! * fraction));
        this.position += this.ratio;
      }
    }
    const consumed = Math.floor(this.position);
    this.carry = data.slice(consumed);
    this.position -= consumed;
    return Int16Array.from(out);
  }
}

/** Whole-buffer conversion (file input). */
export function resampleTo16k(samples: Float32Array, inputRate: number): Int16Array {
  return new Downsampler(inputRate).push(samples);
}
