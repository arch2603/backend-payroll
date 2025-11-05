
const { number } = require('zod');
const pool = require('../db');

function periodStartSQL(alias = 'pp') {
  return `COALESCE(${alias}.start_date, ${alias}.period_start)`;
}

function periodEndSQL(alias = 'pp') {
  return `COALESCE(${alias}.end_date, ${alias}.period_end)`;
}

async function recalcLine(client, id) {
  const { rows: lineRows } = await client.query(`
    SELECT 
      id, employee_id, pay_run_id,
      COALESCE(hours,0)                  AS hours,
      COALESCE(rate,0)                   AS rate,
      COALESCE(allowance,0)              AS allowance,
      COALESCE(tax,0)                    AS tax,
      COALESCE("super",0)                AS "super",
      COALESCE(deductions_total,0)    AS deductions_total
    FROM pay_run_items
    WHERE id = $1
  `, [id]);

  if (lineRows.length === 0) return null;

  const L = lineRows[0];
  const gross = Number(L.hours) * Number(L.rate) + Number(L.allowance || 0);
  // TODO: replace with your real tax/super calc or DB function
  const tax = Number(L.tax || 0);
  const sup = Number(L.super || 0);
  const net = gross - tax - Number(L.deductions_total || 0) - sup;

  await client.query(`
    UPDATE pay_run_items
       SET gross = $2, tax = $3, "super" = $4, net = $5, updated_at = NOW()
     WHERE id = $1
  `, [id, gross, tax, sup, net]);

  const { rows: updated } = await client.query(`
    SELECT id as line_id, employee_id, pay_run_id,
           hours, allowance, rate, gross, tax, "super",
           post_tax_deductions as deductions, net, status
    FROM pay_run_items 
    WHERE id = $1
  `, [id]);

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
  try {
    const v = await client.query(`SELECT pay_run_id FROM v_current_run LIMIT 1`);
    if (v.rows[0]?.pay_run_id) return v.rows[0].pay_run_id;
  } catch (error) { }

  // Fallback by date + status (adjust statuses to your enum)
  const q = await client.query(`
    SELECT r.id AS pay_run_id
    FROM pay_runs r
    JOIN pay_periods pp ON pp.id = r.period_id
    WHERE CURRENT_DATE BETWEEN ${periodStartSQL()} AND ${periodEndSQL()}
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
async function getCurrentRunItems({ search = '', limit = 25, offset = 0 } = {}) {
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
}

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
        COALESCE(l.deductions_total,0)::numeric(12,2)      AS deductions,
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

    const totals = items.reduce((t, r) => ({
      ...t,
      employees: t.employees + 1,
      gross: t.gross + r.gross,
      tax: t.tax + r.tax,
      deductions: t.deductions + r.deductions,
      net: t.net + r.net
    }), { employees: 0, gross: 0, tax: 0, deductions: 0, net: 0 });

    return { status, period: { start, end }, items, totals };
  } finally {
    client.release();
  }
}

// Align with controller: (lineId, patch, userId)
async function updateCurrentItem(id, patch, userId) {
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
        AND r.status IN ('Draft')
      FOR UPDATE
    `, [id]);

    if (chk.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const runId = chk[0].pay_run_id;

    const { _recalc, ...realPatch } = patch;

    const sets = [];
    const vals = [id];

    if (realPatch.hours !== undefined) {
      vals.push(patch.hours);
      sets.push(`hours = $${vals.length}`);
    }
    if (realPatch.rate !== undefined) {
      vals.push(patch.rate);
      sets.push(`rate = $${vals.length}`);
    }
    if (realPatch.allowance !== undefined) {
      vals.push(patch.allowance);
      sets.push(`allowance = $${vals.length}`);
    }
    if (realPatch.tax !== undefined) {
      vals.push(patch.tax);
      sets.push(`tax = $${vals.length}`);
    }
    if (realPatch.deductions !== undefined) {
      vals.push(patch.deductions);
      sets.push(`deductions_total = $${vals.length}`);
    }
    if (realPatch.super !== undefined) {
      vals.push(patch.super);
      sets.push(`super = $${vals.length}`);
    }
    if (realPatch.note !== undefined) {
      vals.push(patch.note);
      sets.push(`note = $${vals.length}`);
    }

    if (sets.length) {
      vals.push(userId || null);
      await client.query(
        `UPDATE pay_run_items SET ${sets.join(', ')}, updated_by=$${vals.length}, updated_at=NOW() WHERE id = $1`,
        vals
      );
    }

    const updatedLine = await recalcLine(client, id);
    const summary = await recomputeRunSummary(client, runId);

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
async function updateCurrentRunStatus(status, userId, { allowApprovedToDraft = false } = {}) {
  
  const allowedTargets = new Set(['Draft', 'Approved', 'Posted']);
  if (!allowedTargets.has(status)) {
    throw new Error(`Unknown target status: ${status}`);
  }

  const allowRollback = allowApprovedToDraft ? `OR r.status = 'Approved' AND $1 = 'Draft'` : '';

  const sql = `
    WITH cur AS (
      SELECT r.id, r.status
      FROM pay_runs r
      JOIN pay_periods pp ON pp.id = r.period_id
      WHERE pp.is_current = TRUE
      ORDER BY r.created_at DESC
      LIMIT 1
    )
    UPDATE pay_runs pr
    SET
      status = $1,
      approved_by = CASE
        WHEN $1 = 'Approved' THEN $2
        WHEN pr.status = 'Approved' AND $1 <> 'Approved' THEN NULL
        ELSE approved_by
      END,
      approved_at = CASE
        WHEN $1 = 'Approved' THEN NOW()
        WHEN pr.status = 'Approved' AND $1 <> 'Approved' THEN NULL
        ELSE approved_at
      END
    FROM cur
    WHERE pr.id = cur.id
      AND (
        pr.status = $1                               
        OR (pr.status = 'Draft' AND $1 = 'Approved') 
        OR (pr.status = 'Approved' AND $1 = 'Posted')
        ${allowRollback}                            
      )
    RETURNING pr.*;`;

  const { rows } = await pool.query(sql, [status, userId || null, allowApprovedToDraft]);

  if (rows.length === 0) {
    // Either no current run, or invalid transition
    // Fetch current to produce a precise error
    const { rows: curRows } = await pool.query(`
      SELECT r.id, r.status
      FROM pay_runs r
      JOIN pay_periods pp ON pp.id = r.period_id
      WHERE pp.is_current = TRUE
      ORDER BY r.created_at DESC
      LIMIT 1
    `);

    if (!curRows.length) return null; // no current period/run

    const cur = curRows[0];
    throw new Error(
      `Invalid transition ${cur.status} → ${status}. Allowed: ` +
      (allowApprovedToDraft
        ? `Draft→Approved, Approved→Posted, Approved→Draft, or no-op.`
        : `Draft→Approved, Approved→Posted, or no-op.`)
    );
  }

  return rows[0];
}

async function startForPeriod(periodId, userId = null) {
  const client = await pool.connect();
  try {

    const { rows: p } = await client.query(`SELECT id FROM pay_periods WHERE id = $1`,
      [periodId]);

    if (!p.length) throw new Error("Period not found");

    // check if a run already exists for this period
    const { rows: existing } = await client.query(
      `SELECT id FROM pay_runs WHERE period_id = $1 LIMIT 1`,
      [periodId]
    );

    if (existing.length) {
      return existing[0];
    }

    const { rows } = await client.query(
      `INSERT INTO pay_runs (period_id, status, created_by, created_at)
     VALUES ($1, 'Draft', $2, now())
     RETURNING id, period_id, status, created_at`,
      [periodId, userId]
    );
    return rows[0];
  } finally {
    client.release();
  }
}

async function validateCurrentRun() {
  const client = await pool.connect();

  try {
    const period = await getCurrentPeriod(client);
    if (!period) {
      return { ok: false, errors: ['NO current period found'] };
    }

    const run = await getCurrentRunRow(client, period.id);
    if (!run) {
      return { ok: false, errors: ['No pay run started for current period'] };
    }

    const { rows: items } = await client.query(`
      SELECT pri.*, e.hourly_rate 
      FROM pay_run_items pri
      LEFT JOIN employee e ON e.employee_id = pri.employee_id
      WHERE pri.pay_run_id = $1
      `, [run.id]);

    const errors = [];

    if (items.length === 0) {
      errors.push('No pay run items found. ');
    }

    for (const it of items) {
      if ((it.hours == null || Number(it.hours) === 0) && (it.gross === null || Number(it.gross) === 0)) {
        errors.push(`Item ${it.id}: zero hours and zero gross`);
      }
      if (!it.hourly_rate && !it.gross) {
        errors.push(`Employee ${it.employee_id}: no hourly rate and no gross set.`)
      }
    }

    return {
      ok: errors.length === 0,
      errors,
    };

  } finally {
    client.release();
  }
}

async function getCurrentPeriod(client) {
  const { rows } = await client.query(`
    SELECT id, 
      COALESCE(start_date, period_start) AS start_date,
      COALESCE(end_date, period_end) AS end_date
      FROM pay_periods
      WHERE is_current = TRUE
      ORDER BY id DESC
      LIMIT 1
    `)
  return rows[0] || null;
}

async function getCurrentRunRow(client, periodId) {
  const { rows } = await client.query(`
    SELECT id, status FROM pay_runs
    WHERE period_id = $1
    ORDER BY id DESC
    LIMIT 1  
  `, [periodId]);
  return rows[0] || null;
}

async function addCurrentRunItem(payload) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const period = await getCurrentPeriod(client);
    if (!period) throw new Error('No current period');

    const run = await getCurrentRunRow(client, period.id);
    if (!run) throw new Error('No current run for current period');

    if (run.status !== 'Draft') {
      throw new Error('Run not in Draft, cannot add items');
    }

    const {
      employee_id,
      hours = 0,
      rate = 0,
      allowance = 0,
      tax = 0,
      deductions_total = 0,
      super_amount = 0,
      note = null,
    } = payload;

    const gross = (Number(hours) * Number(rate)) + Number(allowance);
    const net = gross - Number(tax) - Number(deductions_total) - Number(super_amount);

    const { rows } = await client.query(`
      INSERT INTO pay_run_items
        (pay_run_id, employee_id, hours, rate, allowance,
         gross, tax, deductions_total, super, net, note)
      VALUES
        ($1, $2, $3, $4, $5,
         $6, $7, $8, $9, $10, $11)
      RETURNING *;
    `, [
      run.id,
      employee_id,
      hours,
      rate,
      allowance,
      gross,
      tax,
      deductions_total,
      super_amount,
      net,
      note
    ]);

    await recomputeRunSummary(client, run.id);
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function startCurrentRun(userId = null) {
  const client = await pool.connect();
  try {
    const period = await getCurrentPeriod(client);
    if (!period) throw new Error('No current period');

    const run = await getCurrentRunRow(client, period.id);
    if (run) return run;

    const { rows } = await client.query(`
      INSERT INTO pay_runs (period_id, status, created_by, created_at)
      VALUES ($1, 'Draft', $2, NOW())
      RETURNING id, period_id, status
      `, [period.id, userId]);

    return rows[0];
  } finally {
    client.release();
  }
}

async function recalcCurrentRun() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const runId = await getActiveRunId(client);
    if (!runId) {
      await client.query('ROLLBACK');
      return { ok: false, message: 'No active run' };
    }

    const { rows: lines } = await client.query(`
      SELECT id FROM pay_run_items WHERE pay_run_id = $1
      `, [runId]);

    for (const row of lines) {
      await recalcLine(client, row.id);
    }
    const summary = await recomputeRunSummary(client, runId);
    return { ok: true, run_id: runId, ...summary };
  } catch (error) {
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
}

async function approveCurrentRun(userId = null) {
  const client = await pool.connect();
  // console.log("[approveCurrentRun] from:", JSON.stringify(fromStatus), "to:", toStatus);
  try {
    await client.query('BEGIN');

    const period = await getCurrentPeriod(client);
    if (!period) throw new Error('No current period');

    const run = await getCurrentRunRow(client, period.id);
    if (!run) throw new Error('No current run');

    if (run.status !== 'Draft') {
      const msg = `Cannot approve a run with status "${run.status}". Only Draft runs can be approved.`;
      console.warn('[payRun] approve blocked:', msg);
      return { ok: false, message: msg };
    }

    const v = await validateCurrentRun();
    if (!v.ok) {
      throw new Error('Validation failed: ' + v.errors.join(';'));
    }

    const { rows } = await client.query(`
      UPDATE pay_runs
      SET status = 'Approved',
      approved_by = $1,
      approved_at = NOW()
      WHERE id = $2
      RETURNING *;
      `, [userId, run.id]);

    await client.query('COMMIT');
    return { rows: rows[0], ok: true, message: 'Run approved successfully' };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error
  }
}

async function postCurrentRun(userId = null) {
  const client = await pool.connect();
  try {
    const runId = await getActiveRunId(client);
    if (!runId) throw new Error('No active run');

    const { rows } = await client.query(`
        SELECT status FROM pay_runs WHERE id = $1
      `, [runId]);

    const currentStatus = rows[0]?.status;

    if (currentStatus !== 'Approved') { throw new Error('Run must be Approved before it can be posted') }

    return updateCurrentRunStatus('Posted', userId);
  } finally {
    client.release();
  }
}

async function deleteCurrentItem(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // find the line + run
    const { rows } = await client.query(`
      SELECT l.pay_run_id, r.status
      FROM pay_run_items l
      JOIN pay_runs r ON r.id = l.pay_run_id
      WHERE l.id = $1
      FOR UPDATE
    `, [id]);

    if (!rows.length) {
      await client.query('ROLLBACK');
      return { ok: true }; // already gone
    }

    const { pay_run_id, status } = rows[0];
    if (status !== 'Draft') {
      throw new Error('Run not in Draft, cannot delete item');
    }

    await client.query(`DELETE FROM pay_run_items WHERE id = $1`, [id]);
    await recomputeRunSummary(client, pay_run_id);
    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getStpPreview() {
  const client = await pool.connect();
  try {
    const runId = await getActiveRunId(client);
    if (!runId) return { ok: false, message: 'No active run', employees: [], totals: {} };

    const { rows: lines } = await client.query(`
      SELECT e.employee_id, e.first_name, e.last_name,
             COALESCE(l.gross,0) AS gross, COALESCE(l.tax,0) AS tax, COALESCE(l.super,0) AS super
      FROM pay_run_items l
      JOIN employee e ON e.employee_id = l.employee_id
      WHERE l.pay_run_id = $1
    `, [runId]);

    const employees = lines.map(r => ({
      employee_id: r.employee_id,
      name: `${r.first_name} ${r.last_name}`,
      tfn: '000000000', // placeholder
      ytd: { gross: Number(r.gross), tax: Number(r.tax), super: Number(r.super) }
    }));
    const totals = employees.reduce((t, e) => ({
      gross: t.gross + e.ytd.gross,
      tax: t.tax + e.ytd.tax,
      super: t.super + e.ytd.super
    }), { gross: 0, tax: 0, super: 0 });

    return { ok: true, employees, totals };
  } finally {
    client.release();
  }
}

// ---- final exports (no stub overwrite)
module.exports = {
  getStpPreview,
  getCurrentRunSummary,
  getCurrentRunItems,   // returns ARRAY
  getCurrentRun,
  startCurrentRun, // fill in when ready
  recalcCurrentRun,
  approveCurrentRun,
  postCurrentRun,
  updateCurrentItem,      // (lineId, patch, userId)
  updateCurrentRunStatus,   // (status, userId)
  startForPeriod,
  validateCurrentRun,
  addCurrentRunItem,
  deleteCurrentItem,

};
