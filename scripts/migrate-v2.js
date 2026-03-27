require('dotenv').config();
const { Pool } = require('pg');
const fs   = require('fs');
const path = require('path');

async function migrate() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
  try {
    console.log('Running V2 migrations...');
    const sql = fs.readFileSync(path.join(__dirname, 'schema-v2.sql'), 'utf8');
    await pool.query(sql);
    console.log('✓ V2 schema applied successfully');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}
migrate();
