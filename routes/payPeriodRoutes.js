// routes/payPeriodRoutes.js
const express = require("express");
const router = express.Router();

const { authenticateToken, authorizeRoles } = require("../middleware/authMiddleware");
const payPeriodCtrl = require("../controllers/payPeriodController");

// GET /api/pay-periods
router.get(
  "/",
  authenticateToken,
  authorizeRoles("admin", "hr"),
  payPeriodCtrl.list
);

// POST /api/pay-periods
router.post(
  "/",
  authenticateToken,
  authorizeRoles("admin", "hr"),
  payPeriodCtrl.create
);

// POST /api/pay-periods/:id/set-current
router.post(
  "/:id/set-current",
  authenticateToken,
  authorizeRoles("admin", "hr"),
  payPeriodCtrl.setCurrent
);

module.exports = router;
