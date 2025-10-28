// routes/dashboardRoutes.js
const express = require('express');
const { authenticateToken } = require('../middleware/authMiddleware');
const pool = require('../db');
const router = express.Router();

// Employees count
router.get('/employees/count', authenticateToken, async (_req, res) => {
  const q = await pool.query(`SELECT COUNT(*)::int AS count FROM employee WHERE COALESCE(is_active, true) = true`);
  res.json({ count: q.rows[0].count });
});

// Payslips pending = payroll rows not approved yet
router.get('/payslips/pending/count', authenticateToken, async (_req, res) => {
  const q = await pool.query(`SELECT COUNT(*)::int AS count FROM payroll WHERE approved_at IS NULL`);
  res.json({ count: q.rows[0].count });
});

// Leaves pending (you don't have requests yet → return 0 for now)
router.get('/leaves/pending/count', authenticateToken, async (_req, res) => {
  res.json({ count: 0 });
});

// Audit (maps to audit_log)
router.get('/audit', authenticateToken, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '5', 10), 50);
  const q = await pool.query(
    `SELECT log_id AS id, user_id,
            action AS action,
            target AS entity,
            NULL::int AS entity_id,
            "timestamp" AS created_at
       FROM audit_log
       ORDER BY "timestamp" DESC
       LIMIT $1`, [limit]
  );
  // Resolve user names if you want; for now send id
  res.json({ items: q.rows.map(r => ({ ...r, user_name: r.user_id ? `User#${r.user_id}` : 'System' })) });
});

// Key dates (return “None” until we add periods/holidays)
router.get('/calendar/next-key-dates', authenticateToken, async (_req, res) => {
  res.json({ nextPeriodEnd: null, publicHolidays: [] });
});

module.exports = router;
