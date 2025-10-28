// routes/employeeRoute.js
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken } = require('../middleware/authMiddleware');

// GET /api/employees?search=&limit=50&offset=0
router.get('/', authenticateToken, async (req, res) => {
  try {
    const search = (req.query.search || '').trim();
    const limit  = Math.min(parseInt(req.query.limit || '50', 10), 200); // hard cap
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);

    const where = `
      ($1 = '' OR
        e.first_name ILIKE '%' || $1 || '%' OR
        e.last_name  ILIKE '%' || $1 || '%' OR
        e.email      ILIKE '%' || $1 || '%' OR
        e.employee_number::text ILIKE '%' || $1 || '%'
      )
    `;

    const listSql = `
      SELECT
        e.employee_id      AS id,
        e.first_name       AS firstname,
        e.last_name        AS lastname,
        e.email            AS email,
        e.employee_number  AS "employeeNumber",
        CASE WHEN COALESCE(e.is_active, TRUE) THEN 'Active' ELSE 'Inactive' END AS status
      FROM employee e
      WHERE ${where}
      ORDER BY e.last_name, e.first_name
      LIMIT $2 OFFSET $3
    `;

    const countSql = `
      SELECT COUNT(*)::int AS count
      FROM employee e
      WHERE ${where}
    `;

    const [list, count] = await Promise.all([
      pool.query(listSql, [search, limit, offset]),
      pool.query(countSql, [search]),
    ]);

    res.json({
      items: list.rows,
      total: count.rows[0].count,
      limit,
      offset,
    });
  } catch (err) {
    console.error('Error fetching employees:', err);
    res.status(500).json({ message: 'Failed to fetch employees' });
  }
});

// router.get('/count', authenticateToken, async (_req, res) => {
//   const q = await pool.query(`
//     SELECT COUNT(*)::int AS count
//     FROM employee
//     WHERE COALESCE(is_active, true) = true
//   `);
//   res.json({ count: q.rows[0].count });
// });

module.exports = router;