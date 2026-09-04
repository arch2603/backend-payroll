require("dotenv").config();
const pool = require('../db');
const dayjs = require('dayjs');
const tz = require('dayjs/plugin/timezone'); dayjs.extend(tz);
const utc = require('dayjs/plugin/utc'); dayjs.extend(utc);
const PDFDocument = require('pdfkit');
const { parse } = require('csv-parse/sync');

const REMITTER = process.env.BANK_REMITTER_NAME || '';
const EXPORT_TZ = process.env.PAYROLL_TIMEZONE || 'Pacific/Apia';
const PAYROLL_CURRENCY = process.env.PAYROLL_CURRENCY || 'WST';

const NPF_MEMBER_RATE = Number(process.env.NPF_MEMBER_RATE || '0.10');    // employee 10%
const NPF_EMPLOYER_RATE = Number(process.env.NPF_EMPLOYER_RATE || '0.10'); // employer 10%
const ACC_EMPLOYER_RATE = Number(process.env.ACC_EMPLOYER_RATE || '0.01');

for (const [name, rate] of Object.entries({ NPF_MEMBER_RATE, NPF_EMPLOYER_RATE, ACC_EMPLOYER_RATE })) {
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new Error(`${name} must be a decimal rate between 0 and 1`);
  }
}


const num = (v) => Number(v || 0);

const money = (v) => {
  const n = Number(v || 0);
  return n.toLocaleString('en', {
    style: 'currency',
    currency: PAYROLL_CURRENCY,
    minimumFractionDigits: 2,
  });
};

const THEME = {
  margins: { top: 40, right: 40, bottom: 40, left: 40 },
  rule: '#CCCCCC',
  cardRule: '#E6E6E6',
  textDim: '#555555',
  draft: '#FF9999',
};


async function recalcLine(client, id) {

  const { rows: lineRows } = await client.query(
    `
    SELECT id
    FROM pay_run_items
    WHERE id = $1
    `,
    [id]
  );

  if (lineRows.length === 0) return null;

  const { rows } = await client.query(
    `
    WITH src AS (
      SELECT
        pri.id,
        pri.employee_id,
        pri.pay_run_id,
        COALESCE(pri.hours, 0)           AS hours,
        COALESCE(pri.rate, 0)            AS rate,
        COALESCE(pri.allowance, 0)       AS allowance,
        COALESCE(pri.ot_15_hours, 0)     AS ot15,
        COALESCE(pri.ot_20_hours, 0)     AS ot20,
        COALESCE(pri.tax, 0)             AS tax,
        COALESCE(pri.deductions_total,0) AS ded
      FROM pay_run_items pri
      WHERE pri.id = $1
      FOR UPDATE
    ),
    base_calc AS (
      SELECT
        id,
        employee_id,
        pay_run_id,
        hours,
        rate,
        allowance,
        ot15,
        ot20,
        tax,
        ded,
        -- base + OT1.5 + OT2.0 + allowance
        ROUND(hours*rate + ot15*rate*1.5 + ot20*rate*2 + allowance, 2) AS gross
      FROM src
    ),
    samoan AS (
      SELECT
        id,
        employee_id,
        pay_run_id,
        hours,
        rate,
        allowance,
        ot15,
        ot20,
        tax,
        ded,
        gross,
        -- Samoa NPF & ACC contributions (hard-coded rates for now)
        ROUND(gross * $2, 2) AS npf_employee,
        ROUND(gross * $3, 2) AS npf_employer,
        ROUND(gross * $4, 2) AS acc_employer,
        -- NET = gross - tax - other deductions - employee NPF
        ROUND(gross - tax - ded - (gross * $2), 2) AS net
      FROM base_calc
    )
    UPDATE pay_run_items p
    SET
      gross         = s.gross,
      tax           = s.tax,
      net           = s.net,
      -- Persist Samoa contributions:
      npf_employee  = s.npf_employee,
      npf_employer  = s.npf_employer,
      acc_employer  = s.acc_employer,
      -- Keep legacy "super" in sync with employee NPF:
      "super"       = s.npf_employee,
      updated_at    = NOW()
    FROM samoan s
    WHERE p.id = s.id
      AND s.net >= 0
    RETURNING
      p.id AS line_id,
      p.employee_id,
      p.pay_run_id,
      p.hours,
      p.allowance,
      p.rate,
      p.gross,
      p.tax,
      p."super",
      p.npf_employee,
      p.npf_employer,
      p.acc_employer,
      p.deductions_total AS deductions,
      p.ot_15_hours      AS time_half,
      p.ot_20_hours      AS double_time,
      p.net,
      p.status
    `,
    [id, NPF_MEMBER_RATE, NPF_EMPLOYER_RATE, ACC_EMPLOYER_RATE]
  );

  if (!rows[0]) {
    const error = new Error(`Deductions exceed gross pay for pay-run item ${id}`);
    error.status = 400;
    throw error;
  }
  return rows[0];
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

async function writeAudit(client, { userId, action, entityType, entityId, beforeData = null, afterData = null }) {
  await client.query(
    `INSERT INTO audit_log
      (user_id, action, target, entity_type, entity_id, before_data, after_data, "timestamp")
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, now())`,
    [
      userId || null,
      action,
      `${entityType}:${entityId}`,
      entityType,
      String(entityId),
      beforeData ? JSON.stringify(beforeData) : null,
      afterData ? JSON.stringify(afterData) : null,
    ]
  );
}

async function getActiveRunId(client) {
  const q = await client.query(`
    SELECT r.id AS pay_run_id
    FROM pay_runs r
    JOIN pay_periods pp ON pp.id = r.period_id
    WHERE pp.is_current = TRUE
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
      run_id: run.id,
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
  search = String(search).trim().slice(0, 100);
  limit = Math.min(Math.max(Number.parseInt(limit, 10) || 25, 1), 200);
  offset = Math.max(Number.parseInt(offset, 10) || 0, 0);
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
      SELECT id AS pay_run_id, status
      FROM pay_runs
      WHERE period_id = $1
      ORDER BY id DESC
      LIMIT 1
    `, [periodId]);

    if (!runRows.length) {
      return { items: [], paging: { search, limit, offset, total: 0 } };
    }

    const runId = runRows[0].pay_run_id;
    const runStatus = runRows[0].status;

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
        l.ot_15_hours,
        l.ot_20_hours,
        l.allowance,
        l.gross,
        l.tax,
        l.deductions_total,
        l.super,
        l.net,
        l.status,
        l.npf_employee,
        l.npf_employer,
        l.acc_employer
        ,l.note
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
      ot_15_hours: Number(r.ot_15_hours ?? 0),
      ot_20_hours: Number(r.ot_20_hours ?? 0),
      allowance: Number(r.allowance ?? 0),
      gross: Number(r.gross ?? 0),
      tax: Number(r.tax ?? 0),
      deductions: Number(r.deductions_total ?? 0),
      super: Number(r.super ?? 0),
      npfEmployee: Number(r.npf_employee ?? 0),
      npfEmployer: Number(r.npf_employer ?? 0),
      accEmployer: Number(r.acc_employer ?? 0),
      net: Number(r.net ?? 0),
      status: r.status
      ,note: r.note
    }));

    return { status: runStatus, items, paging: { search, limit, offset, total } };
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

    return { run_id: runId, status, period: { start, end }, items, totals };
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
      SELECT l.*, r.status AS run_status
      FROM pay_run_items l
      JOIN pay_runs r     ON r.id = l.pay_run_id
      JOIN pay_periods pp ON pp.id = r.period_id
      WHERE l.id = $1 
        AND pp.is_current = TRUE
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
    if (realPatch.ot_15_hours !== undefined) {
      vals.push(patch.ot_15_hours);
      sets.push(`ot_15_hours = $${vals.length}`);
    }
    if (realPatch.ot_20_hours !== undefined) {
      vals.push(patch.ot_20_hours);
      sets.push(`ot_20_hours = $${vals.length}`);
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

    await writeAudit(client, {
      userId,
      action: _recalc ? 'PAY_RUN_ITEM_RECALCULATED' : 'PAY_RUN_ITEM_UPDATED',
      entityType: 'pay_run_item',
      entityId: id,
      beforeData: chk[0],
      afterData: updatedLine,
    });

    await client.query('COMMIT');
    return { line: updatedLine, summary };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function startForPeriod(periodId, userId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: p } = await client.query(`SELECT id FROM pay_periods WHERE id = $1`,
      [periodId]);

    if (!p.length) throw new Error("Period not found");

    const { rows } = await client.query(
      `INSERT INTO pay_runs (period_id, status, created_by, created_at)
       VALUES ($1, 'Draft', $2, now())
       ON CONFLICT (period_id) DO UPDATE
         SET period_id = EXCLUDED.period_id
       RETURNING id, period_id, status, created_at`,
      [periodId, userId]
    );

    await writeAudit(client, {
      userId,
      action: 'PAY_RUN_ENSURED_FOR_PERIOD',
      entityType: 'pay_run',
      entityId: rows[0].id,
      afterData: rows[0],
    });
    await client.query('COMMIT');
    return rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function validateRunWithClient(client, run) {
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
}

async function validateCurrentRun() {
  const client = await pool.connect();

  try {
    const period = await getCurrentPeriod(client);
    if (!period) {
      return { ok: false, errors: ['No current period found'] };
    }

    const run = await getCurrentRunRow(client, period.id);
    if (!run) {
      return { ok: false, errors: ['No pay run started for current period'] };
    }

    return validateRunWithClient(client, run);

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
    FOR UPDATE
  `, [periodId]);
  return rows[0] || null;
}

async function addCurrentRunItem(payload, userId = null) {
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
      note = null,
      ot_15_hours = 0,
      ot_20_hours = 0,
    } = payload;

    const { rows: insertedRows } = await client.query(`
      INSERT INTO pay_run_items
        (pay_run_id, employee_id, hours, rate, allowance, ot_15_hours, ot_20_hours,
         tax, deductions_total, "super", note)
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
      ot_15_hours,
      ot_20_hours,
      tax,
      deductions_total,
      0,
      note
    ]);
    const inserted = insertedRows[0];

    await recalcLine(client, inserted.id);

    const { rows: finalRows } = await client.query(
      `SELECT * FROM pay_run_items WHERE id = $1`,
      [inserted.id]
    );
    const finalLine = finalRows[0];

    await recomputeRunSummary(client, run.id);
    await writeAudit(client, {
      userId,
      action: 'PAY_RUN_ITEM_CREATED',
      entityType: 'pay_run_item',
      entityId: finalLine.id,
      afterData: finalLine,
    });
    await client.query('COMMIT');
    return finalLine;
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
    await client.query('BEGIN');
    const period = await getCurrentPeriod(client);
    if (!period) throw new Error('No current period');

    const { rows } = await client.query(`
      INSERT INTO pay_runs (period_id, status, created_by, created_at)
      VALUES ($1, 'Draft', $2, NOW())
      ON CONFLICT (period_id) DO UPDATE
        SET period_id = EXCLUDED.period_id
      RETURNING id, period_id, status
      `, [period.id, userId]);
    await writeAudit(client, {
      userId,
      action: 'PAY_RUN_ENSURED',
      entityType: 'pay_run',
      entityId: rows[0].id,
      afterData: rows[0],
    });
    await client.query('COMMIT');
    return rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function recalcCurrentRun(userId = null) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const runId = await getActiveRunId(client);
    if (!runId) {
      await client.query('ROLLBACK');
      return { ok: false, message: 'No active run' };
    }

    const { rows: runRows } = await client.query(
      `SELECT status FROM pay_runs WHERE id = $1 FOR UPDATE`,
      [runId]
    );
    if (runRows[0]?.status !== 'Draft') {
      throw new Error('Only a Draft pay run can be recalculated');
    }

    const { rows: lines } = await client.query(`
      SELECT id FROM pay_run_items WHERE pay_run_id = $1
      `, [runId]);

    for (const row of lines) {
      await recalcLine(client, row.id);
    }
    const summary = await recomputeRunSummary(client, runId);
    await writeAudit(client, {
      userId,
      action: 'PAY_RUN_RECALCULATED',
      entityType: 'pay_run',
      entityId: runId,
      afterData: summary,
    });
    await client.query('COMMIT');
    return { ok: true, run_id: runId, ...summary };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function approveCurrentRun(userId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const period = await getCurrentPeriod(client);
    if (!period) throw new Error('No current period');

    const run = await getCurrentRunRow(client, period.id);
    if (!run) throw new Error('No current run');

    if (run.status !== 'Draft') {
      const msg = `Cannot approve a run with status "${run.status}". Only Draft runs can be approved.`;
      await client.query('ROLLBACK');
      return { ok: false, message: msg };
    }

    const v = await validateRunWithClient(client, run);
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

    await client.query(
      `INSERT INTO payslips (pay_run_item_id, employee_id, period_id, created_at)
       SELECT item.id, item.employee_id, $2, now()
       FROM pay_run_items item
       WHERE item.pay_run_id = $1
       ON CONFLICT (pay_run_item_id) DO NOTHING`,
      [run.id, period.id]
    );

    await writeAudit(client, {
      userId,
      action: 'PAY_RUN_APPROVED',
      entityType: 'pay_run',
      entityId: run.id,
      beforeData: { status: run.status },
      afterData: { status: 'Approved' },
    });
    await client.query('COMMIT');
    return { run: rows[0], ok: true, message: 'Run approved successfully' };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function transitionCurrentRun({ expectedStatus, targetStatus, userId, action }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const period = await getCurrentPeriod(client);
    if (!period) throw new Error('No current period');

    const run = await getCurrentRunRow(client, period.id);
    if (!run) throw new Error('No current pay run');
    if (run.status !== expectedStatus) {
      throw new Error(`Run must be ${expectedStatus} before it can become ${targetStatus}`);
    }

    if (targetStatus === 'Draft') {
      const { rows: distributed } = await client.query(
        `SELECT count(*)::int AS count
         FROM payslips slip
         JOIN pay_run_items item ON item.id = slip.pay_run_item_id
         WHERE item.pay_run_id = $1
           AND (slip.printed_at IS NOT NULL OR slip.emailed_at IS NOT NULL)`,
        [run.id]
      );
      if (distributed[0].count > 0) {
        throw new Error('A distributed payslip exists; this pay run cannot be reopened');
      }
      await client.query(
        `DELETE FROM payslips
         WHERE pay_run_item_id IN (
           SELECT id FROM pay_run_items WHERE pay_run_id = $1
         )`,
        [run.id]
      );
    }

    const { rows } = await client.query(
      `UPDATE pay_runs
          SET status = $1,
              approved_by = CASE WHEN $1 = 'Draft' THEN NULL ELSE approved_by END,
              approved_at = CASE WHEN $1 = 'Draft' THEN NULL ELSE approved_at END,
              posted_by = CASE WHEN $1 = 'Posted' THEN $2 ELSE NULL END,
              posted_at = CASE WHEN $1 = 'Posted' THEN now() ELSE NULL END
        WHERE id = $3
        RETURNING *`,
      [targetStatus, userId || null, run.id]
    );

    await writeAudit(client, {
      userId,
      action,
      entityType: 'pay_run',
      entityId: run.id,
      beforeData: { status: expectedStatus },
      afterData: { status: targetStatus },
    });
    await client.query('COMMIT');
    return { ok: true, run: rows[0] };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function postCurrentRun(userId = null) {
  return transitionCurrentRun({
    expectedStatus: 'Approved',
    targetStatus: 'Posted',
    userId,
    action: 'PAY_RUN_POSTED',
  });
}

async function reopenCurrentRun(userId = null) {
  return transitionCurrentRun({
    expectedStatus: 'Approved',
    targetStatus: 'Draft',
    userId,
    action: 'PAY_RUN_REOPENED',
  });
}

async function deleteCurrentItem(id, userId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // find the line + run
    const { rows } = await client.query(`
      SELECT l.*, r.status AS run_status
      FROM pay_run_items l
      JOIN pay_runs r ON r.id = l.pay_run_id
      WHERE l.id = $1
      FOR UPDATE
    `, [id]);

    if (!rows.length) {
      await client.query('ROLLBACK');
      return { ok: true }; // already gone
    }

    const { pay_run_id, run_status: runStatus } = rows[0];
    if (runStatus !== 'Draft') {
      throw new Error('Run not in Draft, cannot delete item');
    }

    await client.query(`DELETE FROM pay_run_items WHERE id = $1`, [id]);
    await recomputeRunSummary(client, pay_run_id);
    await writeAudit(client, {
      userId,
      action: 'PAY_RUN_ITEM_DELETED',
      entityType: 'pay_run_item',
      entityId: id,
      beforeData: rows[0],
    });
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

async function buildBankCsvForCurrentRun({ runId: explicitRunId } = {}) {
  const client = await pool.connect();
  try {
    const runId = explicitRunId ?? (await getActiveRunId(client));

    if (!runId) {
      return { filename: 'bank.csv', csv: '', warnings: ['No active run'] };
    }
    const { meta, lines } = await getRunMetaAndLinesForBank(client, runId);

    if (!meta) return { filename: 'bank.csv', csv: '', warnings: ['No such run'] };
    if (!['Approved', 'Posted'].includes(meta.status)) {
      return {
        filename: `bank-run-${meta.run_id}.csv`,
        csv: '',
        warnings: ['Bank exports require an Approved or Posted pay run'],
      };
    }

    const { usable, warnings } = splitUsableAndWarnings(lines);

    if (usable.length === 0) {
      return { filename: `bank-run-${meta.run_id}.csv`, csv: '', warnings };
    }

    const columns = ['bsb', 'account_number', 'account_name', 'amount_cents', 'reference'];
    const rows = usable.map(u => ({
      bsb: u.bsb,
      account_number: u.account_number,
      account_name: `${u.first_name} ${u.last_name}`,
      amount_cents: Math.round(Number(u.net) * 100),
      reference: `PAY-${meta.run_id}`
    }));

    const csv = toCsv({ columns, rows });
    return { filename: `bank-run-${meta.run_id}.csv`, csv, warnings };
  } finally {
    client.release();
  }
}

async function getRunMetaAndLinesForBank(client, runId) {
  // You may rename columns to match your schema if different.
  const metaQ = await client.query(`
    SELECT r.id as run_id, r.status,
           pp.period_start, pp.period_end
    FROM pay_runs r
    JOIN pay_periods pp ON pp.id = r.period_id
    WHERE r.id = $1
    LIMIT 1
  `, [runId]);

  const linesQ = await client.query(`
    SELECT 
      l.id AS line_id,
      e.employee_id,
      e.first_name, e.last_name,
      bank_pick.bsb,
      bank_pick.account_number,
      bank_pick.bank_code,
      COALESCE(l.net,0)             AS net,
      COALESCE(l.gross,0)           AS gross,
      COALESCE(l.tax,0)             AS tax,
      COALESCE(l.super,0)           AS super,
      COALESCE(l.deductions_total,0) AS deductions
    FROM pay_run_items l
    JOIN employee e
      ON e.employee_id = l.employee_id
    LEFT JOIN LATERAL (
      SELECT ebc.bsb, ebc.account_number, ebc.bank_code
      FROM employee_bank_accounts ebc
      WHERE ebc.employee_id = e.employee_id
      ORDER BY 
        CASE WHEN ebc.is_primary IS TRUE THEN 0 ELSE 1 END,  -- prefer primary
        ebc.id ASC
      LIMIT 1
    ) AS bank_pick ON TRUE
    WHERE l.pay_run_id = $1
    ORDER BY e.last_name, e.first_name, l.id
  `, [runId]);

  return { meta: metaQ.rows[0], lines: linesQ.rows };
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildBankCsvRows(meta, lines) {

  const header = [
    'date', 'remitter', 'method', 'employee_id', 'employee_name', 'bsb', 'account', 'amount', 'reference'
  ];

  const payDate = dayjs().tz(EXPORT_TZ).format('YYYY-MM-DD');
  const rows = [header];

  for (const r of lines) {
    const hasBank = !!(r.bank_bsb && r.bank_account);
    const method = hasBank ? 'EFT' : 'CASH';
    const name = `${r.first_name} ${r.last_name}`.trim();
    const reference = r.bank_reference || `PAY-${meta.run_id}`;
    // Round to cents in CSV string
    const amount = (Number(r.net || 0)).toFixed(2);

    rows.push([
      payDate,
      REMITTER,
      method,
      r.employee_id,
      name,
      hasBank ? String(r.bank_bsb) : '',
      hasBank ? String(r.bank_account) : '',
      amount,
      reference
    ]);
  }
  return rows.map(row => row.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

async function getRunMetaAndLinesForPayslips(client, runId) {
  const metaQ = await client.query(`
    SELECT r.id as run_id, r.status,
           pp.period_start, pp.period_end
    FROM pay_runs r
    JOIN pay_periods pp ON pp.id = r.period_id
    WHERE r.id = $1
  `, [runId]);

  const linesQ = await client.query(`
    SELECT 
      l.id as line_id,
      e.employee_id, e.first_name, e.last_name,
      e.email, e.employee_number, e.position,
      bank_pick.bsb AS bank_bsb,
      bank_pick.account_number AS bank_account,
      COALESCE(l.hours,0)        as hours,
      COALESCE(l.rate,0)         as rate,
      COALESCE(l.ot_15_hours,0)  as ot_15_hours,
      COALESCE(l.ot_20_hours,0)  as ot_20_hours,
      COALESCE(l.allowance,0)    as allowance,
      COALESCE(l.gross,0)        as gross,
      COALESCE(l.tax,0)          as tax,
      COALESCE(l.super,0)        as super,
      COALESCE(l.deductions_total,0) as deductions_total,
      COALESCE(l.net,0)          as net,
      COALESCE(l.npf_employee,0)    as npf_employee,
      COALESCE(l.npf_employer,0)    as npf_employer,
      COALESCE(l.acc_employer,0)    as acc_employer,
      l.note
    FROM pay_run_items l
    JOIN employee e ON e.employee_id = l.employee_id
    LEFT JOIN LATERAL (
      SELECT ebc.bsb, ebc.account_number
      FROM employee_bank_accounts ebc
      WHERE ebc.employee_id = e.employee_id
        AND ebc.is_active
      ORDER BY ebc.is_primary DESC, ebc.id
      LIMIT 1
    ) bank_pick ON TRUE
    WHERE l.pay_run_id = $1
    ORDER BY e.last_name, e.first_name, l.id
  `, [runId]);

  return { meta: metaQ.rows[0], lines: linesQ.rows };
}


function n(val) {
  const v = Number(val ?? 0);
  return Number.isFinite(v) ? v : 0;
}

function safeFilename(s) {
  return String(s || '')
    .replace(/[^\w.\-#()@\s]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

async function streamPayslipsPdfForCurrentRun(res) {
  if (!res) throw new Error('Response stream is required');
  const client = await pool.connect();
  try {
    const runId = await getActiveRunId(client);
    if (!runId) { res.status(400).json({ message: 'No active run to export' }); return; }
    return streamPayslipsPdfForRunById(runId, res);
  } finally {
    client.release();
  }
}

async function streamPayslipsPdfForRunById(runId, res) {

  if (!res) throw new Error('Response stream is required');

  if (!Number.isFinite(Number(runId)) || Number(runId) <= 0) {
    res.status(400).json({ message: 'Invalid run id' });
    return;
  }

  const client = await pool.connect();

  try {

    const { meta, lines } = await getRunMetaAndLinesForPayslips(client, runId);
    if (!meta) {
      res.status(404).json({ message: `Run ${runId} not found` });
      return;
    }

    //Header Payslip
    const LOGO_PATH = process.env.COMPANY_LOGO_PATH; // e.g. '/mnt/assets/logo.png'
    const COMPANY_ABN = process.env.COMPANY_ABN || '';
    const COMPANY_NAME = process.env.COMPANY_NAME || '';
    const remitter = (typeof REMITTER !== 'undefined' && REMITTER) ? REMITTER : '';
    const period = `${dayjs(meta.period_start).format('DD MMM YYYY')} – ${dayjs(meta.period_end).format('DD MMM YYYY')}`;
    const payDate = meta.pay_date ? dayjs(meta.pay_date).format('DD MMM YYYY') : null;
    const curStatus = String(meta.status || '').toLocaleLowerCase();
    const isDraft = !['approved', 'posted'].includes(curStatus);

    if (!lines.length) {
      const fileName = `payslips-run-${meta.run_id}-empty.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      const doc = new PDFDocument({ size: 'A4', margins: THEME.margins });
      doc.pipe(res);
      doc.fontSize(14).text(`No payslips to generate for run #${meta.run_id}.`, 40, 120);
      doc.end();
      return;
    }

    // 4) Set headers for normal case – BEFORE creating the PDF doc
    const fileName = `payslips-run-${meta.run_id}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'no-store');

    //Initialising and creating Payslip doc
    const doc = new PDFDocument({
      autoFirstPage: false,
      size: 'A4',
      margins: THEME.margins,
      bufferPages: true
    });
    doc.on('error', (err) => { try { res.destroy(err); } catch (_) { } });
    doc.pipe(res);

    // 6) Layout constants & page helpers – place RIGHT AFTER doc creation
    let X_LEFT, X_RIGHT, COL_GAP, COL_LEFT, COL_RIGHT, COL_WIDTH, RULE_COLOR;
    const SAFE_TOP_CONST = 130;

    let streaming = true;
    const stopStreaming = () => {
      if (!streaming) return;
      streaming = false;
      try { doc.unpipe(res); } catch { }
      try { doc.end(); } catch { }
    };

    res.on('finish', stopStreaming); // response fully sent
    res.on('close', stopStreaming);  // client aborted
    res.on('error', stopStreaming);

    doc.on('error', () => {          // if PDFKit errors, stop writing
      stopStreaming();
    });

    function watermarkDraft() {
      if (!isDraft) return;
      const cx = (X_LEFT + X_RIGHT) / 2;
      const cy = doc.page.height / 2;
      doc.save()
        .rotate(-30, { origin: [cx, cy] })
        .fontSize(80)
        .fillColor(THEME.draft)
        .opacity(0.5)
        .text('DRAFT', cx - 180, cy - 40, { width: 360, align: 'center' })
        .opacity(1)
        .fillColor('black')
        .restore();
    }

    function drawHeader() {
      const topY = 40;
      const headerW = X_RIGHT - X_LEFT;
      const logoSize = 42;

      if (LOGO_PATH) {
        try { doc.image(LOGO_PATH, X_LEFT, topY, { width: logoSize, height: logoSize, fit: [logoSize, logoSize] }); } catch (_) { }
      }

      const headerX = LOGO_PATH ? X_LEFT + logoSize + 10 : X_LEFT;

      doc.fontSize(16).font('Helvetica-Bold').text(COMPANY_NAME || ' ', headerX, topY, { width: headerW - (headerX - X_LEFT), align: 'left' });
      doc.moveDown(0.2);
      doc.fontSize(9).font('Helvetica').fillColor('#444')
        .text(remitter ? `Remitter: ${remitter}` : '')
        .text(COMPANY_ABN ? `ABN: ${COMPANY_ABN}` : '')
        .fillColor('black');

      const sub = [
        `Pay Run: #${meta.run_id}`,
        `Status: ${meta.status || '—'}`,
        `Period: ${period}`,
        ...(payDate ? [`Pay Date: ${payDate}`] : [])
      ].join('   •   ');

      doc.fontSize(10).text(sub, X_LEFT, doc.y + 4, { width: headerW, align: 'left' });

      doc.moveTo(X_LEFT, doc.y + 6).lineWidth(0.7).strokeColor(RULE_COLOR).lineTo(X_RIGHT, doc.y + 6).stroke().strokeColor('black');
    }

    function drawFooter() {
      const bottom = doc.page.height - doc.page.margins.bottom;
      const ts = `${dayjs().tz(EXPORT_TZ).format('DD MMM YYYY HH:mm')} ${EXPORT_TZ}`;
      const range = doc.bufferedPageRange(); // { start, count }
      doc.fontSize(9).fillColor('#666')
        .text(`Generated: ${ts}`, X_LEFT, bottom - 14, { width: (X_RIGHT - X_LEFT) / 2, align: 'left' })

        .fillColor('black');
    }

    function refreshLayoutForCurrentPage() {
      // now doc.page definitely exists
      X_LEFT = doc.page.margins.left;
      X_RIGHT = doc.page.width - doc.page.margins.right;
      COL_GAP = 24;
      COL_LEFT = X_LEFT;
      COL_RIGHT = X_LEFT + ((X_RIGHT - X_LEFT) / 2) + COL_GAP / 2;
      COL_WIDTH = ((X_RIGHT - X_LEFT) / 2) - (COL_GAP / 2);
      RULE_COLOR = THEME.rule;
    }

    const SAFE_BOTTOM = () => doc.page.height - doc.page.margins.bottom - 50;

    function beginPayslipPage() {
      doc.addPage();
      refreshLayoutForCurrentPage();       // ✅ set X_LEFT/X_RIGHT/etc now that page exists
      watermarkDraft();
      drawHeader();
      drawFooter();
      return SAFE_TOP_CONST;
    }

    function ensureSpace(currentY, need = 40) {
      if (currentY + need > SAFE_BOTTOM()) return beginPayslipPage();
      return currentY;
    }

    function sectionCard(title, x, y) {
      const paddingX = 10;
      const paddingY = 6;
      const textY = y + paddingY;
      const boxHeight = 22 + paddingY * 2;
      doc.roundedRect(x - 8, y, COL_WIDTH + 16, boxHeight, 6).lineWidth(0.6).strokeColor(THEME.cardRule).stroke().strokeColor('black');
      doc.fontSize(11).font('Helvetica-Bold').text(title, x + paddingX, textY);
      return y + boxHeight + 4; // return y to start items
    }

    function lineItem(label, amount, x, y) {
      const leftWidth = Math.floor(COL_WIDTH * 0.6);
      doc.fontSize(10).font('Helvetica').text(label, x, y + 8, { width: leftWidth });
      doc.font('Helvetica').text(money(amount), x + leftWidth + 8, y + 8, { width: COL_WIDTH - leftWidth - 8, align: 'right' });
      return doc.y;
    }

    function drawTotalsPanel(gross, tax, npfEmployee, otherDeductions, net) {
      const h = 112;
      const y0 = doc.y + 10;
      doc.roundedRect(X_LEFT, y0, X_RIGHT - X_LEFT, h, 6).lineWidth(0.8).strokeColor(RULE_COLOR).stroke().strokeColor('black');

      const left = X_LEFT + 12;
      const mid = X_LEFT + (X_RIGHT - X_LEFT) / 2;
      const right = X_RIGHT - 12;

      doc.font('Helvetica-Bold').fontSize(11);
      doc.text('Gross', left, y0 + 10);
      doc.text('Tax', left, y0 + 30);
      doc.text('NPF (employee)', left, y0 + 50);
      doc.text('Other deductions', left, y0 + 70);
      doc.text('NET PAY', left, y0 + 92);

      doc.font('Helvetica-Bold').text(money(gross), mid, y0 + 10, { width: right - mid, align: 'right' });
      doc.font('Helvetica').text(money(tax), mid, y0 + 30, { width: right - mid, align: 'right' });
      doc.font('Helvetica').text(money(npfEmployee), mid, y0 + 50, { width: right - mid, align: 'right' });
      doc.text(money(otherDeductions), mid, y0 + 70, { width: right - mid, align: 'right' });
      doc.font('Helvetica-Bold').fontSize(14).text(money(net), mid, y0 + 90, { width: right - mid, align: 'right' });

      return y0 + h;
    }

    function drawYtdPanel(ytd) {
      const { gross = 0, tax = 0, superToFund = 0, net = 0 } = ytd || {};
      const h = 70;
      const y0 = doc.y + 10;
      doc.roundedRect(X_LEFT, y0, X_RIGHT - X_LEFT, h, 6).lineWidth(0.8).strokeColor('#E6E6E6').stroke().strokeColor('black');

      const left = X_LEFT + 12, mid = X_LEFT + (X_RIGHT - X_LEFT) / 2, right = X_RIGHT - 12;
      doc.font('Helvetica-Bold').fontSize(11).text('Year-to-Date', left, y0 + 10);
      doc.font('Helvetica').fontSize(10)
        .text(`Gross YTD`, left, y0 + 30)
        .text(`Tax YTD`, left, y0 + 45)
        .text(`Super (to fund) YTD`, left, y0 + 60);

      doc.text(money(gross), mid, y0 + 30, { width: right - mid, align: 'right' })
        .text(money(tax), mid, y0 + 45, { width: right - mid, align: 'right' })
        .text(money(superToFund), mid, y0 + 60, { width: right - mid, align: 'right' });

      return y0 + h;
    }

    // 8) PER-EMPLOYEE PAGES – place AFTER helpers
    for (const r of lines) {
      let y = beginPayslipPage();

      // Employee identity block (top of body)
      const fullName = `${r.first_name || ''} ${r.last_name || ''}`.trim() || 'Employee';
      y = ensureSpace(y, 40);
      doc.fontSize(12).font('Helvetica-Bold').text(fullName, X_LEFT, y, { width: X_RIGHT - X_LEFT, align: 'left' });
      y = doc.y + 2;

      const maskedBsb = r.bank_bsb ? `${String(r.bank_bsb).slice(0, 3)}-${String(r.bank_bsb).slice(3)}` : null;
      const maskedAcct = r.bank_account ? `•••• ${String(r.bank_account).slice(-4)}` : null;
      const bankLine = (maskedBsb || maskedAcct) ? [`BSB: ${maskedBsb || '—'}`, `Acct: ${maskedAcct || '—'}`].join('   •   ') : null;

      const idParts = [
        r.employee_number ? `Employee #: ${r.employee_number}` : `Employee ID: ${r.employee_id}`,
        r.position ? `Position: ${r.position}` : null,
        r.email || null,
        bankLine
      ].filter(Boolean);

      doc.fontSize(10).fillColor(THEME.textDim).text(idParts.join('   •   '), X_LEFT, y).fillColor('black');
      y = doc.y + 8;

      // Two columns (EARNINGS / DEDUCTIONS)
      let yLeft = sectionCard('EARNINGS', COL_LEFT, y);
      let yRight = sectionCard('DEDUCTIONS', COL_RIGHT, y);   // NOTE: only once; no duplicate header

      const hours = num(r.hours);
      const rate = num(r.rate);
      const ot15h = num(r.ot_15_hours);
      const ot20h = num(r.ot_20_hours);
      const allowance = num(r.allowance);
      const payeTax = num(r.tax);
      const otherDed = num(r.deductions_total);
      const npfEmployee = num(r.npf_employee ?? r.super ?? 0); // employee NPF
      const npfEmployer = num(r.npf_employer ?? 0);            // employer NPF
      const accEmployer = num(r.acc_employer ?? 0);            // employer ACC

      const base = hours * rate;
      if (hours > 0) yLeft = lineItem(`Base ${hours.toFixed(2)} h × ${money(rate)}`, base, COL_LEFT, yLeft);
      if (ot15h > 0) yLeft = lineItem(`Overtime 1.5   ${ot15h.toFixed(2)} h × ${money(rate)} × 1.5`, ot15h * rate * 1.5, COL_LEFT, yLeft);
      if (ot20h > 0) yLeft = lineItem(`Overtime 2.0   ${ot20h.toFixed(2)} h × ${money(rate)} × 2.0`, ot20h * rate * 2.0, COL_LEFT, yLeft);
      if (allowance > 0) yLeft = lineItem('Allowance', allowance, COL_LEFT, yLeft);

      yRight = lineItem('Tax (PAYE)', payeTax, COL_RIGHT, yRight);

      if (npfEmployee > 0) {
        yRight = lineItem('NPF (employee)', npfEmployee, COL_RIGHT, yRight);
      }

      if (otherDed > 0) {
        yRight = lineItem('Other deductions', otherDed, COL_RIGHT, yRight);
      }


      // Totals panel (ensure space first)
      doc.y = ensureSpace(Math.max(yLeft, yRight) + 6, 100);
      const gross = num(r.gross);
      const net = num(r.net);
      doc.y = drawTotalsPanel(gross, payeTax, npfEmployee, otherDed, net);

      if (npfEmployer > 0 || accEmployer > 0) {
        doc.y = ensureSpace(doc.y + 8, 55);
        doc.font('Helvetica-Bold').fontSize(10)
          .text('Employer contributions (not deducted from net pay)', X_LEFT, doc.y);
        if (npfEmployer > 0) {
          doc.font('Helvetica').text(`NPF employer: ${money(npfEmployer)}`, X_LEFT, doc.y + 3);
        }
        if (accEmployer > 0) {
          doc.font('Helvetica').text(`ACC employer: ${money(accEmployer)}`, X_LEFT, doc.y + 3);
        }
      }

      // Optional YTD block
      if (r.ytd) {
        doc.y = ensureSpace(doc.y + 10, 80);
        drawYtdPanel(r.ytd);
      }

      // Optional Note
      if (r.note) {
        doc.y = ensureSpace(doc.y + 8, 60);
        const noteTop = doc.y;
        const noteW = X_RIGHT - X_LEFT;
        doc.roundedRect(X_LEFT - 6, noteTop - 6, noteW + 12, 50, 6).lineWidth(0.6).strokeColor('#EDEDED').stroke().strokeColor('black');
        doc.font('Helvetica-Bold').fontSize(10).text('Note', X_LEFT, noteTop);
        doc.font('Helvetica').fontSize(10).text(String(r.note), X_LEFT, doc.y + 2, { width: noteW });
      }
    }

    const range = doc.bufferedPageRange(); // { start, count }
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);

      if (typeof refreshLayoutForCurrentPage === 'function') refreshLayoutForCurrentPage();

      const bottom = doc.page.height - doc.page.margins.bottom;
      const current = (i - range.start) + 1;
      const total = range.count;

      doc.fontSize(9).fillColor('#666')
        .text(`Page ${current} of ${total}`, X_LEFT + (X_RIGHT - X_LEFT) / 2, bottom - 14, {
          width: (X_RIGHT - X_LEFT) / 2,
          align: 'right'
        })
        .fillColor('black');
    }

    doc.end();

  } catch (err) {
    if (!res.headersSent) {
      try {
        res.status(500).json({ message: 'Failed to generate payslips PDF' });
      } catch { }
    }
    console.error('[payslips] generation failed:', err);
  } finally {
    client.release();
  }
}


function drawPayslipInLine(doc, data) {

  const { run, employee, item } = data;

  const LOGO_PATH = process.env.COMPANY_LOGO_PATH || '';
  const COMPANY_ABN = process.env.COMPANY_ABN || '';
  const COMPANY_NAME = process.env.COMPANY_NAME || '';
  const remitter = (typeof REMITTER !== 'undefined' && REMITTER) ? REMITTER : '';

  const period = `${dayjs(run.period_start).format('DD MMM YYYY')} – ${dayjs(run.period_end).format('DD MMM YYYY')}`;
  const payDate = run.pay_date ? dayjs(run.pay_date).format('DD MMM YYYY') : null;
  const curStatus = String(run.status || '').toLowerCase();
  const isDraft = !['approved', 'posted'].includes(curStatus);

  // --- Layout constants & helpers ---
  let X_LEFT, X_RIGHT, COL_GAP, COL_LEFT, COL_RIGHT, COL_WIDTH, RULE_COLOR;
  const SAFE_TOP_CONST = 130;

  function refreshLayoutForCurrentPage() {
    X_LEFT = doc.page.margins.left;
    X_RIGHT = doc.page.width - doc.page.margins.right;
    COL_GAP = 24;
    COL_LEFT = X_LEFT;
    COL_RIGHT = X_LEFT + ((X_RIGHT - X_LEFT) / 2) + COL_GAP / 2;
    COL_WIDTH = ((X_RIGHT - X_LEFT) / 2) - (COL_GAP / 2);
    RULE_COLOR = THEME.rule;
  }

  const SAFE_BOTTOM = () => doc.page.height - doc.page.margins.bottom - 50;

  function watermarkDraft() {
    if (!isDraft) return;
    const cx = (X_LEFT + X_RIGHT) / 2;
    const cy = doc.page.height / 2;
    doc.save()
      .rotate(-30, { origin: [cx, cy] })
      .fontSize(80)
      .fillColor(THEME.draft)
      .opacity(0.5)
      .text('DRAFT', cx - 180, cy - 40, { width: 360, align: 'center' })
      .opacity(1)
      .fillColor('black')
      .restore();
  }

  function drawHeader() {
    const topY = 40;
    const headerW = X_RIGHT - X_LEFT;
    const logoSize = 42;

    if (LOGO_PATH) {
      try {
        doc.image(LOGO_PATH, X_LEFT, topY, {
          width: logoSize,
          height: logoSize,
          fit: [logoSize, logoSize],
        });
      } catch (_) { /* ignore logo errors */ }
    }

    const headerX = LOGO_PATH ? X_LEFT + logoSize + 10 : X_LEFT;

    doc
      .fontSize(16).font('Helvetica-Bold')
      .text(COMPANY_NAME || ' ', headerX, topY, {
        width: headerW - (headerX - X_LEFT),
        align: 'left',
      });

    doc.moveDown(0.2);
    doc.fontSize(9).font('Helvetica').fillColor('#444');
    if (remitter) doc.text(`Remitter: ${remitter}`);
    if (COMPANY_ABN) doc.text(`ABN: ${COMPANY_ABN}`);
    doc.fillColor('black');

    const sub = [
      `Pay Run: #${run.run_id}`,
      `Status: ${run.status || '—'}`,
      `Period: ${period}`,
      ...(payDate ? [`Pay Date: ${payDate}`] : []),
    ].join('   •   ');

    doc.fontSize(10).text(sub, X_LEFT, doc.y + 4, { width: headerW, align: 'left' });

    doc
      .moveTo(X_LEFT, doc.y + 6)
      .lineWidth(0.7)
      .strokeColor(RULE_COLOR)
      .lineTo(X_RIGHT, doc.y + 6)
      .stroke()
      .strokeColor('black');
  }

  function drawFooter() {
    const bottom = doc.page.height - doc.page.margins.bottom;
    const ts = `${dayjs().tz(EXPORT_TZ).format('DD MMM YYYY HH:mm')} ${EXPORT_TZ}`;
    doc.fontSize(9).fillColor('#666')
      .text(`Generated: ${ts}`, X_LEFT, bottom - 14, {
        width: (X_RIGHT - X_LEFT) / 2,
        align: 'left',
      })
      .fillColor('black');

    // Single page → page 1 of 1
    doc.fontSize(9).fillColor('#666')
      .text(`Page 1 of 1`, X_LEFT + (X_RIGHT - X_LEFT) / 2, bottom - 14, {
        width: (X_RIGHT - X_LEFT) / 2,
        align: 'right',
      })
      .fillColor('black');
  }

  function ensureSpace(currentY, need = 40) {
    // For inline single page we *could* add more pages, but realistically one payslip fits on one page.
    // If ever needed, you can call doc.addPage() here.
    if (currentY + need > SAFE_BOTTOM()) {
      // Optional: doc.addPage(); refreshLayoutForCurrentPage(); drawHeader(); drawFooter();
      // For now just clamp.
      return SAFE_BOTTOM() - need;
    }
    return currentY;
  }

  function sectionCard(title, x, y) {
    const paddingX = 10;
    const paddingY = 6;
    const textY = y + paddingY;
    const boxHeight = 22 + paddingY * 2;

    doc
      .roundedRect(x - 8, y, COL_WIDTH + 16, boxHeight, 6)
      .lineWidth(0.6)
      .strokeColor(THEME.cardRule)
      .stroke()
      .strokeColor('black');

    doc
      .fontSize(11)
      .font('Helvetica-Bold')
      .text(title, x + paddingX, textY);

    return y + boxHeight + 4;
  }

  function lineItem(label, amount, x, y) {
    const leftWidth = Math.floor(COL_WIDTH * 0.6);
    doc
      .fontSize(10)
      .font('Helvetica')
      .text(label, x, y + 8, { width: leftWidth });

    doc
      .font('Helvetica')
      .text(money(amount), x + leftWidth + 8, y + 8, {
        width: COL_WIDTH - leftWidth - 8,
        align: 'right',
      });

    return doc.y;
  }

  function drawTotalsPanel(gross, tax, npfEmployee, otherDeductions, net) {
    const h = 112;
    const y0 = doc.y + 10;

    doc
      .roundedRect(X_LEFT, y0, X_RIGHT - X_LEFT, h, 6)
      .lineWidth(0.8)
      .strokeColor(RULE_COLOR)
      .stroke()
      .strokeColor('black');

    const left = X_LEFT + 12;
    const mid = X_LEFT + (X_RIGHT - X_LEFT) / 2;
    const right = X_RIGHT - 12;

    doc.font('Helvetica-Bold').fontSize(11);
    doc.text('Gross', left, y0 + 10);
    doc.text('Tax', left, y0 + 30);
    doc.text('NPF (employee)', left, y0 + 50);
    doc.text('Other deductions', left, y0 + 70);
    doc.text('NET PAY', left, y0 + 92);

    doc
      .font('Helvetica-Bold')
      .text(money(gross), mid, y0 + 10, { width: right - mid, align: 'right' });
    doc
      .font('Helvetica')
      .text(money(tax), mid, y0 + 30, { width: right - mid, align: 'right' });
    doc
      .font('Helvetica')
      .text(money(npfEmployee), mid, y0 + 50, {
        width: right - mid,
        align: 'right',
      });
    doc.font('Helvetica').text(money(otherDeductions), mid, y0 + 70, {
      width: right - mid,
      align: 'right',
    });
    doc
      .font('Helvetica-Bold')
      .fontSize(14)
      .text(money(net), mid, y0 + 90, {
        width: right - mid,
        align: 'right',
      });

    return y0 + h;
  }

  // --- START PAGE ---
  refreshLayoutForCurrentPage();
  watermarkDraft();
  drawHeader();
  drawFooter();

  let y = SAFE_TOP_CONST;

  // Employee identity
  const fullName = `${employee.first_name || ''} ${employee.last_name || ''}`.trim() || 'Employee';

  y = ensureSpace(y, 40);
  doc
    .fontSize(12)
    .font('Helvetica-Bold')
    .text(fullName, X_LEFT, y, {
      width: X_RIGHT - X_LEFT,
      align: 'left',
    });
  y = doc.y + 2;

  const idParts = [
    employee.employee_number ? `Employee #: ${employee.employee_number}` : `Employee ID: ${employee.employee_id}`,
    employee.email || null,
  ].filter(Boolean);

  doc
    .fontSize(10)
    .fillColor(THEME.textDim)
    .text(idParts.join('   •   '), X_LEFT, y)
    .fillColor('black');

  y = doc.y + 8;

  // Two columns (EARNINGS / DEDUCTIONS)
  let yLeft = sectionCard('EARNINGS', COL_LEFT, y);
  let yRight = sectionCard('DEDUCTIONS', COL_RIGHT, y);

  const hours = num(item.hours);
  const rate = num(item.rate || item.effective_hourly_rate);
  const ot15h = num(item.ot_15_hours);
  const ot20h = num(item.ot_20_hours);
  const allowance = num(item.allowance);
  const payeTax = num(item.tax);
  const otherDed = num(item.deductions_total || item.deductions);
  const npfEmployee = num(item.npf_employee ?? item.super ?? 0);
  const npfEmployer = num(item.npf_employer ?? 0);
  const accEmployer = num(item.acc_employer ?? 0);

  const base = hours * rate;
  if (hours > 0) {
    yLeft = lineItem(`Base ${hours.toFixed(2)} h × ${money(rate)}`, base, COL_LEFT, yLeft);
  }
  if (ot15h > 0) {
    yLeft = lineItem(
      `Overtime 1.5   ${ot15h.toFixed(2)} h × ${money(rate)} × 1.5`,
      ot15h * rate * 1.5,
      COL_LEFT,
      yLeft
    );
  }
  if (ot20h > 0) {
    yLeft = lineItem(
      `Overtime 2.0   ${ot20h.toFixed(2)} h × ${money(rate)} × 2.0`,
      ot20h * rate * 2.0,
      COL_LEFT,
      yLeft
    );
  }
  if (allowance > 0) {
    yLeft = lineItem('Allowance', allowance, COL_LEFT, yLeft);
  }

  yRight = lineItem('Tax (PAYG)', payeTax, COL_RIGHT, yRight);
  if (npfEmployee > 0) {
    yRight = lineItem('NPF (employee)', npfEmployee, COL_RIGHT, yRight);
  }
  if (otherDed > 0) {
    yRight = lineItem('Other deductions', otherDed, COL_RIGHT, yRight);
  }

  // Totals panel
  doc.y = ensureSpace(Math.max(yLeft, yRight) + 6, 100);
  const gross = num(item.gross);
  const net = num(item.net);
  doc.y = drawTotalsPanel(gross, payeTax, npfEmployee, otherDed, net);

  if (npfEmployer > 0 || accEmployer > 0) {
    doc.y = ensureSpace(doc.y + 8, 55);
    doc.font('Helvetica-Bold').fontSize(10)
      .text('Employer contributions (not deducted from net pay)', X_LEFT, doc.y);
    if (npfEmployer > 0) {
      doc.font('Helvetica').text(`NPF employer: ${money(npfEmployer)}`, X_LEFT, doc.y + 3);
    }
    if (accEmployer > 0) {
      doc.font('Helvetica').text(`ACC employer: ${money(accEmployer)}`, X_LEFT, doc.y + 3);
    }
  }

  // Optional Note
  if (item.note) {
    doc.y = ensureSpace(doc.y + 8, 60);
    const noteTop = doc.y;
    const noteW = X_RIGHT - X_LEFT;
    doc
      .roundedRect(X_LEFT - 6, noteTop - 6, noteW + 12, 50, 6)
      .lineWidth(0.6)
      .strokeColor('#EDEDED')
      .stroke()
      .strokeColor('black');

    doc.font('Helvetica-Bold').fontSize(10).text('Note', X_LEFT, noteTop);
    doc
      .font('Helvetica')
      .fontSize(10)
      .text(String(item.note), X_LEFT, doc.y + 2, { width: noteW });
  }
}

async function viewPayslipInline(runId, employeeId, res) {
  if (!res) throw new Error('Response stream is required');

  if (!Number.isFinite(Number(runId)) || Number(runId) <= 0) {
    res.status(400).json({ message: 'Invalid run id' });
    return;
  }

  const data = await getPayslipData(runId, employeeId);

  const filename = `payslip-run-${data.run.run_id}-emp-${data.employee.employee_number || data.employee.employee_id}.pdf`;

  // Inline (browser preview) instead of attachment
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');

  const doc = new PDFDocument({
    size: 'A4',
    margins: THEME.margins,
    bufferPages: true,
  });

  doc.on('error', (err) => {
    try { res.destroy(err); } catch (_) { }
  });

  doc.pipe(res);

  drawPayslipInLine(doc, data);

  doc.end();

}

async function getPayslipData(runId, employeeId) {
  const db = await pool.connect();
  try {
    const { rows: runRows } = await db.query(`
      SELECT r.id as run_id, r.status, p.period_start, p.period_end 
      FROM pay_runs r
      JOIN pay_periods p on p.id = r.period_id
      WHERE r.id = $1` , [runId]);

    if (!runRows.length) throw new Error('Run not found');

    const { rows: empRows } = await db.query(
      `SELECT e.employee_id, e.first_name, e.last_name, e.email,
            e.employee_number, e.effective_hourly_rate
       FROM employee e where e.employee_id = $1`,
      [employeeId]
    );
    if (!empRows.length) throw new Error('Employee not found');

    const { rows: itemRows } = await db.query(
      `SELECT i.*
       FROM pay_run_items i
      WHERE i.pay_run_id = $1 and i.employee_id = $2`,
      [runId, employeeId]
    );
    if (!itemRows.length) throw new Error('No payslip line for this employee/run');

    return {
      run: runRows[0],
      employee: empRows[0],
      item: itemRows[0],
    };
  } finally {
    db.release();
  }
}

function toCsv({ columns, rows }) {
  const esc = (v = '') => {
    const raw = String(v);
    const s = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map(esc).join(',');
  const body = rows.map(r => columns.map(c => esc(r[c])).join(',')).join('\n');
  return `${header}\n${body}\n`;
}

function splitUsableAndWarnings(lines) {
  const warnings = [];
  const usable = [];
  for (const r of lines) {
    if (!r.bsb || !r.account_number) {
      warnings.push(`Missing bank details: ${r.first_name} ${r.last_name} (line ${r.line_id})`);
      continue;
    }
    if (Number(r.net) === 0) {
      warnings.push(`Zero net amount: ${r.first_name} ${r.last_name} (line ${r.line_id})`);
      continue;
    }
    usable.push(r);
  }
  return { usable, warnings };
}

async function importTimesheetsFromCsv(runId, fileBuffer, userId = null) {
  let records;
  try {
    records = parse(fileBuffer, { columns: true, skip_empty_lines: true, trim: true });
  } catch (error) {
    throw new Error(`Failed to parse CSV: ${error.message}`);
  }

  if (!records.length) throw new Error('CSV is empty');
  if (records.length > 10000) throw new Error('CSV exceeds the 10,000 row limit');

  const required = ['employee_number', 'regular_hours'];
  const headers = Object.keys(records[0]);
  const missing = required.filter(column => !headers.includes(column));
  if (missing.length) throw new Error(`CSV missing required columns: ${missing.join(', ')}`);

  const client = await pool.connect();
  const errors = [];
  let inserted = 0;
  let updated = 0;

  try {
    await client.query('BEGIN');
    const { rows: runRows } = await client.query(
      'SELECT id, status FROM pay_runs WHERE id = $1 FOR UPDATE',
      [runId]
    );
    if (!runRows.length) throw new Error(`Pay run ${runId} was not found`);
    if (runRows[0].status !== 'Draft') throw new Error('Timesheets can only be imported into a Draft run');

    const employeeNumbers = [...new Set(records.map(row => String(row.employee_number || '').trim()).filter(Boolean))];
    const { rows: employees } = await client.query(
      `SELECT employee_id, employee_number, effective_hourly_rate
         FROM employee
        WHERE employee_number = ANY($1) AND is_active = true`,
      [employeeNumbers]
    );
    const employeesByNumber = new Map(employees.map(employee => [String(employee.employee_number), employee]));
    const changedIds = [];
    const seenEmployeeNumbers = new Set();

    for (let index = 0; index < records.length; index += 1) {
      const row = records[index];
      const rowNumber = index + 2;
      const employeeNumber = String(row.employee_number || '').trim();
      if (seenEmployeeNumbers.has(employeeNumber)) {
        errors.push({ row: rowNumber, error: `Duplicate employee_number ${employeeNumber || '(blank)'} in CSV` });
        continue;
      }
      seenEmployeeNumbers.add(employeeNumber);
      const employee = employeesByNumber.get(employeeNumber);
      if (!employee) {
        errors.push({ row: rowNumber, error: `Active employee ${employeeNumber || '(blank)'} was not found` });
        continue;
      }

      const values = {
        hours: Number(row.regular_hours || 0),
        ot15: Number(row.ot_15_hours || 0),
        ot20: Number(row.ot_20_hours || 0),
        allowance: Number(row.allowances || 0),
        deductions: Number(row.deductions || 0),
        tax: Number(row.tax || 0),
        rate: Number(employee.effective_hourly_rate || 0),
      };
      if (Object.values(values).some(value => !Number.isFinite(value) || value < 0)) {
        errors.push({ row: rowNumber, error: 'Hours and money fields must be non-negative numbers' });
        continue;
      }
      if (values.rate <= 0) {
        errors.push({ row: rowNumber, error: `Employee ${employeeNumber} has no effective hourly rate` });
        continue;
      }

      const { rows } = await client.query(
        `INSERT INTO pay_run_items
          (pay_run_id, employee_id, hours, rate, allowance, ot_15_hours,
           ot_20_hours, tax, deductions_total, note, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Draft')
         ON CONFLICT (pay_run_id, employee_id) DO UPDATE SET
           hours = EXCLUDED.hours,
           rate = EXCLUDED.rate,
           allowance = EXCLUDED.allowance,
           ot_15_hours = EXCLUDED.ot_15_hours,
           ot_20_hours = EXCLUDED.ot_20_hours,
           tax = EXCLUDED.tax,
           deductions_total = EXCLUDED.deductions_total,
           note = EXCLUDED.note,
           updated_by = $11,
           updated_at = now()
         RETURNING id, (xmax = 0) AS inserted`,
        [runId, employee.employee_id, values.hours, values.rate, values.allowance,
          values.ot15, values.ot20, values.tax, values.deductions,
          String(row.notes || '').trim() || null, userId || null]
      );
      changedIds.push(rows[0].id);
      if (rows[0].inserted) inserted += 1;
      else updated += 1;
    }

    for (const id of changedIds) await recalcLine(client, id);
    const summary = await recomputeRunSummary(client, runId);
    await writeAudit(client, {
      userId,
      action: 'TIMESHEETS_IMPORTED',
      entityType: 'pay_run',
      entityId: runId,
      afterData: { records: records.length, inserted, updated, rejected: errors.length },
    });
    await client.query('COMMIT');

    return { run_id: runId, records: records.length, inserted, updated, rejected: errors.length, errors, summary };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getSamoaContributionsSummary(runId) {
  const client = await pool.connect();
  try {
    const id = runId ?? (await getActiveRunId(client));
    if (!id) {
      return { ok: false, message: 'No active run', employees: [], totals: {} };
    }

    const { rows: runRows } = await client.query(
      `SELECT status FROM pay_runs WHERE id = $1`,
      [id]
    );
    if (!runRows.length) {
      return { ok: false, message: 'Pay run not found', employees: [], totals: {} };
    }

    const { rows } = await client.query(
      `
      SELECT 
        e.employee_id,
        e.first_name,
        e.last_name,
        COALESCE(l.gross,0)         AS gross,
        COALESCE(l.tax,0)           AS tax,
        COALESCE(l.npf_employee,0)  AS npf_employee,
        COALESCE(l.npf_employer,0)  AS npf_employer,
        COALESCE(l.acc_employer,0)  AS acc_employer,
        COALESCE(l.net,0)           AS net
      FROM pay_run_items l
      JOIN employee e ON e.employee_id = l.employee_id
      WHERE l.pay_run_id = $1
      ORDER BY e.last_name, e.first_name, l.id
      `,
      [id]
    );

    const employees = rows.map(r => ({
      employee_id: r.employee_id,
      name: `${r.first_name} ${r.last_name}`,
      gross: Number(r.gross),
      tax: Number(r.tax),
      npf_employee: Number(r.npf_employee),
      npf_employer: Number(r.npf_employer),
      acc_employer: Number(r.acc_employer),
      net: Number(r.net),
    }));

    const totals = employees.reduce(
      (t, e) => ({
        gross: t.gross + e.gross,
        tax: t.tax + e.tax,
        npf_employee: t.npf_employee + e.npf_employee,
        npf_employer: t.npf_employer + e.npf_employer,
        acc_employer: t.acc_employer + e.acc_employer,
        net: t.net + e.net,
      }),
      { gross: 0, tax: 0, npf_employee: 0, npf_employer: 0, acc_employer: 0, net: 0 }
    );

    return { ok: true, run_id: id, status: runRows[0].status, employees, totals };
  } finally {
    client.release();
  }
}

async function buildSuperCsvForCurrentRun({ runId } = {}) {
  const summary = await getSamoaContributionsSummary(runId);
  if (!summary.ok) {
    return { filename: 'npf-export.csv', csv: '', warnings: [summary.message] };
  }
  if (!['Approved', 'Posted'].includes(summary.status)) {
    return {
      filename: `npf-run-${summary.run_id}.csv`,
      csv: '',
      warnings: ['NPF exports require an Approved or Posted pay run'],
    };
  }

  const columns = [
    'employee_id',
    'employee_name',
    'gross',
    'npf_employee',
    'npf_employer',
    'acc_employer',
  ];
  const rows = summary.employees.map(employee => ({
    employee_id: employee.employee_id,
    employee_name: employee.name,
    gross: employee.gross.toFixed(2),
    npf_employee: employee.npf_employee.toFixed(2),
    npf_employer: employee.npf_employer.toFixed(2),
    acc_employer: employee.acc_employer.toFixed(2),
  }));

  return {
    filename: `npf-run-${summary.run_id}.csv`,
    csv: toCsv({ columns, rows }),
    warnings: [],
  };
}

module.exports = {
  viewPayslipInline,
  getActiveRunId,
  getStpPreview,
  getCurrentRunSummary,
  getCurrentRunItems,   // returns ARRAY
  getCurrentRun,
  startCurrentRun, // fill in when ready
  recalcCurrentRun,
  approveCurrentRun,
  postCurrentRun,
  reopenCurrentRun,
  updateCurrentItem,      // (lineId, patch, userId)
  startForPeriod,
  validateCurrentRun,
  addCurrentRunItem,
  deleteCurrentItem,
  buildBankCsvForCurrentRun,
  buildSuperCsvForCurrentRun,
  streamPayslipsPdfForCurrentRun,
  streamPayslipsPdfForRunById,
  importTimesheetsFromCsv,
  getSamoaContributionsSummary
};
