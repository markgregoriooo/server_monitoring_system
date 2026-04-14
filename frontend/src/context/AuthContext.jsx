import { createContext, useContext, useMemo, useState, useCallback } from "react";
import { api } from "../api/api";

// create context / create global auth storge
const AuthContext = createContext(null);

//  provider(gives auth to the whole app) 
export function AuthProvider({ children }) {
  // user
  const [user, setUser] = useState(() => {
    try {
      const saved = sessionStorage.getItem("cspc_user");
      return saved ? JSON.parse(saved) : null;
    } catch { return null; }
  });
  // login
  const login = useCallback(async (username, password) => {
    try {

       const data = await api.login(username, password);
      
      sessionStorage.setItem("cspc_token", JSON.stringify(data.token));
      sessionStorage.setItem("cspc_user",  JSON.stringify(data.user));

      setUser(data.user);
      return { success: true, user: data.user };
      
    } catch {
      return { success: false, error: "Cannot connect to server. Make sure the backend is running." };
    }
  }, []);
  
  // logout
  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch { /* ignore */ }
    
    setUser(null);
    sessionStorage.removeItem("cspc_user");
    sessionStorage.removeItem("cspc_token");
  }, []);

  // remove unnecessary re-renders
  const value = useMemo (() =>{
    return {user, login, logout};
  }, [user]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}
// access auth anywhere
export function useAuth() {
  return useContext(AuthContext);
}
