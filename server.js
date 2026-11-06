/* Study Notebook server.
   Serves the page in public/ and a small JSON API backed by Neon (PostgreSQL).
   The database password stays here on the server; the browser never sees it.
   Everyone signs in with one shared access code (APP_PASSWORD). */

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* hosts set env vars themselves */ }

const { DATABASE_URL, APP_PASSWORD, SESSION_SECRET } = process.env;
const PORT = Number(process.env.PORT) || 3000;
if (!DATABASE_URL || !APP_PASSWORD || !SESSION_SECRET) {
  console.error('Missing settings. Copy .env.example to .env and fill in DATABASE_URL, APP_PASSWORD and SESSION_SECRET.');
  process.exit(1);
}

/* ---------- Database ---------- */

function poolConfig(url) {
  const u = new URL(url);
  const wantsBinding = u.searchParams.get('channel_binding') === 'require';
  u.searchParams.delete('sslmode');           // TLS is set explicitly below
  u.searchParams.delete('channel_binding');
  return { connectionString: u.toString(), ssl: { rejectUnauthorized: true }, enableChannelBinding: wantsBinding, max: 5, idleTimeoutMillis: 30000 };
}
const pool = new Pool(poolConfig(DATABASE_URL));
pool.on('error', err => console.error('Database connection error:', err.message));
const q = (text, params) => pool.query(text, params);
async function tx(fn) {
  const c = await pool.connect();
  try { await c.query('begin'); const r = await fn(c); await c.query('commit'); return r; }
  catch (e) { await c.query('rollback').catch(() => {}); throw e; }
  finally { c.release(); }
}

/* ---------- Sign-in (one shared access code, signed cookie) ---------- */

const COOKIE = 'sn_session';
const SESSION_DAYS = 30;
const sign = v => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url');
const sameText = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest(), hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
function readCookie(req, name) {
  const m = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}
function signedIn(req) {
  const [exp, sig] = readCookie(req, COOKIE).split('.');
  return !!exp && !!sig && Number(exp) > Date.now() && sameText(sig, sign(exp));
}
function setSession(res, req) {
  const exp = String(Date.now() + SESSION_DAYS * 864e5);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}
/* Slow down guessing: after 5 wrong codes from one address, wait 10 minutes. */
const attempts = new Map();
function tooMany(ip) {
  const a = attempts.get(ip);
  return a && a.count >= 5 && Date.now() < a.until;
}
function failed(ip) {
  const a = attempts.get(ip) && Date.now() < attempts.get(ip).until ? attempts.get(ip) : { count: 0 };
  attempts.set(ip, { count: a.count + 1, until: Date.now() + 10 * 60e3 });
}

/* ---------- App ---------- */

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.get('/healthz', (req, res) => res.type('text').send('ok'));   // the host checks this to know the app is up
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));
app.use('/api', express.json({ limit: '1mb' }));

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = msg => { throw new HttpError(400, msg); };
const text = (v, max, field) => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') bad(`${field} must be text`);
  if (v.length > max) bad(`${field} is too long`);
  return v;
};
const uid = () => Date.now().toString(36) + crypto.randomBytes(4).toString('hex');

app.post('/api/login', (req, res) => {
  if (tooMany(req.ip)) return res.status(429).json({ error: 'Too many tries. Wait 10 minutes and try again.' });
  if (!sameText(req.body?.code ?? '', APP_PASSWORD)) { failed(req.ip); return res.status(401).json({ error: 'That access code isn’t right.' }); }
  attempts.delete(req.ip);
  setSession(res, req);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

/* Everything below needs a signed-in browser. */
app.use('/api', (req, res, next) => signedIn(req) ? next() : res.status(401).json({ error: 'Please sign in.' }));

/* The whole notebook in one go: it's small, and the page polls it for other people's changes. */
app.get('/api/state', async (req, res) => {
  const [tutors, notes, links, files, student] = await Promise.all([
    q(`select id, name from tutors order by substring(id from 2)::bigint`),
    q(`select id, num, tutor_id, title, body, sort_key, created_at, updated_at from notes`),
    q(`select id, note_id, url, label from note_links order by note_id, position, id`),
    q(`select id, note_id, name, mime_type, size_bytes from note_files order by created_at, id`),
    q(`select name from students order by id limit 1`),
  ]);
  const byNote = new Map();
  const bucket = id => byNote.get(id) || byNote.set(id, { links: [], files: [] }).get(id);
  links.rows.forEach(l => bucket(l.note_id).links.push({ id: String(l.id), url: l.url, label: l.label }));
  files.rows.forEach(f => bucket(f.note_id).files.push({ id: f.id, name: f.name, type: f.mime_type, size: f.size_bytes }));
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    student: student.rows[0]?.name || '',
    tutors: tutors.rows,
    notes: notes.rows.map(n => ({
      id: n.id, num: n.num, tutor: n.tutor_id, title: n.title, text: n.body,
      c: Number(n.sort_key), created: n.created_at.getTime(), at: n.updated_at.getTime(),
      ...(byNote.get(n.id) || { links: [], files: [] }),
    })),
  });
});

/* Tutors */
app.post('/api/tutors', async (req, res) => {
  const name = text(req.body?.name, 40, 'Name')?.trim() || bad('Type a name');
  const { rows } = await q(`insert into tutors (id, name) values ($1, $2) returning id, name`, ['t' + Date.now(), name]);
  res.status(201).json(rows[0]);
});
app.patch('/api/tutors/:id', async (req, res) => {
  const name = text(req.body?.name, 40, 'Name')?.trim() || bad('Type a name');
  const { rows } = await q(`update tutors set name = $2 where id = $1 returning id, name`, [req.params.id, name]);
  if (!rows.length) throw new HttpError(404, 'Tutor not found');
  res.json(rows[0]);
});

/* Notes. The database numbers each new note itself (note_num_seq), so numbers never repeat. */
app.post('/api/notes', async (req, res) => {
  const tutor = text(req.body?.tutor, 40, 'Tutor') || bad('Pick a tutor');
  const { rows } = await q(
    `insert into notes (id, tutor_id, sort_key) select $1, id, $3 from tutors where id = $2 returning id, num`,
    [uid(), tutor, Date.now()]);
  if (!rows.length) throw new HttpError(404, 'Tutor not found');
  res.status(201).json(rows[0]);
});
app.patch('/api/notes/:id', async (req, res) => {
  const title = text(req.body?.title, 200, 'Title'), body = text(req.body?.text, 200000, 'Notes');
  const { rowCount } = await q(
    `update notes set title = coalesce($2, title), body = coalesce($3, body), updated_at = now() where id = $1`,
    [req.params.id, title ?? null, body ?? null]);
  if (!rowCount) throw new HttpError(404, 'This note was deleted');
  res.json({ ok: true });
});
app.delete('/api/notes/:id', async (req, res) => {
  await q(`delete from notes where id = $1`, [req.params.id]);   // links and files go with it
  res.json({ ok: true });
});
/* Reorder within one tutor's list: up, down, or top. The list is sorted by sort_key, highest first. */
app.post('/api/notes/:id/move', async (req, res) => {
  const dir = req.body?.dir;
  if (!['up', 'down', 'top'].includes(dir)) bad('Unknown move');
  await tx(async c => {
    const me = (await c.query(`select tutor_id from notes where id = $1`, [req.params.id])).rows[0];
    if (!me) throw new HttpError(404, 'This note was deleted');
    await c.query(`select pg_advisory_xact_lock(hashtext($1))`, [me.tutor_id]);   // one reorder per tutor at a time
    const list = (await c.query(`select id, sort_key::bigint as k from notes where tutor_id = $1 order by sort_key desc, id`, [me.tutor_id])).rows;
    const i = list.findIndex(n => n.id === req.params.id);
    if (dir === 'top') {
      if (i > 0) await c.query(`update notes set sort_key = $2 where id = $1`, [list[i].id, Math.max(Date.now(), Number(list[0].k) + 1)]);
      return;
    }
    const j = i + (dir === 'up' ? -1 : 1);
    if (j < 0 || j >= list.length) return;
    let ki = Number(list[j].k), kj = Number(list[i].k);
    if (ki === kj) ki += dir === 'up' ? 1 : -1;
    await c.query(`update notes set sort_key = $2 where id = $1`, [list[i].id, ki]);
    await c.query(`update notes set sort_key = $2 where id = $1`, [list[j].id, kj]);
  });
  res.json({ ok: true });
});

/* Links */
app.post('/api/notes/:id/links', async (req, res) => {
  const raw = text(req.body?.url, 2000, 'Link') || bad('Paste a link');
  let url;
  try { const u = new URL(raw); if (!/^https?:$/.test(u.protocol)) throw 0; url = u.href; } catch { bad('Enter a link starting with http:// or https://'); }
  const label = text(req.body?.label, 120, 'Name')?.trim() || '';
  await tx(async c => {
    const ok = (await c.query(`update notes set updated_at = now() where id = $1`, [req.params.id])).rowCount;
    if (!ok) throw new HttpError(404, 'This note was deleted');
    await c.query(
      `insert into note_links (note_id, position, url, label)
       values ($1, (select coalesce(max(position), -1) + 1 from note_links where note_id = $1), $2, $3)`,
      [req.params.id, url, label]);
  });
  res.status(201).json({ ok: true });
});
app.delete('/api/links/:id', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) bad('Unknown link');
  await q(`with l as (delete from note_links where id = $1 returning note_id) update notes set updated_at = now() where id in (select note_id from l)`, [req.params.id]);
  res.json({ ok: true });
});

/* Files: stored in the database itself (note_files.data). */
const MAX_BYTES = 15 * 1024 * 1024;
const TYPES = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv', txt: 'text/plain',
};
const INLINE = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp']);
const extOf = n => (n.includes('.') ? n.split('.').pop() : '').toLowerCase();

app.post('/api/notes/:id/files', express.raw({ type: () => true, limit: MAX_BYTES }), async (req, res) => {
  const name = text(req.query.name, 200, 'File name')?.trim() || bad('Missing file name');
  const ext = extOf(name);
  if (!TYPES[ext]) bad(`"${name}" isn't a supported file type`);
  const data = req.body;
  if (!Buffer.isBuffer(data) || !data.length) bad(`"${name}" is empty`);
  const id = uid();
  await tx(async c => {
    const ok = (await c.query(`update notes set updated_at = now() where id = $1`, [req.params.id])).rowCount;
    if (!ok) throw new HttpError(404, 'This note was deleted');
    await c.query(`insert into note_files (id, note_id, name, mime_type, size_bytes, data) values ($1, $2, $3, $4, $5, $6)`,
      [id, req.params.id, name, TYPES[ext], data.length, data]);
  });
  res.status(201).json({ id });
});
app.get('/api/files/:id', async (req, res) => {
  const { rows } = await q(`select name, data from note_files where id = $1`, [req.params.id]);
  if (!rows.length) throw new HttpError(404, 'File not found');
  const { name, data } = rows[0], ext = extOf(name);
  const inline = req.query.view === '1' && INLINE.has(ext);
  res.setHeader('Content-Type', TYPES[ext] || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(data);
});
app.delete('/api/files/:id', async (req, res) => {
  await q(`with f as (delete from note_files where id = $1 returning note_id) update notes set updated_at = now() where id in (select note_id from f)`, [req.params.id]);
  res.json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That file is over 15 MB.' });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Try again.' });
});

app.listen(PORT, () => console.log(`Study Notebook running at http://localhost:${PORT}`));
