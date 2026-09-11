// ==UserScript==
// @id             iitc-plugin-simple-cloud-sync
// @name           IITC plugin: Simple Cloud Sync (perso)
// @category       Misc
// @version        0.1.0
// @namespace      https://github.com/iitc-project/ingress-intel-total-conversion
// @description    Synchronise les données localStorage des plugins IITC (clés, uniques, bookmarks, etc.) entre vos propres appareils via un petit backend Google Apps Script.
// @include        https://intel.ingress.com/*
// @match          https://intel.ingress.com/*
// @grant          none
// ==/UserScript==

function wrapper(plugin_info) {
  if (typeof window.plugin !== 'function') window.plugin = function () {};

  window.plugin.simpleCloudSync = function () {};
  const self = window.plugin.simpleCloudSync;

  // ==================== CONFIGURATION - À MODIFIER ====================
  // Collez ici l'URL "/exec" obtenue après déploiement du Apps Script
  self.ENDPOINT = 'https://script.google.com/macros/s/AKfycbyymk0Uz8dOKYDnAUipHIZaQPuiPsTsB4mIkUVbd2kUOri5HLkk7T0jRCca2Lnx86U/exec';
  // Doit être identique au TOKEN défini côté Apps Script
  self.TOKEN = 'Diligence-Hurried-Anthem-Tacky-Expensive-Yeast9';
  // Fréquence de synchro automatique (millisecondes)
  self.SYNC_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
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
    Object.keys(snap).forEach(function (k) {
      localStorage.setItem(k, snap[k]);
    });
  };

  self.getLocalTs = function () {
    return Number(localStorage.getItem('plugin-simpleCloudSync-ts') || 0);
  };

  self.setLocalTs = function (ts) {
    localStorage.setItem('plugin-simpleCloudSync-ts', String(ts));
  };

  self.pull = function (callback) {
    fetch(self.ENDPOINT + '?token=' + encodeURIComponent(self.TOKEN))
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res.error) {
          self.log('Erreur pull: ' + res.error);
        } else {
          const localTs = self.getLocalTs();
          if (res.ts > localTs) {
            self.applySnapshot(res.data);
            self.setLocalTs(res.ts);
            self.log('Données appliquées depuis le cloud (ts=' + res.ts + '). Rechargez la page pour tout prendre en compte.');
          } else {
            self.log('Rien de plus récent côté cloud.');
          }
        }
        if (callback) callback();
      })
      .catch(function (err) {
        self.log('Erreur réseau (pull): ' + err);
        if (callback) callback();
      });
  };

  self.push = function () {
    const ts = Date.now();
    const body = {
      token: self.TOKEN,
      ts: ts,
      data: self.getLocalSnapshot()
    };
    fetch(self.ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // évite le preflight CORS
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res.error === 'stale') {
          self.log('Le cloud a une version plus récente : on la récupère puis on réessaie.');
          self.pull(function () { self.push(); });
          return;
        }
        if (res.error) {
          self.log('Erreur push: ' + res.error);
          return;
        }
        self.setLocalTs(res.ts);
        self.log('Données envoyées vers le cloud (ts=' + res.ts + ')');
      })
      .catch(function (err) { self.log('Erreur réseau (push): ' + err); });
  };

  self.syncNow = function () {
    self.log('Synchronisation manuelle...');
    self.pull(function () { self.push(); });
  };

  const setup = function () {
    // Synchro initiale au chargement de la page (récupère les données des autres appareils)
    self.pull();

    // Synchro automatique périodique (envoi des changements locaux)
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
