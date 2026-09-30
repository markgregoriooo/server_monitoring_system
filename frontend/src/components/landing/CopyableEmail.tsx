import { useEffect, useRef, useState } from "react";

/**
 * An email address that works whether or not the visitor has a mail client.
 *
 * A plain `mailto:` does nothing on a machine with no mail app set up. So a click
 * copies the address and shows "Copied", then lets the `mailto:` open normally.
 * Uses the `execCommand` fallback because `navigator.clipboard` needs HTTPS and the
 * campus LAN deployment may be plain HTTP.
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
    // No preventDefault: the mailto still opens for anyone who has a mail client.
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
