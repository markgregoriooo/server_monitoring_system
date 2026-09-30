import { useState, useId } from "react";
import type { ReactNode } from "react";
import Reveal from "./Reveal";
import { SplitHeading, SectionRail } from "./ScrollFx";

/**
 * Frequently asked questions. Every answer matches the code, with the real numbers
 * (retention, domains, severity default, buffering), including the awkward ones like
 * "Can I use it off campus?". The role breakdown lives here too.
 */

const CHEVRON_SIZE = 12;

interface QA {
  q: string;
  a: ReactNode;
}

const QUESTIONS: QA[] = [
  {
    q: "Who can sign in?",
    a: (
      <>
        Anyone with a <strong>@cspc.edu.ph</strong> or <strong>@my.cspc.edu.ph</strong> Google
        account can request access — but signing in does not by itself grant it. A first sign-in
        creates a <em>pending</em> registration that an ICTU administrator has to approve, and
        assign a role to, before any page opens.
      </>
    ),
  },
  {
    q: "Why does my account need to be approved by hand?",
    a: (
      <>
        Because this dashboard shows the state of the infrastructure it monitors — hostnames, IP
        addresses, network topology, which machines are struggling and which are unattended. A
        valid CSPC address proves who you are; it does not establish that you have a reason to see
        the server room. Those are two different questions, and only a person can answer the
        second.
      </>
    ),
  },
  {
    q: "What can each role do?",
    a: (
      <>
        <strong>IT Staff</strong> get every monitoring page — servers, network, MikroTik, UPS,
        environment and air conditioning — plus acknowledging and resolving alerts, predictive
        analytics, history and generated reports.
        <br />
        <br />
        <strong>Admin</strong> get all of that, plus the two pages that change how the system
        itself behaves: <em>User Management</em>, which approves or rejects sign-in requests, and{" "}
        <em>Alert Rules</em>, which sets the thresholds every alert is measured against.
      </>
    ),
  },
  {
    q: "What does the system store about me?",
    a: (
      <>
        Your name, email address and profile photo, taken from your Google account and re-synced at
        every sign-in — the system never holds a password for you, because it never issues one. It
        also records an audit trail of actions taken in the dashboard, including the IP address and
        browser they came from, kept for <strong>365 days</strong>.
        <br />
        <br />
        Alerts are kept 30 days and generated reports 90. The full detail, including your rights
        under the Data Privacy Act, is in the Privacy Notice — readable without an account, linked
        in the footer.
      </>
    ),
  },
  {
    q: "How do alerts reach me?",
    a: (
      <>
        Four ways, and you can tune them per account. A bell feed and a corner toast appear in the
        dashboard the instant an alert is raised; an optional browser notification fires when the
        tab is in the background; and email goes out for anything at or above your chosen severity
        — <strong>critical</strong> by default.
        <br />
        <br />
        The same device and condition will not re-alert within a cool-off window, so a metric
        sitting on its threshold cannot turn into a hundred emails.
      </>
    ),
  },
  {
    q: "Can I open the dashboard from outside campus?",
    a: (
      <>
        Not as things stand. The backend has to sit on the same network as the equipment it watches
        — the SNMP and MikroTik pollers dial into device addresses, and the sensor node holds a
        socket open to a host on its own LAN. The dashboard is served from that same machine.
        <br />
        <br />
        Reaching it from outside is a matter of campus network policy — a VPN, or publishing the
        hostname — rather than something this system decides on its own.
      </>
    ),
  },
  {
    q: "What happens to readings during a power cut or a network outage?",
    a: (
      <>
        They are kept and replayed, not lost. The sensor node writes to a micro SD card whenever it
        cannot reach the backend, and replays the buffer on reconnect under the timestamps the
        readings were actually taken at. Server agents buffer their samples the same way and
        backfill in a batch.
        <br />
        <br />
        Separately, every ingested sample is mirrored to flat files on on-site storage as it
        arrives — an independent copy that survives the database being wiped.
      </>
    ),
  },
  {
    q: "Something looks wrong. Who do I contact?",
    a: (
      <>
        ICTU, through the support address in the footer. If you are reporting a reading you believe
        is incorrect, note the device and the time you saw it — history is stored, so a specific
        moment can be gone back to and checked.
      </>
    ),
  },
];

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width={CHEVRON_SIZE}
      height={CHEVRON_SIZE}
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
      style={{
        transform: open ? "rotate(180deg)" : "rotate(0deg)",
        transition: "transform 220ms cubic-bezier(0.16,1,0.3,1)",
      }}
    >
      <path d="M2.5 4.5 L6 8 L9.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Item({
  qa,
  open,
  onToggle,
  index,
}: {
  qa: QA;
  open: boolean;
  onToggle: () => void;
  index: number;
}) {
  const id = useId();
  const panelId = `${id}-panel`;
  const buttonId = `${id}-button`;

  return (
    <Reveal delay={index * 55}>
      <div className="gf-panel">
        <h3>
          <button
            type="button"
            id={buttonId}
            aria-expanded={open}
            aria-controls={panelId}
            onClick={onToggle}
            className="w-full flex items-center justify-between gap-4 text-left px-4 py-3.5"
            style={{
              color: open ? "var(--gf-text-primary)" : "var(--gf-text-muted)",
              transition: "color 160ms ease",
            }}
          >
            <span className="text-[14px] font-semibold leading-snug">{qa.q}</span>
            <Chevron open={open} />
          </button>
        </h3>

        {/* Height animates with grid-template-rows 0fr → 1fr, which works for any content
           height (max-height would need a guessed limit). */}
        <div
          id={panelId}
          role="region"
          aria-labelledby={buttonId}
          style={{
            display: "grid",
            gridTemplateRows: open ? "1fr" : "0fr",
            transition: "grid-template-rows 280ms cubic-bezier(0.16,1,0.3,1)",
          }}
        >
          {/* `min-height: 0` is needed: a grid item defaults to min-height:auto and would not
             collapse to the 0fr row. */}
          <div style={{ overflow: "hidden", minHeight: 0 }}>
            <div
              className="px-4 pb-4 text-[13.5px] leading-relaxed"
              style={{ color: "var(--gf-text-muted)" }}
            >
              {qa.a}
            </div>
          </div>
        </div>
      </div>
    </Reveal>
  );
}

export default function Faq() {
  // One at a time. Eight answers open at once is a wall of text, and the point
  // of collapsing them is that the whole list stays scannable.
  const [openIndex, setOpenIndex] = useState<number>(0);

  return (
    <section
      className="relative px-4 sm:px-6 py-16 sm:py-20"
      style={{ borderTop: "1px solid var(--gf-divider)" }}
      id="faq"
    >
      <SectionRail />
      <div className="max-w-7xl mx-auto">
        <div className="grid lg:grid-cols-[0.85fr_1.4fr] gap-8 lg:gap-14 items-start">
          <div className="lg:sticky" style={{ top: 76 }}>
            <Reveal>
              <p
                className="text-[12px] tracking-[0.22em] uppercase mb-3"
                style={{ color: "var(--gf-accent-text)" }}
              >
                FAQ
              </p>
            </Reveal>
            <SplitHeading
              text="Questions people actually ask"
              className="text-[24px] sm:text-[28px] font-semibold leading-snug"
              style={{ color: "var(--gf-text-primary)" }}
            />
            <Reveal delay={140}>
              <p className="text-[14px] leading-relaxed mt-2.5" style={{ color: "var(--gf-text-muted)" }}>
                Access, privacy and what happens when things go wrong. If something here is not
                covered, the support address in the footer reaches ICTU.
              </p>
            </Reveal>
          </div>

          <div className="flex flex-col gap-2.5">
            {QUESTIONS.map((qa, i) => (
              <Item
                key={qa.q}
                qa={qa}
                index={i}
                open={openIndex === i}
                onToggle={() => setOpenIndex(openIndex === i ? -1 : i)}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
