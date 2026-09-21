import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import {
  BrowserFrame,
  RecordedBrowser,
} from "@omnirush/presentation";
import type { BrowserRecording } from "@omnirush/presentation";

export type OnboardingVideoProps = { recording: BrowserRecording };

export function OnboardingVideo({ recording }: OnboardingVideoProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const seconds = Math.min(frame / fps, recording.durationSeconds);

  return (
    <AbsoluteFill
      style={{
        background: "#f4f6ef",
        overflow: "hidden",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
      }}
    >
      <div
        style={{
          width: 1600,
          height: 1000,
          position: "relative",
          transform: "scale(1.2)",
          transformOrigin: "0 0",
        }}
      >
        <BrowserFrame section="Get started" address="OmniRush.ai">
          <RecordedBrowser recording={recording} seconds={seconds} />
        </BrowserFrame>
      </div>
    </AbsoluteFill>
  );
}
