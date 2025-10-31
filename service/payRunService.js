// service/payRunService.js
const pool = require('../db');

// ---- helper: recalc a single line
async function recalcLine(client, lineId) {
  const { rows: lineRows } = await client.query(`
    SELECT 
      id, employee_id, pay_run_id,
      COALESCE(hours,0)                  AS hours,
      COALESCE(rate,0)                   AS rate,
      COALESCE(allowance,0)              AS allowance,
      COALESCE(tax,0)                    AS tax,
      COALESCE("super",0)                AS "super",
      COALESCE(post_tax_deductions,0)    AS post_tax_deductions
    FROM pay_run_items
    WHERE id = $1
  `, [lineId]);

  if (lineRows.length === 0) return null;

  const L = lineRows[0];
  const gross = Number(L.hours) * Number(L.rate) + Number(L.allowance || 0);
  // TODO: replace with your real tax/super calc or DB function
  const tax = Number(L.tax || 0);
  const sup = Number(L.super || 0);
  const net = gross - tax - Number(L.post_tax_deductions || 0) - sup;

  await client.query(`
    UPDATE pay_run_items
       SET gross = $2, tax = $3, "super" = $4, net = $5, updated_at = NOW()
     WHERE id = $1
  `, [lineId, gross, tax, sup, net]);

  const { rows: updated } = await client.query(`
    SELECT id as line_id, employee_id, pay_run_id,
           hours, allowance, rate, gross, tax, "super",
           post_tax_deductions as deductions, net, status
    FROM pay_run_items 
    WHERE id = $1
  `, [lineId]);

  return updated[0];
}

async function recomputeRunSummary(client, runId) {
  const { rows } = await client.query(`
    SELECT 
      COUNT(*)::int                         AS employees,
      COALESCE(SUM(gross),0)::numeric(12,2) AS gross,
      COALESCE(SUM(net),0)::numeric(12,2)   AS net,
      COALESCE(SUM(CASE WHEN status = 'warning' THEN 1 ELSE 0 END),0)::int AS warnings
    FROM pay_run_items
    WHERE pay_run_id = $1
  `, [runId]);

  const s = rows[0];

  await client.query(`
    UPDATE pay_runs
       SET totals_employees = $2,
           totals_gross     = $3,
           totals_net       = $4,
           warnings         = $5,
           updated_at       = NOW()
     WHERE id = $1
  `, [runId, s.employees, s.gross, s.net, s.warnings]);

  return {
    totals: {
      employees: Number(s.employees || 0),
      gross: Number(s.gross || 0),
      net: Number(s.net || 0)
    },
    warnings: Number(s.warnings || 0)
  };
}

async function getActiveRunId(client) {
  // Prefer your view if present
  const v = await client.query(`SELECT pay_run_id FROM v_current_run LIMIT 1`);
  if (v.rows[0]?.pay_run_id) return v.rows[0].pay_run_id;

  // Fallback by date + status (adjust statuses to your enum)
  const q = await client.query(`
    SELECT r.id AS pay_run_id
    FROM pay_runs r
    JOIN pay_periods pp ON pp.id = r.period_id
    WHERE CURRENT_DATE BETWEEN pp.period_start AND pp.period_end
      AND r.status IN ('Draft','Approved','Posted')
    ORDER BY r.updated_at DESC NULLS LAST
    LIMIT 1
  `);
  return q.rows[0]?.pay_run_id || null;
}

// -------- Controller expects: { status, period: {start,end}, totals, items? }
async function getCurrentRunSummary() {
  const client = await pool.connect();
  try {
    // 1) get the current period
    const { rows: periodRows } = await client.query(`
      SELECT id AS period_id,
             COALESCE(start_date, period_start) AS start_date,
             COALESCE(end_date, period_end) AS end_date
      FROM pay_periods
      WHERE is_current = TRUE
      ORDER BY id DESC
      LIMIT 1
    `);

    if (!periodRows.length) {
      // no current period at all
      return null;
    }

    const period = periodRows[0];

    // 2) get the pay run for this period
    const { rows: runRows } = await client.query(`
      SELECT id,
             status
      FROM pay_runs
      WHERE period_id = $1
      ORDER BY id DESC
      LIMIT 1
    `, [period.period_id]);

    if (!runRows.length) {
      // period exists, but no run yet
      return {
        status: 'None',
        period: {
          start: period.start_date,
          end: period.end_date,
        },
        totals: {
          employees: 0,
          gross: 0,
          tax: 0,
          deductions: 0,
          net: 0,
        },
        items: []
      };
    }

    const run = runRows[0];

    // 3) aggregate items for this run
    const { rows: sumRows } = await client.query(`
      SELECT
        COUNT(DISTINCT employee_id)::int             AS employees,
        COALESCE(SUM(gross),             0)::numeric AS gross,
        COALESCE(SUM(tax),               0)::numeric AS tax,
        COALESCE(SUM(deductions_total),  0)::numeric AS deductions,
        COALESCE(SUM(net),               0)::numeric AS net
      FROM pay_run_items
      WHERE pay_run_id = $1
    `, [run.id]);

    const s = sumRows[0];

    return {
      status: run.status,
      period: {
        start: period.start_date,
        end: period.end_date,
      },
      totals: {
        employees: Number(s.employees ?? 0),
        gross: Number(s.gross ?? 0),
        tax: Number(s.tax ?? 0),
        deductions: Number(s.deductions ?? 0),
        net: Number(s.net ?? 0),
      },
      items: []   // summary endpoint doesn’t need full lines
    };
  } finally {
    client.release();
  }
}

// -------- Controller expects an ARRAY (not {items,paging})
async function getCurrentRunItems ({ search = '', limit = 25, offset = 0 } = {}) {
  const client = await pool.connect();
  try {
    // 1) current period
    const { rows: periodRows } = await client.query(`
      SELECT id AS period_id
      FROM pay_periods
      WHERE is_current = TRUE
      ORDER BY id DESC
      LIMIT 1
    `);

    if (!periodRows.length) {
      return { items: [], paging: { search, limit, offset, total: 0 } };
    }

    const periodId = periodRows[0].period_id;

    // 2) run for that period
    const { rows: runRows } = await client.query(`
      SELECT id AS pay_run_id
      FROM pay_runs
      WHERE period_id = $1
      ORDER BY id DESC
      LIMIT 1
    `, [periodId]);

    if (!runRows.length) {
      return { items: [], paging: { search, limit, offset, total: 0 } };
    }

    const runId = runRows[0].pay_run_id;

    // 3) count
    const { rows: crows } = await client.query(
      `
      SELECT COUNT(*)::int AS total
      FROM pay_run_items l
      JOIN employee e ON e.employee_id = l.employee_id
      WHERE l.pay_run_id = $1
        AND (
          $2 = '' OR
          e.first_name ILIKE '%' || $2 || '%' OR
          e.last_name  ILIKE '%' || $2 || '%'
        )
      `,
      [runId, search]
    );
    const total = crows[0].total;

    // 4) data
    const { rows } = await client.query(
      `
      SELECT
        l.id                                 AS line_id,
        e.employee_id                        AS employee_id,
        (e.first_name || ' ' || e.last_name) AS employee_name,
        l.rate                                AS hourly_rate,
        l.hours,
        l.allowance,
        l.gross,
        l.tax,
        l.deductions_total,
        l.super,
        l.net,
        l.status
      FROM pay_run_items l
      JOIN employee e ON e.employee_id = l.employee_id
      WHERE l.pay_run_id = $1
        AND (
          $2 = '' OR
          e.first_name ILIKE '%' || $2 || '%' OR
          e.last_name  ILIKE '%' || $2 || '%'
        )
      ORDER BY e.last_name, e.first_name, l.id
      LIMIT $3 OFFSET $4
      `,
      [runId, search, limit, offset]
    );

    const items = rows.map(r => ({
      id: r.line_id,
      employeeId: r.employee_id,
      employeeName: r.employee_name,
      hourlyRate: Number(r.hourly_rate ?? 0),
      hours: Number(r.hours ?? 0),
      allowance: Number(r.allowance ?? 0),
      gross: Number(r.gross ?? 0),
      tax: Number(r.tax ?? 0),
      deductions: Number(r.deductions_total ?? 0),
      super: Number(r.super ?? 0),
      net: Number(r.net ?? 0),
      status: r.status
    }));

    return { items, paging: { search, limit, offset, total } };
  } finally {
    client.release();
  }
};

async function getCurrentRun() {
  const client = await pool.connect();
  try {
    const runId = await getActiveRunId(client);
    if (!runId) return null;

    const meta = await client.query(`
      SELECT r.status,
             pp.period_start AS start,
             pp.period_end   AS "end"
      FROM pay_runs r
      JOIN pay_periods pp ON pp.id = r.period_id
      WHERE r.id = $1
    `, [runId]);

    const { status, start, end } = meta.rows[0];

    const itemsRows = await client.query(`
      SELECT 
        e.employee_id                                         AS emp_id,
        (e.first_name || ' ' || e.last_name)                  AS emp_name,
        COALESCE(l.gross,0)::numeric(12,2)                    AS gross,
        COALESCE(l.tax,0)::numeric(12,2)                      AS tax,
        COALESCE(l.post_tax_deductions,0)::numeric(12,2)      AS deductions,
        COALESCE(l.net,0)::numeric(12,2)                      AS net
      FROM pay_run_items l
      JOIN employee e ON e.employee_id = l.employee_id
      WHERE l.pay_run_id = $1
      ORDER BY e.last_name, e.first_name, l.id
    `, [runId]);

    const items = itemsRows.rows.map(r => ({
      employee: { id: Number(r.emp_id), name: r.emp_name },
      gross: Number(r.gross),
      tax: Number(r.tax),
      deductions: Number(r.deductions),
      net: Number(r.net),
    }));

    return { status, period: { start, end }, items };
  } finally {
    client.release();
  }
}

// Align with controller: (lineId, patch, userId)
async function updateCurrentRunLine(lineId, patch, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ensure the line belongs to the *current* run
    const { rows: chk } = await client.query(`
      SELECT l.id, l.pay_run_id, r.status
      FROM pay_run_items l
      JOIN pay_runs r     ON r.id = l.pay_run_id
      JOIN pay_periods pp ON pp.id = r.period_id
      WHERE l.id = $1 
        AND CURRENT_DATE BETWEEN pp.period_start AND pp.period_end
        AND r.status IN ('Draft','Approved','Posted')
      FOR UPDATE
    `, [lineId]);

    if (chk.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const runId = chk[0].pay_run_id;

    const sets = [];
    const vals = [lineId];
    if (patch.hours !== undefined)     { vals.push(patch.hours);     sets.push(`hours     = $${vals.length}`); }
    if (patch.allowance !== undefined) { vals.push(patch.allowance); sets.push(`allowance = $${vals.length}`); }
    if (patch.note !== undefined)      { vals.push(patch.note);      sets.push(`note      = $${vals.length}`); }

    if (sets.length) {
      vals.push(userId || null);
      await client.query(
        `UPDATE pay_run_items SET ${sets.join(', ')}, updated_by=$${vals.length}, updated_at=NOW() WHERE id = $1`,
        vals
      );
    }

    const updatedLine = await recalcLine(client, lineId);
    const summary     = await recomputeRunSummary(client, runId);

    await client.query('COMMIT');
    return { line: updatedLine, summary };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Align with controller: (status, userId)
async function updateCurrentRunStatus(status, userId) {
  const sql = `
    UPDATE pay_runs
    SET status = $1,
        approved_by = CASE WHEN $1 = 'Approved' THEN $2 ELSE approved_by END,
        approved_at = CASE WHEN $1 = 'Approved' THEN NOW() ELSE approved_at END
    WHERE id = (
      SELECT id FROM pay_runs
      WHERE status != 'Posted'
      ORDER BY created_at DESC
      LIMIT 1
    )
    RETURNING *;
  `;
  const { rows } = await pool.query(sql, [status, userId || null]);
  return rows[0] || null;
}

async function startForPeriod(periodId, userId = null) {
  // make sure period exists
  const { rows: p } = await db.query(
    `SELECT id FROM pay_periods WHERE id = $1`,
    [periodId]
  );
  if (!p.length) throw new Error("Period not found");

  // check if a run already exists for this period
  const { rows: existing } = await db.query(
    `SELECT id FROM pay_runs WHERE period_id = $1 LIMIT 1`,
    [periodId]
  );
  if (existing.length) {
    // either return existing, or throw
    return existing[0];
  }

  const { rows } = await db.query(
    `INSERT INTO pay_runs (period_id, status, created_by, created_at)
     VALUES ($1, 'Draft', $2, now())
     RETURNING id, period_id, status, created_at`,
    [periodId, userId]
  );
  return rows[0];
}


// ---- final exports (no stub overwrite)
module.exports = {
  getCurrentRunSummary,
  getCurrentRunItems,   // returns ARRAY
  getCurrentRun,
  startCurrentRun: async () => ({ ok: true }), // fill in when ready
  recalcCurrentRun: async () => ({ ok: true }),
  approveCurrentRun: async () => ({ ok: true }),
  postCurrentRun: async () => ({ ok: true }),
  updateCurrentRunLine,      // (lineId, patch, userId)
  updateCurrentRunStatus,   // (status, userId)
  startForPeriod
};
