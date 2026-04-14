import express from "express";
import { reports } from "../data/db.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";

const router = express.Router();

// GET /api/reports
router.get("/", authMiddleware, (req, res) => {
  res.json({ reports });
});

// POST /api/reports — generate a new report
router.post(
  "/",
  authMiddleware,
  requireRole("super_admin", "it_staff"),
  (req, res) => {
    const { title, type } = req.body;

    const newReport = {
      id: reports.length + 1,
      title: title || "On-Demand Report",
      date: new Date().toISOString().split("T")[0],
      status: "Generated",
      type: type || "Environment",
    };

    reports.unshift(newReport);

    res.status(201).json({
      report: newReport,
    });
  }
);

export default router;
