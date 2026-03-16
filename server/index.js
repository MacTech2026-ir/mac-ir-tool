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

// ── DIRS ──────────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const DB_PATH = path.join(__dirname, '..', 'data', 'mac_ir.db');
const DATA_DIR = path.join(__dirname, '..', 'data');
[UPLOADS_DIR, DATA_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });