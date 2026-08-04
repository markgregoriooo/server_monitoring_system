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

  // `range` is a preset (-1h … -30d) OR an absolute window via { start, stop } ISO
  // strings — pass one or the other, `start` wins if both are sent. `iface` scopes
  // the chart to one port; omit for the device total.
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

  getNetworkLogs: async (id: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.get(`/network/${id}/logs`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Register a router/switch for SNMP monitoring (admin). Picked up by the poller
  // on its next cycle — no backend restart needed.
  addNetworkDevice: async (payload: {
    name: string;
    ip: string;
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

  deleteNetworkDevice: async (id: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.delete(`/network/${id}`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Name one of a router's discovered interfaces (admin), e.g. "ether3" →
  // "Uplink to admin building". The poller discovers the ports; this labels them.
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

  // UPS monitoring — battery/load via SNMP (UPS-MIB / RFC 1628)
  getUpsDevices: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/ups");
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Same contract as getNetworkHistory: a preset, or an absolute { start, stop }.
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

  getUpsLogs: async (id: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.get(`/ups/${id}/logs`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Register a UPS (with an SNMP/network card) for monitoring (admin). Picked up by
  // the poller on its next cycle — no backend restart needed.
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

  deleteUpsDevice: async (id: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.delete(`/ups/${id}`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  getEnvHistory: async (count: number = 20): Promise<ApiResult> => {
    try {
      const res = await apiClient.get(`/environment/history?count=${count}`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  getHistoryLogs: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/environment/logs");
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