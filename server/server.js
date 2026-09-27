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
// Compte administrateur, hors du dossier des agents
const ADMIN_FILE = process.env.ADMIN_FILE || path.join(path.dirname(DATA_DIR), 'admin.json');
const ADMIN_DIR = path.join(__dirname, 'admin');

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
    reset: function (key) { map.delete(key); },
    purge: function () {
      const now = Date.now();
      map.forEach(function (e, k) { if (now - e.since > windowMs) map.delete(k); });
    }
  };
}

const ipFailures = makeCounter(WINDOW_MS);
const userFailures = makeCounter(WINDOW_MS);
const ipCreations = makeCounter(CREATION_WINDOW_MS);
setInterval(function () {
  ipFailures.purge(); userFailures.purge(); ipCreations.purge(); purgeSessions();
}, 60 * 1000).unref();

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

// ---- Administration ----

// Compte admin : { user, auth: { salt, hash, N }, isDefault }
// Créé au premier démarrage à partir de ADMIN_USER / ADMIN_PASSWORD (fichier .env non versionné),
// puis modifiable depuis la page admin. Sans ces variables ni compte existant, la page admin est désactivée.
const DEFAULT_ADMIN = { user: process.env.ADMIN_USER || '', password: process.env.ADMIN_PASSWORD || '' };
const SESSION_TTL = 8 * 60 * 60 * 1000;
const RESET_PASSWORD_LENGTH = 12;
const RESET_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

let admin = null;
const sessions = new Map(); // jeton -> expiration

function saveAdmin() {
  fs.mkdirSync(path.dirname(ADMIN_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(ADMIN_FILE + '.tmp', JSON.stringify(admin), { mode: 0o600 });
  fs.renameSync(ADMIN_FILE + '.tmp', ADMIN_FILE);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return scrypt(password, salt, SCRYPT.N).then(function (key) {
    return { salt: salt, hash: key.toString('hex'), N: SCRYPT.N };
  });
}

function checkPassword(auth, password) {
  return scrypt(password, auth.salt, auth.N || SCRYPT.N).then(function (key) {
    return crypto.timingSafeEqual(key, Buffer.from(auth.hash, 'hex'));
  });
}

function loadAdmin() {
  try {
    admin = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
    return Promise.resolve();
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (!DEFAULT_ADMIN.user || !DEFAULT_ADMIN.password) {
    console.log('Page admin désactivée : ADMIN_USER et ADMIN_PASSWORD absents');
    return Promise.resolve();
  }
  return hashPassword(DEFAULT_ADMIN.password).then(function (auth) {
    admin = { user: DEFAULT_ADMIN.user, auth: auth, isDefault: true };
    saveAdmin();
    console.log('Compte admin créé avec les identifiants par défaut');
  });
}

function purgeSessions() {
  const now = Date.now();
  sessions.forEach(function (exp, t) { if (exp < now) sessions.delete(t); });
}

function adminSession(req) {
  const header = String(req.headers.authorization || '');
  const token = header.indexOf('Bearer ') === 0 ? header.slice(7) : '';
  const exp = token && sessions.get(token);
  if (!exp || exp < Date.now()) return null;
  return token;
}

// Lecture d'un agent sans le garder en mémoire s'il n'y est pas déjà
function readStore(user) {
  if (stores.has(user)) return stores.get(user);
  try {
    const raw = JSON.parse(fs.readFileSync(userFile(user), 'utf8'));
    return { auth: raw.auth || null, rev: Number(raw.rev) || 0, entries: raw.entries || {} };
  } catch (e) {
    return null;
  }
}

// Nom du plugin d'une clé localStorage : "plugin-bookmarks-portals" -> "bookmarks"
function pluginOf(key) {
  const rest = key.indexOf('plugin-') === 0 ? key.slice(7) : key;
  return rest.split('-')[0] || rest;
}

function agentSummary(user, store) {
  const plugins = Object.create(null);
  let total = 0;
  let lastChange = 0;
  Object.keys(store.entries).forEach(function (k) {
    const e = store.entries[k];
    const size = Buffer.byteLength(k, 'utf8') + Buffer.byteLength(String(e.value), 'utf8');
    const name = pluginOf(k);
    if (!plugins[name]) plugins[name] = { name: name, size: 0, keys: [] };
    plugins[name].size += size;
    plugins[name].keys.push({ key: k, size: size });
    total += size;
    if (e.ts > lastChange) lastChange = e.ts;
  });
  const list = Object.keys(plugins).map(function (n) {
    // Nom affiché : préfixe commun des clés du groupe ("draw-tools-layer" + "draw-tools-options" -> "draw-tools")
    const parts = plugins[n].keys.map(function (k) { return k.key.replace(/^plugin-/, '').split('-'); });
    let common = parts[0];
    parts.forEach(function (p) {
      let i = 0;
      while (i < common.length && i < p.length && common[i] === p[i]) i++;
      common = common.slice(0, i);
    });
    if (parts.length > 1 && common.length > 1) plugins[n].name = common.join('-');
    return plugins[n];
  });
  list.sort(function (a, b) { return b.size - a.size; });
  list.forEach(function (p) { p.keys.sort(function (a, b) { return b.size - a.size; }); });
  return {
    user: user,
    size: total,
    keyCount: Object.keys(store.entries).length,
    lastChange: lastChange,
    plugins: list
  };
}

function listAgents() {
  let files = [];
  try { files = fs.readdirSync(DATA_DIR); } catch (e) { /* dossier absent : aucun agent */ }
  const agents = [];
  files.forEach(function (f) {
    const m = /^([a-z0-9_]{1,40})\.json$/.exec(f);
    if (!m) return;
    const store = readStore(m[1]);
    if (store) agents.push(agentSummary(m[1], store));
  });
  agents.sort(function (a, b) { return a.user < b.user ? -1 : 1; });
  return { agents: agents, limits: { store: MAX_STORE, entries: MAX_ENTRIES } };
}

function randomPassword() {
  const bytes = crypto.randomBytes(RESET_PASSWORD_LENGTH);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += RESET_ALPHABET[bytes[i] % RESET_ALPHABET.length];
  return out;
}

// Remplace le mot de passe d'un agent par un mot de passe temporaire, à saisir
// par l'agent dans le plugin sur chacun de ses appareils.
function resetAgentPassword(user) {
  const store = loadStore(user);
  if (!store) return Promise.resolve(null);
  const password = randomPassword();
  return hashPassword(password).then(function (auth) {
    store.auth = auth;
    save(user);
    verified.delete(user);
    userFailures.reset(user);
    console.log('Mot de passe réinitialisé par l\'admin : ' + user);
    return password;
  });
}

function handleAdminApi(req, res, route, body) {
  const ip = clientIp(req);
  if (!admin) return send(res, 503, { error: 'admin disabled' });

  if (route === 'login') {
    if (ipFailures.count(ip) >= MAX_FAILURES_PER_IP) return send(res, 429, { error: 'too many failures' });
    const user = String(body.user || '');
    const password = String(body.password || '');
    if (!password || password.length > MAX_PASSWORD) return send(res, 401, { error: 'unauthorized' });
    return checkPassword(admin.auth, password).then(function (ok) {
      if (!ok || user.toLowerCase() !== admin.user.toLowerCase()) {
        ipFailures.add(ip);
        console.log('Échec de connexion admin depuis ' + ip);
        return send(res, 401, { error: 'unauthorized' });
      }
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, Date.now() + SESSION_TTL);
      send(res, 200, { token: token, user: admin.user, isDefault: !!admin.isDefault });
    });
  }

  const token = adminSession(req);
  if (!token) return send(res, 401, { error: 'unauthorized' });

  if (route === 'logout') {
    sessions.delete(token);
    return send(res, 200, { ok: true });
  }

  if (route === 'agents') {
    return send(res, 200, Object.assign({ admin: { user: admin.user, isDefault: !!admin.isDefault } }, listAgents()));
  }

  if (route === 'reset-password') {
    const user = String(body.user || '').toLowerCase();
    if (!USER_RE.test(user)) return send(res, 400, { error: 'invalid user' });
    return resetAgentPassword(user).then(function (password) {
      if (!password) return send(res, 404, { error: 'unknown agent' });
      send(res, 200, { user: user, password: password });
    });
  }

  if (route === 'password') {
    const current = String(body.current || '');
    const next = String(body.password || '');
    if (next.length < MIN_NEW_PASSWORD || next.length > MAX_PASSWORD) {
      return send(res, 400, { error: 'weak password', min: MIN_NEW_PASSWORD });
    }
    if (ipFailures.count(ip) >= MAX_FAILURES_PER_IP) return send(res, 429, { error: 'too many failures' });
    return checkPassword(admin.auth, current).then(function (ok) {
      if (!ok) {
        ipFailures.add(ip);
        return send(res, 403, { error: 'wrong password' });
      }
      return hashPassword(next).then(function (auth) {
        admin.auth = auth;
        admin.isDefault = false;
        saveAdmin();
        // Les autres sessions ouvertes sont fermées
        sessions.forEach(function (exp, t) { if (t !== token) sessions.delete(t); });
        console.log('Mot de passe admin changé');
        send(res, 200, { ok: true });
      });
    });
  }

  return send(res, 404, { error: 'not found' });
}

// Fichiers statiques de la page admin, chargés au démarrage
const ADMIN_FILES = Object.assign(Object.create(null), {
  '/admin/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/admin/admin.js': { file: 'admin.js', type: 'text/javascript; charset=utf-8' },
  '/admin/admin.css': { file: 'admin.css', type: 'text/css; charset=utf-8' },
  '/admin/favicon.png': { file: 'favicon.png', type: 'image/png' }
});
Object.keys(ADMIN_FILES).forEach(function (url) {
  const f = ADMIN_FILES[url];
  try { f.content = fs.readFileSync(path.join(ADMIN_DIR, f.file)); } catch (e) { f.content = null; }
});

function serveAdminFile(res, url) {
  const f = ADMIN_FILES[url];
  if (!f.content) return send(res, 404, { error: 'not found' });
  res.setHeader('Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; " +
    "form-action 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.writeHead(200, { 'Content-Type': f.type });
  res.end(f.content);
}

// ---- HTTP ----

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(obj === undefined ? '' : JSON.stringify(obj));
}

function readBody(req, res, handler) {
  const chunks = [];
  let size = 0;
  req.on('data', function (c) {
    size += c.length;
    if (size > MAX_BODY) { send(res, 413, { error: 'too large' }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', function () {
    if (res.writableEnded) return;
    let body = {};
    if (chunks.length) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (e) {
        return send(res, 400, { error: 'invalid json' });
      }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'invalid body' });
    Promise.resolve()
      .then(function () { return handler(body); })
      .catch(function (e) {
        console.error(e);
        if (!res.writableEnded) send(res, 500, { error: 'internal error' });
      });
  });
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
  const url = req.url.split('?')[0];
  // La page admin n'est accessible que depuis sa propre origine
  const isAdmin = url === '/admin' || url.indexOf('/admin/') === 0;
  if (!isAdmin) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');

  if (req.method === 'OPTIONS') return send(res, 204);
  if (req.method === 'GET' && url === '/health') return send(res, 200, { ok: true });

  if (isAdmin) {
    if (req.method === 'GET' && url === '/admin') {
      res.writeHead(301, { Location: '/admin/' });
      return res.end();
    }
    if (req.method === 'GET' && ADMIN_FILES[url]) return serveAdminFile(res, url);
    const api = /^\/admin\/api\/([a-z-]+)$/.exec(url);
    if (api && (req.method === 'POST' || (req.method === 'GET' && api[1] === 'agents'))) {
      return readBody(req, res, function (body) { return handleAdminApi(req, res, api[1], body); });
    }
    return send(res, 404, { error: 'not found' });
  }

  if (req.method !== 'POST' || url !== '/sync') return send(res, 404, { error: 'not found' });
  readBody(req, res, function (body) { return handleSync(req, res, body); });
});

server.headersTimeout = 15 * 1000;
server.requestTimeout = 30 * 1000;
server.keepAliveTimeout = 5 * 1000;

Promise.resolve().then(loadAdmin).then(function () {
  server.listen(PORT, function () {
    console.log('IITC sync en écoute sur :' + PORT);
  });
}, function (e) {
  console.error(e);
  process.exit(1);
});
