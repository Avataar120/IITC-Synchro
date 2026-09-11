// ==UserScript==
// @id             iitc-plugin-simple-cloud-sync
// @name           IITC plugin: Simple Cloud Sync (perso)
// @category       Misc
// @version        0.3.0
// @namespace      https://github.com/iitc-project/ingress-intel-total-conversion
// @description    Synchronise les données localStorage des plugins IITC (clés, uniques, bookmarks, etc.) entre vos propres appareils via JSONBin.io. Affiche son statut directement sur la carte (utile sur mobile sans console).
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
  // =======================================================================

  // ---- Indicateur visuel sur la carte (pas besoin de console) ----
  self.showStatus = function (msg) {
    console.log('[SimpleCloudSync] ' + msg);
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
  };

  self.getLocalSnapshot = function () {
    const snap = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(self.KEY_PREFIX) === 0 && k !== 'plugin-simpleCloudSync-ts') {
        snap[k] = localStorage.getItem(k);
      }
    }
    return snap;
  };

  self.applySnapshot = function (snap) {
    Object.keys(snap || {}).forEach(function (k) {
      localStorage.setItem(k, snap[k]);
    });
  };

  self.getLocalTs = function () {
    return Number(localStorage.getItem('plugin-simpleCloudSync-ts') || 0);
  };

  self.setLocalTs = function (ts) {
    localStorage.setItem('plugin-simpleCloudSync-ts', String(ts));
  };

  self.fetchRemote = function () {
    return fetch(self.ENDPOINT + '/latest', {
      headers: { 'X-Master-Key': self.API_KEY }
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (res) {
      return res.record || { ts: 0, data: {} };
    });
  };

  self.pull = function (callback) {
    self.showStatus('Pull en cours...');
    self.fetchRemote()
      .then(function (record) {
        const localTs = self.getLocalTs();
        if ((record.ts || 0) > localTs) {
          self.applySnapshot(record.data);
          self.setLocalTs(record.ts);
          self.showStatus('Appliqué depuis le cloud (ts=' + record.ts + '). Rechargez pour tout voir.');
        } else {
          self.showStatus('OK, rien de plus récent côté cloud (local ts=' + localTs + ', cloud ts=' + (record.ts || 0) + ').');
        }
        if (callback) callback();
      })
      .catch(function (err) {
        self.showStatus('ERREUR pull: ' + err.message);
        if (callback) callback();
      });
  };

  self.push = function () {
    self.showStatus('Push en cours...');
    self.fetchRemote()
      .then(function (record) {
        const localTs = self.getLocalTs();
        if ((record.ts || 0) > localTs) {
          self.applySnapshot(record.data);
          self.setLocalTs(record.ts);
          self.showStatus('Version distante plus récente : appliquée, push différé.');
          return null;
        }
        const ts = Date.now();
        const body = { ts: ts, data: self.getLocalSnapshot() };
        return fetch(self.ENDPOINT, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-Master-Key': self.API_KEY,
            'X-Bin-Versioning': 'false'
          },
          body: JSON.stringify(body)
        }).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        }).then(function () {
          self.setLocalTs(ts);
          self.showStatus('Envoyé vers le cloud (ts=' + ts + ')');
        });
      })
      .catch(function (err) { self.showStatus('ERREUR push: ' + err.message); });
  };

  self.syncNow = function () {
    self.pull(function () { self.push(); });
  };

  const setup = function () {
    self.showStatus('Plugin chargé, démarrage...');
    self.pull();
    setInterval(self.push, self.SYNC_INTERVAL_MS);
    $('#toolbox').append(
      '<a onclick="window.plugin.simpleCloudSync.syncNow(); return false;" title="Forcer la synchronisation cloud">Sync cloud</a>'
    );
  };

  setup.info = plugin_info;
  if (!window.bootPlugins) window.bootPlugins = [];
  window.bootPlugins.push(setup);
  if (window.iitcLoaded && typeof setup === 'function') setup();
}

const script = document.createElement('script');
const info = {};
if (typeof GM_info !== 'undefined' && GM_info && GM_info.script) {
  info.script = {
    version: GM_info.script.version,
    name: GM_info.script.name,
    description: GM_info.script.description
  };
}
script.appendChild(document.createTextNode('(' + wrapper + ')(' + JSON.stringify(info) + ');'));
(document.body || document.head || document.documentElement).appendChild(script);