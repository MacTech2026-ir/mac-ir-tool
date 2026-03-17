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
  CREATE TABLE IF NOT EX	STS manuals (
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
});‚˜\œ]
	ËØ\KÜ\ËÎšY	Ë
™\K™\ÊHOˆÂˆÛÛœİÈ˜[YKØ]YÛÜKÙ\šY\Ë\İÜšXÙK[İ\—ØÛÜİ›İ\Ë™YˆHH™\K˜›ÙNÂˆ‹œ™\\™J	ÕTUH\ÈÑU˜[YOOËØ]YÛÜOOËÙ\šY\ÏOË\İÜšXÙOOË[İ\—ØÛÜİOË›İ\ÏOË™YOË\]YØ]Y]][YJ››İÈŠHÒT‘HYOÉÊBˆœ[Š˜[YKØ]YÛÜKÙ\šY\Ë\İÜšXÙK[İ\—ØÛÜİ›İ\Ë”ÓÓ‹œİš[™ÚYJ™Yˆ×JK™\Kœ\˜[\ËšY
NÂˆ™\ËšœÛÛŠÈÚÎˆYHJNÂŸJNÂ‚˜\™[]J	ËØ\KÜ\ËÎšY	Ë
™\K™\ÊHOˆÂˆ‹œ™\\™J	ÑSUH”+ÓH\ÈÒT‘HYHÉÊKœ[Š™\Kœ\˜[\ËšY
NÂˆ™\ËšœÛÛŠÈÚÎˆYHJNÂŸJNÂ‚‹ËÈš[\ˆÜ[ÛœÂ˜\™Ù]
	ËØ\KÜ\ËÛY]KÙš[\œÉË
™\K™\ÊHOˆÂˆÛÛœİØ]YÛÜšY\ÈH‹œ™\\™J	ÔÑSPÕTÕSÕØ]YÛÜH”“ÓH\ÈÒT‘HØ]YÛÜHOHˆˆÔ‘Tˆ–HØ]YÛÜIÊK˜[

K›X\
ˆOˆ‹˜Ø]YÛÜJNÂˆÛÛœİÙ\šY\ÈH‹œ™\\™J	ÔÑSPÕTÕSÕÙ\šY\È”“ÓH\ÈÒT‘HÙ\šY\ÈOHˆˆÔ‘Tˆ–HÙ\šY\ÉÊK˜[

K›X\
ˆOˆ‹œÙ\šY\ÊNÂˆÛÛœİ][İ\ÈH‹œ™\\™J	ÔÑSPÕTÕSÕ][İWÛ[H”“ÓH\ÈÒT‘H][İWÛ[HTÈ“Õ•SÔ‘Tˆ–H][İWÛ[HTĞÈSRU	ÊK˜[

K›X\
ˆOˆ‹œ][İWÛ[JNÂˆ™\ËšœÛÛŠÈØ]YÛÜšY\ËÙ\šY\Ë][İ\ÈJNÂŸJNÂ‚‹ËÈX[X[Â˜\™Ù]
	ËØ\KÛX[X[ÉË
™\K™\ÊHOˆÂˆÛÛœİÈHHH™\Kœ]Y\NÂˆ]Ü[H	ÔÑSPÕ
ˆ”“ÓHX[X[ÈÒT‘HOLIÎÂˆÛÛœİ\˜[\ÈH×NÂˆYˆ
JHÈÜ[
ÏH	ÈS‘
]HRÑHÈÔˆ[Ù[ÈRÑHÈÔˆÛİ\˜ÙWÜİXš™XİRÑHÊIÎÈÛÛœİZÙHH	IÜ_IXÈ\˜[\Ëœ\Ú
ZÙKZÙKZÙJNÈBˆÜ[
ÏH	ÈÔ‘Tˆ–H]HTĞËÜ™X]YØ]TĞÉÎÂˆÛÛœİ›İÜÈH‹œ™\\™JÜ[
K˜[
‹‹œ\˜[\ÊNÂˆ™\ËšœÛÛŠ›İÜË›X\
ˆOˆ
È‹‹œ‹[Ù[Îˆ”ÓÓ‹œ\œÙJ‹›[Ù[È	Ö×IÊHJJJNÂŸJNÂ‚˜\™[]J	ËØ\KÛX[X[ËÎšY	Ë
™\K™\ÊHOˆÂˆÛÛœİX[X[H‹œ™\\™J	ÔÑSPÕ
ˆ”“ÓHX[X[ÈÒT‘HYHÉÊK™Ù]
™\Kœ\˜[\ËšY
NÂˆYˆ
X[X[	‰ˆX[X[™š[[˜[YJHÂˆÛÛœİœH]š›Ú[ŠTĞQ×ÑT‹X[X[™š[[˜[YJNÂˆYˆ
œË™^\İÔŞ[˜Êœ
JHœË[›[šÔŞ[˜Êœ
NÂˆBˆ‹œ™\\™J	ÑSUH”“ÓHX[X[ÈÒT‘HYHÉÊKœ[Š™\Kœ\˜[\ËšY
NÂˆ™\ËšœÛÛŠÈÚÎˆYHJNÂŸJNÂ‚‹ËÈX[X[\ØY[™Ú[˜\œÜİ
	ËØ\KÛX[X[Ëİ\ØY	Ë\ØY˜\œ˜^J	ÜœÉËŒ
K\Ş[˜È
™\K™\ÊHOˆÂˆÛÛœİ™\İ[ÈH×NÂˆ›Üˆ
ÛÛœİš[HÙˆ™\K™š[\È×JHÂˆHÂˆÛÛœİY™™\ˆHœËœ™XYš[TŞ[˜Êš[Kœ]
NÂˆ]•^H	ÉËYÙ\ÈHÂˆHÈÛÛœİH]ØZ]”\œÙJY™™\ŠNÈ•^H^ÈYÙ\ÈH›[\YÙ\ÎÈHØ]Ú
JHßBˆÛÛœİ[Ù[ÈH^˜Xİ[Ù[Ñœ›ÛU^
•^
È	È	È
Èš[K›ÜšYÚ[˜[˜[YJNÂˆÛÛœİ]HH
™\K˜›ÙK]Hš[K›ÜšYÚ[˜[˜[YJKœ™\XÙJ×—ÊÉË	ÉÊKœ™\XÙJ×ËÙË	È	ÊNÂˆÛÛœİYH\ØYÉÑ]K››İÊ
_WÉÓX]œ˜[™ÛJ
KÔİš[™ÊÍŠKœÛXÙJŠ_XÂˆ‹œ™\\™J	ÒS”ÑT•”“ÓHX[X[È
Y]K[Ù[Ëš[[˜[YKš[\]š[WÜÚ^™KYÙ\ËÛİ\˜ÙWÜİXš™Xİ]K\ØYYØJHU•TU2ƒòÃòÃòÃòÃòÃòÃòÃòÃòÆFFWF–ÖR‚&æ÷r"’Â&ÖçVÂ"’r¢ç'Vâ†–BÂF—FÆRÂ¥4ôâç7G&–æv–g’†ÖöFVÇ2’Âf–ÆRæf–ÆVæÖRÂ÷WÆöG2òG¶f–ÆRæf–ÆVæÖWÖÂf–ÆRç6—¦RÂvW2Âf–ÆRæ÷&–v–æÆæÖR“° ¢òòW‡G&7B'G2g&öÒWÆöFVBD`¢6öç7B'G2ÒW‡G&7E'G4g&öÕFW‡B‡FeFW‡BÂçVÆÂÂæWrFFR‚’çFô•4õ7G&–ær‚’ç7Æ—B‚uBr•³Ò“°¢6öç7B–ç2ÒF"çG&ç67F–öâ‚‚’Óâ°¢f÷"†6öç7Böb'G2’F"ç&W&R‚t”å4U%Bõ"”täõ$R”åDò'G2†–BÇ'EöçVÒÆæÖRÆ6FVv÷'’Ç6W&–W2ÆÆ—7E÷&–6RÇ–÷W%ö6÷7BÆæ÷FW2Ç‡&VbÇ7WÆ–W"’dÅTU2ƒòÃòÃòÃòÃòÃòÃòÃòÃòÃòÃò’r’ç'Vâ‡æ–BÇç'EöçVÒÇææÖRÇæ6FVv÷'’Çç6W&–W2ÇæÆ—7E÷&–6RÇç–÷W%ö6÷7BÇææ÷FW2Çç‡&VbÂt–ævW'6öÆÂ&æBr“°¢Ò“°¢–ç2‚“°¢&W7VÇG2çW6‚‡²ö³¢G'VRÂ–BÂF—FÆRÂÖöFVÇ2Â'G3¢'G2æÆVæwF‚ÂvW2Ò“°¢Ò6F6‚†R’°¢&W7VÇG2çW6‚‡²ö³¢fÇ6RÂf–ÆVæÖS¢f–ÆRæ÷&–v–æÆæÖRÂW'&÷#¢RæÖW76vRÒ“°¢Ğ¢Ğ¢&W2æ§6öâ‡&W7VÇG2“°§Ò“° ¢òò6V&6‚7&÷72&÷F€¦ævWB‚rö’÷6V&6‚rÂ‡&WÂ&W2’Óâ°¢6öç7B²ÒÒ&WçVW'“°¢–b‚’&WGW&â&W2æ§6öâ‡²'G3¢µÒÂÖçVÇ3¢µÒÒ“°¢6öç7BÆ–¶RÒRG·ÒV°¢6öç7B'G2ÒF"ç&W&R‚u4TÄT5B¢e$ôÒ'G2t„U$R'EöçVÒÄ”´Ròõ"æÖRÄ”´Ròõ"æ÷FW2Ä”´Ròõ"‡&VbÄ”´RòÄ”Ô•BSr’æÆÂ†Æ–¶RÆÆ–¶RÆÆ–¶RÆÆ–¶R¢æÖ‡"Óâ‡²ââç"Â‡&Vc¢¥4ôâç'6R‡"ç‡&VbÇÂuµÒr’Ò’“°¢6öç7BÖçVÇ2ÒF"ç&W&R‚u4TÄT5B¢e$ôÒÖçVÇ2t„U$RF—FÆRÄ”´Ròõ"ÖöFVÇ2Ä”´Ròõ"6÷W&6U÷7V&¦V7BÄ”´RòÄ”Ô•B#r’æÆÂ†Æ–¶RÆÆ–¶RÆÆ–¶R¢æÖ‡"Óâ‡²ââç"ÂÖöFVÇ3¢¥4ôâç'6R‡"æÖöFVÇ2ÇÂuµÒr’Ò’“°¢&W2æ§6öâ‡²'G2ÂÖçVÇ2Ò“°§Ò“° ¢òòWF‚7FGW0¦ævWB‚rö’öWF‚÷7FGW2rÂ‡&WÂ&W2’Óâ°¢&W2æ§6öâ‡²6öææV7FVC¢vWE6WGF–ær‚vvÖ–Åö66W75÷Fö¶Vâr’ÂW‡—'“¢vWE6WGF–ær‚vvÖ–Å÷Fö¶VåöW‡—'’r’Ò“°§Ò“° ¦ç÷7B‚rö’öWF‚öF—66öææV7BrÂ‡&WÂ&W2’Óâ°¢F"ç&W&R‚$DTÄUDRe$ôÒ6WGF–æw2t„U$R¶W’”â‚vvÖ–Åö66W75÷Fö¶VârÂvvÖ–Å÷&Vg&W6…÷Fö¶VârÂvvÖ–Å÷Fö¶VåöW‡—'’r’"’ç'Vâ‚“°¢&W2æ§6öâ‡²ö³¢G'VRÒ“°§Ò“° ¢òòÒÒ5D%BÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒĞ¦æÆ—7FVâ…õ%BÂ‚’Óâ°¢6öç6öÆRæÆör†ÆâÔ2•"'G2FööÂ'Vææ–æröâ‡GG¢òöÆö6Æ†÷7C¢Gµõ%GÖ“°¢6öç6öÆRæÆör†vÖ–Â6öææV7FVC¢G²vWE6WGF–ær‚vvÖ–Åö66W75÷Fö¶Vâr—Ö“°¢6öç6öÆRæÆör†'G2–âD#¢G¶F"ç&W&R‚u4TÄT5B4õTåB‚¢’22e$ôÒ'G2r’ævWB‚’æ7Ö“°¢6öç6öÆRæÆör†ÖçVÇ2–âD#¢G¶F"ç&W&R‚u4TÄT5B4õTåB‚¢’22e$ôÒÖçVÇ2r’ævWB‚’æ7ÕÆæ“°§Ò“°