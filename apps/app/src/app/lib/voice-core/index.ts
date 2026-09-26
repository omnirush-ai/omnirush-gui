/**
 * voice-core: dictation without a UI. Capture-agnostic (any AudioSource
 * delivering 16 kHz mono Int16), dependency-free TypeScript that runs in a
 * browser renderer and in Node 20+, so the CLI can vendor this folder as is.
 *
 *   source → Segmenter (energy VAD, pause-cut) → encodeWav → Transcriber
 *          → ordered stitch → keyterm post-correction → text
 *
 * Audio is disposable: silence is dropped as it arrives, each speech
 * segment's PCM and WAV are released once its text (or final failure) is
 * known, and nothing is ever written to disk.
 */
export * from "./types";
export { encodeWav, decodeWav, type DecodedWav } from "./wav";
export { Downsampler, resampleTo16k } from "./resample";
export { LevelMeter, Segmenter, levelFromRms, rms, type Segment, type SegmenterOptions } from "./segmenter";
export { countWords, isCjk, isLikelyHallucination, padInsertion, stitch } from "./text";
export { DEV_KEYTERMS, applyKeyterms, buildKeyterms, splitIdentifier, type KeytermContext } from "./keyterms";
export { RemoteTranscriber, errorCode, multipartBody, voiceErrorFromResponse, type RemoteTranscriberOptions } from "./transcriber";
export { CircuitBreaker, VoiceSession, type VoiceSessionOptions } from "./session";
export { VOICE_INPUT_FILE_ENV, WavFileSource, voiceInputFileFromEnv } from "./file-source";
