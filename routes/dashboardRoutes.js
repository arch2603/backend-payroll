// routes/dashboardRoutes.js
const express = require('express');
const { authenticateToken, authorizeRoles } = require('../middleware/authMiddleware');
const pool = require('../db');
const router = express.Router();
const dashboardAccess = [authenticateToken, authorizeRoles('admin', 'hr')];

// Employees count
router.get('/employees/count', ...dashboardAccess, async (_req, res) => {
  const q = await pool.query(`SELECT COUNT(*)::int AS count FROM employee WHERE COALESCE(is_active, true) = true`);
  res.json({ count: q.rows[0].count });
});

// Approved/posted payslips that have not yet been printed or emailed.
router.get('/payslips/pending/count', ...dashboardAccess, async (_req, res) => {
  const q = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM payslips slip
    JOIN pay_run_items item ON item.id = slip.pay_run_item_id
    JOIN pay_runs run ON run.id = item.pay_run_id
    WHERE run.status IN ('Approved', 'Posted')
      AND slip.printed_at IS NULL
      AND slip.emailed_at IS NULL
  `);
  res.json({ count: q.rows[0].count });
});

// Pending leave requests.
router.get('/leaves/pending/count', ...dashboardAccess, async (_req, res) => {
  const q = await pool.query(
    `SELECT COUNT(*)::int AS count FROM leave_requests WHERE status = 'PENDING'`
  );
  res.json({ count: q.rows[0].count });
});

// Audit (maps to audit_log)
router.get('/audit', ...dashboardAccess, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || '5', 10) || 5, 1), 50);
  const q = await pool.query(
    `SELECT log_id AS id, user_id,
            action AS action,
            target AS entity,
            entity_id,
            "timestamp" AS created_at
       FROM audit_log
       ORDER BY "timestamp" DESC
       LIMIT $1`, [limit]
  );
  // Resolve user names if you want; for now send id
  res.json({ items: q.rows.map(r => ({ ...r, user_name: r.user_id ? `User#${r.user_id}` : 'System' })) });
});

// Next period end and public holidays in the coming 60 days.
router.get('/calendar/next-key-dates', ...dashboardAccess, async (_req, res) => {
  const [period, holidays] = await Promise.all([
    pool.query(
      `SELECT end_date AS next_period_end
       FROM pay_periods
       WHERE end_date >= CURRENT_DATE
       ORDER BY end_date
       LIMIT 1`
    ),
    pool.query(
      `SELECT holiday_date AS date, name
       FROM public_holidays
       WHERE holiday_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '60 days'
       ORDER BY holiday_date`
    ),
  ]);
  res.json({
    nextPeriodEnd: period.rows[0]?.next_period_end || null,
    publicHolidays: holidays.rows,
  });
});

module.exports = router;
