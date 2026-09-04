// scripts/createInitialAdmin.js
require('dotenv').config();
const pool = require('../db');
const bcrypt = require('bcrypt');

async function createAdmin() {
  const username = process.env.INIT_ADMIN_USERNAME;
  const password = process.env.INIT_ADMIN_PASSWORD;
  const role = 'admin';

  if (!username || !password) {
    throw new Error('INIT_ADMIN_USERNAME and INIT_ADMIN_PASSWORD are required');
  }
  if (password.length < 12) {
    throw new Error('INIT_ADMIN_PASSWORD must be at least 12 characters');
  }

  try {
    const hashed = await bcrypt.hash(password, 10);
    const q = await pool.query(
      'INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3) RETURNING user_id, username, role',
      [username, hashed, role]
    );
    console.log('Admin created:', q.rows[0]);
    process.exit(0);
  } catch (err) {
    if (err.code === '23505') {
      console.log('Admin already exists. Exit.');
      process.exit(0);
    }
    console.error('Error creating admin', err);
    process.exit(1);
  }
}

createAdmin();
