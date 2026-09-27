// Serveur de synchro IITC : stockage clé/valeur avec fusion par timestamp.
// Aucune dépendance externe (Node >= 18).
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8080', 10);
const DATA_DIR = process.env.DATA_DIR || '/data/users';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://intel.ingress.com';
const MAX_BODY = 20 * 1024 * 1024;

// Un store par agent (pseudo Ingress), chargé à la demande :
// { auth: { salt, hash }, rev: <compteur>, entries: { key: { value, ts, rev } } }
// Le premier appareil qui synchronise un agent fixe son mot de passe.
const USER_RE = /^[a-z0-9_-]{1,40}$/;
const stores = {};

function userFile(user) {
  return path.join(DATA_DIR, user + '.json');
}

function loadStore(user) {
  if (stores[user]) return stores[user];
  try {
    stores[user] = JSON.parse(fs.readFileSync(userFile(user), 'utf8'));
  } catch (e) {
    stores[user] = { rev: 0, entries: {} };
  }
  return stores[user];
}

// Anti force brute : trop d'échecs depuis une IP => blocage temporaire
const MAX_FAILURES = 10;
const BLOCK_MS = 15 * 60 * 1000;
const failures = {};

function clientIp(req) {
  return req.headers['cf-connecting-ip'] ||
    String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress;
}

function isBlocked(ip) {
  const f = failures[ip];
  if (!f) return false;
  if (Date.now() - f.since > BLOCK_MS) { delete failures[ip]; return false; }
  return f.count >= MAX_FAILURES;
}

function recordFailure(ip) {
  const f = failures[ip] || (failures[ip] = { count: 0, since: Date.now() });
  f.count++;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

// Mots de passe déjà vérifiés, pour ne pas recalculer scrypt à chaque requête
const verified = {};

// Renvoie true si le mot de passe est bon ; réserve l'agent s'il est nouveau.
function checkPassword(user, password) {
  const store = loadStore(user);
  const fast = crypto.createHash('sha256').update(password).digest('hex');
  if (!store.auth) {
    const salt = crypto.randomBytes(16).toString('hex');
    store.auth = { salt: salt, hash: hashPassword(password, salt) };
    save(user);
    verified[user] = fast;
    console.log('Nouvel agent : ' + user);
    return true;
  }
  if (verified[user] === fast) return true;
  const ok = crypto.timingSafeEqual(
    Buffer.from(hashPassword(password, store.auth.salt), 'hex'),
    Buffer.from(store.auth.hash, 'hex')
  );
  if (ok) verified[user] = fast;
  return ok;
}

function save(user) {
  const file = userFile(user);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
  fs.writeFileSync(file + '.tmp', JSON.stringify(stores[user]));
  fs.renameSync(file + '.tmp', file);
}

// Applique les entrées reçues (la plus récente gagne) puis renvoie tout ce
// que le client n'a pas encore vu depuis `since`, plus la version serveur des
// clés qu'il a envoyées mais qui ont perdu la fusion.
function sync(user, body) {
  const store = loadStore(user);
  const since = Number(body.since) || 0;
  const incoming = body.entries || {};
  const rejected = [];
  let changed = false;

  Object.keys(incoming).forEach(function (k) {
    const e = incoming[k];
    if (!e || typeof e.value !== 'string') return;
    const ts = Number(e.ts) || 0;
    const cur = store.entries[k];
    if (!cur || ts > cur.ts) {
      if (cur && cur.value === e.value) { cur.ts = ts; return; }
      store.rev++;
      store.entries[k] = { value: e.value, ts: ts, rev: store.rev };
      changed = true;
    } else if (cur.value !== e.value) {
      rejected.push(k);
    }
  });

  if (changed) save(user);

  const out = {};
  Object.keys(store.entries).forEach(function (k) {
    const e = store.entries[k];
    if (e.rev > since && !incoming[k]) out[k] = { value: e.value, ts: e.ts };
  });
  rejected.forEach(function (k) {
    const e = store.entries[k];
    out[k] = { value: e.value, ts: e.ts };
  });

  return { rev: store.rev, entries: out };
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(obj === undefined ? '' : JSON.stringify(obj));
}

http.createServer(function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') return send(res, 204);
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
  if (req.method !== 'POST' || req.url !== '/sync') return send(res, 404, { error: 'not found' });
  const ip = clientIp(req);
  if (isBlocked(ip)) return send(res, 429, { error: 'too many failures' });

  const chunks = [];
  let size = 0;
  req.on('data', function (c) {
    size += c.length;
    if (size > MAX_BODY) { send(res, 413, { error: 'too large' }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', function () {
    if (res.writableEnded) return;
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const user = String(body.user || '').toLowerCase();
      if (!USER_RE.test(user)) return send(res, 400, { error: 'invalid user' });
      // Mot de passe en en-tête (fetch) ou dans le corps (sendBeacon, qui ne permet pas d'en-têtes)
      const header = String(req.headers.authorization || '');
      const password = header.indexOf('Bearer ') === 0 ? header.slice(7) : String(body.password || '');
      if (password.length < 4 || password.length > 200) return send(res, 401, { error: 'unauthorized' });
      if (!checkPassword(user, password)) {
        recordFailure(ip);
        return send(res, 401, { error: 'unauthorized' });
      }
      send(res, 200, sync(user, body));
    } catch (e) {
      console.error(e);
      send(res, 400, { error: e.message });
    }
  });
}).listen(PORT, function () {
  console.log('IITC sync en écoute sur :' + PORT);
});
