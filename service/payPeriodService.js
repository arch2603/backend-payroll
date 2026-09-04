// service/payPeriodService.js
const db = require("../db"); // adjust path

async function list() {
  const { rows } = await db.query(
    `SELECT id, start_date, end_date, is_current
       FROM pay_periods
      ORDER BY start_date DESC`
  );
  return rows;
}

async function create({ start_date, end_date, make_current }, userId = null) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    if (make_current) {
      await client.query(`UPDATE pay_periods SET is_current = FALSE WHERE is_current = TRUE`);
    }

    const { rows } = await client.query(
      `INSERT INTO pay_periods (start_date, end_date, is_current)
       VALUES ($1, $2, $3)
       RETURNING id, start_date, end_date, is_current`,
      [start_date, end_date, make_current]
    );

    await client.query(
      `INSERT INTO audit_log
         (user_id, action, target, entity_type, entity_id, after_data, "timestamp")
       VALUES ($1, 'PAY_PERIOD_CREATED', $2, 'pay_period', $3, $4::jsonb, now())`,
      [userId, `pay_period:${rows[0].id}`, String(rows[0].id), JSON.stringify(rows[0])]
    );

    await client.query("COMMIT");
    return rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function setCurrent(id, userId = null) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Lock the target period
    const { rows: periodRows } = await client.query(
      `SELECT id FROM pay_periods WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!periodRows.length) {
      await client.query("ROLLBACK");
      return false;
    }

    // Unset previous current
    await client.query(`UPDATE pay_periods SET is_current = FALSE WHERE is_current = TRUE`);
    // Mark selected period as current
    await client.query(`UPDATE pay_periods SET is_current = TRUE WHERE id = $1`, [id]);

    await client.query(
      `INSERT INTO pay_runs (period_id, status, created_by, created_at)
       VALUES ($1, 'Draft', $2, now())
       ON CONFLICT (period_id) DO NOTHING`,
      [id, userId]
    );

    await client.query(
      `INSERT INTO audit_log
         (user_id, action, target, entity_type, entity_id, after_data, "timestamp")
       VALUES ($1, 'PAY_PERIOD_SET_CURRENT', $2, 'pay_period', $3, $4::jsonb, now())`,
      [userId, `pay_period:${id}`, String(id), JSON.stringify({ is_current: true })]
    );

    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

module.exports = {
  list,
  create,
  setCurrent,
};
