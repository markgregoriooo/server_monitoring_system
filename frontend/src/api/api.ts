import apiClient from "./client.js";

interface User {
  [key: string]: number | string;
}

interface LoginResponse {
  token: string;
  user: User;
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
  // Auth
  login: async (username: string, password: string): Promise<ApiResult<LoginResponse>> => {
    try {
      const res = await apiClient.post<LoginResponse>("/auth/login", { username, password });
      return { success: true, data: res.data };
    } catch (err: any) {
      const status = err?.response?.status;
      return {
        success: false,
        status,
        error:
          err?.response?.data?.error
      };
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

  // Servers
  getServers: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/servers");
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

  toggleAircon: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.post("/aircon/toggle");
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  setAirconMode: async (mode: string): Promise<ApiResult> => {
    try {
      const res = await apiClient.post("/aircon/mode", { mode });
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  setAirconTemp: async (temp: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.post("/aircon/temp", { temp });
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  // Alerts
  getAlerts: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/alerts");
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },

  getAuditLog: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/alerts/audit");
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

  deleteUser: async (id: number): Promise<ApiResult> => {
    try {
      const res = await apiClient.delete(`/users/${id}`);
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },
};