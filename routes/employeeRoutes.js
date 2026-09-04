const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken, authorizeRoles } = require('../middleware/authMiddleware');
const employeeCtrl = require('../controllers/employeeController');

// GET /api/employees?search=&limit=50&offset=0
router.get('/', authenticateToken, authorizeRoles('admin','hr'), async (req, res) => {
  try {
    const search = String(req.query.search || '').trim().slice(0, 100);
    const limit  = Math.min(Math.max(parseInt(req.query.limit || '50', 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);

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
        COALESCE(e.is_active, TRUE) AS status
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

router.post('/create', authenticateToken, authorizeRoles('admin','hr'), employeeCtrl.createEmployee);
router.patch('/patch/:empId', authenticateToken, authorizeRoles('admin','hr'), employeeCtrl.updateEmployee);
router.get('/:empId', authenticateToken, authorizeRoles('admin','hr'), employeeCtrl.getEmployeeById);

module.exports = router;
