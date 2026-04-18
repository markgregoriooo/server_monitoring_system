import axios from "axios";
import type {
  AxiosInstance,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";

const baseURL = "http://192.168.100.9:3000/api";

function getToken(): string | null {
  try {
    return JSON.parse(sessionStorage.getItem("cspc_token") || "null");
  } catch {
    return null;
  }
}

const apiClient: AxiosInstance = axios.create({
  baseURL,
  headers: {
    "Content-Type": "application/json",
  },
});

// Attach token automatically
apiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = getToken();

    if (token) {
      config.headers.set("Authorization", `Bearer ${token}`);
    }

    return config;
  }
);

// Global error handler
apiClient.interceptors.response.use(
  (response: AxiosResponse) => response,
  (error: any) => {
    const message =
      error.response?.data?.error ||
      error.response?.data?.message ||
      "Request failed";

    return Promise.reject(new Error(message));
  }
);

export default apiClient;
