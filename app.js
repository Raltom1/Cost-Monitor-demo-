'use strict';
/* ==========================================================
   Cost Monitor - app.js
   Real-time project cost and profit/loss monitoring.
   - Local data: localStorage in this browser
   ========================================================== */
(function () {

  /* ================= Config ================= */
  const KEYS = {
    db: 'pcm_db_v1',
    settings: 'pcm_settings_v1',
    account: 'pcm_account_v1',
    lock: 'pcm_lock_v1',
    session: 'pcm_session_v1'
  };
  const DEFAULT_SETTINGS = { theme: 'default' };
  const MAX_TEXT = 120;
  const MAX_NOTE = 300;
  const MAX_AMOUNT = 1e9;
  const PBKDF2_ITER = 150000;
  const IDLE_MS = 15 * 60 * 1000;

  /* ================= Utils ================= */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const peso = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });
  const numFmt = new Intl.NumberFormat('en-PH', { maximumFractionDigits: 4 });
  const money = n => peso.format(round2(n));
  const pct = n => (Math.round(n * 10) / 10).toLocaleString('en-PH') + '%';
  const pad = n => String(n).padStart(2, '0');
  const todayStr = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00').getTime());
  const fmtDate = s => { const p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' }); };
  const fmtDateTime = ts => new Date(ts).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
  const uid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  const icon = (n, cls) => '<svg class="icon ' + (cls || '') + '" aria-hidden="true" focusable="false"><use href="#i-' + n + '"></use></svg>';
  const bytesToB64 = b => btoa(String.fromCharCode.apply(null, Array.from(b)));
  const b64ToBytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  function safeEqual(a, b) {
    a = String(a); b = String(b);
    let diff = a.length ^ b.length;
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    return diff === 0;
  }

  const LS = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v === null ? (fallback === undefined ? null : fallback) : JSON.parse(v); }
      catch (e) { return fallback === undefined ? null : fallback; }
    },
    set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; } },
    remove(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } }
  };
  const Session = {
    get() { try { return sessionStorage.getItem(KEYS.session) === '1'; } catch (e) { return false; } },
    set() { try { sessionStorage.setItem(KEYS.session, '1'); } catch (e) { /* ignore */ } },
    clear() { try { sessionStorage.removeItem(KEYS.session); } catch (e) { /* ignore */ } }
  };

  /* ================= Section definitions ================= */
  const f = (key, label, type, extra) => Object.assign({ key, label, type }, extra || {});
  const NOTE = f('note', 'Note (optional)', 'textarea');

  const SECTIONS = {
    materials: {
      label: 'Materials', icon: 'box', blurb: 'Materials purchased and used for the project.',
      fields: [
        f('date', 'Date', 'date', { required: true }),
        f('item', 'Material / Item', 'text', { required: true }),
        f('supplier', 'Supplier / Store', 'text'),
        f('qty', 'Quantity', 'number', { required: true, min: 0.0001, def: 1 }),
        f('unitCost', 'Unit price', 'number', { required: true, min: 0.01 }),
        NOTE
      ],
      amount: e => e.qty * e.unitCost,
      title: e => e.item,
      sub: e => [e.supplier, numFmt.format(e.qty) + ' x ' + money(e.unitCost)].filter(Boolean).join(' | ')
    },
    labor: {
      label: 'Labor / Payroll', icon: 'users', blurb: 'Worker wages.',
      fields: [
        f('date', 'Date', 'date', { required: true }),
        f('worker', 'Worker name', 'text', { required: true }),
        f('days', 'Days worked', 'number', { required: true, min: 0.0001, def: 1 }),
        f('rate', 'Daily rate', 'number', { required: true, min: 0.01 }),
        NOTE
      ],
      amount: e => e.days * e.rate,
      title: e => e.worker,
      sub: e => numFmt.format(e.days) + ' days x ' + money(e.rate)
    },
    transpo: {
      label: 'Transportation / Allowance', icon: 'bus', blurb: 'Worker transportation and allowances.',
      fields: [
        f('date', 'Date', 'date', { required: true }),
        f('worker', 'Worker name', 'text', { required: true }),
        f('purpose', 'Purpose / Route', 'text'),
        f('amount', 'Amount', 'number', { required: true, min: 0.01 }),
        NOTE
      ],
      amount: e => e.amount,
      title: e => e.worker,
      sub: e => e.purpose
    },
    lalamove: {
      label: 'Lalamove Fees', icon: 'truck', blurb: 'Delivery and hauling fees.',
      fields: [
        f('date', 'Date', 'date', { required: true }),
        f('route', 'Route / Destination', 'text', { required: true }),
        f('bookingRef', 'Booking / Order no.', 'text'),
        f('amount', 'Amount', 'number', { required: true, min: 0.01 }),
        NOTE
      ],
      amount: e => e.amount,
      title: e => e.route,
      sub: e => (e.bookingRef ? 'Ref: ' + e.bookingRef : '')
    },
    liquidation: {
      label: 'Expense Liquidation (Receipts)', icon: 'receipt', blurb: 'Liquidated expenses and receipt tracking.',
      fields: [
        f('date', 'Date', 'date', { required: true }),
        f('desc', 'Expense description', 'text', { required: true }),
        f('receipt', 'Receipt status', 'select', { options: [['oo', 'Receipt available'], ['wala', 'No receipt']] }),
        f('receiptNo', 'Receipt / OR no.', 'text'),
        f('by', 'Submitted by', 'text'),
        f('amount', 'Amount', 'number', { required: true, min: 0.01 }),
        NOTE
      ],
      amount: e => e.amount,
      title: e => e.desc,
      sub: e => [e.receiptNo ? 'OR# ' + e.receiptNo : '', e.by].filter(Boolean).join(' | ')
    }
  };
  const SECTION_KEYS = Object.keys(SECTIONS);
  const ROUTES = ['dashboard'].concat(SECTION_KEYS, ['settings']);

  /* ================= Data model ================= */
  function emptyDB() {
    const entries = {};
    SECTION_KEYS.forEach(k => { entries[k] = []; });
    return { version: 1, updatedAt: 0, project: { name: 'My Project', contract: 0, progress: 0, targetMargin: 10 }, entries };
  }

  function sanitizeEntry(key, raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {
      id: (typeof raw.id === 'string' && /^[\w-]{1,64}$/.test(raw.id)) ? raw.id : uid(),
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now()
    };
    SECTIONS[key].fields.forEach(fd => {
      const v = raw[fd.key];
      if (fd.type === 'number') {
        let n = Number(v);
        if (!Number.isFinite(n)) n = 0;
        out[fd.key] = clamp(Math.round(n * 10000) / 10000, 0, MAX_AMOUNT);
      } else if (fd.type === 'date') {
        out[fd.key] = isDate(v) ? v : todayStr();
      } else if (fd.type === 'select') {
        const vals = fd.options.map(o => o[0]);
        out[fd.key] = vals.indexOf(v) >= 0 ? v : vals[0];
      } else {
        out[fd.key] = String(v == null ? '' : v).trim().slice(0, fd.type === 'textarea' ? MAX_NOTE : MAX_TEXT);
      }
    });
    return out;
  }

  function normalizeDB(raw) {
    const db = emptyDB();
    if (!raw || typeof raw !== 'object') return db;
    db.updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0;
    const p = raw.project && typeof raw.project === 'object' ? raw.project : {};
    const projectName = String(p.name == null ? '' : p.name).trim().slice(0, MAX_TEXT);
    db.project.name = !projectName || projectName === 'Aking Proyekto' ? db.project.name : projectName;
    db.project.contract = clamp(round2(Number(p.contract) || 0), 0, MAX_AMOUNT);
    db.project.progress = clamp(Math.round((Number(p.progress) || 0) * 10) / 10, 0, 100);
    const tm = Number(p.targetMargin);
    db.project.targetMargin = Number.isFinite(tm) ? clamp(tm, 0, 100) : 10;
    SECTION_KEYS.forEach(k => {
      const arr = raw.entries && Array.isArray(raw.entries[k]) ? raw.entries[k] : [];
      db.entries[k] = arr.map(e => sanitizeEntry(k, e)).filter(Boolean).slice(0, 20000);
    });
    return db;
  }

  /* ================= State ================= */
  const state = {
    db: emptyDB(),
    settings: Object.assign({}, DEFAULT_SETTINGS),
    route: 'dashboard',
    loggedIn: false,
    search: {},
    closeModal: null,
    idleTimer: null
  };

  function loadSettings() {
    const s = LS.get(KEYS.settings, {});
    const out = Object.assign({}, DEFAULT_SETTINGS);
    if (s && typeof s === 'object') {
      out.theme = s.theme === 'dark' ? 'dark' : 'default';
    }
    return out;
  }
  const saveSettings = () => LS.set(KEYS.settings, state.settings);

  function applyTheme() {
    const dark = state.settings.theme === 'dark';
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'default');
    const m = $('meta[name="theme-color"]');
    if (m) m.setAttribute('content', dark ? '#0e1217' : '#1b2430');
  }

  function persistLocal() {
    const ok = LS.set(KEYS.db, state.db);
    if (!ok) toast('error', 'Could not save to this device. Browser storage may be full or blocked.');
    return ok;
  }

  /** Call after every data change. */
  function commit() {
    state.db.updatedAt = Date.now();
    persistLocal();
  }

  /* ================= Loader / Toast ================= */
  let loaderDepth = 0;
  function showLoader(msg) {
    loaderDepth++;
    $('#loader-msg').textContent = msg || 'Please wait...';
    $('#loader').hidden = false;
  }
  function hideLoader() {
    loaderDepth = Math.max(0, loaderDepth - 1);
    if (loaderDepth === 0) $('#loader').hidden = true;
  }
  async function withLoading(msg, fn, minMs) {
    const min = minMs === undefined ? 450 : minMs;
    showLoader(msg);
    const t0 = Date.now();
    try { return await fn(); }
    finally {
      const wait = min - (Date.now() - t0);
      if (wait > 0) await sleep(wait);
      hideLoader();
    }
  }

  const TOAST_ICON = { success: 'check', error: 'alert', warning: 'alert', info: 'info' };
  function toast(type, msg, ms) {
    const box = $('#toasts');
    if (!box) return;
    const el = document.createElement('div');
    el.className = 'toast toast-' + type;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.innerHTML = icon(TOAST_ICON[type] || 'info') + '<p>' + esc(msg) + '</p>' +
      '<button type="button" class="toast-close" aria-label="Close">' + icon('x') + '</button>';
    const remove = () => { if (el.parentNode) el.parentNode.removeChild(el); };
    $('.toast-close', el).addEventListener('click', remove);
    box.appendChild(el);
    setTimeout(remove, ms || (type === 'error' ? 6500 : 4200));
    while (box.children.length > 4) box.removeChild(box.firstChild);
  }

  /* ================= Dialogs ================= */
  function setFormError(form, msg) {
    const el = $('.form-error', form);
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  function showDialog(opts) {
    const o = Object.assign({
      title: '', body: '', confirmText: 'OK', cancelText: 'Cancel', danger: false,
      dismissible: true, cancelValue: null, wide: false, onSubmit: null, onOpen: null
    }, opts);
    return new Promise(resolve => {
      const root = $('#modal-root');
      const prevFocus = document.activeElement;
      root.innerHTML =
        '<div class="modal-backdrop"><div class="modal' + (o.wide ? ' modal-wide' : '') + '" role="dialog" aria-modal="true" aria-labelledby="dlg-title">' +
        '<form novalidate><h2 id="dlg-title">' + esc(o.title) + '</h2>' +
        '<div class="modal-body">' + o.body + '</div>' +
        '<p class="form-error" role="alert" hidden></p>' +
        '<div class="modal-actions">' +
        '<button type="button" class="btn btn-ghost" data-cancel>' + esc(o.cancelText) + '</button>' +
        '<button type="submit" class="btn ' + (o.danger ? 'btn-danger' : 'btn-primary') + '" data-ok>' + esc(o.confirmText) + '</button>' +
        '</div></form></div></div>';
      document.body.classList.add('modal-open');
      const form = $('form', root);
      const okBtn = $('[data-ok]', root);
      const cancelBtn = $('[data-cancel]', root);
      let busy = false;
      let done = false;

      function onKey(ev) {
        if (ev.key === 'Escape') {
          if (o.dismissible && !busy) { ev.preventDefault(); finish(o.cancelValue); }
          return;
        }
        if (ev.key === 'Tab') {
          const focusables = $$('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])', root);
          if (!focusables.length) return;
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          if (!root.contains(document.activeElement)) { ev.preventDefault(); first.focus(); }
          else if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
          else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
        }
      }
      function finish(val) {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        root.innerHTML = '';
        document.body.classList.remove('modal-open');
        state.closeModal = null;
        try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (e) { /* ignore */ }
        resolve(val);
      }
      document.addEventListener('keydown', onKey, true);
      state.closeModal = () => finish(null);

      cancelBtn.addEventListener('click', () => { if (!busy) finish(o.cancelValue); });
      form.addEventListener('submit', async ev => {
        ev.preventDefault();
        if (busy) return;
        busy = true; okBtn.disabled = true; setFormError(form, '');
        try {
          const r = o.onSubmit ? await o.onSubmit(form) : { ok: true, value: true };
          if (r && r.ok) { finish(r.value === undefined ? true : r.value); return; }
          setFormError(form, (r && r.error) || 'An error occurred. Please try again.');
        } catch (err) {
          setFormError(form, (err && err.message) || 'An error occurred. Please try again.');
        }
        busy = false; okBtn.disabled = false;
      });

      if (o.onOpen) o.onOpen(form);
      const firstField = $('input:not([type="hidden"]):not([disabled]),select,textarea', root);
      (firstField || (o.danger ? cancelBtn : okBtn)).focus();
    });
  }

  const confirmAction = c => showDialog({
    title: c.title, danger: !!c.danger, confirmText: c.confirmText || 'Yes, continue',
    body: '<p class="modal-text">' + esc(c.message) + '</p>'
  }).then(r => r === true);

  const confirmWithPassword = c => showDialog({
    title: c.title, danger: true, confirmText: c.confirmText || 'Yes, continue',
    body: '<p class="modal-text">' + esc(c.message) + '</p>' +
      '<div class="field"><label for="cp-pass">Enter your password to confirm</label>' +
      '<input id="cp-pass" name="password" type="password" autocomplete="current-password"></div>',
    onSubmit: async form => {
      const pw = form.elements.namedItem('password').value;
      if (!pw) return { ok: false, error: 'Enter your password.' };
      const ok = await withLoading('Verifying password...', () => Auth.verify(pw), 300);
      return ok ? { ok: true, value: true } : { ok: false, error: 'Incorrect password.' };
    }
  }).then(r => r === true);

  /* ================= Auth ================= */
  const validUsername = u => /^[A-Za-z0-9_.-]{3,30}$/.test(u);
  const validPassword = p => typeof p === 'string' && p.length >= 8 && p.length <= 128 && /[A-Za-z]/.test(p) && /\d/.test(p);
  const USERNAME_RULE = 'Username must be 3–30 characters and can contain only letters, numbers, periods, underscores, and hyphens.';
  const PASSWORD_RULE = 'Password must be at least 8 characters and include a letter and a number.';

  const Auth = {
    get account() { return LS.get(KEYS.account); },
    async derive(password, saltB64, iter) {
      if (!(window.crypto && crypto.subtle)) throw new Error('A secure context is required. Open the app over HTTPS or localhost (for example, with Live Server).');
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b64ToBytes(saltB64), iterations: iter }, key, 256);
      return bytesToB64(new Uint8Array(bits));
    },
    async create(username, password) {
      const salt = bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
      const hash = await this.derive(password, salt, PBKDF2_ITER);
      if (!LS.set(KEYS.account, { username, salt, hash, iter: PBKDF2_ITER })) throw new Error('Could not save the account to this device.');
    },
    async verify(password) {
      const a = this.account;
      if (!a || !password) return false;
      const h = await this.derive(password, a.salt, a.iter || PBKDF2_ITER);
      return safeEqual(h, a.hash);
    },
    async setPassword(password) {
      const a = this.account;
      const salt = bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
      a.salt = salt; a.iter = PBKDF2_ITER;
      a.hash = await this.derive(password, salt, PBKDF2_ITER);
      if (!LS.set(KEYS.account, a)) throw new Error('Could not save the new password.');
    }
  };

  function renderAuth(mode) {
    const host = $('#auth');
    $('#app').hidden = true;
    $('#boot').hidden = true;
    host.hidden = false;
    const setup = mode === 'setup';
    host.innerHTML =
      '<div class="auth-card">' +
      '<div class="brand brand-lg">' + icon('trend-up', 'icon-lg') + '<span>Cost Monitor</span></div>' +
      '<h1>' + (setup ? 'Create an account' : 'Log in') + '</h1>' +
      '<p class="muted">' + (setup ? 'Create an account to use this app on this device.' : 'Enter your username and password.') + '</p>' +
      '<form data-form="' + mode + '" novalidate>' +
      '<div class="field"><label for="a-user">Username</label><input id="a-user" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="30"></div>' +
      '<div class="field"><label for="a-pass">Password</label><input id="a-pass" name="password" type="password" autocomplete="' + (setup ? 'new-password' : 'current-password') + '" maxlength="128"></div>' +
      (setup ? '<div class="field"><label for="a-pass2">Confirm password</label><input id="a-pass2" name="password2" type="password" autocomplete="new-password" maxlength="128"></div><p class="muted small" style="margin-top:-0.4rem">' + esc(PASSWORD_RULE) + '</p>' : '') +
      '<p class="form-error" role="alert" hidden></p>' +
      '<button type="submit" class="btn btn-primary btn-block">' + icon('lock') + (setup ? 'Create account and log in' : 'Log in') + '</button>' +
      '</form>' +
      (setup ? '' : '<button type="button" class="link-btn" data-act="forgot">Forgot password?</button>') +
      '</div>';
    const first = $('input', host);
    if (first) first.focus();
  }

  async function handleLogin(form) {
    const username = form.elements.namedItem('username').value.trim();
    const password = form.elements.namedItem('password').value;
    const lock = LS.get(KEYS.lock, { fails: 0, until: 0 }) || { fails: 0, until: 0 };
    if (Date.now() < lock.until) {
      return setFormError(form, 'Too many failed attempts. Try again in ' + Math.ceil((lock.until - Date.now()) / 1000) + ' seconds.');
    }
    if (!username || !password) return setFormError(form, 'Enter your username and password.');
    setFormError(form, '');
    let ok = false;
    try {
      ok = await withLoading('Logging in...', async () => {
        const passOk = await Auth.verify(password);
        const acct = Auth.account;
        return passOk && !!acct && acct.username.toLowerCase() === username.toLowerCase();
      });
    } catch (err) { return setFormError(form, err.message); }
    if (!ok) {
      lock.fails = (lock.fails || 0) + 1;
      if (lock.fails >= 5) { lock.until = Date.now() + 30000; lock.fails = 0; }
      LS.set(KEYS.lock, lock);
      return setFormError(form, 'Incorrect username or password.');
    }
    LS.remove(KEYS.lock);
    Session.set();
    enterApp();
  }

  async function handleSetup(form) {
    const username = form.elements.namedItem('username').value.trim();
    const p1 = form.elements.namedItem('password').value;
    const p2 = form.elements.namedItem('password2').value;
    if (!validUsername(username)) return setFormError(form, USERNAME_RULE);
    if (!validPassword(p1)) return setFormError(form, PASSWORD_RULE);
    if (p1 !== p2) return setFormError(form, 'The passwords do not match.');
    setFormError(form, '');
    try { await withLoading('Creating account...', () => Auth.create(username, p1)); }
    catch (err) { return setFormError(form, err.message); }
    Session.set();
    toast('success', 'Account created. Welcome!');
    enterApp();
  }

  async function forgotPassword() {
    const res = await showDialog({
      title: 'Reset the app?', danger: true, confirmText: 'Reset everything',
      body: '<p class="modal-text">Your password cannot be recovered. Resetting will delete the account and database from this device. Data on other devices or in backups will not be deleted.</p>' +
        '<div class="field"><label for="rs-confirm">Type RESET to continue</label><input id="rs-confirm" name="confirm" type="text" autocomplete="off" autocapitalize="characters"></div>',
      onSubmit: form => form.elements.namedItem('confirm').value.trim() === 'RESET'
        ? { ok: true, value: true } : { ok: false, error: 'Type RESET in uppercase to continue.' }
    });
    if (res !== true) return;
    await withLoading('Resetting the app...', async () => {
      [KEYS.account, KEYS.db, KEYS.settings, KEYS.lock].forEach(k => LS.remove(k));
      Session.clear();
      const theme = state.settings.theme;
      state.settings = Object.assign({}, DEFAULT_SETTINGS, { theme });
      saveSettings();
      state.db = emptyDB();
    });
    renderAuth('setup');
    toast('info', 'App reset. Create a new account.');
  }

  /* ================= Project analysis ================= */
  const amountOf = (key, e) => round2(SECTIONS[key].amount(e));

  function analyze(db) {
    const byKey = {};
    const counts = {};
    let total = 0;
    SECTION_KEYS.forEach(k => {
      byKey[k] = round2(db.entries[k].reduce((s, e) => s + amountOf(k, e), 0));
      counts[k] = db.entries[k].length;
      total += byKey[k];
    });
    total = round2(total);
    const contract = db.project.contract;
    const progress = db.project.progress;
    const target = db.project.targetMargin;
    const noReceipt = db.entries.liquidation.filter(e => e.receipt !== 'oo');
    const a = {
      byKey, counts, total, contract, progress, target,
      noReceiptCount: noReceipt.length,
      noReceiptTotal: round2(noReceipt.reduce((s, e) => s + amountOf('liquidation', e), 0)),
      usedPct: contract > 0 ? (total / contract) * 100 : 0,
      profitNow: round2(contract - total),
      projectedCost: null, projectedProfit: null, projectedMargin: null,
      status: 'unset', notes: []
    };
    if (progress >= 100) a.projectedCost = total;
    else if (progress > 0) a.projectedCost = round2(total / (progress / 100));
    if (contract > 0) {
      if (a.projectedCost !== null) {
        a.projectedProfit = round2(contract - a.projectedCost);
        a.projectedMargin = (a.projectedProfit / contract) * 100;
      }
      if (total > contract) a.status = 'loss';
      else if (a.projectedCost === null) a.status = 'noforecast';
      else if (a.projectedProfit < 0) a.status = 'risk';
      else if (a.projectedMargin < target) a.status = 'thin';
      else a.status = 'profit';
      if (progress > 0 && progress < 100 && a.usedPct > progress + 10) {
        a.notes.push('Spending (' + pct(a.usedPct) + ' of the contract) is outpacing project progress (' + pct(progress) + ').');
      }
    }
    if (a.noReceiptCount > 0) {
      a.notes.push(a.noReceiptCount + ' liquidated expense(s) totaling ' + money(a.noReceiptTotal) + ' have no receipt.');
    }
    return a;
  }

  const STATUS = {
    unset: { cls: 'info', icon: 'info', title: 'Contract amount not set' },
    noforecast: { cls: 'info', icon: 'trend-up', title: 'Currently profitable' },
    profit: { cls: 'ok', icon: 'trend-up', title: 'Profitable' },
    thin: { cls: 'warn', icon: 'alert', title: 'Low profit margin' },
    risk: { cls: 'bad', icon: 'alert', title: 'At risk of a loss' },
    loss: { cls: 'bad', icon: 'trend-down', title: 'Operating at a loss' }
  };

  function statusText(a) {
    switch (a.status) {
      case 'unset': return 'Enter the contract amount and project progress in "Update Project" to see whether the project is profitable.';
      case 'noforecast': return 'Project progress has not been recorded, so a forecast is not available. Enter the progress percentage for a more accurate analysis.';
      case 'loss': return 'Expenses exceed the contract amount by ' + money(a.total - a.contract) + '.';
      case 'risk': return 'At the current spending rate (' + pct(a.progress) + ' complete), total expenses are projected to reach ' + money(a.projectedCost) + ', exceeding the contract by ' + money(-a.projectedProfit) + '.';
      case 'thin': return 'Estimated profit at completion: ' + money(a.projectedProfit) + ' (' + pct(a.projectedMargin) + '), below the target of ' + pct(a.target) + '.';
      default: return 'Estimated profit at completion: ' + money(a.projectedProfit) + ' (' + pct(a.projectedMargin) + '), meeting the target of ' + pct(a.target) + '.';
    }
  }

  /* ================= Views ================= */
  function meterHTML(label, value, text, tone) {
    const w = clamp(value, 0, 100);
    return '<div class="meter"><div class="meter-head"><span>' + esc(label) + '</span><strong>' + esc(text) + '</strong></div>' +
      '<div class="track" role="progressbar" aria-label="' + esc(label) + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(w) + '">' +
      '<div class="fill fill-' + tone + '" style="width:' + w + '%"></div></div></div>';
  }

  function dashboardHTML() {
    const db = state.db;
    const a = analyze(db);
    const st = STATUS[a.status];
    const hasContract = a.contract > 0;
    const figLabel = a.profitNow >= 0 ? 'Current profit' : 'Current loss';
    const budgetTone = a.usedPct > 100 ? 'bad' : (a.usedPct >= 85 ? 'warn' : 'ok');

    const banner =
      '<section class="status status-' + st.cls + '" aria-label="Project status">' +
      icon(st.icon, 'status-icon') +
      '<div class="status-body"><h2 class="status-title">' + esc(st.title) + '</h2><p class="status-text">' + esc(statusText(a)) + '</p></div>' +
      (hasContract ? '<div class="status-fig"><span>' + figLabel + '</span><strong>' + money(Math.abs(a.profitNow)) + '</strong></div>' : '') +
      '</section>';

    const notes = a.notes.length
      ? '<ul class="notes">' + a.notes.map(n => '<li>' + icon('alert') + '<span>' + esc(n) + '</span></li>').join('') + '</ul>' : '';

    const stats =
      '<div class="stats-grid">' +
      '<div class="stat"><span>Contract amount</span><strong>' + (hasContract ? money(a.contract) : '-') + '</strong></div>' +
      '<div class="stat"><span>Total expenses (direct costs)</span><strong>' + money(a.total) + '</strong></div>' +
      '<div class="stat"><span>' + figLabel + '</span><strong class="' + (hasContract ? (a.profitNow >= 0 ? 'tone-ok' : 'tone-bad') : '') + '">' + (hasContract ? money(a.profitNow) : '-') + '</strong></div>' +
      '<div class="stat"><span>Projected cost at 100% completion</span><strong>' + (a.projectedCost !== null ? money(a.projectedCost) : '-') + '</strong>' +
      '<small>' + (a.projectedCost !== null ? 'Expenses to date / progress %' : 'Project progress is required') + '</small></div>' +
      '</div>';

    const meters = '<section class="meters card" aria-label="Progress">' +
      meterHTML('Contract spent', a.usedPct, hasContract ? pct(a.usedPct) : 'No contract amount', budgetTone) +
      meterHTML('Project progress', a.progress, pct(a.progress), 'accent') +
      meterHTML('Target profit margin', clamp(a.target, 0, 100), pct(a.target), 'ok') +
      '</section>';

    const cards = SECTION_KEYS.map(k => {
      const S = SECTIONS[k];
      const share = a.total > 0 ? (a.byKey[k] / a.total) * 100 : 0;
      const warn = k === 'liquidation' && a.noReceiptCount > 0
        ? '<div class="warnline">' + icon('alert') + '<span>' + a.noReceiptCount + ' without receipts (' + esc(money(a.noReceiptTotal)) + ')</span></div>' : '';
      return '<a class="section-card" href="#/' + k + '" aria-label="' + esc(S.label) + ': ' + esc(money(a.byKey[k])) + '. Open section.">' +
        '<div class="section-card-head">' + icon(S.icon) + '<span>' + esc(S.label) + '</span></div>' +
        '<div class="big">' + money(a.byKey[k]) + '</div>' +
        '<div class="meta"><span>' + a.counts[k] + ' entries</span><span>' + pct(share) + ' of expenses</span></div>' +
        '<div class="track" aria-hidden="true"><div class="fill fill-accent" style="width:' + clamp(share, 0, 100) + '%"></div></div>' +
        warn + '</a>';
    }).join('');

    return '<div class="page-head"><div><h1>' + esc(db.project.name) + '</h1><p class="muted">Real-time project expenses and profitability.</p></div>' +
      '<button type="button" class="btn btn-primary" data-act="edit-project">' + icon('edit') + 'Update Project</button></div>' +
      banner + notes + stats + meters +
      '<h2 class="section-title">Expense Categories</h2><div class="section-grid">' + cards + '</div>';
  }

  function sectionHTML(key) {
    const S = SECTIONS[key];
    const list = state.db.entries[key];
    const total = round2(list.reduce((s, e) => s + amountOf(key, e), 0));
    let extra = '';
    if (key === 'liquidation') {
      const a = analyze(state.db);
      extra = '<div><span>Expenses without receipts</span><strong class="' + (a.noReceiptCount ? 'tone-bad' : '') + '">' + money(a.noReceiptTotal) + '</strong></div>';
    }
    return '<div class="page-head"><div><h1>' + icon(S.icon, 'icon-lg') + esc(S.label) + '</h1><p class="muted">' + esc(S.blurb) + '</p></div>' +
      '<button type="button" class="btn btn-primary" data-act="add" data-section="' + key + '">' + icon('plus') + 'Add Entry</button></div>' +
      '<div class="summary-bar"><div><span>Total</span><strong>' + money(total) + '</strong></div><div><span>Entries</span><strong>' + list.length + '</strong></div>' + extra + '</div>' +
      '<div class="field search"><label class="sr-only" for="search">Search</label>' + icon('search') +
      '<input id="search" type="search" placeholder="Search entries..." value="' + esc(state.search[key] || '') + '" autocomplete="off"></div>' +
      '<div id="list" class="list">' + listHTML(key) + '</div>';
  }

  function listHTML(key) {
    const S = SECTIONS[key];
    const q = (state.search[key] || '').trim().toLowerCase();
    let items = state.db.entries[key].slice().sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
    if (q) {
      items = items.filter(e => S.fields.some(fd => String(e[fd.key] == null ? '' : e[fd.key]).toLowerCase().indexOf(q) >= 0) ||
        money(amountOf(key, e)).toLowerCase().indexOf(q) >= 0);
    }
    if (!items.length) {
      return '<div class="empty">' + icon(S.icon, 'icon-lg') + '<p>' + (q ? 'No matching entries found.' : 'No entries yet. Select "Add Entry" to get started.') + '</p></div>';
    }
    return items.map(e => {
      const sub = S.sub(e);
      let badge = '';
      if (key === 'liquidation') {
        badge = e.receipt === 'oo'
          ? '<span class="badge badge-ok">' + icon('check') + 'Receipt available</span>'
          : '<span class="badge badge-warn">' + icon('alert') + 'No receipt</span>';
      }
      return '<article class="entry"><div class="entry-main"><h3>' + esc(S.title(e) || '(untitled)') + '</h3>' +
        '<p class="muted">' + esc(fmtDate(e.date)) + (sub ? ' | ' + esc(sub) : '') + '</p>' +
        (e.note ? '<p class="note">' + esc(e.note) + '</p>' : '') + '</div>' +
        '<div class="entry-side">' + badge + '<strong class="amount">' + money(amountOf(key, e)) + '</strong>' +
        '<button type="button" class="btn btn-secondary btn-icon" data-act="edit" data-section="' + key + '" data-id="' + esc(e.id) + '" aria-label="Edit">' + icon('edit') + '</button>' +
        '<button type="button" class="btn btn-danger-outline btn-icon" data-act="del" data-section="' + key + '" data-id="' + esc(e.id) + '" aria-label="Delete">' + icon('trash') + '</button>' +
        '</div></article>';
    }).join('');
  }

  function settingsHTML() {
    const s = state.settings;
    const acct = Auth.account || { username: '' };
    return '<div class="page-head"><div><h1>' + icon('sliders', 'icon-lg') + 'Settings</h1><p class="muted">Local data, appearance, and account.</p></div></div>' +
      '<div class="settings-grid">' +

      '<section class="card"><h2>' + icon('database') + 'Data on this device</h2>' +
      '<p class="muted">Your database is saved only in this browser. It does not sync with other devices or servers.</p>' +
      '<p class="muted" id="device-last"></p>' +
      '<div class="btn-row"><button type="button" class="btn btn-primary" data-act="save-db">' + icon('save') + 'Save database</button>' +
      '<button type="button" class="btn btn-danger" data-act="clear-db">' + icon('trash') + 'Clear database</button></div></section>' +

      '<section class="card"><h2>' + icon('palette') + 'Appearance</h2>' +
      '<div class="seg" role="radiogroup" aria-label="Appearance">' +
      '<label><input type="radio" name="theme" value="default"' + (s.theme !== 'dark' ? ' checked' : '') + '><span>' + icon('sun') + 'Default</span></label>' +
      '<label><input type="radio" name="theme" value="dark"' + (s.theme === 'dark' ? ' checked' : '') + '><span>' + icon('moon') + 'Dark mode</span></label>' +
      '</div></section>' +

      '<section class="card"><h2>' + icon('user') + 'Account</h2>' +
      '<p class="muted">Logged in as <strong id="acct-name">' + esc(acct.username) + '</strong></p>' +
      '<form class="form-block" data-form="username" novalidate><h3>Change username</h3>' +
      '<div class="field"><label for="u-new">New username</label><input id="u-new" name="newUsername" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="30"></div>' +
      '<div class="field"><label for="u-pass">Current password</label><input id="u-pass" name="password" type="password" autocomplete="current-password" maxlength="128"></div>' +
      '<p class="form-error" role="alert" hidden></p>' +
      '<button type="submit" class="btn btn-primary btn-block">' + icon('check') + 'Save username</button></form>' +
      '<hr>' +
      '<form class="form-block" data-form="password" novalidate><h3>Change password</h3>' +
      '<div class="field"><label for="p-old">Current password</label><input id="p-old" name="current" type="password" autocomplete="current-password" maxlength="128"></div>' +
      '<div class="field"><label for="p-new">New password</label><input id="p-new" name="password" type="password" autocomplete="new-password" maxlength="128"></div>' +
      '<div class="field"><label for="p-new2">Confirm new password</label><input id="p-new2" name="password2" type="password" autocomplete="new-password" maxlength="128"></div>' +
      '<p class="muted small" style="margin-bottom:1rem">' + esc(PASSWORD_RULE) + '</p>' +
      '<p class="form-error" role="alert" hidden></p>' +
      '<button type="submit" class="btn btn-primary btn-block">' + icon('lock') + 'Save password</button></form>' +
      '</section>' +
      '</div>';
  }

  function updateLocalDataUI() {
    const dev = $('#device-last');
    if (dev) dev.textContent = state.db.updatedAt ? 'Last database update: ' + fmtDateTime(state.db.updatedAt) + '.' : 'The database is empty.';
  }

  /* ================= Rendering / Router ================= */
  const currentRoute = () => {
    const r = location.hash.replace(/^#\/?/, '') || 'dashboard';
    return ROUTES.indexOf(r) >= 0 ? r : 'dashboard';
  };

  function renderNav() {
    const items = [['dashboard', 'Dashboard', 'home']]
      .concat(SECTION_KEYS.map(k => [k, SECTIONS[k].label, SECTIONS[k].icon]))
      .concat([['settings', 'Settings', 'sliders']]);
    $('#nav').innerHTML = items.map(i =>
      '<a class="nav-link" href="#/' + i[0] + '"' + (state.route === i[0] ? ' aria-current="page"' : '') + '>' + icon(i[2]) + '<span>' + esc(i[1]) + '</span></a>'
    ).join('');
  }

  function render(opts) {
    if (!state.loggedIn) return;
    state.route = currentRoute();
    renderNav();
    const view = $('#view');
    let title;
    if (state.route === 'dashboard') { title = 'Dashboard'; view.innerHTML = dashboardHTML(); }
    else if (state.route === 'settings') { title = 'Settings'; view.innerHTML = settingsHTML(); updateLocalDataUI(); }
    else { title = SECTIONS[state.route].label; view.innerHTML = sectionHTML(state.route); }
    $('#page-title').textContent = title;
    document.title = title + ' | Cost Monitor';
    closeDrawer();
    if (opts && opts.focus) { view.focus({ preventScroll: true }); window.scrollTo(0, 0); }
  }

  function openDrawer() {
    $('#sidebar').classList.add('open');
    $('#scrim').hidden = false;
    const b = $('.menu-btn'); if (b) b.setAttribute('aria-expanded', 'true');
  }
  function closeDrawer() {
    $('#sidebar').classList.remove('open');
    $('#scrim').hidden = true;
    const b = $('.menu-btn'); if (b) b.setAttribute('aria-expanded', 'false');
  }

  function renderUserChip() {
    const a = Auth.account;
    $('#user-name').textContent = a ? a.username : '';
  }

  /* ================= Entry forms ================= */
  function fieldHTML(fd, val) {
    const id = 'f-' + fd.key;
    const req = fd.required ? ' required aria-required="true"' : '';
    const v = esc(val == null ? '' : val);
    let input;
    if (fd.type === 'textarea') {
      input = '<textarea id="' + id + '" name="' + fd.key + '" rows="3" maxlength="' + MAX_NOTE + '">' + v + '</textarea>';
    } else if (fd.type === 'select') {
      input = '<select id="' + id + '" name="' + fd.key + '">' +
        fd.options.map(o => '<option value="' + esc(o[0]) + '"' + (o[0] === val ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') + '</select>';
    } else if (fd.type === 'number') {
      input = '<input id="' + id + '" name="' + fd.key + '" type="number" inputmode="decimal" step="any" min="' + (fd.min == null ? 0 : fd.min) + '" max="' + (fd.max == null ? MAX_AMOUNT : fd.max) + '" value="' + v + '"' + req + '>';
    } else if (fd.type === 'date') {
      input = '<input id="' + id + '" name="' + fd.key + '" type="date" value="' + v + '"' + req + '>';
    } else {
      input = '<input id="' + id + '" name="' + fd.key + '" type="text" maxlength="' + MAX_TEXT + '" value="' + v + '" autocomplete="off"' + req + '>';
    }
    return '<div class="field"><label for="' + id + '">' + esc(fd.label) + (fd.required ? ' <span class="req" aria-hidden="true">*</span>' : '') + '</label>' + input + '</div>';
  }

  function readFields(fields, form) {
    const data = {};
    for (const fd of fields) {
      const el = form.elements.namedItem(fd.key);
      let v = el ? String(el.value) : '';
      if (fd.type === 'number') {
        v = v.trim();
        if (v === '') {
          if (fd.required) return { error: 'Enter ' + fd.label + '.' };
          v = 0;
        } else {
          v = Number(v);
          const min = fd.min == null ? 0 : fd.min;
          const max = fd.max == null ? MAX_AMOUNT : fd.max;
          if (!Number.isFinite(v)) return { error: 'Enter a valid number for ' + fd.label + '.' };
          if (v < min) return { error: fd.label + ' must be at least ' + numFmt.format(min) + '.' };
          if (v > max) return { error: fd.label + ' is too large.' };
        }
      } else {
        v = v.trim();
        if (fd.required && !v) return { error: 'Enter ' + fd.label + '.' };
        if (fd.type === 'date' && !isDate(v)) return { error: 'Enter a valid date.' };
      }
      data[fd.key] = v;
    }
    return { data };
  }

  async function openEntryForm(key, entry) {
    const S = SECTIONS[key];
    const isEdit = !!entry;
    const initial = fd => {
      if (entry) return entry[fd.key];
      if (fd.key === 'date') return todayStr();
      if (fd.def !== undefined) return fd.def;
      if (fd.type === 'select') return fd.options[0][0];
      return '';
    };
    const body = '<div class="two-col">' + S.fields.filter(fd => fd.type !== 'textarea').map(fd => fieldHTML(fd, initial(fd))).join('') + '</div>' +
      S.fields.filter(fd => fd.type === 'textarea').map(fd => fieldHTML(fd, initial(fd))).join('') +
      '<div class="total-preview"><span>Total</span><strong id="total-preview">' + money(0) + '</strong></div>';

    const result = await showDialog({
      title: (isEdit ? 'Edit: ' : 'Add: ') + S.label,
      body, wide: true, confirmText: isEdit ? 'Save changes' : 'Add entry',
      onOpen: form => {
        const update = () => {
          const tmp = {};
          S.fields.forEach(fd => {
            const el = form.elements.namedItem(fd.key);
            tmp[fd.key] = fd.type === 'number' ? (Number(el && el.value) || 0) : (el ? el.value : '');
          });
          let a = 0;
          try { a = S.amount(tmp); } catch (e) { a = 0; }
          $('#total-preview', form).textContent = money(a);
        };
        form.addEventListener('input', update);
        update();
      },
      onSubmit: async form => {
        const r = readFields(S.fields, form);
        if (r.error) return { ok: false, error: r.error };
        const clean = sanitizeEntry(key, r.data);
        const amt = amountOf(key, clean);
        if (!(amt > 0)) return { ok: false, error: 'The total amount must be greater than zero.' };
        if (amt > MAX_AMOUNT) return { ok: false, error: 'The total amount is too large.' };
        return { ok: true, value: r.data };
      }
    });
    if (!result) return;

    const clean = sanitizeEntry(key, Object.assign({}, result, entry ? { id: entry.id, createdAt: entry.createdAt } : {}));
    const list = state.db.entries[key];
    if (isEdit) {
      const i = list.findIndex(e => e.id === entry.id);
      if (i >= 0) list[i] = clean; else list.push(clean);
    } else { list.push(clean); }
    commit();
    render();
    toast('success', isEdit ? 'Entry updated.' : 'Entry added.');
  }

  async function deleteEntry(key, id) {
    const e = state.db.entries[key].find(x => x.id === id);
    if (!e) return;
    const S = SECTIONS[key];
    const ok = await confirmAction({
      title: 'Delete entry?', danger: true, confirmText: 'Yes, delete',
      message: '"' + (S.title(e) || 'Entry') + '" - ' + money(amountOf(key, e)) + '. This action cannot be undone.'
    });
    if (!ok) return;
    state.db.entries[key] = state.db.entries[key].filter(x => x.id !== id);
    commit();
    render();
    toast('success', 'Entry deleted.');
  }

  async function editProject() {
    const p = state.db.project;
    const fields = [
      f('name', 'Project name', 'text', { required: true }),
      f('contract', 'Contract amount (expected revenue)', 'number', { min: 0 }),
      f('progress', 'Project progress (0 to 100%)', 'number', { min: 0, max: 100 }),
      f('targetMargin', 'Target profit margin (% of contract)', 'number', { min: 0, max: 100 })
    ];
    const vals = { name: p.name, contract: p.contract || '', progress: p.progress || '', targetMargin: p.targetMargin };
    const res = await showDialog({
      title: 'Update Project', confirmText: 'Save',
      body: fields.map(fd => fieldHTML(fd, vals[fd.key])).join('') +
        '<p class="muted small" style="margin-bottom:1rem">Project progress is used to forecast total expenses: expenses to date / progress %.</p>',
      onSubmit: async form => {
        const r = readFields(fields, form);
        if (r.error) return { ok: false, error: r.error };
        return { ok: true, value: r.data };
      }
    });
    if (!res) return;
    state.db.project = normalizeDB({ project: res }).project;
    commit();
    render();
    toast('success', 'Project updated.');
  }

  /* ================= Database actions ================= */
  async function manualSave() {
    state.db.updatedAt = Date.now();
    const saved = await withLoading('Saving to this device...', async () => persistLocal());
    if (!saved) return;
    toast('success', 'Saved to this device (browser storage).');
    updateLocalDataUI();
  }

  async function clearDatabase() {
    const msg = 'ALL expenses and project details on this device will be deleted. This action cannot be undone. Your account will remain.';
    const ok = await confirmWithPassword({ title: 'Clear database?', message: msg, confirmText: 'Yes, clear it' });
    if (!ok) return;
    const saved = await withLoading('Clearing database...', async () => {
      state.db = emptyDB();
      state.db.updatedAt = Date.now();
      return persistLocal();
    });
    render();
    if (!saved) toast('error', 'The app was cleared, but the change could not be saved to browser storage.');
    else toast('success', 'Database cleared.');
  }

  /* ================= Account forms ================= */
  async function handleUsername(form) {
    const nu = form.elements.namedItem('newUsername').value.trim();
    const pw = form.elements.namedItem('password').value;
    if (!validUsername(nu)) return setFormError(form, USERNAME_RULE);
    if (!pw) return setFormError(form, 'Enter your current password.');
    setFormError(form, '');
    const ok = await withLoading('Verifying password...', () => Auth.verify(pw), 300);
    if (!ok) return setFormError(form, 'Incorrect password.');
    const a = Auth.account;
    a.username = nu;
    if (!LS.set(KEYS.account, a)) return setFormError(form, 'Could not save the new username.');
    form.reset();
    renderUserChip();
    const n = $('#acct-name'); if (n) n.textContent = nu;
    toast('success', 'Username updated.');
  }

  async function handlePassword(form) {
    const cur = form.elements.namedItem('current').value;
    const p1 = form.elements.namedItem('password').value;
    const p2 = form.elements.namedItem('password2').value;
    if (!cur) return setFormError(form, 'Enter your current password.');
    if (!validPassword(p1)) return setFormError(form, PASSWORD_RULE);
    if (p1 !== p2) return setFormError(form, 'The new passwords do not match.');
    if (p1 === cur) return setFormError(form, 'The new password must be different from the current password.');
    setFormError(form, '');
    const ok = await withLoading('Verifying password...', () => Auth.verify(cur), 300);
    if (!ok) return setFormError(form, 'Incorrect current password.');
    await withLoading('Saving new password...', () => Auth.setPassword(p1));
    form.reset();
    toast('success', 'Password updated.');
  }

  /* ================= Session ================= */
  function logout(message) {
    state.loggedIn = false;
    Session.clear();
    clearTimeout(state.idleTimer);
    if (state.closeModal) state.closeModal();
    closeDrawer();
    $('#app').hidden = true;
    renderAuth('login');
    if (message) toast('info', message);
  }

  function bumpIdle() {
    if (!state.loggedIn) return;
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => logout('You were logged out after 15 minutes of inactivity.'), IDLE_MS);
  }

  async function enterApp() {
    state.loggedIn = true;
    $('#auth').hidden = true;
    $('#auth').innerHTML = '';
    $('#boot').hidden = true;
    $('#app').hidden = false;
    renderUserChip();
    render({ focus: false });
    bumpIdle();
  }

  /* ================= Events ================= */
  function guard(fn) {
    return function () {
      const args = arguments;
      Promise.resolve().then(() => fn.apply(null, args)).catch(err => {
        console.error(err);
        toast('error', (err && err.message) || 'An error occurred.');
      });
    };
  }

  const actions = {
    add: el => openEntryForm(el.dataset.section, null),
    edit: el => {
      const e = (state.db.entries[el.dataset.section] || []).find(x => x.id === el.dataset.id);
      if (e) return openEntryForm(el.dataset.section, e);
    },
    del: el => deleteEntry(el.dataset.section, el.dataset.id),
    'edit-project': () => editProject(),
    'save-db': () => manualSave(),
    'clear-db': () => clearDatabase(),
    logout: () => logout(),
    forgot: () => forgotPassword(),
    menu: () => (($('#sidebar').classList.contains('open')) ? closeDrawer() : openDrawer()),
    'close-drawer': () => closeDrawer()
  };

  function bindEvents() {
    document.addEventListener('click', ev => {
      if (ev.target.closest('.nav-link')) closeDrawer();
      const el = ev.target.closest('[data-act]');
      if (!el || el.disabled) return;
      const fn = actions[el.dataset.act];
      if (fn) guard(fn)(el);
    });

    document.addEventListener('submit', ev => {
      const form = ev.target.closest ? ev.target.closest('form[data-form]') : null;
      if (!form) return;
      ev.preventDefault();
      const handlers = { login: handleLogin, setup: handleSetup, username: handleUsername, password: handlePassword };
      const h = handlers[form.dataset.form];
      if (!h) return;
      Promise.resolve().then(() => h(form)).catch(err => { console.error(err); setFormError(form, (err && err.message) || 'An error occurred.'); });
    });

    document.addEventListener('input', ev => {
      if (ev.target.id === 'search' && SECTIONS[state.route]) {
        state.search[state.route] = ev.target.value;
        $('#list').innerHTML = listHTML(state.route);
      }
    });

    document.addEventListener('change', ev => {
      const t = ev.target;
      if (t.name === 'theme' && t.checked) {
        state.settings.theme = t.value === 'dark' ? 'dark' : 'default';
        applyTheme();
        saveSettings();
        toast('success', state.settings.theme === 'dark' ? 'Dark mode enabled.' : 'Light theme enabled.');
      }
    });

    document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeDrawer(); });
    ['click', 'keydown', 'pointerdown', 'touchstart'].forEach(n => document.addEventListener(n, bumpIdle, { passive: true }));

    window.addEventListener('hashchange', () => render({ focus: true }));
  }

  /* ================= Boot ================= */
  function boot() {
    state.settings = loadSettings();
    saveSettings();
    applyTheme();
    state.db = normalizeDB(LS.get(KEYS.db));
    bindEvents();
    if (!Auth.account) renderAuth('setup');
    else if (Session.get()) enterApp();
    else renderAuth('login');
  }

  boot();
})();