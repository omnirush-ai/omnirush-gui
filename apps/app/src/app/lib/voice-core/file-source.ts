import { resampleTo16k } from "./resample";
import { VOICE_SAMPLE_RATE, VoiceError, type AudioSource } from "./types";
import { decodeWav } from "./wav";

/** The test hook: a WAV file played in place of the microphone. */
export const VOICE_INPUT_FILE_ENV = "OMNIRUSH_VOICE_INPUT_FILE";

export function voiceInputFileFromEnv(env: Record<string, string | undefined>): string | null {
  const value = env[VOICE_INPUT_FILE_ENV]?.trim();
  return value ? value : null;
}

/**
 * An AudioSource that plays a WAV file (any PCM format, resampled to 16 kHz
 * mono) in chunks, paced in real time unless `realtime` is false. The caller
 * reads the file; this module never touches a file system.
 */
export class WavFileSource implements AudioSource {
  private readonly pcm: Int16Array;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(wavBytes: Uint8Array, private readonly options: { realtime?: boolean; chunkMs?: number } = {}) {
    let decoded;
    try {
      decoded = decodeWav(wavBytes);
    } catch (error) {
      throw new VoiceError("capture_failed", `The voice input file could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.pcm = resampleTo16k(decoded.samples, decoded.sampleRate);
  }

  get durationMs(): number {
    return (this.pcm.length / VOICE_SAMPLE_RATE) * 1000;
  }

  async start(onFrames: (frames: Int16Array) => void, onEnd?: (error?: VoiceError) => void): Promise<void> {
    this.stopped = false;
    const chunkMs = this.options.chunkMs ?? 100;
    const chunk = Math.round((VOICE_SAMPLE_RATE * chunkMs) / 1000);
    let offset = 0;
    const step = () => {
      if (this.stopped) return false;
      if (offset >= this.pcm.length) {
        this.stop();
        onEnd?.();
        return false;
      }
      onFrames(this.pcm.slice(offset, offset + chunk));
      offset += chunk;
      return true;
    };
    if (this.options.realtime === false) {
      // Delivered after start() resolves, as a microphone would.
      setTimeout(() => {
        while (step()) {
          // drain
        }
      }, 0);
      return;
    }
    this.timer = setInterval(step, chunkMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
