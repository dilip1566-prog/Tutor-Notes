/* Creates the notebook's tables in the database named by DATABASE_URL.
   Safe to run more than once: it only adds what is missing.
   Usage: npm run setup-db */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch {}
if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL in .env first.'); process.exit(1); }

(async () => {
  const u = new URL(process.env.DATABASE_URL);
  u.searchParams.delete('sslmode'); u.searchParams.delete('channel_binding');
  const c = new Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: true } });
  await c.connect();
  await c.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  const { rows } = await c.query(`select count(*)::int as tutors from tutors`);
  if (!rows[0].tutors) {
    await c.query(`insert into tutors (id, name) values ('t1', 'Tutor 1'), ('t2', 'Tutor 2'), ('t3', 'Tutor 3')`);
    console.log('Added Tutor 1, Tutor 2 and Tutor 3.');
  }
  console.log('Database is ready.');
  await c.end();
})().catch(e => { console.error('Setup failed:', e.message); process.exit(1); });
