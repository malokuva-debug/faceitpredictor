/**
 * FACEIT Match Predictor — Backend Server v2.0
 *
 * ┌─────────────────────────────────────────────────────────┐
 * │  SETUP: npm install  →  node server.js                  │
 * │  Runs at http://localhost:3001                          │
 * └─────────────────────────────────────────────────────────┘
 *
 * The FACEIT API key lives HERE, never in the extension.
 * Users must log in via the popup before predictions load.
 */

'use strict';

const express = require('express');
const cors    = require('cors');
const jwt     = require('jsonwebtoken');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' })); // Chrome extension needs this

/* ══════════════════════════════════════════════════════════════
   ██  CONFIGURATION — edit this block
   ══════════════════════════════════════════════════════════════ */

// ── Your FACEIT API key (server.faceit.com → Apps → Create App) ──
const FACEIT_API_KEY = '22986c72-5806-4fa8-8c48-3e199cda8437';

// ── JWT signing secret — change to a long random string in production ──
const JWT_SECRET = '9f3c6a1e7b8d4c2f91a0e5d6b3c7f8a2d4e6f1c9b8a7d3e5f2c1a9b0e6d7c8f4b2a1c3d5e7f9a0b6c8d2e4f1a7b9c3d5';

// ── Port ──
const PORT = 3001;

// ── Allowed users  { username: password }  ──────────────────────────────────
// Change these before deploying. Passwords are plain-text here for
// simplicity; for production hash them with bcrypt.
const USERS = {
  admin:  'changeme123',
  user1:  'faceit2024',
  user2:  'predictor99',
};

/* ══════════════════════════════════════════════════════════════
   AUTH
   ══════════════════════════════════════════════════════════════ */

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

  const expected = USERS[username.toLowerCase()];
  if (!expected || expected !== password) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = jwt.sign({ username: username.toLowerCase() }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ ok: true, token, username: username.toLowerCase() });
});

app.get('/api/auth/verify', requireAuth, (req, res) => {
  res.json({ ok: true, username: req.user.username });
});

/* ══════════════════════════════════════════════════════════════
   MIDDLEWARE
   ══════════════════════════════════════════════════════════════ */

function requireAuth(req, res, next) {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });

  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token expired or invalid — please log in again' });
  }
}

/* ══════════════════════════════════════════════════════════════
   FACEIT API HELPERS
   ══════════════════════════════════════════════════════════════ */

const OPEN_API = 'https://open.faceit.com/data/v4';

async function faceit(path) {
  const url = path.startsWith('http') ? path : `${OPEN_API}${path}`;
  const res  = await fetch(url, { headers: { Authorization: `Bearer ${FACEIT_API_KEY}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`FACEIT ${res.status}: ${path}`);
  return res.json();
}

/* ══════════════════════════════════════════════════════════════
   PREDICTION ENDPOINT
   ══════════════════════════════════════════════════════════════ */

app.get('/api/predict/:matchId', requireAuth, async (req, res) => {
  const { matchId } = req.params;

  try {
    const match = await faceit(`/matches/${matchId}`);
    if (!match) return res.status(404).json({ ok: false, error: 'Match not found' });

    const f1 = match.teams?.faction1;
    const f2 = match.teams?.faction2;
    if (!f1 || !f2) return res.status(400).json({ ok: false, error: 'Could not parse team data' });

    const allIds = [
      ...f1.roster.map(p => p.player_id),
      ...f2.roster.map(p => p.player_id),
    ];

    // Fetch player stats + history in parallel
    const [statsArr, histArr] = await Promise.all([
      Promise.all(allIds.map(id => faceit(`/players/${id}/stats/cs2`).catch(() => null))),
      Promise.all(allIds.map(id => faceit(`/players/${id}/history?game=cs2&limit=20`).catch(() => null))),
    ]);

    const pData = {};
    allIds.forEach((id, i) => { pData[id] = { stats: statsArr[i], history: histArr[i] }; });

    const prediction = buildPrediction(match, f1, f2, pData);
    res.json({ ok: true, data: prediction });

  } catch (err) {
    console.error('[FP] /predict error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ══════════════════════════════════════════════════════════════
   PREDICTION ENGINE
   ══════════════════════════════════════════════════════════════ */

const CS2_MAPS = ['de_dust2','de_mirage','de_inferno','de_nuke','de_ancient','de_anubis','de_vertigo'];

const MAP_LABELS = {
  de_dust2:'Dust2', de_mirage:'Mirage', de_inferno:'Inferno', de_nuke:'Nuke',
  de_ancient:'Ancient', de_anubis:'Anubis', de_vertigo:'Vertigo',
  de_overpass:'Overpass', de_cache:'Cache', de_train:'Train', de_cobblestone:'Cobble',
};

const REGION_LABELS = {
  EU:'🇪🇺 Europe', NA:'🇺🇸 North America', SA:'🌎 South America',
  CIS:'🇷🇺 CIS', ASIA:'🌏 Asia', OCE:'🇦🇺 Oceania', ME:'🌍 Middle East', AF:'🌍 Africa',
};

const COUNTRY_REGION = {
  EU:  ['DE','FR','GB','ES','IT','NL','PL','SE','DK','FI','NO','CZ','HU','RO','PT','BE',
        'AT','CH','SK','HR','RS','BG','GR','LT','LV','EE','SI','MK','BA','ME','AL','IE',
        'IS','LU','MT','CY','XK','UA'],
  CIS: ['RU','KZ','BY','UZ','AZ','GE','AM','MD','KG','TJ','TM'],
  NA:  ['US','CA','MX'],
  SA:  ['BR','AR','CL','CO','PE','VE','EC','BO','PY','UY'],
  ASIA:['CN','KR','JP','SG','TH','ID','MY','PH','VN','TW','HK','IN','PK'],
  OCE: ['AU','NZ'],
  ME:  ['TR','IL','SA','AE','EG','QA','KW','OM','IQ','IR','JO'],
  AF:  ['ZA','NG','KE','GH','MA','ET'],
};

function countryToRegion(cc) {
  if (!cc) return null;
  const up = cc.toUpperCase();
  for (const [r, list] of Object.entries(COUNTRY_REGION)) {
    if (list.includes(up)) return r;
  }
  return null;
}

function buildPrediction(match, f1, f2, pData) {
  const roster1 = f1.roster ?? [];
  const roster2 = f2.roster ?? [];
  const all     = [...roster1, ...roster2];

  /* ── ELO ── */
  const avgElo1 = avgElo(roster1);
  const avgElo2 = avgElo(roster2);
  const eloDiff = Math.round(avgElo1 - avgElo2);

  /* ── Win probability (Elo formula) ── */
  const winPct1 = Math.round((1 / (1 + Math.pow(10, -eloDiff / 400))) * 100);
  const winPct2 = 100 - winPct1;

  /* ── Confidence score (0-100): based on data availability & Elo gap ── */
  const dataQuality = all.filter(p => pData[p.player_id]?.stats).length / all.length;
  const eloGapFactor = Math.min(Math.abs(eloDiff) / 300, 1); // 300+ elo = full confidence
  const confidence   = Math.round((dataQuality * 0.6 + eloGapFactor * 0.4) * 100);

  /* ── Map pool ── */
  const mapPool = (match.voting?.map?.entities ?? []).map(e => e.guid ?? e.name)
                  .filter(Boolean);
  const activePool = mapPool.length ? mapPool : CS2_MAPS;

  /* ── Map predictions ── */
  const mapPredictions = buildMapPredictions(activePool, all, pData);

  /* ── Server ── */
  const serverLocation = predictServer(match, all);

  /* ── Player enrichment ── */
  const players1 = enrichPlayers(roster1, f1, pData);
  const players2 = enrichPlayers(roster2, f2, pData);

  /* ── Team summary stats ── */
  const team1Stats = teamSummary(roster1, pData);
  const team2Stats = teamSummary(roster2, pData);

  /* ── Risk flags ── */
  const risks = detectRisks(all, pData);

  const hasStats = all.some(p => pData[p.player_id]?.stats);

  return {
    matchId: match.match_id,
    team1:  { id: f1.faction_id, name: f1.name, avgElo: Math.round(avgElo1), stats: team1Stats, players: players1 },
    team2:  { id: f2.faction_id, name: f2.name, avgElo: Math.round(avgElo2), stats: team2Stats, players: players2 },
    eloDiff,
    eloDiffFavor: eloDiff > 20 ? f1.name : eloDiff < -20 ? f2.name : 'Even',
    winPct1, winPct2,
    confidence,
    mapPredictions,
    serverLocation,
    risks,
    hasStats,
    generatedAt: Date.now(),
  };
}

function avgElo(roster) {
  if (!roster.length) return 0;
  return roster.reduce((s, p) => s + (Number(p.faceit_elo ?? p.elo) || 1000), 0) / roster.length;
}

function buildMapPredictions(pool, players, pData) {
  // Frequency table with Laplace smoothing
  const freq  = Object.fromEntries(pool.map(m => [m, 1]));
  let hasData = false;

  players.forEach(p => {
    const id   = p.player_id;
    const hist = pData[id]?.history?.items ?? [];
    const segs = pData[id]?.stats?.segments ?? [];

    // ── History: recency-weighted ──
    hist.forEach((h, idx) => {
      const mapRaw = h.i8 ?? h.voting?.map?.pick?.[0] ?? null;
      if (mapRaw && pool.includes(mapRaw)) {
        hasData = true;
        const weight = 1 + (hist.length - idx) * 0.08;
        freq[mapRaw] = (freq[mapRaw] ?? 1) + weight;
      }
    });

    // ── Stats segments: weighted by match count ──
    segs.forEach(seg => {
      const raw  = (seg.label ?? '').toLowerCase();
      const key  = raw.startsWith('de_') ? raw : `de_${raw}`;
      const cnt  = parseInt(seg.stats?.Matches ?? 0);
      if (pool.includes(key) && cnt > 0) {
        hasData = true;
        freq[key] = (freq[key] ?? 1) + cnt * 0.015;
      }
    });
  });

  const total = Object.values(freq).reduce((s, v) => s + v, 0);

  return pool
    .map(m => ({
      key:         m,
      name:        MAP_LABELS[m] ?? m.replace(/^de_/, '').replace(/_/g, ' '),
      probability: Math.round((freq[m] / total) * 100),
      hasData,
    }))
    .sort((a, b) => b.probability - a.probability);
}

function teamSummary(roster, pData) {
  let kd = 0, wr = 0, hs = 0, count = 0;
  roster.forEach(p => {
    const lt = pData[p.player_id]?.stats?.lifetime;
    if (!lt) return;
    kd += parseFloat(lt['K/D Ratio'] ?? lt['Average K/D Ratio'] ?? 0);
    wr += parseFloat(lt['Win Rate %'] ?? 0);
    hs += parseFloat(lt['Average Headshots %'] ?? lt['Headshots %'] ?? 0);
    count++;
  });
  if (!count) return null;
  return {
    avgKD: (kd / count).toFixed(2),
    avgWR: Math.round(wr / count),
    avgHS: Math.round(hs / count),
  };
}

function enrichPlayers(roster, faction, pData) {
  return roster.map(p => {
    const id   = p.player_id;
    const lt   = pData[id]?.stats?.lifetime ?? {};
    const hist = pData[id]?.history?.items ?? [];

    /* Recent form: check the player_id in each match result */
    const recentForm = hist.slice(0, 5).map(h => {
      const winner = h.results?.winner;         // "faction1" or "faction2"
      if (!winner) return '?';
      // Find which faction this player was on
      const inF1 = (h.teams?.faction1?.players ?? []).some(x => x.player_id === id);
      return (inF1 && winner === 'faction1') || (!inF1 && winner === 'faction2') ? 'W' : 'L';
    });

    const kd = parseFloat(lt['K/D Ratio'] ?? lt['Average K/D Ratio'] ?? 0);
    const wr = parseFloat(lt['Win Rate %'] ?? 0);
    const hs = parseFloat(lt['Average Headshots %'] ?? lt['Headshots %'] ?? 0);

    /* Smurf risk: high K/D but few games or suspiciously low ELO for stats */
    const matches = parseInt(lt['Matches'] ?? lt['matches'] ?? 0);
    const elo = Number(p.faceit_elo ?? p.elo) || 1000;

    let smurfRisk = 'none';
    if (kd > 1.5 && matches < 100 && elo < 1800) smurfRisk = 'medium';
    if (kd > 2.0 && matches < 50)                 smurfRisk = 'high';

    return {
      id,
      name:       p.nickname,
      country:    p.country ?? null,
      elo:        elo,
      skillLevel: p.skill_level ?? null,
      kd:         kd ? kd.toFixed(2) : null,
      wr:         wr ? Math.round(wr) : null,
      hs:         hs ? Math.round(hs) : null,
      matches:    matches || null,
      recentForm,
      smurfRisk,
    };
  });
}

function detectRisks(players, pData) {
  const flags = [];
  players.forEach(p => {
    const lt  = pData[p.player_id]?.stats?.lifetime ?? {};
    const kd  = parseFloat(lt['K/D Ratio'] ?? 0);
    const cnt = parseInt(lt['Matches'] ?? 0);
    if (kd > 2.0 && cnt < 50)  flags.push(`Possible smurf: ${p.nickname}`);
    if (!pData[p.player_id]?.stats) flags.push(`No data: ${p.nickname}`);
  });
  return flags;
}

function predictServer(match, players) {
  const r = match.region;
  if (r) return REGION_LABELS[r.toUpperCase()] ?? r;

  const counts = {};
  players.forEach(p => {
    const c = p.country;
    if (c) counts[c] = (counts[c] ?? 0) + 1;
  });

  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  const reg = countryToRegion(top);
  return reg ? (REGION_LABELS[reg] ?? reg) : '❓ Unknown';
}

/* 

// Simple homepage for testing
app.get('/', (req, res) => {
  res.send(`
    <h1>FACEIT Predictor Server v2.0</h1>
    <p>Use the API endpoints:</p>
    <ul>
      <li>POST /api/auth/login</li>
      <li>GET /api/auth/verify</li>
      <li>GET /api/predict/:matchId</li>
    </ul>
  `);
});

══════════════════════════════════════════════════════════════
   START
   ══════════════════════════════════════════════════════════════ */

app.listen(PORT, () => {
  console.log(`\n⚡ FACEIT Predictor Server v2.0`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   API key: ${FACEIT_API_KEY === 'YOUR_FACEIT_API_KEY_HERE' ? '⚠ NOT SET — edit server.js' : '✓ Configured'}\n`);
});
