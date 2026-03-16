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