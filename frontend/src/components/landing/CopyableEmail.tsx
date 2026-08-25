import { useEffect, useRef, useState } from "react";

/**
 * An email address that is useful whether or not the visitor has a mail client.
 *
 * A bare `mailto:` is a trapdoor. Chrome hands the URL to the OS, and on a
 * machine with no registered mail handler — the default state of a fresh
 * Windows install without Outlook set up — absolutely nothing happens: no
 * composer, no error, no feedback. The one contact route on the page reads as
 * broken to precisely the people who needed it.
 *
 * So the click does BOTH. It copies the address to the clipboard and shows that
 * it did, then lets the `mailto:` proceed normally. Anyone with a mail client
 * gets their composer as before; anyone without gets the address on their
 * clipboard and a visible "Copied" instead of silence.
 *
 * `navigator.clipboard` is a secure-context API and this dashboard is served
 * over plain HTTP on the campus LAN, so it is simply absent in the deployment
 * that matters most. The `execCommand` path is not legacy cruft to be cleaned up
 * later — it is the one that will actually run on site. Same reasoning as the
 * install-keys panel.
 */

async function copyText(text: string): Promise<boolean> {
  // Preferred path — HTTPS, or localhost during development.
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through — permissions can refuse even in a secure context */
    }
  }

  // The path that runs on the LAN deployment.
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    // Off-screen but still selectable. `display:none` cannot be selected, and a
    // visible element would scroll the page to itself on focus.
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export default function CopyableEmail({
  address,
  className = "",
  style,
}: {
  address: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const onClick = () => {
    // Deliberately NOT preventDefault: the mailto still fires for anyone whose
    // machine can act on it. This only adds a floor under the case where it
    // cannot.
    void copyText(address).then((ok) => {
      setState(ok ? "copied" : "failed");
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setState("idle"), 2200);
    });
  };

  return (
    <span className="inline-flex items-baseline gap-2 flex-wrap">
      <a
        href={`mailto:${address}`}
        onClick={onClick}
        title="Click to copy — also opens your mail app if you have one"
        className={`hover:underline break-all ${className}`}
        style={style}
      >
        {address}
      </a>

      {/* Feedback lives in the DOM rather than in a tooltip so a screen reader
          announces it too — the whole point is that the silent case is over. */}
      <span aria-live="polite" className="text-[11px] shrink-0">
        {state === "copied" && <span style={{ color: "var(--gf-text-dim)" }}>Copied</span>}
        {state === "failed" && (
          <span style={{ color: "var(--gf-text-dim)" }}>Select and copy the address</span>
        )}
      </span>
    </span>
  );
}
