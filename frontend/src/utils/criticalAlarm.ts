// The CRITICAL alarm siren — a continuous two-tone sweep, synthesised with the Web Audio
// API, that runs until somebody stops it.
//
// Deliberately NOT the same thing as `notificationSound.ts`. That is a 200 ms chime for
// "something happened"; this is for "the server room is on fire" and has to survive being
// in another room. Different job, different volume, different lifetime — and, importantly,
// a different mute: `notificationSound`'s localStorage toggle must NOT be able to silence
// this one, or a staff member who muted the chime months ago is unreachable during a fire.
//
// ⚠️ AUTOPLAY IS THE HARD PART. Browsers start every AudioContext `suspended` and refuse to
// resume it without a user gesture, so an alarm that first tries to make noise at the moment
// of the emergency is exactly the one that gets blocked. `primeAlarm()` therefore unlocks the
// context on the first click/keypress/touch anywhere in the app — normally the sign-in click,
// long before any alert — and the modal reports it honestly when the context is still
// suspended rather than pretending it is sounding. See isAudioBlocked().

const SWEEP_MS = 700; // one full high-low cycle
const HI_HZ = 1000;
const LO_HZ = 660;
const PEAK_GAIN = 0.55; // loud on purpose; the chime peaks at 0.14

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
 * Unlock audio on the first user gesture of the session, so the alarm is ready long before
 * it is needed. Idempotent, and it removes its own listeners once the context is running.
 * Call once, high in the tree.
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
 * True when the browser is still refusing to play audio. The modal surfaces this as a
 * button rather than swallowing it: a siren that is silently blocked is worse than no
 * siren, because the screen implies a noise that nobody in the corridor can hear.
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
    osc.type = "square"; // harsh on purpose — a sine does not carry through a door
    gain.gain.value = 0;

    // Schedule the sweep as a repeating ramp on the oscillator itself rather than with a JS
    // timer: setInterval in a background tab is throttled to once a second or stopped
    // outright, which would turn the siren into an intermittent bleep exactly when the
    // operator has switched tabs.
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
