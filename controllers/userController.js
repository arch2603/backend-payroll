// controllers/userController.js
const pool = require('../db');
const bcrypt = require('bcrypt');

/**
 * GET /users
 * Admin only — returns user list (no password_hash)
 */
const listUsers = async (req, res) => {
  try {
    const q = await pool.query('SELECT user_id, username, role, employee_id, created_at FROM users ORDER BY created_at DESC');
    res.json({ items: q.rows });
  } catch (err) {
    console.error('listUsers error', err);
    res.status(500).json({ message: 'Error fetching users' });
  }
};

/**
 * POST /users
 * Admin only — create new user (this is thin wrapper to reuse registerUser if you prefer)
 * Accepts { username, password, role, employee_id }
 */
const createUser = async (req, res) => {
  // We can forward to same query as registerUser, but implement here to keep controller focused
  const { username, password, role = 'employee', employee_id = null } = req.body;
  if (!username || !password) return res.status(400).json({ message: 'username & password required' });

  try {
    const hashed = await require('bcrypt').hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, password_hash, role, employee_id) VALUES ($1,$2,$3,$4) RETURNING user_id, username, role, employee_id, created_at',
      [username, hashed, role, employee_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('createUser error', err);
    if (err.code === '23505') return res.status(409).json({ message: 'username already exists' });
    res.status(500).json({ message: 'Error creating user' });
  }
};

const updateUser = async (req, res) => {
  const id = Number(req.params.id);
  const { username, role, employee_id } = req.body;

  try {
    const updateQ = await pool.query(
      `UPDATE users
      SET username = COALESCE($1, username),
      role = COALESCE($2, role),
      employee_id = COALESCE($3, employee_id)
      WHERE user_id = $4
      RETURNING user_id, username, role, employee_id, created_at`,
      [username ?? null, role ?? null, employee_id ?? null, id]
    );
    if (updateQ.rows.length === 0) return res.status(404).json({ message: 'User not found' });
    res.json(updateQ.rows[0]);
  } catch (err) {
    console.error('updateUser error', err);
    res.status(500).json({ message: 'Error updating user' });
  }
};

//elete user
const deleteUser = async (req, res) => {
  const id = Number(req.params.id);
  try {
    const q = await pool.query('DELETE FROM users WHERE user_id=$1 RETURNING user_id', [id]);
    if (q.rows.length === 0) return res.status(404).json({ message: 'User not found' });
    res.json({ message: 'User deleted' });
  } catch (err) {
    console.error('deleteUser error', err);
    res.status(500).json({ message: 'Error deleting user' });
  }
};

module.exports = { listUsers, createUser, updateUser, deleteUser };