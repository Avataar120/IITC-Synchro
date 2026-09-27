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

// Limites de taille
const MAX_BODY = 2 * 1024 * 1024;          // corps d'une requête
const MAX_STORE = 2 * 1024 * 1024;         // données d'un agent
const MAX_ENTRIES = 2000;                  // clés par agent
const MAX_KEY_LENGTH = 256;
const MAX_USERS = 200;
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000; // un ts plus loin dans le futur est ramené à maintenant

// Mots de passe : longueur mini à la création d'un agent, scrypt N=2^15 r=8 p=1
const MIN_NEW_PASSWORD = 8;
const MAX_PASSWORD = 200;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

// Anti force brute (fenêtre de 15 min) et limite de créations d'agents (par 24 h)
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_IP = 10;
const MAX_FAILURES_PER_USER = 10;
const MAX_CREATIONS_PER_IP = 5;
const CREATION_WINDOW_MS = 24 * 60 * 60 * 1000;

// Fichiers de données lisibles uniquement par le processus
process.umask(0o077);

// Pseudo Ingress : lettres, chiffres, underscore
const USER_RE = /^[a-z0-9_]{1,40}$/;

// Un store par agent, chargé à la demande :
// { auth: { salt, hash, N }, rev: <compteur>, entries: { key: { value, ts, rev } } }
// Le premier appareil qui synchronise un agent fixe son mot de passe.
// Les Map et objets sans prototype évitent toute pollution de prototype via les noms fournis par les clients.
const stores = new Map();
const hasOwn = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };

function userFile(user) {
  return path.join(DATA_DIR, user + '.json');
}

function loadStore(user) {
  if (stores.has(user)) return stores.get(user);
  let store = null;
  try {
    const raw = JSON.parse(fs.readFileSync(userFile(user), 'utf8'));
    store = { auth: raw.auth || null, rev: Number(raw.rev) || 0, entries: Object.assign(Object.create(null), raw.entries) };
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (store) stores.set(user, store);
  return store;
}

function countUsers() {
  try { return fs.readdirSync(DATA_DIR).filter(function (f) { return /\.json$/.test(f); }).length; } catch (e) { return 0; }
}

function save(user) {
  const file = userFile(user);
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
  fs.writeFileSync(file + '.tmp', JSON.stringify(stores.get(user)), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

// ---- Compteurs glissants (échecs, créations) ----

function makeCounter(windowMs) {
  const map = new Map();
  return {
    count: function (key) {
      const e = map.get(key);
      if (!e) return 0;
      if (Date.now() - e.since > windowMs) { map.delete(key); return 0; }
      return e.count;
    },
    add: function (key) {
      if (this.count(key) === 0) map.set(key, { count: 0, since: Date.now() });
      map.get(key).count++;
    },
    purge: function () {
      const now = Date.now();
      map.forEach(function (e, k) { if (now - e.since > windowMs) map.delete(k); });
    }
  };
}

const ipFailures = makeCounter(WINDOW_MS);
const userFailures = makeCounter(WINDOW_MS);
const ipCreations = makeCounter(CREATION_WINDOW_MS);
setInterval(function () { ipFailures.purge(); userFailures.purge(); ipCreations.purge(); }, 60 * 1000).unref();

// IP du client : dernière entrée de X-Forwarded-For, posée par Traefik et non falsifiable
// par le client (les en-têtes fournis par le client, comme CF-Connecting-IP, sont ignorés).
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',');
  return xff[xff.length - 1].trim() || req.socket.remoteAddress;
}

// ---- Mots de passe ----

function scrypt(password, salt, N) {
  return new Promise(function (resolve, reject) {
    crypto.scrypt(password, salt, 32, Object.assign({}, SCRYPT, { N: N }), function (err, key) {
      if (err) reject(err); else resolve(key);
    });
  });
}

function fastHash(user, password) {
  return crypto.createHash('sha256').update(user + '\0' + password).digest('hex');
}

// Mots de passe déjà vérifiés : les appareils connus passent sans recalcul scrypt,
// même quand l'agent est temporairement bloqué par des échecs d'un tiers.
const verified = new Map();
// Agents en cours de création (deux premières synchros simultanées)
const creating = new Set();

function createUser(user, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return scrypt(password, salt, SCRYPT.N).then(function (key) {
    stores.set(user, { auth: { salt: salt, hash: key.toString('hex'), N: SCRYPT.N }, rev: 0, entries: Object.create(null) });
    save(user);
    verified.set(user, fastHash(user, password));
    console.log('Nouvel agent : ' + user);
  });
}

function verifyPassword(user, store, password) {
  const auth = store.auth;
  const N = auth.N || 16384;
  return scrypt(password, auth.salt, N).then(function (key) {
    const ok = crypto.timingSafeEqual(key, Buffer.from(auth.hash, 'hex'));
    if (!ok) return false;
    verified.set(user, fastHash(user, password));
    // Hachage mis à niveau vers les paramètres actuels
    if (N !== SCRYPT.N) {
      const salt = crypto.randomBytes(16).toString('hex');
      return scrypt(password, salt, SCRYPT.N).then(function (k) {
        store.auth = { salt: salt, hash: k.toString('hex'), N: SCRYPT.N };
        save(user);
        return true;
      });
    }
    return true;
  });
}

// ---- Fusion ----

function storeSize(store) {
  let size = 0;
  Object.keys(store.entries).forEach(function (k) { size += k.length + store.entries[k].value.length; });
  return size;
}

// Applique les entrées reçues (la plus récente gagne) puis renvoie tout ce
// que le client n'a pas encore vu depuis `since`, plus la version serveur des
// clés qu'il a envoyées mais qui ont perdu la fusion.
// Renvoie null si le résultat dépasserait les quotas de l'agent (rien n'est alors modifié).
function sync(user, store, body) {
  const since = Number(body.since) || 0;
  const incoming = (body.entries && typeof body.entries === 'object') ? body.entries : {};
  const maxTs = Date.now() + MAX_FUTURE_MS;
  const updates = [];
  const rejected = [];

  Object.keys(incoming).forEach(function (k) {
    const e = incoming[k];
    if (k.length > MAX_KEY_LENGTH || !e || typeof e.value !== 'string') return;
    let ts = Number(e.ts);
    if (!isFinite(ts) || ts < 0) ts = 0;
    if (ts > maxTs) ts = Date.now();
    const cur = store.entries[k];
    if (!cur || ts > cur.ts) {
      updates.push({ key: k, value: e.value, ts: ts });
    } else if (cur.value !== e.value) {
      rejected.push(k);
    }
  });

  // Contrôle des quotas avant toute modification
  let size = storeSize(store);
  let count = Object.keys(store.entries).length;
  updates.forEach(function (u) {
    const cur = store.entries[u.key];
    if (cur) size -= u.key.length + cur.value.length; else count++;
    size += u.key.length + u.value.length;
  });
  if (size > MAX_STORE || count > MAX_ENTRIES) return null;

  let changed = false;
  updates.forEach(function (u) {
    const cur = store.entries[u.key];
    if (cur && cur.value === u.value) { cur.ts = u.ts; return; }
    store.rev++;
    store.entries[u.key] = { value: u.value, ts: u.ts, rev: store.rev };
    changed = true;
  });
  if (changed) save(user);

  const out = Object.create(null);
  Object.keys(store.entries).forEach(function (k) {
    const e = store.entries[k];
    if (e.rev > since && !hasOwn(incoming, k)) out[k] = { value: e.value, ts: e.ts };
  });
  rejected.forEach(function (k) {
    const e = store.entries[k];
    out[k] = { value: e.value, ts: e.ts };
  });

  return { rev: store.rev, entries: out };
}

// ---- HTTP ----

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(obj === undefined ? '' : JSON.stringify(obj));
}

// Traitement d'une requête /sync authentifiée ou créant l'agent
function handleSync(req, res, body) {
  const ip = clientIp(req);
  const user = String(body.user || '').toLowerCase();
  if (!USER_RE.test(user)) return send(res, 400, { error: 'invalid user' });

  // Mot de passe en en-tête (fetch) ou dans le corps (sendBeacon, qui ne permet pas d'en-têtes)
  const header = String(req.headers.authorization || '');
  const password = header.indexOf('Bearer ') === 0 ? header.slice(7) : String(body.password || '');
  if (!password || password.length > MAX_PASSWORD) return send(res, 401, { error: 'unauthorized' });

  const store = loadStore(user);
  let auth;

  if (!store) {
    if (password.length < MIN_NEW_PASSWORD) return send(res, 400, { error: 'weak password', min: MIN_NEW_PASSWORD });
    if (ipCreations.count(ip) >= MAX_CREATIONS_PER_IP || countUsers() >= MAX_USERS) {
      return send(res, 429, { error: 'too many accounts' });
    }
    if (creating.has(user)) return send(res, 409, { error: 'retry' });
    creating.add(user);
    ipCreations.add(ip);
    auth = createUser(user, password)
      .then(function () { creating.delete(user); return true; },
        function (e) { creating.delete(user); throw e; });
  } else if (verified.get(user) === fastHash(user, password)) {
    auth = Promise.resolve(true);
  } else {
    if (ipFailures.count(ip) >= MAX_FAILURES_PER_IP || userFailures.count(user) >= MAX_FAILURES_PER_USER) {
      return send(res, 429, { error: 'too many failures' });
    }
    auth = verifyPassword(user, store, password).then(function (ok) {
      if (!ok) {
        ipFailures.add(ip);
        userFailures.add(user);
        console.log('Échec d\'authentification : ' + user);
      }
      return ok;
    });
  }

  return auth.then(function (ok) {
    if (!ok) return send(res, 401, { error: 'unauthorized' });
    const result = sync(user, stores.get(user), body);
    if (!result) return send(res, 413, { error: 'quota exceeded' });
    send(res, 200, result);
  });
}

const server = http.createServer(function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');

  if (req.method === 'OPTIONS') return send(res, 204);
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
  if (req.method !== 'POST' || req.url !== '/sync') return send(res, 404, { error: 'not found' });

  const chunks = [];
  let size = 0;
  req.on('data', function (c) {
    size += c.length;
    if (size > MAX_BODY) { send(res, 413, { error: 'too large' }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', function () {
    if (res.writableEnded) return;
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (e) {
      return send(res, 400, { error: 'invalid json' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'invalid body' });
    Promise.resolve()
      .then(function () { return handleSync(req, res, body); })
      .catch(function (e) {
        console.error(e);
        if (!res.writableEnded) send(res, 500, { error: 'internal error' });
      });
  });
});

server.headersTimeout = 15 * 1000;
server.requestTimeout = 30 * 1000;
server.keepAliveTimeout = 5 * 1000;

server.listen(PORT, function () {
  console.log('IITC sync en écoute sur :' + PORT);
});
