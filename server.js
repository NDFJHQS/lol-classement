// Classement LoL entre potes — serveur sans dépendance (Node 18+)
// Lancement : RIOT_API_KEY=RGAPI-xxxx node server.js

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.RIOT_API_KEY;
const PLATFORM = process.env.PLATFORM || 'euw1'; // euw1, eun1, na1, kr...
const REGION = process.env.REGION || 'europe';   // europe, americas, asia
const FRIENDS_FILE = path.join(__dirname, 'friends.json');
const CACHE_MS = 2 * 60 * 1000; // 2 min, pour ne pas dépasser les limites de l'API
const ADMIN_KEY = process.env.ADMIN_KEY || ''; // si défini, il faut ce code pour ajouter/retirer un pote

if (!API_KEY) {
  console.error('❌ Il manque la clé API. Lance : RIOT_API_KEY=RGAPI-xxxx node server.js');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cache = { at: 0, data: null };
const accounts = new Map(); // "pseudo#tag" -> compte Riot (le puuid ne change pas)

// ---------- Appels à l'API Riot ----------
async function riot(url, tries = 3) {
  const res = await fetch(url, { headers: { 'X-Riot-Token': API_KEY } });
  if (res.status === 429 && tries > 0) {
    const wait = (Number(res.headers.get('retry-after')) || 2) * 1000;
    await sleep(wait);
    return riot(url, tries - 1);
  }
  if (!res.ok) {
    const err = new Error(`Riot API ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function splitRiotId(riotId) {
  const i = riotId.lastIndexOf('#');
  if (i < 1 || i === riotId.length - 1) return null;
  return { gameName: riotId.slice(0, i).trim(), tagLine: riotId.slice(i + 1).trim() };
}

async function getAccount(riotId) {
  const key = riotId.toLowerCase();
  if (accounts.has(key)) return accounts.get(key);
  const id = splitRiotId(riotId);
  if (!id) throw Object.assign(new Error('Format attendu : Pseudo#TAG'), { status: 400 });
  const acc = await riot(
    `https://${REGION}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/` +
      `${encodeURIComponent(id.gameName)}/${encodeURIComponent(id.tagLine)}`
  );
  accounts.set(key, acc);
  return acc;
}

async function getPlayer(riotId) {
  try {
    const acc = await getAccount(riotId);
    const base = `https://${PLATFORM}.api.riotgames.com/lol`;
    const [summoner, entries] = await Promise.all([
      riot(`${base}/summoner/v4/summoners/by-puuid/${acc.puuid}`),
      riot(`${base}/league/v4/entries/by-puuid/${acc.puuid}`),
    ]);
    const pick = (q) => {
      const e = entries.find((x) => x.queueType === q);
      return e
        ? { tier: e.tier, rank: e.rank, lp: e.leaguePoints, wins: e.wins, losses: e.losses, hotStreak: e.hotStreak }
        : null;
    };
    return {
      riotId,
      gameName: acc.gameName,
      tagLine: acc.tagLine,
      icon: summoner.profileIconId,
      level: summoner.summonerLevel,
      solo: pick('RANKED_SOLO_5x5'),
      flex: pick('RANKED_FLEX_SR'),
    };
  } catch (e) {
    return { riotId, error: e.status === 404 ? 'Joueur introuvable' : e.message };
  }
}

// ---------- Liste des potes ----------
function readFriends() {
  try { return JSON.parse(fs.readFileSync(FRIENDS_FILE, 'utf8')); } catch { return []; }
}
function writeFriends(list) {
  fs.writeFileSync(FRIENDS_FILE, JSON.stringify(list, null, 2));
}

async function leaderboard(force) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) return cache;
  const players = [];
  for (const id of readFriends()) {
    players.push(await getPlayer(id));
    await sleep(100); // reste sous la limite de 20 requêtes/s
  }
  cache = { at: Date.now(), data: players };
  return cache;
}

// ---------- Serveur HTTP ----------
function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/leaderboard' && req.method === 'GET') {
      const { at, data } = await leaderboard(url.searchParams.has('refresh'));
      return json(res, 200, { updatedAt: at, players: data });
    }

    if (url.pathname === '/api/friends' && req.method !== 'GET' && ADMIN_KEY &&
        req.headers['x-admin-key'] !== ADMIN_KEY) {
      return json(res, 401, { error: 'Code admin incorrect' });
    }

    if (url.pathname === '/api/friends' && req.method === 'POST') {
      const { riotId } = await readBody(req);
      if (!riotId || !splitRiotId(String(riotId))) return json(res, 400, { error: 'Format attendu : Pseudo#TAG' });
      const list = readFriends();
      if (list.some((f) => f.toLowerCase() === riotId.toLowerCase())) return json(res, 409, { error: 'Déjà dans la liste' });
      try {
        const acc = await getAccount(riotId.trim());
        list.push(`${acc.gameName}#${acc.tagLine}`);
      } catch (e) {
        return json(res, e.status === 404 ? 404 : 502, { error: e.status === 404 ? 'Joueur introuvable' : e.message });
      }
      writeFriends(list);
      cache.at = 0;
      return json(res, 201, { ok: true });
    }

    if (url.pathname === '/api/friends' && req.method === 'DELETE') {
      const id = (url.searchParams.get('riotId') || '').toLowerCase();
      writeFriends(readFriends().filter((f) => f.toLowerCase() !== id));
      cache.at = 0;
      return json(res, 200, { ok: true });
    }

    // Page du site
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    json(res, 500, { error: e.message });
  }
}).listen(PORT, '0.0.0.0', () => console.log(`✅ Classement dispo sur http://localhost:${PORT}`));
