import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import {users, auditLog} from "../data/db.js";
import { authMiddleware, JWT_SECRET } from "../middleware/auth.js";

const router = express.Router();

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required." });
  }

  const user = users.find(u => u.username === username);
  if (!user) {
    return res.status(401).json({ error: "Invalid username or password." });
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    return res.status(401).json({ error: "Invalid username or password." });
  }

  const payload = { id: user.id, name: user.name, username: user.username, role: user.role, avatar: user.avatar, email: user.email };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "1h" });

  // Audit log
  auditLog.unshift({ time: new Date().toLocaleTimeString("en-PH"), action: `User "${username}" logged in`, user: user.name });

  res.json({ token, user: payload });
});

// GET /api/auth/me  (verify current token)
router.get("/me", authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// POST /api/auth/logout  (client just discards token, but we log it)
router.post("/logout", authMiddleware, (req, res) => {
  auditLog.unshift({ time: new Date().toLocaleTimeString("en-PH"), action: `User "${req.user.username}" logged out`, user: req.user.name });
  res.json({ message: "Logged out." });
});

export default router;