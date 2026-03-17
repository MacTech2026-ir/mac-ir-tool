require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const axios = require('axios');
const pdfParse = require('pdf-parse');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;

// -- DIRS ------------------------------------------------------------------
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const DB_PATH = path.join(__dirname, '..', 'data', 'mac_ir.db');
const DATA_DIR = path.join(__dirname, '..', 'data');
[UPLOADS_DIR, DATA_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// -- DATABASE --------------------------------------------------------------
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS parts (
    id TEXT PRIMARY KEY,
    part_num TEXT NOT NULL,
    name TEXT,
    category TEXT,
    series TEXT,
    list_price REAL,
    your_cost REAL,
    quote_num TEXT,
    supplier TEXT DEFAULT 'Ingersoll Rand',
    date TEXT,
    xref TEXT DEFAULT '[]',
    notes TEXT,
    source_email_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS manuals (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    models TEXT DEFAULT '[]',
    filename TEXT,
    filepath TEXT,
    file_size INTEGER,
    pages INTEGER,
    source_email_id TEXT,
    source_subject TEXT,
    date TEXT,
    uploaded_by TEXT DEFAULT 'system',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT,
    completed_at TEXT,
    emails_scanned INTEGER DEFAULT 0,
    parts_found INTEGER DEFAULT 0,
    manuals_found INTEGER DEFAULT 0,
    status TEXT,
    log TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_parts_num ON parts(part_num);
  CREATE INDEX IF NOT EXISTS idx_parts_quote ON parts(quote_num);
  CREATE INDEX IF NOT EXISTS idx_manuals_models ON manuals(models);
`);

// -- MIDDLEWARE ------------------------------------------------------------
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// -- PASSWORD AUTH --------------------------------------------------------
const SITE_PASSWORD = process.env.SITE_PASSWORD || '';
const AUTH_COOKIE = 'mac_ir_auth';
const AUTH_TOKEN = require('crypto').createHash('sha256')
  .update(SITE_PASSWORD + 'mac-ir-salt-2024').digest('hex');

const LOGIN_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MAC IR Parts Tool - Login</title>
<style>*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
background:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:2.5rem;width:100%;max-width:380px}
.logo{text-align:center;margin-bottom:1.5rem}
.logo h1{color:#f8fafc;font-size:1.4rem;font-weight:700}
.logo p{color:#94a3b8;font-size:.85rem;margin-top:.25rem}
label{display:block;color:#cbd5e1;font-size:.85rem;font-weight:500;margin-bottom:.4rem}
input[type=password]{width:100%;padding:.65rem .85rem;background:#0f172a;
border:1px solid #334155;border-radius:8px;color:#f8fafc;font-size:1rem;outline:none}
input[type=password]:focus{border-color:#3b82f6}
button{width:100%;margin-top:1.25rem;padding:.7rem;background:#3b82f6;color:#fff;
border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer}
button:hover{background:#2563eb}
.err{color:#f87171;font-size:.85rem;margin-top:.75rem;text-align:center}
</style></head><body><div class="card">
<div class="logo"><h1>MAC Technologies</h1><p>IR Parts and Manuals Tool</p></div>
<form method="POST" action="/login">
<label for="pw">Password</label>
<input type="password" id="pw" name="password" placeholder="Enter access password" autofocus>
<button type="submit">Sign In</button>
ERRMSG
</form></div></body></html>`;

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '').split(';')
      .map(c => c.trim().split('='))
      .filter(p => p.length === 2)
      .map(([k, v]) => [k.trim(), v.trim()])
  );
}

app.get('/login', (req, res) => {
  if (!SITE_PASSWORD) return res.redirect('/');
  res.send(LOGIN_HTML.replace('ERRMSG', ''));
});

app.post('/login', (req, res) => {
  if (!SITE_PASSWORD) return res.redirect('/');
  if ((req.body.password || '').trim() === SITE_PASSWORD) {
    res.setHeader('Set-Cookie',
      `${AUTH_COOKIE}=${AUTH_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
    return res.redirect('/');
  }
  res.status(401).send(LOGIN_HTML.replace('ERRMSG',
    '<p class="err">Incorrect password.</p>'));
});

app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  res.redirect('/login');
});

// Auth guard - all routes below this require login
app.use((req, res, next) => {
  if (!SITE_PASSWORD) return next();
  if (['/login', '/logout', '/favicon.ico'].includes(req.path)) return next();
  const cookies = parseCookies(req);
  if (cookies[AUTH_COOKIE] === AUTH_TOKEN) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/'))
    return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
});

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// Multer for PDF uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, Date.now() + '_' + safe);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 }, fileFilter: (req, file, cb) => {
  cb(null, file.mimetype === 'application/pdf');
}});

// -- HELPERS ---------------------------------------------------------------
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

function extractPartsFromText(text, quoteNum, date) {
  const parts = [];
  const lines = text.split(/[\n\r]+/);

  // Pattern: 8-10 digit IR part number with optional description and prices
  const rowRe = /\b(\d{8,10})\b[^\d]*?([\d,]+\.?\d{0,2})[^\d]*([\d,]+\.?\d{0,2})?/g;

  for (const line of lines) {
    const pnMatch = line.match(/\b(\d{8,10})\b/);
    if (!pnMatch) continue;
    const pn = pnMatch[1];

    // Extract description -- text near the part number
    const desc = line.replace(pn, '').replace(/[|\--:$,\d\.]+/g, ' ').trim().replace(/\s+/g, ' ').substring(0, 100);

    // Extract prices
    const prices = [...line.matchAll(/\$?([\d,]+\.\d{2})/g)]
      .map(m => parseFloat(m[1].replace(/,/g, '')))
      .filter(p => p > 0.5 && p < 500000);

    const listPrice = prices.length >= 2 ? Math.max(...prices) : (prices[0] || null);
    const yourCost = prices.length >= 2 ? Math.min(...prices) : null;

    if (pn.length >= 8) {
      parts.push({
        id: `ir_${pn}_${(quoteNum||'').replace(/\W/g,'')}`,
        part_num: pn,
        name: desc || 'Ingersoll Rand Part',
        category: inferCategory(desc),
        series: inferSeries(desc),
        list_price: listPrice,
        your_cost: yourCost,
        quote_num: quoteNum || null,
        date,
        xref: '[]',
        notes: quoteNum ? `From ${quoteNum}` : 'Manual upload',
      });
    }
  }

  // Supersession patterns
  const superRe = /part\s*#?\s*(\d{7,10})\s+(?:has\s+)?super\w+\s+to\s+part\s*#?\s*(\d{7,10})/gi;
  let sm;
  while ((sm = superRe.exec(text)) !== null) {
    const [, oldPn, newPn] = sm;
    const existing = parts.find(p => p.part_num === newPn);
    if (existing) {
      const xref = JSON.parse(existing.xref || '[]');
      xref.push(oldPn);
      existing.xref = JSON.stringify([...new Set(xref)]);
      existing.notes = (existing.notes || '') + ` Supersedes ${oldPn}.`;
    }
  }

  return parts.slice(0, 40);
}

function inferCategory(desc) {
  const d = (desc || '').toLowerCase();
  if (/filter|element|separator|air filter/i.test(d)) return 'Filter';
  if (/valve|inlet|check|unloader|discharge/i.test(d)) return 'Valve';
  if (/gasket|seal|o.?ring/i.test(d)) return 'Gasket / Seal';
  if (/belt/i.test(d)) return 'Belt';
  if (/motor/i.test(d)) return 'Motor';
  if (/switch|pressure switch/i.test(d)) return 'Pressure Switch';
  if (/pump|piston|head|cylinder/i.test(d)) return 'Pump / Head';
  if (/kit/i.test(d)) return 'Kit';
  if (/oil|lubric/i.test(d)) return 'Oil / Lubricant';
  if (/cooler|intercooler|aftercooler/i.test(d)) return 'Cooler';
  if (/bearing/i.test(d)) return 'Bearing';
  if (/hose|tube|fitting/i.test(d)) return 'Hose / Fitting';
  return 'Part';
}

function inferSeries(text) {
  const t = (text || '').toUpperCase();
  if (/RS\s?9|RS\s?11|RS\s?7/.test(t)) return 'RS-Series';
  if (/T.?30/.test(t)) return 'T30';
  if (/UP6S?/.test(t)) return 'UP6/UP6S';
  if (/SSR/.test(t)) return 'SSR';
  if (/R\s?SERIES|ROTARY SCREW/.test(t)) return 'R-Series';
  return 'General';
}

function extractModelsFromText(text) {
  const patterns = [/RS\s?\d+[iA]?[-\s]?[A-Z]?\d*/g, /T-?30/g, /UP6S?[-\s]?\d*/g, /SSR[-\s]?\d+/g];
  const models = [];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) models.push(...m.map(x => x.trim().toUpperCase()));
  }
  return [...new Set(models)].slice(0, 8);
}

// -- GMAIL OAUTH -----------------------------------------------------------
app.get('/auth/gmail', (req, res) => {
  const clientId = process.env.GMAIL_CLIENT_ID;
  if (!clientId) return res.status(400).json({ error: 'GMAIL_CLIENT_ID not configured in environment' });

  const redirectUri = process.env.GMAIL_REDIRECT_URI ||
    `${req.protocol}://${req.get('host')}/auth/callback`;

  const url = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent('https://www.googleapis.com/auth/gmail.readonly')}` +
    `&access_type=offline&prompt=consent` +
    `&login_hint=ryuseim%40mactechnologies.net`;

  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?auth=error');

  try {
    const redirectUri = process.env.GMAIL_REDIRECT_URI ||
      `${req.protocol}://${req.get('host')}/auth/callback`;

    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    const { access_token, refresh_token, expires_in } = tokenRes.data;
    setSetting('gmail_access_token', access_token);
    setSetting('gmail_refresh_token', refresh_token);
    setSetting('gmail_token_expiry', String(Date.now() + (expires_in * 1000)));

    res.redirect('/?auth=success');
  } catch (e) {
    console.error('OAuth error:', e.response?.data || e.message);
    res.redirect('/?auth=error');
  }
});

async function getValidToken() {
  let token = getSetting('gmail_access_token');
  const expiry = parseInt(getSetting('gmail_token_expiry') || '0');
  const refresh = getSetting('gmail_refresh_token');

  if (!token) throw new Error('Not authenticated -- connect Gmail first');
  if (Date.now() > expiry - 60000 && refresh) {
    const res = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    });
    token = res.data.access_token;
    setSetting('gmail_access_token', token);
    setSetting('gmail_token_expiry', String(Date.now() + (res.data.expires_in * 1000)));
  }
  return token;
}

// -- GMAIL SYNC ------------------------------------------------------------
let syncInProgress = false;
let syncLog = [];
let syncProgress = { pct: 0, sub: '', scanned: 0, parts: 0, manuals: 0 };

app.get('/api/sync/status', (req, res) => {
  const last = db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 1').get();
  res.json({
    inProgress: syncInProgress,
    progress: syncProgress,
    recentLog: syncLog.slice(-20),
    lastSync: last || null,
    gmailConnected: !!getSetting('gmail_access_token'),
  });
});

app.post('/api/sync/start', async (req, res) => {
  if (syncInProgress) return res.json({ ok: false, message: 'Sync already running' });
  res.json({ ok: true, message: 'Sync started' });
  runGmailSync().catch(console.error);
});

async function runGmailSync() {
  syncInProgress = true;
  syncLog = [];
  syncProgress = { pct: 0, sub: 'Starting...', scanned: 0, parts: 0, manuals: 0 };
  const logId = db.prepare('INSERT INTO sync_log (started_at, status) VALUES (datetime("now"), "running")').run().lastInsertRowid;

  const log = (msg, type = 'info') => {
    syncLog.push({ msg, type, ts: new Date().toISOString() });
    console.log(`[SYNC] ${msg}`);
  };

  try {
    const token = await getValidToken();
    log('Gmail connected [OK]', 'ok');

    // Find IR label
    syncProgress.sub = 'Finding Ingersoll Rand label...';
    const labelsRes = await axios.get('https://www.googleapis.com/gmail/v1/users/me/labels',
      { headers: { Authorization: `Bearer ${token}` } });

    const irLabel = labelsRes.data.labels.find(l =>
      l.name === 'Vendors/Ingersoll Rand' ||
      l.name.toLowerCase().includes('ingersoll rand')
    );

    let query;
    if (irLabel) {
      log(`Found label: "${irLabel.name}" [OK]`, 'ok');
      query = `label:${irLabel.id}`;
    } else {
      log('Label not found -- using keyword search', 'warn');
      query = 'from:ingersollrand OR subject:(CTS) OR subject:(ingersoll rand) OR subject:(IR quote)';
    }

    // Get message list
    syncProgress.sub = 'Loading email list...';
    let messages = [];
    let pageToken = null;
    do {
      const url = `https://www.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=100${pageToken ? '&pageToken=' + pageToken : ''}`;
      const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
      if (res.data.messages) messages = messages.concat(res.data.messages);
      pageToken = res.data.nextPageToken;
    } while (pageToken && messages.length < 300);

    log(`Found ${messages.length} emails to scan`, 'ok');

    const insertPart = db.prepare(`
      INSERT OR REPLACE INTO parts (id, part_num, name, category, series, list_price, your_cost, quote_num, date, xref, notes, source_email_id, updated_at)
      VALUES (@id, @part_num, @name, @category, @series, @list_price, @your_cost, @quote_num, @date, @xref, @notes, @source_email_id, datetime('now'))
    `);
    const insertManual = db.prepare(`
      INSERT OR IGNORE INTO manuals (id, title, models, filename, filepath, file_size, pages, source_email_id, source_subject, date)
      VALUES (@id, @title, @models, @filename, @filepath, @file_size, @pages, @source_email_id, @source_subject, @date)
    `);

    for (let i = 0; i < messages.length; i++) {
      syncProgress.pct = Math.round(10 + (i / messages.length) * 80);
      syncProgress.scanned = i + 1;

      try {
        const msgRes = await axios.get(
          `https://www.googleapis.com/gmail/v1/users/me/messages/${messages[i].id}?format=full`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const msg = msgRes.data;
        const headers = msg.payload.headers || [];
        const getH = n => (headers.find(h => h.name.toLowerCase() === n.toLowerCase()) || {}).value || '';
        const subject = getH('Subject');
        const date = getH('Date');
        const parsedDate = (() => { try { return new Date(date).toISOString().split('T')[0]; } catch(e) { return ''; } })();

        // Extract body text
        let bodyText = '';
        const walkParts = part => {
          if (!part) return;
          if (part.mimeType === 'text/plain' && part.body?.data) {
            bodyText += Buffer.from(part.body.data, 'base64').toString('utf8');
          } else if (part.mimeType === 'text/html' && part.body?.data && !bodyText) {
            const html = Buffer.from(part.body.data, 'base64').toString('utf8');
            bodyText += html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
          }
          if (part.parts) part.parts.forEach(walkParts);
        };
        walkParts(msg.payload);

        const fullText = subject + ' ' + bodyText;
        const isManual = /manual|service guide|IOM|installation.*operation|operation.*manual/i.test(fullText);
        const isQuote = /CTS-\d+|quote|proposal|part\s*number|part\s*#|\d{8,10}/i.test(fullText);
        const ctsMatch = fullText.match(/CTS-(\d+)/i);
        const quoteNum = ctsMatch ? 'CTS-' + ctsMatch[1] : null;

        // Process attachments
        const walkAttachments = async (part) => {
          if (!part) return;
          if (part.filename && part.filename.toLowerCase().endsWith('.pdf') && part.body?.attachmentId) {
            try {
              const attRes = await axios.get(
                `https://www.googleapis.com/gmail/v1/users/me/messages/${messages[i].id}/attachments/${part.body.attachmentId}`,
                { headers: { Authorization: `Bearer ${token}` } }
              );
              const pdfBuffer = Buffer.from(attRes.data.data, 'base64');
              const safeName = part.filename.replace(/[^a-zA-Z0-9.\-_]/g, '_');
              const filename = `${Date.now()}_${safeName}`;
              const filepath = path.join(UPLOADS_DIR, filename);
              fs.writeFileSync(filepath, pdfBuffer);

              // Parse PDF for text
              let pdfText = '';
              let pages = 0;
              try {
                const parsed = await pdfParse(pdfBuffer);
                pdfText = parsed.text;
                pages = parsed.numpages;
              } catch(e) {}

              const allText = pdfText + ' ' + fullText;

              if (isManual || /manual|IOM|service guide/i.test(part.filename)) {
                const models = extractModelsFromText(allText);
                const manualId = `manual_${messages[i].id}_${part.body.attachmentId}`;
                insertManual.run({
                  id: manualId,
                  title: part.filename.replace(/_/g, ' ').replace(/\.\w+$/, ''),
                  models: JSON.stringify(models),
                  filename,
                  filepath: `/uploads/${filename}`,
                  file_size: pdfBuffer.length,
                  pages,
                  source_email_id: messages[i].id,
                  source_subject: subject,
                  date: parsedDate,
                });
                syncProgress.manuals++;
                log(` Manual saved: ${part.filename}`, 'ok');
              }

              // Extract parts from PDF text
              if (isQuote && pdfText) {
                const pdfParts = extractPartsFromText(pdfText, quoteNum, parsedDate);
                const insertMany = db.transaction(() => {
                  for (const p of pdfParts) {
                    insertPart.run({ ...p, source_email_id: messages[i].id });
                    syncProgress.parts++;
                  }
                });
                insertMany();
                if (pdfParts.length > 0) log(`[OK] ${quoteNum || part.filename}: ${pdfParts.length} parts from PDF`, 'ok');
              }
            } catch(e) {
              log(`[WARN] Could not download attachment ${part.filename}: ${e.message}`, 'warn');
            }
          }
          if (part.parts) for (const p of part.parts) await walkAttachments(p);
        };
        await walkAttachments(msg.payload);

        // Also extract from email body
        if (isQuote) {
          const bodyParts = extractPartsFromText(bodyText, quoteNum, parsedDate);
          const insertBodyParts = db.transaction(() => {
            for (const p of bodyParts) {
              insertPart.run({ ...p, source_email_id: messages[i].id });
              syncProgress.parts++;
            }
          });
          insertBodyParts();
        }

      } catch(e) {
        log(`[WARN] Error on email ${i + 1}: ${e.message}`, 'warn');
      }

      // Rate limit safety
      if (i % 5 === 0) await new Promise(r => setTimeout(r, 200));
    }

    syncProgress.pct = 100;
    syncProgress.sub = 'Sync complete!';
    log(`[OK] Done -- ${syncProgress.parts} parts, ${syncProgress.manuals} manuals from ${messages.length} emails`, 'ok');

    db.prepare('UPDATE sync_log SET completed_at=datetime("now"), emails_scanned=?, parts_found=?, manuals_found=?, status="complete", log=? WHERE id=?')
      .run(messages.length, syncProgress.parts, syncProgress.manuals, JSON.stringify(syncLog), logId);

  } catch(e) {
    log(`[ERR] Sync failed: ${e.message}`, 'err');
    db.prepare('UPDATE sync_log SET completed_at=datetime("now"), status="error", log=? WHERE id=?')
      .run(JSON.stringify(syncLog), logId);
  } finally {
    syncInProgress = false;
  }
}

// -- API ROUTES ------------------------------------------------------------

// Stats
app.get('/api/stats', (req, res) => {
  const parts = db.prepare('SELECT COUNT(*) as c FROM parts').get().c;
  const manuals = db.prepare('SELECT COUNT(*) as c FROM manuals').get().c;
  const withPricing = db.prepare('SELECT COUNT(*) as c FROM parts WHERE list_price IS NOT NULL AND your_cost IS NOT NULL').get().c;
  const quotes = db.prepare("SELECT COUNT(DISTINCT quote_num) as c FROM parts WHERE quote_num IS NOT NULL").get().c;
  const lastSync = db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 1').get();
  res.json({ parts, manuals, withPricing, quotes, lastSync, gmailConnected: !!getSetting('gmail_access_token') });
});

// Parts
app.get('/api/parts', (req, res) => {
  const { q, category, series, quote, sort = 'part_num', limit = 200, offset = 0 } = req.query;
  let sql = 'SELECT * FROM parts WHERE 1=1';
  const params = [];
  if (q) { sql += ' AND (part_num LIKE ? OR name LIKE ? OR notes LIKE ? OR xref LIKE ?)'; const like = `%${q}%`; params.push(like,like,like,like); }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (series) { sql += ' AND series = ?'; params.push(series); }
  if (quote) { sql += ' AND quote_num = ?'; params.push(quote); }
  const allowed = ['part_num','category','series','list_price','your_cost','date','name'];
  sql += ` ORDER BY ${allowed.includes(sort) ? sort : 'part_num'} LIMIT ? OFFSET ?`;
  params.push(parseInt(limit), parseInt(offset));
  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(r => ({ ...r, xref: JSON.parse(r.xref || '[]') })));
});

app.get('/api/parts/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM parts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ ...row, xref: JSON.parse(row.xref || '[]') });
});

app.post('/api/parts', (req, res) => {
  const { part_num, name, category, series, list_price, your_cost, quote_num, notes, xref } = req.body;
  if (!part_num) return res.status(400).json({ error: 'part_num required' });
  const id = `manual_${part_num}_${Date.now()}`;
  db.prepare(`INSERT OR REPLACE INTO parts (id, part_num, name, category, series, list_price, your_cost, quote_num, notes, xref, supplier, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Ingersoll Rand', datetime('now'))`)
    .run(id, part_num, name || '', category || '', series || '', list_price || null, your_cost || null, quote_num || null, notes || '', JSON.stringify(xref || []));
  res.json({ ok: true, id });
});

app.put('/api/parts/:id', (req, res) => {
  const { name, category, series, list_price, your_cost, notes, xref } = req.body;
  db.prepare('UPDATE parts SET name=?, category=?, series=?, list_price=?, your_cost=?, notes=?, xref=?, updated_at=datetime("now") WHERE id=?')
    .run(name, category, series, list_price, your_cost, notes, JSON.stringify(xref || []), req.params.id);
  res.json({ ok: true });
});

app.delete('/api/parts/:id', (req, res) => {
  db.prepare('DELETE FROM parts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Filter options
app.get('/api/parts/meta/filters', (req, res) => {
  const categories = db.prepare('SELECT DISTINCT category FROM parts WHERE category != "" ORDER BY category').all().map(r => r.category);
  const series = db.prepare('SELECT DISTINCT series FROM parts WHERE series != "" ORDER BY series').all().map(r => r.series);
  const quotes = db.prepare('SELECT DISTINCT quote_num FROM parts WHERE quote_num IS NOT NULL ORDER BY quote_num DESC LIMIT 30').all().map(r => r.quote_num);
  res.json({ categories, series, quotes });
});

// Manuals
app.get('/api/manuals', (req, res) => {
  const { q } = req.query;
  let sql = 'SELECT * FROM manuals WHERE 1=1';
  const params = [];
  if (q) { sql += ' AND (title LIKE ? OR models LIKE ? OR source_subject LIKE ?)'; const like = `%${q}%`; params.push(like,like,like); }
  sql += ' ORDER BY date DESC, created_at DESC';
  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(r => ({ ...r, models: JSON.parse(r.models || '[]') })));
});

app.delete('/api/manuals/:id', (req, res) => {
  const manual = db.prepare('SELECT * FROM manuals WHERE id = ?').get(req.params.id);
  if (manual && manual.filename) {
    const fp = path.join(UPLOADS_DIR, manual.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  db.prepare('DELETE FROM manuals WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Manual upload endpoint
app.post('/api/manuals/upload', upload.array('pdfs', 20), async (req, res) => {
  const results = [];
  for (const file of req.files || []) {
    try {
      const pdfBuffer = fs.readFileSync(file.path);
      let pdfText = '', pages = 0;
      try { const p = await pdfParse(pdfBuffer); pdfText = p.text; pages = p.numpages; } catch(e) {}
      const models = extractModelsFromText(pdfText + ' ' + file.originalname);
      const title = (req.body.title || file.originalname).replace(/\.\w+$/, '').replace(/_/g, ' ');
      const id = `upload_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      db.prepare('INSERT INTO manuals (id, title, models, filename, filepath, file_size, pages, source_subject, date, uploaded_by) VALUES (?,?,?,?,?,?,?,?,datetime("now"),"manual")')
        .run(id, title, JSON.stringify(models), file.filename, `/uploads/${file.filename}`, file.size, pages, file.originalname);

      // Extract parts from uploaded PDF
      const parts = extractPartsFromText(pdfText, null, new Date().toISOString().split('T')[0]);
      const ins = db.transaction(() => {
        for (const p of parts) db.prepare('INSERT OR IGNORE INTO parts (id,part_num,name,category,series,list_price,your_cost,notes,xref,supplier) VALUES (?,?,?,?,?,?,?,?,?,?)').run(p.id,p.part_num,p.name,p.category,p.series,p.list_price,p.your_cost,p.notes,p.xref,'Ingersoll Rand');
      });
      ins();
      results.push({ ok: true, id, title, models, parts: parts.length, pages });
    } catch(e) {
      results.push({ ok: false, filename: file.originalname, error: e.message });
    }
  }
  res.json(results);
});

// Search across both
app.get('/api/search', (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ parts: [], manuals: [] });
  const like = `%${q}%`;
  const parts = db.prepare('SELECT * FROM parts WHERE part_num LIKE ? OR name LIKE ? OR notes LIKE ? OR xref LIKE ? LIMIT 50').all(like,like,like,like)
    .map(r => ({ ...r, xref: JSON.parse(r.xref || '[]') }));
  const manuals = db.prepare('SELECT * FROM manuals WHERE title LIKE ? OR models LIKE ? OR source_subject LIKE ? LIMIT 20').all(like,like,like)
    .map(r => ({ ...r, models: JSON.parse(r.models || '[]') }));
  res.json({ parts, manuals });
});

// Auth status
app.get('/api/auth/status', (req, res) => {
  res.json({ connected: !!getSetting('gmail_access_token'), expiry: getSetting('gmail_token_expiry') });
});

app.post('/api/auth/disconnect', (req, res) => {
  db.prepare("DELETE FROM settings WHERE key IN ('gmail_access_token','gmail_refresh_token','gmail_token_expiry')").run();
  res.json({ ok: true });
});

// -- START -----------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`\n MAC IR Parts Tool running on http://localhost:${PORT}`);
  console.log(`   Gmail connected: ${!!getSetting('gmail_access_token')}`);
  console.log(`   Parts in DB: ${db.prepare('SELECT COUNT(*) as c FROM parts').get().c}`);
  console.log(`   Manuals in DB: ${db.prepare('SELECT COUNT(*) as c FROM manuals').get().c}\n`);
});
