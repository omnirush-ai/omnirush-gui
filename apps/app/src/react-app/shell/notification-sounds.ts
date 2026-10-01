let context: AudioContext | null = null;
let lastChimeAt = -Infinity;

function audioContext() {
  if (typeof window === "undefined" || typeof window.AudioContext !== "function") return null;
  if (!context || context.state === "closed") {
    context = new window.AudioContext();
    lastChimeAt = -Infinity;
  }
  return context;
}

// Sending a prompt unlocks browser audio before the user puts the app in the background.
export function installNotificationSoundUnlock() {
  const unlock = () => {
    try {
      const audio = audioContext();
      if (audio && audio.state !== "running") void audio.resume().catch(() => undefined);
    } catch {
      // Audio must never interrupt typing or sending a prompt.
    }
  };
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
  return () => {
    window.removeEventListener("pointerdown", unlock, true);
    window.removeEventListener("keydown", unlock, true);
    void context?.close().catch(() => undefined);
    context = null;
  };
}

export function playNotificationSound(kind: "completed" | "attention") {
  try {
    const audio = audioContext();
    // Do not queue a stale chime if the browser has not allowed audio yet.
    if (!audio || audio.state !== "running" || audio.currentTime - lastChimeAt < 1) return;
    lastChimeAt = audio.currentTime;
    const notes = kind === "completed" ? [659.25, 880] : [523.25, 659.25];
    notes.forEach((frequency, index) => {
      const start = audio.currentTime + index * 0.12;
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.045, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.4);
      gain.gain.linearRampToValueAtTime(0, start + 0.45);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
      };
      oscillator.start(start);
      oscillator.stop(start + 0.45);
    });
  } catch {
    // Unavailable audio must not affect the task or its desktop notification.
  }
}
