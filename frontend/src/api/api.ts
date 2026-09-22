import apiClient from "./client.js";

interface LoginUser {
  id: number;
  name: string;
  username: string;
  email: string;
  role: string;
  status?: string;
  avatar?: string;
  profile_image?: string;
  permissions: string[];
  created_at?: string;
  last_login?: string;
  policy_version?: string | null;
  policy_accepted_at?: string | null;
  policy_current?: string;
}

interface LoginResponse {
  token: string;
  user: LoginUser;
}

export interface ApiResult<T = any> {
  success: boolean;
  data?: T;
  status?: number;
  error?: string;
}

/** POST /network/test and POST /ups/test — "can this device be monitored, and HOW?"
 *
 *  Mirrors the return of backend `services/deviceProbe.js`. `ok:false` with `error` set
 *  means the INPUT was rejected (blank or malformed IP, impossible port) and nothing was
 *  probed; `ok:true` means the probe ran and `verdict` holds the answer — which may still
 *  be a refusal. The two are different things and the form says so differently. */
export interface ProbeResult {
  ok: boolean;
  /** Only when ok === false: why the probe could not even be attempted. */
  error?: string;
  ip?: string;
  port?: number;
  communityGiven?: boolean;
  icmp?: { reachable: boolean; latencyMs: number | null; packetLossPct: number | null };
  snmp?: {
    attempted: boolean;
    answered: boolean;
    sysName: string | null;
    sysDescr: string | null;
    uptimeSeconds: number | null;
    error: string | null;
  };
  ifCount?: number;
  ifNames?: string[];
  ups?: {
    isUps: boolean;
    chargePct: number | null;
    runtimeMin: number | null;
    outputState: string | null;
  };
  verdict?: {
    /** ups | snmp_router | snmp_bare | ping_only | unreachable — stable, keyed off by the UI. */
    code: string;
    /** Judged against what the form is trying to register, not in the abstract. */
    ok: boolean;
    registerAs: string | null;
    title: string;
    detail: string;
  };
}

/** `deviceFirstPoll` — how the FIRST poll of a just-registered device went, pushed to
 *  the admin who registered it (and to nobody else). The poll is fire-and-forget so the
 *  response is not held behind an SNMP/API timeout, which used to mean its verdict
 *  reached the server console and no human at all. */
export interface DeviceFirstPoll {
  id: number | string;
  name: string;
  kind: "router" | "ups" | "mikrotik";
  ok: boolean;
  reason: string | null;
  /** 'ping' routers never report interfaces — an empty port list is not a failure. */
  mode: string;
}

/** Page sizes a report can be rendered at. Mirrors PAPER_SIZES in
 *  backend/services/reportTemplate.js — `folio` is Philippine long bond (8.5x13in),
 *  which is ICTU's default. */
export type PaperSizeKey = "a4" | "letter" | "folio";

/** One entry of GET /reports/template's `paperSizes` map. */
export interface PaperSizeOption {
  label: string;
  size: [number, number];
  inches: string;
}

/** One line of the report's signature block. */
export interface Signatory {
  /** The label, e.g. "Prepared by:". Required — a line with no label is not a block. */
  role: string;
  /** A fixed name, or "" to leave the line blank for a manual signature. */
  name: string;
  /** Fill `name` with whoever generated the report. An explicit name still wins. */
  auto: boolean;
}

/** Mirrors MAX_SIGNATORIES in backend/services/reportTemplate.js — two rows of three. */
export const MAX_SIGNATORIES = 6;

/** GET /reports/template — the active branding an admin can change. */
export interface ReportTemplate {
  paperSize: PaperSizeKey;
  /** The signature block, in printed order. */
  signatories: Signatory[];
  /** The large line on the letterhead, where CSPC's own stationery reads
   *  "COLLEGE of COMPUTER STUDIES". */
  unitName: string;
  /** What it falls back to when cleared — shown as the input's placeholder. */
  unitNameDefault: string;
  logos: Record<
    "cspc" | "ictu",
    {
      /** true = ICTU's own upload; false = the placeholder bundled with the repo. */
      uploaded: boolean;
      /** The fixed name it is stored under, e.g. "cspc-logo.png". */
      file: string | null;
      /** The name the admin uploaded it as. Falls back to `file` for older uploads. */
      originalName: string | null;
      updatedAt: string | null;
      bundled: string;
    }
  >;
}

/** Message shown when the server sent no `error` field of its own. Keyed by HTTP status;
 *  anything absent falls through to the network-level message. */
const STATUS_FALLBACK: Record<number, string> = {
  401: "Unauthorized. Please log in again.",
  403: "You don't have permission to do that.",
  404: "Resource not found.",
  429: "Too many requests. Please wait.",
  500: "Server error. Please try again later.",
  503: "Service temporarily unavailable. Please try again shortly.",
};

// error handler
const handleError = (err: any): ApiResult<never> => {
  const status = err?.response?.status;
  const serverMessage = err?.response?.data?.error;

  // A lookup table, written as a lookup table. This was a six-deep ternary ladder —
  // readable, but a chain of equality tests against one variable IS a map, and saying so
  // makes adding a status a one-line data change instead of another rung.
  const fallback = STATUS_FALLBACK[status ?? 0] ?? "Cannot connect to server.";

  return {
    success: false,
    status,
    error: serverMessage || fallback,
  };
};

export const api = {
  // Auth — Google sign-in is the ONLY login path. Send the one-time AUTH CODE
  // (from the custom "CSPC Mail" button's authorization-code flow); the backend
  // exchanges it with Google. On an active account the backend returns
  // { token, user }. For a not-yet-active account it returns a body with status =
  // "pending" | "rejected" | "disabled", which we pass through (via data) so the
  // Login page can show the right message instead of an error.
  loginWithGoogle: async (code: string): Promise<ApiResult<LoginResponse & { status?: string; message?: string }>> => {
    try {
      const res = await apiClient.post<LoginResponse>("/auth/google", { code });
      return { success: true, data: res.data as any };
    } catch (err: any) {
      return { ...handleError(err), data: err?.response?.data };
    }
  },

  // Admin — registration approvals
  getPendingUsers: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/users/pending");
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  approveUser: async (id: number, role: string): Promise<ApiResult> => {
    try {
      const res = await apiClient.post(`/users/${id}/approve`, { role });
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  rejectUser: async (id: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.post(`/users/${id}/reject`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  me: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/auth/me");
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  logout: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.post("/auth/logout");
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Privacy Notice & Terms — record acceptance of the version currently in force.
  // Sends no version: the server records its own constant, so a client cannot
  // claim to have accepted a document it was never shown.
  acceptPolicy: async (): Promise<ApiResult<{ policy_version: string; policy_current: string }>> => {
    try {
      const res = await apiClient.post("/policy/accept");
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Version in force, readable WITHOUT a session — the public /privacy page stamps
  // itself with this. apiClient attaches a token when there is one and the route
  // ignores it either way.
  policyVersion: async (): Promise<ApiResult<{ version: string }>> => {
    try {
      const res = await apiClient.get("/policy/version");
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Users (super_admin only)
  getUsers: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/users");
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // createUser / changePassword removed 2026-08-25 — their backend endpoints are gone.
  // Login is Google-only, so no password stored through them could ever authenticate
  // anyone, and nothing in this app called either function. See
  // audits/auth-flow-security-2026-08-25.md — AF-03.

  updateUser: async (id: number, data: any): Promise<ApiResult> => {
    try {
      const res = await apiClient.patch(`/users/${id}`, data);

      return {
        success: true,
        data: res.data,
      };

    } catch (err: any) {

      return handleError(err);

    }
  },

  // Update own USERNAME — the only self-editable field. Name, email and photo come
  // from the Google ID token and are re-synced on every sign-in, so editing them
  // here would be undone at the next login (see services/googleAuthService.js).
  updateMe: async (username: string): Promise<ApiResult<LoginUser>> => {
    try {
      const res = await apiClient.patch("/users/me", { username });
      return {
      success: true,
      data: res.data.data,
    };
    } catch (err: any) {
      return handleError(err);
    }
  },

  updateUserStatus: async (id: number, status: string): Promise<ApiResult> => {

    try {
      const res = await apiClient.patch(`/users/${id}/status`, { status });

      return {
        success: true,
        data: res.data,
      };

    } catch (err: any) {

      return handleError(err);

    }
  },

  deleteUser: async (id: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.delete(`/users/${id}`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },


  // Servers (live metrics from the Go monitoring agents)
  getServers: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/servers");
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Real metric history for one server (InfluxDB). Either a preset range
  // ("-1h" | "-6h" | "-24h" | "-7d" | "-30d") OR an absolute window via
  // { start, stop } ISO strings — pass one or the other; `start` wins if both go.
  getServerHistory: async (
    id: number,
    range: string,
    window?: { start: string; stop: string },
  ): Promise<ApiResult> => {
    try {
      const res = await apiClient.get(`/servers/${id}/history`, {
        params: window ? { ...window } : { range },
      });
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Device event log for one server (MySQL device_logs)
  getServerLogs: async (id: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.get(`/servers/${id}/logs`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Server agents — admin approval flow
  getPendingAgents: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/agents/pending");
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  approveAgent: async (id: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.post(`/agents/${id}/approve`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  rejectAgent: async (id: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.post(`/agents/${id}/reject`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Agent install keys (admin) — the credential the installer presents at enrollment.
  // Distinct from a server's agent token: revoking a key stops NEW enrollments and
  // leaves every already-enrolled agent reporting.
  getInstallKeys: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/agents/install-keys");
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // The response carries the plaintext key. It is the ONLY time the server will ever
  // return it — only a hash is stored — so the caller must show it before discarding.
  // No label: the dashboard identifies a key by its prefix and dates. The server still
  // writes one for the audit trail (installKeyService.create), and the field stays
  // accepted by the API, so this can grow a label again without a backend change.
  createInstallKey: async (
    expiresInDays: number | null,
  ): Promise<ApiResult<{ key: string; record: any }>> => {
    try {
      const res = await apiClient.post("/agents/install-keys", { expiresInDays });
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Servers this key enrolled that are still reporting — the blast radius of revoking
  // it with `revokeAgents`. Shown by name in the confirm dialog.
  getInstallKeyServers: async (id: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.get(`/agents/install-keys/${id}/servers`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // revokeAgents=false → block new enrolments only, running servers untouched.
  // revokeAgents=true  → also de-authorise the servers this key enrolled; each agent
  //                      gets a 403 on its next post, deletes its conf and exits.
  revokeInstallKey: async (id: number, revokeAgents = false): Promise<ApiResult> => {
    try {
      const res = await apiClient.post(`/agents/install-keys/${id}/revoke`, { revokeAgents });
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // The plaintext key again, so the install command can be re-opened. Admin-only, and
  // the backend audits every call — this is the one path that returns a key after
  // creation. 409 when the key predates recoverable storage.
  revealInstallKey: async (id: number): Promise<ApiResult<{ key: string; label: string }>> => {
    try {
      const res = await apiClient.get(`/agents/install-keys/${id}/reveal`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Remove a revoked key from the list. Rejected by the backend while the key is still
  // active — revoke first, so the "can this take servers down" decision is its own step.
  deleteInstallKey: async (id: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.delete(`/agents/install-keys/${id}`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Park / unpark a server for planned downtime (admin). While parked, offline
  // and threshold alerts are suppressed for it.
  setServerMaintenance: async (id: number, enabled: boolean): Promise<ApiResult> => {
    try {
      const res = await apiClient.post(`/servers/${id}/maintenance`, { enabled });
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  deleteServer: async (id: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.delete(`/servers/${id}`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Rename a server / set its admin display label (admin only). Pass an empty
  // string to clear the label and fall back to the hostname.
  renameServer: async (id: number, displayName: string): Promise<ApiResult> => {
    try {
      const res = await apiClient.patch(`/servers/${id}`, { displayName });
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Network monitoring — routers/switches via SNMP (IF-MIB)
  getNetworkDevices: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/network");
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  getNetworkHistory: async (
    id: number,
    range: string,
    iface?: string,
    window?: { start: string; stop: string },
  ): Promise<ApiResult> => {
    try {
      const params: Record<string, string> = window ? { ...window } : { range };
      if (iface) params.interface = iface;
      const res = await apiClient.get(`/network/${id}/history`, { params });
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Whether the ESP32 is currently reporting. Needed on first paint — otherwise the
  // page only finds out via the next `esp32Status` socket transition, which may never come.
  getSensorStatus: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/environment/sensor-status");
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Room-level alert thresholds ({tempWarn,tempCrit,gasWarn,gasCrit,humWarn,humCrit}) —
  // what the dashboards colour humidity and gas against, so a tile turns orange exactly
  // when the system starts calling it a warning. Both roles; rule EDITING stays admin-only
  // on /api/alert-rules. See hooks/useRoomThresholds.ts.
  getRoomThresholds: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/environment/thresholds");
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // ── MQ-2 gas sensors: which channels are wired, and where each one is ──────────────
  // Read by both roles (the Environment page needs the labels to draw its lines); the PATCH
  // is admin-only server-side, because asserting a sensor is wired is a hardware claim and a
  // wrong one arms a floating ADC pin to raise smoke alarms.
  getGasSensors: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/gas-sensors");
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Both fields optional: renaming and (un)wiring are separate acts, and the server
  // COALESCEs so an omitted one is never blanked. `locationLabel: ""` is a deliberate clear.
  updateGasSensor: async (
    channel: number,
    body: { locationLabel?: string; enabled?: boolean },
  ): Promise<ApiResult> => {
    try {
      const res = await apiClient.patch(`/gas-sensors/${channel}`, body);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  getNetworkLogs: async (id: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.get(`/network/${id}/logs`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Ask the ESP32 to re-measure the MQ-2 clean-air baseline and save it to its flash.
  // Admin-only. The air must be clean when this runs — the result arrives asynchronously
  // on the `gasCalibrated` socket event.
  calibrateGasSensor: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.post("/environment/calibrate-gas");
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // UPS monitoring — battery/load via SNMP (UPS-MIB / RFC 1628)
  getUpsDevices: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/ups");
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  getUpsHistory: async (
    id: number,
    range: string,
    window?: { start: string; stop: string },
  ): Promise<ApiResult> => {
    try {
      const res = await apiClient.get(`/ups/${id}/history`, {
        params: window ? { ...window } : { range },
      });
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  addNetworkDevice: async (payload: {
    name: string;
    ip: string;
    /** Read-only v2c community. **Empty string = register for ICMP ping monitoring
     *  only** (up/down, latency, packet loss — no per-port traffic or link status),
     *  which is the only way to watch gear you cannot enable SNMP on, such as an
     *  ISP-owned router. A UPS has no such fallback and still requires one. */
    community: string;
    snmpPort?: number | string | undefined;
    location?: string | undefined;
  }): Promise<ApiResult> => {
    try {
      const res = await apiClient.post("/network", payload);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  /** Probe an address BEFORE registering it. Persists nothing.
   *
   *  The Add form's answer to "I filled this in and nothing ever appeared": a wrong IP,
   *  a wrong community or a blocked UDP 161 is caught here, next to the field that
   *  caused it, instead of becoming a device that sits Offline with no explanation.
   *  Runs the same SNMP/ICMP code the poller runs — see backend services/deviceProbe.js.
   *
   *  A blank `community` is passed through as blank and means "verify ICMP", because
   *  that is what a blank community registers. */
  testNetworkDevice: async (payload: {
    ip: string;
    community?: string;
    snmpPort?: number | string | undefined;
  }): Promise<ApiResult<ProbeResult>> => {
    try {
      const res = await apiClient.post("/network/test", payload);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  deleteNetworkDevice: async (id: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.delete(`/network/${id}`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  setNetworkInterfaceLabel: async (
    id: number,
    interfaceName: string,
    locationLabel: string,
  ): Promise<ApiResult> => {
    try {
      const res = await apiClient.patch(`/network/${id}/interfaces`, { interfaceName, locationLabel });
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  addUpsDevice: async (payload: {
    name: string;
    ip: string;
    community: string;
    snmpPort?: number | string | undefined;
    location?: string | undefined;
    brand?: string | undefined;
    model?: string | undefined;
    batteryCapacity?: string | undefined;
    commType?: string | undefined;
    serialNumber?: string | undefined;
  }): Promise<ApiResult> => {
    try {
      const res = await apiClient.post("/ups", payload);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  /** Probe an address BEFORE registering it as a UPS. Persists nothing.
   *
   *  Stricter than the router probe by design: an address that answers ping, or answers
   *  SNMP without implementing UPS-MIB, FAILS here even though the identical result
   *  passes on the Add router form. A UPS has no ping-only mode — a reply to ping only
   *  proves its management card has power. */
  testUpsDevice: async (payload: {
    ip: string;
    community?: string;
    snmpPort?: number | string | undefined;
  }): Promise<ApiResult<ProbeResult>> => {
    try {
      const res = await apiClient.post("/ups/test", payload);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  deleteUpsDevice: async (id: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.delete(`/ups/${id}`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  getUpsLogs: async (id: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.get(`/ups/${id}/logs`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // MikroTik monitoring — campus router via the RouterOS API (per-port = per-building)
  getMikrotikDevices: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/mikrotik");
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // admin: register a new MikroTik (needs the device_type ENUM migration applied)
  addMikrotik: async (body: {
    name: string;
    ip?: string;
    location?: string;
    apiPort?: number;
    useTls?: boolean;
    apiUsername?: string;
    apiPassword?: string;
  }): Promise<ApiResult> => {
    try {
      const res = await apiClient.post("/mikrotik", body);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  getMikrotikInterfaces: async (id: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.get(`/mikrotik/${id}/interfaces`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // `monitored: false` silences interface-down alerts for that port. Omit the field
  // to leave the current setting untouched.
  saveMikrotikInterfaces: async (
    id: number,
    labels: { name: string; label: string; monitored?: boolean }[],
  ): Promise<ApiResult> => {
    try {
      const res = await apiClient.put(`/mikrotik/${id}/interfaces`, { labels });
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  deleteMikrotik: async (id: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.delete(`/mikrotik/${id}`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // `iface` omitted → device totals; supplied → that single port's throughput.
  // Either a preset range ("-1h" | "-6h" | "-24h" | "-7d" | "-30d") OR an absolute
  // window via { start, stop } ISO strings — the same contract as getNetworkHistory,
  // since both endpoints are served by networkHistoryHandler.
  getMikrotikHistory: async (
    id: number,
    range: string,
    iface?: string,
    window?: { start: string; stop: string },
  ): Promise<ApiResult> => {
    try {
      const params: Record<string, string> = window ? { ...window } : { range };
      if (iface) params.interface = iface;
      const res = await apiClient.get(`/mikrotik/${id}/history`, { params });
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  getMikrotikLogs: async (id: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.get(`/mikrotik/${id}/logs`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // admin: set the RouterOS API connection (password is encrypted server-side)
  saveMikrotikConnection: async (
    id: number,
    body: { apiPort?: number; useTls?: boolean; apiUsername?: string; apiPassword?: string },
  ): Promise<ApiResult> => {
    try {
      const res = await apiClient.put(`/mikrotik/${id}/connection`, body);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // id === null → ad-hoc test of credentials that haven't been saved yet (Add form).
  // With an id, `body` overrides the stored values; omit it to test what's saved.
  testMikrotik: async (
    id: number | null,
    body?: { ip?: string; apiPort?: number; useTls?: boolean; apiUsername?: string; apiPassword?: string },
  ): Promise<ApiResult> => {
    try {
      const url = id == null ? "/mikrotik/test" : `/mikrotik/${id}/test`;
      const res = await apiClient.post(url, body ?? {});
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Per-day environment summary measured from InfluxDB (temperature avg/max/min,
  // humidity avg, peak gas, environment-alert count). Replaces getEnvHistory, which
  // hit a mock endpoint returning random values and had no callers.
  getEnvironmentDaily: async (days: number = 7): Promise<ApiResult> => {
    try {
      const res = await apiClient.get(`/environment/daily?days=${days}`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Unified activity/audit history (system_logs + aircon_logs + alerts + device_logs)
  // with actor accountability (admin | staff | system). Returns { events, total,
  // page, pageSize, days, summary }.
  getHistory: async (params: {
    days?: number;
    start?: string;
    end?: string;
    category?: string;
    severity?: string;
    actorType?: string | undefined;
    userId?: number | "all" | undefined;
    search?: string;
    page?: number;
    pageSize?: number;
  } = {}): Promise<ApiResult> => {
    try {
      const qs = new URLSearchParams();
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== "" && v !== "all") qs.append(k, String(v));
      });
      const res = await apiClient.get(`/history?${qs.toString()}`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Users who appear in the history (for the per-user filter). Returns { actors: [...] }.
  getHistoryActors: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/history/actors");
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Aircon
  getAircon: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/aircon");
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // ── PiP widget layout (per-user) ──
  getWidgetLayout: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/widget-layout");
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  saveWidgetLayout: async (tiles: string[]): Promise<ApiResult> => {
    try {
      const res = await apiClient.put("/widget-layout", { tiles });
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  addAircon: async (name: string, ir_channel: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.post("/aircon", { name, ir_channel });
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  deleteAircon: async (id: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.delete(`/aircon/${id}`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  toggleAircon: async (id: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.patch(`/aircon/${id}/toggle`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  renameAircon: async (id: number, name: string): Promise<ApiResult> => {
    try {
      const res = await apiClient.patch(`/aircon/${id}/name`, { name });
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Auto-cooling IR zone thresholds (when IR fires). GET both roles; PUT admin-only.
  getAirconIRConfig: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/aircon/ir-config");
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  saveAirconIRConfig: async (cfg: {
    coldBelow: number; normalMax: number; acceptableMax: number; nearCritMax: number;
  }): Promise<ApiResult> => {
    try {
      const res = await apiClient.put("/aircon/ir-config", cfg);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Alerts — shared incident list + lifecycle (acknowledge / resolve). Admin + IT staff.
  getAlerts: async (status?: string): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/alerts", status ? { params: { status } } : undefined);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  getOpenAlertCount: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/alerts/count");
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  acknowledgeAlert: async (id: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.post(`/alerts/${id}/acknowledge`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  resolveAlert: async (id: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.post(`/alerts/${id}/resolve`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Notifications — the per-user bell feed.
  getNotifications: async (limit?: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/notifications", limit ? { params: { limit } } : undefined);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  markNotificationsRead: async (ids: number[]): Promise<ApiResult> => {
    try {
      const res = await apiClient.post("/notifications/read", { ids });
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  markAllNotificationsRead: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.post("/notifications/read", { all: true });
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  dismissNotifications: async (ids: number[]): Promise<ApiResult> => {
    try {
      const res = await apiClient.post("/notifications/clear", { ids });
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  clearAllNotifications: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.post("/notifications/clear", { all: true });
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  getNotificationPrefs: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/notifications/prefs");
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  saveNotificationPrefs: async (prefs: {
    emailEnabled?: boolean;
    popupEnabled?: boolean;
    minEmailSeverity?: string;
  }): Promise<ApiResult> => {
    try {
      const res = await apiClient.put("/notifications/prefs", prefs);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Reports
  getReports: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/reports");
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Devices a report of this type can be scoped to (empty = campus-wide only).
  getReportScopeOptions: async (type: string): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/reports/scope-options", { params: { type } });
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Returns 202 with a `pending` report — the backend builds it in the background
  // and pushes the finished row over Socket.IO as `reportUpdated`.
  // `deviceId` scopes the report to one device; omit for campus-wide.
  // `paperSize` is per report (ICTU asked for it to be chosen, not fixed); omit to
  // take the admin's configured default.
  generateReport: async (opts: {
    type: string;
    title?: string;
    periodStart?: string;
    periodEnd?: string;
    deviceId?: number | string;   // a device_id, or "room" for the server room itself
    paperSize?: PaperSizeKey;
  }): Promise<ApiResult> => {
    try {
      const res = await apiClient.post("/reports", opts);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // ── Report template (ICTU letterhead + page size) ───────────────────────────
  // Read by both roles (the Generate modal needs the size options); every mutation
  // below is admin-only server-side.
  getReportTemplate: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/reports/template");
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  setReportPaperSize: async (paperSize: PaperSizeKey): Promise<ApiResult> => {
    try {
      const res = await apiClient.put("/reports/template/paper-size", { paperSize });
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Replaces the whole block — it is a short ordered list, and sending it entire is
  // simpler than diffing rows that have no ids.
  setReportSignatories: async (signatories: Signatory[]): Promise<ApiResult> => {
    try {
      const res = await apiClient.put("/reports/template/signatories", { signatories });
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Blank restores the default, which is how an admin undoes a change without
  // having to retype the original wording.
  setReportUnitName: async (unitName: string): Promise<ApiResult> => {
    try {
      const res = await apiClient.put("/reports/template/unit-name", { unitName });
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Sends the file's RAW bytes, not multipart and not base64 — the backend reads the
  // body with express.raw and identifies the image by its leading bytes. The declared
  // Content-Type only decides whether the body is parsed at all, so it is taken from
  // the File and re-checked server-side.
  uploadReportLogo: async (slot: "cspc" | "ictu", file: File): Promise<ApiResult> => {
    try {
      const type = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
      const res = await apiClient.post(`/reports/template/logo/${slot}`, file, {
        headers: {
          "Content-Type": type,
          // The body is the raw image, so the name it was uploaded under travels
          // separately. Encoded because HTTP headers are Latin-1 and a filename can
          // hold anything; the server decodes and sanitises it.
          "X-Logo-Filename": encodeURIComponent(file.name),
        },
      });
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  clearReportLogo: async (slot: "cspc" | "ictu"): Promise<ApiResult> => {
    try {
      const res = await apiClient.delete(`/reports/template/logo/${slot}`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Streams the stored CSV/PDF and triggers a browser download. `filename` is
  // supplied by the caller (built from the report title + period) — the backend's
  // Content-Disposition name isn't readable cross-origin, so we don't rely on it.
  downloadReport: async (
    id: number | string,
    format: "csv" | "pdf",
    filename?: string,
  ): Promise<ApiResult> => {
    try {
      const res = await apiClient.get(`/reports/${id}/download`, {
        params: { format },
        responseType: "blob",
      });
      const cd = String(res.headers["content-disposition"] || "");
      const match = /filename="?([^"]+)"?/.exec(cd);
      const name = filename || match?.[1] || `report-${id}.${format}`;
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      return { success: true };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Mails an already-generated report to the signed-in user as a PDF attachment.
  // Does not rebuild it — a saved report's numbers are frozen.
  emailReport: async (id: number | string): Promise<ApiResult> => {
    try {
      const res = await apiClient.post(`/reports/${id}/email`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  deleteReport: async (id: number | string): Promise<ApiResult> => {
    try {
      const res = await apiClient.delete(`/reports/${id}`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Alert rules — configurable thresholds (admin only). deviceId null = global default
  // that applies to every server / the room; a deviceId is a per-server override.
  // ── Predictive analytics (Phase 1) ──────────────────────────────────────────
  // Disk-full ETA per server (linear regression). days = lookback window.
  getDiskForecast: async (days?: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/analytics/forecast/disk", days ? { params: { days } } : undefined);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // UPS battery-degradation ETA (linear regression on runtime). days = lookback.
  getUpsBatteryForecast: async (days?: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/analytics/forecast/ups-battery", days ? { params: { days } } : undefined);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Link-saturation ETA per router interface (linear regression on utilization).
  getLinkSaturationForecast: async (days?: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/analytics/forecast/link-saturation", days ? { params: { days } } : undefined);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Alert analytics summary (MTTR, severity mix, noisiest devices/types).
  getAlertSummary: async (days?: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/analytics/alerts/summary", days ? { params: { days } } : undefined);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // ── Predictive analytics (Phases 2–4) ───────────────────────────────────────
  // Trend + projection (seasonal Holt-Winters; EWMA is the displayed smooth line) for one metric.
  getMetricTrend: async (
    metric: string,
    opts: { deviceId?: number | null; hours?: number; horizon?: number } = {},
  ): Promise<ApiResult> => {
    try {
      const params: Record<string, unknown> = {};
      if (opts.deviceId != null) params.deviceId = opts.deviceId;
      if (opts.hours) params.hours = opts.hours;
      if (opts.horizon) params.horizon = opts.horizon;
      const res = await apiClient.get(`/analytics/trends/${metric}`, { params });
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Per-hour-of-day z-score anomalies (+ IQR fences) for one metric.
  getAnomalies: async (
    metric: string,
    opts: { deviceId?: number | null; days?: number; z?: number } = {},
  ): Promise<ApiResult> => {
    try {
      const params: Record<string, unknown> = { metric };
      if (opts.deviceId != null) params.deviceId = opts.deviceId;
      if (opts.days) params.days = opts.days;
      if (opts.z) params.z = opts.z;
      const res = await apiClient.get("/analytics/anomalies", { params });
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Suggested alert-rule thresholds (percentiles) vs current global rules.
  // deviceId narrows the suggestion to one server instead of pooling the whole fleet.
  getRecommendations: async (days?: number, deviceId?: number | null): Promise<ApiResult> => {
    try {
      const params: Record<string, string | number> = {};
      if (days) params.days = days;
      if (deviceId != null) params.deviceId = deviceId;
      const res = await apiClient.get("/analytics/recommendations", { params });
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Rolling-origin backtest — how far off past forecasts actually were, measured against
  // what the metric really did next. See predictive-analytics.md §17.
  getForecastAccuracy: async (
    metric: string,
    opts?: { deviceId?: number | null; days?: number; horizon?: number },
  ): Promise<ApiResult> => {
    try {
      const params: Record<string, string | number> = { metric };
      if (opts?.deviceId != null) params.deviceId = opts.deviceId;
      if (opts?.days) params.days = opts.days;
      if (opts?.horizon) params.horizon = opts.horizon;
      const res = await apiClient.get("/analytics/accuracy", { params });
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  getAlertRules: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/alert-rules");
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  createAlertRule: async (data: {
    deviceId?: number | null;
    metricName: string;
    thresholdValue: number;
    comparison: string;
    severity: string;
    isActive?: boolean;
  }): Promise<ApiResult> => {
    try {
      const res = await apiClient.post("/alert-rules", data);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  updateAlertRule: async (id: number, data: Record<string, unknown>): Promise<ApiResult> => {
    try {
      const res = await apiClient.put(`/alert-rules/${id}`, data);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  deleteAlertRule: async (id: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.delete(`/alert-rules/${id}`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

};