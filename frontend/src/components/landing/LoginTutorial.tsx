import { useEffect, useRef, useState } from "react";
import { animate, createTimeline } from "animejs";
import { useInView, prefersReducedMotion, useIsNarrow } from "./motion";
import Reveal from "./Reveal";
import { SplitHeading, SectionRail } from "./ScrollFx";
import BrowserFrame from "./BrowserFrame";
import ScaledStage from "./ScaledStage";
import { STATUS } from "../../theme/gf";
const { green: GREEN, orange: ORANGE, critical: RED } = STATUS;

/**
 * The walkthrough: signing in, then actually using the thing.
 *
 * It started as a login demo, which undersold it — signing in is one button, and
 * stopping there left the interesting half undescribed anywhere on the page: an
 * alert arriving, being taken by someone, and being closed. The scenes now run
 * from the sign-in screen through to a resolved alert, which is a shift's worth
 * of the product rather than its front door.
 *
 * Animated in code rather than screen-recorded: no file to host on a page that
 * loads before login, it follows the theme toggle, and it cannot drift out of
 * date against a UI change without someone noticing the code no longer matches.
 *
 * The chapter cards beside the stage are BUTTONS. Auto-advance is a courtesy for
 * someone who just wants to watch; the full cycle runs half a minute, and anyone
 * who came for the last scene should not have to sit through the other five.
 */

const ACCENT = "#5794F2";

interface Scene {
  n: string;
  title: string;
  body: string;
  /** how long this scene holds before auto-advance, ms */
  ms: number;
}

const SCENES: Scene[] = [
  {
    n: "01",
    title: "Sign in",
    body: "Pick your CSPC Google account. There is no separate password for this system to leak.",
    ms: 4600,
  },
  {
    n: "02",
    title: "Get approved",
    body: "A first sign-in only creates a request. An administrator assigns your role — nobody lets themselves in.",
    ms: 4800,
  },
  {
    n: "03",
    title: "Watch it live",
    body: "Panels update as readings arrive — no refresh button, and no page quietly showing a stale number.",
    ms: 3600,
  },
  {
    n: "04",
    title: "An alert fires",
    body: "A threshold is crossed. The panel turns critical, the bell count rises, a toast appears.",
    ms: 3900,
  },
  {
    n: "05",
    title: "The email goes out",
    body: "Severity-gated, and it arrives whether or not the dashboard is open.",
    ms: 4600,
  },
  {
    n: "06",
    title: "Acknowledge, then resolve",
    body: "Acknowledging says someone has it. Resolving closes it, with your name against both.",
    ms: 5700,
  },
  // ── Act two: the rest of the system ──────────────────────────────────────
  // Scenes 01-06 are a narrative — get in, watch, something happens, close it.
  // These are a tour, and they are deliberately after the story rather than
  // interleaved with it: a reader who leaves at scene 06 has still seen the
  // system make its case.
  {
    n: "07",
    title: "Every device, in depth",
    body: "Per-volume disk, per-interface throughput, battery runtime. Each device has its own page and its own history.",
    ms: 3600,
  },
  {
    n: "08",
    title: "The room cools itself",
    body: "Cross a temperature zone and the ESP32 fires a captured infrared code. The air conditioner changes with nobody in the room.",
    ms: 5600,
  },
  {
    n: "09",
    title: "You set what counts as a problem",
    body: "Thresholds live in the database, not the firmware. Change one and it reaches the device on its next connect.",
    ms: 3800,
  },
  {
    n: "10",
    title: "It forecasts, not just reports",
    body: "Regression over weeks of history turns a slow climb into a date — and says Stable rather than guess when the fit is weak.",
    ms: 3800,
  },
  {
    n: "11",
    title: "Reports, and a record of everything",
    body: "Generate CSV or PDF over any window. Every action lands in an audit trail that keeps for a year.",
    ms: 4400,
  },
];

/** Every scene takes the same prop, so STAGES can hold them interchangeably.
    Most ignore it — only the email scene has to reflow. */
type SceneProps = { compact: boolean };

/* ── shared bits ─────────────────────────────────────────────────────────── */

/** The pointer. One shape, so a click reads the same in every scene. */
function Cursor({ style }: { style?: React.CSSProperties }) {
  return (
    <div
      data-cursor=""
      aria-hidden="true"
      className="absolute pointer-events-none"
      style={{ opacity: 0, zIndex: 30, ...style }}
    >
      <svg width="16" height="16" viewBox="0 0 16 16">
        <path
          d="M2 1.5 L2 12.5 L5.2 9.6 L7.4 14 L9.6 13 L7.4 8.7 L11.5 8.7 Z"
          fill="#fff"
          stroke="#111"
          strokeWidth="1"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

/** Chrome shared by the in-app scenes (03, 04, 06), so they read as one product.
    05 deliberately opts out — it is a phone, and that is its whole argument. */
function AppChrome({ children, badge = 0 }: { children: React.ReactNode; badge?: number }) {
  return (
    <div className="absolute inset-0 flex flex-col" style={{ background: "var(--gf-bg)" }}>
      <div
        className="flex items-center justify-between px-3 shrink-0"
        style={{
          height: 24,
          background: "var(--gf-header)",
          borderBottom: "1px solid var(--gf-divider)",
        }}
      >
        <span style={{ fontSize: 8, letterSpacing: "0.16em", color: "var(--gf-text-dim)" }}>
          CSPC-ICTU · MONITORING
        </span>
        <span className="relative flex items-center" style={{ width: 14, height: 14 }}>
          <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path
              d="M7 1.6a3.4 3.4 0 0 0-3.4 3.4v2.4L2.4 9.2h9.2l-1.2-1.8V5A3.4 3.4 0 0 0 7 1.6ZM5.6 10.6a1.4 1.4 0 0 0 2.8 0"
              stroke="var(--gf-text-muted)"
              strokeWidth="1.1"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {badge > 0 && (
            <span
              data-badge=""
              className="absolute flex items-center justify-center rounded-full"
              style={{
                top: -3,
                right: -4,
                minWidth: 10,
                height: 10,
                padding: "0 2px",
                fontSize: 7,
                fontWeight: 700,
                color: "#fff",
                background: RED,
              }}
            >
              {badge}
            </span>
          )}
        </span>
      </div>
      <div className="flex-1 min-h-0 relative">{children}</div>
    </div>
  );
}

/** Six-panel dashboard grid, shared by scenes 03 and 04. */
function DashGrid({ alarmed = false }: { alarmed?: boolean }) {
  const panels = [
    { label: "CPU", value: "44%", tone: ACCENT },
    { label: "MEMORY", value: "76%", tone: "#7F77DD" },
    { label: "ROOM", value: "26.5°", tone: GREEN },
    { label: "UPS", value: "98%", tone: GREEN },
    { label: "LINKS", value: "12", tone: GREEN },
    { label: "GAS", value: alarmed ? "318 ppm" : "42 ppm", tone: alarmed ? RED : GREEN },
  ];
  return (
    <div className="absolute inset-0 p-2 grid grid-cols-3 grid-rows-2 gap-1.5">
      {panels.map((p, i) => (
        <div
          key={p.label}
          {...(i === 5 ? { "data-gas-panel": "" } : {})}
          className="gf-panel flex flex-col justify-center px-2"
          style={{ borderLeft: `2px solid ${p.tone}` }}
        >
          <div style={{ fontSize: 6.5, letterSpacing: "0.16em", color: "var(--gf-text-dim)" }}>
            {p.label}
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: p.tone, lineHeight: 1.2 }}>
            {p.value}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Scene 01 — sign in ──────────────────────────────────────────────────── */
function SceneSignIn(_props: SceneProps) {
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const cursor = el.querySelector<HTMLElement>("[data-cursor]");
    const button = el.querySelector<HTMLElement>("[data-button]");
    const popup = el.querySelector<HTMLElement>("[data-popup]");
    if (!cursor || !button || !popup) return;

    if (prefersReducedMotion()) {
      popup.style.opacity = "1";
      return;
    }

    const account = el.querySelector<HTMLElement>("[data-account]");
    const signing = el.querySelector<HTMLElement>("[data-signing]");

    const tl = createTimeline({ defaults: { ease: "outQuad" } });
    if (signing) tl.set(signing, { opacity: 0 });

    tl.set(cursor, { opacity: 0, translateX: -76, translateY: 44 })
      .set(popup, { opacity: 0, translateY: 10 })
      .add(cursor, { opacity: 1, duration: 240 }, 250)
      .add(cursor, { translateX: 0, translateY: 0, duration: 880, ease: "inOutQuad" }, 250)
      .add(button, { scale: 0.94, duration: 110 }, 1180)
      .add(button, { scale: 1, duration: 170 }, 1290)
      .add(popup, { opacity: 1, translateY: 0, duration: 320 }, 1430)
      .add(cursor, { opacity: 0, duration: 200 }, 1620);

    // The chooser used to be where the scene stopped, leaving it parked on
    // "Choose an account" for three and a half seconds — which reads as frozen,
    // not as a pause. Picking the account and handing back to a signing-in
    // button finishes the thought and fills the scene's own dwell.
    if (account) {
      tl.add(account, { backgroundColor: ["rgba(0,0,0,0)", "rgba(87,148,242,0.16)"], duration: 260 }, 2150);
    }
    tl.add(popup, { opacity: 0, duration: 280 }, 2650);
    if (signing) {
      tl.add(signing, { opacity: [0, 1], duration: 300 }, 2760);
    }

    return () => {
      tl.revert();
    };
  }, []);

  return (
    <div ref={root} className="absolute inset-0 flex flex-col items-center justify-center px-6">
      <div
        className="text-[10px] tracking-[0.2em] uppercase mb-2"
        style={{ color: "var(--gf-accent-text)" }}
      >
        CSPC-ICTU Monitoring
      </div>
      <div
        className="text-[16.5px] font-semibold text-center mb-5"
        style={{ color: "var(--gf-text-primary)" }}
      >
        Sign in to continue
      </div>

      <div className="relative">
        <div
          data-button=""
          className="relative flex items-center gap-2 px-4 font-semibold"
          style={{
            height: 32,
            background: "#fff",
            color: "#1f1f1f",
            border: "1px solid rgba(0,0,0,0.16)",
            borderRadius: 2,
            fontSize: 11,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
          </svg>
          CSPC Mail
          {/* Sits over the button's own face, so the swap needs no text
              measuring and cannot reflow the row it is in. */}
          <span
            data-signing=""
            className="absolute inset-0 flex items-center justify-center gap-2"
            style={{ background: "#fff", borderRadius: 2, opacity: 0, fontSize: 11, color: "#1f1f1f" }}
          >
            <span
              aria-hidden="true"
              className="inline-block w-3 h-3 rounded-full border-2 animate-spin"
              style={{ borderColor: "#1f1f1f", borderTopColor: "transparent" }}
            />
            Signing in…
          </span>
        </div>
        <Cursor style={{ right: -6, bottom: -10 }} />
      </div>

      <div className="text-[8.5px] mt-4" style={{ color: "var(--gf-text-dim)" }}>
        @cspc.edu.ph · @my.cspc.edu.ph
      </div>

      <div
        data-popup=""
        className="absolute px-3 py-2.5"
        style={{
          left: "50%",
          top: "50%",
          marginLeft: -84,
          marginTop: -22,
          width: 168,
          background: "#fff",
          borderRadius: 3,
          boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
          opacity: 0,
        }}
      >
        <div style={{ fontSize: 8, color: "#5f6368", marginBottom: 6 }}>Choose an account</div>
        <div data-account="" className="flex items-center gap-2 px-1 py-1" style={{ borderRadius: 3 }}>
          <div className="rounded-full shrink-0" style={{ width: 16, height: 16, background: ACCENT }} />
          <div className="min-w-0">
            <div style={{ fontSize: 8.5, color: "#202124", fontWeight: 600 }}>ICTU Staff</div>
            <div style={{ fontSize: 7.5, color: "#5f6368" }}>staff@cspc.edu.ph</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Scene 02 — pending, then approved ───────────────────────────────────── */
function SceneApproval(_props: SceneProps) {
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const pending = el.querySelector<HTMLElement>("[data-pending]");
    const approved = el.querySelector<HTMLElement>("[data-approved]");
    const admin = el.querySelector<HTMLElement>("[data-admin]");
    if (!pending || !approved || !admin) return;

    if (prefersReducedMotion()) {
      [pending, approved, admin].forEach((n) => {
        n.style.opacity = "1";
      });
      return;
    }

    const tl = createTimeline({ defaults: { ease: "outQuad" } });
    tl.set([pending, approved, admin], { opacity: 0 })
      .add(pending, { opacity: 1, translateY: [-6, 0], duration: 380 }, 200)
      // The admin's side of it. Two people, one queue — showing the reviewer is
      // what makes "approved by hand" concrete instead of a claim.
      .add(admin, { opacity: 1, translateY: [8, 0], duration: 420 }, 1500)
      .add(pending, { opacity: 0.25, duration: 300 }, 2900)
      .add(approved, { opacity: 1, translateY: [6, 0], duration: 420 }, 3100);

    return () => {
      tl.revert();
    };
  }, []);

  return (
    <div ref={root} className="absolute inset-0 flex flex-col items-center justify-center px-6 gap-2.5">
      <div
        data-pending=""
        className="px-3 py-2 w-full"
        style={{
          maxWidth: 300,
          fontSize: 9,
          lineHeight: 1.45,
          color: ORANGE,
          background: `${ORANGE}14`,
          border: `1px solid ${ORANGE}40`,
          borderRadius: 2,
          opacity: 0,
        }}
      >
        Your registration is awaiting administrator approval.
      </div>

      <div data-admin="" className="gf-panel px-3 py-2 w-full" style={{ maxWidth: 300, opacity: 0 }}>
        <div
          style={{ fontSize: 7, letterSpacing: "0.16em", color: "var(--gf-text-dim)", marginBottom: 5 }}
        >
          ADMIN · PENDING REGISTRATIONS
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div style={{ fontSize: 9, color: "var(--gf-text-primary)", fontWeight: 600 }}>ICTU Staff</div>
            <div style={{ fontSize: 7.5, color: "var(--gf-text-dim)" }}>staff@cspc.edu.ph</div>
          </div>
          <span
            className="px-1.5 py-0.5 shrink-0"
            style={{ fontSize: 7, color: GREEN, border: `1px solid ${GREEN}`, borderRadius: 2 }}
          >
            APPROVE · IT STAFF
          </span>
        </div>
      </div>

      <div
        data-approved=""
        className="px-3 py-2 w-full"
        style={{
          maxWidth: 300,
          fontSize: 9,
          lineHeight: 1.45,
          color: GREEN,
          background: `${GREEN}14`,
          border: `1px solid ${GREEN}40`,
          borderRadius: 2,
          opacity: 0,
        }}
      >
        Approved — signed in as <strong>IT Staff</strong>.
      </div>
    </div>
  );
}

/* ── Scene 03 — live dashboard ───────────────────────────────────────────── */
function SceneLive(_props: SceneProps) {
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = root.current;
    if (!el || prefersReducedMotion()) return;
    const panels = el.querySelectorAll<HTMLElement>(".gf-panel");
    const pulse = el.querySelector<HTMLElement>("[data-pulse]");

    const anims = Array.from(panels).map((p, i) =>
      animate(p, {
        opacity: [0, 1],
        scale: [0.97, 1],
        duration: 420,
        delay: i * 70,
        ease: "outExpo",
      }),
    );
    if (pulse) {
      anims.push(
        animate(pulse, {
          opacity: [1, 0.3],
          duration: 900,
          loop: true,
          alternate: true,
          ease: "inOutQuad",
        }),
      );
    }
    return () => anims.forEach((a) => a.revert());
  }, []);

  return (
    <div ref={root} className="absolute inset-0">
      <AppChrome>
        <DashGrid />
        <div
          className="absolute flex items-center gap-1.5 px-1.5 py-1"
          style={{
            right: 8,
            bottom: 8,
            background: "var(--gf-panel)",
            border: "1px solid var(--gf-panel-border)",
            borderRadius: 2,
          }}
        >
          <span data-pulse="" className="rounded-full" style={{ width: 5, height: 5, background: GREEN }} />
          <span style={{ fontSize: 7, letterSpacing: "0.1em", color: "var(--gf-text-muted)" }}>LIVE</span>
        </div>
      </AppChrome>
    </div>
  );
}

/* ── Scene 04 — an alert fires ───────────────────────────────────────────── */
function SceneAlert(_props: SceneProps) {
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const toast = el.querySelector<HTMLElement>("[data-toast]");
    const badge = el.querySelector<HTMLElement>("[data-badge]");
    const gas = el.querySelector<HTMLElement>("[data-gas-panel]");
    if (!toast) return;

    if (prefersReducedMotion()) {
      toast.style.opacity = "1";
      return;
    }

    const tl = createTimeline({ defaults: { ease: "outQuad" } });
    tl.set(toast, { opacity: 0, translateX: 24 });

    // The panel flares first: the reading is what happened, and everything after
    // it is the system reacting to it.
    if (gas) tl.add(gas, { scale: [1, 1.04, 1], duration: 520, ease: "outExpo" }, 200);
    if (badge) tl.add(badge, { scale: [0, 1], duration: 380, ease: "outBack" }, 620);

    tl.add(toast, { opacity: 1, translateX: 0, duration: 420 }, 780);

    return () => {
      tl.revert();
    };
  }, []);

  return (
    <div ref={root} className="absolute inset-0">
      <AppChrome badge={1}>
        <DashGrid alarmed />

        <div
          data-toast=""
          className="absolute px-2 py-1.5"
          style={{
            right: 8,
            bottom: 8,
            width: "62%",
            maxWidth: 210,
            background: "var(--gf-panel)",
            border: `1px solid ${RED}`,
            borderLeft: `3px solid ${RED}`,
            borderRadius: 2,
            boxShadow: "var(--gf-shadow)",
            opacity: 0,
          }}
        >
          <div style={{ fontSize: 7, letterSpacing: "0.14em", color: RED, fontWeight: 700 }}>CRITICAL</div>
          <div style={{ fontSize: 8.5, color: "var(--gf-text-primary)", marginTop: 2, lineHeight: 1.35 }}>
            Smoke detected — Server Room
          </div>
          <div style={{ fontSize: 7, color: "var(--gf-text-dim)", marginTop: 2 }}>MQ-2 · 318 ppm</div>
        </div>
      </AppChrome>
    </div>
  );
}

/* ── Scene 05 — the alert email ──────────────────────────────────────────────
   On a phone, deliberately. The dashboard scenes all argue "look how much this
   shows you"; this one argues the opposite and more important thing — that you
   do not have to be looking at all. A desktop mail client would have blurred
   that, because a desktop is where the dashboard already is.

   The message mirrors what emailService actually sends: severity in the subject,
   then the device, the reading, the threshold it crossed and the time. */
function SceneEmail({ compact }: SceneProps) {
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const notif = el.querySelector<HTMLElement>("[data-notif]");
    const body = el.querySelector<HTMLElement>("[data-mailbody]");
    const rows = el.querySelectorAll<HTMLElement>("[data-mailrow]");
    if (!notif || !body) return;

    if (prefersReducedMotion()) {
      notif.style.opacity = "1";
      body.style.opacity = "1";
      rows.forEach((r) => {
        r.style.opacity = "1";
      });
      return;
    }

    const tl = createTimeline({ defaults: { ease: "outQuad" } });
    tl.set(notif, { opacity: 0, translateY: -26 })
      .set(body, { opacity: 0 })
      .set(rows, { opacity: 0, translateX: -6 })
      // the banner drops in the way a push notification does
      .add(notif, { opacity: 1, translateY: 0, duration: 460, ease: "outBack" }, 300)
      // then it is opened, and the detail fills in line by line
      .add(body, { opacity: 1, duration: 380 }, 1700);

    rows.forEach((r, i) => {
      tl.add(r, { opacity: 1, translateX: 0, duration: 300 }, 1900 + i * 150);
    });

    return () => {
      tl.revert();
    };
  }, []);

  return (
    <div
      ref={root}
      className="absolute inset-0 flex items-center justify-center px-6"
      style={{ gap: compact ? 12 : 20 }}
    >
      {/* the phone */}
      <div
        className="relative shrink-0"
        style={{
          width: compact ? 116 : 132,
          height: "86%",
          maxHeight: compact ? 232 : 250,
          background: "var(--gf-bg)",
          border: "2px solid var(--gf-btn-border)",
          borderRadius: 12,
          padding: 5,
          boxShadow: "var(--gf-shadow)",
        }}
      >
        <div
          className="w-full h-full relative overflow-hidden"
          style={{ background: "var(--gf-panel)", borderRadius: 8 }}
        >
          {/* status bar */}
          <div className="flex items-center justify-between px-2" style={{ height: 14 }}>
            <span style={{ fontSize: 6, color: "var(--gf-text-dim)" }}>09:41</span>
            <span style={{ fontSize: 6, color: "var(--gf-text-dim)" }}>▮▮▮</span>
          </div>

          {/* the push notification */}
          <div
            data-notif=""
            className="mx-1.5 px-2 py-1.5"
            style={{
              background: "var(--gf-bg)",
              border: `1px solid ${RED}60`,
              borderLeft: `2px solid ${RED}`,
              borderRadius: 4,
              opacity: 0,
            }}
          >
            <div className="flex items-center gap-1 mb-1">
              <svg width="7" height="7" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <rect x="1" y="2.5" width="10" height="7" rx="1" stroke={ACCENT} strokeWidth="1.2" />
                <path d="M1.4 3.2 6 6.6l4.6-3.4" stroke={ACCENT} strokeWidth="1.2" strokeLinecap="round" />
              </svg>
              <span style={{ fontSize: 5.5, letterSpacing: "0.1em", color: "var(--gf-text-dim)" }}>
                MAIL · NOW
              </span>
            </div>
            <div style={{ fontSize: 6.5, fontWeight: 700, color: RED, lineHeight: 1.3 }}>
              [CRITICAL] Smoke detected
            </div>
            <div style={{ fontSize: 6, color: "var(--gf-text-muted)", lineHeight: 1.35, marginTop: 1 }}>
              Server Room · MQ-2 at 318 ppm
            </div>
          </div>

          {/* opened */}
          <div data-mailbody="" className="mx-1.5 mt-1.5 px-2 py-1.5" style={{ opacity: 0 }}>
            {[
              ["Device", "ESP32 · Server Room"],
              ["Reading", "318 ppm"],
              ["Threshold", "300 ppm · critical"],
              ["Time", "09:41:06 +08"],
            ].map(([k, v]) => (
              <div
                key={k}
                data-mailrow=""
                className="flex items-baseline justify-between gap-1.5"
                style={{ opacity: 0, marginBottom: 3 }}
              >
                <span style={{ fontSize: 5.5, letterSpacing: "0.08em", color: "var(--gf-text-dim)" }}>
                  {k?.toUpperCase()}
                </span>
                <span style={{ fontSize: 6, color: "var(--gf-text-primary)", textAlign: "right" }}>{v}</span>
              </div>
            ))}
            <div
              className="mt-2 py-1 text-center"
              style={{
                fontSize: 5.5,
                color: "#fff",
                background: ACCENT,
                borderRadius: 2,
              }}
            >
              View in dashboard
            </div>
          </div>
        </div>
      </div>

      {/* the claim the phone is making */}
      <div className="min-w-0" style={{ maxWidth: compact ? 150 : 190 }}>
        <div
          className="text-[10px] tracking-[0.16em] uppercase mb-2"
          style={{ color: "var(--gf-accent-text)" }}
        >
          Nobody was watching
        </div>
        <p style={{ fontSize: 9.5, lineHeight: 1.55, color: "var(--gf-text-muted)" }}>
          The dashboard was closed. The alert still left the building, addressed to every active
          account whose severity setting asked for it.
        </p>
        <div
          className="mt-3 pt-2.5 flex items-center gap-1.5"
          style={{ borderTop: "1px solid var(--gf-divider)" }}
        >
          <span className="rounded-full" style={{ width: 4, height: 4, background: GREEN }} />
          <span style={{ fontSize: 8, color: "var(--gf-text-dim)" }}>
            De-duplicated — it will not send again for the same fault
          </span>
        </div>
      </div>
    </div>
  );
}

/* ── Scene 06 — acknowledge, then resolve ────────────────────────────────── */
function SceneResolve(_props: SceneProps) {
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const cursor = el.querySelector<HTMLElement>("[data-cursor]");
    const ackBtn = el.querySelector<HTMLElement>("[data-ack-btn]");
    const resBtn = el.querySelector<HTMLElement>("[data-res-btn]");
    const status = el.querySelector<HTMLElement>("[data-status]");
    const who = el.querySelector<HTMLElement>("[data-who]");
    const row = el.querySelector<HTMLElement>("[data-row]");
    const badge = el.querySelector<HTMLElement>("[data-badge]");
    if (!cursor || !ackBtn || !resBtn || !status || !who || !row) return;

    const setStatus = (text: string, tone: string) => {
      status.textContent = text;
      status.style.color = tone;
      status.style.borderColor = tone;
    };

    if (prefersReducedMotion()) {
      setStatus("RESOLVED", GREEN);
      who.style.opacity = "1";
      who.textContent = "acknowledged and resolved by you";
      row.style.opacity = "0.55";
      ackBtn.style.opacity = "0.3";
      resBtn.style.opacity = "0.3";
      if (badge) badge.style.opacity = "0";
      return;
    }

    const tl = createTimeline({ defaults: { ease: "outQuad" } });

    tl.set(cursor, { opacity: 0, translateX: -54, translateY: 26 })
      .set(who, { opacity: 0 })

      // → Acknowledge
      .add(cursor, { opacity: 1, duration: 220 }, 250)
      .add(cursor, { translateX: 0, translateY: 0, duration: 760, ease: "inOutQuad" }, 250)
      .add(ackBtn, { scale: 0.92, duration: 100 }, 1050)
      .add(ackBtn, { scale: 1, duration: 160 }, 1150)
      .call(() => setStatus("ACKNOWLEDGED", ORANGE), 1180)
      .call(() => {
        who.textContent = "acknowledged by you";
      }, 1200)
      .add(who, { opacity: 1, duration: 300 }, 1220)
      .add(ackBtn, { opacity: 0.3, duration: 260 }, 1300)

      // → Resolve
      .add(cursor, { translateX: 46, duration: 700, ease: "inOutQuad" }, 2700)
      .add(resBtn, { scale: 0.92, duration: 100 }, 3450)
      .add(resBtn, { scale: 1, duration: 160 }, 3550)
      .call(() => {
        setStatus("RESOLVED", GREEN);
        who.textContent = "acknowledged and resolved by you";
      }, 3580)
      .add(resBtn, { opacity: 0.3, duration: 260 }, 3660)
      .add(cursor, { opacity: 0, duration: 220 }, 3800)
      // the row settles back — closed, and the bell count goes with it
      .add(row, { opacity: 0.55, duration: 420 }, 4000);

    if (badge) tl.add(badge, { opacity: 0, scale: 0.4, duration: 320 }, 4000);

    return () => {
      tl.revert();
    };
  }, []);

  return (
    <div ref={root} className="absolute inset-0">
      <AppChrome badge={1}>
        <div className="absolute inset-0 p-2.5">
          <div
            style={{ fontSize: 7, letterSpacing: "0.16em", color: "var(--gf-text-dim)", marginBottom: 6 }}
          >
            ALERTS
          </div>

          <div data-row="" className="gf-panel p-2.5" style={{ borderLeft: `2px solid ${RED}` }}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div style={{ fontSize: 9, color: "var(--gf-text-primary)", fontWeight: 600 }}>
                  Smoke detected — Server Room
                </div>
                <div style={{ fontSize: 7.5, color: "var(--gf-text-dim)", marginTop: 2 }}>
                  MQ-2 · 318 ppm · a moment ago
                </div>
                <div data-who="" style={{ fontSize: 7.5, color: GREEN, marginTop: 3, opacity: 0 }}>
                  acknowledged by you
                </div>
              </div>
              <span
                data-status=""
                className="px-1.5 py-0.5 shrink-0"
                style={{
                  fontSize: 7,
                  letterSpacing: "0.1em",
                  color: RED,
                  border: `1px solid ${RED}`,
                  borderRadius: 2,
                }}
              >
                OPEN
              </span>
            </div>

            <div className="flex items-center gap-1.5 mt-2.5 relative">
              <span
                data-ack-btn=""
                className="px-2 py-1"
                style={{
                  fontSize: 7.5,
                  color: "var(--gf-text-primary)",
                  background: "var(--gf-btn-face)",
                  border: "1px solid var(--gf-btn-border)",
                  borderRadius: 2,
                }}
              >
                Acknowledge
              </span>
              <span
                data-res-btn=""
                className="px-2 py-1"
                style={{
                  fontSize: 7.5,
                  color: "var(--gf-text-primary)",
                  background: "var(--gf-btn-face)",
                  border: "1px solid var(--gf-btn-border)",
                  borderRadius: 2,
                }}
              >
                Resolve
              </span>
              <Cursor style={{ left: 18, top: 14 }} />
            </div>
          </div>

          {/* one closed alert underneath, so the list reads as a history rather
              than as a single staged row */}
          <div
            className="gf-panel p-2 mt-1.5"
            style={{ borderLeft: "2px solid var(--gf-panel-border)", opacity: 0.5 }}
          >
            <div className="flex items-center justify-between gap-2">
              <span style={{ fontSize: 8, color: "var(--gf-text-muted)" }}>UPS on battery — Rack A</span>
              <span style={{ fontSize: 6.5, letterSpacing: "0.1em", color: "var(--gf-text-dim)" }}>
                RESOLVED
              </span>
            </div>
          </div>
        </div>
      </AppChrome>
    </div>
  );
}

/* ── shared: a sparkline that plots itself ───────────────────────────────── */
function Spark({ points, tone, h = 30 }: { points: number[]; tone: string; h?: number }) {
  const W = 100;
  const d = points
    .map((v, i) => {
      const x = (i / (points.length - 1)) * W;
      const y = h - 3 - (v / 100) * (h - 6);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${W} ${h}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height: h, display: "block" }}
      aria-hidden="true"
    >
      <path
        data-spark=""
        d={d}
        fill="none"
        stroke={tone}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Draw every [data-spark] in a subtree, staggered. Shared by the tour scenes. */
function drawSparks(el: HTMLElement, startAt = 200): Array<ReturnType<typeof animate>> {
  const paths = el.querySelectorAll<SVGPathElement>("[data-spark]");
  if (prefersReducedMotion()) {
    paths.forEach((p) => {
      p.style.strokeDasharray = "none";
      p.style.strokeDashoffset = "0";
    });
    return [];
  }
  return Array.from(paths).map((p, i) => {
    const len = p.getTotalLength();
    p.style.strokeDasharray = String(len);
    p.style.strokeDashoffset = String(len);
    return animate(p, {
      strokeDashoffset: 0,
      duration: 760,
      delay: startAt + i * 120,
      ease: "outCubic",
    });
  });
}

/** Panels settling in, staggered. Also shared. */
function settleCards(el: HTMLElement, sel = "[data-card]"): Array<ReturnType<typeof animate>> {
  if (prefersReducedMotion()) return [];
  const cards = el.querySelectorAll<HTMLElement>(sel);
  return Array.from(cards).map((c, i) =>
    animate(c, { opacity: [0, 1], translateY: [6, 0], duration: 380, delay: i * 90, ease: "outExpo" }),
  );
}

/* ── Scene 07 — per-device pages ─────────────────────────────────────────── */
const DEVICE_TILES = [
  { label: "CPU", value: "44%", tone: ACCENT, pts: [30, 42, 36, 51, 44, 62, 48, 44] },
  { label: "MEMORY", value: "76%", tone: "#7F77DD", pts: [60, 64, 63, 68, 70, 73, 75, 76] },
  { label: "/var", value: "91%", tone: ORANGE, pts: [70, 74, 77, 80, 84, 87, 89, 91] },
  { label: "NETWORK", value: "842M", tone: GREEN, pts: [40, 66, 52, 78, 60, 84, 70, 76] },
];

function SceneDevices(_props: SceneProps) {
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const anims = [...settleCards(el), ...drawSparks(el, 260)];
    return () => anims.forEach((a) => a.revert());
  }, []);

  return (
    <div ref={root} className="absolute inset-0">
      <AppChrome>
        <div className="absolute inset-0 p-2.5 flex flex-col">
          <div className="flex items-center justify-between mb-2 shrink-0">
            <div className="flex items-center gap-1.5">
              <span className="rounded-full" style={{ width: 5, height: 5, background: GREEN }} />
              <span style={{ fontSize: 9.5, color: "var(--gf-text-primary)", fontWeight: 600 }}>
                db-01
              </span>
              <span style={{ fontSize: 7, color: "var(--gf-text-dim)" }}>· 4 volumes · up 41d</span>
            </div>
            <span style={{ fontSize: 7, letterSpacing: "0.12em", color: GREEN }}>ONLINE</span>
          </div>

          <div className="grid grid-cols-2 gap-1.5 flex-1 min-h-0">
            {DEVICE_TILES.map((t) => (
              <div key={t.label} data-card="" className="gf-panel px-2 pt-1.5 pb-1 flex flex-col" style={{ opacity: 0 }}>
                <div className="flex items-baseline justify-between">
                  <span style={{ fontSize: 6.5, letterSpacing: "0.14em", color: "var(--gf-text-dim)" }}>
                    {t.label}
                  </span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: t.tone }}>{t.value}</span>
                </div>
                <div className="flex-1 flex items-end">
                  <Spark points={t.pts} tone={t.tone} h={28} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </AppChrome>
    </div>
  );
}

/* ── Scene 08 — environment drives the air conditioning ──────────────────── */
function SceneAircon(_props: SceneProps) {
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const temp = el.querySelector<HTMLElement>("[data-temp]");
    const zone = el.querySelector<HTMLElement>("[data-zone]");
    const burst = el.querySelector<HTMLElement>("[data-burst]");
    const setTemp = el.querySelector<HTMLElement>("[data-settemp]");
    const logRow = el.querySelector<HTMLElement>("[data-log]");
    if (!temp || !zone || !burst || !setTemp || !logRow) return;

    if (prefersReducedMotion()) {
      temp.textContent = "28.4°C";
      temp.style.color = ORANGE;
      zone.textContent = "NEAR CRITICAL";
      zone.style.color = ORANGE;
      setTemp.textContent = "22°C";
      burst.style.opacity = "1";
      logRow.style.opacity = "1";
      return;
    }

    const tl = createTimeline({ defaults: { ease: "outQuad" } });
    const reading = { v: 25.2 };

    tl.set(burst, { opacity: 0, scale: 0.6 })
      .set(logRow, { opacity: 0 })
      // the room warms past a zone edge
      .add(
        reading,
        {
          v: 28.4,
          duration: 2200,
          ease: "inOutQuad",
          onUpdate: () => {
            temp.textContent = `${reading.v.toFixed(1)}°C`;
            const warm = reading.v >= 28;
            temp.style.color = warm ? ORANGE : GREEN;
            zone.textContent = warm ? "NEAR CRITICAL" : "ACCEPTABLE";
            zone.style.color = warm ? ORANGE : GREEN;
          },
        },
        300,
      )
      // the infrared goes out
      .add(burst, { opacity: [0, 1], scale: [0.6, 1], duration: 420, ease: "outBack" }, 2500)
      .call(() => {
        setTemp.textContent = "22°C";
      }, 2900)
      .add(setTemp, { scale: [1.25, 1], duration: 420, ease: "outExpo" }, 2900)
      .add(logRow, { opacity: 1, translateY: [5, 0], duration: 380 }, 3200)
      .add(burst, { opacity: 0, duration: 400 }, 4000);

    return () => {
      tl.revert();
    };
  }, []);

  return (
    <div ref={root} className="absolute inset-0">
      <AppChrome>
        <div className="absolute inset-0 p-2.5 flex flex-col gap-1.5">
          {/* the room */}
          <div className="gf-panel px-2.5 py-2 flex items-center justify-between">
            <div>
              <div style={{ fontSize: 6.5, letterSpacing: "0.14em", color: "var(--gf-text-dim)" }}>
                ROOM TEMPERATURE
              </div>
              <span data-temp="" style={{ fontSize: 19, fontWeight: 600, color: GREEN, lineHeight: 1.2 }}>
                25.2°C
              </span>
            </div>
            <span
              data-zone=""
              className="px-1.5 py-0.5"
              style={{ fontSize: 7, letterSpacing: "0.1em", color: GREEN, border: "1px solid currentColor", borderRadius: 2 }}
            >
              ACCEPTABLE
            </span>
          </div>

          {/* the infrared hop */}
          <div className="flex items-center justify-center gap-2" style={{ height: 22 }}>
            <span style={{ fontSize: 7, color: "var(--gf-text-dim)" }}>ESP32</span>
            <span data-burst="" className="flex items-center gap-0.5" style={{ opacity: 0 }} aria-hidden="true">
              {[0.35, 0.6, 1].map((o, i) => (
                <span
                  key={i}
                  style={{
                    display: "block",
                    width: 3 + i,
                    height: 3 + i,
                    borderRadius: "50%",
                    background: RED,
                    opacity: o,
                  }}
                />
              ))}
              <span style={{ fontSize: 6.5, color: RED, marginLeft: 3, letterSpacing: "0.1em" }}>IR</span>
            </span>
            <span style={{ fontSize: 7, color: "var(--gf-text-dim)" }}>→ AC 1</span>
          </div>

          {/* the unit */}
          <div className="gf-panel px-2.5 py-2 flex items-center justify-between">
            <div>
              <div style={{ fontSize: 9, color: "var(--gf-text-primary)", fontWeight: 600 }}>
                Server Room AC 1
              </div>
              <div style={{ fontSize: 6.5, color: "var(--gf-text-dim)", marginTop: 1 }}>
                IR channel 1 · GPIO 25
              </div>
            </div>
            <div className="text-right">
              <div style={{ fontSize: 6.5, letterSpacing: "0.14em", color: "var(--gf-text-dim)" }}>
                SET TO
              </div>
              <span data-settemp="" style={{ fontSize: 16, fontWeight: 600, color: ACCENT, display: "inline-block" }}>
                24°C
              </span>
            </div>
          </div>

          <div data-log="" className="gf-panel px-2 py-1.5" style={{ opacity: 0 }}>
            <span style={{ fontSize: 7, color: "var(--gf-text-muted)" }}>
              <span style={{ color: GREEN }}>auto</span> · re-targeted to 22°C on zone change
            </span>
          </div>
        </div>
      </AppChrome>
    </div>
  );
}

/* ── Scene 09 — alert rules ──────────────────────────────────────────────── */
const RULE_ROWS = [
  { metric: "cpu", scope: "global", warn: "80", crit: "90" },
  { metric: "temperature", scope: "server room", warn: "28", crit: "30" },
  { metric: "ups_charge", scope: "global", warn: "40", crit: "20" },
];

function SceneRules(_props: SceneProps) {
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const crit = el.querySelector<HTMLElement>("[data-crit]");
    const pushed = el.querySelector<HTMLElement>("[data-pushed]");
    if (!crit || !pushed) return;

    if (prefersReducedMotion()) {
      crit.textContent = "29";
      pushed.style.opacity = "1";
      return;
    }

    const tl = createTimeline({ defaults: { ease: "outQuad" } });
    tl.set(pushed, { opacity: 0 })
      .add(crit, { scale: [1, 1.18, 1], duration: 520, ease: "outExpo" }, 900)
      .call(() => {
        crit.textContent = "29";
        crit.style.color = RED;
      }, 1050)
      // the value does not just change in a table — it leaves for the hardware
      .add(pushed, { opacity: 1, translateY: [6, 0], duration: 420 }, 1700);

    return () => {
      tl.revert();
    };
  }, []);

  return (
    <div ref={root} className="absolute inset-0">
      <AppChrome>
        <div className="absolute inset-0 p-2.5 flex flex-col">
          <div className="flex items-center justify-between mb-2">
            <span style={{ fontSize: 7, letterSpacing: "0.16em", color: "var(--gf-text-dim)" }}>
              ALERT RULES
            </span>
            <span style={{ fontSize: 6.5, color: "var(--gf-accent-text)", border: "1px solid var(--gf-accent)", borderRadius: 2, padding: "1px 4px" }}>
              ADMIN
            </span>
          </div>

          <div className="gf-panel">
            <div
              className="grid px-2 py-1"
              style={{ gridTemplateColumns: "1.5fr 1.2fr 0.7fr 0.7fr", borderBottom: "1px solid var(--gf-divider)" }}
            >
              {["METRIC", "SCOPE", "WARN", "CRIT"].map((h) => (
                <span key={h} style={{ fontSize: 6, letterSpacing: "0.14em", color: "var(--gf-text-dim)" }}>
                  {h}
                </span>
              ))}
            </div>
            {RULE_ROWS.map((r, i) => (
              <div
                key={r.metric}
                className="grid px-2 py-1.5 items-center"
                style={{
                  gridTemplateColumns: "1.5fr 1.2fr 0.7fr 0.7fr",
                  borderBottom: i < RULE_ROWS.length - 1 ? "1px solid var(--gf-divider)" : "none",
                  background: i === 1 ? "var(--gf-accent-dim)" : "transparent",
                }}
              >
                <span style={{ fontSize: 8, color: "var(--gf-text-primary)" }}>{r.metric}</span>
                <span style={{ fontSize: 7.5, color: "var(--gf-text-dim)" }}>{r.scope}</span>
                <span style={{ fontSize: 8, color: ORANGE }}>{r.warn}</span>
                {i === 1 ? (
                  <span data-crit="" style={{ fontSize: 8, color: RED, display: "inline-block" }}>
                    {r.crit}
                  </span>
                ) : (
                  <span style={{ fontSize: 8, color: RED }}>{r.crit}</span>
                )}
              </div>
            ))}
          </div>

          <div data-pushed="" className="gf-panel px-2 py-1.5 mt-1.5" style={{ opacity: 0 }}>
            <span style={{ fontSize: 7, color: "var(--gf-text-muted)" }}>
              <span style={{ color: GREEN }}>envConfig</span> pushed to the ESP32 — LED, buzzer and
              reported status now use 29°C. No reflash.
            </span>
          </div>
        </div>
      </AppChrome>
    </div>
  );
}

/* ── Scene 10 — predictive analytics ─────────────────────────────────────── */
const TREND = [52, 54, 55, 58, 59, 62, 63, 66, 68, 70, 73, 76, 78];

function SceneAnalytics(_props: SceneProps) {
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const proj = el.querySelector<SVGPathElement>("[data-proj]");
    const eta = el.querySelector<HTMLElement>("[data-eta]");
    const anims = [...settleCards(el), ...drawSparks(el, 200)];

    if (prefersReducedMotion()) {
      if (proj) {
        proj.style.strokeDasharray = "4 3";
        proj.style.strokeDashoffset = "0";
      }
      if (eta) eta.style.opacity = "1";
      return () => anims.forEach((a) => a.revert());
    }

    if (proj) {
      const len = proj.getTotalLength();
      proj.style.strokeDasharray = String(len);
      proj.style.strokeDashoffset = String(len);
      anims.push(
        animate(proj, {
          strokeDashoffset: 0,
          duration: 620,
          delay: 1000,
          ease: "outCubic",
          onComplete: () => {
            proj.style.strokeDasharray = "4 3";
            proj.style.strokeDashoffset = "0";
          },
        }),
      );
    }
    if (eta) {
      anims.push(
        animate(eta, { opacity: [0, 1], translateY: [6, 0], duration: 420, delay: 1600, ease: "outExpo" }),
      );
    }

    return () => anims.forEach((a) => a.revert());
  }, []);

  return (
    <div ref={root} className="absolute inset-0">
      <AppChrome>
        <div className="absolute inset-0 p-2.5 flex flex-col">
          <div className="flex items-center justify-between mb-2">
            <span style={{ fontSize: 7, letterSpacing: "0.16em", color: "var(--gf-text-dim)" }}>
              PREDICTIVE ANALYTICS · db-01 · /var
            </span>
            <span style={{ fontSize: 6.5, color: "var(--gf-accent-text)", border: "1px solid var(--gf-accent)", borderRadius: 2, padding: "1px 4px" }}>
              R² 0.94
            </span>
          </div>

          <div data-card="" className="gf-panel p-2 flex-1 min-h-0 flex flex-col" style={{ opacity: 0 }}>
            <svg
              viewBox="0 0 200 70"
              preserveAspectRatio="none"
              style={{ width: "100%", flex: 1, minHeight: 0, display: "block" }}
              aria-hidden="true"
            >
              <line x1="0" x2="200" y1="14" y2="14" stroke={RED} strokeWidth="0.8" strokeDasharray="3 2" opacity="0.6" />
              <path
                data-spark=""
                d={TREND.map((v, i) => {
                  const x = (i / (TREND.length - 1)) * 130;
                  const y = 66 - (v / 100) * 56;
                  return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
                }).join(" ")}
                fill="none"
                stroke={ACCENT}
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                data-proj=""
                d="M130,22.3 L182,10"
                fill="none"
                stroke={ORANGE}
                strokeWidth="1.8"
                strokeLinecap="round"
              />
              <circle cx="182" cy="10" r="2.6" fill={ORANGE} />
            </svg>
            <div className="flex items-center justify-between mt-1">
              <span style={{ fontSize: 6, color: "var(--gf-text-dim)" }}>30 days measured</span>
              <span style={{ fontSize: 6, color: "var(--gf-text-dim)" }}>projected</span>
            </div>
          </div>

          <div
            data-eta=""
            className="flex items-center gap-2 px-2 py-1.5 mt-1.5"
            style={{ background: `${ORANGE}14`, border: `1px solid ${ORANGE}40`, borderRadius: 2, opacity: 0 }}
          >
            <span style={{ fontSize: 10, fontWeight: 700, color: ORANGE }}>~6 days</span>
            <span style={{ fontSize: 7, color: "var(--gf-text-muted)" }}>
              until /var is full — alert raised before anyone noticed a climb
            </span>
          </div>
        </div>
      </AppChrome>
    </div>
  );
}

/* ── Scene 11 — reports and the audit trail ──────────────────────────────── */
const AUDIT = [
  { who: "you", what: "resolved alert · Smoke detected", when: "09:44" },
  { who: "you", what: "generated report · Environment", when: "09:46" },
  { who: "admin", what: "updated rule · temperature", when: "09:41" },
];

function SceneReports(_props: SceneProps) {
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const status = el.querySelector<HTMLElement>("[data-status]");
    const actions = el.querySelector<HTMLElement>("[data-actions]");
    const rows = el.querySelectorAll<HTMLElement>("[data-audit]");
    if (!status || !actions) return;

    if (prefersReducedMotion()) {
      status.textContent = "GENERATED";
      status.style.color = GREEN;
      status.style.borderColor = GREEN;
      actions.style.opacity = "1";
      rows.forEach((r) => {
        r.style.opacity = "1";
      });
      return;
    }

    const tl = createTimeline({ defaults: { ease: "outQuad" } });
    tl.set(actions, { opacity: 0 }).set(rows, { opacity: 0, translateX: -6 });

    // pending → generated. The row appears first and flips when the background
    // build finishes, which is what actually happens: the POST answers 202.
    tl.call(() => {
      status.textContent = "GENERATED";
      status.style.color = GREEN;
      status.style.borderColor = GREEN;
    }, 1500)
      .add(status, { scale: [1.15, 1], duration: 420, ease: "outExpo" }, 1500)
      .add(actions, { opacity: 1, duration: 380 }, 1700);

    rows.forEach((r, i) => {
      tl.add(r, { opacity: 1, translateX: 0, duration: 320 }, 2300 + i * 180);
    });

    return () => {
      tl.revert();
    };
  }, []);

  return (
    <div ref={root} className="absolute inset-0">
      <AppChrome>
        <div className="absolute inset-0 p-2.5 flex flex-col gap-1.5">
          <div className="gf-panel px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div style={{ fontSize: 9, color: "var(--gf-text-primary)", fontWeight: 600 }}>
                  Environment · last 7 days
                </div>
                <div style={{ fontSize: 6.5, color: "var(--gf-text-dim)", marginTop: 1 }}>
                  built live from InfluxDB at generate time
                </div>
              </div>
              <span
                data-status=""
                className="px-1.5 py-0.5 shrink-0"
                style={{ fontSize: 6.5, letterSpacing: "0.1em", color: ORANGE, border: `1px solid ${ORANGE}`, borderRadius: 2 }}
              >
                PENDING
              </span>
            </div>
            <div data-actions="" className="flex items-center gap-1.5 mt-2" style={{ opacity: 0 }}>
              {["CSV", "PDF", "Email"].map((a) => (
                <span
                  key={a}
                  className="px-2 py-0.5"
                  style={{
                    fontSize: 7,
                    color: "var(--gf-text-primary)",
                    background: "var(--gf-btn-face)",
                    border: "1px solid var(--gf-btn-border)",
                    borderRadius: 2,
                  }}
                >
                  {a}
                </span>
              ))}
            </div>
          </div>

          <div className="gf-panel px-2 py-1.5 flex-1 min-h-0">
            <div style={{ fontSize: 6, letterSpacing: "0.16em", color: "var(--gf-text-dim)", marginBottom: 4 }}>
              HISTORY · AUDIT TRAIL
            </div>
            {AUDIT.map((r) => (
              <div
                key={r.what}
                data-audit=""
                className="flex items-baseline justify-between gap-2"
                style={{ opacity: 0, marginBottom: 3 }}
              >
                <span style={{ fontSize: 7, color: "var(--gf-text-muted)" }} className="truncate">
                  <span style={{ color: "var(--gf-accent-text)" }}>{r.who}</span> {r.what}
                </span>
                <span style={{ fontSize: 6.5, color: "var(--gf-text-dim)" }} className="shrink-0 tabular-nums">
                  {r.when}
                </span>
              </div>
            ))}
          </div>
        </div>
      </AppChrome>
    </div>
  );
}

const STAGES = [
  SceneSignIn,
  SceneApproval,
  SceneLive,
  SceneAlert,
  SceneEmail,
  SceneResolve,
  SceneDevices,
  SceneAircon,
  SceneRules,
  SceneAnalytics,
  SceneReports,
];

/* ── the section ─────────────────────────────────────────────────────────── */
export default function LoginTutorial() {
  // `once: false` matters: inView has to go BACK to false when the section
  // leaves, or it cannot gate anything that needs to stop again.
  const { ref, inView } = useInView<HTMLDivElement>({ threshold: 0.25, once: false });
  // A phone gets a narrower, TALLER design box: 16:9 at 360px is only 202px
  // high, which is not enough room for six scenes that each hold a small
  // interface. 6:5 gives them the height back without the scale penalty.
  const narrow = useIsNarrow();
  const [scene, setScene] = useState<number>(0);
  // Bumped on every manual pick, so the dwell timer restarts from that moment
  // instead of inheriting whatever was left of the previous scene's.
  const [nonce, setNonce] = useState<number>(0);

  const still = prefersReducedMotion();

  useEffect(() => {
    // Off screen: don't advance. Coming back to a walkthrough that has silently
    // played three scenes without you is worse than finding it where you left
    // it. Reduced motion: no auto-advance at all — the bars are the control.
    if (!inView || still) return;
    const t = window.setTimeout(
      () => setScene((s) => (s + 1) % SCENES.length),
      SCENES[scene]?.ms ?? 5000,
    );
    return () => window.clearTimeout(t);
  }, [scene, inView, still, nonce]);

  const pick = (i: number) => {
    setScene(i);
    setNonce((n) => n + 1);
  };

  const Stage = STAGES[scene] ?? SceneSignIn;
  const active = SCENES[scene];

  return (
    <section className="relative px-4 sm:px-6 py-16 sm:py-20" style={{ borderTop: "1px solid var(--gf-divider)" }}>
      <SectionRail />
      <div className="max-w-7xl mx-auto">
        <div className="mb-8 max-w-2xl">
          <Reveal>
            <p
              className="text-[12px] tracking-[0.22em] uppercase mb-3"
              style={{ color: "var(--gf-accent-text)" }}
            >
              Walkthrough
            </p>
          </Reveal>
          <SplitHeading
            text="What using it actually looks like"
            className="text-[24px] sm:text-[28px] font-semibold leading-snug"
            style={{ color: "var(--gf-text-primary)" }}
          />
          <Reveal delay={120}>
            <p className="text-[14px] leading-relaxed mt-2.5" style={{ color: "var(--gf-text-muted)" }}>
              No public sign-up, and no password to steal — sign-in is delegated to Google
              Workspace, restricted to @cspc.edu.ph and @my.cspc.edu.ph, and approved by hand.
              Everything past step 02 is the system itself: live panels, an alert running its
              course, the room cooling itself, forecasts, rules and reports.
            </p>
          </Reveal>
        </div>

        <div ref={ref} className="grid lg:grid-cols-[1.5fr_1fr] gap-6 lg:gap-8 items-center">
          <Reveal y={20}>
            <BrowserFrame>
              {/* Fixed 560x315 design box, scaled to fit. The scenes position
                  themselves absolutely against it, so they are laid out once and
                  simply get smaller on a phone — see ScaledStage. */}
              <ScaledStage width={narrow ? 360 : 560} height={narrow ? 300 : 315}>
                <div className="relative w-full h-full overflow-hidden" style={{ background: "var(--gf-bg)" }}>
                  {/* Mounted only while the section is on screen. Mounting is
                      what starts a scene's timeline, so rendering it eagerly
                      meant scene 01 played its cursor, click and popup during
                      page load and was sitting at its finished state — cursor
                      already faded out — by the time anyone scrolled down to it.
                      It read as frozen, because it was over.

                      `key` then remounts on every scene change, which is what
                      re-runs the entrance animation. Far clearer than one
                      timeline that would have to rewind eleven scenes. */}
                  {inView && <Stage key={`${scene}-${nonce}`} compact={narrow} />}
                </div>
              </ScaledStage>
            </BrowserFrame>
            <p className="text-[11px] mt-3" style={{ color: "var(--gf-text-dim)" }}>
              Illustrative — the flow and its order are real, the values are not a live feed.
              {!still && " Pick a step to jump to it."}
            </p>
          </Reveal>

          {/* ONE caption, following the stage.
              Six cards restated every scene at once, which on a phone was most
              of the section and asked the reader to hold six things in their
              head while watching a seventh. A single box says only what is on
              screen now — and the bars above it do the job the cards were really
              there for, which was letting someone jump. */}
          <div className="gf-panel p-4">
            {/* Progress bars, one per scene: past filled, current filling,
                future empty. Navigation and progress in one control, so the
                reader can see how far in they are AND skip, without a second
                widget for each. */}
            <div className="flex gap-1.5 mb-4">
              {SCENES.map((s, i) => {
                const done = i < scene;
                const current = i === scene;
                const playing = current && inView && !still;
                return (
                  <button
                    key={s.n}
                    type="button"
                    onClick={() => pick(i)}
                    aria-label={`Step ${s.n}: ${s.title}`}
                    {...(current ? { "aria-current": "step" as const } : {})}
                    // The bar is 3px; the button is padded to a real touch target
                    // around it, because a 3px tap target is not one.
                    className="flex-1 py-2"
                  >
                    <span
                      className="block relative overflow-hidden"
                      style={{ height: 3, borderRadius: 2, background: "var(--gf-seg-empty)" }}
                    >
                      <span
                        key={`${scene}-${nonce}`}
                        className="absolute left-0 top-0 block h-full"
                        style={{
                          background: "var(--gf-accent)",
                          width: done || (current && !playing) ? "100%" : 0,
                          opacity: done ? 0.45 : 1,
                          ...(playing ? { animation: `landingDwell ${s.ms}ms linear forwards` } : {}),
                        }}
                      />
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Keyed on the scene so the copy crossfades instead of snapping.
                minHeight holds the box still across scenes whose text runs to a
                different number of lines — without it the section jolts every
                few seconds, which is far more distracting than the animation. */}
            <div
              key={`${scene}-${nonce}`}
              style={{
                minHeight: 74,
                ...(still ? {} : { animation: "fadeIn 320ms cubic-bezier(0.16,1,0.3,1)" }),
              }}
            >
              <div className="flex items-baseline gap-2 mb-1.5">
                <span
                  className="text-[12px] font-semibold tracking-[0.18em]"
                  style={{ color: "var(--gf-accent-text)" }}
                >
                  {active?.n}
                </span>
                <h3 className="text-[15.5px] font-semibold" style={{ color: "var(--gf-text-primary)" }}>
                  {active?.title}
                </h3>
              </div>
              <p className="text-[13.5px] leading-relaxed" style={{ color: "var(--gf-text-muted)" }}>
                {active?.body}
              </p>
            </div>
          </div>
        </div>

        {/* Announce the scene change for anyone not watching the stage. */}
        <p className="sr-only" aria-live="polite">
          {active ? `Step ${active.n}: ${active.title}` : ""}
        </p>
      </div>
    </section>
  );
}
