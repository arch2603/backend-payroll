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

async function create({ start_date, end_date, make_current }) {
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

    await client.query("COMMIT");
    return rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function setCurrent(id) {
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

    // ✅ Ensure a pay run exists for this period
    const { rows: existingRun } = await client.query(
      `SELECT id FROM pay_runs WHERE period_id = $1 LIMIT 1`,
      [id]
    );

    if (!existingRun.length) {
      await client.query(
        `INSERT INTO pay_runs (period_id, status, created_at)
         VALUES ($1, 'Draft', now())`,
        [id]
      );
    }

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
