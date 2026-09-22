/**
 * Notification shapes, owned by neither the context nor its helpers.
 *
 * These lived in `context/NotificationContext.tsx`, which imports `routeFor` from
 * `components/notifications/notificationUtils.ts` — while that file imported these
 * types back. A cycle, harmless only because the type direction used `import type`
 * and TypeScript erases it. Promote that to a value import and it becomes a real
 * circular dependency that fails at module-init time in a production build.
 *
 * See audits/code-complexity-report-2026-08-25.md — C-14.
 */

export type Severity = "info" | "warning" | "critical";

/** Mirrors the backend `toClient()` shape (camelCase). `id` is the per-user
 *  `alert_notifications` row — the thing we mark read. */
export interface AppNotification {
  id: number;
  alertId: number;
  deviceId: number;
  /** The EFFECTIVE name — an admin's display label if set, otherwise the hostname.
   *  Matches what every page shows for the same device. */
  deviceName: string | null;
  /** The agent-reported hostname, sent ONLY when it differs from `deviceName`, so a
   *  device with no custom label never renders as "web-01 (web-01)". */
  deviceHostname: string | null;
  /** `devices.device_type` (server|router|mikrotik|ups|esp32|aircon), or null for alerts
   *  with no device row. Drives which page a notification click opens — see `routeFor`. */
  deviceType: string | null;
  type: string;
  title: string;
  message: string;
  severity: Severity;
  isRead: boolean;
  createdAt: string;
  sentAt: string;
  /** Shared lifecycle (acknowledge/resolve) — kept live via the `alertUpdated` event. */
  status?: "active" | "acknowledged" | "resolved";
  acknowledgedByName?: string | null;
  acknowledgedByRole?: string | null;
  acknowledgedAt?: string | null;
  resolvedAt?: string | null;
}
