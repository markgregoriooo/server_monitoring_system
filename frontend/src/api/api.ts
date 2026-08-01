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

// error handler
const handleError = (err: any): ApiResult<never> => {
  const status = err?.response?.status;
  const serverMessage = err?.response?.data?.error;

  const fallback =
    status === 429 ? "Too many requests. Please wait." :
      status === 401 ? "Unauthorized. Please log in again." :
        status === 403 ? "You don't have permission to do that." :
          status === 404 ? "Resource not found." :
            status === 500 ? "Server error. Please try again later." :
              "Cannot connect to server.";

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

  // Users (super_admin only)
  getUsers: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/users");
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  createUser: async (data: any): Promise<ApiResult> => {
    try {
      const res = await apiClient.post("/users", data);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

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

    // update own name, username, email
  updateMe: async (data: FormData): Promise<ApiResult<LoginUser>> => {
    try {
      const res = await apiClient.patch("/users/me", data);
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


  // PATCH /api/users/me/password — change own password (requires current password)
  changePassword: async (currentPassword: string, newPassword: string): Promise<ApiResult> => {
    try {
      const res = await apiClient.patch("/users/me/password", {currentPassword,newPassword,});
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

  // Real metric history for one server (InfluxDB) — range: "-1h" | "-6h" | "-24h"
  getServerHistory: async (id: number, range: string): Promise<ApiResult> => {
    try {
      const res = await apiClient.get(`/servers/${id}/history`, { params: { range } });
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

  deleteServer: async (id: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.delete(`/servers/${id}`);
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

  getNetworkHistory: async (id: number, range: string): Promise<ApiResult> => {
    try {
      const res = await apiClient.get(`/network/${id}/history`, { params: { range } });
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

  // UPS monitoring — battery/load via SNMP (UPS-MIB / RFC 1628)
  getUpsDevices: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/ups");
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  getUpsHistory: async (id: number, range: string): Promise<ApiResult> => {
    try {
      const res = await apiClient.get(`/ups/${id}/history`, { params: { range } });
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

  saveMikrotikInterfaces: async (
    id: number,
    labels: { name: string; label: string }[],
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
  getMikrotikHistory: async (id: number, range: string, iface?: string): Promise<ApiResult> => {
    try {
      const params: Record<string, string> = { range };
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

  setAirconMode: async (id: number, mode: string): Promise<ApiResult> => {
    try {
      const res = await apiClient.patch(`/aircon/${id}/mode`, { mode });
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  setAirconTemp: async (id: number, temp: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.patch(`/aircon/${id}/temp`, { temp });
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

  generateReport: async (title: string, type: string): Promise<ApiResult> => {
    try {
      const res = await apiClient.post("/reports", { title, type });
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Alert rules — configurable thresholds (admin only). deviceId null = global default
  // that applies to every server / the room; a deviceId is a per-server override.
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