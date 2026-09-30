// A short "ding-dong" chime for each new notification, made with the Web Audio API (no
// audio file). Can be muted (saved in localStorage); on by default.

const STORAGE_KEY = "cspc_notif_sound";

let ctx: AudioContext | null = null;

export function isSoundEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== "0";
}

export function setSoundEnabled(on: boolean): void {
  localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
}

export function playNotificationSound(): void {
  if (!isSoundEnabled()) return;
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    if (!ctx) ctx = new AC();
    // Browsers suspend the context until a user gesture — resume best-effort.
    if (ctx.state === "suspended") void ctx.resume();

    const now = ctx.currentTime;
    const notes = [{ freq: 880, at: 0 }, { freq: 660, at: 0.12 }]; // two descending tones
    for (const n of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = n.freq;
      const start = now + n.at;
      // quick attack, smooth decay — a soft chime, not a harsh beep
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.14, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.2);
    }
  } catch {
    /* audio not permitted yet (no user gesture) — ignore */
  }
}
