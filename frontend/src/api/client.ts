import axios from "axios";
import type {
  AxiosInstance,
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

export default apiClient;
