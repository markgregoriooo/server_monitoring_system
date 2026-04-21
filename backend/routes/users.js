import express from "express";
import bcrypt from "bcryptjs";
import { users } from "../data/db.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import db from "../config/mysql.js";

const router = express.Router();

// Remove password before sending user data
const sanitize = (u) => {
  const { password, ...safe } = u;
  return safe;
};

// GET /api/users — list all users (admin only)
router.get("/", authMiddleware, requireRole("admin"), (req, res) => {
  res.json({ users: users.map(sanitize) });
});

// POST /api/users — create new user (admin only)
router.post("/", authMiddleware, requireRole("admin"), async (req, res) => {
  const { name, username, password, role, email } = req.body;

  if (!name || !username || !password || !role) {
    return res.status(400).json({
      error: "Name, username, password, and role are required."
    });
  }

  if (!["admin", "staff", "viewer"].includes(role)) {
    return res.status(400).json({
      error: "Invalid role."
    });
  }

  if (users.find((u) => u.username === username)) {
    return res.status(409).json({
      error: "Username already exists."
    });
  }

  const newUser = {
    id: users.length + 1,
    name,
    username,
    password: await bcrypt.hash(password, 10),
    role,
    avatar: name
      .split(" ")
      .map((w) => w[0])
      .join("")
      .toUpperCase()
      .slice(0, 2),
    email: email || "",
    created_at: new Date().toISOString().split("T")[0]
  };

  users.push(newUser);

  res.status(201).json({
    user: sanitize(newUser)
  });
});

// DELETE /api/users/:id — delete user
router.delete("/:id", authMiddleware, requireRole("admin"), (req, res) => {
  const id = parseInt(req.params.id);

  if (id === 1) {
    return res.status(403).json({
      error: "Cannot delete the primary super admin."
    });
  }

  if (id === req.user.id) {
    return res.status(403).json({
      error: "Cannot delete your own account."
    });
  }

  const idx = users.findIndex((u) => u.id === id);

  if (idx === -1) {
    return res.status(404).json({
      error: "User not found."
    });
  }

  users.splice(idx, 1);

  res.json({
    message: "User deleted."
  });
});

export default router;
