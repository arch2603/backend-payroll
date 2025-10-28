const pool = require('../db');

// helper to recalc a single line; replace with your real rules or a DB function
async function recalcLine(client, lineId) {
  // Example: gross = hours * rate + allowance - preTaxDeductions
  const { rows: lineRows } = await client.query(`
    SELECT 
      id, employee_id, 
      COALESCE(hours,0)    AS hours,
      COALESCE(rate,0)     AS rate,
      COALESCE(allowance,0) AS allowance,
      COALESCE(tax,0)      AS tax,
      COALESCE("super",0)  AS "super",
      COALESCE(post_tax_deductions,0) AS post_tax_deductions
    FROM pay_run_items
    WHERE id = $1`, 
    [lineId]);

  if (lineRows.length === 0) return null;

  const L = lineRows[0];
  const gross = Number(L.hours) * Number(L.rate) + Number(L.allowance || 0);
  // You may compute tax/super here or call a DB function:
  // SELECT * FROM compute_payroll_components($1);
  const tax = L.tax ?? 0;
  const sup = L.super ?? 0;
  const net = gross - tax - Number(L.post_tax_deductions || 0) - sup; // adjust to your logic

  await client.query(`
    UPDATE pay_run_items
       SET gross = $2, tax = $3, super = $4, net = $5, updated_at = NOW()
     WHERE id = $1
  `, [lineId, gross, tax, sup, net]);

  const { rows: updated } = await client.query(`
    SELECT id as line_id, employee_id, hours, allowance, rate, gross, tax, "super", post_tax_deductions as deductions, net, status
    FROM pay_run_items 
    WHERE id = $1`, 
    [lineId]);

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

  return { totals: { employees: s.employees, gross: s.gross, net: s.net }, warnings: s.warnings };
}

exports.updateCurrentRunLine = async ({ lineId, patch, userId }) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ensure the line belongs to the "current" run
    const { rows: chk } = await client.query(`
      SELECT l.id, l.run_id, r.status
      FROM pay_run_items l
      JOIN pay_runs r ON r.id = l.run_id
      JOIN pay_periods pp ON pp.id = r.period_id
      WHERE l.id = $1 
      AND CURRENT_DATE BETWEEN pp.period_start AND pp.period_end
      AND r.status IN ('Draft', 'OPEN')
      FOR UPDATE`,
      [lineId]);
    if (chk.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const runId = chk[0].run_id;

    // build dynamic set clause
    const sets = [];
    const vals = [lineId];
    if (patch.hours !== undefined) { vals.push(patch.hours); sets.push(`hours = $${vals.length}`); }
    if (patch.allowance !== undefined) { vals.push(patch.allowance); sets.push(`allowance = $${vals.length}`); }
    if (patch.note !== undefined) { vals.push(patch.note); sets.push(`note = $${vals.length}`); }

    if (sets.length) {
      await client.query(`UPDATE pay_run_lines SET ${sets.join(', ')}, updated_by=$${vals.length + 1}, updated_at=NOW() WHERE id = $1`,
        [...vals, userId || null]);
    }

    // recalc this line
    const updatedLine = await recalcLine(client, lineId);

    // refresh run summary
    const summary = await recomputeRunSummary(client, runId);

    await client.query('COMMIT');
    return { line: updatedLine, summary };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

exports.getCurrentRunSummary = async () => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`
      SELECT id, period_start, period_end, status,
             totals_employees, totals_gross, totals_net, warnings
      FROM current_pay_run_summary
      ORDER BY updated_at DESC
      LIMIT 1
    `);
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      payRunId: r.id,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      status: r.status,
      totals: {
        employees: r.totals_employees ?? 0,
        gross: Number(r.totals_gross ?? 0),
        net: Number(r.totals_net ?? 0)
      },
      warnings: r.warnings ?? 0
    };
  } finally {
    client.release();
  }
};

// Return paged items for the current run (search by employee name)
exports.getCurrentRunItems = async ({ search = '', limit = 25, offset = 0 }) => {
  const client = await pool.connect();
  try {
    
    const { rows: cur } = await client.query(`SELECT pay_run_id FROM v_current_run LIMIT 1`);
    const runId = cur[0]?.pay_run_id;

    if (!runId) {
      return { items: [], paging: { search, limit, offset, total: 0 } };
    }

    // COUNT (use consistent table/aliases and FK column)
    const { rows: crows } = await client.query(
     `SELECT COUNT(*)::int AS total
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

    // DATA (same aliases and FK)
    const { rows } = await client.query(
      `
      SELECT
        l.id AS line_id,
        e.employee_id AS employee_id,
        (e.first_name || ' ' || e.last_name) AS employee_name,
        l.rate  AS hourly_rate,
        l.hours,
        l.allowance,
        l.gross,
        l.tax,
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
      super: Number(r.super ?? 0),
      net: Number(r.net ?? 0),
      status: r.status
    }));

    return { items, paging: { search, limit, offset, total } };
  } finally {
    client.release();
  }
};

async function getActiveRunId(client) {
  // If you have v_current_run, use it:
  const v = await client.query(`SELECT pay_run_id FROM v_current_run LIMIT 1`);
  if (v.rows[0]?.pay_run_id) return v.rows[0].pay_run_id;

  // Fallback by date + status (adjust table/cols to your schema)
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

exports.getCurrentRunView = async () => {
  const client = await pool.connect();
  try {
    const runId = await getActiveRunId(client);
    if (!runId) return null;

    // status + period
    const meta = await client.query(`
      SELECT r.status,
             pp.period_start AS start,
             pp.period_end   AS "end"
      FROM pay_runs r
      JOIN pay_periods pp ON pp.id = r.period_id
      WHERE r.id = $1
    `, [runId]);

    const { status, start, end } = meta.rows[0];

    // items: nested employee + four money fields
    const { rows } = await client.query(`
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

    const items = rows.map(r => ({
      employee: { id: Number(r.emp_id), name: r.emp_name },
      gross: Number(r.gross),
      tax: Number(r.tax),
      deductions: Number(r.deductions),
      net: Number(r.net),
    }));

    return {
      status,                           // "Draft" | "Approved" | "Posted"
      period: { start, end },           // strings; ISO from PG is fine
      items
    };
  } finally {
    client.release();
  }
};

const pool = require('../db'); // assuming you already export your pg Pool instance

exports.updateCurrentRunStatus = async ({ status, userId }) => {
  try {
    const sql = `
      UPDATE pay_runs
      SET status = $1,
          approved_by = CASE WHEN $1 = 'Approved' THEN $2 ELSE approved_by END,
          approved_at = CASE WHEN $1 = 'Approved' THEN NOW() ELSE approved_at END,
          created_at = created_at  -- no change
      WHERE id = (
        SELECT id FROM pay_runs
        WHERE status != 'Posted'
        ORDER BY created_at DESC
        LIMIT 1
      )
      RETURNING *;
    `;

    const { rows } = await pool.query(sql, [status, userId]);
    return rows[0] || null;
  } catch (err) {
    console.error("[payRunService] updateCurrentRunStatus error:", err);
    throw err;
  }
};

