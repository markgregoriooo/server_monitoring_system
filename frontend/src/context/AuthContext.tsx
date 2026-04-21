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

// create context / create global auth storage
const AuthContext = createContext<AuthContextType | null>(null);

// provider (gives auth to the whole app)
export function AuthProvider({ children }: { children: ReactNode }) {
  // user
  const [user, setUser] = useState<User | null>(() => {
    try {
      const saved = sessionStorage.getItem("cspc_user");
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  // login
  const login = useCallback(
    async (username: string, password: string) => {
      try {
        const data = await api.login(username, password);

        sessionStorage.setItem("cspc_token", JSON.stringify(data.token));
        sessionStorage.setItem("cspc_user", JSON.stringify(data.user));

        setUser(data.user);

        return { success: true, user: data.user };
      } catch {
        return {
          success: false,
          error:
            "Cannot connect to server. Make sure the backend is running.",
        };
      }
    },
    []
  );

  // logout
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

  // remove unnecessary re-renders
  const value = useMemo(() => {
    return { user, login, logout };
  }, [user, login, logout]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );

}

// access auth anywhere
export function useAuth() {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }

  return context;
}
