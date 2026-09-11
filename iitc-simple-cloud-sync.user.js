// ==UserScript==
// @id             iitc-plugin-simple-cloud-sync
// @name           IITC plugin: Simple Cloud Sync (perso)
// @category       Misc
// @version        3.0.0
// @namespace      https://github.com/iitc-project/ingress-intel-total-conversion
// @description    Synchronise les données localStorage des plugins IITC entre vos appareils via JSONBin.io, avec fusion par clé basée sur la détection de changement de contenu.
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
  self.SYNC_INTERVAL_MS = 1 * 60 * 1000;
  self.KEY_PREFIX = 'plugin-';
  // Passez à true pour réafficher l'encart de statut sur la carte (diagnostic mobile)
  self.DEBUG = false;
  // =======================================================================

  // Métadonnées : pour chaque clé, la dernière valeur connue-synchronisée + son timestamp.
  // Sert à détecter si une clé a changé localement depuis la dernière synchro,
  // sans dépendre d'un patch de localStorage.setItem (peu fiable selon l'environnement).
  self.META_KEY = 'plugin-simpleCloudSync-meta';

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

  self.getMeta = function () {
    try { return JSON.parse(localStorage.getItem(self.META_KEY) || '{}'); } catch (e) { return {}; }
  };

  self.setMeta = function (meta) {
    localStorage.setItem(self.META_KEY, JSON.stringify(meta));
  };

  // Construit l'état local actuel, avec un ts "frais" (Date.now()) pour toute clé
  // dont la valeur a changé depuis la dernière synchro connue (meta), et conserve
  // le ts précédent pour les clés inchangées.
  self.buildLocalEntries = function () {
    const meta = self.getMeta();
    const entries = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || k.indexOf(self.KEY_PREFIX) !== 0 || k === self.META_KEY) continue;
      const value = localStorage.getItem(k);
      const prev = meta[k];
      if (prev && prev.value === value) {
        entries[k] = { value: value, ts: prev.ts || 0 };
      } else {
        // valeur absente des meta, ou différente : changement détecté
        entries[k] = { value: value, ts: Date.now() };
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

  self.syncNow = function () {
    self.showStatus('Synchronisation...');
    self.fetchRemote()
      .then(function (remoteEntries) {
        const localEntries = self.buildLocalEntries();
        const merged = {};
        const newMeta = {};
        let appliedCount = 0;

        const allKeys = new Set(
          Object.keys(localEntries).concat(Object.keys(remoteEntries))
        );

        allKeys.forEach(function (k) {
          const local = localEntries[k];
          const remote = remoteEntries[k];

          if (remote && (!local || remote.ts > local.ts)) {
            // le cloud a une version plus récente (ou clé absente localement)
            localStorage.setItem(k, remote.value);
            merged[k] = remote;
            newMeta[k] = { value: remote.value, ts: remote.ts };
            appliedCount++;
          } else if (local) {
            merged[k] = local;
            newMeta[k] = { value: local.value, ts: local.ts };
          } else if (remote) {
            merged[k] = remote;
            newMeta[k] = { value: remote.value, ts: remote.ts };
          }
        });

        self.setMeta(newMeta);

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