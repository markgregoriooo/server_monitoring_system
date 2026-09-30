// The critical alarm: a continuous two-tone siren made with the Web Audio API, running
// until someone stops it. Separate from `notificationSound.ts` (a short chime), with its
// own mute: muting the chime must never silence this.
//
// Browsers keep audio suspended until a user gesture, so `primeAlarm()` unlocks it on
// the first click/keypress/touch (usually the sign-in click). If audio is still blocked,
// the modal says so instead of pretending to sound. See isAudioBlocked().

const SWEEP_MS = 700; // one full high-low cycle
const HI_HZ = 1000;
const LO_HZ = 660;
const PEAK_GAIN = 0.55; // louder than the chime (0.14)

let ctx: AudioContext | null = null;
let osc: OscillatorNode | null = null;
let gain: GainNode | null = null;
let running = false;

function audioContextClass(): typeof AudioContext | undefined {
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  );
}

function ensureContext(): AudioContext | null {
  try {
    const AC = audioContextClass();
    if (!AC) return null;
    if (!ctx) ctx = new AC();
    return ctx;
  } catch {
    return null; // Web Audio unavailable — the modal still shows, silently
  }
}

/**
 * Unlock audio on the first user gesture of the session. Safe to call more than once;
 * removes its listeners once audio is running. Call once, high in the tree.
 */
export function primeAlarm(): void {
  const unlock = () => {
    const c = ensureContext();
    if (!c) return detach();
    void c.resume().then(() => {
      if (c.state === "running") detach();
    });
  };
  const detach = () => {
    document.removeEventListener("pointerdown", unlock);
    document.removeEventListener("keydown", unlock);
    document.removeEventListener("touchstart", unlock);
  };
  document.addEventListener("pointerdown", unlock);
  document.addEventListener("keydown", unlock);
  document.addEventListener("touchstart", unlock);
}

/**
 * True when the browser still blocks audio. The modal shows this as a button, since a
 * silently blocked siren would make people think it is sounding.
 */
export function isAudioBlocked(): boolean {
  const AC = audioContextClass();
  if (!AC) return true;
  return ctx != null && ctx.state !== "running";
}

/** Start the siren. Safe to call repeatedly — a second call is a no-op, not a second tone. */
export function startAlarm(): void {
  if (running) return;
  const c = ensureContext();
  if (!c) return;
  void c.resume();

  try {
    osc = c.createOscillator();
    gain = c.createGain();
    osc.type = "square"; // sawtooth carries through a door better than a sine
    gain.gain.value = 0;

    // The sweep is scheduled on the oscillator itself, not with a JS timer: timers in a
    // background tab are slowed to once a second or stopped.
    const now = c.currentTime;
    osc.frequency.setValueAtTime(HI_HZ, now);
    const cycles = 600; // ~7 minutes of scheduled sweep; restarted well before it runs out
    for (let i = 0; i < cycles; i++) {
      const t = now + (i * SWEEP_MS) / 1000;
      osc.frequency.setValueAtTime(HI_HZ, t);
      osc.frequency.setValueAtTime(LO_HZ, t + SWEEP_MS / 2000);
    }

    // Short fade-in so the start is not a click, then hold.
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, now + 0.05);

    osc.connect(gain).connect(c.destination);
    osc.start(now);
    running = true;
  } catch {
    stopAlarm();
  }
}

/** Stop the siren and release the nodes. Safe to call when nothing is playing. */
export function stopAlarm(): void {
  running = false;
  try {
    if (gain && ctx) {
      // Ramp rather than cut — an abrupt stop on a square wave is an audible pop.
      const now = ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
    }
    osc?.stop((ctx?.currentTime ?? 0) + 0.1);
  } catch {
    /* already stopped */
  }
  osc = null;
  gain = null;
}

export function isAlarmRunning(): boolean {
  return running;
}
