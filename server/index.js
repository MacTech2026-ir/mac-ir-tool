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
  const superRe = /part\s*#?\s*(\d{7,0})\s+(?:has\s+)?super\w+\sÝto\s+part\s*#?\s*(\d{7,10})/gi;
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
  if (/RS\s*9|RS\s*11|RS\s*7/.test(t)) return 'RS-Series';
  if (/T.?30/.test(t)) return 'T30';
  if (/UP6S?/.test(t)) return 'UP6/UP6S ';
  if (/SSR/.test(t)) return 'SSR';
  if (/R\s?SERIESROTARY SCEUÕ-Žtest(t)) return 'R-Series';
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

  const redirectUri = process.env.GMAIL_REDIRECT_URI !||
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
      client_secret: process.env.GMAIL_CGWFƒ"ævöövÆV—2æ6öÒ÷Fö¶VârÂ°¢6öFRÀ¢6Æ–VçEö–C¢&ö6W72æVçbätÔ”Åô4Ä”TåEô”BÀ¢6Æ–VçE÷6V7&WC¢&ö6W72æVçbätÔ”Åô4Ä”TåEõ4T5$UBÀ¢&VF—&V7E÷W&“¢&VF—&V7EW&’À¢w&çE÷G—S¢vWF†÷&—¦F–öåö6öFRrÀ¢Ò“° ¢6öç7B²66W75÷Fö¶VâÂ&Vg&W6…÷Fö¶VâÂW‡—&W5ö–âÒÒFö¶Vå&W2æFF°¢6WE6WGF–ær‚vvÖ–Åö66W75÷Fö¶VârÂ66W75÷Fö¶Vâ“°¢6WE6WGF–ær‚vvÖ–Å÷&Vg&W6…÷Fö¶VârÂ&Vg&W6…÷Fö¶Vâ“°¢6WE6WGF–ær‚vvÖ–Å÷Fö¶VåöW‡—'’rÂ7G&–ær„FFRææ÷r‚’²†W‡—&W5ö–â¢’’“° ¢&W2ç&VF—&V7B‚róöWFƒ×7V66W72r“°¢Ò6F6‚†R’°¢6öç6öÆRæW'&÷"‚tôWF‚W'&÷#¢rÂRç&W7öç6SòæFFÇÂRæÖW76vR“°¢&W2ç&VF—&V7B‚róöWFƒÖW'&÷"r“°¢Ð§Ò“° ¦7–æ2gVæ7F–öâvWEfÆ–EFö¶Vâ‚’°¢ÆWBFö¶VâÒvWE6WGF–ær‚vvÖ–Åö66W75÷Fö¶Vâr“°¢6öç7BW‡—'’Ò'6T–çB†vWE6WGF–ær‚vvÖ–Å÷Fö¶VåöW‡—'’r’ÇÂsr“°¢6öç7B&Vg&W6‚ÒvWE6WGF–ær‚vvÖ–Å÷&Vg&W6…÷Fö¶Vâr“° ¢–b‚Fö¶Vâ’F‡&÷ræWrW'&÷"‚tæ÷BWF†VçF–6FVBÒÒ6öææV7BvÖ–Âf—'7Br“°¢–b„FFRææ÷r‚’âW‡—'’Òcbb&Vg&W6‚’°¢6öç7B&W2Òv—B†–÷2ç÷7B‚v‡GG3¢òööWFƒ"ævöövÆV—2æ6öÒ÷Fö¶VârÂ°¢6Æ–VçEö–C¢&ö6W72æVçbätÔ”Åô4Ä”TåEô”BÀ¢6Æ–VçE÷6V7&WC¢&ö6W72æVçbätÔ”Åô4Ä”TåEõ4T5$UBÀ¢&Vg&W6…÷Fö¶Vã¢&Vg&W6‚À¢w&çE÷G—S¢w&Vg&W6…÷Fö¶VârÀ¢Ò“°¢Fö¶VâÒ&W2æFFæ66W75÷Fö¶Vã°¢6WE6WGF–ær‚vvÖ–Åö66W75÷Fö¶VârÂFö¶Vâ“°¢6WE6WGF–ær‚vvÖ–Å÷Fö¶VåöW‡—'’rÂ7G&–ær„FFRææ÷r‚’²‡&W2æFFæW‡—&W5ö–â¢’’“°¢Ð¢&WGW&âFö¶Vã°§Ð ¢òòÒÒtÔ”Â5”ä2ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦ÆWB7–æ4–å&öw&W72ÒfÇ6S°¦ÆWB7–æ4ÆörÒµÓ°¦ÆWB7–æ5&öw&W72Ò²7C¢Â7V#¢rrÂ66ææVC¢Â'G3¢ÂÖçVÇ3¢Ó° ¦ævWB‚rö’÷7–æ2÷7FGW2rÂ‡&WÂ&W2’Óâ°¢6öç7BÆ7BÒF"ç&W&R‚u4TÄT5B¢e$ôÒ7–æ5öÆörõ$DU"%’–BDU42Ä”Ô•Br’ævWB‚“°¢&W2æ§6öâ‡°¢–å&öw&W73¢7–æ4–å&öw&W72À¢&öw&W73¢7–æ5&öw&W72À¢&V6VçDÆös¢7–æ4Æörç6Æ–6R‚Ó#’À¢Æ7E7–æ3¢Æ7BÇÂçVÆÂÀ¢vÖ–Ä6öææV7FVC¢vWE6WGF–ær‚vvÖ–Åö66W75÷Fö¶Vâr’À¢Ò“°§Ò“° ¦ç÷7B‚rö’÷7–æ2÷7F'BrÂ7–æ2‡&WÂ&W2’Óâ°¢–b‡7–æ4–å&öw&W72’&WGW&â&W2æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢u7–æ2Ç&VG’'Vææ–ærrÒ“°¢&W2æ§6öâ‡²ö³¢G'VRÂÖW76vS¢u7–æ27F'FVBrÒ“°¢'VävÖ–Å7–æ2‚’æ6F6‚†6öç6öÆRæW'&÷"“°§Ò“° ¦7–æ2gVæ7F–öâ'VävÖ–Å7–æ2‚’°¢7–æ4–å&öw&W72ÒG'VS°¢7–æ4ÆörÒµÓ°¢7–æ5&öw&W72Ò²7C¢Â7V#¢u7F'F–ærââârÂ66ææVC¢Â'G3¢ÂÖçVÇ3¢Ó°¢6öç7BÆöt–BÒF"ç&W&R‚t”å4U%B”åDò7–æ5öÆör‡7F'FVEöBÂ7FGW2’dÅTU2†FFWF–ÖR‚&æ÷r"’Â''Vææ–ær"’r’ç'Vâ‚’æÆ7D–ç6W'E&÷v–C° ¢6öç7BÆörÒ†×6rÂG—RÒv–æfòr’Óâ°¢7–æ4ÆörçW6‚‡²×6rÂG—RÂG3¢æWrFFR‚’çFô•4õ7G&–ær‚’Ò“°¢6öç6öÆRæÆör†µ5”ä5ÒG¶×6wÖ“°¢Ó° ¢G'’°¢6öç7BFö¶VâÒv—BvWEfÆ–EFö¶Vâ‚“°¢Æör‚tvÖ–Â6öææV7FVB´ôµÒrÂvö²r“° ¢òòf–æB•"Æ&VÀ¢7–æ5&öw&W72ç7V"Òtf–æF–ær–ævW'6öÆÂ&æBÆ&VÂâââs°¢6öç7BÆ&VÇ5&W2Òv—B†–÷2ævWB‚v‡GG3¢ò÷wwrævöövÆV—2æ6öÒövÖ–Â÷c÷W6W'2öÖRöÆ&VÇ2rÀ¢²†VFW'3¢²WF†÷&—¦F–öã¢&V&W"G·Fö¶VçÖÒÒ“° ¢6öç7B—$Æ&VÂÒÆ&VÇ5&W2æFFæÆ&VÇ2æf–æB†ÂÓà¢ÂææÖRÓÓÒufVæF÷'2ô–ævW'6öÆÂ&æBrÇÀ¢ÂææÖRçFôÆ÷vW$66R‚’æ–æ6ÇVFW2‚v–ævW'6öÆÂ&æBr¢“° ¢ÆWBVW'“°¢–b†—$Æ&VÂ’°¢Æör†f÷VæBÆ&VÃ¢"G¶—$Æ&VÂææÖWÒ"´ôµÖÂvö²r“°¢VW'’ÒÆ&VÃ¢G¶—$Æ&VÂæ–GÖ°¢ÒVÇ6R°¢Æör‚tÆ&VÂæ÷Bf÷VæBÒÒW6–ær¶W—v÷&B6V&6‚rÂwv&âr“°¢VW'’Òvg&öÓ¦–ævW'6öÆÇ&æBõ"7V&¦V7C¢„5E2’õ"7V&¦V7C¢†–ævW'6öÆÂ&æB’õ"7V&¦V7C¢„•"V÷FR’s°¢Ð ¢òòvWBÖW76vRÆ—7@¢7–æ5&öw&W72ç7V"ÒtÆöF–ærVÖ–ÂÆ—7Bâââs°¢ÆWBÖW76vW2ÒµÓ°¢ÆWBvUFö¶VâÒçVÆÃ°¢Fò°¢6öç7BW&ÂÒ‡GG3¢ò÷wwrævöövÆV—2æ6öÒövÖ–Â÷c÷W6W'2öÖRöÖW76vW3÷ÒG¶Væ6öFUU$”6ö×öæVçB‡VW'’—ÒfÖ…&W7VÇG3ÓG·vUFö¶VâòrgvUFö¶VãÒr²vUFö¶Vâ¢rwÖ°¢6öç7B&W2Òv—B†–÷2ævWB‡W&ÂÂ²†VFW'3¢²WF†÷&—¦F–öã¢&V&W"G·Fö¶VçÖÒÒ“°¢–b‡&W2æFFæÖW76vW2’ÖW76vW2ÒÖW76vW2æ6öæ6B‡&W2æFFæÖW76vW2“°¢vUFö¶VâÒ&W2æFFææW‡EvUFö¶Vã°¢Òv†–ÆR‡vUFö¶VâbbÖW76vW2æÆVæwF‚Â3“° ¢Æör†f÷VæBG¶ÖW76vW2æÆVæwF‡ÒVÖ–Ç2Fò66æÂvö²r“° ¢6öç7B–ç6W'E'BÒF"ç&W&R† ¢”å4U%Bõ"$UÄ4R”åDò'G2†–BÂ'EöçVÒÂæÖRÂ6FVv÷'’Â6W&–W2ÂÆ—7E÷&–6RÂ–÷W%ö6÷7BÂV÷FUöçVÒÂFFRÂ‡&VbÂæ÷FW2Â6÷W&6UöVÖ–Åö–BÂWFFVEöB¢dÅTU2„–BÂ'EöçVÒÂæÖRÂ6FVv÷'’Â6FVv÷'’Â6W&–W2ÂÆ—7E÷&–6RÂ–÷W%ö6÷7BÂwV÷FUöçVÒÂFFRÂ‡&VbÂæ÷FW2Â6÷W&6UöVÖ–Åö–BÂFFWF–ÖR‚væ÷rr’¢“°¢6öç7B–ç6W'DÖçVÂÒF"ç&W&R† ¢”å4U%Bõ"”täõ$R”åDòÖçVÇ2†–BÂF—FÆRÂÖöFVÇ2Âf–ÆVæÖRÂf–ÆWF‚Âf–ÆU÷6—¦RÂvW2Â6÷W&6UöVÖ–Åö–BÂ6÷W&6U÷7V&¦V7BÂFFR¢dÅTU2„–BÂF—FÆRÂÖöFVÇ2Âf–ÆVæÖRÂf–ÆWF‚Âf–ÆU÷6—¦RÂvW2Â6÷W&6UöVÖ–Åö–BÂ6÷W&6U÷7V&¦V7BÂFFR¢“° ¢f÷"†ÆWB’Ò²’ÂÖW76vW2æÆVæwFƒ²’²²’°¢7–æ5&öw&W72ç7BÒÖF‚ç&÷VæBƒ²†’òÖW76vW2æÆVæwF‚’¢ƒ“°¢7–æ5&öw&W72ç66ææVBÒ’²° ¢G'’°¢6öç7B×6u&W2Òv—B†–÷2ævWB€¢‡GG3¢ò÷wwrævöövÆV—2æ6öÒövÖ–Â÷c÷W6W'2öÖRöÖW76vW2òG¶ÖW76vW5¶•Òæ–GÓöf÷&ÖCÖgVÆÆÀ¢²†VFW'3¢²WF†÷&—¦F–öã¢&V&W"G·Fö¶VçÖÒÐ¢“°¢6öç7B×6rÒ×6u&W2æFF°¢6öç7B†VFW'2Ò×6rç–ÆöBæ†VFW'2ÇÂµÓ°¢6öç7BvWD‚ÒâÓâ††VFW'2æf–æB†‚Óâ‚ææÖRçFôÆ÷vW$66R‚’ÓÓÒâçFôÆ÷vW$66R‚’’ÇÂ·Ò’çfÇVRÇÂrs°¢6öç7B7V&¦V7BÒvWD‚‚u7V&¦V7Br“°¢6öç7BFFRÒvWD‚‚tFFRr“°¢6öç7B'6VDFFRÒ‚‚’Óâ²G'’²&WGW&âæWrFFR†FFR’çFô•4õ7G&–ær‚’ç7Æ—B‚uBr•³Ó²Ò6F6‚†R’²&WGW&ârs²ÒÒ’‚“° ¢òòW‡G&7B&öG’FW‡@¢ÆWB&öG•FW‡BÒrs°¢6öç7BvÆµ'G2Ò'BÓâ°¢–b‚'B’&WGW&ã°¢–b‡'BæÖ–ÖUG—RÓÓÒwFW‡B÷Æ–ârbb'Bæ&öG“òæFF’°¢&öG•FW‡B³Ò'VffW"æg&öÒ‡'Bæ&öG’æFFÂv&6ScBr’çFõ7G&–ær‚wWFc‚r“°¢ÒVÇ6R–b‡'BæÖ–ÖUG—RÓÓÒwFW‡Bö‡FÖÂrbb'Bæ&öG“òæFFbb&öG•FW‡B’°¢6öç7B‡FÖÂÒ'VffW"æg&öÒ‡'Bæ&öG’æFFÂv&6ScBr’çFõ7G&–ær‚wWFc‚r“°¢&öG•FW‡B³Ò‡FÖÂç&WÆ6R‚óÅµãåÒ³âörÂrr’ç&WÆ6R‚õÇ2²örÂrr“°¢Ð¢–b‡'Bç'G2’'Bç'G2æf÷$V6‚‡vÆµ'G2“°¢Ó°¢vÆµ'G2†×6rç–ÆöB“° ¢6öç7BgVÆÅFW‡BÒ7V&¦V7B²rr²&öG•FW‡C°¢6öç7B—4ÖçVÂÒöÖçVÇÇ6W'f–6RwV–FWÄ”ô×Æ–ç7FÆÆF–öââ¦÷W&F–öçÆ÷W&F–öââ¦ÖçVÂö’çFW7B†gVÆÅFW‡B“°¢6öç7B—5V÷FRÒô5E2ÕÆB·ÇV÷FWÇ&÷÷6ÇÇ'EÇ2¦çVÖ&W'Ç'EÇ2¢7ÅÆG³‚ÃÒö’çFW7B†gVÆÅFW‡B“°¢6öç7B7G4ÖF6‚ÒgVÆÅFW‡BæÖF6‚‚ô5E2Ò…ÆB²’ö’“°¢6öç7BV÷FTçVÒÒ7G4ÖF6‚òt5E2Òr²7G4ÖF6…³Ò¢çVÆÃ° ¢òò&ö6W72GF6†ÖVçG0¢6öç7BvÆ´GF6†ÖVçG2Ò7–æ2‡'B’Óâ°¢–b‚'B’&WGW&ã°¢–b‡'Bæf–ÆVæÖRbb'Bæf–ÆVæÖRçFôÆ÷vW$66R‚’æVæG5v—F‚‚rçFbr’bb'Bæ&öG“òæGF6†ÖVçD–B’°¢G'’°¢6öç7BGE&W2Òv—B†–÷2ævWB€¢‡GG3¢ò÷wwrævöövÆV—2æ6öÒövÖ–Â÷c÷W6W'2öÖRöÖW76vW2òG¶ÖW76vW5¶•Òæ–GÒöGF6†ÖVçG2òG·'Bæ&öG’æGF6†ÖVçD–GÖÀ¢²†VFW'3¢²WF†÷&—¦F–öã¢&V&W"G·Fö¶VçÖÒÐ¢“°¢6öç7BFd'VffW"Ò'VffW"æg&öÒ†GE&W2æFFæFFÂv&6ScBr“°¢6öç7B6fTæÖRÒ'Bæf–ÆVæÖRç&WÆ6R‚õµæ×¤Õ£Ó’åÂÕõÒörÂuòr“°¢6öç7Bf–ÆVæÖRÒG´FFRææ÷r‚—ÕòG·6fTæÖWÖ°¢6öç7Bf–ÆWF‚ÒF‚æ¦ö–â…UÄôE5ôD•"Âf–ÆVæÖR“°¢g2çw&—FTf–ÆU7–æ2†f–ÆWF‚ÂFd'VffW"“° ¢òò'6RDbf÷"FW‡@¢ÆWBFeFW‡BÒrs°¢ÆWBvW2Ò°¢G'’°¢6öç7B'6VBÒv—BFe'6R‡Fd'VffW"“°¢FeFW‡BÒ'6VBçFW‡C°¢vW2Ò'6VBæçV×vW3°¢Ò6F6‚†R’·Ð ¢6öç7BÆÅFW‡BÒFeFW‡B²rr²gVÆÅFW‡C° ¢–b†—4ÖçVÂÇÂöÖçVÇÄ”ô×Ç6W'f–6RwV–FRö’çFW7B‡'Bæf–ÆVæÖR’’°¢6öç7BÖöFVÇ2ÒW‡G&7DÖöFVÇ4g&öÕFW‡B†ÆÅFW‡B“°¢6öç7BÖçVÄ–BÒÖçVÅòG¶ÖW76vW5¶•Òæ–GÕòG·'Bæ&öG’æGF6†ÖVçD–GÖ°¢–ç6W'DÖçVÂç'Vâ‡°¢–C¢ÖçVÄ–BÀ¢F—FÆS¢'Bæf–ÆVæÖRç&WÆ6R‚õòörÂrr’ç&WÆ6R‚õÂåÇr²BòÂrr’À¢ÖöFVÇ3¢¥4ôâç7G&–æv–g’†ÖöFVÇ2’À¢f–ÆVæÖRÀ¢f–ÆWFƒ¢÷WÆöG2òG¶f–ÆVæÖWÖÀ¢f–ÆU÷6—¦S¢Fd'VffW"æÆVæwF‚À¢vW2À¢6÷W&6UöVÖ–Åö–C¢ÖW76vW5¶•Òæ–BÀ¢6÷W&6U÷7V&¦V7C¢7V&¦V7BÀ¢FFS¢'6VDFFRÀ¢Ò“°¢7–æ5&öw&W72æÖçVÇ2²³°¢Æör†ÖçVÂ6fVC¢G·'Bæf–ÆVæÖWÖÂvö²r“°¢Ð ¢òòW‡G&7B'G2g&öÒDbFW‡@¢–b†—5V÷FRbbFeFW‡B’°¢6öç7BFe'G2ÒW‡G&7E'G4g&öÕFW‡B‡FeFW‡BÂV÷FTçVÒÂ'6VDFFR“°¢6öç7B–ç6W'DÖç’ÒF"çG&ç67F–öâ‚‚’Óâ°¢f÷"†6öç7BöbFe'G2’°¢–ç6W'E'Bç'Vâ‡²ââçÂ6÷W&6UöVÖ–Åö–C¢ÖW76vW5¶•Òæ–BÒ“°¢7–æ5&öw&W72ç'G2²³°¢Ð¢Ò“°¢–ç6W'DÖç’‚“°¢–b‡Fe'G2æÆVæwF‚â’Æör†´ôµÒG·V÷FTçVÒÇÂ'Bæf–ÆVæÖWÓ¢G·Fe'G2æÆVæwF‡Ò'G2g&öÒDfÂvö²r“°¢Ð¢Ò6F6‚†R’°¢Æör†µt$åÒ6÷VÆBæ÷BF÷væÆöBGF6†ÖVçBG·'Bæf–ÆVæÖWÓ¢G¶RæÖW76vWÖÂwv&âr“°¢Ð¢Ð¢–b‡'Bç'G2’f÷"†6öç7Böb'Bç'G2’v—BvÆ´GF6†ÖVçG2‡“°¢Ó°¢v—BvÆ´GF6†ÖVçG2†×6rç–ÆöB“° ¢òòÇ6òW‡G&7Bg&öÒVÖ–Â&öG¢–b†—5V÷FR’°¢6öç7B&öG•'G2ÒW‡G&7E'G4g&öÕFW‡B†&öG•FW‡BÂV÷FTçVÒÂ'6VDFFR“°¢6öç7B–ç6W'D&öG•'G2ÒF"çG&ç67F–öâ‚‚’Óâ°¢f÷"†6öç7Böb&öG•'G2’°¢–ç6W'E'Bç'Vâ‡²ââçÂ6÷W&6UöVÖ–Åö–C¢ÖW76vW5¶•Òæ–BÒ“°¢7–æ5&öw&W72ç'G2²³°¢Ð¢Ò“°¢–ç6W'D&öG•'G2‚“°¢Ð ¢Ò6F6‚†R’°¢Æör†µt$åÒW'&÷"öâVÖ–ÂG¶’²Ó¢G¶RæÖW76vWÖÂwv&âr“°¢Ð ¢òò&FRÆ–Ö—B6fWG¢–b†’RRÓÓÒ’v—BæWr&öÖ—6R‡"Óâ6WEF–ÖV÷WB‡"Â#’“°¢Ð ¢7–æ5&öw&W72ç7BÒ°¢7–æ5&öw&W72ç7V"Òu7–æ26ö×ÆWFRs°¢Æör†´ôµÒFöæRÒÒG·7–æ5&öw&W72ç'G7Ò'G2ÂG·7–æ5&öw&W72æÖçVÇ7ÒÖçVÇ2g&öÒG¶ÖW76vW2æÆVæwF‡ÒVÖ–Ç6Âvö²r“° ¢F"ç&W&R‚uUDDR7–æ5öÆör4UB6ö×ÆWFVEöCÖFFWF–ÖR‚&æ÷r"’ÂVÖ–Ç5÷66ææVCÓòÂ'G5öf÷VæCÓòÂÖçVÇ5öf÷VæCÓòÂ7FGW3Ò&6ö×ÆWFR"ÂÆösÓòt„U$R–CÓòr¢ç'Vâ†ÖW76vW2æÆVæwF‚Â7–æ5&öw&W72ç'G2Â7–æ5&öw&W72æÖçVÇ2Â¥4ôâç7G&–æv–g’‡7–æ4Æör’ÂÆöt–B“° ¢Ò6F6‚†R’°¢Æör†´U%%Ò7–æ2f–ÆVC¢G¶RæÖW76vWÖÂvW'"r“°¢F"ç&W&R‚uUDDR7–æ5öÆör4UB6ö×ÆWFVEöCÖFFWF–ÖR‚&æ÷r"’Â7FGW3Ò&W'&÷""ÂÆösÓòt„U$R–CÓòr¢ç'Vâ„¥4ôâç7G&–æv–g’‡7–æ4Æör’ÂÆöt–B“°¢Òf–æÆÇ’°¢7–æ4–å&öw&W72ÒfÇ6S°¢Ð§Ð ¢òòÒÒ’$õUDU2ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ ¢òò7FG0¦ævWB‚rö’÷7FG2rÂ‡&WÂ&W2’Óâ°¢6öç7B'G2ÒF"ç&W&R‚u4TÄT5B4õTåB‚¢’22e$ôÒ'G2r’ævWB‚’æ3°¢6öç7BÖçVÇ2ÒF"ç&W&R‚u4TÄT5B4õTåB‚¢’22e$ôÒÖçVÇ2r’ævWB‚’æ3°¢6öç7Bv—F…&–6–ærÒF"ç&W&R‚u4TÄT5B4õTåB‚¢’22e$ôÒ'G2t„U$RÆ—7E÷&–6R•2äõBåTÄÂäB–÷W%ö6÷7B•2äõBåTÄÂr’ævWB‚’æ3°¢6öç7BV÷FW2ÒF"ç&W&R‚%4TÄT5B4õTåB„D•5D”ä5BV÷FUöçVÒ’22e$ôÒ'G2t„U$RV÷FUöçVÒ•2äõBåTÄÂ"’ævWB‚’æ3°¢6öç7BÆ7E7–æ2ÒF"ç&W&R‚u4TÄT5B¢e$ôÒ7–æ5öÆörõ$DU"%’–BDU42Ä”Ô•Br’ævWB‚“°¢&W2æ§6öâ‡²'G2ÂÖçVÇ2Âv—F…&–6–ærÂV÷FW2ÂÆ7E7–æ2ÂvÖ–Ä6öææV7FVC¢vWE6WGF–ær‚vvÖ–Åö66W75÷Fö¶Vâr’Ò“°§Ò“° ¢òò'G0¦ævWB‚rö’÷'G2rÂ‡&WÂ&W2’Óâ°¢6öç7B²Â6FVv÷'’Â6W&–W2ÂV÷FRÂ6÷'BÒw'EöçVÒrÂÆ–Ö—BÒ#Âöfg6WBÒÒÒ&WçVW'“°¢ÆWB7ÂÒu4TÄT5B¢e$ôÒ'G2t„U$RÓs°¢6öç7B&×2ÒµÓ°¢–b‡’²7Â³ÒräB‡'EöçVÒÄ”´Ròõ"æÖRÄ”´Ròõ"æ÷FW2Ä”´Ròõ"‡&VbÄ”´Rò’s²6öç7BÆ–¶RÒRG·ÒV²&×2çW6‚†Æ–¶RÆÆ–¶RÆÆ–¶RÆÆ–¶R“²Ð¢–b†6FVv÷'’’²7Â³ÒräB2u4TÄT5B4õTåB‚¢’22e$ôÒ'G2t„U$RÆ—7E÷&–6R•2äõBåTÄÂäB–÷W%ö6÷7B•2äõBåTÄÂr’ævWB‚’æ3°¢6öç7BV÷FW2ÒF"ç&W&R‚%4TÄT5B4õTåB„D•5D”ä5BV÷FUöçVÒ’22e$ôÒ'G2t„U$RV÷FUöçVÒ•2äõBåTÄÂ"’ævWB‚’æ3°¢6öç7BÆ7E7–æ2ÒF"ç&W&R‚u4TÄT5B¢e$ôÒ7–æ5öÆörõ$DU"%’–BDU42Ä”Ô•Br’ævWB‚“°¢&W2æ§6öâ‡²'G2ÂÖçVÇ2Âv—F…&–6–ærÂV÷FW2ÂÆ7E7–æ2ÂvÖ–Ä6öææV7FVC¢vWE6WGF–ær‚vvÖ–Åö66W75÷Fö¶Vâr’Ò“°§Ò“° ¢òò'G0¦ævWB‚rö’÷'G2rÂ‡&WÂ&W2’Óâ°¢6öç7B²Â6FVv÷'’Â6W&–W2ÂV÷FRÂ6÷'BÒw'EöçVÒrÂÆ–Ö—BÒ#Âöfg6WBÒÒÒ&WçVW'“°¢ÆWB7ÂÒu4TÄT5B¢e$ôÒ'G2t„U$RÓs°¢6öç7B&×2ÒµÓ°¢–b‡’²7Â³ÒräB‡'EöçVÒÄ”´Ròõ"æÖRÄ”´Ròõ"æ÷FW2Ä”´Ròõ"‡&VbÄ”´Rò’s²6öç7BÆ–¶RÒRG·ÒV²&×2çW6‚†Æ–¶RÆÆ–¶RÆÆ–¶RÆÆ–¶R“²Ð¢–b†6FVv÷'’’²7Â³ÒräB6FVv÷'’Òòs²&×2çW6‚†6FVv÷'’“²Ð¢–b‡6W&–W2’²7Â³ÒräB6W&–W2Òòs²&×2çW6‚‡6W&–W2“²Ð¢–b‡V÷FR’²7Â³ÒräBV÷FUöçVÒÒòs²&×2çW6‚‡V÷FR“²Ð¢6öç7BÆÆ÷vVBÒ²w'EöçVÒrÂv6FVv÷'’rÂw6W&–W2rÂvÆ—7E÷&–6RrÂw–÷W%ö6÷7BrÂvFFRrÂvæÖRuÓ°¢7Â³Òõ$DU"%’G¶ÆÆ÷vVBæ–æ6ÇVFW2‡6÷'B’ò6÷'B¢w'EöçVÒwÒÄ”Ô•Bòôde4UBö°¢&×2çW6‚‡'6T–çB†Æ–Ö—B’Â'6T–çB†öfg6WB’“°¢6öç7B&÷w2ÒF"ç&W&R‡7Â’æÆÂ‚ââç&×2“°¢&W2æ§6öâ‡&÷w2æÖ‡"Óâ‡²ââç"Â‡&Vc¢¥4ôâç'6R‡"ç‡&VbÇÂuµÒr’Ò’’“°§Ò“° ¦ævWB‚rö’÷'G2ó¦–BrÂ‡&WÂ&W2’Óâ°¢6öç7B&÷rÒF"ç&W&R‚u4TÄT5B¢e$ôÒ'G2t„U$R–BÒòr’ævWB‡&Wç&×2æ–B“°¢–b‚&÷r’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²W'&÷#¢tæ÷Bf÷VæBrÒ“°¢&W2æ§6öâ‡²ââç&÷rÂ‡&Vc¢¥4ôâç'6R‡&÷rç‡&VbÇÂuµÒr’Ò“°§Ò“° ¦ç÷7B‚rö’÷'G2rÂ‡&WÂ&W2’Óâ°¢6öç7B²'EöçVÒÂæÖRÂ6FVv÷'’Â6W&–W2ÂÆ—7E÷&–6RÂ–÷W%ö6÷7BÂV÷FUöçVÒÂæ÷FW2Â‡&VbÒÒ&Wæ&öG“°¢–b‚'EöçVÒ’&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²W'&÷#¢w'EöçVÒ&WV—&VBrÒ“°¢6öç7B–BÒÖçVÅòG·'EöçV×ÕòG´FFRææ÷r‚—Ö°¢F"ç&W&R†”å4U%Bõ"$UÄ4R”åDò'G2†–BÂ'EöçVÒÂæÖRÂ6FVv÷'’Â6W&–W2ÂÆ—7E÷&–6RÂ–÷W%ö6÷7BÂV÷FUöçVÒÂæ÷FW2Â‡&VbÂ7WÆ–W"ÂWFFVEöB¢dÅTU2ƒòÂòÂòÂòÂòÂòÂòÂòÂòÂòÂt–ævW'6öÆÂ&æBrÂFFWF–ÖR‚væ÷rr’–¢ç'Vâ†–BÂ'EöçVÒÂæÖRÇÂrrÂ6FVv÷'’ÇÂrrÂ6W&–W2ÇÂrrÂÆ—7E÷&–6RÇÂçVÆÂÂ–÷W%ö6÷7BÇÂçVÆÂÂV÷FUöçVÒÇÂçVÆÂÂæ÷FW2ÇÂrrÂ¥4ôâç7G&–æv–g’‡‡&VbÇÂµÒ’“°¢&W2æ§6öâ‡²ö³¢G'VRÂ–BÒ“°§Ò“° ¦çWB‚rö’÷'G2ó¦–BrÂ‡&WÂ&W2’Óâ°¢6öç7B²æÖRÂ6FVv÷'’Â6W&–W2ÂÆ—7E÷&–6RÂ–÷W%ö6÷7BÂæ÷FW2Â‡&VbÒÒ&Wæ&öG“°¢F"ç&W&R‚uUDDR'G24UBæÖSÓòÂ6FVv÷'“ÓòÂ6W&–W3ÓòÂÆ—7E÷&–6SÓòÂ–÷W%ö6÷7CÓòÂæ÷FW3ÓòÂ‡&VcÓòÂWFFVEöCÖFFWF–ÖR‚&æ÷r"’t„U$R–CÓòr¢ç'Vâ†æÖRÂ6FVv÷'’Â6W&–W2ÂÆ—7E÷&–6RÂ–÷W%ö6÷7BÂæ÷FW2Â¥4ôâç7G&–æv–g’‡‡&VbÇÂµÒ’Â&Wç&×2æ–B“°¢&W2æ§6öâ‡²ö³¢G'VRÒ“°§Ò“° ¦æFVÆWFR‚rö’÷'G2ó¦–BrÂ‡&WÂ&W2’Óâ°¢F"ç&W&R‚tDTÄUDRe$ôÒ'G2t„U$R–BÒòr’ç'Vâ‡&Wç&×2æ–B“°¢&W2æ§6öâ‡²ö³¢G'VRÒ“°§Ò“° ¢òòf–ÇFW"÷F–öç0¦ævWB‚rö’÷'G2öÖWFöf–ÇFW'2rÂ‡&WÂ&W2’Óâ°¢6öç7B6FVv÷&–W2ÒF"ç&W&R‚u4TÄT5BD•5D”ä5B6FVv÷'’e$ôÒ'G2t„U$R6FVv÷'’Ò""õ$DU"%’6FVv÷'’r’æÆÂ‚’æÖ‡"Óâ"æ6FVv÷'’“°¢6öç7B6W&–W2ÒF"ç&W&R‚u4TÄT5BD•5D”ä5B6W&–W2e$ôÒ'G2t„U$R6W&–W2Ò""õ$DU"%’6W&–W2r’æÆÂ‚’æÖ‡"Óâ"ç6W&–W2“°¢6öç7BV÷FW2ÒF"ç&W&R‚u4TÄT5BD•5D”ä5BV÷FUöçVÒe$ôÒ'G2t„U$RV÷FUöçVÒ•2äõBåTÄÂõ$DU"%’V÷FUöçVÒDU42Ä”Ô•B3r’æÆÂ‚’æÖ‡"Óâ"çV÷FUöçVÒ“°¢&W2æ§6öâ‡²6FVv÷&–W2Â6W&–W2ÂV÷FW2Ò“°§Ò“° ¢òòÖçVÇ0¦ævWB‚rö’öÖçVÇ2rÂ‡&WÂ&W2’Óâ°¢6öç7B²ÒÒ&WçVW'“°¢ÆWB7ÂÒu4TÄT5B¢e$ôÒÖçVÇ2t„U$RÓs°¢6öç7B&×2ÒµÓ°¢–b‡’²7Â³ÒräB‡F—FÆRÄ”´Ròõ"ÖöFVÇ2Ä”´Ròõ"6÷W&6U÷7V&¦V7BÄ”´Rò’s²6öç7BÆ–¶RÒRG·ÒV²&×2çW6‚†Æ–¶RÆÆ–¶RÆÆ–¶R“²Ð¢7Â³Òrõ$DU"%’FFRDU42Â7&VFVEöBDU42s°¢6öç7B&÷w2ÒF"ç&W&R‡7Â’æÆÂ‚ââç&×2“°¢&W2æ§6öâ‡&÷w2æÖ‡"Óâ‡²ââç"ÂÖöFVÇ3¢¥4ôâç'6R‡"æÖöFVÇ2ÇÂuµÒr’Ò’’“°§Ò“° ¦æFVÆWFR‚rö’öÖçVÇ2ó¦–BrÂ‡&WÂ&W2’Óâ°¢6öç7BÖçVÂÒF"ç&W&R‚u4TÄT5B¢e$ôÒÖçVÇ2t„U$R–BÒòr’ævWB‡&Wç&×2æ–B“°¢–b†ÖçVÂbbÖçVÂæf–ÆVæÖR’°¢6öç7BgÒF‚æ¦ö–â…UÄôE5ôD•"ÂÖçVÂæf–ÆVæÖR“°¢–b†g2æW†—7G57–æ2†g’’g2çVæÆ–æµ7–æ2†g“°¢Ð¢F"ç&W&R‚tDTÄUDRe$ôÒÖçVÇ2t„U$R–BÒòr’ç'Vâ‡&Wç&×2æ–B“°¢&W2æ§6öâ‡²ö³¢G'VRÒ“°§Ò“° ¢òòÖçVÂWÆöBVæGö–ç@¦ç÷7B‚rö’öÖçVÇ2÷WÆöBrÂWÆöBæ'&’‚wFg2rÂ#’Â7–æ2‡&WÂ&W2’Óâ°¢6öç7B&W7VÇG2ÒµÓ°¢f÷"†6öç7Bf–ÆRöb&Wæf–ÆW2ÇÂµÒ’°¢G'’°¢6öç7BFd'VffW"Òg2ç&VDf–ÆU7–æ2†f–ÆRçF‚“°¢ÆWBFeFW‡BÒrrÂvW2Ò°¢G'’²6öç7BÒv—BFe'6R‡Fd'VffW"“²FeFW‡BÒçFW‡C²vW2ÒæçV×vW3²Ò6F6‚†R’·Ð¢6öç7BÖöFVÇ2ÒW‡G&7DÖöFVÇ4g&öÕFW‡B‡FeFW‡B²rr²f–ÆRæ÷&–v–æÆæÖR“°¢6öç7BF—FÆRÒ‡&Wæ&öG’çF—FÆRÇÂf–ÆRæ÷&–v–æÆæÖR’ç&WÆ6R‚õÂåÇr²BòÂrr’ç&WÆ6R‚õòörÂrr“°¢6öç7B–BÒWÆöEòG´FFRææ÷r‚—ÕòG´ÖF‚ç&æFöÒ‚’çFõ7G&–ærƒ3b’ç6Æ–6Rƒ"—Ö°¢F"ç&W&R‚t”å4U%B”åDòÖçVÇ2†–BÂF—FÆRÂÖöFVÇ2Âf–ÆVæÖRÂf–ÆWF‚Âf–ÆU÷6—¦RÂvW2Â6÷W&6U÷7V&¦V7BÂFFRÂWÆöFVEö'’’dÅTU2ƒòÃòÃòÃòÃòÃòÃòÃòÆFFWF–ÖR‚&æ÷r"’Â&ÖçVÂ"’r¢ç'Vâ†–BÂF—FÆRÂ¥4ôâç7G&–æv–g’†ÖöFVÇ2’Âf–ÆRæf–ÆVæÖRÂ÷WÆöG2òG¶f–ÆRæf–ÆVæÖWÖÂf–ÆRç6—¦RÂvW2Âf–ÆRæ÷&–v–æÆæÖR“° ¢òòW‡G&7B'G2g&öÒWÆöFVBD`¢6öç7B'G2ÒW‡G&7E'G4g&öÕFW‡B‡FeFW‡BÂçVÆÂÂæWrFFR‚’çFô•4õ7G&–ær‚’ç7Æ—B‚uBr•³Ò“°¢6öç7B–ç2ÒF"çG&ç67F–öâ‚‚’Óâ°¢f÷"†6öç7Böb'G2’F"ç&W&R‚t”å4U%Bõ"”täõ$R”åDò'G2†–BÇ'EöçVÒÆæÖRÆ6FVv÷'’Ç6W&–W2ÆÆ—7E÷&–6RÇ–÷W%ö6÷7BÆæ÷FW2Ç‡&VbÇ7WÆ–W"’dÅTU2ƒòÃòÃòÃòÃòÃòÃòÃòÃòÃò’r’ç'Vâ‡æ–BÇç'EöçVÒÇææÖRÇæ6FVv÷'’Çç6W&–W2ÇæÆ—7E÷&–6RÇç–÷W%ö6÷7BÇææ÷FW2Çç‡&VbÂt–ævW'6öÆÂ&æBr“°¢Ò“°¢–ç2‚“°¢&W7VÇG2çW6‚‡²ö³¢G'VRÂ–BÂF—FÆRÂÖöFVÇ2Â'G3¢'G2æÆVæwF‚ÂvW2Ò“°¢Ò6F6‚†R’°¢&W7VÇG2çW6‚‡²ö³¢fÇ6RÂf–ÆVæÖS¢f–ÆRæ÷&–v–æÆæÖRÂW'&÷#¢RæÖW76vRÒ“°¢Ð¢Ð¢&W2æ§6öâ‡&W7VÇG2“°§Ò“° ¢òò6V&6‚7&÷72&÷F€¦ævWB‚rö’÷6V&6‚rÂ‡&WÂ&W2’Óâ°¢6öç7B²ÒÒ&WçVW'“°¢–b‚’&WGW&â&W2æ§6öâ‡²'G3¢µÒÂÖçVÇ3¢µÒÒ“°¢6öç7BÆ–¶RÒRG·ÒV°¢6öç7B'G2ÒF"ç&W&R‚u4TÄT5B¢e$ôÒ'G2t„U$R'EöçVÒÄ”´Ròõ"æÖRÄ”´Ròõ"æ÷FW2Ä”´Ròõ"‡&VbÄ”´RòÄ”Ô•BSr’æÆÂ†Æ–¶RÆÆ–¶RÆÆ–¶RÆÆ–¶R¢æÖ‡"Óâ‡²ââç"Â‡&Vc¢¥4ôâç'6R‡"ç‡&VbÇÂuµÒr’Ò’“°¢6öç7BÖçVÇ2ÒF"ç&W&R‚u4TÄT5B¢e$ôÒÖçVÇ2t„U$RF—FÆRÄ”´Ròõ"ÖöFVÇ2Ä”´Ròõ"6÷W&6U÷7V&¦V7BÄ”´RòÄ”Ô•B#r’æÆÂ†Æ–¶RÆÆ–¶RÆÆ–¶R¢æÖ‡"Óâ‡²ââç"ÂÖöFVÇ3¢¥4ôâç'6R‡"æÖöFVÇ2ÇÂuµÒr’Ò’“°¢&W2æ§6öâ‡²'G2ÂÖçVÇ2Ò“°§Ò“° ¢òòWF‚7FGW0¦ævWB‚rö’öWF‚÷7FGW2rÂ‡&WÂ&W2’Óâ°¢&W2æ§6öâ‡²6öææV7FVC¢vWE6WGF–ær‚vvÖ–Åö66W75÷Fö¶Vâr’ÂW‡—'“¢vWE6WGF–ær‚vvÖ–Å÷Fö¶VåöW‡—'’r’Ò“°§Ò“° ¦ç÷7B‚rö’öWF‚öF—66öææV7BrÂ‡&WÂ&W2’Óâ°¢F"ç&W&R‚$DTÄUDRe$ôÒ6WGF–æw2t„U$R¶W’”â‚vvÖ–Åö66W75÷Fö¶VârÂvvÖ–Å÷&Vg&W6…÷Fö¶VârÂvvÖ–Å÷Fö¶VåöW‡—'’r’"’ç'Vâ‚“°¢&W2æ§6öâ‡²ö³¢G'VRÒ“°§Ò“° ¢òòÒÒ5D%BÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦æÆ—7FVâ…õ%BÂ‚’Óâ°¢6öç6öÆRæÆör†ÆâÔ2•"'G2FööÂ'Vææ–æröâ‡GG¢òöÆö6Æ†÷7C¢Gµõ%GÖ“°¢6öç6öÆRæÆör†vÖ–Â6öææV7FVC¢G²vWE6WGF–ær‚vvÖ–Åö66W75÷Fö¶Vâr—Ö“°¢6öç6öÆRæÆör†'G2–âD#¢G¶F"ç&W&R‚u4TÄT5B4õTåB‚¢’22e$ôÒ'G2r’ævWB‚’æ7Ö“°¢6öç6öÆRæÆör†ÖçVÇ2–âD#¢G¶F"ç&W&R‚u4TÄT5B4õTåB‚¢’22e$ôÒÖçVÇ2r’ævWB‚’æ7ÕÆæ“°§Ò“° 