// Mock users — simulates a MySQL users table
// Roles: super_admin | it_staff | viewer

export const mockUsers = [
  {
    id: 1,
    name: "Super Admin",
    username: "superadmin",
    password: "admin123",
    role: "super_admin",
    avatar: "SA",
    email: "superadmin@cspc.edu.ph",
  },
  {
    id: 2,
    name: "IT Staff",
    username: "itstaff",
    password: "staff123",
    role: "it_staff",
    avatar: "IS",
    email: "itstaff@cspc.edu.ph",
  },
  {
    id: 3,
    name: "Viewer",
    username: "viewer",
    password: "viewer123",
    role: "viewer",
    avatar: "VW",
    email: "viewer@cspc.edu.ph",
  },
];

// Role definitions — what each role can access
export const roleConfig = {
  super_admin: {
    label: "Super Admin",
    color: "text-yellow-400",
    bg: "bg-yellow-500/10",
    border: "border-yellow-500/30",
    pages: ["dashboard", "server-metrics", "environment", "air-control", "history", "reports", "settings", "user-management"],
  },
  it_staff: {
    label: "IT Staff",
    color: "text-blue-400",
    bg: "bg-blue-500/10",
    border: "border-blue-500/30",
    pages: ["dashboard", "server-metrics", "environment", "air-control", "history", "reports"],
  },
  viewer: {
    label: "Viewer",
    color: "text-slate-300",
    bg: "bg-slate-500/10",
    border: "border-slate-500/30",
    pages: ["dashboard", "environment", "history"],
  },
};
