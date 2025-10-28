// routes/historyRoutes.js
const express = require('express');
const { authenticateToken } = require('../middleware/authMiddleware');
const pool = require('../db');
const router = express.Router();

// Helper to build WHERE based on filters
function buildWhere({ employee, from, to, status }) {
  const where = [];
  const params = [];
  if (employee) {
    params.push(`%${employee}%`);
    where.push(`(LOWER(e.first_name || ' ' || e.last_name) LIKE LOWER($${params.length}) OR CAST(e.employee_id AS TEXT) LIKE $${params.length})`);
  }
  if (from) {
    params.push(from);
    where.push(`pp.period_start >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    where.push(`pp.period_end <= $${params.length}`);
  }
  if (status === 'printed') where.push(`ps.printed_at IS NOT NULL`);
  if (status === 'emailed') where.push(`ps.emailed_at IS NOT NULL`);
  if (status === 'unprinted') where.push(`ps.printed_at IS NULL`);
  if (status === 'unemailed') where.push(`ps.emailed_at IS NULL`);

  return { whereSql: where.length ? ('WHERE ' + where.join(' AND ')) : '', params };
}

// GET /api/history/payslips?employee=&from=yyyy-mm-dd&to=yyyy-mm-dd&status=&page=&pageSize=
router.get('/history/payslips', authenticateToken, async (req, res) => {
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '25', 10), 1), 200);
  const { whereSql, params } = buildWhere(req.query);
  const offset = (page - 1) * pageSize;

  const q = await pool.query(
    `SELECT ps.id,
            pp.period_start::date, pp.period_end::date,
            e.employee_id, (e.first_name || ' ' || e.last_name) AS employee_name,
            i.gross, i.tax, i.deductions_total AS deductions, i.net,
            ps.printed_at, ps.emailed_at
       FROM payslips ps
       JOIN pay_run_items i ON i.id = ps.pay_run_item_id
       JOIN employee e ON e.employee_id = ps.employee_id
       JOIN pay_periods pp ON pp.id = ps.period_id
       ${whereSql}
       ORDER BY pp.period_end DESC, e.last_name, e.first_name
       LIMIT ${pageSize} OFFSET ${offset}`,
    params
  );

  res.json({ items: q.rows });
});

// GET /api/history/export.csv?employee=&from=&to=&status=
router.get('/history/export.csv', authenticateToken, async (req, res) => {
  const { whereSql, params } = buildWhere(req.query);
  const q = await pool.query(
    `SELECT pp.period_start::date, pp.period_end::date,
            e.employee_id, (e.first_name || ' ' || e.last_name) AS employee_name,
            i.gross, i.tax, i.deductions_total AS deductions, i.net,
            ps.printed_at, ps.emailed_at
       FROM payslips ps
       JOIN pay_run_items i ON i.id = ps.pay_run_item_id
       JOIN employee e ON e.employee_id = ps.employee_id
       JOIN pay_periods pp ON pp.id = ps.period_id
       ${whereSql}
       ORDER BY pp.period_end DESC, e.last_name, e.first_name`,
    params
  );

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="payslip-history.csv"');

  // Stream CSV
  res.write('period_start,period_end,employee_id,employee_name,gross,tax,deductions,net,printed_at,emailed_at\n');
  for (const r of q.rows) {
    res.write([
      r.period_start?.toISOString?.().slice(0,10) ?? r.period_start,
      r.period_end?.toISOString?.().slice(0,10) ?? r.period_end,
      r.employee_id,
      csvEscape(r.employee_name),
      num(r.gross), num(r.tax), num(r.deductions), num(r.net),
      r.printed_at ? toIso(r.printed_at) : '',
      r.emailed_at ? toIso(r.emailed_at) : ''
    ].join(',') + '\n');
  }
  res.end();
});

function csvEscape(s) {
  if (s == null) return '';
  const str = String(s);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}
function num(n) { return Number(n || 0).toFixed(2); }
function toIso(d) { return new Date(d).toISOString(); }

module.exports = router;
