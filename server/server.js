import express from 'express';
import path from 'path'; // Moved up
import dotenv from 'dotenv';
import { fileURLToPath } from 'url'; // For __dirname fix
import { dirname, join } from 'path';

// --- CRITICAL: Define __dirname for ES Modules ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- NOW load the config before anything else ---
dotenv.config({ path: path.join(__dirname, '.env') });

// --- NOW import the rest of your libraries ---
import axios from 'axios';
import cors from 'cors';
import http from 'http';
import { Server } from "socket.io";
import sqlite3 from 'sqlite3';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import AfricasTalking from 'africastalking';
import fs from 'fs';
import helmet from 'helmet';
import { exec } from 'child_process';
import { getSokoBalance, sendSoko, getAdminWalletAddress, isValidAddress } from './blockchain.js';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- FIX: Trust proxy for express-rate-limit behind Ngrok/Load Balancers ---
app.set('trust proxy', 1);

const publicPath = path.join(__dirname, '..', 'public');
const matchCache = new Map();

const PORT = process.env.PORT || 3000;
if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET must be set");
}
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_TILL = process.env.MPESA_TILL || process.env.BUYGOODS_TILL || '4440728';
const at = AfricasTalking({
    apiKey: process.env.AT_API_KEY,
    username: process.env.AT_USERNAME
});
const sms = at.SMS;

app.use(
  helmet({
        contentSecurityPolicy: {
     directives: {
        "upgrade-insecure-requests": null,
                "script-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdn.socket.io"], // Allow common CDNs as needed
        "script-src-attr": ["'unsafe-inline'"],
        "style-src": ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
                "connect-src": ["'self'", "https://ipapi.co", "https://*.ipapi.co", "https://polysoko.com", "https://api.weatherapi.com", "https://nominatim.openstreetmap.org", "https://*.loca.lt", "https://*.ngrok-free.app", "https://*.ngrok-free.dev", "ws:", "wss:", "https://solid-files-enjoy.loca.lt"],
        "frame-src": ["'self'", "https://www.youtube.com", "https://www.youtube-nocookie.com"],
        "media-src": ["'self'", "data:", "blob:", "https:"],
        "img-src": ["'self'", "data:", "https:"],
     },
    },
  })
);
app.use(express.json());
app.use(cors());
// Serve a default avatar fallback when the explicit default.png file is missing
app.get('/uploads/avatars/default.png', (req, res) => {
    const fallback = path.join(publicPath, 'uploads', 'avatars', 'avatar-1778927214826-353713367.jpg');
    if (fs.existsSync(fallback)) return res.sendFile(fallback);
    res.status(404).end();
});
app.use(express.static(publicPath));

app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100
}));

const db = new sqlite3.Database(path.join(__dirname, 'terminal.db'));
const uploadPath = path.join(publicPath, 'uploads', 'avatars');
if (!fs.existsSync(uploadPath)) {
    fs.mkdirSync(uploadPath, { recursive: true });
}

const dbGet = (query, params = []) => new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => err ? reject(err) : resolve(row));
});
const dbAll = (query, params = []) => new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => err ? reject(err) : resolve(rows));
});
const dbRun = (query, params = []) => new Promise((resolve, reject) => {
    db.run(query, params, function(err) { err ? reject(err) : resolve(this); });
});

// --- CORE UTILS ---
const normalizePhone = (phone) => {
    if (!phone) return null;
    // Remove all non-digit characters except leading zero logic
    let p = phone.toString().replace(/\D/g, ''); 
    if (p.startsWith('0')) return '254' + p.slice(1);
    return p;
};

const formatNairobiDate = (offsetDays = 0) => {
    const date = new Date();
    date.setDate(date.getDate() + offsetDays);
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Africa/Nairobi",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(date);

    const get = (type) => parts.find((part) => part.type === type)?.value;
    return `${get("year")}-${get("month")}-${get("day")}`;
};

const personaFilePath = path.join(__dirname, '..', 'public', 'persona.txt');
const personaRaw = fs.existsSync(personaFilePath) ? fs.readFileSync(personaFilePath, 'utf8') : '';
const personaConfig = personaRaw.split(/\r?\n/).reduce((acc, line) => {
    const parts = line.split(':');
    if (parts.length < 2) return acc;
    const key = parts[0].trim().toUpperCase();
    const value = parts.slice(1).join(':').trim();
    if (key === 'KEYWORDS') acc.keywords = value.split(',').map((w) => w.trim()).filter(Boolean);
    if (key === 'INSTRUCTIONS') acc.instructions = value;
    if (key === 'TONE') acc.tone = value;
    if (key === 'ROLE') acc.role = value;
    return acc;
}, { keywords: [], instructions: '', tone: 'High-Energy', role: 'Elite Analyst' });

function buildNewsQuestion(headline) {
    const clean = headline.replace(/^will\s+/i, '').replace(/\?+$/g, '').trim();
    return `Will ${clean}?`;
}

function buildPersonaInsight(headline) {
    const base = headline.replace(/\s+-\s+[^-]+$/, '').trim();
    const hook = personaConfig.instructions || 'Always focus on impact and narrative.';
    const keyword = personaConfig.keywords?.[Math.floor(Math.random() * personaConfig.keywords.length)] || 'Relevant';
    return `Market insight: ${base}. ${hook} This feels ${keyword.toLowerCase()} unless trends shift.`;
}

// --- GEOPOLITICAL NEWS DETECTION ---
function isGeopoliticalNews(headline, description) {
    const text = `${headline || ''} ${description || ''}`.toLowerCase();
    
    // Geopolitical keywords that indicate political, diplomatic, or international affairs news
    const geopoliticalKeywords = [
        // Government & Diplomacy
        'parliament', 'congress', 'senate', 'minister', 'government', 'diplomat', 'ambassador',
        'treaty', 'sanctions', 'embargo', 'resolution', 'legislation', 'bill',
        
        // Elections & Politics
        'election', 'vote', 'campaign', 'candidate', 'political', 'politician', 'party',
        'referendum', 'ballots', 'voting', 'inauguration',
        
        // International Relations
        'war', 'conflict', 'border', 'invasion', 'military', 'troops', 'deployed',
        'ceasefire', 'peace talks', 'negotiations', 'tension', 'crisis',
        
        // Regional & Global Issues
        'russia', 'china', 'iran', 'ukraine', 'israel', 'palestine', 'middle east',
        'north korea', 'south korea', 'taiwan', 'eu', 'brexit', 'nato', 'un',
        'united nations', 'security council', 'geopolitical',
        
        // Economic Sanctions & Trade Wars
        'tariff', 'trade war', 'trade deal', 'export ban', 'import ban', 'trade agreement',
        'commerce department', 'trade policy',
        
        // Protests & Civil Unrest
        'protest', 'demonstration', 'riot', 'civil unrest', 'martial law', 'coup', 'uprising',
        'revolution', 'rebellion',
        
        // Key Politicians & Leaders
        'trump', 'biden', 'putin', 'xi jinping', 'modi', 'macron', 'sunak', 'zelensky',
        'johnson', 'scholz', 'draghi', 'sanchez',
        
        // International Organizations & Summits
        'summit', 'g7', 'g20', 'imf', 'world bank', 'wto', 'oecd', 'brics',
        'apec', 'asean', 'european union',
        
        // Weapons & Military Technology
        'nuclear', 'missile', 'drone strike', 'weapons', 'military exercise', 'defense',
        'airstrikes', 'bombardment', 'naval'
    ];
    
    // Check if any geopolitical keyword matches
    return geopoliticalKeywords.some(keyword => text.includes(keyword));
}

function isTechNews(headline, description) {
    const text = `${headline || ''} ${description || ''}`.toLowerCase();
    const techKeywords = [
        'tech', 'technology', 'software', 'hardware', 'app', 'apps', 'internet',
        'startup', 'silicon', 'chip', 'semiconductor', 'cpu', 'gpu', 'ai', 'artificial intelligence',
        'machine learning', 'robot', 'robotics', 'cloud', 'data breach', 'cyber', 'cybersecurity',
        'hack', 'hacker', 'security', 'smartphone', 'mobile', 'device', 'gadget',
        'streaming', 'vr', 'ar', 'metaverse', 'blockchain', 'web3', 'nft', 'crypto',
        'google', 'apple', 'microsoft', 'amazon', 'tesla', 'meta', 'facebook', 'netflix',
        'spotify', 'elon musk', 'twitter', 'x.com', 'samsung', 'intel', 'amd',
        'nvidia', 'oracle', 'ibm', 'qualcomm', 'sap', 'tiktok', 'wechat',
        'drone', 'satellite', '5g', '6g', 'quantum', 'ai chip', 'sensor',
        'autonomous', 'autonomy', 'self-driving', 'electric vehicle', 'ev',
        'software update', 'operating system', 'ios', 'android'
    ];
    return techKeywords.some(keyword => text.includes(keyword));
}

function createMatchNewsQuery(teamA, teamB) {
    const safeTeamA = teamA ? teamA.replace(/[^a-zA-Z0-9 ]/g, ' ').trim() : '';
    const safeTeamB = teamB ? teamB.replace(/[^a-zA-Z0-9 ]/g, ' ').trim() : '';
    if (safeTeamA && safeTeamB) return `${safeTeamA} OR ${safeTeamB}`;
    return safeTeamA || safeTeamB || 'football';
}

async function syncTmdbMarkets() {
    if (!process.env.TMDB_API_KEY) {
        console.warn('TMDB API key is not configured. Skipping TMDB market sync.');
        return;
    }

    const tmdbBase = 'https://api.themoviedb.org/3';
    const authHeaders = process.env.TMDB_READ_ACCESS_TOKEN ? {
        Authorization: `Bearer ${process.env.TMDB_READ_ACCESS_TOKEN}`
    } : undefined;

    const endpoints = [
        { path: '/trending/movie/week', label: 'Trending Movie', categorySuffix: 'movie', limit: 6 },
        { path: '/movie/upcoming', label: 'Upcoming Movie', categorySuffix: 'movie', limit: 6 },
        { path: '/movie/popular', label: 'Popular Movie', categorySuffix: 'movie', limit: 6 },
        { path: '/movie/top_rated', label: 'Top Rated Movie', categorySuffix: 'movie', limit: 6 },
        { path: '/movie/now_playing', label: 'Now Playing Movie', categorySuffix: 'movie', limit: 6 },
        { path: '/trending/tv/week', label: 'Trending TV Show', categorySuffix: 'tv', limit: 5 },
        { path: '/tv/popular', label: 'Popular TV Show', categorySuffix: 'tv', limit: 5 },
        { path: '/tv/top_rated', label: 'Top Rated TV Show', categorySuffix: 'tv', limit: 5 },
        { path: '/search/movie', label: 'Award Movie', categorySuffix: 'movie', limit: 5, params: { query: 'oscar', include_adult: false } },
        { path: '/search/tv', label: 'Award TV Show', categorySuffix: 'tv', limit: 5, params: { query: 'award', include_adult: false } }
    ];

    try {
        for (const endpoint of endpoints) {
            const url = `${tmdbBase}${endpoint.path}`;
            const response = await axios.get(url, {
                params: {
                    api_key: process.env.TMDB_API_KEY,
                    language: 'en-US',
                    page: 1,
                    ...(endpoint.params || {})
                },
                headers: authHeaders
            });

            const items = Array.isArray(response.data?.results) ? response.data.results.slice(0, endpoint.limit) : [];
            const expiryTime = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

            items.forEach((item) => {
                const title = item.title || item.name || item.original_name || item.original_title || 'Unnamed';
                const idSource = `${endpoint.path}_${item.id || title}`;
                const hash = crypto.createHash('md5').update(idSource).digest('hex');
                const rawHeadline = endpoint.path.includes('trending')
                    ? `${title} is trending on TMDB right now`
                    : endpoint.path.includes('upcoming')
                        ? `${title} is an upcoming TMDB release`
                        : endpoint.path.includes('popular')
                            ? `${title} is one of TMDB's most popular titles`
                            : endpoint.path.includes('top_rated')
                                ? `${title} is a top rated TMDB title`
                                : endpoint.path.includes('/search/')
                                    ? `${title} is getting award attention on TMDB`
                                    : `${title} is featured on TMDB`; 

                const overview = item.overview || item.description || `TMDB entry for ${title}.`;
                const mediaUrl = item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : item.backdrop_path ? `https://image.tmdb.org/t/p/w780${item.backdrop_path}` : null;
                const detailUrl = item.id ? `${endpoint.categorySuffix === 'tv' ? 'https://www.themoviedb.org/tv' : 'https://www.themoviedb.org/movie'}/${item.id}` : null;

                const content = [
                    `Title: ${title}`,
                    endpoint.categorySuffix === 'movie' ? `Release Date: ${item.release_date || 'N/A'}` : `First Air Date: ${item.first_air_date || item.first_air_date || 'N/A'}`,
                    `Popularity: ${item.popularity}`,
                    `Vote Average: ${item.vote_average ?? 'N/A'}`,
                    `Vote Count: ${item.vote_count ?? 'N/A'}`,
                    `Overview: ${overview}`
                ].join('\n');

                const market = buildNewsMarket({
                    id: `tmdb_${endpoint.categorySuffix}_${hash}`,
                    title: rawHeadline,
                    description: overview,
                    content,
                    media_url: mediaUrl,
                    media_type: 'image',
                    category: 'tech',
                    country: 'TMDB',
                    startTime: expiryTime,
                    url: item.homepage || detailUrl,
                    status: 'open',
                    sideA: 'YES',
                    sideB: 'NO'
                });

                db.run(`INSERT INTO markets (id, title, description, content, media_url, media_type, category, country, sideA, sideB, startTime, status, url) VALUES (?, ?, ?, ?, ?, 'image', 'tech', ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description, content=excluded.content, media_url=excluded.media_url, media_type=excluded.media_type, category=excluded.category, country=excluded.country, sideA=excluded.sideA, sideB=excluded.sideB, startTime=excluded.startTime, status=excluded.status, url=excluded.url, timestamp=CURRENT_TIMESTAMP`,
                    [market.id, market.title, market.description, market.content, market.media_url, market.country, market.sideA, market.sideB, market.startTime, market.status, market.url]);
            });
        }
    } catch (e) {
        console.error('TMDB sync error:', e.message);
    }
}

// --- MAILER ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// --- AI helpers: retry on 429 and fallback between OpenAI <-> Gemini ---
async function callOpenAI(model, messages, opts = {}) {
    const maxAttempts = 3;
    let attempt = 0;
    while (attempt < maxAttempts) {
        try {
            const res = await axios.post('https://api.openai.com/v1/chat/completions', {
                model,
                messages,
                temperature: opts.temperature ?? 0.6,
                max_tokens: opts.max_tokens ?? 320
            }, {
                headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }
            });
            return res.data?.choices?.[0]?.message?.content || null;
        } catch (err) {
            const status = err?.response?.status;
            if (status === 429) {
                attempt++;
                const delay = 300 * Math.pow(2, attempt);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            throw err;
        }
    }
    const e = new Error('OpenAI rate-limited');
    e.code = 429;
    throw e;
}

async function callGemini(promptText, opts = {}) {
    const maxAttempts = 3;
    let attempt = 0;
    while (attempt < maxAttempts) {
        try {
            const body = {
                contents: [{ parts: [{ text: promptText }] }],
                generationConfig: {
                    temperature: opts.temperature ?? 0.6,
                    maxOutputTokens: opts.maxOutputTokens ?? 320
                }
            };
            // Corrected to use v1beta as requested
            const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${opts.model || 'gemini-1.5-flash'}:generateContent?key=${process.env.GEMINI_API_KEY}`, body);
            return res.data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
        } catch (err) {
            const status = err?.response?.status;
            if (status === 429) {
                attempt++;
                const delay = 300 * Math.pow(2, attempt);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            throw err;
        }
    }
    const e = new Error('Gemini rate-limited');
    e.code = 429;
    throw e;
}

async function callAI({ engine = 'gpt', messages = null, promptText = '' }) {
    // Priority 1: OpenAI (only if engine is gpt and key is available)
    const useOpenAI = engine === 'gpt' && !!process.env.OPENAI_API_KEY;
    const useGemini = !!process.env.GEMINI_API_KEY;

    if (useOpenAI) {
        try {
            const resp = await callOpenAI('gpt-4o', messages, { temperature: 0.6, max_tokens: 320 });
            if (resp) return { engine: 'openai', text: resp };
        } catch (err) {
            console.error("❌ OpenAI Error:", err.response?.status || err.message);
            if (!useGemini) throw err; // Only throw if we can't fall back to Gemini
        }
    }

    if (useGemini) {
        try {
            const resp = await callGemini(promptText || (messages?.map(m => m.content).join('\n') || ''), { model: 'gemini-1.5-flash', temperature: 0.6, maxOutputTokens: 320 });
            if (resp) return { engine: 'gemini', text: resp };
        } catch (err) {
            console.error("❌ Gemini Error:", err.response?.status || err.message);
            throw err;
        }
    }

    return { engine: 'none', text: null };
}
const sendPolyMail = async (to, subject, html) => {
    console.log(`✉️ Attempting to send email to: "${to}"`); 
    if (!to || to === "null") return;
    try {
        await transporter.sendMail({
            from: `"PolySoko Support" <${process.env.EMAIL_USER}>`,
            to, subject, html
        });
    } catch (e) { console.error("📧 Mail Error:", e.message); }
};
// Define the paths you need
const foldersToCreate = [
    './public/uploads/avatars',
    './backups' // Good practice if you plan to backup terminal.db
];

foldersToCreate.forEach(dir => {
    if (!fs.existsSync(dir)) {
        // recursive: true allows it to create /public AND /uploads at once
        fs.mkdirSync(dir, { recursive: true });
        console.log(`📁 Created directory: ${dir}`);
    }
});
const emitAdminEvent = (event, data = {}) => {
    io.to("adminRoom").emit(event, data);
};
const mapStatus = (short) => {
    if (["1H","2H","HT"].includes(short)) return "live";
    if (short === "FT") return "ended";
    return "open"; // 👈 CRITICAL
};
const MARKET_STATUS = {
  UPCOMING: "upcoming",
  LIVE: "live",
  CLOSED: "closed",
  SETTLED: "settled"
};

const formatPhone = (phone) => {
    let p = phone.trim();
    if (p.startsWith('0')) p = '+254' + p.substring(1);
    if (!p.startsWith('+')) p = '+' + p;
    return p;
};
// --- MULTER STORAGE ---
const storage = multer.diskStorage({
    destination: uploadPath,
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'avatar-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (/jpeg|jpg|png/.test(path.extname(file.originalname).toLowerCase())) return cb(null, true);
        cb(new Error("Only images are allowed"));
    }
});

// --- DB SCHEMA & AUTO-MIGRATION ---
db.serialize(() => {
    // 1. Create tables
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        name TEXT, email TEXT UNIQUE, phone TEXT UNIQUE, password TEXT, 
        balance REAL DEFAULT 0, crypto_balance REAL DEFAULT 0, otp TEXT, status TEXT DEFAULT 'unverified',
        terms_accepted INTEGER DEFAULT 0, referral_code TEXT, referred_by TEXT, verification_token TEXT,
        avatar_url TEXT DEFAULT '/uploads/avatars/default.png', wallet_address TEXT,
        role TEXT DEFAULT 'user'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_phone TEXT,
        title TEXT,
        message TEXT,
        type TEXT DEFAULT 'info',
        is_read INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_phone TEXT, type TEXT, amount REAL, 
        reference TEXT, market_id TEXT, side TEXT, status TEXT, potential_payout REAL, 
        settled_amount REAL, odds REAL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS markets (
        id TEXT PRIMARY KEY, title TEXT, description TEXT, category TEXT, sideA TEXT, sideB TEXT, 
        oddsA REAL DEFAULT 1.90, oddsB REAL DEFAULT 1.90, home_volume REAL DEFAULT 0, away_volume REAL DEFAULT 0,
        league TEXT, country TEXT, startTime DATETIME, result TEXT, settled INTEGER DEFAULT 0,
        media_url TEXT, media_type TEXT, content TEXT,
        creator TEXT,
        url TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, status TEXT DEFAULT 'open'
    )`);
db.run(`CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT,
    token TEXT,
        otp TEXT,
    expires INTEGER
)`);
db.run(`
CREATE TABLE IF NOT EXISTS bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_phone TEXT,
    market_id TEXT,
    event TEXT,
    picked TEXT,
    amount REAL,
    odds REAL,
    status TEXT CHECK(status IN ('active','won','lost','cancelled')),
    category TEXT,
    commence_time TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
`);
db.run(`
CREATE TABLE IF NOT EXISTS user_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_phone TEXT,
    ua_string TEXT,
    first_login DATETIME DEFAULT CURRENT_TIMESTAMP
)
`);
    // 2. Performance Indexes
    db.run(`CREATE INDEX IF NOT EXISTS idx_markets_status ON markets(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_transactions_phone ON transactions(user_phone)`);

const addColumnSafely = (tableName, columnName, definition, callback) => {
    db.all(`PRAGMA table_info(${tableName})`, (err, columns) => {
        if (err || !columns) return;

        const exists = columns.some(col => col.name === columnName);
        
        if (!exists) {
            const cleanDef = definition.replace(/,$/, '');
            const sql = `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${cleanDef}`;

            console.log("🧪 Running:", sql);

            db.run(sql, (err) => {
                if (err) console.error("❌ ALTER ERROR:", err.message);
                if (callback) callback();
            });
        } else {
            if (callback) callback();
        }
    });
};
   
    addColumnSafely('users', 'crypto_balance', 'REAL DEFAULT 0');
    addColumnSafely('markets', 'category', 'TEXT');
    addColumnSafely('markets', 'league', 'TEXT');
    addColumnSafely('markets', 'country', 'TEXT');
    addColumnSafely('markets', 'startTime', 'DATETIME');
    addColumnSafely('markets', 'result', 'TEXT');
    addColumnSafely('markets', 'settled', 'INTEGER DEFAULT 0');
    addColumnSafely('markets', 'media_url', 'TEXT');    
    addColumnSafely('markets', 'media_type', 'TEXT');   
    addColumnSafely('markets', 'content', 'TEXT');  
    addColumnSafely('transactions', 'odds', 'REAL');
    addColumnSafely('transactions', 'settled_amount', 'REAL');
    addColumnSafely('transactions', 'potential_payout', 'REAL');
    addColumnSafely('users', 'verification_token', 'TEXT');
addColumnSafely('transactions', 'mpesa_receipt', 'TEXT');
addColumnSafely('transactions', 'internal_id', 'TEXT');
addColumnSafely('password_resets', 'otp', 'TEXT');
    addColumnSafely('users', 'is_upgraded', 'INTEGER DEFAULT 0');
    addColumnSafely('users', 'upgrade_expiry', 'DATETIME');
    addColumnSafely('users', 'is_suspended', 'INTEGER DEFAULT 0');
    addColumnSafely('users', 'suspension_expires', 'DATETIME');
    addColumnSafely('markets', 'creator', 'TEXT');
    addColumnSafely('markets', 'url', 'TEXT');
    addColumnSafely('markets', 'is_boosted', 'INTEGER DEFAULT 0');
    addColumnSafely('transactions', 'is_boosted', 'INTEGER DEFAULT 0');
    addColumnSafely('bets', 'is_boosted', 'INTEGER DEFAULT 0');
    setTimeout(() => {
        if (process.env.ADMIN_PHONE) {
            const adminPhone = normalizePhone(process.env.ADMIN_PHONE);
            db.run(`UPDATE users SET role='admin' WHERE phone=?`, [adminPhone], (err) => {
                if (err) console.error("❌ Admin Assignment Failed:", err.message);
                else console.log(`👑 SuperAdmin verified: ${adminPhone}`);
            });
        }
    }, 2000); 
});
// --- UTILS ---

// --- CORE UTILS & MIDDLEWARE (Defined early to avoid ReferenceErrors) ---
/** 
 * --- CORE UTILS & MIDDLEWARE ---
 * Defined early to prevent SyntaxErrors (re-declaration) 
 * and ReferenceErrors (using before initialization).
 */
const authenticate = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if(!token) return res.status(401).json({ success:false });
    try { 
        req.user = jwt.verify(token, JWT_SECRET); 
        req.user.phone = normalizePhone(req.user.phone);
        next(); 
    } catch { res.status(401).json({ success:false }); }
};

const authenticateAdmin = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(403).json({ success: false, message: "Authentication token missing" });

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const adminPhone = normalizePhone(process.env.ADMIN_PHONE);
        const userPhone = normalizePhone(decoded.phone);

        if (!adminPhone || userPhone !== adminPhone) {
            console.warn(`🚫 Unauthorized admin access attempt from: ${userPhone}`);
            return res.status(403).json({ success: false, message: "Access denied: Not an administrator" });
        }

        req.user = decoded;
        req.user.role = 'admin';
        req.user.phone = normalizePhone(decoded.phone);
        next();
    } catch {
        return res.status(403).json({ success: false, message: "Invalid or expired session" });
    }
};

const createNotification = async (phone, title, message, type = 'info') => {
    try {
        await dbRun(`INSERT INTO notifications (user_phone, title, message, type) VALUES (?, ?, ?, ?)`, 
            [normalizePhone(phone), title, message, type]);
        io.to(normalizePhone(phone)).emit('newNotification', { title, message, type });
    } catch (e) { console.error("Notification Error:", e); }
};

const emitBalance = (phone) => {
    const normalized = normalizePhone(phone);
    db.get(`SELECT balance FROM users WHERE phone=?`, [normalized], (err, user) => {
        if (err) return console.error("❌ Database error in emitBalance:", err);
        if (user) {
            io.to(normalized).emit("balanceUpdate", { balance: user.balance });
        }
    });
};

const emitMarkets = () => {
    const sql = `SELECT * FROM markets WHERE status IN ('open','live','upcoming','pending') ORDER BY category ASC, title ASC`;
    db.all(sql, [], (err, rows) => {
        if (err) return console.error("❌ DB Error:", err.message);
        io.emit('marketsUpdated', {
            status: 'success',
            count: rows?.length || 0,
            lastUpdated: new Date().toISOString(),
            markets: rows || []
        });
        // Also notify admin room of pending counts
        const pending = rows.filter(m => m.status === 'pending').length;
        io.to("adminRoom").emit('adminStatsUpdate', { pendingMarkets: pending });
    });
};

// --- NOTIFICATION ROUTES ---
app.get('/api/notifications', authenticate, async (req, res) => {
    try {
        const notes = await dbAll(
            `SELECT * FROM notifications WHERE user_phone = ? ORDER BY created_at DESC LIMIT 50`,
            [normalizePhone(req.user.phone)]
        );
        res.json({ success: true, notifications: notes });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/notifications/read-all', authenticate, async (req, res) => {
    try {
        await dbRun(
            `UPDATE notifications SET is_read = 1 WHERE user_phone = ?`,
            [normalizePhone(req.user.phone)]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.delete('/api/notifications/:id', authenticate, async (req, res) => {
    try {
        await dbRun(
            `DELETE FROM notifications WHERE id = ? AND user_phone = ?`,
            [req.params.id, normalizePhone(req.user.phone)]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

const syncFootballMarkets = async () => {
    try {
        console.log("⚽ Syncing football fixtures via API-Football...");

        // Dates for Today and Tomorrow in YYYY-MM-DD
        const dates = [0, 1].map((daysAhead) => formatNairobiDate(daysAhead));

        const responses = await Promise.all(dates.map((date) => (
            axios.get('https://v3.football.api-sports.io/fixtures', {
                params: {
                    date,
                    timezone: 'Africa/Nairobi'
                },
                headers: {
                    'x-apisports-key': process.env.FOOTBALL_API_KEY
                }
            })
        )));

        // API-Football returns data inside 'response'
        const matches = responses.flatMap((res) => res.data?.response || []);
        const apiErrors = responses.map((res) => res.data?.errors).filter(e => e && Object.keys(e).length > 0);

        if (apiErrors.length > 0) {
            console.error("⚠️ API-Football Errors:", JSON.stringify(apiErrors));
        }

        if (matches.length === 0) {
            console.log("⚠️ No fixtures returned from API-Football.");
            return;
        }

        console.log(`⚽ Syncing ${matches.length} matches...`);
        await processMatches(matches);

    } catch (e) {
        console.error("⚽ API-Football Sync Error:", e.response?.data || e.message);
    }
};
const processMatches = async (matches) => {
    if (!matches || matches.length === 0) return;

    for (const m of matches) {
        // API-Football uses m.fixture.id and m.fixture.date
        const marketId = `fb_${m.fixture.id}`;
        const homeTeam = m.teams.home.name;
        const awayTeam = m.teams.away.name;
        const title = `${homeTeam} vs ${awayTeam}`;

        // Compute status using the fixture status (e.g., 'NS', '1H', 'FT')
        const status = computeMarketStatus(
            m.fixture.date,
            m.fixture.status.short
        );

        const category = "football";

        await dbRun(
            `INSERT INTO markets 
            (id, title, category, sideA, sideB, oddsA, oddsB, startTime, status, league, country) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET 
            title = excluded.title,
            status = excluded.status,
            startTime = excluded.startTime,
            league = excluded.league,
            country = excluded.country`,
            [
                marketId,
                title,
                category,
                homeTeam,
                awayTeam,
                1.90, 
                1.90, 
                m.fixture.date,
                status,
                m.league.name || "Football",
                m.league.country || "International"
            ]
        );
    }

    emitMarkets();
};

    // Sync weather markets once every 24 hours using the official Weather API
    // Expanded Environmental & Weather Sync
    const syncWeatherMarkets = async () => {
        const towns = [
            // Kenya hub
            { name: 'Mombasa', lat: -4.0435, lon: 39.6682 },
            { name: 'Nairobi', lat: -1.2864, lon: 36.8172 },
            { name: 'Kisumu', lat: -0.0917, lon: 34.7680 },
            { name: 'Nakuru', lat: -0.3031, lon: 36.0800 },
            { name: 'Eldoret', lat: 0.5143, lon: 35.2698 },
            // Global Hubs
            { name: 'London', lat: 51.5074, lon: -0.1278 },
            { name: 'New York', lat: 40.7128, lon: -74.0060 },
            { name: 'Tokyo', lat: 35.6895, lon: 139.6917 },
            { name: 'Dubai', lat: 25.2048, lon: 55.2708 },
            { name: 'Lagos', lat: 6.5244, lon: 3.3792 },
            { name: 'Johannesburg', lat: -26.2041, lon: 28.0473 },
            { name: 'Paris', lat: 48.8566, lon: 2.3522 },
            { name: 'Sydney', lat: -33.8688, lon: 151.2093 }
        ];

        for (const town of towns) {
            try {
                let forecast = null;
                try {
                    const wRes = await axios.get(`http://api.weatherapi.com/v1/forecast.json`, {
                        params: { key: process.env.WEATHER_API_KEY, q: town.name, days: 2, alerts: 'yes' }
                    });
                    const tomorrow = wRes.data?.forecast?.forecastday?.[1];
                    if (tomorrow) {
                        forecast = {
                            date: tomorrow.date,
                            icon: tomorrow.day?.condition?.icon ? `https:${tomorrow.day.condition.icon}` : null,
                            condition: tomorrow.day?.condition?.text || 'Forecast',
                            rainChance: tomorrow.day?.daily_chance_of_rain || 0,
                            avgTemp: tomorrow.day?.avgtemp_c || 0,
                            maxTemp: tomorrow.day?.maxtemp_c || 0,
                            maxWind: tomorrow.day?.maxwind_kph || 0,
                            alerts: wRes.data?.alerts?.alert || [],
                            provider: 'WeatherAPI'
                        };
                    }
                } catch (err) {
                    // Fallback to Open-Meteo if WeatherAPI fails
                    const meteo = await axios.get('https://api.open-meteo.com/v1/forecast', {
                        params: {
                            latitude: town.lat,
                            longitude: town.lon,
                            timezone: 'Africa/Nairobi',
                            daily: 'precipitation_probability_max,temperature_2m_max,temperature_2m_min,wind_speed_10m_max'
                        }
                    });
                    const daily = meteo.data.daily || {};
                    forecast = {
                        date: daily.time?.[1] || formatNairobiDate(1),
                        icon: null,
                        condition: 'Forecast available',
                        rainChance: daily.precipitation_probability_max?.[1] || 0,
                        avgTemp: ((daily.temperature_2m_max?.[1] || 0) + (daily.temperature_2m_min?.[1] || 0)) / 2,
                        maxTemp: daily.temperature_2m_max?.[1] || 0,
                        maxWind: daily.wind_speed_10m_max?.[1] || 0,
                        alerts: [],
                        provider: 'Open-Meteo'
                    };
                }

                if (!forecast) continue;

                const baseId = `env_${town.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${forecast.date.replace(/-/g, '_')}`;
                
                const marketVariants = [
                    {
                        id: `${baseId}_rain`,
                        title: `Will it rain in ${town.name} tomorrow?`,
                        desc: `Forecast: ${forecast.condition}. Chance of rain: ${forecast.rainChance}%.`,
                    },
                    {
                        id: `${baseId}_temp`,
                        title: `Will ${town.name} exceed 35°C tomorrow?`,
                        desc: `Expected Max Temp: ${forecast.maxTemp}°C. This market resolves YES if the daily high reaches 35.0°C or more.`,
                    },
                    {
                        id: `${baseId}_wind`,
                        title: `Gale Warning: Winds over 50km/h in ${town.name}?`,
                        desc: `Forecasted Max Wind: ${forecast.maxWind} kph. Resolves YES if peak gusts exceed 50kph.`,
                    },
                    {
                        id: `${baseId}_alert`,
                        title: `Severe Warning (Tsunami/Flood) for ${town.name}?`,
                        desc: `Current Alerts: ${forecast.alerts?.length || 0}. Resolves YES if any official Severe Weather, Tsunami, or Flood warnings are issued for this date.`,
                    }
                ];
                for (const m of marketVariants) {
                    await dbRun(
                        `INSERT INTO markets (id, title, description, content, media_url, media_type, category, country, sideA, sideB, startTime, status) 
                         VALUES (?, ?, ?, ?, ?, 'image', 'weather', ?, 'YES', 'NO', ?, 'open')
                         ON CONFLICT(id) DO UPDATE SET 
                            title=excluded.title, 
                            description=excluded.description, 
                            content=excluded.content, 
                            media_url=excluded.media_url, 
                            timestamp=CURRENT_TIMESTAMP`,
                        [
                            m.id, 
                            m.title, 
                            m.desc, 
                            m.desc, 
                            forecast.icon, 
                            town.name.toLowerCase(), 
                            forecast.date
                        ]
                    );
                }
            } catch (e) {
                console.warn(`Weather sync failed for ${town.name}:`, e.message);
            }
        }

        // After syncing, push markets to connected clients
        emitMarkets();
    };
const normalizeStatus = (status) => {
    if (!status) return "upcoming";

    const s = status.toUpperCase();

    if (["1H", "2H", "HT", "ET", "P", "LIVE"].includes(s)) {
        return "live";
    }

    if (["FT", "AET", "PEN"].includes(s)) {
        return "closed";
    }
    
    if (["CANCL", "PSTP", "ABD", "SUSP", "INT"].includes(s)) {
        return "suspended";
    }

    return "upcoming";
};

const computeMarketStatus = (startTime, apiStatusShort = null) => {
    const now = Date.now();
    
    const start = new Date(startTime).getTime();

    if (apiStatusShort) {
        const normalized = normalizeStatus(apiStatusShort);
        if (normalized !== "upcoming") return normalized;
    }

    if (start <= now) return "live";
    
    return "upcoming";
};
const cleanupOutdatedMarkets = async () => {
    const today = formatNairobiDate();
    const now = new Date().toISOString();

    // 1. Remove finalized/cancelled markets
    await dbRun(`DELETE FROM markets WHERE status IN ('closed','ended','settled','suspended','cancelled') OR settled = 1`);
    
    // 2. Remove football matches that started before today
    await dbRun(
        `DELETE FROM markets 
         WHERE category='football' 
         AND (status NOT IN ('upcoming','live') OR date(startTime) < date(?))`,
        [today]
    );

    // 3. Remove crypto/weather/news markets that have expired based on startTime
    await dbRun(
        `DELETE FROM markets 
         WHERE category IN ('crypto', 'weather', 'news') 
         AND startTime IS NOT NULL 
         AND startTime < ?`,
        [now]
    );

    // 4. Remove redundant markets with no startTime that are old (orphaned)
    await dbRun(`DELETE FROM markets WHERE startTime IS NULL AND timestamp < datetime('now', '-1 day')`);
    
    console.log("🧹 Database cleanup complete: Redundant markets cleared.");
};

// Helper to ensure all active markets have a closure time
const fixMissingMarketTimes = async () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await dbRun(`UPDATE markets SET startTime = ? WHERE startTime IS NULL AND status IN ('open', 'upcoming', 'live')`, [tomorrow]);
};

const recalculateOdds = async (marketId) => {
    try {
        const market = await dbGet(
            `SELECT home_volume, away_volume FROM markets WHERE id=?`,
            [marketId]
        );

        if (!market) return;

        const total = market.home_volume + market.away_volume;

        // Avoid division by zero
        if (total === 0) return;

        // Simple probability-based odds
        const minLiquidity = 100;

let oddsA = (total + minLiquidity) / ((market.home_volume || 1) + minLiquidity);
let oddsB = (total + minLiquidity) / ((market.away_volume || 1) + minLiquidity);
        // Add house margin (important for profit)
        const margin = 1.05;
        oddsA = Number((oddsA * margin).toFixed(2));
        oddsB = Number((oddsB * margin).toFixed(2));

        await dbRun(
            `UPDATE markets SET oddsA=?, oddsB=? WHERE id=?`,
            [oddsA, oddsB, marketId]
        );

    } catch (e) {
        console.error("Odds calc error:", e.message);
    }
};
// --- SETTLEMENT ENGINE ---
const settleMarket = async (marketId, winningSide) => {
    console.log(`⚖️ Settling market ${marketId} → ${winningSide}`);

    try {
        // ✅ CHECK FIRST
        const market = await dbGet(
            `SELECT settled FROM markets WHERE id=?`,
            [marketId]
        );

        if (market?.settled) {
            console.log("⚠️ Market already settled.");
            return;
        }

        // 1. Get bets
        const bets = await dbAll(`
            SELECT * FROM transactions
            WHERE market_id = ?
            AND type = 'bet'
            AND status = 'active'
        `, [marketId]);

        if (!bets.length) {
            console.log("⚠️ No active bets found.");
            return;
        }

        let totalPayout = 0;
        let totalStake = 0;

        await dbRun("BEGIN TRANSACTION");

        for (const bet of bets) {
            totalStake += bet.amount;

            const isWinner = bet.side === winningSide;

            if (isWinner) {
                const payout = Number((bet.amount * bet.odds).toFixed(2));
                totalPayout += payout;

                await dbRun(
                    `UPDATE users SET balance = balance + ? WHERE phone = ?`,
                    [payout, bet.user_phone]
                );

                await dbRun(
                    `UPDATE transactions 
                     SET status='won', settled_amount=? 
                     WHERE id=?`,
                    [payout, bet.id]
                );
                
                await dbRun(
                    `UPDATE bets SET status='won' WHERE market_id=? AND user_phone=? AND status IN ('active','pending','open')`,
                    [marketId, bet.user_phone]
                );

                emitBalance(bet.user_phone);

            } else {
                await dbRun(
                    `UPDATE transactions 
                     SET status='lost', settled_amount=0 
                     WHERE id=?`,
                    [bet.id]
                );

                await dbRun(
                    `UPDATE bets SET status='lost' WHERE market_id=? AND user_phone=? AND status IN ('active','pending','open')`,
                    [marketId, bet.user_phone]
                );
            }
        }

        console.log(`📊 Market P&L → Stake: ${totalStake}, Paid: ${totalPayout}, Profit: ${totalStake - totalPayout}`);

        await dbRun(`
            UPDATE markets 
            SET status='settled', result=?, settled=1 
            WHERE id=?
        `, [winningSide, marketId]);

        await dbRun("COMMIT");

        console.log(`✅ Market ${marketId} fully settled`);

        emitMarkets();

    } catch (e) {
        console.error("❌ Settlement failed:", e.message);
        await dbRun("ROLLBACK");
    }
};
const settleWeatherMarkets = async () => {
    const markets = await dbAll(`
        SELECT * FROM markets 
        WHERE category='weather' 
        AND status='open' 
        AND settled=0
    `);

    for (const m of markets) {
        try {
            const town = m.country;
            const date = new Date(m.startTime).toISOString().split('T')[0];

            const res = await axios.get(
                `http://api.weatherapi.com/v1/history.json`,
                {
                    params: { key: process.env.WEATHER_API_KEY, q: town, dt: date }
                }
            );

            const day = res.data?.forecast?.forecastday?.[0]?.day;
            if (!day) continue;

            let result = 'NO';
            if (m.id.endsWith('_rain')) {
                result = day.daily_will_it_rain ? 'YES' : 'NO';
            } else if (m.id.endsWith('_temp')) {
                result = day.maxtemp_c >= 35 ? 'YES' : 'NO';
            } else if (m.id.endsWith('_wind')) {
                result = day.maxwind_kph >= 50 ? 'YES' : 'NO';
            } else if (m.id.endsWith('_alert')) {
                // For history, alerts are harder to retroactively get from WeatherAPI Basic.
                // Fallback: If wind > 80 or rain > 90% or precip > 20mm, it's a severe event.
                result = (day.maxwind_kph > 80 || day.totalprecip_mm > 20) ? 'YES' : 'NO';
            }

            await settleMarket(m.id, result);

        } catch (e) {
            console.error("🌧️ Weather settlement error:", e.message);
        }
    }
};
const closeExpiredMarkets = async () => {
    try {
        const now = Date.now();

        const markets = await dbAll(
            `SELECT * FROM markets 
             WHERE status IN ('upcoming', 'live', 'open') AND startTime IS NOT NULL`
        );

        for (const m of markets) {
            const start = new Date(m.startTime).getTime();
            const isExpiredUpcoming = (m.status === "upcoming" || m.status === "open") && start <= now;
            const isStaleLive = m.status === "live" && start + (3 * 60 * 60 * 1000) <= now;

            if (isExpiredUpcoming || isStaleLive) {
                await dbRun(
                    `UPDATE markets SET status='closed' WHERE id=?`,
                    [m.id]
                );

                console.log(`⛔ Market closed: ${m.id}`);
            }
        }

        emitMarkets();

    } catch (e) {
        console.error("Close market error:", e.message);
    }
};
const refreshBoostedMarkets = async () => {
    try {
        const candidates = await dbAll(`
            SELECT id, home_volume, away_volume, status
            FROM markets
            WHERE status IN ('open','upcoming','live') AND settled = 0
        `, []);

        if (!candidates || candidates.length === 0) {
            return;
        }

        const selectedIds = candidates
            .map(m => ({
                id: m.id,
                volume: Number(m.home_volume || 0) + Number(m.away_volume || 0)
            }))
            .sort((a, b) => b.volume - a.volume || Math.random() - 0.5)
            .slice(0, 10)
            .map(m => m.id);

        await dbRun("BEGIN TRANSACTION");
        await dbRun(`UPDATE markets SET is_boosted = 0 WHERE is_boosted = 1`);
        for (const id of selectedIds) {
            await dbRun(`UPDATE markets SET is_boosted = 1 WHERE id = ?`, [id]);
        }
        await dbRun("COMMIT");

        if (selectedIds.length) {
            console.log(`🟩 Refreshed boosted markets: ${selectedIds.join(', ')}`);
            emitMarkets();
        }
    } catch (e) {
        console.error("❌ Boosted markets refresh failed:", e.message);
        await dbRun("ROLLBACK");
    }
};

const settleResolvedMarkets = async () => {
    try {
        const toSettle = await dbAll(`
            SELECT id, result
            FROM markets
            WHERE settled = 0 AND result IS NOT NULL AND TRIM(result) != ''
        `, []);

        for (const market of toSettle) {
            await settleMarket(market.id, market.result);
        }
    } catch (e) {
        console.error("❌ Resolved market settlement failed:", e.message);
    }
};

const sendDailyMarkets = () => {
    db.all(`SELECT email FROM users WHERE terms_accepted=1`, [], (err, users) => {
        db.all(`SELECT title, oddsA, oddsB FROM markets WHERE status='upcoming' LIMIT 5`, [], (err, markets) => {
            if (!markets || markets.length === 0) return;
            const marketList = markets.map(m => `${m.title} (Yes: ${m.oddsA} | No: ${m.oddsB})`).join('\n');
            users.forEach(u => {
                sendPolyMail(u.email, "Today's Hot Markets 🔥", `Check out these live odds:\n\n${marketList}`);
            });
        });
    });
};
// --- AUTH MIDDLEWARE ---

// --- SYNC LOGIC ---
const syncAllMarkets = async () => {
    console.log(`[${new Date().toLocaleTimeString()}] 🔄 STARTING GLOBAL SYNC...`);
  // --- 2. CRYPTO MARKETS (Using CoinGecko) ---
    try {
        const cryptoRes = await axios.get('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana&price_change_percentage=24h');
        
        const marketDate = formatNairobiDate();
        const expiryTime = new Date(new Date().setHours(23, 59, 59, 999)).toISOString(); // Closes at end of day

        cryptoRes.data.forEach(coin => {
const marketId = `crypto_${coin.id}_${marketDate}`;            
            const targetPrice = (coin.current_price * 1.02).toFixed(2); // 2% target
            const title = `Will ${coin.name} hit $${targetPrice} today?`;
            const description = `${coin.name} is trading at $${coin.current_price?.toLocaleString?.() || coin.current_price}. 24h change: ${Number(coin.price_change_percentage_24h || 0).toFixed(2)}%.`;
            const content = [
                `Current price: $${coin.current_price}`,
                `24h high: $${coin.high_24h}`,
                `24h low: $${coin.low_24h}`,
                `Market cap: $${coin.market_cap}`,
                `24h volume: $${coin.total_volume}`
            ].join("\n");

            db.run(
                `INSERT INTO markets (id, title, description, content, media_url, media_type, category, sideA, sideB, startTime) 
                 VALUES (?, ?, ?, ?, ?, 'image', 'crypto', 'YES', 'NO', ?)
                 ON CONFLICT(id) DO UPDATE SET
                    title = excluded.title,
                    description = excluded.description,
                    content = excluded.content,
                    media_url = excluded.media_url,
                    media_type = excluded.media_type,
                    startTime = excluded.startTime,
                    timestamp = CURRENT_TIMESTAMP,
                    status = 'open'`,
                [marketId, title, description, content, coin.image || null, expiryTime]
            );
        });
    } catch (e) { console.error("🪙 Crypto Sync Error:", e.message); }

    try {
        await syncTmdbMarkets();
    } catch (e) {
        console.error('TMDB sync failed inside syncAllMarkets:', e.message);
    }

    // Weather markets are handled by a dedicated syncWeatherMarkets() function
    // to avoid duplicate creation and to allow a 24-hour refresh cadence.
    try {
        await syncWeatherMarkets();
    } catch (e) {
        console.error('Weather sync failed inside syncAllMarkets:', e.message);
    }

    // --- 4. NEWS MARKETS (API-driven news markets using persona rules) ---
    const keyRegions = ['us', 'gb', 'ke', 'ng']; // Reduced to stay within NewsAPI Free Tier limits (100 req/day)
    for (const country of keyRegions) {
        try {
            const newsRes = await axios.get(`https://newsapi.org/v2/top-headlines?country=${country}&apiKey=${process.env.NEWS_API_KEY}`);
            const articles = newsRes.data.articles.slice(0, 5); // Get more articles to separate by category
            
            // Separate articles into regular news, tech news, and geopolitical news
            const regularNews = [];
            const techNews = [];
            const geopoliticalNews = [];
            
            articles.forEach((a) => {
                if (isTechNews(a.title, a.description)) {
                    techNews.push(a);
                } else if (isGeopoliticalNews(a.title, a.description)) {
                    geopoliticalNews.push(a);
                } else {
                    regularNews.push(a);
                }
            });
            
            // Process regular news (keep first 2)
            regularNews.slice(0, 2).forEach((a) => {
                const hash = crypto.createHash('md5').update(a.title + country).digest('hex');
                const rawHeadline = String(a.title || '').trim();
                
                // Improved content fetching to include description and snippets if available
                const mainStory = a.description || "";
                const snippet = a.content ? a.content.replace(/\[\+\d+ chars\]/g, " [Read full story on source]") : "";
                const content = `${mainStory}\n\n${snippet}\n\nSource: ${a.source?.name || country.toUpperCase()}\nPublished: ${new Date(a.publishedAt).toLocaleString()}`;
                
                const newsExpiry = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(); // 12h rotation
                const market = buildNewsMarket({
                    id: `news_${hash}`,
                    title: rawHeadline,
                    description: a.description || rawHeadline,
                    content,
                    media_url: a.urlToImage || null,
                    media_type: 'image',
                    category: 'news',
                    country,
                    startTime: newsExpiry,
                    url: a.url || null,
                    status: 'open'
                });
                db.run(`INSERT INTO markets (id, title, description, content, media_url, media_type, category, country, sideA, sideB, startTime, status, url) VALUES (?, ?, ?, ?, ?, 'image', 'news', ?, 'YES', 'NO', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description, content=excluded.content, media_url=excluded.media_url, startTime=excluded.startTime, status=excluded.status, url=excluded.url, timestamp=CURRENT_TIMESTAMP`,
                    [market.id, market.title, market.description, market.content, market.media_url, country, market.startTime, market.status, market.url]);
            });
            
            // Process tech news as tech markets
            techNews.slice(0, 3).forEach((a) => {
                const hash = crypto.createHash('md5').update(a.title + country + 'tech').digest('hex');
                const rawHeadline = String(a.title || '').trim();
                const mainStory = a.description || "";
                const snippet = a.content ? a.content.replace(/\[\+\d+ chars\]/g, " [Read full story on source]") : "";
                const content = `${mainStory}\n\n${snippet}\n\nSource: ${a.source?.name || country.toUpperCase()}\nPublished: ${new Date(a.publishedAt).toLocaleString()}`;
                const techExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h tech rotation
                const market = buildNewsMarket({
                    id: `tech_${hash}`,
                    title: rawHeadline,
                    description: a.description || rawHeadline,
                    content,
                    media_url: a.urlToImage || null,
                    media_type: 'image',
                    category: 'tech',
                    country,
                    startTime: techExpiry,
                    url: a.url || null,
                    status: 'open',
                    sideA: 'YES',
                    sideB: 'NO'
                });
                db.run(`INSERT INTO markets (id, title, description, content, media_url, media_type, category, country, sideA, sideB, startTime, status, url) VALUES (?, ?, ?, ?, ?, 'image', 'tech', ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description, content=excluded.content, media_url=excluded.media_url, startTime=excluded.startTime, status=excluded.status, url=excluded.url, sideA=excluded.sideA, sideB=excluded.sideB, timestamp=CURRENT_TIMESTAMP`,
                    [market.id, market.title, market.description, market.content, market.media_url, country, market.sideA, market.sideB, market.startTime, market.status, market.url]);
            });
            
            // Process geopolitical news as politics markets
            geopoliticalNews.slice(0, 3).forEach((a) => {
                const hash = crypto.createHash('md5').update(a.title + country + 'politics').digest('hex');
                const rawHeadline = String(a.title || '').trim();
                
                // Improved content fetching to include description and snippets if available
                const mainStory = a.description || "";
                const snippet = a.content ? a.content.replace(/\[\+\d+ chars\]/g, " [Read full story on source]") : "";
                const content = `${mainStory}\n\n${snippet}\n\nSource: ${a.source?.name || country.toUpperCase()}\nPublished: ${new Date(a.publishedAt).toLocaleString()}`;
                
                // Politics markets expire in 48 hours for longer-term geopolitical events
                const politicsExpiry = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
                const market = buildNewsMarket({
                    id: `geo_${hash}`,
                    title: rawHeadline,
                    description: a.description || rawHeadline,
                    content,
                    media_url: a.urlToImage || null,
                    media_type: 'image',
                    category: 'politics',  // Politics category
                    country,
                    startTime: politicsExpiry,
                    url: a.url || null,
                    status: 'open',
                    sideA: 'LIKELY',
                    sideB: 'UNLIKELY'  // Better suited for geopolitical events
                });
                db.run(`INSERT INTO markets (id, title, description, content, media_url, media_type, category, country, sideA, sideB, startTime, status, url) VALUES (?, ?, ?, ?, ?, 'image', 'politics', ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description, content=excluded.content, media_url=excluded.media_url, startTime=excluded.startTime, status=excluded.status, url=excluded.url, sideA=excluded.sideA, sideB=excluded.sideB, timestamp=CURRENT_TIMESTAMP`,
                    [market.id, market.title, market.description, market.content, market.media_url, country, market.sideA, market.sideB, market.startTime, market.status, market.url]);
            });
        } catch (e) { console.error("News Error for country", country, ":", e.message); }
    }

    emitMarkets();
};

app.post('/api/register', async (req, res) => {
    const { name, phone, password, email, referralCode } = req.body;
    const normalized = normalizePhone(phone);
    try {
        if (!password || password.length < 8) {
            return res.status(400).json({ success: false, message: "Password must be at least 8 characters long." });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const myReferralCode = crypto.randomBytes(3).toString('hex').toUpperCase();
        const verificationToken = crypto.randomBytes(32).toString('hex');

        db.run(`INSERT INTO users (name, phone, password, email, referral_code, referred_by, verification_token, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'unverified')`,
            [name, normalized, hashedPassword, email, myReferralCode, referralCode || null, verificationToken], function(err) {
                if (err) return res.status(400).json({ success: false, message: "User already exists." });
                
                const verifyLink = `${process.env.BASE_URL}/verify.html?token=${verificationToken}`;
                sendPolyMail(email, "Welcome to PolySoko - Verify Your Account", 
                    `<h1>Welcome ${name}!</h1>
                     <p>Soko ni Soko. Please verify your account to activate your referral benefits:</p>
                     <a href="${verifyLink}" style="padding:10px 20px; background:#00ff88; color:black; text-decoration:none; border-radius:5px; font-weight:bold;">Verify Account</a>`);

                if (referralCode) {
                    db.get(`SELECT phone, is_upgraded FROM users WHERE UPPER(referral_code) = UPPER(?)`, [referralCode], (err, referrer) => {
                        if (referrer && referrer.phone !== normalized) {
                            const bonus = referrer.is_upgraded === 1 ? 100 : 50;
                            db.run(`UPDATE users SET balance = balance + ? WHERE phone = ?`, [bonus, referrer.phone]);
                            db.run(`INSERT INTO transactions (user_phone, type, amount, status, reference) VALUES (?, 'referral_bonus', ?, 'completed', ?)`, 
                                [referrer.phone, bonus, `REF_BONUS_${normalized}`], (err) => {
                                    if (!err) emitBalance(referrer.phone);
                                });
                        }
                    });
                }
                res.json({ success: true });
            }
        );
    } catch (e) { res.status(500).json({ success: false }); }
});

app.get('/api/verify', (req, res) => {
    const { token } = req.query;
    db.get(`SELECT phone FROM users WHERE verification_token = ?`, [token], (err, user) => {
        if (err || !user) return res.status(400).json({ success: false, message: "Invalid or expired token" });
        
        db.run(`UPDATE users SET status = 'verified', verification_token = NULL WHERE verification_token = ?`, [token], (err) => {
            if (err) return res.status(500).json({ success: false });
            res.json({ success: true, message: "Account verified! Your referral code is now active." });
        });
    });
});

app.post('/api/reset-password', async (req, res) => {
    const { token, newPassword, otp } = req.body;
    try {
        const reset = await dbGet(`SELECT phone FROM password_resets WHERE token = ? AND otp = ? AND expires > ?`, [token, otp, Date.now()]);
        if (!reset) return res.status(400).json({ success: false, message: "Link expired or invalid" });

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await dbRun(`UPDATE users SET password = ? WHERE phone = ?`, [hashedPassword, reset.phone]);
        await dbRun(`DELETE FROM password_resets WHERE phone = ?`, [reset.phone]);

        const user = await dbGet(`SELECT email FROM users WHERE phone = ?`, [reset.phone]);
        if (user?.email) {
            sendPolyMail(user.email, "Security Notification: Password Changed", 
                `<p>Hello, your PolySoko password was successfully reset. If you did not perform this action, please contact support immediately.</p>`);
        }

        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/login', (req, res) => {
    const { phone, password } = req.body;
    const normalized = normalizePhone(phone);
    const ua = req.headers['user-agent'] || 'Unknown Device';

    db.get(`SELECT * FROM users WHERE phone=?`, [normalized], async (err, user) => {
        if(!user || !(await bcrypt.compare(password, user.password))) return res.json({ success:false });
        if (user.is_suspended) return res.json({ success: false, message: "This account has been suspended." });

        // New Device Detection
        db.get(`SELECT id FROM user_devices WHERE user_phone=? AND ua_string=?`, [normalized, ua], async (err, device) => {
            if (!device) {
                await dbRun(`INSERT INTO user_devices (user_phone, ua_string) VALUES (?, ?)`, [normalized, ua]);
                
                // Identify Phone Type
                let deviceType = "Desktop/Unknown";
                if (/iPhone/i.test(ua)) deviceType = "iPhone";
                else if (/Android/i.test(ua)) deviceType = "Android Device";
                else if (/iPad/i.test(ua)) deviceType = "iPad";

                if (user.email) {
                    sendPolyMail(user.email, "Security Alert: New Login Detected", `
                        <div style="font-family: sans-serif; padding: 20px; border: 1px solid #333; border-radius: 12px; background: #0b0c10; color: white;">
                            <h2 style="color: #00ff88;">New Device Login</h2>
                            <p>Hello ${user.name}, your account was just accessed from a new device.</p>
                            <div style="background: #1a1b23; padding: 15px; border-radius: 8px; margin: 20px 0;">
                                <b>Device Type:</b> ${deviceType}<br>
                                <b>Time:</b> ${new Date().toLocaleString()}<br>
                                <b>User Agent:</b> <span style="font-size: 0.7rem; color: #777;">${ua}</span>
                            </div>
                            <p style="font-size: 0.8rem; color: #888;">If this wasn't you, please reset your password immediately in the app.</p>
                        </div>`);
                }
            }
        });

        const token = jwt.sign({ phone: normalized }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, token });
    });
});
app.post('/api/logout', (req, res) => {
    res.json({ success: true, message: "Logged out successfully" });
});
app.get('/api/profile', authenticate, (req, res) => {
    db.get(`SELECT name, phone, email, balance, referral_code, avatar_url, role, is_upgraded FROM users WHERE phone=?`, [req.user.phone], (err, user) => {
        res.json({ success: true, user });
    });
});
app.get('/api/user/me', authenticate, async (req, res) => {
    try {
        const user = await dbGet(
            `SELECT name, phone, balance, role, avatar_url, is_upgraded FROM users WHERE phone=?`, 
            [req.user.phone]
        );
        if (!user) return res.status(404).json({ success: false });
        res.json({ success: true, user });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});
// Add this to server.js to catch the frontend request
app.get('/api/user/profile', authenticate, (req, res) => {
    db.get(`SELECT name, phone, email, balance, referral_code, avatar_url, role, is_upgraded FROM users WHERE phone=?`, 
    [req.user.phone], (err, user) => {
        if (err || !user) return res.status(404).json({ success: false });
        res.json({ success: true, user });
    });
});

app.post('/api/user/update', authenticate, (req, res) => {
    const { name, email } = req.body;
    db.run(
        `UPDATE users SET name = ?, email = ? WHERE phone = ?`,
        [name, email, req.user.phone],
        function(err) {
            if (err) return res.status(500).json({ success: false, message: "Update failed" });
            res.json({ success: true });
        }
    );
});

app.post('/api/user/update-email', authenticate, (req, res) => {
    const { email } = req.body;
    db.run(
        `UPDATE users SET email = ? WHERE phone = ?`,
        [email, req.user.phone],
        function(err) {
            if (err) return res.status(500).json({ success: false, message: "Email update failed" });
            res.json({ success: true });
        }
    );
});

// Admin: receive market submissions from upgraded users
app.post('/api/user/submit-market', authenticate, async (req, res) => {
    const { title, category, sideA, sideB, startTime, description, media_url, media_type } = req.body;
    try {
        const user = await dbGet(`SELECT is_upgraded, role, phone FROM users WHERE phone = ?`, [req.user.phone]);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        if (!(user.is_upgraded === 1 || user.role === 'admin')) {
            return res.status(403).json({ success: false, message: 'Not authorized to create markets' });
        }

        const id = `user_${Date.now()}`;
        const isAutoOpen = (user.role === 'admin');
        const status = isAutoOpen ? 'open' : 'pending';

        // Populate both description and content for compatibility
        await dbRun(`INSERT INTO markets (id, title, description, content, category, sideA, sideB, startTime, status, creator, media_url, media_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, title, description || '', description || '', category || 'misc', sideA || 'YES', sideB || 'NO', startTime || new Date().toISOString(), status, req.user.phone, media_url || null, media_type || 'auto']);

        if (isAutoOpen) {
            // Immediately broadcast markets so upgraded users' markets are visible
            emitMarkets();

            // Send confirmation email to creator if email exists
            try {
                const creator = await dbGet(`SELECT email, name FROM users WHERE phone=?`, [req.user.phone]);
                if (creator && creator.email) {
                    const subject = `🚀 Your Market is LIVE: ${title}`;
                    const html = `<div style="font-family:sans-serif;padding:20px;color:#333;"><h2>Hi ${creator.name || ''},</h2><p>Your market "${title}" is now live on PolySoko. Good luck!</p></div>`;
                    sendPolyMail(creator.email, subject, html);
                }
            } catch (e) { console.warn('Email send failed for auto-open market', e.message); }

            res.json({ success: true, message: 'Market created and is live' });
        } else {
            // Notify admin room for review
            emitAdminEvent('newMarketPending', { id, title, creator: req.user.phone });
            res.json({ success: true, message: 'Market submitted for review' });
        }
    } catch (e) {
        console.error('Create market error:', e);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Superadmin: Direct market creation (bypass pending status)
app.post('/api/admin/create-market', authenticateAdmin, async (req, res) => {
    const { title, category, sideA, sideB, startTime, description, media_url, media_type } = req.body;
    try {
        const id = `m_${Date.now()}`;
        await dbRun(
            `INSERT INTO markets (id, title, description, content, category, sideA, sideB, startTime, status, media_url, media_type, creator) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
            [
                id, 
                title, 
                description || '', 
                description || '',
                category || 'misc', 
                sideA || 'YES', 
                sideB || 'NO', 
                startTime || new Date().toISOString(),
                media_url || null,
                media_type || 'auto',
                req.user.phone
            ]
        );
        emitMarkets();
        res.json({ success: true, message: 'Market created successfully' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// User: submit crypto deposit proof for manual verification
app.post('/api/user/deposit-crypto', authenticate, async (req, res) => {
    const { amount, txhash } = req.body;
    try {
        if (!amount || !txhash) return res.status(400).json({ success: false, message: 'Missing amount or txhash' });
        await dbRun(`INSERT INTO transactions (user_phone, type, amount, reference, status) VALUES (?, 'crypto', ?, ?, 'pending')`, [req.user.phone, amount, txhash]);
        emitAdminEvent('cryptoDepositPending', { user: req.user.phone, amount, txhash });
        res.json({ success: true });
    } catch (e) {
        console.error('Deposit crypto error:', e);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get('/api/payment-config', authenticate, (req, res) => {
    res.json({
        success: true,
        adminWallet: getAdminWalletAddress(),
        adminTill: ADMIN_TILL
    });
});

// Upgrade account to Elite package
app.post('/api/user/upgrade', authenticate, async (req, res) => {
    const FEE = 1500; // sKES
    try {
        const user = await dbGet(`SELECT balance, is_upgraded FROM users WHERE phone = ?`, [req.user.phone]);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        if (user.is_upgraded === 1) {
            return res.json({ success: false, message: 'Account already upgraded' });
        }

        const balance = parseFloat(user.balance || 0);
        if (balance < FEE) {
            return res.json({ success: false, message: 'Insufficient balance for upgrade' });
        }

        const newBalance = (balance - FEE).toFixed(2);
        const expiry = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days

        await dbRun(`UPDATE users SET balance = ?, is_upgraded = 1, upgrade_expiry = ? WHERE phone = ?`, [newBalance, expiry, req.user.phone]);
        await dbRun(`INSERT INTO transactions (user_phone, type, amount, reference, status) VALUES (?, 'upgrade', ?, ?, 'completed')`, [req.user.phone, FEE, `UPGRADE_${Date.now()}`]);

        // Notify realtime balance update
        if (typeof emitBalance === 'function') emitBalance(req.user.phone);

        res.json({ success: true, message: 'Upgrade successful' });
    } catch (e) {
        console.error('Upgrade error:', e);
        res.status(500).json({ success: false, message: 'Server error during upgrade' });
    }
});

app.get('/api/user/history', authenticate, (req, res) => {
    const userPhone = normalizePhone(req.user.phone);

    const query = `
        -- Query for user transaction history
        SELECT id, type, amount, status, reference, mpesa_receipt, internal_id, timestamp, timestamp AS created_at 
        FROM transactions 
        WHERE user_phone = ? 
        AND type IN ('stk_request', 'withdraw', 'deposit', 'referral_bonus', 'crypto')
        ORDER BY id DESC
    `;

    db.all(query, [userPhone], (err, rows) => {
        if (err) {
            console.error("❌ SQL Error:", err.message);
            return res.status(500).json({ success: false, message: "Database query failed" });
        }
        console.log(`🔍 /api/user/history for ${userPhone}: Found ${rows?.length || 0} transactions.`);
        // Uncomment the line below for very detailed debugging of the raw data from the DB
        // console.log("Transaction rows from DB:", rows); 
        res.json({ success: true, history: rows || [] });
    });
});
app.get('/api/markets', (req, res) => {
    db.all(
        `SELECT * FROM markets 
         WHERE status IN ('open', 'upcoming', 'live')
         ORDER BY category ASC, startTime ASC, title ASC`,
        [],
        (err, rows) => {
        if (err) return res.status(500).json({ success: false });

        res.json({ success: true, markets: rows || [] });
    });
});
app.get('/api/user/context', async (req, res) => {
    const fallbackTowns = {
        mombasa: { city: "Mombasa", country: "Kenya", lat: -4.0435, lon: 39.6682 },
        nairobi: { city: "Nairobi", country: "Kenya", lat: -1.2864, lon: 36.8172 },
        kisumu: { city: "Kisumu", country: "Kenya", lat: -0.0917, lon: 34.7680 },
        nakuru: { city: "Nakuru", country: "Kenya", lat: -0.3031, lon: 36.0800 },
        eldoret: { city: "Eldoret", country: "Kenya", lat: 0.5143, lon: 35.2698 }
    };
    const weatherCodeText = (code) => {
        const map = {
            0: "Clear", 1: "Mainly clear", 2: "Partly cloudy", 3: "Cloudy",
            45: "Fog", 48: "Fog", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
            61: "Light rain", 63: "Rain", 65: "Heavy rain", 80: "Rain showers",
            81: "Rain showers", 82: "Heavy rain showers", 95: "Thunderstorm"
        };
        return map[Number(code)] || "Current weather";
    };

    try {
        const { lat, lon } = req.query;
        let city = "";
        let country = "";
        let weatherQuery = "";
        let fallbackCoords = fallbackTowns.mombasa;

        if (lat && lon) {
            weatherQuery = `${lat},${lon}`;
            fallbackCoords = { city: "Mombasa", country: "Kenya", lat: Number(lat), lon: Number(lon) };
        } else {
            const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || "").split(",")[0].trim();
            const publicIp = ip === "::1" || ip === "127.0.0.1" ? "" : ip;
            const geo = await axios.get(`http://ip-api.com/json/${publicIp || ""}`);
            city = geo.data.city || "";
            country = geo.data.country || "";
            weatherQuery = city || "Mombasa";
            fallbackCoords = fallbackTowns[String(city).toLowerCase()] || fallbackTowns.mombasa;
        }

        let temp;
        let condition;
        try {
            const weather = await axios.get(
                `http://api.weatherapi.com/v1/current.json`,
                {
                    params: {
                        key: process.env.WEATHER_API_KEY,
                        q: weatherQuery
                    }
                }
            );

            temp = weather.data.current.temp_c;
            condition = weather.data.current.condition.text;
            city = weather.data.location?.name || city || fallbackCoords.city;
            country = weather.data.location?.country || country || fallbackCoords.country;
        } catch (weatherErr) {
            const meteo = await axios.get('https://api.open-meteo.com/v1/forecast', {
                params: {
                    latitude: fallbackCoords.lat,
                    longitude: fallbackCoords.lon,
                    current_weather: true,
                    timezone: 'Africa/Nairobi'
                }
            });
            temp = meteo.data?.current_weather?.temperature ?? "--";
            condition = weatherCodeText(meteo.data?.current_weather?.weathercode);
            city = city || fallbackCoords.city;
            country = country || fallbackCoords.country;
        }

        res.json({
            success: true,
            city,
            country,
            temp,
            condition
        });

    } catch (e) {
        console.error("Context error:", e.message);

        res.json({
            success: true,
            city: "Mombasa",
            country: "Kenya",
            temp: "--",
            condition: "Unavailable"
        });
    }
});
app.post('/api/forgot-password', (req, res) => {
    const { phone } = req.body;
    const norm = normalizePhone(phone);
    db.get(`SELECT email, name FROM users WHERE phone=?`, [norm], (err, user) => {
        if (!user) return res.json({ success: false, message: "Not registered" });
        const token = crypto.randomBytes(32).toString('hex');
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expires = Date.now() + 1200000;
        db.run(`INSERT INTO password_resets (phone, token, otp, expires) VALUES (?, ?, ?, ?)`, [norm, token, otp, expires], () => {
            const resetLink = `${process.env.BASE_URL}/reset.password.html?token=${token}&otp=${otp}`;
            sendPolyMail(user.email, "PolySoko Password Reset", 
                `<p>Click the link below to reset your password. The verification code has been attached for your convenience.</p>
                 <a href="${resetLink}">Reset Password</a>`);
            
            sms.send({
                to: [formatPhone(norm)],
                message: `PolySoko: Your password reset code is ${otp}. Soko ni Soko.`,
                from: "POLYSOKO"
            }).catch(e => console.warn("SMS bypassed or failed. OTP sent via Email."));

            res.json({ success: true, message: "Check your email for the reset link." });
        });
    });
});

app.post('/api/change-password', authenticate, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    db.get(`SELECT email, password FROM users WHERE phone=?`, [req.user.phone], async (err, user) => {
        if (!user || !(await bcrypt.compare(currentPassword, user.password))) return res.json({ success: false });
        const hashed = await bcrypt.hash(newPassword, 10);
        db.run(`UPDATE users SET password=? WHERE phone=?`, [hashed, req.user.phone], () => {
            sendPolyMail(user.email, "Security Alert", "Password changed.");
            res.json({ success: true });
        });
    });
});
app.post('/api/place-bet', authenticate, async (req, res) => {
    const { marketId, side, amount } = req.body;
    const stake = parseFloat(amount);

    if (!marketId) return res.status(400).json({ success: false, message: "Missing Market ID" });
    if (isNaN(stake) || stake <= 0) return res.status(400).json({ success: false, message: "Invalid amount" });

    const normalizedSide = side?.toUpperCase();
    let col = '';
    if (['HOME', 'YES'].includes(normalizedSide)) col = 'home_volume';
    if (['AWAY', 'NO'].includes(normalizedSide)) col = 'away_volume';
    if (!col) return res.status(400).json({ success: false, message: "Invalid side" });

    const reference = "BET_" + Date.now();

    try {
        const market = await dbGet(`SELECT * FROM markets WHERE id=?`, [marketId]);
        if (!market) return res.status(404).json({ success: false, message: "Market not found" });

        const bettableStatuses = ['open', 'upcoming'];
        if (!market.status || !bettableStatuses.includes(market.status.toLowerCase())) {
            return res.status(400).json({ success: false, message: "This market is closed." });
        }

        const baseOdds = ["HOME", "YES"].includes(normalizedSide) ? market.oddsA : market.oddsB;
        const user = await dbGet(`SELECT is_upgraded, upgrade_expiry FROM users WHERE phone = ?`, [req.user.phone]);
        
        const isElite = user && Number(user.is_upgraded) === 1 && new Date(user.upgrade_expiry || 0) > new Date();
        const isBoostedMarket = Number(market.is_boosted || 0) === 1;
        const boostedOdds = isElite && isBoostedMarket ? Number((baseOdds * 1.10).toFixed(2)) : baseOdds;
        const isBoostedBet = isElite && isBoostedMarket ? 1 : 0;

        // Using a transaction for atomicity
        await dbRun("BEGIN TRANSACTION");

        // Deduct balance
        const deduction = await dbRun(`
            UPDATE users SET balance = balance - ? 
            WHERE phone = ? AND balance >= ?
        `, [stake, req.user.phone, stake]);

        if (deduction.changes === 0) {
            await dbRun("ROLLBACK");
            return res.status(400).json({ success: false, message: "Insufficient balance" });
        }

        // Update market volume
        await dbRun(`UPDATE markets SET ${col} = ${col} + ? WHERE id=?`, [stake, marketId]);

        // Insert transaction log
        await dbRun(`
            INSERT INTO transactions (user_phone, market_id, amount, type, side, status, odds, reference, is_boosted) 
            VALUES (?, ?, ?, 'bet', ?, 'active', ?, ?, ?)
        `, [req.user.phone, marketId, stake, side, boostedOdds, reference, isBoostedBet]);

        // Insert actual bet record
        const betInsert = await dbRun(`
            INSERT INTO bets (user_phone, market_id, event, picked, amount, odds, status, category, commence_time, is_boosted)
            VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
        `, [req.user.phone, marketId, market.title, side, stake, boostedOdds, market.category || 'general', market.startTime || null, isBoostedBet]);

        const betId = betInsert.lastID;
        const betRow = await dbGet(`SELECT * FROM bets WHERE id=?`, [betId]);

        await dbRun("COMMIT");

        // Run background tasks after commit
        recalculateOdds(marketId).catch(e => console.error("Odds error:", e.message));
        emitMarkets();
        emitBalance(req.user.phone);
        io.to(req.user.phone).emit('betPlaced', betRow);

        return res.json({
            success: true,
            message: "Bet placed successfully!",
            bet: betRow
        });

    } catch (e) {
        console.error("❌ Place Bet Error:", e.message);
        try { await dbRun("ROLLBACK"); } catch (rollbackErr) { /* ignore */ }
        return res.status(500).json({ success: false, message: "Internal server error" });
    }
});

async function triggerMpesaB2C(phone, amount) {
    // Validation: B2C payouts only support individual phone numbers (10-13 digits)
    const cleanPhone = phone.toString().replace(/\D/g, '');
    if (cleanPhone.length < 10 || cleanPhone.length > 13) {
        throw new Error(`Invalid recipient: ${phone}. M-Pesa B2C service only supports individual phone numbers, not Till numbers.`);
    }

    const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
    
    // 1. Get Token
    const tokenRes = await axios.get('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
        headers: { Authorization: `Basic ${auth}` }
    });
    
    // 2. The Payout Payload
    const payload = {
        "InitiatorName": "testapi",
        "SecurityCredential": "I+H4y6mKg0Ug3PHudwV6K4fVmj4CPFF7rZK8iQOyOaOCmmK1CZV1pWr7wkywroptq98QjNKjpyHamleadcpDkUBR8d441G3I7zJifJCj7CAc2TY0KNtDpXX4tjm0zCyW1hhDVd493jgOlMcMcMa/plM3yhAIcFpQ7XMgNnaPpnMycDd4VY6yRA/X1edylLD5/mS+MMPuC/9o3keqbvfQRXXggk+GCsY7vO5u7vphe2IQekn2TTAaBDs89H7H8cP74Dh4tIHsoIgDiM9z771lZxKqBs2LgfkeqcEnE7Gb9gzCrseAZrx2fqoE5+otYwFKaRBsFr8SxAsQ18drxrRgCw==",
        "CommandID": "BusinessPayment", // Correct for withdrawals
        "Amount": Math.round(amount),
        "PartyA": "600989", // This is the Sandbox B2C Shortcode
        "PartyB": phone,    // The user's phone number
        "Remarks": "Withdrawal",
        "QueueTimeOutURL": `${process.env.BASE_URL}/api/mpesa/timeout`,
        "ResultURL": `${process.env.BASE_URL}/api/mpesa/result`,
        "Occassion": "Withdrawal"
    };

    // 3. Send to Safaricom
    const response = await axios.post(
        'https://sandbox.safaricom.co.ke/mpesa/b2c/v1/paymentrequest', 
        payload, 
        { headers: { Authorization: `Bearer ${tokenRes.data.access_token}` } }
    );

    return response.data;
}

app.post('/api/withdraw', authenticate, async (req, res) => {
    const withdrawAmt = Number(req.body.amount);
    const userPhone = req.user.phone;

    if (isNaN(withdrawAmt) || withdrawAmt <= 0) {
        return res.status(400).json({ success: false, message: "Invalid withdrawal amount." });
    }

    try {
        const user = await dbGet(`SELECT balance FROM users WHERE phone = ?`, [userPhone]);
        if (!user) return res.status(404).json({ success: false, message: "User not found." });

        const currentBalance = Number(user.balance);
        if (currentBalance < withdrawAmt) return res.json({ success: false, message: "Insufficient balance." });

        // Start transaction manually using serialize + run
        await dbRun("BEGIN TRANSACTION");

        const updateRes = await dbRun(`UPDATE users SET balance = balance - ? WHERE phone = ? AND balance >= ?`, [withdrawAmt, userPhone, withdrawAmt]);
        if (!updateRes || updateRes.changes === 0) {
            await dbRun("ROLLBACK");
            return res.status(400).json({ success: false, message: "Balance update failed." });
        }

        const reference = "WD_" + Date.now();
        await dbRun(`INSERT INTO transactions (user_phone, type, amount, status, reference) VALUES (?, 'withdraw', ?, 'pending', ?)`, [userPhone, -withdrawAmt, reference]);

        await dbRun("COMMIT");

        emitBalance(userPhone);
        try {
            await sendPolyMail(process.env.ADMIN_EMAIL, "💰 Withdrawal Request", `User ${userPhone} requested withdrawal of sKES ${withdrawAmt}`);
        } catch (e) { /* ignore mail errors */ }

        return res.json({ success: true, message: "Withdrawal request received and is pending approval." });
    } catch (e) {
        console.error('Withdraw error:', e);
        try { await dbRun("ROLLBACK"); } catch (_) {}
        return res.status(500).json({ success: false });
    }
});

app.post('/api/mpesa/result', async (req, res) => {
    const Result = req.body.Result || {};
    const { ResultCode, ResultDesc, ConversationID, TransactionID } = Result;

    try {
        const tx = await dbGet(`SELECT id, user_phone, amount, status FROM transactions WHERE reference = ?`, [ConversationID]);
        if (!tx) return res.status(200).send('OK');

        if (ResultCode === 0) {
            // SUCCESS
            await dbRun(`UPDATE transactions SET status = 'completed', reference = ? WHERE id = ?`, [TransactionID, tx.id]);
            console.log(`✅ Transaction ${TransactionID} marked as completed.`);
        } else {
            // FAILED
            if (tx.status !== 'failed' && tx.status !== 'completed') {
                await dbRun(`UPDATE transactions SET status = 'failed' WHERE id = ?`, [tx.id]);
                const refund = Math.abs(tx.amount || 0);
                await dbRun(`UPDATE users SET balance = balance + ? WHERE phone = ?`, [refund, tx.user_phone]);
                emitBalance(tx.user_phone);
                console.log(`❌ Transaction ${ConversationID} failed: ${ResultDesc}. Refunded sKES ${refund} to ${tx.user_phone}`);
            }
        }
    } catch (e) {
        console.error('Error handling M-Pesa result:', e);
    }

    res.status(200).send('OK');
});
app.post('/api/stkpush', authenticate, async (req,res)=>{
    const { amount } = req.body;
    try {
        const tokenRes = await axios.get(`https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials`,
            { auth:{ username: process.env.MPESA_CONSUMER_KEY, password: process.env.MPESA_CONSUMER_SECRET } });
        const accessToken = tokenRes.data.access_token;
        const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0,14);
        const password = Buffer.from(`${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`).toString('base64');
        const formattedPhone = normalizePhone(req.user.phone);

        const stkRes = await axios.post('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest', {
    BusinessShortCode: process.env.MPESA_SHORTCODE, 
    Password: password, 
    Timestamp: timestamp, 
    TransactionType: 'CustomerPayBillOnline', 
    Amount: amount, 
    PartyA: formattedPhone, 
    PartyB: process.env.MPESA_SHORTCODE, // Must match BusinessShortCode
    PhoneNumber: formattedPhone, 
    CallBackURL: process.env.CALLBACK_URL, 
    AccountReference: 'PolySoko', 
    TransactionDesc: 'Deposit'
}, { headers:{ Authorization: `Bearer ${accessToken}` } });
        
        db.run(`INSERT INTO transactions (user_phone, type, amount, reference, status) VALUES (?, 'stk_request', ?, ?, 'pending')`,
            [req.user.phone, amount, stkRes.data.CheckoutRequestID]);
        res.json({ success:true });
   } catch(err) {
    console.error("M-Pesa STK Push Error:", err.response ? err.response.data : err.message);
    res.status(500).json({ 
        success: false, 
        error: err.response ? err.response.data.errorMessage : "Server Error" 
    });
   }
});

app.post('/api/stkcallback', (req, res) => {
    console.log("Full Callback Data:", JSON.stringify(req.body, null, 2));
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });

    const stk = req.body.Body?.stkCallback;
    if (!stk) return;

    if (stk.ResultCode !== 0) {
        db.run(`UPDATE transactions SET status = 'failed' WHERE reference = ? AND status = 'pending'`, 
            [stk.CheckoutRequestID]);
        console.log(`❌ STK Push failed for ${stk.CheckoutRequestID}: ${stk.ResultDesc}`);
        emitAdminEvent('mpesaLogUpdate', { reference: stk.CheckoutRequestID, status: 'failed' });
        return;
    }

    const metadata = stk.CallbackMetadata.Item;
    const amount = Number(metadata.find(i => i.Name === 'Amount')?.Value);
    const mpesaId = metadata.find(i => i.Name === 'MpesaReceiptNumber')?.Value;
    const checkoutID = stk.CheckoutRequestID;

    // --- FIX: GENERATE THE ID HERE ---
    const internalTxnId = "PS-" + Math.random().toString(36).substr(2, 7).toUpperCase();

    db.get(`SELECT user_phone, status FROM transactions WHERE reference = ?`, [checkoutID], (err, tx) => {
        // Handle error and check if transaction exists
        if (err) {
            console.error("DB Get Error:", err);
            return;
        }

        if (tx && tx.status === 'pending') {
            db.serialize(() => {
                // 1. Update User Balance
                db.run(`UPDATE users SET balance = balance + ? WHERE phone = ?`, [amount, tx.user_phone]);
                
                // 2. Update Transaction Status with M-Pesa and Internal IDs
                db.run(
                    `UPDATE transactions SET status = 'completed', mpesa_receipt = ?, internal_id = ? WHERE reference = ?`, 
                    [mpesaId, internalTxnId, checkoutID], 
                    (err) => {
                        if (!err) {
                            console.log(`✅ Deposit Success: KES ${amount} for ${tx.user_phone}`);
                            
                            // 3. Send Notification
                            sendPolysokoPush(tx.user_phone, amount, mpesaId, internalTxnId);
                            
                            // 4. Update UI balance via Socket
                            emitBalance(tx.user_phone);

                            // 5. Notify Admins
                            emitAdminEvent('mpesaLogUpdate', { 
                                phone: tx.user_phone, 
                                amount, 
                                status: 'completed', 
                                reference: checkoutID 
                            });
                        } else {
                            console.error("SQL Update Error:", err);
                        }
                    }
                );
            });
        }
    });
});

app.get('/api/user/sync-wallet', authenticate, async (req, res) => {
    try {
        const user = await dbGet("SELECT wallet_address, id FROM users WHERE phone = ?", [req.user.phone]);    
        if (!user?.wallet_address) return res.status(400).json({ message: "Link wallet first" });
        const balance = await getSokoBalance(user.wallet_address);
        await dbRun("UPDATE users SET crypto_balance = ? WHERE id = ?", [balance, user.id]);
        res.json({ success: true, balance });
    } catch (e) { res.status(500).json({ success: false }); }
});
app.get('/api/transactions', authenticate, (req, res) => {
    db.all(
        `SELECT * FROM transactions WHERE user_phone = ? ORDER BY timestamp DESC`,
        [req.user.phone],
        (err, rows) => {
            if (err) return res.json({ success: false });
            res.json({ success: true, transactions: rows });
        }
    );
});
app.get('/api/my-bets', authenticate, (req, res) => {
    const phone = req.user.phone;
    const status = req.query.status; // active | won | lost | cancelled | all

    // Use the actual 'bets' table which has the event info
    let sql = `
        SELECT 
            id,
            market_id,
            event,
            picked,
            amount,
            odds,
            status,
            category,
            commence_time
        FROM bets 
        WHERE user_phone = ?
    `;

    const params = [phone];

    // Filter by status if the user clicked a specific tab (Active, Won, etc.)
    if (status && status !== 'all') {
        sql += ` AND status = ?`;
        params.push(status);
    }

    sql += ` ORDER BY id DESC`;

    db.all(sql, params, (err, rows) => {
        if (err) {
            console.error("DATABASE ERROR:", err);
            return res.status(500).json({ success: false, message: "Internal server error" });
        }

        // Send the response back to your switchBetTab function
        res.json({
            success: true,
            bets: rows
        });
    });
});
// --- ADMIN ROUTES ---
app.post('/api/admin/update-market', authenticateAdmin, (req, res) => {
    const { id, title, content, media_url, media_type } = req.body;
    
    db.run(`
        UPDATE markets 
        SET title = ?, content = ?, media_url = ?, media_type = ? 
        WHERE id = ?
    `, [title, content, media_url || null, media_type || 'auto', id], function(err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        
        if (typeof emitMarkets === "function") emitMarkets(); 
        
        res.json({ success: true });
    });
});

app.post('/api/admin/rephrase-market', authenticateAdmin, async (req, res) => {
    const { title, content, engine = 'gpt' } = req.body;
    if (!title && !content) {
        return res.status(400).json({ success: false, message: 'Provide title or description text to rephrase.' });
    }

    const originalText = `TITLE: ${title || ''}\nDESCRIPTION: ${content || ''}`;
    const prompt = `Rewrite the following betting market title and description into a sharper, clearer, more compelling market listing for a superadmin-reviewed marketplace. Keep the meaning exactly, preserve the category intent, and output only valid JSON with keys \"title\" and \"description\".`;

    const messages = [
        { role: 'system', content: 'You are an expert market editor for a sports and news betting platform.' },
        { role: 'user', content: `${prompt}\n\n${originalText}` }
    ];

    try {
        // Use helper that handles retries and provider fallback
        const aiResp = await callAI({ engine, messages, promptText: `${prompt}\n\n${originalText}` });
        let responseText = aiResp?.text;
        let usedEngine = aiResp?.engine || 'none';

        if (!responseText) {
            return res.json({ success: true, engine: usedEngine, rephrased: { title: title || '', description: content || '' } });
        }

        let parsed = null;
        try {
            parsed = JSON.parse(responseText.replace(/^[^\{]*\{/, '{').trim());
        } catch (jsonErr) {
            const titleMatch = responseText.match(/"title"\s*:\s*"([^"]+)"/i);
            const descMatch = responseText.match(/"description"\s*:\s*"([^"]+)"/i);
            parsed = {
                title: titleMatch ? titleMatch[1] : title,
                description: descMatch ? descMatch[1] : content
            };
        }

        res.json({ success: true, engine: usedEngine, rephrased: parsed });
    } catch (err) {
        console.error('Rephrase service failed:', err.message || err);
        res.status(500).json({ success: false, message: 'AI rephrase failed. Check API key or try again.' });
    }
});

// Simple AI chat endpoint for assistant UI
app.post('/api/ai/chat', async (req, res) => {
    const { message, engine = 'gpt' } = req.body;
    if (!message) return res.status(400).json({ success: false, message: 'Missing message' });

    const systemPrompt = personaRaw || 'You are a helpful assistant.';
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
    ];

    try {
        const aiResp = await callAI({ engine, messages, promptText: message });
        if (!aiResp || !aiResp.text) return res.status(500).json({ success: false, message: 'AI returned no response' });
        return res.json({ success: true, engine: aiResp.engine, reply: aiResp.text });
    } catch (err) {
        console.error('AI chat failed:', err.message || err);
        return res.status(500).json({ success: false, message: 'AI chat failed' });
    }
});

app.get('/api/admin/mpesa-log', authenticateAdmin, (req, res) => {
    db.all(`SELECT * FROM transactions ORDER BY timestamp DESC LIMIT 200`, (err, rows) => {
        if (err) return res.status(500).json({ success: false });
        res.json({ success: true, logs: rows });
    });
});

app.get('/api/admin/all-markets', authenticateAdmin, (req, res) => {
    db.all("SELECT * FROM markets ORDER BY timestamp DESC", (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: "Database error" });
        res.json({ success: true, markets: rows || [] });
    });
});
app.get('/api/admin/all-active-bets', authenticateAdmin, async (req, res) => {
    try {
       const bets = await dbAll(`
            SELECT 
                b.id,
                b.user_phone,
                u.name AS userName,
                b.event AS marketTitle,
                b.market_id,
                b.amount,
                b.picked AS side,
                b.odds,
                b.status,
                b.created_at as timestamp
            FROM bets b
            LEFT JOIN users u ON b.user_phone = u.phone
            ORDER BY b.created_at DESC
`);

        res.json({ success: true, bets });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false });
    }
});
app.post('/api/admin/delete-market', authenticateAdmin, async (req, res) => {
    const { id } = req.body;
    db.run(`DELETE FROM markets WHERE id = ?`, [id], function(err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true });
    });
});

app.post('/api/admin/wire-funds', authenticateAdmin, async (req, res) => {
    const { amount, type } = req.body;
    const adminPhone = normalizePhone(process.env.ADMIN_PHONE) || 'SYSTEM';
    try {
        if (!amount || Number(amount) <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid amount provided.' });
        }

        const wireAmount = Number(amount);
        const reference = `WIRE_${type?.toUpperCase() || 'UNKNOWN'}_${Date.now()}`;

        if (type === 'till') {
            // FIX: Automated B2C to Shortcode (4440728) is not supported by Safaricom.
            // This action now records the settlement for audit logs.
            await dbRun(
                `INSERT INTO transactions (user_phone, type, amount, status, reference) VALUES (?, ?, ?, 'completed', ?)`,
                [adminPhone, 'admin_wire', -wireAmount, reference]
            );
             console.log(`💰 [WIRE TO TILL] sKES ${wireAmount} by admin ${adminPhone}. Ref: ${reference}`);
            console.log(`⚠️ [MANUAL SETTLEMENT REQUIRED] Logged sKES ${wireAmount} wire to Till 4440728 by admin ${adminPhone}. Ref: ${reference}`);
            return res.json({ success: true, message: 'Wire to Till recorded. Please perform the manual transfer via your Merchant Portal.', reference });
        }

        if (type === 'metamask') {
            const recipientAddress = process.env.META_MASK_ADDRESS || getAdminWalletAddress();
            if (!recipientAddress || !isValidAddress(recipientAddress)) {
                throw new Error('MetaMask wallet address is not configured or invalid.');
            }
            const transferResult = await sendSoko(recipientAddress, wireAmount);
            if (!transferResult.success) {
                throw new Error(transferResult.error || 'MetaMask transfer failed');
            }
            await dbRun(
                `INSERT INTO transactions (user_phone, type, amount, status, reference) VALUES (?, ?, ?, 'completed', ?)`,
                [adminPhone, 'admin_wire', -wireAmount, `${reference}_${transferResult.hash || 'NOHASH'}`]
            );
            return res.json({ success: true, message: 'Wired to MetaMask successfully.', txHash: transferResult.hash });
        }

        throw new Error('Unknown wire type');
    } catch (e) {
        console.error('Admin wire funds failed:', e);
        res.status(500).json({ success: false, message: e.message || 'Wire failed' });
    }
});

app.post('/api/admin/approve-withdraw-fast', authenticateAdmin, async (req, res) => {
    const { txId } = req.body;

    try {
        const tx = await dbGet(`SELECT * FROM transactions WHERE id=?`, [txId]);
        if (!tx || tx.status !== 'pending') {
            return res.status(400).json({ success: false, message: "Invalid transaction" });
        }

        const amount = Math.abs(tx.amount);
        const userPhone = tx.user_phone;

        await dbRun(`UPDATE transactions SET status='processing' WHERE id=? AND status='pending'`, [txId]);
        res.json({ success: true, message: "Withdrawal approval started" });

        (async () => {
            try {
                const mpesaResponse = await triggerMpesaB2C(userPhone, amount);
                if (mpesaResponse.ResponseCode !== "0") {
                    throw new Error(mpesaResponse.ResponseDescription || "M-Pesa rejected payout");
                }

                await dbRun(
                    `UPDATE transactions SET status='completed', reference=? WHERE id=?`,
                    [mpesaResponse.ConversationID, txId]
                );

                sms.send({
                    to: [formatPhone(userPhone)],
                    message: `Your withdrawal of sKES ${amount} was approved and sent to M-Pesa.`,
                    from: "POLYSOKO"
                }).catch(e => console.log("SMS failed but payout succeeded.", e.message));
            } catch (err) {
                console.error("Async withdrawal approval failed:", err.message);
                await dbRun(`UPDATE transactions SET status='failed' WHERE id=?`, [txId]);
                await dbRun(`UPDATE users SET balance = balance + ? WHERE phone=?`, [amount, userPhone]);
                emitBalance(userPhone);
            }
        })();
    } catch (err) {
        console.error("Fast approval error:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});


// --- APPROVE WITHDRAWAL ---
app.post('/api/admin/approve-withdraw', authenticateAdmin, async (req, res) => {
    const { txId } = req.body;

    try {
        const tx = await dbGet(`SELECT * FROM transactions WHERE id=?`, [txId]);
        if (!tx || tx.status !== 'pending') {
            return res.status(400).json({ success: false, message: "Invalid transaction" });
        }

        const amount = Math.abs(tx.amount);
        const userPhone = tx.user_phone;

        // --- STEP 1: M-PESA PAYOUT ---
        // If this fails, it jumps to the catch block below
        const mpesaResponse = await triggerMpesaB2C(userPhone, amount);

        if (mpesaResponse.ResponseCode !== "0") {
            // Throwing an error here prevents the database from updating to 'completed'
            throw new Error(`M-Pesa Payout Failed: ${mpesaResponse.ResponseDescription}`);
        }

        // --- STEP 2: UPDATE DATABASE ---
        await dbRun(
            `UPDATE transactions SET status='completed', reference=? WHERE id=?`,
            [mpesaResponse.ConversationID, txId]
        );

        // --- STEP 3: SMS NOTIFICATION ---
        const victoryMsg = `Victory! 🏆 Your withdrawal of sKES ${amount} was approved and sent to M-Pesa.`;
        await sms.send({
            to: [formatPhone(userPhone)],
            message: victoryMsg,
            from: "POLYSOKO"
        }).catch(e => console.log("SMS failed but payout succeeded."));

        res.json({ success: true, message: "Withdrawal successful" });

  } catch (err) {
    // FORCE the terminal to show the error
    console.log("------------------------------------");
    console.error("❌ APPROVAL CRASHED AT:");
    console.error(err); 
    console.log("------------------------------------");

    const tx = await dbGet(`SELECT user_phone, amount, status FROM transactions WHERE id=?`, [txId]);
    if (tx && tx.status === 'pending') {
         await dbRun(`UPDATE transactions SET status='failed' WHERE id=?`, [txId]);
         const refund = Math.abs(tx.amount);
         await dbRun(`UPDATE users SET balance = balance + ? WHERE phone = ?`, [refund, tx.user_phone]);
         emitBalance(tx.user_phone);
         console.log(`💰 Automatic refund issued for failed withdrawal: sKES ${refund} to ${tx.user_phone}`);
    }
    
    return res.status(500).json({ 
        success: false, 
        message: "Server Error: " + err.message 
    });
}});

// --- REJECT WITHDRAWAL ---
app.post('/api/admin/reject-withdraw', authenticateAdmin, async (req, res) => {
    const { txId, reason } = req.body; // Added reason from admin input

    try {
        const tx = await dbGet(`SELECT * FROM transactions WHERE id=?`, [txId]);

        if (!tx || tx.status !== 'pending') {
            return res.json({ success: false, message: "Transaction not pending" });
        }

        const refund = Math.abs(tx.amount);
        const userPhone = tx.user_phone;
        const rejectReason = reason || "Inconsistent account details";

        // 1. Refund user balance
        await dbRun(`UPDATE users SET balance = balance + ? WHERE phone=?`, [refund, userPhone]);

        // 2. Mark transaction as failed
        await dbRun(`UPDATE transactions SET status='failed' WHERE id=?`, [txId]);

        // 3. SEND REJECTION SMS
        const rejectMsg = `Polysoko Update: Your withdrawal request of sKES ${refund} was declined. Reason: ${rejectReason}. Your funds have been reversed to your Polysoko wallet.`;
        sms.send({
            to: [formatPhone(userPhone)],
            message: rejectMsg,
            from: "POLYSOKO"
        }).catch(e => console.log("SMS fail:", e.message));

        emitBalance(userPhone);
        res.json({ success: true, message: "Withdrawal rejected and user notified" });

    } catch (err) {
        console.error("Reject Error:", err);
        res.status(500).json({ success: false });
    }
});

app.post('/api/admin/approve-market', authenticateAdmin, async (req, res) => {
    const { marketId } = req.body;
    try {
        const market = await dbGet(`SELECT * FROM markets WHERE id=? AND status='pending'`, [marketId]);
        if (!market) return res.status(404).json({ success: false, message: 'Market not found' });

        await dbRun(`UPDATE markets SET status='open' WHERE id=?`, [marketId]);

        // Send Email to Creator
        if (market.creator) {
            createNotification(market.creator, "🚀 Market Approved!", `Your market "${market.title}" is now LIVE.`, "success");
            
            const creator = await dbGet(`SELECT email, name FROM users WHERE phone=?`, [market.creator]);
            if (creator && creator.email) {
                const subject = `🚀 Your Market is LIVE: ${market.title}`;
                const html = `
                    <div style="font-family: sans-serif; padding: 20px; color: #333;">
                        <h2>Congratulations ${creator.name}!</h2>
                        <p>Your market submission has been reviewed and approved by PolySoko Admin.</p>
                        <div style="background: #f4f4f4; padding: 15px; border-radius: 8px; border-left: 4px solid #00ff88;">
                            <strong>Market:</strong> ${market.title}<br>
                            <strong>Initial Odds:</strong> ${market.oddsA} / ${market.oddsB}<br>
                            <strong>Category:</strong> ${market.category}
                        </div>
                        <p>Users can now start trading on your market. Soko ni Soko!</p>
                    </div>
                `;
                sendPolyMail(creator.email, subject, html);
            }
        }

        emitMarkets();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/admin/bulk-approve-elite-markets', authenticateAdmin, async (req, res) => {
    try {
        // 1. Find all pending markets created by upgraded users
        const pendingEliteMarkets = await dbAll(`
            SELECT m.id, m.title, m.creator, m.category, u.name as creator_name, u.email as creator_email
            FROM markets m
            JOIN users u ON m.creator = u.phone
            WHERE m.status = 'pending' AND u.is_upgraded = 1
        `);

        if (!pendingEliteMarkets || pendingEliteMarkets.length === 0) {
            return res.json({ success: true, message: "No pending Elite markets found.", count: 0 });
        }

        let approvedCount = 0;
        await dbRun("BEGIN TRANSACTION");

        for (const market of pendingEliteMarkets) {
            await dbRun(`UPDATE markets SET status='open' WHERE id=?`, [market.id]);
            approvedCount++;

            // Notify creator
            createNotification(market.creator, "🚀 Market Approved!", `Your market "${market.title}" is now LIVE.`, "success");
            if (market.creator_email) {
                const subject = `🚀 Your Market is LIVE: ${market.title}`;
                const html = `
                    <div style="font-family: sans-serif; padding: 20px; color: #333;">
                        <h2>Congratulations ${market.creator_name || ''}!</h2>
                        <p>Your market submission has been reviewed and approved by PolySoko Admin.</p>
                        <div style="background: #f4f4f4; padding: 15px; border-radius: 8px; border-left: 4px solid #00ff88;">
                            <strong>Market:</strong> ${market.title}<br>
                            <strong>Category:</strong> ${market.category}
                        </div>
                        <p>Users can now start trading on your market. Soko ni Soko!</p>
                    </div>
                `;
                sendPolyMail(market.creator_email, subject, html);
            }
        }

        await dbRun("COMMIT");
        emitMarkets(); // Update all clients with the new open markets

        res.json({ success: true, message: `${approvedCount} markets approved.`, count: approvedCount });

    } catch (e) {
        console.error("Bulk approve elite markets error:", e);
        await dbRun("ROLLBACK");
        res.status(500).json({ success: false, message: "Server error during bulk approval." });
    }
});

app.post('/api/admin/reject-market', authenticateAdmin, async (req, res) => {
    const { marketId } = req.body;
    try {
        await dbRun(`DELETE FROM markets WHERE id=? AND status='pending'`, [marketId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/admin/settle', authenticateAdmin, (req, res) => {
    const { marketId, result } = req.body;

    if (!marketId || !result) {
        return res.status(400).json({ success: false });
    }

    settleMarket(marketId, result.toUpperCase());

    res.json({ success: true });
});
app.post('/api/update-avatar', authenticate, upload.single('avatar'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });

    db.get(`SELECT avatar_url FROM users WHERE phone = ?`, [req.user.phone], (err, user) => {
        if (err) {
            console.error("Avatar lookup failed:", err.message);
            return res.status(500).json({ success: false, message: "Unable to update avatar" });
        }

        if (user && user.avatar_url && !user.avatar_url.includes('default.png')) {
            // Use absolute pathing for deletion
            const oldFileName = path.basename(user.avatar_url);
            const oldFilePath = path.join(uploadPath, oldFileName);
            if (oldFilePath.startsWith(publicPath)) {
                fs.rm(oldFilePath, { force: true, maxRetries: 2 }, (unlinkErr) => {
                    if (unlinkErr) {
                        console.warn("Warning: Could not remove old avatar:", unlinkErr.message);
                    }
                });
            }
        }

        const avatarUrl = `/uploads/avatars/${req.file.filename}`;
        db.run(
            `UPDATE users SET avatar_url = ? WHERE phone = ?`, 
            [avatarUrl, req.user.phone], 
            (err) => {
                if (err) {
                    console.error("Avatar update failed:", err.message);
                    return res.status(500).json({ success: false, message: "Database update failed" });
                }
                res.json({ success: true, avatarUrl, url: avatarUrl });
            }
        );
    });
});

app.get('/api/admin/stats', authenticate, async (req, res) => {
    try {
        const adminPhone = normalizePhone(process.env.ADMIN_PHONE);
        const userPhone = normalizePhone(req.user.phone);
        const isSuperAdmin = adminPhone && userPhone === adminPhone;

        if (!isSuperAdmin) {
            const user = await dbGet("SELECT is_upgraded, upgrade_expiry FROM users WHERE phone=?", [userPhone]);
            if (user?.is_upgraded === 1) {
                const expiry = new Date(user.upgrade_expiry);
                const days = Math.ceil((expiry - new Date()) / (1000 * 60 * 60 * 24));
                const boostedMarkets = await dbAll(`
                    SELECT id, title, category, oddsA, oddsB, status, home_volume, away_volume, is_boosted
                    FROM markets
                    WHERE is_boosted = 1 AND status IN ('open','upcoming','live')
                    ORDER BY startTime ASC
                    LIMIT 10
                `, []);
                return res.json({ success: true, isSuperAdmin: false, remainingDays: days > 0 ? days : 0, boostedMarkets: boostedMarkets || [] });
            }
            return res.status(403).json({ success: false, message: "Unauthorized" });
        }

        let statsData = { isSuperAdmin };

            const pendingWithdrawals = await dbGet(`SELECT COUNT(*) as c FROM transactions WHERE type='withdraw' AND status='pending'`);
            const usersCount = await dbGet(`SELECT COUNT(*) as c FROM users`);
            const bonuses = await dbGet(`SELECT SUM(amount) as c FROM transactions WHERE type='referral_bonus'`);
            const subs = await dbGet(`SELECT COUNT(*) as c FROM users WHERE is_upgraded=1`);
            
            const profitData = await dbGet(`
                SELECT (SUM(CASE WHEN type='bet' THEN amount ELSE 0 END) - SUM(CASE WHEN status='won' THEN settled_amount ELSE 0 END)) as p 
                FROM transactions 
                WHERE type='bet' AND status IN ('won','lost','active')
            `);

            const totalPlatformBalance = await dbGet(`SELECT SUM(balance + crypto_balance) as total FROM users`);
            const pendingMarkets = await dbAll(`
                SELECT m.*, u.name as creator_name 
                FROM markets m 
                LEFT JOIN users u ON m.creator = u.phone 
                WHERE m.status='pending'
            `);

            Object.assign(statsData, {
                pending: pendingWithdrawals.c,
                users: usersCount.c,
                bonuses: bonuses.c || 0,
                subscriptions: subs.c || 0,
                profit: profitData.p || 0,
                platformTotal: totalPlatformBalance.total || 0,
                adminWallet: getAdminWalletAddress(),
                adminTill: ADMIN_TILL,
                pendingMarkets: pendingMarkets || []
            });

        res.json({ success: true, ...statsData });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/admin/pending-markets', authenticateAdmin, async (req, res) => {
    try {
        const markets = await dbAll(`
            SELECT m.*, m.creator as creator_phone, u.name as creator_name 
            FROM markets m 
            LEFT JOIN users u ON m.creator = u.phone 
            WHERE m.status='pending'
        `);
        res.json({ success: true, markets });
    } catch (e) {
        console.error("❌ Error fetching pending markets:", e);
        res.status(500).json({ success: false, message: "Database error fetching markets" });
    }
});

app.get('/api/admin/users', authenticateAdmin, async (req, res) => {
    try {
        const users = await dbAll("SELECT name, phone, email, balance, is_upgraded, is_suspended FROM users ORDER BY name ASC");
        res.json({ success: true, users });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/admin/users/manage', authenticateAdmin, async (req, res) => {
    const { phone, action, reason, violation } = req.body;
    const norm = normalizePhone(phone);
    try {
        const user = await dbGet("SELECT name, email, is_suspended, balance, referral_code FROM users WHERE phone=?", [norm]);
        if (!user) return res.status(404).json({ success: false, message: "User not found" });

        const adminPhone = normalizePhone(process.env.ADMIN_PHONE);
        const effectiveReason = reason || (action === 'upgrade' ? 'Manual Admin Promotion' : 'No reason provided');
        let emailBody = "";
        let subject = "PolySoko Support Update";

        if (action === 'suspend') {
            const suspensionDaysMap = {
                scraping: 7,
                exploit: 7,
                reverse: 5,
                age: 2,
                multi: 4
            };
            const days = suspensionDaysMap[violation] || 3;
            const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
            await dbRun("UPDATE users SET is_suspended = 1, suspension_expires = ? WHERE phone = ?", [expiresAt.toISOString(), norm]);
            emailBody = `Your account has been suspended for ${days} day${days === 1 ? '' : 's'} due to policy violation. It will automatically become active again on ${expiresAt.toLocaleDateString()}.`;
            subject = "Account Suspended";
        } else if (action === 'unsuspend') {
            await dbRun("UPDATE users SET is_suspended = 0, suspension_expires = NULL WHERE phone = ?", [norm]);
            emailBody = `Your account has been restored to ACTIVE status.`;
            subject = "Account Restored";
        } else if (action === 'upgrade') {
            const expiry = new Date(Date.now() + (60 * 24 * 60 * 60 * 1000));
            await dbRun("UPDATE users SET is_upgraded = 1, upgrade_expiry = ? WHERE phone = ?", [expiry.toISOString(), norm]);
            subject = "🚀 Congratulations: You are now ELITE!";
            emailBody = `Your account has been upgraded to the Elite Package for 60 days! Enjoy 10% boosted odds, priority withdrawals, and exclusive admin access. <br><br><b>Your Invite Code:</b> ${user.referral_code}`;
        } else if (action === 'revoke') {
            await dbRun("UPDATE users SET is_upgraded = 0, upgrade_expiry = NULL WHERE phone = ?", [norm]);
            emailBody = `Your Elite affiliation has been revoked.`;
        } else if (action === 'delete') {
            if (user.balance > 0 && adminPhone && adminPhone !== norm) {
                await dbRun("UPDATE users SET balance = balance + ? WHERE phone = ?", [user.balance, adminPhone]);
                await dbRun(`INSERT INTO transactions (user_phone, type, amount, status, reference) VALUES (?, 'finance_recovery', ?, 'completed', ?)`, 
                    [adminPhone, user.balance, `RECOVERY_FROM_${norm}`]);
                emitBalance(adminPhone);
            }
            await dbRun("DELETE FROM users WHERE phone = ?", [norm]);
            await dbRun("DELETE FROM transactions WHERE user_phone = ?", [norm]);
            await dbRun("DELETE FROM bets WHERE user_phone = ?", [norm]);
            emailBody = `Your account has been permanently deleted from our records.`;
        }

        if (user.email) {
            const html = `
                <div style="font-family: sans-serif; padding: 20px; color: #333; border: 1px solid #da020e; border-radius: 12px; max-width: 500px; margin: auto;">
                    <h2 style="color: #da020e; border-bottom: 2px solid #da020e; padding-bottom: 10px;">PolySoko Update</h2>
                    <p>Hello <b>${user.name}</b>,</p>
                    <p>${emailBody}</p>
                    ${effectiveReason ? `<div style="background: #f9f9f9; padding: 15px; border-radius: 8px; border-left: 4px solid #da020e; margin: 20px 0;"><strong>Administrative Reason:</strong><br><span style="font-style: italic; color: #555;">${effectiveReason}</span></div>` : ''}
                    <p style="font-size: 0.8rem; color: #777; margin-top: 20px;">If you believe this was a mistake, please contact our support desk.</p>
                    <p><b>Soko ni Soko.</b></p>
                </div>`;
            await sendPolyMail(user.email, subject, html);
        }

        res.json({ success: true });
    } catch (e) { console.error('Admin users manage error:', e); res.status(500).json({ success: false }); }
});

app.get('/api/admin/users/:phone/details', authenticateAdmin, async (req, res) => {
    const norm = normalizePhone(req.params.phone);
    try {
        const user = await dbGet("SELECT name, phone, email, balance, is_upgraded, is_suspended, suspension_expires, upgrade_expiry, referral_code FROM users WHERE phone=?", [norm]);
        const activity = await dbGet(`
            SELECT 
                (SELECT COUNT(*) FROM bets WHERE user_phone=?) as totalBets,
                (SELECT SUM(amount) FROM transactions WHERE user_phone=? AND type='deposit' AND status='completed') as deposits,
                (SELECT SUM(ABS(amount)) FROM transactions WHERE user_phone=? AND type='withdraw' AND status='completed') as withdrawals
            `, [norm, norm, norm]);
        res.json({ success: true, user, stats: activity });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.get('/test-balance/:phone', (req, res) => {
    const phone = normalizePhone(req.params.phone);
    emitBalance(phone);
    res.send("Balance emit triggered");
});
// --- SOCKET AUTH MIDDLEWARE ---
io.use((socket, next) => {
    try {
        const token = socket.handshake.auth?.token;
        if (!token) return next(new Error("No token provided"));

        const decoded = jwt.verify(token, JWT_SECRET);
        socket.user = { phone: normalizePhone(decoded.phone) };
        next();
    } catch (err) {
        console.error("❌ Socket Auth Failed:", err.message);
        next(new Error("Auth Error"));
    }
});
io.on('connection', (socket) => {
    if (!socket.user?.phone) return socket.disconnect();

    const userRoom = socket.user.phone;
    socket.join(userRoom);

    socket.on("adminJoin", () => {
        socket.join("adminRoom");
    });

    socket.on('requestInitialData', () => {
        try {
            emitBalance(userRoom);
            emitMarkets();
        } catch (e) {
            console.error("Socket init error:", e.message);
        }
    });
});

// Backend: server.js
// server.js
app.get('/api/football/details/:id', async (req, res) => {
    try {
        const fixtureId = req.params.id.replace('fb_', '');
        const apiKey = process.env.FOOTBALL_API_KEY; 
        const config = { headers: { 'x-apisports-key': apiKey } };

        const [stats, lineups, events, predictions] = await Promise.all([
            axios.get(`https://v3.football.api-sports.io/fixtures/statistics?fixture=${fixtureId}`, config),
            axios.get(`https://v3.football.api-sports.io/fixtures/lineups?fixture=${fixtureId}`, config).catch(() => ({ data: { response: [] } })),
            axios.get(`https://v3.football.api-sports.io/fixtures/events?fixture=${fixtureId}`, config),
            axios.get(`https://v3.football.api-sports.io/predictions?fixture=${fixtureId}`, config)
        ]);

        const lineupsData = lineups.data.response || [];
        const teamA = lineupsData[0]?.team?.name || '';
        const teamB = lineupsData[1]?.team?.name || '';
        const query = createMatchNewsQuery(teamA, teamB);
        let relatedNews = [];

        if (process.env.NEWS_API_KEY && query) {
            try {
                const newsRes = await axios.get(`https://newsapi.org/v2/everything`, {
                    params: {
                        q: query,
                        language: 'en',
                        pageSize: 5,
                        sortBy: 'publishedAt',
                        apiKey: process.env.NEWS_API_KEY
                    }
                });
                relatedNews = (newsRes.data.articles || []).map((article) => ({
                    title: article.title,
                    description: article.description,
                    source: article.source?.name,
                    url: article.url,
                    image: article.urlToImage
                }));
            } catch (newsError) {
                console.warn('⚠️ Match news fetch failed:', newsError.response?.data || newsError.message);
            }
        }

        // Persist any related news from the football API into the markets table
        if (Array.isArray(relatedNews) && relatedNews.length) {
            for (const article of relatedNews) {
                try {
                    const rawHeadline = String(article.title || '').trim();
                    const hash = crypto.createHash('md5').update(rawHeadline + fixtureId).digest('hex');
                    const content = article.description || rawHeadline;

                    const newsMarket = buildNewsMarket({
                        id: `news_${hash}`,
                        title: rawHeadline,
                        description: content,
                        content,
                        media_url: article.image || null,
                        media_type: 'image',
                        category: 'news',
                        country: article.source || 'API-FOOTBALL',
                        startTime: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
                        status: 'open',
                        url: article.url || article.url || null
                    });

                    await dbRun(`INSERT INTO markets (id, title, description, content, media_url, media_type, category, country, sideA, sideB, startTime, status, url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'YES', 'NO', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description, content=excluded.content, media_url=excluded.media_url, media_type=excluded.media_type, startTime=excluded.startTime, status=excluded.status, url=excluded.url, timestamp=CURRENT_TIMESTAMP`,
                        [newsMarket.id, newsMarket.title, newsMarket.description, newsMarket.content, newsMarket.media_url, newsMarket.media_type, newsMarket.category, newsMarket.country, newsMarket.startTime, newsMarket.status, newsMarket.url]);
                } catch (e) {
                    console.warn('Failed to persist related match news:', e.message);
                }
            }
        }

        res.json({
            stats: stats.data.response || [],
            lineups: lineupsData,
            events: events.data.response || [],
            predictions: predictions.data.response || [],
            relatedNews
        });
    } catch (error) {
        console.error("❌ API-Football Error:", error.response?.data || error.message);
        res.status(error.response?.status || 500).json({ error: "Failed to fetch match details" });
    }
});
app.get('/api/news/everything', async (req, res) => {
    try {
        const cachedNews = await dbAll(`
            SELECT * FROM markets 
            WHERE category='news'
              AND status IN ('open','upcoming','live')
            ORDER BY timestamp DESC
            LIMIT 100
        `, []);

        if (cachedNews && cachedNews.length > 0) {
            return res.json({ articles: cachedNews });
        }

        const apiKey = process.env.NEWS_API_KEY;
        const countries = ['us', 'gb', 'au', 'ca', 'in', 'ke', 'za', 'ng', 'br', 'mx', 'de', 'fr', 'it', 'es'];
        const processedMarkets = [];

        try {
            // Fetch from multiple countries
            const countryRequests = countries.map(country =>
                axios.get(`https://newsapi.org/v2/top-headlines?country=${country}&pageSize=5&apiKey=${apiKey}`)
                    .catch(e => ({ data: { articles: [] } }))
            );
            const responses = await Promise.all(countryRequests);
            
            // Fetch general news across all languages
            const [generalNews, deepSearch] = await Promise.all([
                axios.get(`https://newsapi.org/v2/everything?language=en&sortBy=publishedAt&pageSize=50&apiKey=${apiKey}`),
                axios.get(`https://newsapi.org/v2/everything?q=news&language=en&sortBy=relevancy&pageSize=50&apiKey=${apiKey}`)
            ]);

            const combined = [
                ...responses.flatMap(r => r.data?.articles || []),
                ...(generalNews.data?.articles || []),
                ...(deepSearch.data?.articles || [])
            ];

            const seen = new Set();
            for (const article of combined) {
                const rawHeadline = String(article.title || '').trim();
                const hash = crypto.createHash('md5').update(rawHeadline + (article.source?.name || '')).digest('hex');
                
                if (seen.has(hash)) continue;
                seen.add(hash);
                
                const content = article.description || article.content || rawHeadline;
                
                // Detect if this is tech or geopolitical news
                const isTech = isTechNews(rawHeadline, content);
                const isGeopolitical = !isTech && isGeopoliticalNews(rawHeadline, content);
                const category = isTech ? 'tech' : isGeopolitical ? 'politics' : 'news';
                const sideA = isTech ? 'YES' : isGeopolitical ? 'LIKELY' : 'YES';
                const sideB = isTech ? 'NO' : isGeopolitical ? 'UNLIKELY' : 'NO';
                const expiry = isTech ? 24 : isGeopolitical ? 48 : 18; // Tech markets 24h, politics 48h, regular news 18h
                const prefix = isTech ? 'tech' : isGeopolitical ? 'geo' : 'news';
                
                const market = buildNewsMarket({
                    id: `${prefix}_${hash}`,
                    title: rawHeadline,
                    description: content,
                    content,
                    media_url: article.urlToImage || null,
                    media_type: 'image',
                    category: category,
                    country: article.source?.name || 'GLOBAL',
                    sideA: sideA,
                    sideB: sideB,
                    url: article.url || null,
                    startTime: new Date(Date.now() + expiry * 60 * 60 * 1000).toISOString(),
                    status: 'open'
                });

                await dbRun(
                    `INSERT INTO markets (id, title, description, content, media_url, media_type, category, country, sideA, sideB, startTime, status, url) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET
                        title=excluded.title,
                        description=excluded.description,
                        content=excluded.content,
                        media_url=excluded.media_url,
                        media_type=excluded.media_type,
                        startTime=excluded.startTime,
                        status=excluded.status,
                        url=excluded.url,
                        sideA=excluded.sideA,
                        sideB=excluded.sideB,
                        category=excluded.category,
                        timestamp=CURRENT_TIMESTAMP`,
                    [market.id, market.title, market.description, market.content, market.media_url, market.media_type, market.category, market.country, market.sideA, market.sideB, market.startTime, market.status, market.url]
                );

                processedMarkets.push(market);
            }
        } catch (e) {
            console.error("Multi-country news fetch error:", e.message);
        }

        emitMarkets();
        res.json({ articles: processedMarkets });
    } catch (error) {
        console.error("❌ Aggregator Error:", error.response?.data || error.message);
        res.status(500).json({ error: "Failed to scrape the global grid." });
    }
});

function buildNewsMarket(market) {
    const processed = { ...market };
    processed.category = (processed.category || 'news').toLowerCase();
    const rawTitle = String(processed.title || processed.description || '').trim();
    const cleanHeadline = rawTitle.replace(/\s+-\s+[^-]+$/, '').replace(/\s+/g, ' ').trim();
    const headlineQuestion = buildNewsQuestion(cleanHeadline);

    processed.displayHeadline = cleanHeadline;
    processed.title = headlineQuestion;
    processed.betQuestion = headlineQuestion;
    processed.persona_script = processed.persona_script || buildPersonaInsight(cleanHeadline);
    processed.sideA = processed.sideA || 'YES';
    processed.sideB = processed.sideB || 'NO';
    processed.status = processed.status || 'open';
    return processed;
}
app.get('/api/admin/market-pnl/:id', authenticateAdmin, async (req, res) => {
    const marketId = req.params.id;

    const bets = await dbAll(
        `SELECT amount, odds, side, status, settled_amount FROM transactions WHERE market_id=? AND type='bet'`,
        [marketId]
    );

    let totalStake = 0;
    let totalPayout = 0;

    bets.forEach(bet => {
        totalStake += bet.amount;
        if (bet.status === 'won') {
            totalPayout += (bet.settled_amount || 0);
        }
    });

    res.json({
        totalStake,
        totalPayout,
        profit: totalStake - totalPayout
    });
});
app.use(express.static(path.join(__dirname, '../public')));

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, '../public', 'login.html'));
});

app.use('/api', (req, res) => {
    res.status(404).json({ error: "API route not found" });
});

app.use((req, res) => {
    res.sendFile(path.join(__dirname, '../public', 'index.html'));
});
async function sendPolysokoPush(phoneNumber, amount, mpesaId, txnId) {
    const message = `Polysoko: Confirmed! We have received sKES ${amount}. Transaction ID: ${txnId}, M-Pesa ID: ${mpesaId}. Your Soko Shilling balance has been updated.`;

    try {
        // Formats phone to +254...
        const formattedPhone = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;

        const result = await at.SMS.send({
            to: [formattedPhone],
            message: message,
            // If you don't have a registered Sender ID yet, comment out the line below
            // from: "POLYSOKO" 
        });

        console.log(`✅ Real SMS Sent to ${phoneNumber}:`, result.SMSMessageData.Recipients[0].status);
    } catch (error) {
        console.error("❌ Africa's Talking Error:", error);
    }
}
// --- STARTUP ---
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. PolySoko is probably already running; stop that process before starting another one.`);
        process.exit(1);
    }

    throw err;
});
// --- FORCE SEND VERIFICATION FOR LEGACY USERS ---
const forceVerifyLegacyUsers = async () => {
    const legacyUsers = await dbAll("SELECT id, name, email FROM users WHERE status = 'unverified' AND verification_token IS NULL");
    if (legacyUsers.length === 0) return;
    
    console.log(`📧 Sending legacy verification to ${legacyUsers.length} users...`);
    for (const user of legacyUsers) {
        const token = crypto.randomBytes(32).toString('hex');
        await dbRun("UPDATE users SET verification_token = ? WHERE id = ?", [token, user.id]);
        const verifyLink = `${process.env.BASE_URL}/verify.html?token=${token}`;
        sendPolyMail(user.email, "Action Required: Verify Your PolySoko Account", 
            `<h1>Hello ${user.name}!</h1>
             <p>We've updated our security. Please verify your account to unlock your referral code:</p>
             <a href="${verifyLink}" style="padding:12px 20px; background:#00ff88; color:black; text-decoration:none; border-radius:8px; font-weight:bold; display:inline-block;">Verify Now</a>`);
    }
};

// Optional: If `AUTO_KILL_PORT` is set, attempt to free the port before starting (Windows only).
const tryAutoKillPort = async () => {
    if (!process.env.AUTO_KILL_PORT) return;
    if (process.platform !== 'win32') return;
    try {
        const cmd = `netstat -ano | findstr :${PORT}`;
        exec(cmd, (err, stdout) => {
            if (err || !stdout) return;
            const lines = stdout.trim().split(/\r?\n/);
            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                const pid = parts[parts.length - 1];
                if (pid && pid !== process.pid.toString()) {
                    console.log(`AUTO_KILL_PORT: killing PID ${pid} that listens on port ${PORT}`);
                    exec(`taskkill /PID ${pid} /F`, (killErr, killOut) => {
                        if (killErr) console.error('Failed to kill PID', pid, killErr.message);
                        else console.log('Killed PID', pid);
                    });
                }
            }
        });
    } catch (e) { console.error('AUTO_KILL_PORT failed:', e.message); }
};

const startServer = async () => {
    await tryAutoKillPort();

    server.listen(PORT, '0.0.0.0', async () => {
        console.log(`🚀 Terminal Online on Port ${PORT}`);
        await fixMissingMarketTimes();
        await cleanupOutdatedMarkets();
        await syncAllMarkets();
        await syncFootballMarkets();
        await refreshBoostedMarkets();
        await settleResolvedMarkets();
        setInterval(syncAllMarkets, 3600000);
        setInterval(syncFootballMarkets, 3600000);
        setInterval(refreshBoostedMarkets, 86400000);
        setInterval(settleResolvedMarkets, 3600000);
        await syncWeatherMarkets();
        setInterval(syncWeatherMarkets, 86400000);
        setInterval(cleanupOutdatedMarkets, 3600000);
        setInterval(sendDailyMarkets, 86400000);
        setInterval(closeExpiredMarkets, 3600000); 
        setInterval(settleWeatherMarkets, 3600000); 
        await forceVerifyLegacyUsers();
        if (process.env.EXIT_AFTER_STARTUP === '1' || process.env.EXIT_AFTER_STARTUP === 'true') {
            console.log('EXIT_AFTER_STARTUP set — exiting process so you can run in VS Code.');
            setTimeout(() => process.exit(0), 250);
        }
    });
};

startServer().catch(e => {
    console.error('Server startup failed:', e);
    process.exit(1);
});
