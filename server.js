// GG ou FF — le site des potes (Node 18+, aucune dépendance)
// Lancement : RIOT_API_KEY=RGAPI-xxxx node server.js

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.RIOT_API_KEY;
const PLATFORM = process.env.PLATFORM || 'euw1'; // euw1, eun1, na1, kr...
const REGION = process.env.REGION || 'europe';   // europe, americas, asia
const ADMIN_KEY = process.env.ADMIN_KEY || '';   // si défini, il faut ce code pour ajouter/retirer un pote
const FRIENDS_FILE = path.join(__dirname, 'friends.json');
const CACHE_MS = 2 * 60 * 1000;        // rangs : rafraîchis au plus toutes les 2 min
const MATCH_REFRESH_MS = 5 * 60 * 1000; // historique : vérifié au plus toutes les 5 min
const MATCH_COUNT = 10;                 // nombre de games analysées par joueur

if (!API_KEY) {
  console.error('❌ Il manque la clé API. Lance : RIOT_API_KEY=RGAPI-xxxx node server.js');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cache = { at: 0, data: null };
const accounts = new Map();   // "pseudo#tag" -> compte Riot
const matches = new Map();    // matchId -> données du match (ne change jamais)
const history = new Map();    // puuid -> { at, ids }

// ---------- Appels HTTP ----------
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

// Données statiques (noms et images des champions) via Data Dragon
let ddragon = { at: 0, version: null, byKey: {} };
async function getDdragon() {
  if (ddragon.version && Date.now() - ddragon.at < 6 * 3600 * 1000) return ddragon;
  try {
    const versions = await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json();
    const v = versions[0];
    const champs = await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${v}/data/fr_FR/champion.json`)).json();
    const byKey = {};
    for (const c of Object.values(champs.data)) byKey[c.key] = { id: c.id, name: c.name };
    ddragon = { at: Date.now(), version: v, byKey };
  } catch (e) {
    console.warn('Data Dragon indisponible :', e.message);
  }
  return ddragon;
}

// ---------- Joueurs ----------
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

const ROLES = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'ADC', UTILITY: 'Support' };

async function getRecentGames(puuid) {
  let h = history.get(puuid);
  if (!h || Date.now() - h.at > MATCH_REFRESH_MS) {
    const ids = await riot(
      `https://${REGION}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?type=ranked&count=${MATCH_COUNT}`
    );
    h = { at: Date.now(), ids };
    history.set(puuid, h);
  }
  const games = [];
  for (const id of h.ids) {
    if (!matches.has(id)) {
      try {
        matches.set(id, await riot(`https://${REGION}.api.riotgames.com/lol/match/v5/matches/${id}`));
        await sleep(60);
      } catch { continue; }
    }
    const m = matches.get(id);
    const p = m.info.participants.find((x) => x.puuid === puuid);
    if (!p || m.info.gameDuration < 300) continue; // ignore les remakes
    games.push({
      win: p.win,
      champion: p.championName,
      role: ROLES[p.teamPosition] || null,
      k: p.kills, d: p.deaths, a: p.assists,
      cs: p.totalMinionsKilled + p.neutralMinionsKilled,
      vision: p.visionScore,
      duration: m.info.gameDuration,
      date: m.info.gameEndTimestamp || m.info.gameCreation,
    });
  }
  return games;
}

function summarize(games) {
  if (!games.length) return null;
  const sum = (f) => games.reduce((s, g) => s + f(g), 0);
  const n = games.length;
  const deaths = sum((g) => g.d);
  const count = (f) => {
    const c = {};
    for (const g of games) { const k = f(g); if (k) c[k] = (c[k] || 0) + 1; }
    return Object.entries(c).sort((a, b) => b[1] - a[1]);
  };
  const champs = count((g) => g.champion).slice(0, 3).map(([id, games]) => ({ id, games }));
  const role = count((g) => g.role)[0];
  return {
    games: n,
    wins: sum((g) => (g.win ? 1 : 0)),
    kda: +((sum((g) => g.k) + sum((g) => g.a)) / Math.max(1, deaths)).toFixed(1),
    k: +(sum((g) => g.k) / n).toFixed(1),
    d: +(deaths / n).toFixed(1),
    a: +(sum((g) => g.a) / n).toFixed(1),
    csMin: +(sum((g) => g.cs) / (sum((g) => g.duration) / 60)).toFixed(1),
    vision: Math.round(sum((g) => g.vision) / n),
    duration: Math.round(sum((g) => g.duration) / n / 60),
    role: role ? role[0] : null,
    champs,
    form: games.map((g) => (g.win ? 'V' : 'D')),
  };
}

async function getPlayer(riotId) {
  try {
    const acc = await getAccount(riotId);
    const base = `https://${PLATFORM}.api.riotgames.com/lol`;
    const [summoner, entries, mastery] = await Promise.all([
      riot(`${base}/summoner/v4/summoners/by-puuid/${acc.puuid}`),
      riot(`${base}/league/v4/entries/by-puuid/${acc.puuid}`),
      riot(`${base}/champion-mastery/v4/champion-masteries/by-puuid/${acc.puuid}/top?count=3`).catch(() => []),
    ]);
    const pick = (q) => {
      const e = entries.find((x) => x.queueType === q);
      return e
        ? { tier: e.tier, rank: e.rank, lp: e.leaguePoints, wins: e.wins, losses: e.losses, hotStreak: e.hotStreak }
        : null;
    };
    let recent = null;
    try { recent = summarize(await getRecentGames(acc.puuid)); } catch (e) { console.warn('Matchs', riotId, e.message); }
    const dd = await getDdragon();
    return {
      riotId,
      gameName: acc.gameName,
      tagLine: acc.tagLine,
      icon: summoner.profileIconId,
      level: summoner.summonerLevel,
      solo: pick('RANKED_SOLO_5x5'),
      flex: pick('RANKED_FLEX_SR'),
      mastery: mastery.map((m) => ({
        id: (dd.byKey[m.championId] || {}).id || String(m.championId),
        name: (dd.byKey[m.championId] || {}).name || `Champion ${m.championId}`,
        level: m.championLevel,
        points: m.championPoints,
      })),
      recent,
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

let pending = null;
async function leaderboard(force) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) return cache;
  if (pending) return pending; // évite deux mises à jour en même temps
  pending = (async () => {
    const players = [];
    for (const id of readFriends()) {
      players.push(await getPlayer(id));
      await sleep(100);
    }
    const dd = await getDdragon();
    cache = { at: Date.now(), data: players, version: dd.version };
    return cache;
  })().finally(() => { pending = null; });
  return pending;
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/leaderboard' && req.method === 'GET') {
      const { at, data, version } = await leaderboard(url.searchParams.has('refresh'));
      return json(res, 200, { updatedAt: at, ddragon: version, players: data });
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
});

server.listen(PORT, '0.0.0.0', () => console.log(`✅ GG ou FF dispo sur http://localhost:${PORT}`));
module.exports = server;
