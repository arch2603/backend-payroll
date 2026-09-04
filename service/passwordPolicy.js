require("dotenv").config();
const pool = require("../db");


// Shared mapping helpers

const PAY_TYPE_MAP = {
  hourly: "HOURLY",
  salary: "SALARY",
  salaried: "SALARY",
};

const PAY_CYCLE_MAP = {
  weekly: "WEEKLY",
  fortnightly: "FORTNIGHTLY",
  fortnight: "FORTNIGHTLY",
  monthly: "MONTHLY",
  annually: "ANNUAL",
  annual: "ANNUAL"
};

function normalizePayType(pay_type) {
  if (pay_type === undefined || pay_type === null) return undefined;
  const norm = String(pay_type || "").toLowerCase();
  return PAY_TYPE_MAP[norm];
}

function normalizePayCycle(pay_cycle) {
  if (pay_cycle === undefined || pay_cycle === null) return undefined;
  const norm = String(pay_cycle || "").toLowerCase();
  return PAY_CYCLE_MAP[norm];
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}


// CREATE EMPLOYEE
async function createEmployee(payload) {
  const {
    first_name,
    last_name,
    dob,
    position,
    tax_rate,
    is_active = true,
    email,
    employee_number,
    pay_type,
    salary,
    hourly_rate,
    standard_hours_per_week = 38,
    pay_cycle = 'ANNUAL',

    // bank account fields (optional at create)
    bank_code,
    bsb,
    account_number,
    account_name,
    is_default = true,
    is_active_bank = true, // payload flag for employee_bank_accounts.is_active
    is_primary = true,
  } = payload;

  const dbPayType = normalizePayType(pay_type);
  const dbPayCycle = normalizePayCycle(pay_cycle);

  if (!String(first_name || '').trim() || !String(last_name || '').trim()) {
    badRequest('First name and last name are required');
  }
  if (!String(employee_number || '').trim()) {
    badRequest('employee_number is required');
  }
  if (!dbPayType) {
    badRequest(`Unsupported pay_type: ${pay_type}`);
  }
  if (!dbPayCycle) {
    badRequest(`Unsupported pay_cycle: ${pay_cycle}`);
  }
  const numericSalary = salary === undefined || salary === null || salary === '' ? null : Number(salary);
  const numericHourlyRate = hourly_rate === undefined || hourly_rate === null || hourly_rate === '' ? null : Number(hourly_rate);
  if (dbPayType === 'SALARY' && (!Number.isFinite(numericSalary) || numericSalary <= 0)) {
    badRequest('A positive salary is required for salaried employees');
  }
  if (dbPayType === 'HOURLY' && (!Number.isFinite(numericHourlyRate) || numericHourlyRate <= 0)) {
    badRequest('A positive hourly_rate is required for hourly employees');
  }
  if (!Number.isFinite(Number(standard_hours_per_week)) || Number(standard_hours_per_week) <= 0) {
    badRequest('standard_hours_per_week must be positive');
  }
  if ((bsb && !account_number) || (!bsb && account_number)) {
    badRequest('Both bsb and account_number are required when adding bank details');
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // NOTE: If your table does NOT have effective_hourly_rate, remove that column + $13.
    const { rows: empRows } = await client.query(
      `
        INSERT INTO employee (
          first_name,
          last_name,
          dob,
          position,
          tax_rate,
          is_active,
          email,
          employee_number,
          pay_type,
          salary,
          hourly_rate,
          standard_hours_per_week,
          pay_cycle
        )
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *;
      `,
      [
        String(first_name).trim(),
        String(last_name).trim(),
        dob,
        position,
        tax_rate,
        is_active,
        email,
        String(employee_number).trim(),
        dbPayType,
        dbPayType === 'SALARY' ? numericSalary : null,
        dbPayType === 'HOURLY' ? numericHourlyRate : null,
        Number(standard_hours_per_week),
        dbPayCycle,
      ]
    );

    const employee = empRows[0];

    // Only insert bank record on create if we have minimal details
    if (employee && bsb && account_number) {
      await client.query(
        `
          INSERT INTO employee_bank_accounts (
            employee_id,
            bank_code,
            bsb,
            account_number,
            account_name,
            is_default,
            is_active,
            is_primary
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
        `,
        [
          employee.employee_id,
          bank_code || null,
          bsb,
          account_number,
          account_name || `${first_name} ${last_name}`,
          is_default,
          is_active_bank,
          is_primary,
        ]
      );
    }

    await client.query("COMMIT");
    return employee;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// UPDATE EMPLOYEE
async function updateEmployee(empId, payload) {
  const {
    first_name,
    last_name,
    dob,
    position,
    tax_rate,
    is_active,
    email,
    employee_number,
    pay_type,
    salary,
    hourly_rate,
    standard_hours_per_week,
    pay_cycle,

    // bank account fields
    bank_code,
    bsb,
    account_number,
    account_name,
    is_default,
    is_active_bank,
    is_primary,
  } = payload;

  let dbPayType;
  if (pay_type !== undefined) {
    dbPayType = normalizePayType(pay_type);
    if (!dbPayType) {
      badRequest(`Unsupported pay_type: ${pay_type}`);
    }
  }

  let dbPayCycle;
  if (pay_cycle !== undefined) {
    dbPayCycle = normalizePayCycle(pay_cycle);
    if (!dbPayCycle) {
      badRequest(`Unsupported pay_cycle: ${pay_cycle}`);
    }
  }

  const fieldsToUpdate = {};

  if (first_name !== undefined) fieldsToUpdate.first_name = first_name;
  if (last_name !== undefined) fieldsToUpdate.last_name = last_name;
  if (dob !== undefined) fieldsToUpdate.dob = dob;
  if (position !== undefined) fieldsToUpdate.position = position;
  if (tax_rate !== undefined) fieldsToUpdate.tax_rate = tax_rate;
  if (is_active !== undefined) fieldsToUpdate.is_active = is_active;
  if (email !== undefined) fieldsToUpdate.email = email;
  if (employee_number !== undefined) fieldsToUpdate.employee_number = employee_number;
  if (standard_hours_per_week !== undefined) {
    fieldsToUpdate.standard_hours_per_week = standard_hours_per_week;
  }

  if (hourly_rate !== undefined) {
    fieldsToUpdate.hourly_rate = hourly_rate;
  }
  if (salary !== undefined) {
    fieldsToUpdate.salary = salary;
  }

  if (dbPayType !== undefined) {
    fieldsToUpdate.pay_type = dbPayType;
    if (dbPayType === 'SALARY') fieldsToUpdate.hourly_rate = null;
    if (dbPayType === 'HOURLY') fieldsToUpdate.salary = null;
  }

  if (dbPayCycle !== undefined) {
    fieldsToUpdate.pay_cycle = dbPayCycle;
  }

  const fieldEntries = Object.entries(fieldsToUpdate);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let updatedEmployee;

    if (fieldEntries.length > 0) {
      const setClauses = [];
      const values = [];
      let idx = 1;

      for (const [col, value] of fieldEntries) {
        setClauses.push(`${col} = $${idx++}`);
        values.push(value);
      }

      values.push(empId);
      const idParamIndex = values.length;

      const sql = `
        UPDATE employee
           SET ${setClauses.join(", ")}
         WHERE employee_id = $${idParamIndex}
         RETURNING *;
      `;

      const { rows } = await client.query(sql, values);
      if (!rows.length) {
        throw new Error(`Employee not found with id ${empId}`);
      }
      updatedEmployee = rows[0];
    } else {

      const { rows } = await client.query(
        `SELECT * FROM employee WHERE employee_id = $1`,
        [empId]
      );
      if (!rows.length) {
        throw new Error(`Employee not found with id ${empId}`);
      }
      updatedEmployee = rows[0];
    }

    const bankAccount = await updateEmployeeBankAccount(client, empId, {
      bank_code,
      bsb,
      account_number,
      account_name,
      is_default,
      is_active_bank,
      is_primary,
    });

    await client.query("COMMIT");
    return {
      ...updatedEmployee,
      bank_account: bankAccount,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// UPSERT EMPLOYEE BANK ACCOUNT (used by updateEmployee)
async function updateEmployeeBankAccount(client, empId, bankPayload) {
  const {
    bank_code,
    bsb,
    account_number,
    account_name,
    is_default,
    is_active_bank,
    is_primary,
  } = bankPayload;

  const hasAnyBankField = [
    bank_code,
    bsb,
    account_number,
    account_name,
    is_default,
    is_active_bank,
    is_primary,
  ].some((v) => v !== undefined);

  if (!hasAnyBankField) {
    // No bank changes in this request
    return null;
  }

  // 2) Try to find an existing primary account for this employee
  const { rows: existingRows } = await client.query(
    `
      SELECT id, employee_id, bank_code, bsb, account_number, account_name,
             is_default, is_active, is_primary
        FROM employee_bank_accounts
       WHERE employee_id = $1
         AND is_primary = true
       LIMIT 1;
    `,
    [empId]
  );

  if (!existingRows.length) {
    const insertCols = ["employee_id"];
    const insertVals = [empId];
    const placeholders = ["$1"];
    let idx = 2;

    const colMap = {
      bank_code,
      bsb,
      account_number,
      account_name,
      is_default,
      is_active: is_active_bank, // payload is_active_bank -> column is_active
      is_primary: is_primary ?? true, // default to primary on first insert
    };

    for (const [col, value] of Object.entries(colMap)) {
      if (value !== undefined) {
        insertCols.push(col);
        insertVals.push(value);
        placeholders.push(`$${idx++}`);
      }
    }

    const { rows: inserted } = await client.query(
      `
        INSERT INTO employee_bank_accounts
          (${insertCols.join(", ")})
        VALUES
          (${placeholders.join(", ")})
        RETURNING *;
      `,
      insertVals
    );

    return inserted[0];
  }

  const existing = existingRows[0];
  const fieldsToUpdate = {};

  if (bank_code !== undefined) fieldsToUpdate.bank_code = bank_code;
  if (bsb !== undefined) fieldsToUpdate.bsb = bsb;
  if (account_number !== undefined) fieldsToUpdate.account_number = account_number;
  if (account_name !== undefined) fieldsToUpdate.account_name = account_name;
  if (is_default !== undefined) fieldsToUpdate.is_default = is_default;
  if (is_active_bank !== undefined) fieldsToUpdate.is_active = is_active_bank;
  if (is_primary !== undefined) fieldsToUpdate.is_primary = is_primary;

  const entries = Object.entries(fieldsToUpdate);
  if (!entries.length) {
    // Nothing actually changed
    return existing;
  }

  let idx = 1;
  const setClauses = [];
  const values = [];

  for (const [col, value] of entries) {
    setClauses.push(`${col} = $${idx++}`);
    values.push(value);
  }

  // If you have updated_at column, keep this. Otherwise remove this line.
  setClauses.push(`updated_at = now()`);

  values.push(existing.id);
  const sql = `
      UPDATE employee_bank_accounts
         SET ${setClauses.join(", ")}
       WHERE id = $${idx}
       RETURNING *;
    `;
  const { rows: updated } = await client.query(sql, values);
  return updated[0];
}

async function getServiceEmployeeById(empId) {
  // const client = await pool.connect();
    const { rows } = await pool.query(`
      SELECT
      e.employee_id,
      e.first_name,
      e.last_name,
      e.dob,
      e.position,
      e.email,
      e.employee_number,
      e.pay_type,
      e.salary,
      e.hourly_rate,
      e.standard_hours_per_week,
      e.pay_cycle,
      e.tax_rate,
      e.is_active AS employee_is_active,
      ba.bank_code,
      ba.bsb,
      ba.account_number,
      ba.account_name,
      ba.is_default,
      ba.is_active AS bank_is_active,
      ba.is_primary
      FROM 
      employee e
      LEFT JOIN employee_bank_accounts ba 
      ON e.employee_id = ba.employee_id 
      AND 
      ba.is_primary = true
      WHERE e.employee_id = $1
      LIMIT 1;
      `, [empId]);

    if (!rows.length) return null;

    const row = rows[0];

    return {
      employee_id: row.employee_id,
      first_name: row.first_name,
      last_name: row.last_name,
      dob: row.dob,
      position: row.position,
      email: row.email,
      employee_number: row.employee_number,
      pay_type: row.pay_type,
      salary: row.salary,
      hourly_rate: row.hourly_rate,
      standard_hours_per_week: row.standard_hours_per_week,
      pay_cycle: row.pay_cycle,
      tax_rate: row.tax_rate,
      is_active: row.employee_is_active,
      bank_account: row.account_number
        ? {
          bank_code: row.bank_code,
          bsb: row.bsb,
          account_number: row.account_number,
          account_name: row.account_name,
          is_default: row.is_default,
          is_active: row.bank_is_active,
          is_primary: row.is_primary,
        }
        : null,
    };
}

module.exports = {
  createEmployee,
  updateEmployee,
  getServiceEmployeeById
};
