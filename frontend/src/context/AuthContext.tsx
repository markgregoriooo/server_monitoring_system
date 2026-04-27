import { createContext, useContext, useMemo, useState, useCallback } from "react";
import type { ReactNode } from "react";
import { api } from "../api/api.js";

interface User {
  [key: string]: number | string;
}

interface AuthContextType {
  user: User | null;
  login: (username: string, password: string) => Promise<{
    success: boolean;
    user?: User;
    error?: string;
  }>;
  logout: () => Promise<void>;
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

  const login = useCallback(async (username: string, password: string) => {
    const result = await api.login(username, password);

    // api.login never throws — check success flag instead
    if (!result.success || !result.data) {
      return {
        success: false,
        error: result.error ?? "Login failed.",
      };
    }

    const { token, user } = result.data; // ✅ data is LoginResponse here

    sessionStorage.setItem("cspc_token", JSON.stringify(token));
    sessionStorage.setItem("cspc_user", JSON.stringify(user));
    setUser(user as User);

    return { success: true, user: user as User };
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* ignore */
    }

    setUser(null);
    sessionStorage.removeItem("cspc_user");
    sessionStorage.removeItem("cspc_token");
  }, []);

  const value = useMemo(() => ({ user, login, logout }), [user, login, logout]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}