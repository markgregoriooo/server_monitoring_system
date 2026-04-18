import apiClient from "./client.js";

interface LoginResponse {
  token: string;
  user: any;
}

interface ApiResponse<T = any> {
  data: T;
}

export const api = {
  // Auth
  login: (username: string, password: string) =>
    apiClient
      .post("/auth/login", { username, password })
      .then((res: ApiResponse<LoginResponse>) => res.data),

  me: () =>
    apiClient.get("/auth/me").then((res: ApiResponse<any>) => res.data),

  logout: () =>
    apiClient.post("/auth/logout").then((res: ApiResponse<any>) => res.data),

  // Servers
  getServers: () =>
    apiClient.get("/servers").then((res: ApiResponse<any>) => res.data),

  // Environment
  getLive: () =>
    apiClient.get("/environment/live").then((res: ApiResponse<any>) => res.data),

  getEnvHistory: (count: number = 20) =>
    apiClient
      .get(`/environment/history?count=${count}`)
      .then((res: ApiResponse<any>) => res.data),

  getHistoryLogs: () =>
    apiClient.get("/environment/logs").then((res: ApiResponse<any>) => res.data),

  // Aircon
  getAircon: () =>
    apiClient.get("/aircon").then((res: ApiResponse<any>) => res.data),

  toggleAircon: () =>
    apiClient.post("/aircon/toggle").then((res: ApiResponse<any>) => res.data),

  setAirconMode: (mode: string) =>
    apiClient.post("/aircon/mode", { mode }).then((res: ApiResponse<any>) => res.data),

  setAirconTemp: (temp: number) =>
    apiClient.post("/aircon/temp", { temp }).then((res: ApiResponse<any>) => res.data),

  // Alerts
  getAlerts: () =>
    apiClient.get("/alerts").then((res: ApiResponse<any>) => res.data),

  getAuditLog: () =>
    apiClient.get("/alerts/audit").then((res: ApiResponse<any>) => res.data),

  // Reports
  getReports: () =>
    apiClient.get("/reports").then((res: ApiResponse<any>) => res.data),

  generateReport: (title: string, type: string) =>
    apiClient.post("/reports", { title, type }).then((res: ApiResponse<any>) => res.data),

  // Users (super_admin only)
  getUsers: () =>
    apiClient.get("/users").then((res: ApiResponse<any>) => res.data),

  createUser: (data: any) =>
    apiClient.post("/users", data).then((res: ApiResponse<any>) => res.data),

  deleteUser: (id: number) =>
    apiClient.delete(`/users/${id}`).then((res: ApiResponse<any>) => res.data),
};
