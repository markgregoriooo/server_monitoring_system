import express from "express";
import {alerts,auditLog} from "../data/db.js";
import {authMiddleware} from "../middleware/auth.js";

const router = express.Router();

// GET /api/alerts
router.get("/", authMiddleware, (req, res) => {
  res.json({ alerts });
});

// GET /api/alerts/audit
router.get("/audit", authMiddleware, (req, res) => {
  res.json({ log: auditLog });
});

export default router;
