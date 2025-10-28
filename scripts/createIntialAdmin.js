// scripts/createInitialAdmin.js
require('dotenv').config();
const pool = require('../db');
const bcrypt = require('bcrypt');

async function createAdmin() {
  const username = process.env.INIT_ADMIN_USERNAME || 'admin';
  const password = process.env.INIT_ADMIN_PASSWORD || 'AdminPass123!'; // change immediately
  const role = 'admin';

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
