import express from "express";
import {servers} from "../data/db.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";

const router = express.Router();


// GET /api/servers
router.get("/", authMiddleware, (req, res) => {
  res.json({ servers });
});

// GET /api/servers/:id
router.get("/:id", authMiddleware, (req, res) => {
  const server = servers.find(s => s.id === parseInt(req.params.id));
  if (!server) return res.status(404).json({ error: "Server not found." });
  res.json({ server });
});

export default router;
