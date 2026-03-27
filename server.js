/**
 * FACEIT Match Predictor — Backend Server v2.1 (PKCE ready)
 *
 * ┌─────────────────────────────────────────────────────────┐
 * │  SETUP: npm install  →  node server.js                  │
 * │  Runs at http://localhost:3001                          │
 * └─────────────────────────────────────────────────────────┘
 *
 * The FACEIT API key lives HERE, never in the extension.
 * Users must log in via the popup before predictions load.
 * PKCE flow avoids needing a client secret for public clients.
 */

'use strict';

const express = require('express');
const cors    = require('cors');
const jwt     = require('jsonwebtoken');
const fetch   = require('node-fetch'); // ensure node-fetch installed

const FACEIT_CLIENT_ID = 'cf30058a-c266-406a-beea-40301216f917'; // PKCE public client
const PORT             = process.env.PORT || 3001;
const SERVER_BASE      = process.env.SERVER_URL || `http://localhost:${PORT}`;

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' })); // Chrome extension needs this

/* ══════════════════════════════════════════════════════════════
   CONFIGURATION — edit this block
   ══════════════════════════════════════════════════════════════ */

const FACEIT_API_KEY = '22986c72-5806-4fa8-8c48-3e199cda8437'; // server-side only

const JWT_SECRET = '9f3c6a1e7b8d4c2f91a0e5d6b3c7f8a2d4e6f1c9b8a7d3e5f2c1a9b0e6d7c8f4b2a1c3d5e7f9a0b6c8d2e4f1a7b9c3d5';

// ── Allowed users
const USERS = {
  admin: 'changeme123',
  user1: 'faceit2024',
  user2: 'predictor99',
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
  const res = await fetch(url, { headers: { Authorization: `Bearer ${FACEIT_API_KEY}` } });
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
   PKCE LOGIN FLOW
   ══════════════════════════════════════════════════════════════ */

app.get('/api/auth/faceit', (req, res) => {
  const redirectUri = req.query.redirect_uri || `${SERVER_BASE}/popup-success`;
  const state       = req.query.state || 'predictor';
  const codeChallenge = req.query.code_challenge || ''; // extension generates S256

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: FACEIT_CLIENT_ID,
    redirect_uri: redirectUri,
    state,
    code_challenge_method: 'S256',
    code_challenge,
  });

  res.redirect(`https://faceit.com/oauth/authorize?${params.toString()}`);
});

app.get('/popup-success', async (req, res) => {
  const { code, code_verifier } = req.query;
  if (!code) return res.send('❌ No code received from FACEIT');

  try {
    const tokenRes = await fetch('https://api.faceit.com/auth/v1/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: FACEIT_CLIENT_ID,
        code,
        code_verifier, // required for PKCE
      }),
    });

    const data = await tokenRes.json();
    if (!data.access_token) return res.send('❌ Failed to get access token');

    const jwtToken = jwt.sign({ faceitToken: data.access_token }, JWT_SECRET, { expiresIn: '24h' });

    res.send(`
      <script>
        localStorage.setItem('fp_token', '${jwtToken}');
        if (window.opener) window.opener.postMessage({ type: 'FACEIT_LOGIN_SUCCESS', token: '${jwtToken}' }, '*');
        window.close();
      </script>
      <p>✅ Login successful! You can close this window.</p>
    `);
  } catch (err) {
    console.error('[popup-success]', err);
    res.send('❌ Error exchanging code for token');
  }
});

/* ══════════════════════════════════════════════════════════════
   HOME
   ══════════════════════════════════════════════════════════════ */

app.get('/', (req, res) => {
  res.send('<h1>FACEIT Predictor Server v2.1</h1><p>Use /api/auth/login or /api/predict/:matchId</p>');
});

/* ══════════════════════════════════════════════════════════════
   START SERVER
   ══════════════════════════════════════════════════════════════ */

app.listen(PORT, () => {
  console.log(`\n⚡ FACEIT Predictor Server v2.1`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   API key: ${FACEIT_API_KEY ? '✓ Configured' : '⚠ NOT SET — edit server.js'}\n`);
});
