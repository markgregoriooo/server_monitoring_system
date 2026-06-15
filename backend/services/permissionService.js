const ROLE_PERMISSIONS = {
  admin: [
    "view:dashboard", "view:server-metrics", "view:environment",
    "view:air-conditioner", "view:history", "view:reports",
    "view:settings", "view:user-management",
    "manage:users", "manage:settings", "manage:aircon",
  ],
  it_staff: [
    "view:dashboard", "view:server-metrics", "view:environment",
    "view:air-conditioner", "view:history", "view:reports",
    "view:settings",
  ],
};

const permissionService = {
  async getPermissionsByRole(role) {
    return ROLE_PERMISSIONS[role] ?? [];
  }
};

export default permissionService;