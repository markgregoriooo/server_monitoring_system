/**
 * Server types shared by more than one page. `Volume` was in ServerMetrics.tsx, which
 * imports ServerDetail, which imported the type back; keeping it here removes the cycle.
 * See audits/code-complexity-report-2026-08-25.md (C-14).
 */

/** One mounted fixed volume, as reported by the Go agent (`server_volumes`). */
export interface Volume {
  mount: string;
  fstype: string;
  total_gb: number;
  used_gb: number;
  percent: number;
}
