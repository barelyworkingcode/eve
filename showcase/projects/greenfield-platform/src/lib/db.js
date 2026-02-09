const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});

async function query(text, params) {
  const result = await pool.query(text, params);
  return result.rows;
}

async function createUser(data) {
  const { name, email, password_hash, role } = data;
  const result = await pool.query(
    'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING *',
    [name, email, password_hash, role || 'user']
  );
  return result.rows[0];
}

async function getUserById(id) {
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function getUserByEmail(email) {
  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  return result.rows[0] || null;
}

async function updateUser(id, data) {
  const fields = Object.keys(data);
  const values = Object.values(data);
  const sets = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');

  const result = await pool.query(
    `UPDATE users SET ${sets}, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, ...values]
  );
  return result.rows[0];
}

module.exports = { query, createUser, getUserById, getUserByEmail, updateUser, pool };
