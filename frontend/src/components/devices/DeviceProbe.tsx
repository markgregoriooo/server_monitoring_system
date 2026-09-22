import { useCallback, useState } from "react";
import type { ApiResult, ProbeResult } from "../../api/api";
import { GF as gf, STATUS } from "../../theme/gf";

const { green: GREEN, orange: ORANGE, red: RED } = STATUS;

// ─── "Test connection", shared by Add router and Add UPS ──────────────────────
//
// The gap this closes: registering a router or a UPS with a wrong IP, a wrong community
// or a blocked UDP 161 produced NO indication at all. The device was created, its first
// poll failed into the server console, and the card showed "Offline" — which is also
// exactly what a healthy device that has not been polled yet looks like. So the admin
// waited for something that was never going to arrive.
//
// One component for both forms rather than a copy each, for the same reason
// theme/gf.ts exists: two copies of a diagnostic drift, and the day they disagree is
// the day somebody is using them to decide whether the network or the form is at fault.
// The MikroTik page had its own Test button before this and keeps it — its probe is a
// RouterOS API login, not SNMP, so it answers a different question with different
// fields. What is shared there is the contract, not the code.

export type ProbeState =
  | { phase: "idle" }
  // Split from a plain boolean: an INPUT rejection ("not a valid IPv4 address") and a
  // probe that ran and came back negative are different events, and conflating them
  // sends someone to check a cable over a typo.
  | { phase: "testing" }
  | { phase: "error"; message: string }
  | { phase: "done"; result: ProbeResult };

/**
 * Holds one form's probe state.
 *
 * `reset` matters more than it looks: a PASS left sitting beside fields the admin has
 * since edited is worse than no result at all, because it is a green tick vouching for
 * a value that was never tested. Every field that feeds the probe clears it on change.
 */
export function useProbe() {
  const [state, setState] = useState<ProbeState>({ phase: "idle" });

  const reset = useCallback(() => {
    setState((s) => (s.phase === "idle" ? s : { phase: "idle" }));
  }, []);

  const run = useCallback(async (call: () => Promise<ApiResult<ProbeResult>>) => {
    setState({ phase: "testing" });
    const r = await call();
    if (!r.success || !r.data) {
      setState({ phase: "error", message: r.error || "Could not reach the backend to run the test." });
      return null;
    }
    // `ok:false` here is the backend refusing the INPUT — nothing was probed.
    if (!r.data.ok) {
      setState({ phase: "error", message: r.data.error || "The test could not be run." });
      return null;
    }
    setState({ phase: "done", result: r.data });
    return r.data;
  }, []);

  return { state, run, reset, setState };
}

/** True once a probe has returned a verdict the form should act on. */
export const probePassed = (s: ProbeState) => s.phase === "done" && s.result.verdict?.ok === true;

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-[11px] leading-relaxed">
      <span className="shrink-0" style={{ color: gf.textDim, minWidth: 74 }}>
        {label}
      </span>
      <span style={{ color: gf.textMuted }}>{children}</span>
    </div>
  );
}

/**
 * The result panel. Renders nothing while idle, so the form is unchanged until asked.
 *
 * It shows the MEASUREMENTS as well as the verdict on purpose. The verdict says what to
 * do; the measurements are what an admin needs when they disagree with it — "it replies
 * to ping in 2 ms and ignores SNMP" is a sentence somebody can take to the network team,
 * where "test failed" is not.
 */
export function ProbeResultPanel({ state }: { state: ProbeState }) {
  if (state.phase === "idle") return null;

  if (state.phase === "testing") {
    return (
      <div className="px-3 py-2 rounded-[2px] text-[12px]" style={{ background: gf.bg, border: `1px solid ${gf.border}`, color: gf.textMuted }}>
        Probing… ICMP first, then SNMP. Up to ~8 seconds if nothing answers.
      </div>
    );
  }

  if (state.phase === "error") {
    return (
      <div className="px-3 py-2 rounded-[2px] text-[12px]" style={{ background: `${RED}14`, border: `1px solid ${RED}40`, color: RED }}>
        {state.message}
      </div>
    );
  }

  const r = state.result;
  const v = r.verdict;
  // Three tones, not two: a refusal that found a live host is amber, because something
  // IS there and the next step is a setting. Only silence at the address is red.
  const tone = v?.ok ? GREEN : v?.code === "unreachable" ? RED : ORANGE;

  return (
    <div className="px-3 py-2 rounded-[2px] flex flex-col gap-1.5" style={{ background: `${tone}12`, border: `1px solid ${tone}40` }}>
      <div className="text-[12px] font-semibold" style={{ color: tone }}>
        {v?.ok ? "✓ " : "! "}
        {v?.title}
      </div>
      <div className="text-[11px] leading-relaxed" style={{ color: gf.textMuted }}>
        {v?.detail}
      </div>

      <div className="mt-0.5 pt-1.5 flex flex-col gap-0.5" style={{ borderTop: `1px solid ${gf.divider}` }}>
        <Line label="ICMP">
          {r.icmp?.reachable
            ? `reply in ${r.icmp.latencyMs} ms${r.icmp.packetLossPct ? `, ${r.icmp.packetLossPct}% loss` : ", no loss"}`
            : "no reply (host down, wrong IP, or ICMP filtered)"}
        </Line>

        {/* Stated explicitly when it was never tried, rather than shown as a failure:
            a blank community is a CHOICE to monitor by ping, not an omission. */}
        <Line label="SNMP">
          {!r.snmp?.attempted
            ? "not attempted — no community given"
            : r.snmp.answered
              ? `answers on UDP ${r.port}${r.snmp.sysName ? ` · ${r.snmp.sysName}` : ""}`
              : `no answer on UDP ${r.port}${r.snmp.error ? ` (${r.snmp.error})` : ""}`}
        </Line>

        {r.snmp?.answered && r.snmp.sysDescr && (
          <Line label="Device">{r.snmp.sysDescr.slice(0, 90)}</Line>
        )}

        {r.snmp?.answered && !r.ups?.isUps && (
          <Line label="Interfaces">
            {r.ifCount
              ? `${r.ifCount} port${r.ifCount === 1 ? "" : "s"} — ${r.ifNames?.slice(0, 5).join(", ")}${(r.ifCount ?? 0) > 5 ? " …" : ""}`
              : "none exposed (no IF-MIB)"}
          </Line>
        )}

        {r.ups?.isUps && (
          <Line label="UPS-MIB">
            {[
              r.ups.chargePct != null ? `battery ${r.ups.chargePct}%` : null,
              r.ups.runtimeMin != null ? `${r.ups.runtimeMin} min runtime` : null,
              r.ups.outputState ? `output ${r.ups.outputState}` : null,
            ]
              .filter(Boolean)
              .join(" · ") || "answers"}
          </Line>
        )}
      </div>
    </div>
  );
}
