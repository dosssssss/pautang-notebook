// Pautang Notebook server: serves the app and stores records in Postgres (Neon).
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const { DATABASE_URL, APP_PASSWORD, SESSION_SECRET } = process.env;
for (const [k, v] of Object.entries({ DATABASE_URL, APP_PASSWORD, SESSION_SECRET })) {
  if (!v) { console.error(`Missing environment variable ${k}`); process.exit(1); }
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: /sslmode=disable|localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
  max: 5,
});

const SCHEMA = `
create table if not exists customers (
  id text primary key,
  name text not null,
  phone text not null default '',
  created_at timestamptz not null default now()
);
create table if not exists entries (
  id text primary key,
  customer_id text not null references customers(id) on delete cascade,
  type text not null check (type in ('utang','bayad')),
  amount integer not null check (amount > 0),
  items jsonb,
  note text not null default '',
  date date not null,
  created_at timestamptz not null default now()
);
create index if not exists entries_customer_idx on entries(customer_id);
`;

/* Session: a signed cookie holding its expiry time. */
const COOKIE = 'pn_session';
const MAX_AGE_MS = 180 * 24 * 3600 * 1000;
const sign = v => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url');
function makeToken() { const exp = String(Date.now() + MAX_AGE_MS); return `${exp}.${sign(exp)}`; }
function validToken(t) {
  if (!t) return false;
  const [exp, sig] = t.split('.');
  if (!exp || !sig) return false;
  const good = Buffer.from(sign(exp)), got = Buffer.from(sig);
  return good.length === got.length && crypto.timingSafeEqual(good, got) && Number(exp) > Date.now();
}
function readCookie(req, name) {
  const m = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
function setSession(res, token, maxAge) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAge / 1000)}${secure}`);
}
function passwordMatches(p) {
  const a = crypto.createHash('sha256').update(String(p)).digest();
  const b = crypto.createHash('sha256').update(APP_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

/* Slow down password guessing: after 5 misses from one address, wait a minute. */
const misses = new Map();
function lockedOut(ip) { const m = misses.get(ip); return m && m.count >= 5 && Date.now() - m.at < 60_000; }
function noteMiss(ip) { const m = misses.get(ip) || { count: 0, at: 0 }; if (Date.now() - m.at > 60_000) m.count = 0; m.count++; m.at = Date.now(); misses.set(ip, m); }

/* Validation */
const isId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));
function cleanCustomer(b) {
  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 120) : '';
  const phone = typeof b.phone === 'string' ? b.phone.trim().slice(0, 40) : '';
  return name ? { name, phone } : null;
}
function cleanEntry(b) {
  if (!isId(b.customerId) || !['utang', 'bayad'].includes(b.type) || !isDate(b.date)) return null;
  const note = typeof b.note === 'string' ? b.note.slice(0, 500) : '';
  let items = null, amount;
  if (b.type === 'utang' && Array.isArray(b.items)) {
    if (!b.items.length || b.items.length > 100) return null;
    items = [];
    for (const i of b.items) {
      const name = typeof i.name === 'string' ? i.name.trim().slice(0, 120) : '';
      const qty = Number(i.qty), price = Number(i.price);
      if (!name || !(qty > 0) || !Number.isInteger(price) || price <= 0) return null;
      items.push({ name, qty, price });
    }
    // The server recomputes the total so it always matches the items.
    amount = items.reduce((t, i) => t + Math.round(i.qty * i.price), 0);
  } else {
    amount = Number(b.amount);
  }
  if (!Number.isInteger(amount) || amount <= 0 || amount > 2_000_000_000) return null;
  return { customerId: b.customerId, type: b.type, amount, items, note, date: b.date };
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

app.get('/healthz', (req, res) => res.send('ok'));

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (lockedOut(ip)) return res.status(429).json({ error: 'Too many wrong tries. Wait a minute and try again.' });
  if (!passwordMatches(req.body?.password ?? '')) { noteMiss(ip); return res.status(401).json({ error: 'Wrong password.' }); }
  misses.delete(ip);
  setSession(res, makeToken(), MAX_AGE_MS);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { setSession(res, '', 0); res.json({ ok: true }); });

app.use('/api', (req, res, next) => {
  if (validToken(readCookie(req, COOKIE))) return next();
  res.status(401).json({ error: 'Log in first.' });
});

const toEntry = r => ({ id: r.id, customerId: r.customer_id, type: r.type, amount: r.amount, items: r.items || undefined, note: r.note, date: r.date });

app.get('/api/data', async (req, res, next) => {
  try {
    const [c, e] = await Promise.all([
      pool.query('select id, name, phone from customers order by created_at'),
      pool.query("select id, customer_id, type, amount, items, note, to_char(date,'YYYY-MM-DD') as date from entries order by date, created_at"),
    ]);
    res.json({ customers: c.rows, entries: e.rows.map(toEntry) });
  } catch (err) { next(err); }
});

app.put('/api/customers/:id', async (req, res, next) => {
  const c = cleanCustomer(req.body || {});
  if (!isId(req.params.id) || !c) return res.status(400).json({ error: 'A customer needs a name.' });
  try {
    await pool.query(
      `insert into customers (id, name, phone) values ($1,$2,$3)
       on conflict (id) do update set name = excluded.name, phone = excluded.phone`,
      [req.params.id, c.name, c.phone]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.delete('/api/customers/:id', async (req, res, next) => {
  try { await pool.query('delete from customers where id = $1', [req.params.id]); res.json({ ok: true }); }
  catch (err) { next(err); }
});

async function upsertEntry(client, id, e) {
  await client.query(
    `insert into entries (id, customer_id, type, amount, items, note, date) values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (id) do update set customer_id = excluded.customer_id, type = excluded.type, amount = excluded.amount,
       items = excluded.items, note = excluded.note, date = excluded.date`,
    [id, e.customerId, e.type, e.amount, e.items ? JSON.stringify(e.items) : null, e.note, e.date]);
}

app.put('/api/entries/:id', async (req, res, next) => {
  const e = cleanEntry(req.body || {});
  if (!isId(req.params.id) || !e) return res.status(400).json({ error: 'That record is missing an amount, date or item.' });
  try {
    await upsertEntry(pool, req.params.id, e);
    res.json({ ok: true, amount: e.amount });
  } catch (err) {
    if (err.code === '23503') return res.status(409).json({ error: 'That customer no longer exists.' });
    next(err);
  }
});

app.delete('/api/entries/:id', async (req, res, next) => {
  try { await pool.query('delete from entries where id = $1', [req.params.id]); res.json({ ok: true }); }
  catch (err) { next(err); }
});

// Move records saved on a phone (before the online version) into the database.
app.post('/api/import', async (req, res, next) => {
  const { customers, entries } = req.body || {};
  if (!Array.isArray(customers) || !Array.isArray(entries)) return res.status(400).json({ error: 'Nothing to import.' });
  const client = await pool.connect();
  try {
    await client.query('begin');
    let nc = 0, ne = 0;
    for (const raw of customers) {
      const c = cleanCustomer(raw || {});
      if (!isId(raw?.id) || !c) continue;
      await client.query('insert into customers (id, name, phone) values ($1,$2,$3) on conflict (id) do nothing', [raw.id, c.name, c.phone]);
      nc++;
    }
    for (const raw of entries) {
      const e = cleanEntry(raw || {});
      if (!isId(raw?.id) || !e) continue;
      const exists = await client.query('select 1 from customers where id = $1', [e.customerId]);
      if (!exists.rowCount) continue;
      await upsertEntry(client, raw.id, e);
      ne++;
    }
    await client.query('commit');
    res.json({ ok: true, customers: nc, entries: ne });
  } catch (err) { await client.query('rollback').catch(() => {}); next(err); }
  finally { client.release(); }
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, file) { if (/\.(html|js|webmanifest)$/.test(file)) res.setHeader('Cache-Control', 'no-cache'); },
}));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'The server could not save that. Try again.' });
});

pool.query(SCHEMA)
  .then(() => app.listen(PORT, () => console.log(`Pautang Notebook on port ${PORT}`)))
  .catch(err => { console.error('Could not set up the database:', err.message); process.exit(1); });
