/**
 * Server-side shapes shared by more than one page.
 *
 * `Volume` lived in `pages/ServerMetrics.tsx`, which `pages/ServerDetail.tsx` imported —
 * while `ServerMetrics` imports `ServerDetail` as a value and renders it. That is an
 * import cycle. It was harmless because the type direction used `import type`, which
 * TypeScript erases, so the emitted JS had only a one-way edge.
 *
 * The safety was incidental, though: promote that `import type` to a value import — a
 * const, an enum, a helper that happens to live alongside the type — and it becomes a
 * real circular dependency, whose symptom is an `undefined` import at module-init time
 * in a production build only. A type neither page owns removes the cycle outright.
 *
 * See audits/code-complexity-report-2026-08-25.md — C-14.
 */

/** One mounted fixed volume, as reported by the Go agent (`server_volumes`). */
export interface Volume {
  mount: string;
  fstype: string;
  total_gb: number;
  used_gb: number;
  percent: number;
}
