import { useState, useEffect, useCallback } from "react";
import "./index.css";
import {
  Routes,
  Route,
  Navigate,
  useLocation,
  useNavigate,
} from "react-router-dom";

import { AuthProvider, useAuth } from "./context/AuthContext";
import { NotificationProvider } from "./context/NotificationContext";
import { PipProvider } from "./pip/PipContext";
import PipHost from "./pip/PipHost";
import { roleConfig } from "./data/users";

import Login from "./pages/auth/Login";
import Unauthorized from "./pages/auth/Unauthorized";
import Sidebar from "./components/layout/Sidebar";
import Header from "./components/layout/Header";
import ToastHost from "./components/notifications/ToastHost";
import Dashboard from "./pages/Dashboard";
import ServerMetrics from "./pages/ServerMetrics";
import Environment from "./pages/Environment";
import AirConditioner from "./pages/AirConditioner";
import History from "./pages/History";
import Reports from "./pages/Reports";
import Settings from "./pages/Settings";
import UserManagement from "./pages/UserManagement";
import AlertRules from "./pages/AlertRules";
import Alerts from "./pages/Alerts";

const pageTitles: Record<string, string> = {
  "/": "Server Environment Monitoring & Control System",
  "/server-metrics": "Server Metrics",
  "/environment": "Environment Monitoring",
  "/air-conditioner": "Air Conditioner Control",
  "/history": "History Logs",
  "/reports": "Reports",
  "/settings": "Settings",
  "/user-management": "User Management",
  "/alert-rules": "Alert Rules",
  "/alerts": "Alerts",
};

interface ProtectedRouteProps {
  children: React.ReactNode;
}

function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const allowed: string[] = roleConfig[user?.role as keyof typeof roleConfig]?.pages || [];
  const currentPage = location.pathname === "/" ? "dashboard" : location.pathname.replace("/", "");

  if (!allowed.includes(currentPage)) {
    return <Unauthorized onBack={() => navigate("/")} />;
  }

  return children;
}

function AppShell() {
  const { user } = useAuth();
  const [mobileOpen, setMobileOpen] = useState<boolean>(false);
  const [collapsed, setCollapsed] = useState<boolean>(
    () => localStorage.getItem("cspc_sidebar_collapsed") === "1",
  );
  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem("cspc_sidebar_collapsed", next ? "1" : "0");
      return next;
    });
  }, []);
  const location = useLocation();

  // Ctrl/Cmd + B toggles the sidebar (like a code editor)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleCollapsed();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleCollapsed]);
  const isLoginPage = location.pathname === "/login";

  if (!user && !isLoginPage) {
    return <Navigate to="/login" />;
  }

  if (isLoginPage) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
      </Routes>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden" style={{ backgroundColor: 'var(--gf-bg)', fontFamily: "'JetBrains Mono', monospace" }}>

      <Sidebar
        mobileOpen={mobileOpen}
        onClose={() => setMobileOpen(false)}
        collapsed={collapsed}
        onToggleCollapse={toggleCollapsed}
      />

      <div className="flex-1 flex flex-col overflow-hidden min-w-0">

        <Header
          title={pageTitles[location.pathname] || "Dashboard"}
          onMenuToggle={() => setMobileOpen(p => !p)}
          collapsed={collapsed}
          onToggleCollapse={toggleCollapsed}
        />

        <main className="flex-1 overflow-y-auto">
          <Routes>
            <Route path="/" element={
              <ProtectedRoute>
                <Dashboard />
              </ProtectedRoute>
            } />

            <Route path="/server-metrics" element={
              <ProtectedRoute>
                <ServerMetrics />
              </ProtectedRoute>
            } />

            <Route path="/environment" element={
              <ProtectedRoute>
                <Environment />
              </ProtectedRoute>
            } />

            <Route path="/air-conditioner" element={
              <ProtectedRoute>
                <AirConditioner />
              </ProtectedRoute>
            } />

            <Route path="/history" element={
              <ProtectedRoute>
                <History />
              </ProtectedRoute>
            } />

            <Route path="/reports" element={
              <ProtectedRoute>
                <Reports />
              </ProtectedRoute>
            } />

            <Route path="/settings" element={
              <ProtectedRoute>
                <Settings />
              </ProtectedRoute>
            } />

            <Route path="/user-management" element={
              <ProtectedRoute>
                <UserManagement />
              </ProtectedRoute>
            } />

            <Route path="/alerts" element={
              <ProtectedRoute>
                <Alerts />
              </ProtectedRoute>
            } />

            <Route path="/alert-rules" element={
              <ProtectedRoute>
                <AlertRules />
              </ProtectedRoute>
            } />

            {/* fallback */}
            <Route path="*" element={<Navigate to="/" />} />

          </Routes>
        </main>
      </div>

      {/* Live notification toasts — overlay, independent of the current route */}
      <ToastHost />

      {/* Picture-in-Picture live widget — portals into its own window when open */}
      <PipHost />
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <NotificationProvider>
        <PipProvider>
          <AppShell />
        </PipProvider>
      </NotificationProvider>
    </AuthProvider>
  );
}