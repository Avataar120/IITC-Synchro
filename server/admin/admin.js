// Page d'administration du serveur Simple Cloud Sync
'use strict';

(function () {
  const TOKEN_KEY = 'scs-admin-token';
  const $ = function (id) { return document.getElementById(id); };

  let token = null;
  let data = null;
  let resetUser = null;

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return token; }
  }

  function setToken(t) {
    token = t;
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* stockage indisponible : jeton gardé en mémoire */ }
  }

  function api(route, body) {
    const opts = { method: body ? 'POST' : 'GET', headers: {} };
    const t = getToken() || token;
    if (t) opts.headers.Authorization = 'Bearer ' + t;
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch('api/' + route, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (json) {
        if (r.status === 401 && route !== 'login') {
          setToken(null);
          showLogin();
        }
        if (!r.ok) {
          const err = new Error(json.error || ('HTTP ' + r.status));
          err.status = r.status;
          err.body = json;
          throw err;
        }
        return json;
      });
    });
  }

  // ---- Formatage ----

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }

  function formatDate(ts) {
    if (!ts) return 'never';
    const d = new Date(ts);
    const diff = Date.now() - ts;
    if (diff < 60 * 1000) return 'just now';
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' min ago';
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' h ago';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function bar(ratio) {
    const b = el('div', 'bar');
    const s = el('span');
    s.style.width = Math.min(100, Math.max(0, ratio * 100)).toFixed(1) + '%';
    b.appendChild(s);
    return b;
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2500);
  }

  // ---- Vues ----

  function showLogin() {
    $('mainView').hidden = true;
    $('nav').hidden = true;
    $('loginView').hidden = false;
    closeDialogs();
    const input = $('loginForm').elements.user;
    if (!input.value) input.focus(); else $('loginForm').elements.password.focus();
  }

  function showMain() {
    $('loginView').hidden = true;
    $('mainView').hidden = false;
    $('nav').hidden = false;
    load();
  }

  function closeDialogs() {
    ['passwordDialog', 'resetDialog'].forEach(function (id) { if ($(id).open) $(id).close(); });
  }

  function load() {
    return api('agents').then(function (res) {
      data = res;
      $('whoami').textContent = res.admin.user;
      $('defaultWarning').hidden = !res.admin.isDefault;
      render();
    }).catch(function (e) {
      if (e.status !== 401) toast('Could not load agents: ' + e.message);
    });
  }

  function renderStats(agents) {
    const total = agents.reduce(function (s, a) { return s + a.size; }, 0);
    const pluginNames = new Set();
    agents.forEach(function (a) { a.plugins.forEach(function (p) { pluginNames.add(p.name); }); });
    const stats = [
      ['Agents', String(agents.length)],
      ['Plugins', String(pluginNames.size)],
      ['Total data', formatSize(total)]
    ];
    const box = $('stats');
    box.textContent = '';
    stats.forEach(function (s) {
      const d = el('div', 'stat');
      d.appendChild(el('div', 'label', s[0]));
      d.appendChild(el('div', 'value', s[1]));
      box.appendChild(d);
    });
  }

  function renderAgent(a, limits, filter) {
    const matchAgent = !filter || a.user.indexOf(filter) !== -1;
    const plugins = matchAgent ? a.plugins : a.plugins.filter(function (p) {
      return p.name.toLowerCase().indexOf(filter) !== -1 ||
        p.keys.some(function (k) { return k.key.toLowerCase().indexOf(filter) !== -1; });
    });
    if (!matchAgent && !plugins.length) return null;

    const card = el('div', 'agent');
    const head = el('div', 'agent-head');
    const summary = el('div', 'summary');
    summary.tabIndex = 0;
    summary.setAttribute('role', 'button');
    summary.appendChild(el('div', 'agent-name', a.user));
    summary.appendChild(el('div', 'agent-meta',
      a.plugins.length + ' plugin' + (a.plugins.length === 1 ? '' : 's') + ' · ' +
      a.keyCount + ' key' + (a.keyCount === 1 ? '' : 's') + ' · ' +
      formatSize(a.size) + ' of ' + formatSize(limits.store) + ' · last change ' + formatDate(a.lastChange)));
    const quota = el('div', 'quota');
    quota.appendChild(bar(a.size / limits.store));
    summary.appendChild(quota);
    head.appendChild(summary);

    const reset = el('button', 'ghost small', 'Reset password');
    reset.type = 'button';
    reset.addEventListener('click', function () { openReset(a.user); });
    head.appendChild(reset);

    const list = el('div', 'plugins');
    if (!plugins.length) list.appendChild(el('p', 'muted', 'No synced data.'));
    const maxSize = plugins.reduce(function (m, p) { return Math.max(m, p.size); }, 0) || 1;
    plugins.forEach(function (p) {
      const row = el('div', 'plugin');
      row.appendChild(el('div', 'plugin-name', p.name));
      row.appendChild(el('div', 'plugin-size', formatSize(p.size)));
      row.appendChild(bar(p.size / maxSize));
      row.appendChild(el('div', 'plugin-keys', p.keys.map(function (k) {
        return k.key + ' (' + formatSize(k.size) + ')';
      }).join(' · ')));
      list.appendChild(row);
    });

    card.appendChild(head);
    card.appendChild(list);

    // Le résumé ouvre/ferme la liste des plugins ; ouverte d'office quand le filtre porte sur un plugin
    const setOpen = function (open) {
      card.classList.toggle('open', open);
      list.hidden = !open;
      summary.setAttribute('aria-expanded', String(open));
    };
    setOpen(!!filter && !matchAgent);
    summary.addEventListener('click', function () { setOpen(list.hidden); });
    summary.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setOpen(list.hidden); }
    });
    return card;
  }

  function render() {
    if (!data) return;
    const filter = $('filter').value.trim().toLowerCase();
    renderStats(data.agents);
    const box = $('agents');
    box.textContent = '';
    let shown = 0;
    const agents = data.agents.slice().sort(function (a, b) { return b.lastChange - a.lastChange; });
    agents.forEach(function (a) {
      const card = renderAgent(a, data.limits, filter);
      if (card) { box.appendChild(card); shown++; }
    });
    $('empty').hidden = shown > 0;
    $('empty').textContent = data.agents.length ? 'No match.' : 'No agent yet.';
  }

  // ---- Réinitialisation du mot de passe d'un agent ----

  function openReset(user) {
    resetUser = user;
    document.querySelectorAll('.reset-user').forEach(function (n) { n.textContent = user; });
    $('resetConfirm').hidden = false;
    $('resetDone').hidden = true;
    $('resetError').hidden = true;
    $('btnResetConfirm').disabled = false;
    $('resetDialog').showModal();
  }

  function confirmReset() {
    $('btnResetConfirm').disabled = true;
    api('reset-password', { user: resetUser }).then(function (res) {
      $('resetPassword').textContent = res.password;
      $('resetConfirm').hidden = true;
      $('resetDone').hidden = false;
    }).catch(function (e) {
      $('btnResetConfirm').disabled = false;
      $('resetError').textContent = 'Reset failed: ' + e.message;
      $('resetError').hidden = false;
    });
  }

  function copyPassword() {
    const text = $('resetPassword').textContent;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(function () { toast('Password copied'); },
        function () { toast('Copy failed, select the text instead'); });
    } else {
      toast('Copy unavailable, select the text instead');
    }
  }

  // ---- Mot de passe admin ----

  function openPassword() {
    $('passwordForm').reset();
    $('passwordError').hidden = true;
    $('passwordDialog').showModal();
  }

  function submitPassword(ev) {
    ev.preventDefault();
    const f = ev.target.elements;
    const err = $('passwordError');
    const fail = function (msg) { err.textContent = msg; err.hidden = false; };
    if (f.password.value !== f.confirm.value) return fail('The new passwords do not match.');
    api('password', { current: f.current.value, password: f.password.value }).then(function () {
      $('passwordDialog').close();
      toast('Admin password changed');
      load();
    }).catch(function (e) {
      if (e.status === 403) fail('Current password is wrong.');
      else if (e.status === 429) fail('Too many attempts, try again later.');
      else if (e.body && e.body.error === 'weak password') fail('The new password must be at least ' + e.body.min + ' characters long.');
      else fail('Error: ' + e.message);
    });
  }

  // ---- Connexion ----

  function submitLogin(ev) {
    ev.preventDefault();
    const f = ev.target.elements;
    const err = $('loginError');
    err.hidden = true;
    api('login', { user: f.user.value.trim(), password: f.password.value }).then(function (res) {
      setToken(res.token);
      f.password.value = '';
      showMain();
    }).catch(function (e) {
      err.textContent = e.status === 429 ? 'Too many attempts, try again later.'
        : e.status === 503 ? 'The admin account is not configured on this server.'
          : e.status === 401 ? 'Wrong user or password.' : 'Error: ' + e.message;
      err.hidden = false;
    });
  }

  function logout() {
    api('logout', {}).catch(function () { /* session déjà expirée */ }).then(function () {
      setToken(null);
      data = null;
      showLogin();
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('loginForm').addEventListener('submit', submitLogin);
    $('passwordForm').addEventListener('submit', submitPassword);
    $('btnLogout').addEventListener('click', logout);
    $('btnPassword').addEventListener('click', openPassword);
    $('btnWarnPassword').addEventListener('click', openPassword);
    $('btnRefresh').addEventListener('click', function () { load().then(function () { toast('Refreshed'); }); });
    $('btnResetConfirm').addEventListener('click', confirmReset);
    $('btnCopy').addEventListener('click', copyPassword);
    $('filter').addEventListener('input', render);
    document.querySelectorAll('[data-close]').forEach(function (b) {
      b.addEventListener('click', function () { b.closest('dialog').close(); });
    });
    $('resetDialog').addEventListener('close', function () { $('resetPassword').textContent = ''; });

    if (getToken()) showMain(); else showLogin();
  });
})();
