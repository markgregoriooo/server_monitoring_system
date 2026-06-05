import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useCallback,
} from "react";
import type { ReactNode } from "react";
import { api } from "../api/api.js";
import { socket } from "../socket/socket.js";

interface User {
  id: number;
  name: string;
  username: string;
  email: string;
  role: string;

    avatar?: string | undefined;
  profile_image?: string | undefined;
  status?: string | undefined;
  created_at?: string | undefined;
  last_login?: string | undefined;

  permissions: string[];
}

interface AuthContextType {
  user: User | null;
  login: (
    email: string,
    password: string,
  ) => Promise<{
    success: boolean;
    user?: User;
    error?: string;
  }>;
  logout: () => Promise<void>;
  updateUser: (data: Partial<User>) => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    try {
      const saved = sessionStorage.getItem("cspc_user");
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  // Keep the socket connection in sync with auth state. This also runs on mount,
  // so a session restored from sessionStorage after a page refresh reconnects the
  // socket (and resumes live sensor data) without needing to log out and back in.
  useEffect(() => {
    if (user) {
      if (!socket.connected) socket.connect();
    } else if (socket.connected) {
      socket.disconnect();
    }
  }, [user]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.login(email, password);

    // success flag instead
    if (!result.success || !result.data) {
      return {
        success: false,
        error: result.error ?? "Login failed.",
      };
    }

    const { token, user } = result.data;

    // normalize user to match AuthContext User type
    const safeUser: User = {
      id: Number(user.id),
      name: String(user.name ?? ""),
      username: String(user.username ?? ""),
      email: String(user.email ?? ""),
      role: String(user.role ?? ""),
      status: user.status ?? undefined,
      avatar: user.avatar ?? undefined,
      profile_image: user.profile_image ?? undefined,
      permissions: Array.isArray(user.permissions)
        ? user.permissions.map(String)
        : [],
      created_at: user.created_at ?? undefined,
      last_login: user.last_login ?? undefined,
    };

    sessionStorage.setItem("cspc_token", JSON.stringify(token));
    sessionStorage.setItem("cspc_user", JSON.stringify(safeUser));

    setUser(safeUser);
    socket.connect();

    return { success: true, user: safeUser };
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* ignore */
    }

    socket.disconnect();
    setUser(null);
    sessionStorage.removeItem("cspc_user");
    sessionStorage.removeItem("cspc_token");
  }, []);

  const updateUser = useCallback((data: Partial<User>) => {
    setUser((prev) => {
      if (!prev) return prev;

      // Only spread defined values — prevents undefined fields
      // from overwriting good existing state
      const patch = Object.fromEntries(
        Object.entries(data).filter(([, v]) => v !== undefined),
      ) as Partial<User>;

      const updated: User = {
        ...prev,
        ...patch,
      };

      sessionStorage.setItem("cspc_user", JSON.stringify(updated));
      return updated;
    });
  }, []);

  const value = useMemo(
    () => ({ user, login, logout, updateUser }),
    [user, login, logout, updateUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
