export type Role = "admin" | "it_staff";

export interface User {
  [key: string]: number | string;
  // id: number;
  // name: string;
  // username: string;
  // password: string;
  // role: Role;
  // avatar: string;
  // email: string;
}

export interface RoleConfig {
  label: string;
  color: string;
  bg: string;
  border: string;
  pages: string[];
}

// Role definitions — what each role can access
export const roleConfig: Record<Role, RoleConfig> = {
  admin: {
    label: "Admin",
    color: "text-yellow-400",
    bg: "bg-yellow-500/10",
    border: "border-yellow-500/30",
    pages: [
      "dashboard",
      "server-metrics",
      "environment",
      "air-conditioner",
      "alerts",
      "analytics",
      "history",
      "reports",
      "settings",
      "user-management",
      "alert-rules",
    ],
  },
  it_staff: {
    label: "IT Staff",
    color: "text-blue-400",
    bg: "bg-blue-500/10",
    border: "border-blue-500/30",
    pages: [
      "dashboard",
      "server-metrics",
      "environment",
      "air-conditioner",
      "alerts",
      "analytics",
      "history",
      "reports",
      "settings",
    ],
  }
};
