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

// Mock users — simulates a MySQL users table
// export const mockUsers: User[] = [
//   {
//     id: 1,
//     name: "Admin",
//     username: "admin",
//     password: "admin123",
//     role: "admin",
//     avatar: "SA",
//     email: "admin@cspc.edu.ph",
//   },
//   {
//     id: 2,
//     name: "Staff",
//     username: "staff",
//     password: "staff123",
//     role: "it_staff",
//     avatar: "IS",
//     email: "staff@cspc.edu.ph",
//   },
// ];

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
      "history",
      "reports",
      "settings",
      "user-management",
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
      "history",
      "reports",
    ],
  }
};
