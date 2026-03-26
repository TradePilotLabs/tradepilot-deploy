require('dotenv').config();
const { Pool } = require('pg');
const fs   = require('fs');
const path = require('path');

async function migrate() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  const files = ['schema.sql', 'schema-phase3.sql'];

  try {
    for (const file of files) {
      const filePath = path.join(__dirname, file);
      if (!fs.existsSync(filePath)) {
        console.warn(`Skipping missing file: ${file}`);
        continue;
      }
      console.log(`Running ${file}...`);
      const sql = fs.readFileSync(filePath, 'utf8');
      await pool.query(sql);
      console.log(`✓ ${file} applied`);
    }
    console.log('\n✓ All migrations complete');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
