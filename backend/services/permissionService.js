import db from "../config/mysql.js";

const permissionService = {
    
  async getPermissionsByRole(role) {
    const [rows] = await db.query(
      `SELECT p.name
       FROM permissions p
       JOIN role_permissions rp ON rp.permission_id = p.id
       WHERE rp.role = ?`,
      [role]
    );

    return rows.map(r => r.name);
  }
};

export default permissionService;