const pool = require('../../db');

async function resolveRunId(req) {
  if (req.params?.id) {
    const id = Number(req.params.id);
    if (Number.isFinite(id) && id > 0) return id;
  }

  if (req.query?.run_id) {
    const id = Number(req.query.run_id);
    if (Number.isFinite(id) && id > 0) return id;
  }

  const { rows } = await pool.query(
    `SELECT r.id
     FROM pay_runs r
     JOIN pay_periods p ON p.id = r.period_id
     ORDER BY r.created_at DESC NULLS LAST, id DESC
     LIMIT 1`
  );
  const row = rows[0] || null;
  return row?.id ?? null;
}

module.exports = { resolveRunId };