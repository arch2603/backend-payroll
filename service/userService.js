const pool = require("../db");
const bcrypt = require("bcrypt");
const { passwordError, normalizeRole } = require('./passwordPolicy');

async function updateUserService(userId, payload) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        const setClauses = [];
        const values = [];
        let index = 1;

        if (payload.username !== undefined) {
            setClauses.push(`username = $${index++}`);
            values.push(payload.username.trim());
        }

        if (payload.role !== undefined) {
            const normalizedRole = normalizeRole(payload.role);

            if(!normalizedRole) {
                const error = new Error(`Invalid role: ${payload.role}`);
                error.status = 400;
                throw error;
            }
            setClauses.push(`role = $${index++}`);
            values.push(normalizedRole);
        }

        if (payload.employee_id !== undefined) {
            setClauses.push(`employee_id = $${index++}`);
            values.push(Number(payload.employee_id) || null);
        }

        if (payload.password) {
            const invalidPassword = passwordError(payload.password);
            if (invalidPassword) {
                const error = new Error(invalidPassword);
                error.status = 400;
                throw error;
            }
            const hash = await bcrypt.hash(payload.password, 10);
            setClauses.push(`password_hash = $${index++}`);
            values.push(hash);
        }

        if (setClauses.length === 0) {
            await client.query("ROLLBACK");
            return { message: "Nothing to update" };
        }

        values.push(userId);

        const sql = `
      UPDATE users
         SET ${setClauses.join(", ")}
       WHERE user_id = $${index}
       RETURNING user_id, username, role, employee_id;
    `;

        const { rows } = await client.query(sql, values);

        await client.query("COMMIT");

        if (!rows[0]) {
            const error = new Error('User not found');
            error.status = 404;
            throw error;
        }
        return rows[0];

    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }

};

module.exports = {
    updateUserService
}
