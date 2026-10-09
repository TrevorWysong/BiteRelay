// The new-order chime: two short tones, synthesized, so there's no audio
// file to ship. Browsers only let a page play sound after the person has
// interacted with it, so `unlockChime` is called from a tap (turning the
// chime on, accepting an order) to have it ready.

let context: AudioContext | null = null;

/// Prepares audio from within a user gesture.
export function unlockChime(): void {
  try {
    context ??= new AudioContext();
    void context.resume();
  } catch {
    // No audio on this device; the visual alert still shows.
  }
}

export function playChime(): void {
  if (!context || context.state !== "running") return;
  const start = context.currentTime;
  for (const [offset, frequency] of [
    [0, 880],
    [0.18, 1320],
  ] as const) {
    const tone = context.createOscillator();
    const volume = context.createGain();
    tone.frequency.value = frequency;
    volume.gain.setValueAtTime(0.0001, start + offset);
    volume.gain.exponentialRampToValueAtTime(0.25, start + offset + 0.02);
    volume.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.16);
    tone.connect(volume).connect(context.destination);
    tone.start(start + offset);
    tone.stop(start + offset + 0.18);
  }
}
