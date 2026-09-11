// ==UserScript==
// @id             iitc-plugin-simple-cloud-sync
// @name           IITC plugin: Simple Cloud Sync (perso)
// @category       Misc
// @version        2.0.0
// @namespace      https://github.com/iitc-project/ingress-intel-total-conversion
// @description    Synchronise les données localStorage des plugins IITC entre vos appareils via JSONBin.io, avec fusion par clé (pas de remplacement en bloc).
// @include        https://intel.ingress.com/*
// @match          https://intel.ingress.com/*
// @grant          none
// ==/UserScript==

function wrapper(plugin_info) {
  if (typeof window.plugin !== 'function') window.plugin = function () {};

  window.plugin.simpleCloudSync = function () {};
  const self = window.plugin.simpleCloudSync;

  // ==================== CONFIGURATION - À MODIFIER ====================
  self.BIN_ID = '6aa45dc1ffd5d16053fba21b';
  self.API_KEY = '***';
  self.ENDPOINT = 'https://api.jsonbin.io/v3/b/' + self.BIN_ID;
  self.SYNC_INTERVAL_MS = 5 * 60 * 1000;
  self.KEY_PREFIX = 'plugin-';
  // Passez à true pour réafficher l'encart de statut sur la carte (diagnostic mobile)
  self.DEBUG = true;
  // =======================================================================

  self.TS_MAP_KEY = 'plugin-simpleCloudSync-tsmap';
  self.origSetItem = localStorage.setItem.bind(localStorage);

  self.showStatus = function (msg) {
    console.log('[SimpleCloudSync] ' + msg);
    if (!self.DEBUG) return;
    try {
      let el = document.getElementById('simpleCloudSyncStatus');
      if (!el) {
        el = document.createElement('div');
        el.id = 'simpleCloudSyncStatus';
        el.style.cssText = [
          'position:fixed', 'bottom:6px', 'left:6px', 'z-index:99999',
          'background:rgba(0,0,0,0.85)', 'color:#ffce00', 'font-size:11px',
          'font-family:sans-serif', 'padding:4px 8px', 'border-radius:4px',
          'max-width:85vw', 'white-space:pre-wrap', 'pointer-events:none'
        ].join(';');
        (document.body || document.documentElement).appendChild(el);
      }
      const time = new Date().toLocaleTimeString();
      el.textContent = '[Sync ' + time + '] ' + msg;
    } catch (e) { /* ignore */ }
  };

  // ---- Suivi des modifications par clé (timestamp individuel par clé) ----

  self.getTsMap = function () {
    try { return JSON.parse(localStorage.getItem(self.TS_MAP_KEY) || '{}'); } catch (e) { return {}; }
  };

  self.setTsMap = function (map) {
    self.origSetItem(self.TS_MAP_KEY, JSON.stringify(map));
  };

  self.touchKey = function (key, ts) {
    const map = self.getTsMap();
    map[key] = ts || Date.now();
    self.setTsMap(map);
  };

  // Intercepte les écritures localStorage des autres plugins (Keys, Uniques, DrawTools...)
  // pour horodater chaque clé individuellement dès qu'elle change.
  self.patchLocalStorage = function () {
    if (self._patched) return;
    self._patched = true;
    localStorage.setItem = function (key, value) {
      self.origSetItem(key, value);
      if (typeof key === 'string' && key.indexOf(self.KEY_PREFIX) === 0 && key !== self.TS_MAP_KEY) {
        self.touchKey(key);
      }
    };
  };

  // Au premier lancement, les clés déjà présentes n'ont pas d'horodatage connu :
  // on les marque comme "inconnu" (0) pour laisser la priorité à une version distante réelle.
  self.initTsMapForExistingKeys = function () {
    const map = self.getTsMap();
    let changed = false;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(self.KEY_PREFIX) === 0 && k !== self.TS_MAP_KEY && !(k in map)) {
        map[k] = 0;
        changed = true;
      }
    }
    if (changed) self.setTsMap(map);
  };

  self.buildLocalEntries = function () {
    const tsMap = self.getTsMap();
    const entries = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(self.KEY_PREFIX) === 0 && k !== self.TS_MAP_KEY) {
        entries[k] = { value: localStorage.getItem(k), ts: tsMap[k] || 0 };
      }
    }
    return entries;
  };

  self.fetchRemote = function () {
    return fetch(self.ENDPOINT + '/latest', {
      headers: { 'X-Master-Key': self.API_KEY }
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (res) {
      return (res.record && res.record.data) || {};
    });
  };

  self.pushMerged = function (merged) {
    return fetch(self.ENDPOINT, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': self.API_KEY,
        'X-Bin-Versioning': 'false'
      },
      body: JSON.stringify({ ts: Date.now(), data: merged })
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  };

  // Synchro complète : fusionne clé par clé (pas de remplacement en bloc),
  // applique localement ce qui vient du cloud si plus récent, puis renvoie
  // le résultat fusionné pour que le cloud reflète aussi les deux côtés.
  self.syncNow = function () {
    self.showStatus('Synchronisation...');
    self.fetchRemote()
      .then(function (remoteEntries) {
        const localEntries = self.buildLocalEntries();
        const tsMap = self.getTsMap();
        let appliedCount = 0;
        const merged = {};

        const allKeys = new Set(
          Object.keys(localEntries).concat(Object.keys(remoteEntries))
        );

        allKeys.forEach(function (k) {
          const local = localEntries[k];
          const remote = remoteEntries[k];

          if (remote && (!local || remote.ts > local.ts)) {
            // le cloud a une version plus récente (ou la clé n'existe pas encore localement)
            self.origSetItem(k, remote.value);
            tsMap[k] = remote.ts;
            merged[k] = remote;
            appliedCount++;
          } else if (local) {
            // la version locale est la plus récente (ou seule à exister)
            merged[k] = local;
          } else if (remote) {
            merged[k] = remote;
          }
        });

        self.setTsMap(tsMap);

        return self.pushMerged(merged).then(function () {
          self.showStatus(
            'OK : ' + appliedCount + ' clé(s) reçue(s) du cloud, ' +
            Object.keys(merged).length + ' au total synchronisées.'
          );
          if (appliedCount > 0) {
            self.showStatus('Rechargez la page pour tout prendre en compte.');
          }
        });
      })
      .catch(function (err) {
        self.showStatus('ERREUR sync: ' + err.message);
      });
  };

  const setup = function () {
    self.patchLocalStorage();
    self.initTsMapForExistingKeys();

    self.showStatus('Plugin chargé, démarrage...');
    self.syncNow();
    setInterval(self.syncNow, self.SYNC_INTERVAL_MS);

    try {
      $('#toolbox').append(
        '<a onclick="window.plugin.simpleCloudSync.syncNow(); return false;" title="Forcer la synchronisation cloud">Sync cloud</a>'
      );
    } catch (e) {
      self.showStatus('Impossible d\'ajouter le bouton toolbox.');
    }
  };

  // Patch appliqué immédiatement (avant même setup) pour capter les écritures
  // des autres plugins dès que possible après le chargement de la page.
  self.patchLocalStorage();

  setup.info = plugin_info;
  if (!window.bootPlugins) window.bootPlugins = [];
  window.bootPlugins.push(setup);
  if (window.iitcLoaded && typeof setup === 'function') setup();
}

// Exécution directe (sans injection <script>, non nécessaire et bloquée sur certains mobiles)
var plugin_info = {};
if (typeof GM_info !== 'undefined' && GM_info && GM_info.script) {
  plugin_info.script = {
    version: GM_info.script.version,
    name: GM_info.script.name,
    description: GM_info.script.description
  };
}
wrapper(plugin_info);