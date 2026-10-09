const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');

loadEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = process.env.NODE_ENV || 'development';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || (NODE_ENV === 'production' ? '' : 'dev-admin-token');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');

if (!ADMIN_TOKEN) {
  console.error('ADMIN_TOKEN is required when NODE_ENV=production.');
  process.exit(1);
}
if (NODE_ENV !== 'production' && !process.env.ADMIN_TOKEN) {
  console.warn('Using development admin token: dev-admin-token');
  console.warn('Set ADMIN_TOKEN in .env before sharing or deploying this project.');
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'leads.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    business TEXT NOT NULL,
    email TEXT NOT NULL,
    service TEXT NOT NULL,
    budget TEXT NOT NULL,
    message TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'New',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const insertLead = db.prepare(`INSERT INTO leads (name,business,email,service,budget,message) VALUES (?,?,?,?,?,?)`);
const getLeadById = db.prepare('SELECT * FROM leads WHERE id = ?');
const listLeads = db.prepare('SELECT * FROM leads ORDER BY datetime(created_at) DESC, id DESC');
const updateLeadStatus = db.prepare('UPDATE leads SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');

const rateBuckets = new Map();
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT = 20;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const i = trimmed.indexOf('=');
    if (i === -1) continue;
    const key = trimmed.slice(0, i).trim();
    let value = trimmed.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; '));
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function clean(value, max = 500) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isAdmin(req) {
  return req.headers['x-admin-token'] === ADMIN_TOKEN;
}

function rateAllowed(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = forwarded || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const current = rateBuckets.get(ip);
  if (!current || now - current.start > RATE_WINDOW_MS) {
    rateBuckets.set(ip, { start: now, count: 1 });
    return true;
  }
  current.count += 1;
  if (current.count > RATE_LIMIT) return false;
  return true;
}

function readJson(req, maxBytes = 30_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Request too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function serveFile(res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return sendText(res, 404, 'Not found');
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

function sendText(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function safeStaticPath(pathname) {
  let requested = pathname;
  if (requested === '/') requested = '/index.html';
  if (requested === '/admin') requested = '/admin.html';
  const normalized = path.normalize(decodeURIComponent(requested)).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC_DIR, normalized);
  if (!full.startsWith(PUBLIC_DIR)) return null;
  return full;
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, service: 'kavi-growth-api', time: new Date().toISOString() });
  }

  if (req.method === 'POST' && url.pathname === '/api/leads') {
    if (!rateAllowed(req)) {
      return sendJson(res, 429, { ok: false, message: 'Too many enquiries from this device. Please try again shortly.' });
    }

    const body = await readJson(req);
    const name = clean(body.name, 80);
    const business = clean(body.business, 120);
    const email = clean(body.email, 160).toLowerCase();
    const service = clean(body.service, 100);
    const budget = clean(body.budget, 80);
    const message = clean(body.message, 1200);

    if (!name || !business || !email || !service || !budget) {
      return sendJson(res, 400, { ok: false, message: 'Please complete all required fields.' });
    }
    if (!isValidEmail(email)) {
      return sendJson(res, 400, { ok: false, message: 'Please enter a valid email address.' });
    }

    const result = insertLead.run(name, business, email, service, budget, message);
    const lead = getLeadById.get(result.lastInsertRowid);
    return sendJson(res, 201, {
      ok: true,
      message: `Thanks ${name}. Your enquiry has been received.`,
      lead: { id: lead.id, status: lead.status, created_at: lead.created_at }
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/leads') {
    if (!isAdmin(req)) return sendJson(res, 401, { ok: false, message: 'Unauthorized' });
    return sendJson(res, 200, { ok: true, leads: listLeads.all() });
  }

  const statusMatch = url.pathname.match(/^\/api\/leads\/(\d+)\/status$/);
  if (req.method === 'PATCH' && statusMatch) {
    if (!isAdmin(req)) return sendJson(res, 401, { ok: false, message: 'Unauthorized' });
    const id = Number(statusMatch[1]);
    const body = await readJson(req);
    const status = clean(body.status, 40);
    const allowed = new Set(['New', 'Contacted', 'Qualified', 'Won', 'Lost']);
    if (!allowed.has(status)) return sendJson(res, 400, { ok: false, message: 'Invalid status.' });
    const result = updateLeadStatus.run(status, id);
    if (result.changes === 0) return sendJson(res, 404, { ok: false, message: 'Lead not found.' });
    return sendJson(res, 200, { ok: true, lead: getLeadById.get(id) });
  }

  if (req.method === 'GET' && url.pathname === '/api/leads/export.csv') {
    if (!isAdmin(req)) return sendJson(res, 401, { ok: false, message: 'Unauthorized' });
    const leads = listLeads.all();
    const cols = ['id','name','business','email','service','budget','message','status','created_at','updated_at'];
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = '\uFEFF' + [cols.join(','), ...leads.map(row => cols.map(c => esc(row[c])).join(','))].join('\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="kavi-growth-leads.csv"'
    });
    return res.end(csv);
  }

  return sendJson(res, 404, { ok: false, message: 'API route not found.' });
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      return await handleApi(req, res, url);
    }

    if (!['GET', 'HEAD'].includes(req.method)) return sendText(res, 405, 'Method not allowed');
    const filePath = safeStaticPath(url.pathname);
    if (!filePath) return sendText(res, 403, 'Forbidden');
    return serveFile(res, filePath);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendJson(res, error.status || 500, { ok: false, message: error.status ? error.message : 'Something went wrong on the server.' });
  }
});

server.listen(PORT, () => {
  console.log(`KAVI GROWTH running at http://localhost:${PORT}`);
  console.log(`Admin dashboard: http://localhost:${PORT}/admin`);
});
