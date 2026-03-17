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

    // Extract description â€” text near the part number
    const desc = line.replace(pn, '').replace(/[|\-â€“:$,\d\.]+/g, ' ').trim().replace(/\s+/g, ' ').substring(0, 100);

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

  if (!token) throw new Error('Not authenticated â€” connect Gmail first');
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
    log('Gmail connected âœ“', 'ok');

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
      log(`Found label: "${irLabel.name}" âœ“`, 'ok');
      query = `label:${irLabel.id}`;
    } else {
      log('Label not found â€” using keyword search', 'warn');
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
        const date = getH('Date')$ì(€€€€€€€½¹ÍÐÁ…ÉÍ•‘…Ñ”€ô€  ¤€ôøìÑÉäìÉ•ÑÕÉ¸¹•Ü…Ñ”¡‘…Ñ”¤¹Ñ½%M=MÑÉ¥¹œ ¤¹ÍÁ±¥Ð Pœ¥lÁtìô…Ñ ¡”¤ìÉ•ÑÕÉ¸€œœìôô¤ ¤ì((€€€€€€€€¼¼áÑÉ…Ð‰½‘äÑ•áÐ(€€€€€€€±•Ð‰½‘åQ•áÐ€ô€œœì(€€€€€€€½¹ÍÐÝ…±­A…ÉÑÌ€ôÁ…ÉÐ€ôøì(€€€€€€€€€¥˜€ …Á…ÉÐ¤É•ÑÕÉ¸ì(€€€€€€€€€¥˜€¡Á…ÉÐ¹µ¥µ•QåÁ”€ôôô€Ñ•áÐ½Á±…¥¸œ€˜˜Á…ÉÐ¹‰½‘äü¹‘…Ñ„¤ì(€€€€€€€€€€€‰½‘åQ•áÐ€¬ô	Õ™™•È¹™É½´¡Á…ÉÐ¹‰½‘ä¹‘…Ñ„°€‰…Í”ØÐœ¤¹Ñ½MÑÉ¥¹œ ÕÑ˜àœ¤ì(€€€€€€€€€ô•±Í”¥˜€¡Á…ÉÐ¹µ¥µ•QåÁ”€ôôô€Ñ•áÐ½¡Ñµ°œ€˜˜Á…ÉÐ¹‰½‘äü¹‘…Ñ„€˜˜€…‰½‘åQ•áÐ¤ì(€€€€€€€€€€€½¹ÍÐ¡Ñµ°€ô	Õ™™•È¹™É½´¡Á…ÉÐ¹‰½‘ä¹‘…Ñ„°€‰…Í”ØÐœ¤¹Ñ½MÑÉ¥¹œ ÕÑ˜àœ¤ì(€€€€€€€€€€€‰½‘åQ•áÐ€¬ô¡Ñµ°¹É•Á±…” ¼ñmxùt¬ø½œ°€œ€œ¤¹É•Á±…” ½qÌ¬½œ°€œ€œ¤ì(€€€€€€€€€ô(€€€€€€€€€¥˜€¡Á…ÉÐ¹Á…ÉÑÌ¤Á…ÉÐ¹Á…ÉÑÌ¹™½É… ¡Ý…±­A…ÉÑÌ¤ì(€€€€€€€ôì(€€€€€€€Ý…±­A…ÉÑÌ¡µÍœ¹Á…å±½…¤ì((€€€€€€€½¹ÍÐ™Õ±±Q•áÐ€ôÍÕ‰©•Ð€¬€œ€œ€¬‰½‘åQ•áÐì(€€€€€€€½¹ÍÐ¥Í5…¹Õ…°€ô€½µ…¹Õ…±ñÍ•ÉÙ¥”Õ¥‘•ñ%=5ñ¥¹ÍÑ…±±…Ñ¥½¸¸©½Á•É…Ñ¥½¹ñ½Á•É…Ñ¥½¸¸©µ…¹Õ…°½¤¹Ñ•ÍÐ¡™Õ±±Q•áÐ¤ì(€€€€€€€½¹ÍÐ¥ÍEÕ½Ñ”€ô€½QLµq­ñÅÕ½Ñ•ñÁÉ½Á½Í…±ñÁ…ÉÑqÌ©¹Õµ‰•ÉñÁ…ÉÑqÌ¨ñq‘ìà°ÄÁô½¤¹Ñ•ÍÐ¡™Õ±±Q•áÐ¤ì(€€€€€€€½¹ÍÐÑÍ5…Ñ €ô™Õ±±Q•áÐ¹µ…Ñ  ½QL´¡q¬¤½¤¤ì(€€€€€€€½¹ÍÐÅÕ½Ñ•9Õ´€ôÑÍ5…Ñ €ü€QL´œ€¬ÑÍ5…Ñ¡lÅt€è¹Õ±°ì((€€€€€€€€¼¼AÉ½•ÍÌ…ÑÑ…¡µ•¹ÑÌ(€€€€€€€½¹ÍÐÝ…±­ÑÑ…¡µ•¹ÑÌ€ô…Íå¹Œ€¡Á…ÉÐ¤€ôøì(€€€€€€€€€¥˜€ …Á…ÉÐ¤É•ÑÕÉ¸ì(€€€€€€€€€¥˜€¡Á…ÉÐ¹™¥±•¹…µ”€˜˜Á…ÉÐ¹™¥±•¹…µ”¹Ñ½1½Ý•É…Í” ¤¹•¹‘Í]¥Ñ  œ¹Á‘˜œ¤€˜˜Á…ÉÐ¹‰½‘äü¹…ÑÑ…¡µ•¹Ñ%¤ì(€€€€€€€€€€€ÑÉäì(€€€€€€€€€€€€€½¹ÍÐ…ÑÑI•Ì€ô…Ý…¥Ð…á¥½Ì¹•Ð (€€€€€€€€€€€€€€€¡ÑÑÁÌè¼½ÝÝÜ¹½½±•…Á¥Ì¹½´½µ…¥°½ØÄ½ÕÍ•ÉÌ½µ”½µ•ÍÍ…•Ì¼‘íµ•ÍÍ…•Ím¥t¹¥‘ô½…ÑÑ…¡µ•¹ÑÌ¼‘íÁ…ÉÐ¹‰½‘ä¹…ÑÑ…¡µ•¹Ñ%‘õ€°(€€€€€€€€€€€€€€€ì¡•…‘•ÉÌèìÕÑ¡½É¥é…Ñ¥½¸è	•…É•È€‘íÑ½­•¹õ€ôô(€€€€€€€€€€€€€€¤ì(€€€€€€€€€€€€€½¹ÍÐÁ‘™	Õ™™•È€ô	Õ™™•È¹™É½´¡…ÑÑI•Ì¹‘…Ñ„¹‘…Ñ„°€‰…Í”ØÐœ¤ì(€€€€€€€€€€€€€½¹ÍÐÍ…™•9…µ”€ôÁ…ÉÐ¹™¥±•¹…µ”¹É•Á±…” ½my„µéµhÀ´ä¹pµ}t½œ°€|œ¤ì(€€€€€€€€€€€€€½¹ÍÐ™¥±•¹…µ”€ô€‘í…Ñ”¹¹½Ü ¥õ|‘íÍ…™•9…µ•õ€ì(€€€€€€€€€€€€€½¹ÍÐ™¥±•Á…Ñ €ôÁ…Ñ ¹©½¥¸¡UA1=M}%H°™¥±•¹…µ”¤ì(€€€€€€€€€€€€€™Ì¹ÝÉ¥Ñ•¥±•Må¹Œ¡™¥±•Á…Ñ °Á‘™	Õ™™•È¤ì((€€€€€€€€€€€€€€¼¼A…ÉÍ”A™½ÈÑ•áÐ(€€€€€€€€€€€€€±•ÐÁ‘™Q•áÐ€ô€œœì(€€€€€€€€€€€€€±•ÐÁ…•Ì€ô€Àì(€€€€€€€€€€€€€ÑÉäì(€€€€€€€€€€€€€€€½¹ÍÐÁ…ÉÍ•€ô…Ý…¥ÐÁ‘™A…ÉÍ”¡Á‘™	Õ™™•È¤ì(€€€€€€€€€€€€€€€Á‘™Q•áÐ€ôÁ…ÉÍ•¹Ñ•áÐì(€€€€€€€€€€€€€€€Á…•Ì€ôÁ…ÉÍ•¹¹ÕµÁ…•Ìì(€€€€€€€€€€€€€ô…Ñ ¡”¤íô((€€€€€€€€€€€€€½¹ÍÐ…±±Q•áÐ€ôÁ‘™Q•áÐ€¬€œ€œ€¬™Õ±±Q•áÐì((€€€€€€€€€€€€€¥˜€¡¥Í5…¹Õ…°ñð€½µ…¹Õ…±ñ%=5ñÍ•ÉÙ¥”Õ¥‘”½¤¹Ñ•ÍÐ¡Á…ÉÐ¹™¥±•¹…µ”¤¤ì(€€€€€€€€€€€€€€€½¹ÍÐµ½‘•±Ì€ô•áÑÉ…Ñ5½‘•±ÍÉ½µQ•áÐ¡…±±Q•áÐ¤ì(€€€€€€€€€€€€€€€½¹ÍÐµ…¹Õ…±%€ôµ…¹Õ…±|‘íµ•ÍÍ…•Ím¥t¹¥‘õ|‘íÁ…ÉÐ¹‰½‘ä¹…ÑÑ…¡µ•¹Ñ%‘õ€ì(€€€€€€€€€€€€€€€¥¹Í•ÉÑ5…¹Õ…°¹ÉÕ¸¡ì(€€€€€€€€€€€€€€€€€¥èµ…¹Õ…±%°(€€€€€€€€€€€€€€€€€Ñ¥Ñ±”èÁ…ÉÐ¹™¥±•¹…µ”¹É•Á±…” ½|½œ°€œ€œ¤¹É•Á±…” ½p¹qÜ¬¼°€œœ¤°(€€€€€€€€€€€€€€€€€µ½‘•±Ìè)M=8¹ÍÑÉ¥¹¥™ä¡µ½‘•±Ì¤°(€€€€€€€€€€€€€€€€€™¥±•¹…µ”°(€€€€€€€€€€€€€€€€€™¥±•Á…Ñ è€½ÕÁ±½…‘Ì¼‘í™¥±•¹…µ•õ€°(€€€€€€€€€€€€€€€€€™¥±•}Í¥é”èÁ‘™	Õ™™•È¹±•¹Ñ °(€€€€€€€€€€€€€€€€€Á…•Ì°(€€€€€€€€€€€€€€€€€Í½ÕÉ•}•µ…¥±}¥èµ•ÍÍ…•Ím¥t¹¥°(€€€€€€€€€€€€€€€€€Í½ÕÉ•}ÍÕ‰©•ÐèÍÕ‰©•Ð°(€€€€€€€€€€€€€€€€€‘…Ñ”èÁ…ÉÍ•‘…Ñ”°(€€€€€€€€€€€€€€€ô¤ì(€€€€€€€€€€€€€€€Íå¹AÉ½É•ÍÌ¹µ…¹Õ…±Ì¬¬ì(€€€€€€€€€€€€€€€±½œ¡ƒÂ~NT€5…¹Õ…°Í…Ù•è€‘íÁ…ÉÐ¹™¥±•¹…µ•õ€°€½¬œ¤ì(€€€€€€€€€€€€€ô((€€€€€€€€€€€€€€¼¼áÑÉ…ÐÁ…ÉÑÌ™É½´AÑ•áÐ(€€€€€€€€€€€€€¥˜€¡¥ÍEÕ½Ñ”€˜˜Á‘™Q•áÐ¤ì(€€€€€€€€€€€€€€€½¹ÍÐÁ‘™A…ÉÑÌ€ô•áÑÉ…ÑA…ÉÑÍÉ½µQ•áÐ¡Á‘™Q•áÐ°ÅÕ½Ñ•9Õ´°Á…ÉÍ•‘…Ñ”¤ì(€€€€€€€€€€€€€€€½¹ÍÐ¥¹Í•ÉÑ5…¹ä€ô‘ˆ¹ÑÉ…¹Í…Ñ¥½¸  ¤€ôøì(€€€€€€€€€€€€€€€€€™½È€¡½¹ÍÐÀ½˜Á‘™A…ÉÑÌ¤ì(€€€€€€€€€€€€€€€€€€€¥¹Í•ÉÑA…ÉÐ¹ÉÕ¸¡ì€¸¸¹À°Í½ÕÉ•}•µ…¥±}¥èµ•ÍÍ…•Ím¥t¹¥ô¤ì(€€€€€€€€€€€€€€€€€€€Íå¹AÉ½É•ÍÌ¹Á…ÉÑÌ¬¬ì(€€€€€€€€€€€€€€€€€ô(€€€€€€€€€€€€€€€ô¤ì(€€€€€€€€€€€€€€€¥¹Í•ÉÑ5…¹ä ¤ì(€€€€€€€€€€€€€€€¥˜€¡Á‘™A…ÉÑÌ¹±•¹Ñ €ø€À¤±½œ¡ƒŠrL€‘íÅÕ½Ñ•9Õ´ñðÁ…ÉÐ¹™¥±•¹…µ•ôè€‘íÁ‘™A…ÉÑÌ¹±•¹Ñ¡ôÁ…ÉÑÌ™É½´A€°€½¬œ¤ì(€€€€€€€€€€€€€ô(€€€€€€€€€€€ô…Ñ ¡”¤ì(€€€€€€€€€€€€€±½œ¡ƒŠj€½Õ±¹½Ð‘½Ý¹±½……ÑÑ…¡µ•¹Ð€‘íÁ…ÉÐ¹™¥±•¹…µ•ôè€‘í”¹µ•ÍÍ…•õ€°€Ý…É¸œ¤ì(€€€€€€€€€€€ô(€€€€€€€€€ô(€€€€€€€€€¥˜€¡Á…ÉÐ¹Á…ÉÑÌ¤™½È€¡½¹ÍÐÀ½˜Á…ÉÐ¹Á…ÉÑÌ¤…Ý…¥ÐÝ…±­ÑÑ…¡µ•¹ÑÌ¡À¤ì(€€€€€€€ôì(€€€€€€€…Ý…¥ÐÝ…±­ÑÑ…¡µ•¹ÑÌ¡µÍœ¹Á…å±½…¤ì((€€€€€€€€¼¼±Í¼•áÑÉ…Ð™É½´•µ…¥°‰½‘ä(€€€€€€€¥˜€¡¥ÍEÕ½Ñ”¤ì(€€€€€€€€€½¹ÍÐ‰½‘åA…ÉÑÌ€ô•áÑÉ…ÑA…ÉÑÍÉ½µQ•áÐ¡‰½‘åQ•áÐ°ÅÕ½Ñ•9Õ´°Á…ÉÍ•‘…Ñ”¤ì(€€€€€€€€€½¹ÍÐ¥¹Í•ÉÑ	½‘åA…ÉÑÌ€ô‘ˆ¹ÑÉ…¹Í…Ñ¥½¸  ¤€ôøì(€€€€€€€€€€€™½È€¡½¹ÍÐÀ½˜‰½‘åA…ÉÑÌ¤ì(€€€€€€€€€€€€€¥¹Í•ÉÑA…ÉÐ¹ÉÕ¸¡ì€¸¸¹À°Í½ÕÉ•}•µ…¥±}¥èµ•ÍÍ…•Ím¥t¹¥ô¤ì(€€€€€€€€€€€€€Íå¹AÉ½É•ÍÌ¹Á…ÉÑÌ¬¬ì(€€€€€€€€€€€ô(€€€€€€€€€ô¤ì(€€€€€€€€€¥¹Í•ÉÑ	½‘åA…ÉÑÌ ¤ì(€€€€€€€ô((€€€€€ô…Ñ ¡”¤ì(€€€€€€€±½œ¡ƒŠj€ÉÉ½È½¸•µ…¥°€‘í¤€¬€Åôè€‘í”¹µ•ÍÍ…•õ€°€Ý…É¸œ¤ì(€€€€€ô((€€€€€€¼¼I…Ñ”±¥µ¥ÐÍ…™•Ñä(€€€€€¥˜€¡¤€”€Ô€ôôô€À¤…Ý…¥Ð¹•ÜAÉ½µ¥Í”¡È€ôøÍ•ÑQ¥µ•½ÕÐ¡È°€ÈÀÀ¤¤ì(€€€ô((€€€Íå¹AÉ½É•ÍÌ¹ÁÐ€ô€ÄÀÀì(€€€Íå¹AÉ½É•ÍÌ¹ÍÕˆ€ô€Må¹Œ½µÁ±•Ñ”„œì(€€€±½œ¡ƒŠr½¹”ƒŠP€‘íÍå¹AÉ½É•ÍÌ¹Á…ÉÑÍôÁ…ÉÑÌ°€‘íÍå¹AÉ½É•ÍÌ¹µ…¹Õ…±Íôµ…¹Õ…±Ì™É½´€‘íµ•ÍÍ…•Ì¹±•¹Ñ¡ô•µ…¥±Í€°€½¬œ¤ì((€€€‘ˆ¹ÁÉ•Á…É” UAQÍå¹}±½œMP½µÁ±•Ñ•‘}…Ðõ‘…Ñ•Ñ¥µ” ‰¹½Üˆ¤°•µ…¥±Í}Í…¹¹•ôü°Á…ÉÑÍ}™½Õ¹ôü°µ…¹Õ…±Í}™½Õ¹ôü°ÍÑ…ÑÕÌô‰½µÁ±•Ñ”ˆ°±½œôü]!I¥ôüœ¤(€€€€€€¹ÉÕ¸¡µ•ÍÍ…•Ì¹±•¹Ñ °Íå¹AÉ½É•ÍÌ¹Á…ÉÑÌ°Íå¹AÉ½É•ÍÌ¹µ…¹Õ…±Ì°)M=8¹ÍÑÉ¥¹¥™ä¡Íå¹1½œ¤°±½%¤ì((€ô…Ñ ¡”¤ì(€€€±½œ¡ƒŠv0Må¹Œ™…¥±•è€‘í”¹µ•ÍÍ…•õ€°€•ÉÈœ¤ì(€€€‘ˆ¹ÁÉ•Á…É” UAQÍå¹}±½œMP½µÁ±•Ñ•‘}…Ðõ‘…Ñ•Ñ¥µ” ‰¹½Üˆ¤°ÍÑ…ÑÕÌô‰•ÉÉ½Èˆ°±½œôü]!I¥ôüœ¤(€€€€€€¹ÉÕ¸¡)M=8¹ÍÑÉ¥¹¥™ä¡Íå¹1½œ¤°±½%¤ì(€ô™¥¹…±±äì(€€€Íå¹%¹AÉ½É•ÍÌ€ô™…±Í”ì(€ô)ô((¼¼€´´A$I=UQL€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´((¼¼MÑ…ÑÌ)…ÁÀ¹•Ð œ½…Á¤½ÍÑ…ÑÌœ°€¡É•Ä°É•Ì¤€ôøì(€½¹ÍÐÁ…ÉÑÌ€ô‘ˆ¹ÁÉ•Á…É” M1P=U9P ¨¤…ÌŒI=4Á…ÉÑÌœ¤¹•Ð ¤¹Œì(€½¹ÍÐµ…¹Õ…±Ì€ô‘ˆ¹ÁÉ•Á…É” M1P=U9P ¨¤…ÌŒI=4µ…¹Õ…±Ìœ¤¹•Ð ¤¹Œì(€½¹ÍÐÝ¥Ñ¡AÉ¥¥¹œ€ô‘ˆ¹ÁÉ•Á…É” M1P=U9P ¨¤…ÌŒI=4Á…ÉÑÌ]!I±¥ÍÑ}ÁÉ¥”%L9=P9U109å½ÕÉ}½ÍÐ%L9=P9U10œ¤¹•Ð ¤¹Œì(€½¹ÍÐÅÕ½Ñ•Ì€ô‘ˆ¹ÁÉ•Á…É” ‰M1P=U9P¡%MQ%9PÅÕ½Ñ•}¹Õ´¤…ÌŒI=4Á…ÉÑÌ]!IÅÕ½Ñ•}¹Õ´%L9=P9U10ˆ¤¹•Ð ¤¹Œì(€½¹ÍÐ±…ÍÑMå¹Œ€ô‘ˆ¹ÁÉ•Á…É” M1P€¨I=4Íå¹}±½œ=IH	d¥M1%5%P€Äœ¤¹•Ð ¤ì(€É•Ì¹©Í½¸¡ìÁ…ÉÑÌ°µ…¹Õ…±Ì°Ý¥Ñ¡AÉ¥¥¹œ°ÅÕ½Ñ•Ì°±…ÍÑMå¹Œ°µ…¥±½¹¹•Ñ•è€„…•ÑM•ÑÑ¥¹œ µ…¥±}…•ÍÍ}Ñ½­•¸œ¤ô¤ì)ô¤ì((¼¼A…ÉÑÌ)…ÁÀ¹•Ð œ½…Á¤½Á…ÉÑÌœ°€¡É•Ä°É•Ì¤€ôøì(€½¹ÍÐìÄ°…Ñ•½Éä°Í•É¥•Ì°ÅÕ½Ñ”°Í½ÉÐ€ô€Á…ÉÑ}¹Õ´œ°±¥µ¥Ð€ô€ÈÀÀ°½™™Í•Ð€ô€Àô€ôÉ•Ä¹ÅÕ•Éäì(€±•ÐÍÅ°€ô€M1P€¨I=4Á…ÉÑÌ]!I€ÄôÄœì(€½¹ÍÐÁ…É…µÌ€ômtì(€¥˜€¡Ä¤ìÍÅ°€¬ô€œ9€¡Á…ÉÑ}¹Õ´1%-€ü=H¹…µ”1%-€ü=H¹½Ñ•Ì1%-€ü=HáÉ•˜1%-€ü¤œì½¹ÍÐ±¥­”€ô€”‘íÅô•€ìÁ…É…µÌ¹ÁÕÍ ¡±¥­”±±¥­”±±¥­”±±¥­”¤ìô(€¥˜€¡…Ñ•½Éä¤ìÍÅ°€¬ô€œ9…Ñ•½Éä€ô€üœìÁ…É…µÌ¹ÁÕÍ ¡…Ñ•½Éä¤ìô(€¥˜€¡Í•É¥•Ì¤ìÍÅ°€¬ô€œ9Í•É¥•Ì€ô€üœìÁ…É…µÌ¹ÁÕÍ ¡Í•É¥•Ì¤ìô(€¥˜€¡ÅÕ½Ñ”¤ìÍÅ°€¬ô€œ9ÅÕ½Ñ•}¹Õ´€ô€üœìÁ…É…µÌ¹ÁÕÍ ¡ÅÕ½Ñ”¤ìô(€½¹ÍÐ…±±½Ý•€ôlÁ…ÉÑ}¹Õ´œ°…Ñ•½Éäœ°Í•É¥•Ìœ°±¥ÍÑ}ÁÉ¥”œ°å½ÕÉ}½ÍÐœ°‘…Ñ”œ°¹…µ”tì(€ÍÅ°€¬ô€=IH	d€‘í…±±½Ý•¹¥¹±Õ‘•Ì¡Í½ÉÐ¤€üÍ½ÉÐ€è€Á…ÉÑ}¹Õ´ô1%5%P€ü=MP€ý€ì(€Á…É…µÌ¹ÁÕÍ ¡Á…ÉÍ•%¹Ð¡±¥µ¥Ð¤°Á…ÉÍ•%¹Ð¡½™™Í•Ð¤¤ì(€½¹ÍÐÉ½ÝÌ€ô‘ˆ¹ÁÉ•Á…É”¡ÍÅ°¤¹…±° ¸¸¹Á…É…µÌ¤ì(€É•Ì¹©Í½¸¡É½ÝÌ¹µ…À¡È€ôø€¡ì€¸¸¹È°áÉ•˜è)M=8¹Á…ÉÍ”¡È¹áÉ•˜ñð€mtœ¤ô¤¤¤ì)ô¤ì()…ÁÀ¹•Ð œ½…Á¤½Á…ÉÑÌ¼é¥œ°€¡É•Ä°É•Ì¤€ôøì(€½¹ÍÐÉ½Ü€ô‘ˆ¹ÁÉ•Á…É” M1P€¨I=4Á…ÉÑÌ]!I¥€ô€üœ¤¹•Ð¡É•Ä¹Á…É…µÌ¹¥¤ì(€¥˜€ …É½Ü¤É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÐ¤¹©Í½¸¡ì•ÉÉ½Èè€9½Ð™½Õ¹œô¤ì(€É•Ì¹©Í½¸¡ì€¸¸¹É½Ü°áÉ•˜è)M=8¹Á…ÉÍ”¡É½Ü¹áÉ•˜ñð€mtœ¤ô¤ì)ô¤ì()…ÁÀ¹Á½ÍÐ œ½…Á¤½Á…ÉÑÌœ°€¡É•Ä°É•Ì¤€ôøì(€½¹ÍÐìÁ…ÉÑ}¹Õ´°¹…µ”°…Ñ•½Éä°Í•É¥•Ì°±¥ÍÑ}ÁÉ¥”°å½ÕÉ}½ÍÐ°ÅÕ½Ñ•}¹Õ´°¹½Ñ•Ì°áÉ•˜ô€ôÉ•Ä¹‰½‘äì(€¥˜€ …Á…ÉÑ}¹Õ´¤É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÀ¤¹©Í½¸¡ì•ÉÉ½Èè€Á…ÉÑ}¹Õ´É•ÅÕ¥É•œô¤ì(€½¹ÍÐ¥€ôµ…¹Õ…±|‘íÁ…ÉÑ}¹Õµõ|‘í…Ñ”¹¹½Ü ¥õ€ì(€‘ˆ¹ÁÉ•Á…É”¡%9MIP=HIA1%9Q<Á…ÉÑÌ€¡¥°Á…ÉÑ}¹Õ´°¹…µ”°…Ñ•½Éä°Í•É¥•Ì°±¥ÍÑ}ÁÉ¥”°å½ÕÉ}½ÍÐ°ÅÕ½Ñ•}¹Õ´°¹½Ñ•Ì°áÉ•˜°ÍÕÁÁ±¥•È°ÕÁ‘…Ñ•‘}…Ð¤(€€€Y1UL€ ü°€ü°€ü°€ü°€ü°€ü°€ü°€ü°€ü°€ü°€%¹•ÉÍ½±°I…¹œ°‘…Ñ•Ñ¥µ” ¹½Üœ¤¥€¤(€€€€¹ÉÕ¸¡¥°Á…ÉÑ}¹Õ´°¹…µ”ñð€œœ°…Ñ•½Éäñð€œœ°Í•É¥•Ìñð€œœ°±¥ÍÑ}ÁÉ¥”ñð¹Õ±°°å½ÕÉ}½ÍÐñð¹Õ±°°ÅÕ½Ñ•}¹Õ´ñð¹Õ±°°¹½Ñ•Ìñð€œœ°)M=8¹ÍÑÉ¥¹¥™ä¡áÉ•˜ñðmt¤¤ì(€É•Ì¹©Í½¸¡ì½¬èÑÉÕ”°¥ô¤ì)ô¤ì()…ÁÀ¹ÁÕÐ œ½…Á¤½Á…ÉÑÌ¼é¥œ°€¡É•Ä°É•Ì¤€ôøì(€½¹ÍÐì¹…µ”°…Ñ•½Éä°Í•É¥•Ì°±¥ÍÑ}ÁÉ¥”°å½ÕÉ}½ÍÐ°¹½Ñ•Ì°áÉ•˜ô€ôÉ•Ä¹‰½‘äì(€‘ˆ¹ÁÉ•Á…É” UAQÁ…ÉÑÌMP¹…µ”ôü°…Ñ•½Éäôü°Í•É¥•Ìôü°±¥ÍÑ}ÁÉ¥”ôü°å½ÕÉ}½ÍÐôü°¹½Ñ•Ìôü°áÉ•˜ôü°ÕÁ‘…Ñ•‘}…Ðõ‘…Ñ•Ñ¥µ” ‰¹½Üˆ¤]!I¥ôüœ¤(€€€€¹ÉÕ¸¡¹…µ”°…Ñ•½Éä°Í•É¥•Ì°±¥ÍÑ}ÁÉ¥”°å½ÕÉ}½ÍÐ°¹½Ñ•Ì°)M=8¹ÍÑÉ¥¹¥™ä¡áÉ•˜ñðmt¤°É•Ä¹Á…É…µÌ¹¥¤ì(€É•Ì¹©Í½¸¡ì½¬èÑÉÕ”ô¤ì)ô¤ì()…ÁÀ¹‘•±•Ñ” œ½…Á¤½Á…ÉÑÌ¼é¥œ°€¡É•Ä°É•Ì¤€ôøì(€‘ˆ¹ÁÉ•Á…É” 1QI=4Á…ÉÑÌ]!I¥€ô€üœ¤¹ÉÕ¸¡É•Ä¹Á…É…µÌ¹¥¤ì(€É•Ì¹©Í½¸¡ì½¬èÑÉÕ”ô¤ì)ô¤ì((¼¼¥±Ñ•È½ÁÑ¥½¹Ì)…ÁÀ¹•Ð œ½…Á¤½Á…ÉÑÌ½µ•Ñ„½™¥±Ñ•ÉÌœ°€¡É•Ä°É•Ì¤€ôøì(€½¹ÍÐ…Ñ•½É¥•Ì€ô‘ˆ¹ÁÉ•Á…É” M1P%MQ%9P…Ñ•½ÉäI=4Á…ÉÑÌ]!I…Ñ•½Éä€„ô€ˆˆ=IH	d…Ñ•½Éäœ¤¹…±° ¤¹µ…À¡È€ôøÈ¹…Ñ•½Éä¤ì(€½¹ÍÐÍ•É¥•Ì€ô‘ˆ¹ÁÉ•Á…É” M1P%MQ%9PÍ•É¥•ÌI=4Á…ÉÑÌ]!IÍ•É¥•Ì€„ô€ˆˆ=IH	dÍ•É¥•Ìœ¤¹…±° ¤¹µ…À¡È€ôøÈ¹Í•É¥•Ì¤ì(€½¹ÍÐÅÕ½Ñ•Ì€ô‘ˆ¹ÁÉ•Á…É” M1P%MQ%9PÅÕ½Ñ•}¹Õ´I=4Á…ÉÑÌ]!IÅÕ½Ñ•}¹Õ´%L9=P9U10=IH	dÅÕ½Ñ•}¹Õ´M1%5%P€ÌÀœ¤¹…±° ¤¹µ…À¡È€ôøÈ¹ÅÕ½Ñ•}¹Õ´¤ì(€É•Ì¹©Í½¸¡ì…Ñ•½É¥•Ì°Í•É¥•Ì°ÅÕ½Ñ•Ìô¤ì)ô¤ì((¼¼5…¹Õ…±Ì)…ÁÀ¹•Ð œ½…Á¤½µ…¹Õ…±Ìœ°€¡É•Ä°É•Ì¤€ôøì(€½¹ÍÐìÄô€ôÉ•Ä¹ÅÕ•Éäì(€±•ÐÍÅ°€ô€M1P€¨I=4µ…¹Õ…±Ì]!I€ÄôÄœì(€½¹ÍÐÁ…É…µÌ€ômtì(€¥˜€¡Ä¤ìÍÅ°€¬ô€œ9€¡Ñ¥Ñ±”1%-€ü=Hµ½‘•±Ì1%-€ü=HÍ½ÕÉ•}ÍÕ‰©•Ð1%-€ü¤œì½¹ÍÐ±¥­”€ô€”‘íÅô•€ìÁ…É…µÌ¹ÁÕÍ ¡±¥­”±±¥­”±±¥­”¤ìô(€ÍÅ°€¬ô€œ=IH	d‘…Ñ”M°É•…Ñ•‘}…ÐMœì(€½¹ÍÐÉ½ÝÌ€ô‘ˆ¹ÁÉ•Á…É”¡ÍÅ°¤¹…±° ¸¸¹Á…É…µÌ¤ì(€É•Ì¹©Í½¸¡É½ÝÌ¹µ…À¡È€ôø€¡ì€¸¸¹È°µ½‘•±Ìè)M=8¹Á…ÉÍ”¡È¹µ½‘•±Ìñð€mtœ¤ô¤¤¤ì)ô¤ì()…ÁÀ¹‘•±•Ñ” œ½…Á¤½µ…¹Õ…±Ì¼é¥œ°€¡É•Ä°É•Ì¤€ôøì(€½¹ÍÐµ…¹Õ…°€ô‘ˆ¹ÁÉ•Á…É” M1P€¨I=4µ…¹Õ…±Ì]!I¥€ô€üœ¤¹•Ð¡É•Ä¹Á…É…µÌ¹¥¤ì(€¥˜€¡µ…¹Õ…°€˜˜µ…¹Õ…°¹™¥±•¹…µ”¤ì(€€€½¹ÍÐ™À€ôÁ…Ñ ¹©½¥¸¡UA1=M}%H°µ…¹Õ…°¹™¥±•¹…µ”¤ì(€€€¥˜€¡™Ì¹•á¥ÍÑÍMå¹Œ¡™À¤¤™Ì¹Õ¹±¥¹­Må¹Œ¡™À¤ì(€ô(€‘ˆ¹ÁÉ•Á…É” 1QI=4µ…¹Õ…±Ì]!I¥€ô€üœ¤¹ÉÕ¸¡É•Ä¹Á…É…µÌ¹¥¤ì(€É•Ì¹©Í½¸¡ì½¬èÑÉÕ”ô¤ì)ô¤ì((¼¼5…¹Õ…°ÕÁ±½…•¹‘Á½¥¹Ð)…ÁÀ¹Á½ÍÐ œ½…Á¤½µ…¹Õ…±Ì½ÕÁ±½…œ°ÕÁ±½…¹…ÉÉ…ä Á‘™Ìœ°€ÈÀ¤°…Íå¹Œ€¡É•Ä°É•Ì¤€ôøì(€½¹ÍÐÉ•ÍÕ±ÑÌ€ômtì(€™½È€¡½¹ÍÐ™¥±”½˜É•Ä¹™¥±•Ìñðmt¤ì(€€€ÑÉäì(€€€€€½¹ÍÐÁ‘™	Õ™™•È€ô™Ì¹É•…‘¥±•Må¹Œ¡™¥±”¹Á…Ñ ¤ì(€€€€€±•ÐÁ‘™Q•áÐ€ô€œœ°Á…•Ì€ô€Àì(€€€€€ÑÉäì½¹ÍÐÀ€ô…Ý…¥ÐÁ‘™A…ÉÍ”¡Á‘™	Õ™™•È¤ìÁ‘™Q•áÐ€ôÀ¹Ñ•áÐìÁ…•Ì€ôÀ¹¹ÕµÁ…•Ììô…Ñ ¡”¤íô(€€€€€½¹ÍÐµ½‘•±Ì€ô•áÑÉ…Ñ5½‘•±ÍÉ½µQ•áÐ¡Á‘™Q•áÐ€¬€œ€œ€¬™¥±”¹½É¥¥¹…±¹…µ”¤ì(€€€€€½¹ÍÐÑ¥Ñ±”€ô€¡É•Ä¹‰½‘ä¹Ñ¥Ñ±”ñð™¥±”¹½É¥¥¹…±¹…µ”¤¹É•Á±…” ½p¹qÜ¬¼°€œœ¤¹É•Á±…” ½|½œ°€œ€œ¤ì(€€€€€½¹ÍÐ¥€ôÕÁ±½…‘|‘í…Ñ”¹¹½Ü ¥õ|‘í5…Ñ ¹É…¹‘½´ ¤¹Ñ½MÑÉ¥¹œ ÌØ¤¹Í±¥” È¥õ€ì(€€€€€‘ˆ¹ÁÉ•Á…É” %9MIP%9Q<µ…¹Õ…±Ì€¡¥°Ñ¥Ñ±”°µ½‘•±Ì°™¥±•¹…µ”°™¥±•Á…Ñ °™¥±•}Í¥é”°Á…•Ì°Í½ÕÉ•}ÍÕ‰©•Ð°‘…Ñ”°ÕÁ±½…‘•‘}‰ä¤Y1UL€ ü°ü°ü°ü°ü°ü°ü°ü±‘…Ñ•Ñ¥µ” ‰¹½Üˆ¤°‰µ…¹Õ…°ˆ¤œ¤(€€€€€€€€¹ÉÕ¸¡¥°Ñ¥Ñ±”°)M=8¹ÍÑÉ¥¹¥™ä¡µ½‘•±Ì¤°™¥±”¹™¥±•¹…µ”°€½ÕÁ±½…‘Ì¼‘í™¥±”¹™¥±•¹…µ•õ€°™¥±”¹Í¥é”°Á…•Ì°™¥±”¹½É¥¥¹…±¹…µ”¤ì((€€€€€€¼¼áÑÉ…ÐÁ…ÉÑÌ™É½´ÕÁ±½…‘•A(€€€€€½¹ÍÐÁ…ÉÑÌ€ô•áÑÉ…ÑA…ÉÑÍÉ½µQ•áÐ¡Á‘™Q•áÐ°¹Õ±°°¹•Ü…Ñ” ¤¹Ñ½%M=MÑÉ¥¹œ ¤¹ÍÁ±¥Ð Pœ¥lÁt¤ì(€€€€€½¹ÍÐ¥¹Ì€ô‘ˆ¹ÑÉ…¹Í…Ñ¥½¸  ¤€ôøì(€€€€€€€™½È€¡½¹ÍÐÀ½˜Á…ÉÑÌ¤‘ˆ¹ÁÉ•Á…É” %9MIP=H%9=I%9Q<Á…ÉÑÌ€¡¥±Á…ÉÑ}¹Õ´±¹…µ”±…Ñ•½Éä±Í•É¥•Ì±±¥ÍÑ}ÁÉ¥”±å½ÕÉ}½ÍÐ±¹½Ñ•Ì±áÉ•˜±ÍÕÁÁ±¥•È¤Y1UL€ ü°ü°ü°ü°ü°ü°ü°ü°ü°ü¤œ¤¹ÉÕ¸¡À¹¥±À¹Á…ÉÑ}¹Õ´±À¹¹…µ”±À¹…Ñ•½Éä±À¹Í•É¥•Ì±À¹±¥ÍÑ}ÁÉ¥”±À¹å½ÕÉ}½ÍÐ±À¹¹½Ñ•Ì±À¹áÉ•˜°%¹•ÉÍ½±°I…¹œ¤ì(€€€€€ô¤ì(€€€€€¥¹Ì ¤ì(€€€€€É•ÍÕ±ÑÌ¹ÁÕÍ ¡ì½¬èÑÉÕ”°¥°Ñ¥Ñ±”°µ½‘•±Ì°Á…ÉÑÌèÁ…ÉÑÌ¹±•¹Ñ °Á…•Ìô¤ì(€€€ô…Ñ ¡”¤ì(€€€€€É•ÍÕ±ÑÌ¹ÁÕÍ ¡ì½¬è™…±Í”°™¥±•¹…µ”è™¥±”¹½É¥¥¹…±¹…µ”°•ÉÉ½Èè”¹µ•ÍÍ…”ô¤ì(€€€ô(€ô(€É•Ì¹©Í½¸¡É•ÍÕ±ÑÌ¤ì)ô¤ì((¼¼M•…É …É½ÍÌ‰½Ñ )…ÁÀ¹•Ð œ½…Á¤½Í•…É œ°€¡É•Ä°É•Ì¤€ôøì(€½¹ÍÐìÄô€ôÉ•Ä¹ÅÕ•Éäì(€¥˜€ …Ä¤É•ÑÕÉ¸É•Ì¹©Í½¸¡ìÁ…ÉÑÌèmt°µ…¹Õ…±Ìèmtô¤ì(€½¹ÍÐ±¥­”€ô€”‘íÅô•€ì(€½¹ÍÐÁ…ÉÑÌ€ô‘ˆ¹ÁÉ•Á…É” M1P€¨I=4Á…ÉÑÌ]!IÁ…ÉÑ}¹Õ´1%-€ü=H¹…µ”1%-€ü=H¹½Ñ•Ì1%-€ü=HáÉ•˜1%-€ü1%5%P€ÔÀœ¤¹…±°¡±¥­”±±¥­”±±¥­”±±¥­”¤(€€€€¹µ…À¡È€ôø€¡ì€¸¸¹È°áÉ•˜è)M=8¹Á…ÉÍ”¡È¹áÉ•˜ñð€mtœ¤ô¤¤ì(€½¹ÍÐµ…¹Õ…±Ì€ô‘ˆ¹ÁÉ•Á…É” M1P€¨I=4µ…¹Õ…±Ì]!IÑ¥Ñ±”1%-€ü=Hµ½‘•±Ì1%-€ü=HÍ½ÕÉ•}ÍÕ‰©•Ð1%-€ü1%5%P€ÈÀœ¤¹…±°¡±¥­”±±¥­”±±¥­”¤(€€€€¹µ…À¡È€ôø€¡ì€¸¸¹È°µ½‘•±Ìè)M=8¹Á…ÉÍ”¡È¹µ½‘•±Ìñð€mtœ¤ô¤¤ì(€É•Ì¹©Í½¸¡ìÁ…ÉÑÌ°µ…¹Õ…±Ìô¤ì)ô¤ì((¼¼ÕÑ ÍÑ…ÑÕÌ)…ÁÀ¹•Ð œ½…Á¤½…ÕÑ ½ÍÑ…ÑÕÌœ°€¡É•Ä°É•Ì¤€ôøì(€É•Ì¹©Í½¸¡ì½¹¹•Ñ•è€„…•ÑM•ÑÑ¥¹œ µ…¥±}…•ÍÍ}Ñ½­•¸œ¤°•áÁ¥Éäè•ÑM•ÑÑ¥¹œ µ…¥±}Ñ½­•¹}•áÁ¥Éäœ¤ô¤ì)ô¤ì()…ÁÀ¹Á½ÍÐ œ½…Á¤½…ÕÑ ½‘¥Í½¹¹•Ðœ°€¡É•Ä°É•Ì¤€ôøì(€‘ˆ¹ÁÉ•Á…É” ‰1QI=4Í•ÑÑ¥¹Ì]!I­•ä%8€ µ…¥±}…•ÍÍ}Ñ½­•¸œ°µ…¥±}É•™É•Í¡}Ñ½­•¸œ°µ…¥±}Ñ½­•¹}•áÁ¥Éäœ¤ˆ¤¹ÉÕ¸ ¤ì(€É•Ì¹©Í½¸¡ì½¬èÑÉÕ”ô¤ì)ô¤ì((¼¼€´´MQIP€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´)…ÁÀ¹±¥ÍÑ•¸¡A=IP°€ ¤€ôøì(€½¹Í½±”¹±½œ¡q»Â~RÐ5%HA…ÉÑÌQ½½°ÉÕ¹¹¥¹œ½¸¡ÑÑÀè¼½±½…±¡½ÍÐè‘íA=IQõ€¤ì(€½¹Í½±”¹±½œ¡€€€µ…¥°½¹¹•Ñ•è€‘ì„…•ÑM•ÑÑ¥¹œ µ…¥±}…•ÍÍ}Ñ½­•¸œ¥õ€¤ì(€½¹Í½±”¹±½œ¡€€€A…ÉÑÌ¥¸è€‘í‘ˆ¹ÁÉ•Á…É” M1P=U9P ¨¤…ÌŒI=4Á…ÉÑÌœ¤¹•Ð ¤¹õ€¤ì(€½¹Í½±”¹±½œ¡€€€5…¹Õ…±Ì¥¸è€‘í‘ˆ¹ÁÉ•Á…É” M1P=U9P ¨¤…ÌŒI=4µ…¹Õ…±Ìœ¤¹•Ð ¤¹õq¹€¤ì)ô¤ì(