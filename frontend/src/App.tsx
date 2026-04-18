import { useState } from "react";
import "./index.css";
import {
  Routes,
  Route,
  Navigate,
  useLocation,
} from "react-router-dom";

import { AuthProvider, useAuth } from "./context/AuthContext.js";
import { roleConfig } from "./data/users.js";

import Login from "./pages/auth/Login.js";
import Unauthorized from "./pages/auth/Unauthorized.js";
import Sidebar from "./components/layout/Sidebar.js";
import Header from "./components/layout/Header.js";
import Dashboard from "./pages/Dashboard.js";
import ServerMetrics from "./pages/ServerMetrics.js";
import Environment from "./pages/Environment.js";
import AirControl from "./pages/AirControl.js";
import History from "./pages/History.js";
import Reports from "./pages/Reports.js";
import Settings from "./pages/Settings.js";
import UserManagement from "./pages/UserManagement.js";

const pageTitles: Record<string, string> = {
  "/": "Server Environment Monitoring & Control System",
  "/server-metrics": "Server Metrics",
  "/environment": "Environment Monitoring",
  "/air-control": "Air Conditioner Control",
  "/history": "History Logs",
  "/reports": "Reports",
  "/settings": "Settings",
  "/user-management": "User Management",
};

interface ProtectedRouteProps {
  children: React.ReactNode;
}

function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user } = useAuth();
  const location = useLocation();

  const allowed: string[] = roleConfig[user?.role as keyof typeof roleConfig]?.pages || [];
  const currentPage =
    location.pathname === "/" ? "dashboard" : location.pathname.replace("/", "");

  if (!allowed.includes(currentPage)) {
    return <Unauthorized />;
  }

  return children;
}

function AppShell() {
  const { user } = useAuth();
  const [mobileOpen, setMobileOpen] = useState<boolean>(false);
  const location = useLocation();
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
    <div className="flex h-screen overflow-hidden bg-[#080f1e] font-sans">

      <Sidebar
        mobileOpen={mobileOpen}
        onClose={() => setMobileOpen(false)}
      />

      <div className="flex-1 flex flex-col overflow-hidden min-w-0">

        <Header
          title={pageTitles[location.pathname] || "Dashboard"}
          alertCount={2}
          onMenuToggle={() => setMobileOpen(p => !p)}
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

            <Route path="/air-control" element={
              <ProtectedRoute>
                <AirControl />
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

            {/* fallback */}
            <Route path="*" element={<Navigate to="/" />} />

          </Routes>
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}