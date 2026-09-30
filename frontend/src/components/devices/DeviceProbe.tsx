import { useCallback, useState } from "react";
import type { ApiResult, ProbeResult } from "../../api/api";
import { GF as gf, STATUS } from "../../theme/gf";

const { green: GREEN, orange: ORANGE, red: RED } = STATUS;

// ─── "Test connection" for Add router and Add UPS ──────────────────────
// Without it, a wrong IP, community or blocked UDP 161 only showed as "Offline",
// the same as a healthy device not polled yet. One component for both forms so they
// always agree. The MikroTik page keeps its own test, since that is a RouterOS API
// login, not SNMP.

export type ProbeState =
  | { phase: "idle" }
  // An input rejection ("not a valid IPv4 address") and a test that ran and failed are
  // different, so they are kept apart.
  | { phase: "testing" }
  | { phase: "error"; message: string }
  | { phase: "done"; result: ProbeResult };

/**
 * Holds one form's test state. `reset` clears the result whenever a tested field
 * changes, so a green tick never refers to values that were not tested.
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
 * The result panel; nothing while idle. Shows the measurements as well as the verdict,
 * so an admin can tell the network team something concrete ("answers ping in 2 ms,
 * ignores SNMP").
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
