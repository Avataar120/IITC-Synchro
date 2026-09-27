// ==UserScript==
// @author          Avataar120
// @id              simplecloudsync@avataar120
// @name            Simple Cloud Sync
// @category        Misc
// @version         1.0.1.20260927
// @description     Syncs the localStorage data of your IITC plugins (bookmarks, draw tools, settings…) across all your devices. Each agent has a private, password-protected space on the sync server, keyed by the logged-in agent name. Per-key merge, most recent change wins; the server is only contacted when something changed.
// @downloadURL     https://github.com/Avataar120/IITC-Synchro/raw/main/iitc-simple-cloud-sync.user.js
// @updateURL       https://github.com/Avataar120/IITC-Synchro/raw/main/iitc-simple-cloud-sync.meta.js
// @icon            https://raw.githubusercontent.com/Avataar120/IITC-Synchro/main/simplecloudsync-32.png
// @icon64          https://raw.githubusercontent.com/Avataar120/IITC-Synchro/main/simplecloudsync-64.png
// @supportURL      https://github.com/Avataar120/IITC-Synchro/issues
// @namespace       https://github.com/Avataar120/IITC-Synchro
// @issueTracker    https://github.com/Avataar120/IITC-Synchro/issues
// @homepageURL     https://github.com/Avataar120/IITC-Synchro/
// @match           https://intel.ingress.com/*
// @include         https://intel.ingress.com/*
// @grant           none
// ==/UserScript==

function wrapper(plugin_info) {
  if (typeof window.plugin !== 'function') window.plugin = function () {};
  plugin_info.buildName = 'main';
  plugin_info.dateTimeVersion = '2026-09-27-152743';
  plugin_info.pluginId = 'simpleCloudSync';

  const changelog = [{
    version: '1.0.1',
    changes: [
      'FIX: Leftover entries from older sync versions are removed from each device and no longer synced.',
    ],
  }, {
    version: '1.0.0',
    changes: [
      'NEW: Own sync server instead of JSONBin.io: no more request quota.',
      'NEW: Multi-agent: each agent has a private space, keyed by the logged-in agent name and protected by a password chosen on first sync.',
      'NEW: Far fewer requests: local changes are detected without any network call, only changed keys are sent, and other devices are checked at most every 10 minutes while the tab is visible.',
      'NEW: Pending changes are sent when the page is hidden or closed.',
    ],
  }];

  window.plugin.simpleCloudSync = function () {};
  const self = window.plugin.simpleCloudSync;

  // ==================== CONFIGURATION ====================
  // URL du serveur de synchro, sans slash final
  self.ENDPOINT = 'https://iitcsimplesync.avataar120.com';
  // Vérification locale des changements (aucun appel réseau si rien n'a changé)
  self.LOCAL_CHECK_MS = 30 * 1000;
  // Récupération des changements des autres appareils, seulement si l'onglet est visible
  self.REMOTE_PULL_MS = 10 * 60 * 1000;
  self.KEY_PREFIX = 'plugin-';
  // Passez à true pour réafficher l'encart de statut sur la carte (diagnostic mobile)
  self.DEBUG = false;
  // =======================================================================

  // Métadonnées : pour chaque clé, la dernière valeur connue-synchronisée + son timestamp.
  // Sert à détecter si une clé a changé localement depuis la dernière synchro,
  // sans dépendre d'un patch de localStorage.setItem (peu fiable selon l'environnement).
  self.META_KEY = 'plugin-simpleCloudSync-meta';
  // Dernière révision serveur vue (hors préfixe KEY_PREFIX : jamais synchronisée)
  self.STATE_KEY = 'simpleCloudSync-state';
  // Mot de passe de l'agent sur ce serveur, propre à cet appareil (jamais synchronisé)
  self.PASSWORD_KEY = 'simpleCloudSync-password';
  // Clés laissées par d'anciennes versions de la synchro : jamais synchronisées, effacées au démarrage
  self.OBSOLETE_KEYS = ['plugin-simpleCloudSync-ts', 'plugin-simpleCloudSync-tsmap', 'plugin-sync-data-uuid'];

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

  // Pseudo de l'agent connecté : chaque agent a son propre espace sur le serveur
  self.getUser = function () {
    return (window.PLAYER && window.PLAYER.nickname) || null;
  };

  self.getState = function () {
    try { return JSON.parse(localStorage.getItem(self.STATE_KEY) || '{}'); } catch (e) { return {}; }
  };

  // Clés à envoyer : celles modifiées depuis la dernière synchro (ts frais),
  // et, au premier contact avec ce serveur, toutes les autres (ts d'origine).
  self.buildChangedEntries = function (meta, firstSync) {
    const entries = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || k.indexOf(self.KEY_PREFIX) !== 0 || k === self.META_KEY) continue;
      if (self.OBSOLETE_KEYS.indexOf(k) !== -1) continue;
      const value = localStorage.getItem(k);
      const prev = meta[k];
      if (!prev || prev.value !== value) {
        entries[k] = { value: value, ts: Date.now() };
      } else if (firstSync) {
        entries[k] = { value: value, ts: prev.ts || 0 };
      }
    }
    return entries;
  };

  self.getPassword = function () {
    return localStorage.getItem(self.PASSWORD_KEY) || '';
  };

  // Le premier appareil qui synchronise un agent choisit son mot de passe ;
  // les appareils suivants doivent saisir le même.
  self.askPassword = function (error) {
    if (self.passwordDialogOpen) return;
    self.passwordDialogOpen = true;
    const html = $('<div>')
      .append($('<p>').text(
        'Mot de passe de synchro pour l\'agent ' + self.getUser() + '. ' +
        'À la première utilisation, il est choisi ici ; sur vos autres appareils, saisissez le même.'
      ))
      .append(error ? $('<p style="color:#f66">').text(error) : '')
      .append('<input type="password" id="simpleCloudSyncPassword" style="width:95%" autocomplete="current-password">');
    window.dialog({
      html: html,
      title: 'Simple Cloud Sync',
      id: 'simpleCloudSyncPassword-dialog',
      buttons: {
        'OK': function () {
          const pw = $('#simpleCloudSyncPassword').val();
          if (!pw || pw.length < 4) return;
          localStorage.setItem(self.PASSWORD_KEY, pw);
          $(this).dialog('close');
          self.syncNow();
        }
      },
      closeCallback: function () { self.passwordDialogOpen = false; }
    });
  };

  self.lastSync = 0;

  self.syncNow = function (manual) {
    const user = self.getUser();
    if (!user) return self.showStatus('Agent inconnu, synchro impossible.');
    const password = self.getPassword();
    if (!password) {
      // Demandé une seule fois par chargement, puis sur clic du bouton
      if (manual || !self.passwordAsked) self.askPassword();
      self.passwordAsked = true;
      return;
    }
    if (self.busy) return;
    self.busy = true;
    self.lastSync = Date.now();
    self.showStatus('Synchronisation...');

    const meta = self.getMeta();
    const state = self.getState();
    const firstSync = state.endpoint !== self.ENDPOINT || state.user !== user;
    const sent = self.buildChangedEntries(meta, firstSync);

    fetch(self.ENDPOINT + '/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + password
      },
      body: JSON.stringify({ user: user, since: firstSync ? 0 : (state.rev || 0), entries: sent })
    })
      .then(function (r) {
        if (r.status === 401) {
          localStorage.removeItem(self.PASSWORD_KEY);
          self.askPassword('Mot de passe incorrect pour cet agent.');
        }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (res) {
        Object.keys(sent).forEach(function (k) { meta[k] = sent[k]; });

        // Le serveur renvoie les clés changées ailleurs, et la version gagnante
        // des clés envoyées qui ont perdu la fusion.
        let appliedCount = 0;
        Object.keys(res.entries).forEach(function (k) {
          if (self.OBSOLETE_KEYS.indexOf(k) !== -1) return;
          const e = res.entries[k];
          if (localStorage.getItem(k) !== e.value) {
            localStorage.setItem(k, e.value);
            appliedCount++;
          }
          meta[k] = { value: e.value, ts: e.ts };
        });

        self.setMeta(meta);
        localStorage.setItem(self.STATE_KEY, JSON.stringify({ endpoint: self.ENDPOINT, user: user, rev: res.rev }));

        self.showStatus(
          'OK : ' + Object.keys(sent).length + ' clé(s) envoyée(s), ' +
          appliedCount + ' reçue(s) du cloud.'
        );
        if (appliedCount > 0) {
          self.showStatus('Rechargez la page pour tout prendre en compte.');
        }
      })
      .catch(function (err) {
        self.showStatus('ERREUR sync: ' + err.message);
      })
      .then(function () { self.busy = false; });
  };

  self.hasLocalChanges = function () {
    return Object.keys(self.buildChangedEntries(self.getMeta(), false)).length > 0;
  };

  // Appelé régulièrement : ne contacte le serveur que s'il y a quelque chose à
  // envoyer, ou si le dernier échange date de plus de REMOTE_PULL_MS (onglet visible).
  self.tick = function () {
    if (self.hasLocalChanges()) return self.syncNow();
    if (!document.hidden && Date.now() - self.lastSync >= self.REMOTE_PULL_MS) self.syncNow();
  };

  // Fermeture de la page : envoi des derniers changements sans attendre de réponse
  // (text/plain => pas de requête préalable CORS).
  self.flushOnExit = function () {
    const user = self.getUser();
    const password = self.getPassword();
    const sent = self.buildChangedEntries(self.getMeta(), false);
    if (!user || !password || !Object.keys(sent).length || !navigator.sendBeacon) return;
    navigator.sendBeacon(self.ENDPOINT + '/sync', JSON.stringify({
      password: password, user: user, since: 0, entries: sent
    }));
  };

  self.removeObsoleteKeys = function () {
    const meta = self.getMeta();
    self.OBSOLETE_KEYS.forEach(function (k) {
      localStorage.removeItem(k);
      delete meta[k];
    });
    self.setMeta(meta);
  };

  const setup = function () {
    self.showStatus('Plugin chargé, démarrage...');
    self.removeObsoleteKeys();
    self.syncNow();
    setInterval(self.tick, self.LOCAL_CHECK_MS);

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) self.flushOnExit();
      else if (Date.now() - self.lastSync >= 2 * 60 * 1000) self.syncNow();
    });
    window.addEventListener('pagehide', self.flushOnExit);

    try {
      $('#toolbox').append(
        '<a onclick="window.plugin.simpleCloudSync.syncNow(true); return false;" title="Forcer la synchronisation cloud">Sync cloud</a>'
      );
    } catch (e) {
      self.showStatus('Impossible d\'ajouter le bouton toolbox.');
    }
  };

  setup.info = plugin_info;
  setup.info.changelog = changelog;
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