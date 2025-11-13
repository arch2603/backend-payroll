async function resolveRunId(req) {
  if (req.params?.id) {
    const id = Number(req.params.id);
    if (Number.isFinite(id) && id > 0) return id;
  }

  if (req.query?.run_id) {
    const id = Number(req.query.run_id);
    if (Number.isFinite(id) && id > 0) return id;
  }

  const pool = req.app?.locals?.db;
  if (!pool) throw new Error('DB handle not provided to resolveRunId');

  const { rows } = await pool.query(
    `SELECT id
     FROM pay_runs
     WHERE status = 'Draft'
     ORDER BY created_at DESC NULLS LAST, id DESC
     LIMIT 1`
  );
  const row = rows[0] || null;
  return row?.id ?? null;
}

module.exports = { resolveRunId };