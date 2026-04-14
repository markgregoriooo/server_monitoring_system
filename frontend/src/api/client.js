import axios from "axios";

const baseURL = "http://192.168.100.9:3000/api";

function getToken() {
  try {
    return JSON.parse(sessionStorage.getItem("cspc_token") || "null");
  } catch {
    return null;
  }
}

const apiClient = axios.create({
  baseURL: baseURL,
  headers: {
    "Content-Type": "application/json",
  },
});

// Attach token automatically
apiClient.interceptors.request.use((config) => {
  const token = getToken();

  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  return config;
});

// Global error handler
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    const message =
      error.response?.data?.error ||
      error.response?.data?.message ||
      "Request failed";

    return Promise.reject(new Error(message));
  }
);

export default apiClient;
