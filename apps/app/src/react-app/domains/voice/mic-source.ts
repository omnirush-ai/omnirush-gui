import { Downsampler, VOICE_SAMPLE_RATE, VoiceError, type AudioSource } from "@/app/lib/voice-core";

/**
 * Posts each 128-frame render quantum of channel 0 to the main thread. The
 * worklet only forwards: resampling and VAD run in voice-core.
 */
const WORKLET_SOURCE = `
class OmniRushCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("omnirush-capture", OmniRushCaptureProcessor);
`;

/** How long the microphone stays open after a recording, so the next one starts without a cold start. */
const KEEP_WARM_MS = 30_000;

type OpenMic = {
  deviceId: string | null;
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  node: AudioWorkletNode | ScriptProcessorNode;
  /** Where the worklet's samples go while a recording listens. */
  sink: { listener: ((samples: Float32Array) => void) | null };
  releaseTimer: ReturnType<typeof setTimeout> | null;
};

let open: OpenMic | null = null;
let opening: Promise<OpenMic> | null = null;

function mapCaptureError(error: unknown): VoiceError {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    return new VoiceError("permission_denied", "Microphone access is turned off for OmniRush.ai.");
  }
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") {
    return new VoiceError("no_device", "No microphone was found. Connect one, or pick another input in Settings → Voice.");
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return new VoiceError("capture_failed", "The microphone is busy or could not be started. Close other apps using it and try again.");
  }
  return new VoiceError("capture_failed", "The microphone could not be opened.");
}

function release(mic: OpenMic): void {
  if (mic.releaseTimer) clearTimeout(mic.releaseTimer);
  try {
    mic.node.disconnect();
    mic.source.disconnect();
  } catch {
    // already disconnected
  }
  for (const track of mic.stream.getTracks()) track.stop();
  void mic.context.close().catch(() => undefined);
  if (open === mic) open = null;
}

/** Closes the microphone now (settings changed, app hidden). */
export function releaseMicrophone(): void {
  if (open) release(open);
}

async function openMicrophone(deviceId: string | null): Promise<OpenMic> {
  if (open && open.deviceId === deviceId && open.stream.getAudioTracks().some((track) => track.readyState === "live")) {
    if (open.releaseTimer) clearTimeout(open.releaseTimer);
    open.releaseTimer = null;
    return open;
  }
  if (open) release(open);
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new VoiceError("no_device", "This window cannot use a microphone.");
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (error) {
    throw mapCaptureError(error);
  }
  // Chromium resamples the input to the context rate; 16 kHz directly when it can.
  let context: AudioContext;
  try {
    context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
  } catch {
    context = new AudioContext();
  }
  const source = context.createMediaStreamSource(stream);
  const sink: OpenMic["sink"] = { listener: null };
  const deliver = (samples: Float32Array) => sink.listener?.(samples);
  let node: AudioWorkletNode | ScriptProcessorNode;
  try {
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const worklet = new AudioWorkletNode(context, "omnirush-capture", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => deliver(event.data);
    node = worklet;
  } catch {
    // No AudioWorklet (very old runtime): the deprecated processor still works.
    const processor = context.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = (event) => deliver(event.inputBuffer.getChannelData(0).slice(0));
    node = processor;
  }
  const mic: OpenMic = { deviceId, stream, context, source, node, sink, releaseTimer: null };
  source.connect(node);
  if (node instanceof ScriptProcessorNode) node.connect(context.destination);
  if (context.state === "suspended") await context.resume().catch(() => undefined);
  for (const track of stream.getAudioTracks()) {
    track.addEventListener("ended", () => {
      if (open === mic) release(mic);
    });
  }
  open = mic;
  return mic;
}

/**
 * The microphone as a voice-core AudioSource. PCM goes from the worklet to
 * voice-core in memory only; stopping keeps the device warm for 30 s, then
 * releases it (the OS indicator turns off).
 */
export class MicrophoneSource implements AudioSource {
  private mic: OpenMic | null = null;
  private stopped = false;
  private onEnd: ((error?: VoiceError) => void) | null = null;

  constructor(private readonly deviceId: string | null) {}

  async start(onFrames: (frames: Int16Array) => void, onEnd?: (error?: VoiceError) => void): Promise<void> {
    this.stopped = false;
    this.onEnd = onEnd ?? null;
    opening ??= openMicrophone(this.deviceId).finally(() => {
      opening = null;
    });
    const mic = await opening;
    if (this.stopped) {
      this.scheduleRelease(mic);
      return;
    }
    this.mic = mic;
    const downsampler = new Downsampler(mic.context.sampleRate);
    mic.sink.listener = (samples) => {
      if (!this.stopped) onFrames(downsampler.push(samples));
    };
    const track = mic.stream.getAudioTracks()[0];
    track?.addEventListener("ended", () => {
      if (!this.stopped) this.onEnd?.(new VoiceError("no_device", "The microphone was disconnected."));
    }, { once: true });
  }

  stop(): void {
    this.stopped = true;
    const mic = this.mic;
    this.mic = null;
    if (!mic) return;
    mic.sink.listener = null;
    this.scheduleRelease(mic);
  }

  private scheduleRelease(mic: OpenMic): void {
    if (mic.releaseTimer) clearTimeout(mic.releaseTimer);
    mic.releaseTimer = setTimeout(() => release(mic), KEEP_WARM_MS);
  }
}

export type MicrophoneDevice = { deviceId: string; label: string };

/** Audio inputs; labels are empty until the user has allowed the microphone once. */
export async function listMicrophones(): Promise<MicrophoneDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  return devices
    .filter((device) => device.kind === "audioinput" && device.deviceId !== "default" && device.deviceId !== "communications")
    .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Microphone ${index + 1}` }));
}

export type MicPermission = "granted" | "denied" | "prompt" | "unknown";

/**
 * macOS asks once per app; before the first recording the desktop shell asks
 * the OS (a denied app must be switched on in System Settings). Elsewhere
 * getUserMedia itself decides.
 */
export async function ensureMicrophonePermission(): Promise<MicPermission> {
  const system = window.__OMNIRUSH_ELECTRON__?.system;
  if (!system?.getMicrophoneStatus) return "unknown";
  const { status } = await system.getMicrophoneStatus();
  if (status === "granted" || status === "not-mac") return "granted";
  if (status === "denied" || status === "restricted") return "denied";
  if (!system.askMicrophoneAccess) return "prompt";
  const answer = await system.askMicrophoneAccess();
  return answer.granted ? "granted" : "denied";
}

export function microphoneSettingsUrl(): string | null {
  const platform = navigator.userAgent;
  if (/Macintosh|Mac OS X/.test(platform)) return "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
  if (/Windows/.test(platform)) return "ms-settings:privacy-microphone";
  return null;
}

export async function openMicrophoneSettings(): Promise<void> {
  const url = microphoneSettingsUrl();
  const openExternal = window.__OMNIRUSH_ELECTRON__?.shell?.openExternal;
  if (url && openExternal) await openExternal(url);
}
