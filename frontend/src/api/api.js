import apiClient from "./client";

export const api = {
  // Auth
  login: (username, password) =>
    apiClient.post("/auth/login", { username, password }).then(res => res.data),

  me: () =>
    apiClient.get("/auth/me").then(res => res.data),

  logout: () =>
    apiClient.post("/auth/logout").then(res => res.data),

  // Servers
  getServers: () =>
    apiClient.get("/servers").then(res => res.data),

  // Environment
  getLive: () =>
    apiClient.get("/environment/live").then(res => res.data),

  getEnvHistory: (count = 20) =>
    apiClient.get(`/environment/history?count=${count}`).then(res => res.data),

  getHistoryLogs: () =>
    apiClient.get("/environment/logs").then(res => res.data),

  // Aircon
  getAircon: () =>
    apiClient.get("/aircon").then(res => res.data),

  toggleAircon: () =>
    apiClient.post("/aircon/toggle").then(res => res.data),

  setAirconMode: (mode) =>
    apiClient.post("/aircon/mode", { mode }).then(res => res.data),

  setAirconTemp: (temp) =>
    apiClient.post("/aircon/temp", { temp }).then(res => res.data),

  // Alerts
  getAlerts: () =>
    apiClient.get("/alerts").then(res => res.data),

  getAuditLog: () =>
    apiClient.get("/alerts/audit").then(res => res.data),

  // Reports
  getReports: () =>
    apiClient.get("/reports").then(res => res.data),

  generateReport: (title, type) =>
    apiClient.post("/reports", { title, type }).then(res => res.data),

  // Users (super_admin only)
  getUsers: () =>
    apiClient.get("/users").then(res => res.data),

  createUser: (data) =>
    apiClient.post("/users", data).then(res => res.data),

  deleteUser: (id) =>
    apiClient.delete(`/users/${id}`).then(res => res.data),
};
