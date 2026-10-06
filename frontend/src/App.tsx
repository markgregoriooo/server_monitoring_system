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
import { LiveSummaryProvider } from "./pip/LiveSummaryContext";
import { WidgetLayoutProvider } from "./pip/useWidgetLayout";
import PipHost from "./pip/PipHost";
import { roleConfig } from "./data/users";
import { useDocumentTitle } from "./hooks/useDocumentTitle";
import { useScrollMemory } from "./hooks/useScrollMemory";

import Login from "./pages/auth/Login";
import Unauthorized from "./pages/auth/Unauthorized";
import PrivacyTerms from "./pages/legal/PrivacyTerms";
import PolicyGate from "./components/legal/PolicyGate";
import Sidebar from "./components/layout/Sidebar";
import Header from "./components/layout/Header";
import ToastHost from "./components/notifications/ToastHost";
import CriticalAlertModal from "./components/notifications/CriticalAlertModal";
import { primeAlarm } from "./utils/criticalAlarm";
import IdleLogoutModal from "./components/session/IdleLogoutModal";
import Dashboard from "./pages/Dashboard";
import ServerMetrics from "./pages/ServerMetrics";
import NetworkMonitoring from "./pages/NetworkMonitoring";
import MikrotikMonitoring from "./pages/MikrotikMonitoring";
import UpsMonitoring from "./pages/UpsMonitoring";
import Environment from "./pages/Environment";
import AirConditioner from "./pages/AirConditioner";
import History from "./pages/History";
import Reports from "./pages/Reports";
import Backups from "./pages/Backups";
import Settings from "./pages/Settings";
import UserManagement from "./pages/UserManagement";
import AlertRules from "./pages/AlertRules";
import Alerts from "./pages/Alerts";
import Analytics from "./pages/Analytics";
import ErrorBoundary from "./components/ErrorBoundary";

const pageTitles: Record<string, string> = {
  "/": "Server Infrastructure Monitoring System",
  "/server-metrics": "Server Metrics",
  "/network": "Network Monitoring",
  "/mikrotik": "MikroTik Network",
  "/ups": "UPS Monitoring",
  "/environment": "Environment Monitoring",
  "/air-conditioner": "Air Conditioner Control",
  "/history": "History Logs",
  "/reports": "Reports",
  "/settings": "Settings",
  "/user-management": "User Management",
  "/alert-rules": "Alert Rules",
  "/backups": "Backups",
  "/alerts": "Alerts",
  "/analytics": "Predictive Analytics",
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
  const { user, idleLogout, confirmIdleLogout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState<boolean>(false);
  /* Header avatar -> Sidebar's My Profile modal. A counter rather than a boolean, so each
     click opens it again without resetting anything first. The modal stays in the Sidebar. */
  const [profileSignal, setProfileSignal] = useState(0);
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

  // Sets the browser tab title. Mounted here because /login and /privacy return early
  // below and would otherwise keep the previous page's title.
  useDocumentTitle();

  /* Restores each route's scroll position. Mounted here for the same reason as the title:
     /login and /privacy return early, and they are the pages that scroll the document. */
  useScrollMemory();

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
  // The Privacy Notice is public: it must be readable before signing in, so it is checked
  // before the redirect below.
  const isPolicyPage = location.pathname === "/privacy";

  if (isPolicyPage) {
    return (
      <Routes>
        <Route path="/privacy" element={<PrivacyTerms />} />
      </Routes>
    );
  }

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

  // Signed in but has not accepted the current Privacy Notice version: show only the gate
  // (no sidebar, routes or live pages). `policy_current` comes from the server, so bumping
  // the version asks everyone again. If the field is missing (an old cached session),
  // don't block; the next sign-in provides it.
  if (user?.policy_current && user.policy_version !== user.policy_current) {
    return <PolicyGate />;
  }

  return (
    <div className="flex h-screen overflow-hidden" style={{ backgroundColor: 'var(--gf-bg)', fontFamily: "'JetBrains Mono', monospace" }}>

      <Sidebar
        mobileOpen={mobileOpen}
        onClose={() => setMobileOpen(false)}
        collapsed={collapsed}
        onToggleCollapse={toggleCollapsed}
        openProfileSignal={profileSignal}
      />

      <div className="flex-1 flex flex-col overflow-hidden min-w-0">

        <Header
          title={pageTitles[location.pathname] || "Dashboard"}
          onMenuToggle={() => setMobileOpen(p => !p)}
          collapsed={collapsed}
          onToggleCollapse={toggleCollapsed}
          onOpenProfile={() => setProfileSignal((n) => n + 1)}
        />

        {/* This is the scroll container (the shell is `h-screen overflow-hidden`). Lock it while
           the mobile drawer is open. `lg:` so widening to desktop with the drawer still set
           cannot leave the page unscrollable. */}
        <main
          className={`flex-1 ${
            mobileOpen ? "overflow-hidden lg:overflow-y-auto" : "overflow-y-auto"
          }`}
        >
          {/* Keyed on the path so moving to another page clears a caught error. Inside <main> so
             the sidebar and header keep working. */}
          <ErrorBoundary key={location.pathname} label={location.pathname}>
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

            <Route path="/network" element={
              <ProtectedRoute>
                <NetworkMonitoring />
              </ProtectedRoute>
            } />

            <Route path="/mikrotik" element={
              <ProtectedRoute>
                <MikrotikMonitoring />
              </ProtectedRoute>
            } />

            <Route path="/ups" element={
              <ProtectedRoute>
                <UpsMonitoring />
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

            <Route path="/analytics" element={
              <ProtectedRoute>
                <Analytics />
              </ProtectedRoute>
            } />

            <Route path="/alert-rules" element={
              <ProtectedRoute>
                <AlertRules />
              </ProtectedRoute>
            } />

            <Route path="/backups" element={
              <ProtectedRoute>
                <Backups />
              </ProtectedRoute>
            } />

            {/* fallback */}
            <Route path="*" element={<Navigate to="/" />} />

          </Routes>
          </ErrorBoundary>
        </main>
      </div>

      {/* Live notification toasts — overlay, independent of the current route */}
      <ToastHost />

      {/* Critical alert takeover: blocking, centred, with sound. Warnings and info stay as
         toasts in the corner. Mounted here so it covers every page. */}
      <CriticalAlertModal />

      {/* Idle timeout notice: the session has already ended; OK finishes the sign-out. */}
      {idleLogout && <IdleLogoutModal onConfirm={confirmIdleLogout} />}

      {/* Picture-in-Picture live widget — portals into its own window when open */}
      <PipHost />
    </div>
  );
}

export default function App() {
  /* Unlock audio on the first click or keypress (usually the sign-in click). Browsers keep
     audio suspended until a user gesture, so doing it early makes the critical alarm audible. */
  useEffect(() => { primeAlarm(); }, []);

  return (
    <AuthProvider>
      <NotificationProvider>
        <LiveSummaryProvider>
          <WidgetLayoutProvider>
            <PipProvider>
              <AppShell />
            </PipProvider>
          </WidgetLayoutProvider>
        </LiveSummaryProvider>
      </NotificationProvider>
    </AuthProvider>
  );
}