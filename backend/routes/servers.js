import express from "express";
import {servers} from "../data/db.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";

const router = express.Router();

// Simulate fluctuating CPU/memory every request
function liveServers() {
  return servers.map(s => ({
    ...s,
    cpu:    Math.min(99, Math.max(5,  s.cpu    + Math.round((Math.random() - 0.5) * 6))),
    memory: Math.min(99, Math.max(10, s.memory + Math.round((Math.random() - 0.5) * 4))),
  }));
}

// GET /api/servers
router.get("/", authMiddleware, (req, res) => {
  res.json({ servers: liveServers() });
});

// GET /api/servers/:id
router.get("/:id", authMiddleware, (req, res) => {
  const server = servers.find(s => s.id === parseInt(req.params.id));
  if (!server) return res.status(404).json({ error: "Server not found." });
  res.json({ server });
});

export default router;
