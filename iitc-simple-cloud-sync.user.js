// ==UserScript==
// @id             iitc-plugin-simple-cloud-sync
// @name           IITC plugin: Simple Cloud Sync (perso)
// @category       Misc
// @version        0.2.0
// @namespace      https://github.com/iitc-project/ingress-intel-total-conversion
// @description    Synchronise les données localStorage des plugins IITC (clés, uniques, bookmarks, etc.) entre vos propres appareils via JSONBin.io.
// @include        https://intel.ingress.com/*
// @match          https://intel.ingress.com/*
// @grant          none
// ==/UserScript==

function wrapper(plugin_info) {
  if (typeof window.plugin !== 'function') window.plugin = function () {};

  window.plugin.simpleCloudSync = function () {};
  const self = window.plugin.simpleCloudSync;

  // ==================== CONFIGURATION - À MODIFIER ====================
  // Sur jsonbin.io : créez un compte gratuit, un Bin (contenu initial: {"ts":0,"data":{}}),
  // puis récupérez l'ID du bin (dans l'URL) et votre X-Master-Key (page "API Keys").
  self.BIN_ID = '6aa45dc1ffd5d16053fba21b';
  self.API_KEY = '***';
  self.ENDPOINT = 'https://api.jsonbin.io/v3/b/' + self.BIN_ID;
  // Fréquence de synchro automatique (millisecondes). 5 min = reste large sous le quota gratuit.
  self.SYNC_INTERVAL_MS = 5 * 60 * 1000;
  // Préfixe des clés localStorage à synchroniser (convention IITC standard)
  self.KEY_PREFIX = 'plugin-';
  // =======================================================================

  self.log = function (msg) {
    console.log('[SimpleCloudSync] ' + msg);
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
    self.fetchRemote()
      .then(function (record) {
        const localTs = self.getLocalTs();
        if ((record.ts || 0) > localTs) {
          self.applySnapshot(record.data);
          self.setLocalTs(record.ts);
          self.log('Données appliquées depuis le cloud (ts=' + record.ts + '). Rechargez la page pour tout prendre en compte.');
        } else {
          self.log('Rien de plus récent côté cloud.');
        }
        if (callback) callback();
      })
      .catch(function (err) {
        self.log('Erreur réseau (pull): ' + err);
        if (callback) callback();
      });
  };

  self.push = function () {
    self.fetchRemote()
      .then(function (record) {
        const localTs = self.getLocalTs();
        if ((record.ts || 0) > localTs) {
          // le cloud a une version plus récente qu'on n'a pas encore : on l'applique
          // plutôt que d'écraser, et on retentera le push au prochain cycle
          self.applySnapshot(record.data);
          self.setLocalTs(record.ts);
          self.log('Version distante plus récente : appliquée localement, push différé.');
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
          self.log('Données envoyées vers le cloud (ts=' + ts + ')');
        });
      })
      .catch(function (err) { self.log('Erreur réseau (push): ' + err); });
  };

  self.syncNow = function () {
    self.log('Synchronisation manuelle...');
    self.pull(function () { self.push(); });
  };

  const setup = function () {
    // Synchro initiale au chargement de la page
    self.pull();

    // Synchro automatique périodique
    setInterval(self.push, self.SYNC_INTERVAL_MS);

    // Bouton manuel dans la barre d'outils IITC
    $('#toolbox').append(
      '<a onclick="window.plugin.simpleCloudSync.syncNow(); return false;" title="Forcer la synchronisation cloud">Sync cloud</a>'
    );
  };

  setup.info = plugin_info;
  if (!window.bootPlugins) window.bootPlugins = [];
  window.bootPlugins.push(setup);
  if (window.iitcLoaded && typeof setup === 'function') setup();
}

// Injection dans le contexte de la page (nécessaire pour IITC Button / Tampermonkey)
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
