require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

async function migrate() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
  const sql = fs.readFileSync(path.join(__dirname, 'schema-phase3.sql'), 'utf8');
  try {
    console.log('Running Phase 3 migrations...');
    await pool.query(sql);
    console.log('✓ Phase 3 schema applied successfully');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
