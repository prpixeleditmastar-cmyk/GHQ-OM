/* GHQ O&M — data layer: login, offline queue, Drive sync, photos, backup/restore.
   Loaded after the original dashboard script; it replaces the demo "alert" actions with real saving. */
(function () {
  'use strict';
  var CFG = window.GHQ_CONFIG || {};
  var API = (CFG.API_URL && !/PASTE/.test(CFG.API_URL)) ? CFG.API_URL : '';
  var LOCAL = !API;
  var BUILD = window.__GHQ_CACHED || window.GHQ_BUILD || 'dev';
  var VERSION = 'v8.2 · build ' + BUILD;
  var NOT_CONFIGURED = LOCAL && !CFG.LOCAL_TEST;       // release app without a server URL must NOT silently run offline

  /* ---------- tiny helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function fmt(ts) { try { return new Date(ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ts; } }
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  var toastT;
  function toast(msg) {
    var t = $('ghq-toast');
    if (!t) { t = document.createElement('div'); t.id = 'ghq-toast'; t.className = 'ghq-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(toastT); toastT = setTimeout(function () { t.style.display = 'none'; }, 3200);
  }

  /* ---------- pending-queue storage (IndexedDB, falls back to memory) ---------- */
  var db = null, mem = {};
  function idbOpen() {
    return new Promise(function (res) {
      try {
        var r = indexedDB.open('ghq_om', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('queue', { keyPath: 'id' }); };
        r.onsuccess = function () { db = r.result; res(); };
        r.onerror = function () { res(); };
      } catch (e) { res(); }
    });
  }
  function qAll() {
    return new Promise(function (res) {
      if (!db) return res(Object.keys(mem).map(function (k) { return mem[k]; }));
      var o = db.transaction('queue').objectStore('queue').getAll();
      o.onsuccess = function () { res(o.result || []); };
      o.onerror = function () { res([]); };
    });
  }
  function qPut(ev) {
    mem[ev.id] = ev;
    if (!db) return Promise.resolve();
    return new Promise(function (res) { var t = db.transaction('queue', 'readwrite'); t.objectStore('queue').put(ev); t.oncomplete = res; t.onerror = res; });
  }
  function qDel(id) {
    delete mem[id];
    if (!db) return Promise.resolve();
    return new Promise(function (res) { var t = db.transaction('queue', 'readwrite'); t.objectStore('queue').delete(id); t.oncomplete = res; t.onerror = res; });
  }

  /* ---------- state ---------- */
  var session = LS.get('ghq_session', null);
  var events = LS.get('ghq_events', []);        // confirmed by server (have seq)
  var lastSeq = LS.get('ghq_seq', 0);
  var seen = {}; events.forEach(function (e) { seen[e.id] = 1; });
  var queue = [];                                // pending on this phone
  var DL_ROLES = ['admin', 'engineer', 'ril', 'pm', 'apm'];
  function isSupervisor() { return !!session && (session.role === 'supervisor' || String(session.work || '').toLowerCase() === 'supervisor'); }
  function canDownload() { return !!session && DL_ROLES.indexOf(session.role) >= 0; }          // Excel downloads
  function canHold() { return !!session && (session.role === 'admin' || session.role === 'engineer' || isSupervisor()); }   // e-ticket hold + add PPM equipment
  var feederRows = LS.get('ghq_feeders', null);  // master list from the 'Feeders' sheet (cached for offline)
  if (feederRows && !feederRows.length) feederRows = null;
  var layoutSig = '';
  var ppmRows = LS.get('ghq_ppm', []), ppmLog = {}, ppmLogId = {}, clItems = LS.get('ghq_cl_items', []), clRej = {}, dgItems = LS.get('ghq_dg_items', []), dgCanStart = false;
  var roster = {}, rosterPdf = {}, shiftsInfo = LS.get('ghq_shifts', []);
  var syncing = false, lastErr = '', timer = null;

  /* ---------- baseline (original demo structures) ---------- */
  var BASE = {
    elec: clone(elecData), water: clone(waterData), btu: clone(btuData),
    tickets: clone(ticketDatabase), amc: clone(amcMasterDatabase), ppm: clone(amcPPMSchedules)
  };
  function layoutFor(type) {                       // {panel:[{name}]} from the sheet, or null = use built-in defaults
    if (!feederRows) return null;
    var o = {};
    feederRows.forEach(function (r) { if (r.type === type) (o[r.panel] = o[r.panel] || []).push({ name: r.feeder }); });
    return o;
  }
  function resetObj(target, src, type) {
    Object.keys(target).forEach(function (k) { delete target[k]; });
    var c = clone(layoutFor(type) || src);
    Object.keys(c).forEach(function (panel) {
      c[panel].forEach(function (f) { f.baseVal = ''; f.prevReading = NaN; f.yesterday = 0; f._first = true; });
      target[panel] = c[panel];
    });
  }
  function resetArr(target, src) { target.length = 0; clone(src).forEach(function (x) { target.push(x); }); }
  function resetState() {
    resetObj(elecData, BASE.elec, 'elec'); resetObj(waterData, BASE.water, 'water'); resetObj(btuData, BASE.btu, 'btu');
    if (CFG.KEEP_DEMO_TICKETS) resetArr(ticketDatabase, BASE.tickets); else ticketDatabase.length = 0;
    resetArr(amcMasterDatabase, BASE.amc); resetArr(amcPPMSchedules, BASE.ppm);
    ppmLog = {}; ppmLogId = {}; roster = {}; rosterPdf = {};
  }

  /* ---------- event replay ---------- */
  function findTicket(id) { return ticketDatabase.filter(function (t) { return t.id === id; })[0]; }
  function findAmc(id) { return amcMasterDatabase.filter(function (a) { return a.id === id; })[0]; }
  function holdDaysFrom(start, at) { var s = new Date(start); if (isNaN(s)) return 1; return Math.max(1, Math.floor(((at || Date.now()) - s.getTime()) / 864e5) + 1); }

  function apply(ev) {
    var d = ev.d || {}, t, a;
    if (ev.type === 'reading') {
      var data = { elec: elecData, water: waterData, btu: btuData }[d.kind];
      var list = data && data[d.panel];
      if (!list) return;
      var f = list.filter(function (x) { return x.name === d.feeder; })[0];
      if (!f) return;
      f.prevReading = d.value; f.yesterday = d.consumption || 0; f._first = false; f.lastBy = ev.user; f.lastAt = ev.ts;
    } else if (ev.type === 'ticket.create' && d.ticket) {
      var tk = clone(d.ticket); tk.by = ev.user; tk.holdDays = 0; tk.status = 'open';
      ticketDatabase.unshift(tk);
    } else if (ev.type === 'ticket.close') {
      t = findTicket(d.id); if (!t) return;
      t.status = 'closed'; t.resolutionNotes = d.notes || 'Resolved and closed.'; t.closedBy = ev.user; t.closedAt = ev.ts; t.closePhoto = d.photo || null;
    } else if (ev.type === 'ticket.hold') {
      t = findTicket(d.id); if (!t) return;
      if (t.status !== 'hold' || !t.holdStartDate) t.holdStartDate = String(ev.ts).slice(0, 10);
      t.status = 'hold'; t.holdUntilDate = d.until; t.holdReason = d.reason; t._live = true;
      t.holdDays = holdDaysFrom(t.holdStartDate);
    } else if (ev.type === 'amc.create' && d.amc) {
      amcMasterDatabase.unshift(clone(d.amc));
      if (d.ppm) amcPPMSchedules.unshift(clone(d.ppm));
    } else if (ev.type === 'ppm.checklist') {
      (ppmLog[d.key] = ppmLog[d.key] || []).push(d.date); ppmLogId[d.key + '|' + d.date] = ev.id;
    } else if (ev.type === 'roster.set') {
      roster[d.month] = { people: d.people || [] };
    } else if (ev.type === 'roster.pdf') {
      rosterPdf[d.month] = { id: d.id, name: d.name };
    } else if (ev.type === 'ppm.done') {
      (ppmLog[d.key] = ppmLog[d.key] || []).push(d.date);
    } else if (ev.type === 'amc.renew') {
      a = findAmc(d.id); if (!a) return;
      a.start = d.start; a.end = d.end; a.status = 'Active'; a.scope = (a.scope || '') + ' | Renewed via ' + (d.po || 'PO');
    }
  }

  function allEvents() {
    var map = {}, out = [];
    events.forEach(function (e) { map[e.id] = e; });
    queue.forEach(function (e) { if (!map[e.id]) map[e.id] = e; });
    Object.keys(map).forEach(function (k) { out.push(map[k]); });
    out.sort(function (a, b) { return (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : ((a.seq || 1e12) - (b.seq || 1e12))); });
    return out;
  }
  function rebuild() {
    resetState();
    allEvents().forEach(apply);
    syncPanelSelects();
    refreshUI();
  }
  /* panel dropdowns follow the Feeders sheet; only touched when the list actually changed (keeps typed values) */
  function syncPanelSelects() {
    var sets = { elec: elecData, water: waterData, btu: btuData };
    var sig = JSON.stringify(Object.keys(sets).map(function (k) { return Object.keys(sets[k]).map(function (p) { return [p, sets[k][p].map(function (f) { return f.name; })]; }); }));
    if (sig === layoutSig) return;
    layoutSig = sig;
    Object.keys(sets).forEach(function (k) {
      var sel = $(k + '-panel-select'); if (!sel) return;
      var cur = sel.value;
      sel.innerHTML = Object.keys(sets[k]).map(function (p) { return '<option value="' + esc(p) + '">' + esc(p) + '</option>'; }).join('');
      if (sets[k][cur]) sel.value = cur;
    });
    try { initAllReadings(); } catch (e) {}
    fillPanelList();
  }
  function refreshUI() {
    try { renderTickets(); } catch (e) {}
    try { renderAMCDashboard(); renderAMCMaster(); renderPPMSchedules(); } catch (e) {}
    try { calculateElecConsumption(); calculateWaterConsumption(); calculateBtuConsumption(); } catch (e) {}
    var es = $('screen-entries'); if (es && es.classList.contains('active')) renderEntries();
    var ps = $('screen-ppm'); if (ps && ps.classList.contains('active')) { try { renderPPM(); } catch (e) {} }
    var rps = $('screen-reports'); if (rps && rps.classList.contains('active') && !repCtx) { try { renderRep(); } catch (e) {} }
    var dd = $('screen-dg'); if (dd && dd.classList.contains('active')) { try { renderDG(); } catch (e) {} }
    var rr = $('screen-roster'); if (rr && rr.classList.contains('active')) { try { renderRoster(); } catch (e) {} }
  }

  /* keep hold-day counters live + show "opening reading" label */
  (function wrapOriginals() {
    var rt = window.renderTickets;
    window.renderTickets = function () {
      ticketDatabase.forEach(function (t) { if (t._live && t.status === 'hold') t.holdDays = holdDaysFrom(t.holdStartDate); });
      return rt.apply(this, arguments);
    };
    [['elec', 'Elec', elecData], ['water', 'Water', waterData], ['btu', 'Btu', btuData]].forEach(function (k) {
      var name = 'calculate' + k[1] + 'Consumption', orig = window[name];
      window[name] = function () {
        orig.apply(this, arguments);
        try {
          var panel = $(k[0] + '-panel-select').value, idx = parseInt($(k[0] + '-feeder-select').value) || 0;
          var f = k[2][panel] && k[2][panel][idx];
          if (f && f._first) $(k[0] + '-today-val').innerHTML = '— <small>opening reading</small>';
        } catch (e) {}
      };
    });
    var om = window.openModule;
    window.openModule = function (id, tab) {
      if ((id === 'screen-users' || id === 'screen-backup') && !(session && session.role === 'admin')) { toast('Admin only'); return; }
      om(id, tab);
      var sub = $('top-bar-sub'), titles = { 'screen-entries': 'My Entries', 'screen-dg': 'DG & Fuel · Load Trial', 'screen-assets': 'Asset Master & QR', 'screen-reports': 'O&M Reports', 'screen-users': 'Admin · Users', 'screen-backup': 'Admin · Backup & Restore' };
      if (titles[id] && sub) sub.textContent = titles[id];
      if (id === 'screen-ppm') renderPPM();
      if (id === 'screen-roster') renderRoster();
      if (id === 'screen-dg') { renderDG(); pullDg(); }
      if (id === 'screen-assets') { astCat = null; astQ = ''; renderAssets(); pullAssets(); }
      if (id === 'screen-reports') { renderRep(); pullRep(); }
      if (id === 'screen-entries') renderEntries();
      if (id === 'screen-users') renderUsers();
      if (id === 'screen-backup') renderBackup();
    };
    var tma = window.toggleModalAction;
    window.toggleModalAction = function (a) {
      if (a === 'hold' && !canHold()) { toast('Only Supervisor / Engineer / Admin can put a ticket on hold'); return; }
      return tma.apply(this, arguments);
    };
    var otm = window.openTicketModal;
    window.openTicketModal = function (id) {
      otm.apply(this, arguments);
      var hb = $('tab-btn-hold-action'); if (hb) hb.style.display = canHold() ? '' : 'none';
      var t = findTicket(id), box = $('ghq-t-photo-view');
      if (!box || !t) return;
      var h = '';
      if (t.photo) h += '<div class="t-desc-lbl">Photo (raised)</div><a href="' + esc(t.photo) + '" target="_blank"><img class="ghq-hold-photo" src="' + esc(t.photo) + '"></a>';
      if (t.closePhoto) h += '<div class="t-desc-lbl" style="margin-top:6px">Photo (closed)</div><a href="' + esc(t.closePhoto) + '" target="_blank"><img class="ghq-hold-photo" src="' + esc(t.closePhoto) + '"></a>';
      if (t.by) h += '<div class="ghq-note" style="margin-top:6px">Raised by ' + esc(t.by) + (t.closedBy ? ' · Closed by ' + esc(t.closedBy) : '') + '</div>';
      box.innerHTML = h;
    };
  })();

  /* ---------- API / sync ---------- */
  function api(action, extra, cred) {
    var c = cred || session || {};
    var body = Object.assign({ action: action, name: c.name, pin: c.pin }, extra || {});
    return fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) })
      .then(function (r) { return r.text(); })
      .then(function (t) { try { return JSON.parse(t); } catch (e) { throw new Error('BAD_REPLY'); } });
  }
  function mine() { return queue.filter(function (e) { return !session || e.user === session.name; }); }

  function updatePill() {
    var p = $('ghq-pill'); if (!p) return;
    var n = queue.length;
    if (LOCAL) { p.className = 'ghq-pill wait'; p.innerHTML = '<i class="fa-solid fa-flask"></i> Local test'; return; }
    if (syncing) { p.className = 'ghq-pill wait'; p.innerHTML = '<i class="fa-solid fa-rotate"></i> Syncing…'; return; }
    if (!navigator.onLine || lastErr) { p.className = 'ghq-pill off'; p.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i> Offline' + (n ? ' (' + n + ')' : ''); return; }
    if (n) { p.className = 'ghq-pill wait'; p.innerHTML = '<i class="fa-solid fa-clock"></i> ' + n + ' pending'; return; }
    p.className = 'ghq-pill ok'; p.innerHTML = '<i class="fa-solid fa-circle-check"></i> Synced';
  }

  function sync() {
    if (LOCAL || !session || syncing || !navigator.onLine) { updatePill(); return Promise.resolve(); }
    syncing = true; updatePill();
    return pushAll().then(pullFeeders).then(pullPpm).then(pullShifts).then(pullChecklists).then(pullDg).then(pullRep).then(pullAssets).then(pullReports).then(pullAll).then(function () { lastErr = ''; lastSyncAt = Date.now(); })
      .catch(function (e) { lastErr = String(e && e.message || e); })
      .then(function () { syncing = false; updatePill(); });
  }
  function pushAll() {
    var batch = mine().slice(0, 3);
    if (!batch.length) return Promise.resolve();
    return api('push', { events: batch }).then(function (r) {
      if (!r.ok) { if (r.error === 'auth') { forceLogout('Your PIN was changed or your user was removed. Please login again.'); } throw new Error(r.error || 'push failed'); }
      var acc = {}; (r.accepted || []).forEach(function (id) { acc[id] = 1; });
      var rejected = batch.filter(function (e) { return !acc[e.id]; });
      if (rejected.length) toast(rejected.length + ' entries not allowed for your role (AMC: Admin/Supervisor · Ticket hold: Admin/Supervisor/Engineer)');
      var done = batch.map(function (e) { return e.id; });
      queue = queue.filter(function (e) { return done.indexOf(e.id) < 0; });
      return Promise.all(done.map(qDel)).then(function () { return mine().length ? pushAll() : null; });
    });
  }
  var feedersInfo = { n: null, at: null, err: '' }, lastSyncAt = null;
  function pullFeeders() {
    return api('feeders').then(function (r) {
      if (!r || !r.ok || !Array.isArray(r.feeders)) { feedersInfo.err = (r && r.error) || 'no reply'; return; }   // older backend without 'feeders' -> keep what we have
      feedersInfo = { n: r.feeders.length, at: Date.now(), err: '' };
      LS.set('ghq_feeders', r.feeders);
      feederRows = r.feeders.length ? r.feeders : null;
    });
  }
  function pullAll() {
    return api('pull', { since: lastSeq }).then(function (r) {
      if (!r.ok) { if (r.error === 'auth') forceLogout('Please login again.'); throw new Error(r.error || 'pull failed'); }
      (r.events || []).forEach(function (e) {
        if (!seen[e.id]) { events.push(e); seen[e.id] = 1; }
        if (e.seq > lastSeq) lastSeq = e.seq;
      });
      LS.set('ghq_events', events); LS.set('ghq_seq', lastSeq);
      rebuild();
      if (r.more) return pullAll();
    });
  }

  function commit(type, d) {
    var ev = { id: uid(), ts: new Date().toISOString(), user: session.name, type: type, d: d };
    queue.push(ev);
    return qPut(ev).then(function () { rebuild(); updatePill(); sync(); return ev; });
  }

  /* ---------- photos ---------- */
  var photoData = {};
  function compress(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () {
        var im = new Image();
        im.onload = function () {
          var s = Math.min(1, 1280 / Math.max(im.width, im.height));
          var c = document.createElement('canvas'); c.width = Math.round(im.width * s); c.height = Math.round(im.height * s);
          c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
          res(c.toDataURL('image/jpeg', 0.72));
        };
        im.onerror = rej; im.src = fr.result;
      };
      fr.onerror = rej; fr.readAsDataURL(file);
    });
  }
  function photoField(id) {
    var w = document.createElement('div'); w.className = 'ghq-photo-box';
    w.innerHTML = '<label class="ghq-lbl"><i class="fa-solid fa-camera"></i> Photo (optional)</label>' +
      '<input type="file" accept="image/*" id="' + id + '"><img id="' + id + '-prev" style="display:none">';
    w.querySelector('input').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0], img = $(id + '-prev');
      if (!f) { photoData[id] = null; img.style.display = 'none'; return; }
      compress(f).then(function (u) { photoData[id] = u; img.src = u; img.style.display = 'block'; })
        .catch(function () { photoData[id] = null; toast('Could not read the photo'); });
    });
    return w;
  }
  function takePhoto(id) {
    var u = photoData[id] || null; photoData[id] = null;
    var i = $(id), p = $(id + '-prev'); if (i) i.value = ''; if (p) p.style.display = 'none';
    return u;
  }
  function injectPhotoFields() {
    var nd = $('new-t-desc'); if (nd) nd.parentNode.appendChild(photoField('ph-new-ticket'));
    var rn = $('modal-resolution-notes'); if (rn) rn.parentNode.appendChild(photoField('ph-close-ticket'));
    var td = $('modal-t-desc');
    if (td) { var b = document.createElement('div'); b.id = 'ghq-t-photo-view'; td.parentNode.appendChild(b); }
  }

  /* ---------- file saving: Android app -> phone's Downloads/GHQ-OM (native FileSaver); browser -> normal download ---------- */
  function toB64(bytes) {
    var b64 = '';
    for (var i = 0; i < bytes.length; i += 0x8000) b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(b64);
  }
  function nativeSave(name, mime, b64) {
    var cap = window.Capacitor; if (!(cap && cap.isNativePlatform && cap.isNativePlatform())) return Promise.reject(new Error('not native'));
    var o = { name: name, mime: mime, data: b64 }, P = cap.Plugins && cap.Plugins.FileSaver;
    if (P && P.save) return P.save(o);
    if (cap.nativePromise) return cap.nativePromise('FileSaver', 'save', o);
    return Promise.reject(new Error('no FileSaver'));
  }
  function shareFallback(name, b64) {                // old route if the native saver is unavailable
    var cap = window.Capacitor, P = cap && cap.Plugins;
    if (!(P && P.Filesystem && P.Share)) { toast('Could not save the file'); return Promise.resolve(); }
    return P.Filesystem.writeFile({ path: name, data: b64, directory: 'CACHE' })
      .then(function (r) { return P.Share.share({ title: name, url: r.uri, dialogTitle: 'Save / open ' + name }); })
      .catch(function (e) { toast('Save failed: ' + (e && e.message || e)); });
  }
  function saveBytes(name, mime, bytes) {
    var cap = window.Capacitor, native = cap && cap.isNativePlatform && cap.isNativePlatform();
    if (native) {
      var b64 = toB64(bytes);
      return nativeSave(name, mime, b64).then(function () { toast('✔ Saved in Downloads/GHQ-OM: ' + name); }).catch(function () { return shareFallback(name, b64); });
    }
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: mime })); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    toast('✔ Downloaded ' + name);
    return Promise.resolve();
  }
  function saveFile(name, mime, text) {
    return saveBytes(name, mime, new TextEncoder().encode(text));
  }
  var XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  function csv(rows) {
    return '﻿' + rows.map(function (r) {
      return r.map(function (v) { v = (v == null ? '' : String(v)); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',');
    }).join('\r\n');
  }
  function stamp() { return new Date().toISOString().slice(0, 10); }

  /* ---------- replaced actions (were demo alerts) ---------- */
  var READ = {
    elec: { data: elecData, p: 'elec-panel-select', f: 'elec-feeder-select', i: 'elec-current-reading', unit: 'kWh', calc: 'calculateElecConsumption', label: 'Electrical' },
    water: { data: waterData, p: 'water-panel-select', f: 'water-feeder-select', i: 'water-current-reading', unit: 'kL', calc: 'calculateWaterConsumption', label: 'Water' },
    btu: { data: btuData, p: 'btu-panel-select', f: 'btu-feeder-select', i: 'btu-current-reading', unit: 'MWH', calc: 'calculateBtuConsumption', label: 'BTU' }
  };
  function saveReading(kind) {
    var c = READ[kind], panel = $(c.p).value, idx = parseInt($(c.f).value) || 0;
    var feeder = (c.data[panel] || [])[idx];
    if (!feeder) { toast('Select a feeder'); return; }
    var val = parseFloat($(c.i).value);
    if (isNaN(val)) { toast('Enter the current reading'); return; }
    var first = !!feeder._first, prev = first ? null : feeder.prevReading, cons = 0, note = '';
    if (!first) {
      if (val < prev) {
        if (!confirm('This reading is lower than the previous (' + prev + ').\nWas the meter reset or replaced? If not, press Cancel and recheck.')) return;
        note = 'meter reset';
      } else {
        cons = kind === 'elec' ? Math.round(val - prev) : Math.round((val - prev) * 10) / 10;
        if (val === prev && !confirm('Reading is same as the previous one. Save anyway?')) return;
      }
    }
    var d = { kind: kind, panel: panel, idx: idx, feeder: feeder.name, prev: prev, value: val, consumption: cons, note: note };
    commit('reading', d).then(function () {
      $(c.i).value = ''; window[c.calc]();
      toast('✔ ' + c.label + ' reading saved' + (navigator.onLine && !LOCAL ? '' : ' (will sync later)'));
    });
  }

  window.submitNewTicket = function () {
    var title = $('new-t-title').value.trim(), loc = $('new-t-loc').value.trim(), desc = $('new-t-desc').value.trim();
    if (!title) { alert('Please enter Issue Title!'); return; }
    if (!loc) { alert('Please enter Location / Floor!'); return; }
    if (!desc) { alert('Please enter Detailed Problem Description!'); return; }
    var now = new Date();
    var id = 'T-' + ('0' + now.getDate()).slice(-2) + ('0' + (now.getMonth() + 1)).slice(-2) + '-' + Math.random().toString(36).slice(2, 5).toUpperCase();
    var tech = $('new-t-tech').value;
    var ticket = {
      id: id, title: title, dept: $('new-t-dept').value, tag: $('new-t-tag').value.trim() || 'N/A', loc: loc, priority: $('new-t-priority').value,
      status: 'open', date: now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
      tech: tech, desc: desc, holdStartDate: null, holdUntilDate: null, holdReason: null, holdDays: 0
    };
    var photo = takePhoto('ph-new-ticket'); if (photo) ticket.photo = photo;
    commit('ticket.create', { ticket: ticket }).then(function () {
      closeNewTicketModal(); toast('✔ Ticket ' + id + ' → ' + tech);
    });
  };

  window.executeCloseCurrentTicket = function () {
    if (!selectedTicketId) return;
    var t = findTicket(selectedTicketId); if (!t || t.status === 'closed') return;
    var notes = $('modal-resolution-notes').value.trim();
    if (!confirm('Confirm closing ticket ' + t.id + ' (' + t.title + ')?')) return;
    var d = { id: t.id, notes: notes || 'Resolved and closed.' }, p = takePhoto('ph-close-ticket'); if (p) d.photo = p;
    commit('ticket.close', d).then(function () { closeTicketModal(); toast('✔ Ticket ' + d.id + ' closed'); });
  };

  window.executeSaveHoldState = function () {
    if (!canHold()) { toast('Only Supervisor / Engineer / Admin can put a ticket on hold'); return; }
    if (!selectedTicketId) return;
    var t = findTicket(selectedTicketId); if (!t) return;
    var until = $('modal-hold-until-date').value, reason = $('modal-hold-reason-input').value.trim();
    if (!until) { alert('Please select the Hold Until Date!'); return; }
    if (!reason) { alert('Please enter the reason for placing/extending hold!'); return; }
    commit('ticket.hold', { id: t.id, until: until, reason: reason }).then(function () { closeTicketModal(); toast('✔ Ticket ' + t.id + ' on hold until ' + until); });
  };

  function fmtDate(s, dflt) {
    if (!s) return dflt;
    var d = new Date(s); return isNaN(d) ? dflt : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  window.submitNewAMC = function () {
    var vendor = $('new-amc-vendor').value.trim(), system = $('new-amc-system').value.trim();
    var qty = parseInt($('new-amc-qty').value) || 1, freq = $('new-amc-freq').value, coverage = $('new-amc-coverage').value;
    var person = $('new-amc-person').value.trim(), phone = $('new-amc-phone').value.trim(), email = $('new-amc-email').value.trim();
    var scope = $('new-amc-scope').value.trim() || coverage + ' AMC Agreement';
    if (!vendor) { alert('Please enter Vendor Name!'); return; }
    if (!system) { alert('Please enter Equipment/System Name!'); return; }
    if (!person || !phone) { alert('Please enter Contact Person Name & Phone Number!'); return; }
    var id = 'AMC-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    var start = fmtDate($('new-amc-start').value, fmtDate(new Date().toISOString(), '')), end = fmtDate($('new-amc-end').value, start);
    var amc = { id: id, vendor: vendor, system: system, qty: qty, start: start, end: end, status: 'Active', freq: freq, contactPerson: person, phone: phone, email: email, scope: scope };
    var ppm = { id: 'PPM-' + id, vendor: vendor, equip: system + ' Bank (' + qty + ' Units)', tag: 'EQ-' + id, freq: freq, lastPPM: start, nextPPM: end, daysRemaining: 30, status: 'upcoming', reportAvail: true, checklistAvail: true };
    commit('amc.create', { amc: amc, ppm: ppm }).then(function () { closeNewAMCModal(); toast('✔ AMC ' + id + ' registered'); });
  };

  window.submitRenewAMC = function () {
    var id = $('renew-select-contract').value, a = findAmc(id); if (!a) return;
    var s = fmtDate($('renew-start-date').value, ''), e = fmtDate($('renew-end-date').value, '');
    if (!s || !e) { alert('Please select new Start and End dates!'); return; }
    var po = $('renew-po-number').value.trim() || 'PO-RENEW';
    commit('amc.renew', { id: id, start: s, end: e, po: po }).then(function () { closeRenewAMCModal(); toast('✔ AMC ' + id + ' renewed until ' + e); });
  };

  window.exportTicketsToExcel = function () {
    if (!canDownload()) { toast('Excel download is for Admin / Engineer / RIL / PM / APM'); return; }
    var H = function (t) { return { v: t, s: 1 }; };
    var rows = [['Ticket', 'Title', 'Dept', 'Tag', 'Location', 'Priority', 'Status', 'Raised', 'Raised by', 'Technician', 'Description', 'Hold until', 'Hold reason', 'Resolution', 'Closed by', 'Photo'].map(H)];
    ticketDatabase.forEach(function (t) { rows.push([t.id, t.title, t.dept, t.tag, t.loc, t.priority, t.status, t.date, t.by || '', t.tech, t.desc, t.holdUntilDate || '', t.holdReason || '', t.resolutionNotes || '', t.closedBy || '', t.photo || '']); });
    var bytes = XlsxLite.build([{ name: 'Tickets', cols: [12, 30, 12, 14, 18, 10, 10, 13, 14, 16, 40, 13, 24, 30, 14, 30], rows: rows, freeze: true }]);
    saveBytes('Tickets_' + stamp() + '.xlsx', XLSX_MIME, bytes);
  };

  /* ---------- monthly readings workbook: one sheet per panel, feeders across, Date + Reading + Consumption ---------- */
  function p2(n) { return ('0' + n).slice(-2); }
  function dayKey(ts) { var d = new Date(ts); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
  function serialOf(y, m, d) { return Math.round(Date.UTC(y, m, d) / 864e5) + 25569; }
  function sheetName(panel, used) {
    var n = String(panel).replace(/[\[\]:*?\/\\]/g, '-').trim().slice(0, 31) || 'Panel', k = n, i = 2;
    while (used[k.toLowerCase()]) { k = n.slice(0, 28) + ' ' + i++; }
    used[k.toLowerCase()] = 1; return k;
  }
  function buildPanelSheets(y, mo, evs) {             // y, mo(0-11); evs = all reading events sorted by time. Returns [{name, cols, rows, merges, freeze}]
    var H = function (t) { return { v: t, s: 1 }; }, WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var hist = {};
    evs.forEach(function (e) { var d = e.d, k = d.kind + '|' + d.panel + '|' + d.feeder; (hist[k] = hist[k] || []).push({ day: dayKey(e.ts), v: Number(d.value) }); });
    var nDays = new Date(y, mo + 1, 0).getDate(), baseKey = dayKey(new Date(y, mo, 0).getTime() + 12 * 36e5), keys = [];
    for (var i = 1; i <= nDays; i++) keys.push(y + '-' + p2(mo + 1) + '-' + p2(i));
    var used = {}, out = [];
    [['elec', elecData], ['water', waterData], ['btu', btuData]].forEach(function (set) {
      var kind = set[0], data = set[1], unit = (READ[kind] || {}).unit || '';
      Object.keys(data).forEach(function (panel) {
        var cols = [], any = false;
        data[panel].forEach(function (f) {
          var h = hist[kind + '|' + panel + '|' + f.name] || [], byDay = {}, base;
          h.forEach(function (x) { if (x.day <= baseKey) base = x.v; byDay[x.day] = x.v; });
          var vals = [base], cons = [''], prev = base;
          keys.forEach(function (k) {
            var v = byDay[k];
            if (v !== undefined && !isNaN(v)) { cons.push(prev === undefined ? '' : Math.round((v - prev) * 100) / 100); prev = v; vals.push(v); if (k.slice(0, 7) === y + '-' + p2(mo + 1)) any = true; }
            else { vals.push(undefined); cons.push(''); }
          });
          cols.push({ name: f.name, vals: vals, cons: cons });
        });
        if (!any) return;
        var r1 = [{ v: panel, s: 4 }], r2 = [{ v: (READ[kind] || {}).label + ' · ' + new Date(y, mo, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }), s: 0 }];
        var r3 = ['', ''], r4 = [H('Day'), H('Date')], merges = [], widths = [7, 13];
        cols.forEach(function (c, i) {
          var cl = 3 + i * 2; r3.push(H(c.name), H(''));
          merges.push(XlsxLite.col(cl) + '3:' + XlsxLite.col(cl + 1) + '3');
          r4.push(H('Reading'), H('Consumption in ' + unit)); widths.push(15, 16);
        });
        var rows = [r1, r2, r3, r4], sums = cols.map(function () { return 0; });
        for (var d = 0; d <= nDays; d++) {
          var dt = d === 0 ? new Date(y, mo, 0) : new Date(y, mo, d);
          var row = [WD[dt.getDay()], { v: serialOf(dt.getFullYear(), dt.getMonth(), dt.getDate()), s: 2 }];
          cols.forEach(function (c, i) {
            row.push(c.vals[d] === undefined ? '' : c.vals[d], c.cons[d]);
            if (c.cons[d] !== '') sums[i] += c.cons[d];
          });
          rows.push(row);
        }
        var tot = ['', { v: 'Total', s: 5 }];
        sums.forEach(function (x) { tot.push('', { v: Math.round(x * 100) / 100, s: 5 }); });
        rows.push(tot);
        out.push({ name: sheetName(panel, used), cols: widths, rows: rows, merges: merges, freeze: { r: 4, c: 2 } });
      });
    });
    return out;
  }
  function monthlyReport() {
    if (!canDownload()) { toast('Excel download is for Admin / Engineer / RIL / PM / APM'); return; }
    var m = $('rep-month').value;
    if (!/^\d{4}-\d{2}$/.test(m)) { toast('Select a month'); return; }
    var y = +m.slice(0, 4), mo = +m.slice(5, 7) - 1;
    var evs = allEvents().filter(function (e) { return e.type === 'reading'; });
    var sheets = buildPanelSheets(y, mo, evs);
    if (!sheets.length) { toast('No readings in ' + new Date(y, mo, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })); return; }
    saveBytes('GHQ_Readings_' + m + '.xlsx', XLSX_MIME, XlsxLite.build(sheets));
  }
  function injectReportBox() {
    var old = $('rep-box'); if (old) old.remove();
    var scr = $('screen-readings'), hdr = scr && scr.querySelector('.op-screen-header');
    if (!hdr || !canDownload()) return;
    var now = new Date(), cur = now.getFullYear() + '-' + ('0' + (now.getMonth() + 1)).slice(-2);
    var box = document.createElement('div'); box.className = 'sub-section-box'; box.id = 'rep-box';
    box.innerHTML = '<div class="sub-section-header"><i class="fa-solid fa-file-excel"></i> Monthly readings Excel (panel-wise)</div>' +
      '<div class="ghq-grid2" style="align-items:end"><div><label class="ghq-lbl">Select month</label><input type="month" id="rep-month" class="ghq-input" value="' + cur + '"></div>' +
      '<button class="ghq-btn" onclick="GHQ.monthlyReport()"><i class="fa-solid fa-download"></i> Download Excel</button></div>' +
      '<div class="ghq-note">One sheet per panel · feeders across · Date, Reading and Consumption. Saved in your phone\'s Downloads/GHQ-OM folder.</div>';
    hdr.insertAdjacentElement('afterend', box);
  }

  /* ---------- admin: add a new panel / feeders (goes to the Feeders sheet) ---------- */
  function injectFeederBox() {
    var old = $('fd-box'); if (old) old.remove();
    var scr = $('screen-readings'), anchor = $('rep-box');
    if (!scr || !anchor || !session || session.role !== 'admin') return;
    var box = document.createElement('div'); box.className = 'sub-section-box'; box.id = 'fd-box';
    box.innerHTML = '<div class="sub-section-header"><i class="fa-solid fa-plus"></i> Add panel / feeders (Admin)</div>' +
      '<div class="ghq-grid2"><div><label class="ghq-lbl">Type</label><select id="fd-type" class="cal-select" style="width:100%"><option>Electrical</option><option>Water</option><option>BTU</option></select></div>' +
      '<div><label class="ghq-lbl">Panel (new or existing)</label><input id="fd-panel" class="ghq-input" list="fd-panels" placeholder="Panel name"><datalist id="fd-panels"></datalist></div></div>' +
      '<div><label class="ghq-lbl">Feeders — one per line</label><textarea id="fd-feeders" class="ghq-input" rows="3" placeholder="Feeder 1&#10;Feeder 2"></textarea></div>' +
      '<button class="ghq-btn" onclick="GHQ.addFeeders()">Add to Feeders sheet</button><div class="ghq-note">Staff can only enter readings. New panels appear for everyone after the next sync.</div>';
    anchor.insertAdjacentElement('afterend', box);
    fillPanelList();
  }
  function fillPanelList() {
    var dl = $('fd-panels'); if (!dl) return;
    var seenP = {}, rows = feederRows || [];
    dl.innerHTML = rows.filter(function (r) { if (seenP[r.panel]) return false; seenP[r.panel] = 1; return true; })
      .map(function (r) { return '<option value="' + esc(r.panel) + '">'; }).join('');
  }
  function addFeeders() {
    var type = $('fd-type').value, panel = $('fd-panel').value.trim(), list = $('fd-feeders').value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
    if (!panel) { toast('Enter the panel name'); return; }
    if (!list.length) { toast('Enter at least one feeder'); return; }
    if (LOCAL) { toast('Not available in local test mode'); return; }
    api('feeder_add', { type: type, panel: panel, feeders: list }).then(function (r) {
      if (!r.ok) throw new Error(r.error === 'auth' ? 'Not allowed' : r.error);
      toast('✔ Added ' + r.added + (r.skipped && r.skipped.length ? ' · ' + r.skipped.length + ' already existed' : ''));
      $('fd-feeders').value = '';
      return sync();
    }).catch(function (e) { toast(String(e && e.message) === 'Failed to fetch' ? 'Internet required' : 'Error: ' + (e && e.message)); });
  }

  /* ---------- screens: My Entries / Users / Backup ---------- */
  function label(ev) {
    var d = ev.d || {};
    switch (ev.type) {
      case 'reading': return '⚡ ' + (READ[d.kind] ? READ[d.kind].label : d.kind) + ' — ' + d.feeder + ': ' + d.value + ' ' + (READ[d.kind] ? READ[d.kind].unit : '') + (d.prev == null ? ' (opening)' : ' (used ' + d.consumption + ')');
      case 'ticket.create': return '🎫 New ticket ' + d.ticket.id + ' — ' + d.ticket.title;
      case 'ticket.close': return '✅ Closed ' + d.id + (d.notes ? ' — ' + d.notes : '');
      case 'ticket.hold': return '⏸ Hold ' + d.id + ' until ' + d.until + ' — ' + d.reason;
      case 'amc.create': return '📄 New AMC ' + d.amc.id + ' — ' + d.amc.vendor;
      case 'roster.set': return '📅 Roster uploaded — ' + d.month + ' (' + (d.people || []).length + ' people)';
      case 'roster.pdf': return '📄 Roster PDF — ' + d.month;
      case 'ppm.checklist': return '✅ PPM checklist — ' + d.eq + (d.tag ? ' [' + d.tag + ']' : '') + ' (' + d.date + ')';
      case 'ppm.done': return '🛠 PPM done — ' + d.eq + ' (' + d.date + ')';
      case 'amc.renew': return '🔁 Renewed AMC ' + d.id + ' until ' + d.end;
      default: return ev.type;
    }
  }
  function ensureScreens() {
    var host = document.querySelector('.app-container');
    function sec(id, html) { if ($(id)) return; var s = document.createElement('section'); s.className = 'screen-view'; s.id = id; s.innerHTML = html; host.appendChild(s); }
    sec('screen-entries',
      '<div class="op-screen-header"><button class="op-back-btn" onclick="openModule(\'screen-dashboard\')"><i class="fa-solid fa-arrow-left"></i> Back</button>' +
      '<div class="op-title-area"><h2><i class="fa-solid fa-list-check"></i> Entries</h2><p id="entries-sub"></p></div></div>' +
      '<div id="entries-filter-wrap" style="display:none"><label class="ghq-lbl">Filter by user</label><select id="entries-user" class="cal-select" style="width:100%" onchange="GHQ.renderEntries()"></select></div>' +
      '<div id="entries-list" style="display:flex;flex-direction:column;gap:8px"></div>');
    sec('screen-roster',
      '<div class="op-screen-header"><button class="op-back-btn" onclick="openModule(\'screen-dashboard\')"><i class="fa-solid fa-arrow-left"></i> Back</button>' +
      '<div class="op-title-area"><h2><i class="fa-solid fa-users"></i> Duty Shift Roster</h2><p id="ro-sub"></p></div></div>' +
      '<div id="ro-mine"></div>' +
      '<div class="cal-controls" style="margin:8px 0"><button class="cal-nav-btn" onclick="GHQ.roMonth(-1)"><i class="fa-solid fa-chevron-left"></i></button>' +
      '<div id="ro-title" style="flex:1;text-align:center;font-weight:800;color:var(--gold-light)"></div>' +
      '<button class="cal-nav-btn" onclick="GHQ.roMonth(1)"><i class="fa-solid fa-chevron-right"></i></button></div>' +
      '<div id="ro-pdf"></div>' +
      '<div class="sub-section-box"><div class="cal-weekdays"><span class="sun">Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span></div>' +
      '<div class="cal-grid" id="ro-grid" style="margin-top:6px"></div></div>' +
      '<div id="ro-day"></div><div id="ro-legend"></div><div id="ro-admin"></div>');
    sec('screen-users',
      '<div class="op-screen-header"><button class="op-back-btn" onclick="openModule(\'screen-dashboard\')"><i class="fa-solid fa-arrow-left"></i> Back</button>' +
      '<div class="op-title-area"><h2><i class="fa-solid fa-users-gear"></i> Users</h2><p>Name + PIN logins</p></div></div>' +
      '<div class="sub-section-box"><div class="sub-section-header">Add / update user</div>' +
      '<input id="u-name" class="ghq-input" placeholder="Name (e.g. Sachin)">' +
      '<input id="u-pin" class="ghq-input" inputmode="numeric" placeholder="PIN (4–6 digits) — leave blank to keep old">' +
      '<div class="ghq-grid2"><select id="u-role" class="cal-select"><option value="staff">Staff</option><option value="admin">Admin</option><option value="engineer">Engineer</option><option value="ril">RIL</option><option value="pm">PM</option><option value="apm">APM</option><option value="supervisor">Supervisor</option></select>' +
      '<select id="u-work" class="cal-select"><option>Electrical</option><option>HVAC</option><option>Plumbing</option><option>Supervisor</option></select></div>' +
      '<button class="ghq-btn" onclick="GHQ.saveUser()">Save user</button><div class="ghq-note">Same name again = update PIN / role. Excel download: Admin, Engineer, RIL, PM, APM. Ticket hold &amp; PPM equipment: Admin, Engineer, Supervisor.</div></div>' +
      '<div id="users-list" style="display:flex;flex-direction:column;gap:8px"></div>');
    sec('screen-backup',
      '<div class="op-screen-header"><button class="op-back-btn" onclick="openModule(\'screen-dashboard\')"><i class="fa-solid fa-arrow-left"></i> Back</button>' +
      '<div class="op-title-area"><h2><i class="fa-solid fa-shield-halved"></i> Backup & Restore</h2><p id="bk-sub"></p></div></div>' +
      '<div class="sub-section-box"><div class="sub-section-header">Connection status</div><div id="bk-status" class="ghq-note"></div>' +
      '<button class="ghq-btn ghost" onclick="GHQ.syncNow()">Sync now</button></div>' +
      '<div class="sub-section-box"><div class="sub-section-header">Google Drive backup</div>' +
      '<div class="ghq-note">Every night at ~2 AM the Google Sheet is copied to Drive folder <b>GHQ_OM_Backups</b> (last 30 kept).</div>' +
      '<button class="ghq-btn" onclick="GHQ.backupNow()">Backup now to Drive</button><div id="bk-msg" class="ghq-note"></div></div>' +
      '<div class="sub-section-box"><div class="sub-section-header">Download</div>' +
      '<button class="ghq-btn ghost" onclick="GHQ.downloadJSON()">Full backup (.json)</button>' +
      '<button class="ghq-btn ghost" onclick="GHQ.downloadReadings()">Readings (Excel / .csv)</button>' +
      '<button class="ghq-btn ghost" onclick="exportTicketsToExcel()">Tickets (Excel / .csv)</button></div>' +
      '<div class="sub-section-box"><div class="sub-section-header">Restore</div>' +
      '<div class="ghq-note">Choose a backup .json. Entries already present are skipped, so restoring twice is safe.</div>' +
      '<input type="file" id="bk-file" accept=".json,application/json" style="font-size:.75rem;color:var(--text-muted)">' +
      '<button class="ghq-btn danger" onclick="GHQ.restore()">Restore from file</button></div>');
  }

  function renderEntries() {
    var isAdmin = session && session.role === 'admin', sel = $('entries-user');
    $('entries-filter-wrap').style.display = isAdmin ? 'block' : 'none';
    var evs = allEvents().slice().reverse(), users = {};
    evs.forEach(function (e) { users[e.user] = 1; });
    if (isAdmin && sel && sel.options.length !== Object.keys(users).length + 1) {
      var cur = sel.value;
      sel.innerHTML = '<option value="">All users</option>' + Object.keys(users).sort().map(function (u) { return '<option>' + esc(u) + '</option>'; }).join('');
      sel.value = cur;
    }
    var who = isAdmin ? (sel ? sel.value : '') : session.name;
    var list = evs.filter(function (e) { return !who || e.user === who; }).slice(0, 150);
    $('entries-sub').textContent = (isAdmin ? (who || 'All users') : session.name) + ' · ' + list.length + ' recent';
    var pend = {}; queue.forEach(function (e) { pend[e.id] = 1; });
    $('entries-list').innerHTML = list.length ? list.map(function (e) {
      return '<div class="ghq-row"><b>' + esc(label(e)) + '</b><span>' + esc(e.user) + ' · ' + esc(fmt(e.ts)) + (pend[e.id] ? ' · <i class="pend">pending sync</i>' : '') + '</span></div>';
    }).join('') : '<div class="ghq-note">No entries yet.</div>';
  }

  function renderUsers() {
    var box = $('users-list');
    if (LOCAL) { box.innerHTML = '<div class="ghq-note">Local test mode — connect the Google Script URL to manage users.</div>'; return; }
    box.innerHTML = '<div class="ghq-note">Loading…</div>';
    api('users_list').then(function (r) {
      if (!r.ok) throw new Error(r.error);
      box.innerHTML = r.users.filter(function (u) { return u.active; }).map(function (u) {
        return '<div class="ghq-row"><b>' + esc(u.name) + '</b><span>' + esc(u.role) + ' · ' + esc(u.work) + '</span>' +
          '<div class="ghq-grid2" style="margin-top:6px"><button class="ghq-btn ghost" onclick="GHQ.editUser(' + esc(JSON.stringify(JSON.stringify(u))) + ')">Edit</button>' +
          '<button class="ghq-btn danger" onclick="GHQ.removeUser(' + esc(JSON.stringify(u.name)) + ')">Remove</button></div></div>';
      }).join('') || '<div class="ghq-note">No users.</div>';
    }).catch(function (e) { box.innerHTML = '<div class="ghq-err">' + esc(e.message) + ' (internet required)</div>'; });
  }
  function editUser(json) { var u = JSON.parse(json); $('u-name').value = u.name; $('u-pin').value = ''; $('u-role').value = u.role; $('u-work').value = u.work || 'Electrical'; window.scrollTo({ top: 0, behavior: 'smooth' }); }
  function saveUser() {
    var u = { name: $('u-name').value.trim(), pin: $('u-pin').value.trim(), role: $('u-role').value, work: $('u-work').value };
    if (!u.name) { toast('Enter a name'); return; }
    if (u.pin && !/^\d{4,6}$/.test(u.pin)) { toast('PIN must be 4–6 digits'); return; }
    api('user_save', { u: u }).then(function (r) { if (!r.ok) throw new Error(r.error); toast('✔ User saved'); $('u-name').value = ''; $('u-pin').value = ''; renderUsers(); })
      .catch(function (e) { toast('Error: ' + e.message); });
  }
  function removeUser(name) {
    if (!confirm('Remove ' + name + '? (their old entries will stay)')) return;
    api('user_delete', { target: name }).then(function (r) { if (!r.ok) throw new Error(r.error); toast('Removed'); renderUsers(); })
      .catch(function (e) { toast('Error: ' + e.message); });
  }

  function renderBackup() {
    $('bk-sub').textContent = LOCAL ? 'Local test mode' : (queue.length + ' entries pending on this phone');
    $('bk-msg').textContent = '';
    var st = $('bk-status'); if (!st) return;
    if (LOCAL) { st.textContent = 'Local test mode (no server URL in config.js).'; return; }
    var t = function (x) { return x ? new Date(x).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—'; };
    st.innerHTML = 'User: <b>' + esc(session.name) + '</b> (' + esc(session.role) + ')<br>Last sync: <b>' + t(lastSyncAt) + '</b>' + (lastErr ? ' · <span style="color:#fca5a5">' + esc(lastErr) + '</span>' : '') +
      '<br>Pending on this phone: <b>' + queue.length + '</b><br>Feeders list: ' +
      (feedersInfo.err ? '<span style="color:#fca5a5">not loaded (' + esc(feedersInfo.err) + ') — redeploy Apps Script as a New version</span>'
        : feedersInfo.n === null ? 'not loaded yet — tap Sync now'
        : feedersInfo.n === 0 ? '<span style="color:#fbbf24">0 rows in the Feeders sheet — using the built-in list</span>'
        : '<b>' + feedersInfo.n + '</b> rows loaded from the Feeders sheet at ' + t(feedersInfo.at));
  }
  function backupNow() {
    if (LOCAL) { toast('No Drive in local test mode'); return; }
    $('bk-msg').textContent = 'Working…';
    api('backup_now').then(function (r) { if (!r.ok) throw new Error(r.error); $('bk-msg').textContent = '✔ Saved in Drive: ' + r.file; })
      .catch(function (e) { $('bk-msg').textContent = 'Error: ' + e.message; });
  }
  function downloadJSON() {
    var data = { app: 'ghq-om', v: 1, exported: new Date().toISOString(), by: session.name, events: allEvents().map(function (e) { var c = clone(e); delete c.seq; return c; }) };
    saveFile('GHQ_OM_Backup_' + stamp() + '.json', 'application/json', JSON.stringify(data));
  }
  function downloadReadings() {
    var rows = [['Time', 'User', 'Type', 'Panel', 'Feeder', 'Previous', 'Current', 'Consumption', 'Unit']];
    allEvents().filter(function (e) { return e.type === 'reading'; }).forEach(function (e) {
      var d = e.d; rows.push([fmt(e.ts), e.user, READ[d.kind] ? READ[d.kind].label : d.kind, d.panel, d.feeder, d.prev == null ? '' : d.prev, d.value, d.consumption, READ[d.kind] ? READ[d.kind].unit : '']);;
    });
    saveFile('Readings_' + stamp() + '.csv', 'text/csv', csv(rows));
  }
  function restore() {
    var f = $('bk-file').files && $('bk-file').files[0];
    if (!f) { toast('Choose a backup file'); return; }
    var fr = new FileReader();
    fr.onload = function () {
      var data; try { data = JSON.parse(fr.result); } catch (e) { toast('Invalid file'); return; }
      if (!data || data.app !== 'ghq-om' || !Array.isArray(data.events)) { toast('This is not a GHQ backup file'); return; }
      if (!confirm(data.events.length + ' entries will be restored. Continue?')) return;
      var evs = data.events.filter(function (e) { return e && e.id && e.type; });
      if (LOCAL) {
        var have = {}; allEvents().forEach(function (e) { have[e.id] = 1; });
        Promise.all(evs.filter(function (e) { return !have[e.id]; }).map(function (e) { queue.push(e); return qPut(e); })).then(function () { rebuild(); toast('✔ Restored'); });
        return;
      }
      var i = 0;
      (function next() {
        if (i >= evs.length) { toast('✔ Restored ' + evs.length); sync(); return; }
        var chunk = evs.slice(i, i + 20); i += 20;
        $('bk-msg').textContent = 'Restoring ' + Math.min(i, evs.length) + '/' + evs.length + '…';
        api('push', { events: chunk, restore: true }).then(function (r) { if (!r.ok) throw new Error(r.error); next(); })
          .catch(function (e) { $('bk-msg').textContent = 'Error: ' + e.message; });
      })();
    };
    fr.readAsText(f);
  }

  /* ---------- login / session ---------- */
  function loginHtml() {
    return '<div class="ghq-login-card"><img src="logo.png" alt="GHQ O&M" class="ghq-logo"><p style="text-align:center">Engineering Operations Suite — Login</p>' +
      '<div><label class="ghq-lbl">Name</label><input id="lg-name" class="ghq-input" type="text" autocomplete="username" autocapitalize="words" autocorrect="off" spellcheck="false" placeholder="Enter your name"></div>' +
      '<div><label class="ghq-lbl">PIN / Password</label><input id="lg-pin" class="ghq-input" type="password" autocomplete="current-password" maxlength="12" placeholder="••••"></div>' +
      '<div id="lg-err" class="ghq-err"></div><button id="lg-btn" class="ghq-btn" onclick="GHQ.login()">Login</button>' +
      '<div style="display:flex;justify-content:space-between;align-items:center"><a href="#" onclick="GHQ.checkServer();return false" class="ghq-note" style="color:var(--gold-primary)">Check connection</a><span class="ghq-note">' + VERSION + '</span></div></div>';
  }
  function showLogin(msg) {
    var o = $('ghq-login');
    if (!o) {
      o = document.createElement('div'); o.id = 'ghq-login'; o.className = 'ghq-login'; o.innerHTML = loginHtml(); document.body.appendChild(o);
      ['lg-name', 'lg-pin'].forEach(function (id) { $(id).addEventListener('keydown', function (e) { if (e.key === 'Enter') login(); }); });
    }
    o.style.display = 'flex'; $('lg-err').textContent = msg || ''; $('lg-pin').value = '';
    $('lg-name').value = LS.get('ghq_last_user', '');
    if (NOT_CONFIGURED) { $('lg-err').textContent = 'This app is not connected to the server: no web app URL in config.js. Admin: fix config.js and build again.'; $('lg-btn').disabled = true; }
  }
  function checkServer() {
    var e = $('lg-err');
    if (NOT_CONFIGURED) { e.textContent = 'No web app URL in config.js.'; return; }
    e.style.color = '#fbbf24'; e.textContent = 'Checking…';
    api('ping', {}, {}).then(function (r) {
      e.textContent = r && r.pong ? (r.ready ? '✔ Server OK' : 'Server reachable, but setup was not run. Admin: run setup in Apps Script.') : 'Unexpected reply from server.';
    }).catch(function (x) {
      e.textContent = String(x && x.message) === 'BAD_REPLY'
        ? 'Server sent a web page instead of data. Admin: Deploy → Manage deployments → Who has access must be "Anyone", and use the latest version.'
        : 'Cannot reach the server. Check internet, and the URL in config.js.';
    }).then(function () { setTimeout(function () { e.style.color = ''; }, 4000); });
  }
  function login() {
    var name = $('lg-name').value.trim(), pin = $('lg-pin').value.trim(), btn = $('lg-btn');
    function err(t) { $('lg-err').textContent = t; }
    if (!name || !pin) { err('Enter your name and PIN'); return; }
    btn.disabled = true; err('');
    api('login', {}, { name: name, pin: pin }).then(function (r) {
      if (r.ok) {
        session = { name: r.name, pin: pin, role: r.role, work: r.work };
        LS.set('ghq_session', session); LS.set('ghq_last_user', r.name);
        $('ghq-login').style.display = 'none'; start(); return;
      }
      if (r.error === 'auth') err('Wrong name or PIN');
      else err('Server problem: ' + r.error + '. Admin: run setup in Apps Script and redeploy.');
    }).catch(function (e) {
      if (String(e && e.message) === 'BAD_REPLY') { err('Cannot talk to the server. Admin: check the web app URL in config.js and that the deployment access is "Anyone".'); return; }
      var prev = LS.get('ghq_session', null);                       // offline: allow same person on same phone
      if (prev && prev.name.toLowerCase() === name.toLowerCase() && prev.pin === pin) { session = prev; $('ghq-login').style.display = 'none'; start(); }
      else err('No internet — first login needs internet');
    }).then(function () { btn.disabled = false; });
  }
  function forceLogout(msg) { LS.del('ghq_session'); session = null; if (timer) clearInterval(timer); showLogin(msg); }
  function logout() {
    var n = mine().length;
    if (n && !confirm(n + ' entries are not synced yet. They stay on this phone and upload at your next login. Logout anyway?')) return;
    forceLogout('');
  }

  function injectMenus() {
    var menu = document.querySelector('.sidebar-menu');
    if (!menu || menu.querySelector('[data-ghq]')) return;
    function item(icon, text, js) { return '<div class="menu-item" data-ghq="1" onclick="' + js + '"><i class="fa-solid ' + icon + '"></i><span>' + text + '</span></div>'; }
    var h = '<div class="menu-group-label" data-ghq="1">My Account</div>' +
      item('fa-list-check', 'My Entries', "openModule('screen-entries')");
    if (session.role === 'admin') h += '<div class="menu-group-label" data-ghq="1">Admin</div>' +
      item('fa-users-gear', 'Users & PIN', "openModule('screen-users')") + item('fa-shield-halved', 'Backup & Restore', "openModule('screen-backup')");
    h += item('fa-right-from-bracket', 'Logout (' + esc(session.name) + ')', 'GHQ.logout()');
    menu.insertAdjacentHTML('beforeend', h);
  }

  function start() {
    var duty = $('duty-name'); if (duty) duty.textContent = session.name + (session.work ? ' (' + session.work + ')' : '');
    var ribbon = document.querySelectorAll('.status-ribbon span');
    var pill = $('ghq-pill');
    if (!pill) { var last = document.querySelector('.status-ribbon').lastElementChild; last.innerHTML = '<span id="ghq-pill" class="ghq-pill ok" onclick="GHQ.syncNow()"></span>'; }
    var m = document.querySelector('.sidebar-menu'); if (m) { m.querySelectorAll('[data-ghq]').forEach(function (n) { n.remove(); }); }
    ensureScreens(); injectMenus(); injectReportBox(); injectFeederBox();
    document.querySelectorAll('.btn-excel-gen[onclick*="exportTicketsToExcel"]').forEach(function (b) { b.style.display = canDownload() ? '' : 'none'; });
    rebuild(); updatePill(); injectPpmAdd();
    openModule('screen-dashboard');
    sync();
    if (timer) clearInterval(timer);
    timer = setInterval(sync, 60000);
  }

  window.addEventListener('online', function () { lastErr = ''; sync(); });
  window.addEventListener('offline', updatePill);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { sync(); checkUpdate(); } });


  /* ---------- PPM: equipment list (Google Sheet 'PPM') -> calendar, category lists, mark-done ---------- */
  var FREQ = { 'Weekly': { d: 7 }, 'Fortnightly': { d: 14 }, 'Monthly': { m: 1 }, 'Quarterly': { m: 3 }, 'Half-yearly': { m: 6 }, 'Yearly': { m: 12 } };
  var CATN = { elec: 'Electrical', hvac: 'HVAC', plumb: 'Plumbing' }, ppmMonth = null, ppmInit = false;
  function parseYmd(k) { var a = String(k).split('-'); return new Date(+a[0], +a[1] - 1, +a[2], 12); }
  function ymdOf(d) { return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
  function addPeriod(d, freq) {
    var f = FREQ[freq] || FREQ.Monthly, x = new Date(d.getTime());
    if (f.d) { x.setDate(x.getDate() + f.d); return x; }
    var day = x.getDate(); x.setDate(1); x.setMonth(x.getMonth() + f.m);
    x.setDate(Math.min(day, new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate())); return x;
  }
  function eqKey(e) { return (e.name + '|' + (e.loc || '')).toLowerCase(); }
  function ppmEval(e) {                              // DONE only after the last approval; until then "waiting". Source: checklist list (all devices) + server state + own unsynced entries
    var k = eqKey(e), dates = [], pend = [], lim = ymdOf(new Date(Date.now() - 3 * 864e5)), seen = {};
    if (e.cdone) dates.push(e.cdone);
    clItems.forEach(function (x) {
      if (((x.eq || '') + '|' + (x.loc || '')).toLowerCase() !== k) return;
      seen[x.id] = 1;
      if (x.status === 'Approved') dates.push(x.date); else if (x.status !== 'Rejected') pend.push({ d: x.date, s: x.status });
    });
    (ppmLog[k] || []).forEach(function (d) {
      var id = ppmLogId[k + '|' + d];
      if (!id) { dates.push(d); return; }                                  // simple "Mark done" (no checklist)
      if (seen[id]) return;
      if (d >= lim) pend.push({ d: d, s: 'Pending Supervisor' });          // just submitted, not synced yet
      else dates.push(d);                                                  // old entry outside the list = already approved
    });
    dates.sort(); var mx = dates.length ? dates[dates.length - 1] : '', wait = '', wd = '';
    pend.forEach(function (x) { if (x.d > mx && x.d >= wd) { wait = x.s; wd = x.d; } });
    if (!wait && e.cwait && (!mx || (e.cdone || '') >= mx)) wait = e.cwait;
    return { dates: dates, wait: wait };
  }
  function doneDates(e) { var a = ppmEval(e).dates.slice(); if (e.last) a.push(e.last); return a.sort(); }
  function lastDone(e) { var a = doneDates(e); return a.length ? a[a.length - 1] : ''; }
  function nextDue(e) { var l = lastDone(e); return l ? addPeriod(parseYmd(l), e.freq) : parseYmd(ymdOf(new Date())); }
  function monthTasks(y, mo) {                         // {day: [{i, e, kind:'due'|'done'}]}
    var from = new Date(y, mo, 1, 12), to = new Date(y, mo + 1, 0, 12), out = {};
    function put(day, i, e, kind) { (out[day] = out[day] || []).push({ i: i, e: e, kind: kind }); }
    ppmRows.forEach(function (e, i) {
      var seenD = {};
      doneDates(e).forEach(function (k) { var d = parseYmd(k); if (d >= from && d <= to && !seenD[k]) { seenD[k] = 1; put(d.getDate(), i, e, 'done'); } });
      var d = nextDue(e), g = 0;
      var wt = ppmEval(e).wait, tdy = parseYmd(ymdOf(new Date()));
      while (d <= to && g++ < 500) { if (d >= from) put(d.getDate(), i, e, wt && d <= tdy ? 'wait' : 'due'); d = addPeriod(d, e.freq); }
    });
    return out;
  }
  function fillScheduled(y, mo) {
    Object.keys(scheduledTasks).forEach(function (k) { delete scheduledTasks[k]; });
    ppmMonth = monthTasks(y, mo);
    Object.keys(ppmMonth).forEach(function (day) {
      var L = ppmMonth[day], due = L.filter(function (t) { return t.kind === 'due'; }).length, wtn = L.filter(function (t) { return t.kind === 'wait'; }).length, done = L.length - due - wtn;
      var has = function (c) { return L.some(function (t) { return t.e.cat === c; }); };
      scheduledTasks[day] = { count: due ? due + (due > 1 ? ' Tasks' : ' Task') + ' Due' + (done ? ' · ' + done + ' Done' : '') + (wtn ? ' · ' + wtn + ' Waiting' : '') : wtn ? wtn + ' Waiting' + (done ? ' · ' + done + ' Done' : '') : done + ' Done', elec: has('elec'), hvac: has('hvac'), plumb: has('plumb') };
    });
  }
  function ppmCard(i, e, kind, dueD) {
    var today = parseYmd(ymdOf(new Date())), st;
    if (kind === 'done') st = '<span style="font-size:.72rem;color:#34d399">✔ Done</span>';
    else {
      var diff = Math.round((dueD - today) / 864e5);
      st = diff < 0 ? '<span style="font-size:.72rem;color:#f87171">Overdue ' + (-diff) + ' day' + (diff === -1 ? '' : 's') + ' · ' + fmtDate(ymdOf(dueD), '') + '</span>'
        : '<span style="font-size:.72rem;color:var(--gold-light)">Due: ' + (diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : 'in ' + diff + ' days') + ' · ' + fmtDate(ymdOf(dueD), '') + '</span>';
    }
    var wt = kind !== 'done' && dueD <= today ? (ppmEval(e).wait || (kind === 'wait' ? 'Pending Supervisor' : '')) : '';
    if (wt) st = '<span style="font-size:.72rem;color:var(--gold-light)">⏳ Waiting for ' + esc(clWaiting(wt)) + ' approval</span>';
    return '<div class="op-item-card"><div class="op-item-top"><span class="tag-badge tag-pm">' + esc(e.freq) + ' PM</span>' + st + '</div>' +
      '<div class="op-item-title">' + esc(e.name) + (e.tag ? ' <span style="color:var(--cyan);font-size:.72rem">[' + esc(e.tag) + ']</span>' : '') + '</div><div class="op-item-desc">' + esc(e.loc || '') + '</div>' +
      '<div class="op-item-foot"><span><i class="fa-solid fa-user-gear"></i> ' + esc(e.team || '—') + '</span>' +
      (kind === 'done' || wt ? '' : (dueD - today) / 864e5 > 0.5 ? '<button class="btn-gold-solid" disabled style="opacity:.45">Opens on ' + esc(fmtDate(ymdOf(dueD), '')) + '</button>'
        : '<button class="btn-gold-solid" onclick="GHQ.ppmOpen(' + i + ')">' + (e.hasCl || (e.check && e.check.length) ? 'Open checklist' : 'Mark done') + '</button>') + '</div></div>';
  }
  function renderDayList() {
    var ban = $('cal-selected-banner'); if (!ban) return;
    var box = $('ppm-day-list');
    if (!box) { box = document.createElement('div'); box.id = 'ppm-day-list'; box.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:10px'; ban.insertAdjacentElement('afterend', box); }
    var L = (ppmMonth || {})[selectedCalDay] || [], y = +$('cal-year-select').value, mo = +$('cal-month-select').value;
    renderCatLists(); renderReports();
    if (!ppmRows.length) { box.innerHTML = '<div class="ghq-note">No equipment yet. ' + (canHold() ? 'Tap “Add equipment” above, or fill the PPM sheet in Google Sheets.' : 'Ask a Supervisor / Engineer to add equipment.') + '</div>'; return; }
    box.innerHTML = L.length ? L.map(function (t) { return ppmCard(t.i, t.e, t.kind, new Date(y, mo, selectedCalDay, 12)); }).join('') : '<div class="ghq-note">No PPM on this day.</div>';
  }
  function renderCatLists() {
    ['elec', 'hvac', 'plumb'].forEach(function (c) {
      var el = $('tab-ppm-' + c); if (!el) return;
      var y = +$('cal-year-select').value, mo = +$('cal-month-select').value, dd = new Date(y, mo, selectedCalDay, 12);
      var list = ((ppmMonth || {})[selectedCalDay] || []).filter(function (t) { return t.e.cat === c; });
      el.innerHTML = '<div class="section-title"><span>' + CATN[c] + ' PM Schedules · ' + esc(fmtDate(ymdOf(dd), '')) + '</span><span style="font-size:0.72rem; color:var(--cyan)">' + list.length + ' equipment</span></div>' +
        (list.length ? list.map(function (t) { return ppmCard(t.i, t.e, t.kind, dd); }).join('') : '<div class="ghq-note">No ' + CATN[c] + ' PPM on this date.</div>');
    });
  }
  function injectPpmAdd() {
    var old = $('ppm-add-box'); if (old) old.remove();
    var scr = $('screen-ppm'), hdr = scr && scr.querySelector('.op-screen-header');
    if (!hdr || !canHold()) return;
    var b = document.createElement('div'); b.id = 'ppm-add-box'; b.style.margin = '8px 0';
    b.innerHTML = '<button class="ghq-btn" onclick="GHQ.ppmAdd()"><i class="fa-solid fa-plus"></i> Add equipment</button>';
    hdr.insertAdjacentElement('afterend', b);
  }
  function renderPPM() {
    var ms = $('cal-month-select'), ys = $('cal-year-select'); if (!ms || !ys) return;
    if (!ppmInit) { var n = new Date(); ms.value = String(n.getMonth()); ys.value = String(n.getFullYear()); selectedCalDay = n.getDate(); ppmInit = true; }
    injectPpmAdd(); renderCalendar(); renderCatLists(); renderApprovals(); renderReports();
  }
  window.updateMonthlyTotals = function (month, year) {
    var mt = ppmMonth || monthTasks(year, month), c = { elec: [0, 0], hvac: [0, 0], plumb: [0, 0] }, tot = 0;
    Object.keys(mt).forEach(function (d) { mt[d].forEach(function (t) { if (t.kind === 'wait') { tot++; return; } c[t.e.cat][t.kind === 'done' ? 0 : 1]++; tot++; }); });
    function set(id, v) { var el = $(id); if (el) el.textContent = v; }
    set('total-monthly-ppm', tot + (tot === 1 ? ' Task' : ' Tasks'));
    Object.keys(c).forEach(function (k) { set('total-' + k + '-ppm', c[k][0] + c[k][1]); set('comp-' + k + '-ppm', c[k][0]); set('pend-' + k + '-ppm', c[k][1]); });
  };
  (function () {
    var rc = window.renderCalendar;
    window.renderCalendar = function () {
      var ms = $('cal-month-select'), ys = $('cal-year-select');
      if (ms && ys) fillScheduled(+ys.value, +ms.value);
      rc.apply(this, arguments);
      renderDayList();
    };
  })();

  function modal(html) {
    closeModal();
    var o = document.createElement('div'); o.id = 'ghq-ov'; o.className = 'ghq-ov';
    o.innerHTML = '<div class="ghq-ov-card">' + html + '</div>';
    o.addEventListener('click', function (ev) { if (ev.target === o) closeModal(); });
    document.body.appendChild(o);
  }
  function closeModal() { try { stopScan(); } catch (e) {} var o = $('ghq-ov'); if (o) o.remove(); }
  function ppmAdd() {
    if (!canHold()) { toast('Only Supervisor / Engineer / Admin can add equipment'); return; }
    modal('<h3 class="ghq-h3">Add equipment (PPM)</h3>' +
      '<label class="ghq-lbl">Category</label><select id="pe-cat" class="cal-select" style="width:100%"><option>Electrical</option><option>HVAC</option><option>Plumbing</option></select>' +
      '<label class="ghq-lbl">Equipment name *</label><input id="pe-name" class="ghq-input" placeholder="e.g. 11kV VCB Panel TR-01">' +
      '<label class="ghq-lbl">Equipment tag</label><input id="pe-tag" class="ghq-input" placeholder="e.g. VCB-01">' +
      '<label class="ghq-lbl">Location</label><input id="pe-loc" class="ghq-input" placeholder="e.g. Main Substation">' +
      '<div class="ghq-grid2"><div><label class="ghq-lbl">Frequency</label><select id="pe-freq" class="cal-select" style="width:100%"><option>Weekly</option><option>Fortnightly</option><option selected>Monthly</option><option>Quarterly</option><option>Half-yearly</option><option>Yearly</option></select></div>' +
      '<div><label class="ghq-lbl">Last done date</label><input id="pe-last" type="date" class="ghq-input" max="' + ymdOf(new Date()) + '"></div></div>' +
      '<label class="ghq-lbl">Team / Vendor</label><input id="pe-team" class="ghq-input" placeholder="e.g. Electrical team / ABC Services">' +
      '<label class="ghq-lbl">Checklist Google Sheet link</label><input id="pe-link" class="ghq-input" placeholder="https://docs.google.com/spreadsheets/d/…">' +
      '<label class="ghq-lbl">Or simple checklist — one point per line</label><textarea id="pe-check" class="ghq-input" rows="4" placeholder="Dust cleaning&#10;Terminal tightening"></textarea>' +
      '<div class="ghq-grid2"><button class="ghq-btn ghost" onclick="GHQ.closeModal()">Cancel</button><button class="ghq-btn" onclick="GHQ.ppmAddSubmit()">Save</button></div>');
  }
  function ppmAddSubmit() {
    var e = { cat: $('pe-cat').value, tag: $('pe-tag').value.trim(), link: $('pe-link').value.trim(), name: $('pe-name').value.trim(), loc: $('pe-loc').value.trim(), freq: $('pe-freq').value, last: $('pe-last').value, team: $('pe-team').value.trim(), check: $('pe-check').value.trim() };
    if (!e.name) { toast('Enter the equipment name'); return; }
    if (LOCAL) {
      ppmRows.push({ cat: { Electrical: 'elec', HVAC: 'hvac', Plumbing: 'plumb' }[e.cat], tag: e.tag, hasCl: false, name: e.name, loc: e.loc, freq: e.freq, last: e.last, team: e.team, check: e.check.split('\n').map(function (x) { return x.trim(); }).filter(Boolean) });
      LS.set('ghq_ppm', ppmRows); closeModal(); renderPPM(); toast('✔ Equipment added'); return;
    }
    api('ppm_add', { e: e }).then(function (r) { if (!r.ok) throw new Error(r.error === 'auth' ? 'Not allowed' : r.error); return pullPpm(); })
      .then(function () { closeModal(); renderPPM(); toast('✔ Equipment added'); })
      .catch(function (err) { toast(String(err && err.message) === 'Failed to fetch' ? 'Internet required' : 'Error: ' + (err && err.message)); });
  }
  function ppmSimple(i) {
    var e = ppmRows[i]; if (!e) return;
    var chk = (e.check || []).map(function (c, k) { return '<label style="display:flex;gap:8px;align-items:flex-start;font-size:.8rem;color:#e2e8f0;margin:4px 0"><input type="checkbox" style="margin-top:3px"> ' + esc(c) + '</label>'; }).join('');
    modal('<h3 class="ghq-h3">' + esc(e.name) + '</h3><div class="ghq-note">' + esc(e.loc || '') + ' · ' + esc(e.freq) + ' · ' + esc(e.team || '—') + '<br>Last done: ' + (lastDone(e) ? fmtDate(lastDone(e), '—') : '—') + ' · Next due: ' + fmtDate(ymdOf(nextDue(e)), '—') + '</div>' +
      (chk ? '<div class="sub-section-header" style="margin-top:8px">Checklist</div>' + chk : '<div class="ghq-note">No checklist added for this equipment.</div>') +
      '<label class="ghq-lbl" style="margin-top:8px">Done on</label><input id="pd-date" type="date" class="ghq-input" value="' + ymdOf(new Date()) + '" readonly>' +
      '<label class="ghq-lbl">Note (optional)</label><input id="pd-note" class="ghq-input" placeholder="Remarks">' +
      '<div class="ghq-grid2" style="margin-top:8px"><button class="ghq-btn ghost" onclick="GHQ.closeModal()">Close</button><button class="ghq-btn" onclick="GHQ.ppmDone(' + i + ')">Mark done</button></div>');
  }
  var clCtx = null;
  function clShow(i, r) {
    var e = ppmRows[i]; if (!e) return;
    if (!r.items || !r.items.length) { ppmSimple(i); return; }
    clCtx = { i: i, e: e, title: r.title || '', items: r.items, fields: r.fields || [], cols: r.cols || null, opts: (r.opts && r.opts.length >= 2) ? r.opts : ['OK', 'Not OK', 'NA'] }; clForm();
  }
  function ppmOpen(i) {
    var e = ppmRows[i]; if (!e) return;
    if (ppmEval(e).wait) { toast('Checklist submitted — waiting for approval'); return; }
    if (nextDue(e) - parseYmd(ymdOf(new Date())) > 36e5) { toast('This checklist opens on ' + fmtDate(ymdOf(nextDue(e)), '')); return; }
    var ck = 'ghq_cl_' + eqKey(e), local = (e.check || []).map(function (t) { return { t: t }; });
    function show(r) { clShow(i, r); }
    if (!e.hasCl || LOCAL) { show({ items: local }); return; }
    var cached = LS.get(ck, null);
    modal('<h3 class="ghq-h3">' + esc(e.name) + '</h3><div class="ghq-note">Loading checklist…</div>');
    if (!navigator.onLine) { if (cached) show(cached); else { toast('Open once with internet to load this checklist'); closeModal(); } return; }
    api('checklist_get', { eq: e.name, loc: e.loc || '' }).then(function (r) {
      if (!r.ok) throw new Error(r.error || 'error');
      if (r.items && r.items.length) { LS.set(ck, r); show(r); }
      else { toast('Checklist sheet is empty — using the simple list'); show({ items: local }); }
    }).catch(function (err) {
      if (cached) show(cached);
      else { toast('Could not load the checklist: ' + (err && err.message || err)); show({ items: local }); }
    });
  }
  function clForm() {
    var c = clCtx, e = c.e, n = 0;
    var h = '<h3 class="ghq-h3">' + esc(e.name) + (e.tag ? ' <span style="color:var(--cyan)">[' + esc(e.tag) + ']</span>' : '') + '</h3>' +
      '<div class="ghq-note">' + esc(e.loc || '') + (c.title ? ' · ' + esc(c.title) : '') + '<br>Last done: ' + (lastDone(e) ? fmtDate(lastDone(e), '—') : '—') + ' · Next due: ' + fmtDate(ymdOf(nextDue(e)), '—') + '</div>' +
      '<button class="ghq-btn ghost" onclick="GHQ.clAllOk()">Mark all points OK</button>';
    (c.fields || []).forEach(function (f, k) {
      if (clAuto(f.l, e) !== null) return;                  // tag / location / date are filled automatically
      h += '<label class="ghq-lbl">' + esc(f.l) + '</label>' + (f.opts ? '<select class="cal-select cl-f" data-k="' + k + '" style="width:100%"><option value="">— select —</option>' + f.opts.map(function (o) { return '<option>' + esc(o) + '</option>'; }).join('') + '</select>' : '<input class="ghq-input cl-f" data-k="' + k + '">');
    });
    c.items.forEach(function (x, k) {
      if (x.h) { h += '<div class="sub-section-header" style="margin-top:8px">' + esc(x.h) + '</div>'; return; }
      n++;
      h += '<div class="cl-item" data-k="' + k + '" style="border-bottom:1px dashed rgba(212,175,55,.2);padding:8px 0"><div style="font-size:.82rem;color:#e2e8f0;margin-bottom:6px">' + esc(x.sr || n) + '. ' + esc(x.t) + '</div>' +
        '<div style="display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap">' + c.opts.map(function (o) { return '<button type="button" class="cl-b" data-c="' + optKind(o) + '" data-s="' + esc(o) + '" onclick="GHQ.clSet(this)">' + esc(o) + '</button>'; }).join('') + '</div>' +
        '<div class="ghq-grid2"><input class="ghq-input cl-v" placeholder="Reading / value"><input class="ghq-input cl-r" placeholder="Remarks"></div></div>';
    });
    h += '<label class="ghq-lbl" style="margin-top:8px">Done on</label><input id="cl-date" type="date" class="ghq-input" value="' + ymdOf(new Date()) + '" readonly>' +
      '<label class="ghq-lbl">Overall remarks (optional)</label><input id="cl-note" class="ghq-input" placeholder="Remarks">' +
      '<div class="ghq-grid2" style="margin-top:8px"><button class="ghq-btn ghost" onclick="GHQ.closeModal()">Close</button><button class="ghq-btn" onclick="GHQ.clSubmit()">Submit &amp; create PDF</button></div>';
    modal(h);
  }
  function optKind(o) { return /not\s*ok|nok|fail|defect|abnormal/i.test(o) ? 'bad' : /^(n\/?a|not applicable)$/i.test(o) ? 'na' : 'ok'; }
  function clAuto(label, e) {                           // value for header labels we can fill ourselves, else null
    var l = String(label).toLowerCase();
    if (/tag/.test(l)) return e.tag || '';
    if (/location|area/.test(l)) return e.loc || '';
    if (/date|time/.test(l)) return '@date';
    if (/equipment|asset/.test(l)) return e.name || '';
    return null;
  }
  function clSet(btn) {
    var row = btn.parentNode; Array.prototype.forEach.call(row.children, function (b) { b.classList.remove('on'); });
    btn.classList.add('on'); row.parentNode.style.background = '';
  }
  function clAllOk() {
    document.querySelectorAll('.cl-item').forEach(function (it) { if (!it.querySelector('.cl-b.on')) { var okb = it.querySelector('.cl-b[data-c="ok"]'); if (okb) clSet(okb); } });
  }
  function clSubmit() {
    var c = clCtx; if (!c) return;
    var out = c.items.map(function (x) { return x.h ? { h: x.h } : null; }), missing = 0, firstMissing = null;
    document.querySelectorAll('.cl-item').forEach(function (it) {
      var k = +it.getAttribute('data-k'), on = it.querySelector('.cl-b.on');
      if (!on) { missing++; it.style.background = 'rgba(248,113,113,.12)'; if (!firstMissing) firstMissing = it; return; }
      out[k] = { t: c.items[k].t, sr: c.items[k].sr || '', s: on.getAttribute('data-s'), v: it.querySelector('.cl-v').value.trim(), r: it.querySelector('.cl-r').value.trim() };
    });
    if (missing) { toast('Select OK / Not OK / NA for ' + missing + ' more point' + (missing > 1 ? 's' : '')); if (firstMissing) firstMissing.scrollIntoView({ block: 'center' }); return; }
    var date = $('cl-date').value;
    if (!date) { toast('Select the date'); return; }
    if (date > ymdOf(new Date())) { toast('Date cannot be in the future'); return; }
    var nowT = new Date(), flds = (c.fields || []).map(function (f, k) {
      var a = clAuto(f.l, c.e), v;
      if (a === '@date') v = date + ' ' + p2(nowT.getHours()) + ':' + p2(nowT.getMinutes());
      else if (a !== null) v = a;
      else { var inp = document.querySelector('.cl-f[data-k="' + k + '"]'); v = inp ? inp.value.trim() : ''; }
      return { l: f.l, v: v };
    });
    var d = { key: eqKey(c.e), eq: c.e.name, tag: c.e.tag || '', loc: c.e.loc || '', title: c.title, cols: c.cols || null, fields: flds, date: date, note: $('cl-note').value.trim(), items: out };
    if (JSON.stringify(d).length > 40000) { toast('Checklist is too long to save'); return; }
    if (c.resub) {
      if (!navigator.onLine) { toast('Internet required to resubmit'); return; }
      toast('Please wait…');
      api('cl_resubmit', { id: c.resub, d: d }).then(function (r) {
        if (!r.ok) throw new Error(r.error || 'error');
        closeModal(); clCtx = null; toast('✔ Checklist resubmitted — sent to Supervisor for approval');
        return pullChecklists().then(pullPpm).then(function () { renderPPM(); });
      }).catch(function (e2) { toast('Error: ' + (e2 && e2.message || e2)); });
      return;
    }
    commit('ppm.checklist', d).then(function () { closeModal(); clCtx = null; toast('✔ Checklist submitted — sent to Supervisor for approval'); });
  }

  /* completed checklists (PDF) — Admin / Engineer / RIL / PM / APM */
  var ppmReports = LS.get('ghq_ppm_rep', []);
  function renderReports() {
    var box = $('ppm-reports'), scr = $('screen-ppm');
    if (!scr || !canDownload()) { if (box) box.remove(); return; }
    if (!box) { box = document.createElement('div'); box.id = 'ppm-reports'; box.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:14px'; scr.appendChild(box); }
    var selY = $('cal-year-select') ? +$('cal-year-select').value : 0, selM = $('cal-month-select') ? +$('cal-month-select').value : 0;
    var selK = selY ? selY + '-' + p2(selM + 1) + '-' + p2(selectedCalDay) : '';
    var rl = selK ? ppmReports.filter(function (r) { return String(r.date).slice(0, 10) === selK; }) : ppmReports;
    box.innerHTML = '<div class="section-title"><span>Approved checklists (PDF)' + (selK ? ' · ' + esc(fmtDate(selK, '')) : '') + '</span><span style="font-size:0.72rem; color:var(--cyan)">' + rl.length + '</span></div>' +
      (rl.length ? rl.map(function (r) {
        return '<div class="op-item-card"><div class="op-item-top"><span class="tag-badge tag-pm">PDF</span><span style="font-size:.72rem;color:var(--text-muted)">' + esc(fmtDate(r.date, r.date)) + '</span></div>' +
          '<div class="op-item-title">' + (r.no ? '<span style="color:var(--gold-light);font-size:.74rem">' + esc(r.no) + '</span><br>' : '') + esc(r.eq) + (r.tag ? ' <span style="color:var(--cyan);font-size:.72rem">[' + esc(r.tag) + ']</span>' : '') + '</div>' +
          '<div class="op-item-desc">By ' + esc(r.user) + ' · ' + (Number(r.bad) ? '<span style="color:#f87171">' + r.bad + ' NOT OK</span>' : 'All OK') + '</div>' +
          (r.id ? '<div class="op-item-foot"><a href="' + esc(r.url) + '" target="_blank" rel="noopener" style="color:var(--gold-light);font-size:.75rem">Open in Drive</a>' +
          '<button class="btn-gold-solid" onclick="GHQ.ppmPdf(\'' + esc(r.id) + '\')">Download PDF</button></div></div>' : '<div class="op-item-desc" style="color:#f87171">PDF not ready' + (r.err ? ': ' + esc(r.err) : '') + ' — will retry on next refresh</div></div>');
      }).join('') : '<div class="ghq-note">No approved checklist PDF for this date.</div>');
  }
  function ppmPdf(id) {
    if (!canDownload()) { toast('Download is for Admin / Engineer / RIL / PM / APM'); return; }
    toast('Preparing PDF…');
    api('ppm_pdf_file', { id: id }).then(function (r) {
      if (!r.ok) throw new Error(r.error || 'error');
      var bin = atob(r.b64), bytes = new Uint8Array(bin.length); for (var k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      return saveBytes(r.name || 'PPM_checklist.pdf', 'application/pdf', bytes);
    }).catch(function (e) { toast(String(e && e.message) === 'Failed to fetch' ? 'Internet required' : 'Could not download: ' + (e && e.message || e)); });
  }
  function pullReports() {
    if (LOCAL || !canDownload()) return Promise.resolve();
    return api('ppm_reports').then(function (r) {
      if (!r || !r.ok || !Array.isArray(r.reports)) return;
      ppmReports = r.reports; LS.set('ghq_ppm_rep', ppmReports);
      var sc = $('screen-ppm'); if (sc && sc.classList.contains('active')) renderReports();
    }).catch(function () {});
  }

  /* ---------- checklist approvals: Technician -> Supervisor -> Engineer -> PM / APM -> PDF ---------- */
  function clWaiting(st) { return st === 'Pending Supervisor' ? 'Supervisor' : st === 'Pending Engineer' ? 'Engineer' : st === 'Pending PM/APM' ? 'PM / APM' : ''; }
  function clTrail(r) {
    return [['Supervisor', r.sup], ['Engineer', r.eng], ['PM / APM', r.pm]].map(function (x) { return x[1] ? '<span style="color:#34d399">✔ ' + x[0] + ': ' + esc(x[1]) + '</span>' : ''; }).filter(Boolean).join(' · ');
  }
  function renderApprovals() {
    var box = $('ppm-approvals'), scr = $('screen-ppm'); if (!scr) return;
    if (!box) { box = document.createElement('div'); box.id = 'ppm-approvals'; box.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:14px'; scr.appendChild(box); }
    var me = session && session.name;
    var list = clItems.filter(function (r) { return r.status !== 'Approved' && (r.status !== 'Rejected' || r.by === me); });
    box.innerHTML = '<div class="section-title"><span>Checklist approvals</span><span style="font-size:0.72rem; color:var(--cyan)">' + list.filter(function (r) { return r.can; }).length + ' for you</span></div>' +
      (list.length ? list.map(function (r) {
        var rej = r.status === 'Rejected';
        return '<div class="op-item-card"><div class="op-item-top"><span class="tag-badge tag-pm">' + esc(r.no || 'Checklist') + '</span>' +
          (rej ? '<span style="font-size:.72rem;color:#f87171">✖ Rejected</span>' : '<span style="font-size:.72rem;color:var(--gold-light)">⏳ Waiting for ' + esc(clWaiting(r.status)) + '</span>') + '</div>' +
          '<div class="op-item-title">' + esc(r.eq) + (r.tag ? ' <span style="color:var(--cyan);font-size:.72rem">[' + esc(r.tag) + ']</span>' : '') + '</div>' +
          '<div class="op-item-desc">' + esc(fmtDate(r.date, r.date)) + ' · By ' + esc(r.by) + ' · ' + (Number(r.bad) ? '<span style="color:#f87171">' + r.bad + ' NOT OK</span>' : 'All OK') + '</div>' +
          (clTrail(r) ? '<div class="op-item-desc" style="font-size:.7rem">' + clTrail(r) + '</div>' : '') +
          (rej && r.rem ? '<div class="op-item-desc" style="color:#f87171;font-size:.72rem">' + esc(r.rem) + '</div>' : '') +
          '<div class="op-item-foot"><span></span>' + (rej && r.by === me ? '<button class="btn-gold-solid" onclick="GHQ.clEdit(\'' + esc(r.id) + '\')">Edit &amp; resubmit</button>' : '<button class="btn-gold-solid" onclick="GHQ.clView(\'' + esc(r.id) + '\')">' + (r.can ? 'Review &amp; approve' : 'View') + '</button>') + '</div></div>';
      }).join('') : '<div class="ghq-note">No checklist is waiting for approval.</div>');
  }
  function clEdit(id) {                                // technician fixes a rejected checklist and sends it again
    if (!navigator.onLine) { toast('Internet required'); return; }
    modal('<div class="ghq-note">Loading…</div>');
    api('cl_get', { id: id }).then(function (r) {
      if (!r.ok) throw new Error(r.error || 'error');
      var d = r.d || {}, e = ppmRows.filter(function (x) { return eqKey(x) === d.key; })[0] || { name: d.eq, tag: d.tag, loc: d.loc, freq: 'Monthly' };
      var cached = LS.get('ghq_cl_' + (d.key || ''), null), opts = cached && cached.opts && cached.opts.length >= 2 ? cached.opts : ['OK', 'Not OK', 'NA'];
      (d.items || []).forEach(function (x) { if (!x.h && opts.indexOf(x.s) < 0) opts.push(x.s); });
      clCtx = { i: -1, e: e, title: d.title || '', items: d.items || [], fields: d.fields ? d.fields.map(function (f) { return { l: f.l }; }) : [], cols: d.cols || null, opts: opts, resub: id };
      clForm();
      var rm = document.querySelector('#ghq-ov .ghq-note'); if (rm) rm.innerHTML += '<br><b style="color:#f87171">Editing rejected checklist ' + esc(r.no || '') + '</b>' + (r.rem ? '<br><span style="color:#f87171">' + esc(r.rem) + '</span>' : '');
      document.querySelectorAll('.cl-item').forEach(function (it) {
        var x = clCtx.items[+it.getAttribute('data-k')]; if (!x) return;
        var b = Array.prototype.filter.call(it.querySelectorAll('.cl-b'), function (q) { return q.getAttribute('data-s') === x.s; })[0]; if (b) clSet(b);
        it.querySelector('.cl-v').value = x.v || ''; it.querySelector('.cl-r').value = x.r || '';
      });
      (d.fields || []).forEach(function (f, k) { var inp = document.querySelector('.cl-f[data-k="' + k + '"]'); if (inp) inp.value = f.v || ''; });
      if ($('cl-note')) $('cl-note').value = d.note || '';
      if ($('cl-date') && d.date) $('cl-date').value = d.date;
      var sb = document.querySelector('#ghq-ov button[onclick="GHQ.clSubmit()"]'); if (sb) sb.textContent = 'Resubmit for approval';
    }).catch(function (e) { closeModal(); toast('Could not open: ' + (e && e.message || e)); });
  }
  function clView(id) {
    if (!navigator.onLine) { toast('Internet required'); return; }
    modal('<div class="ghq-note">Loading…</div>');
    api('cl_get', { id: id }).then(function (r) {
      if (!r.ok) throw new Error(r.error || 'error');
      var d = r.d || {}, n = 0, h = '<h3 class="ghq-h3">' + esc(r.no) + '</h3><div class="ghq-note"><b>' + esc(d.eq || '') + '</b>' + (d.tag ? ' [' + esc(d.tag) + ']' : '') + '<br>' + esc(d.loc || '') + ' · ' + esc(fmtDate(d.date, d.date)) + '<br>Submitted by ' + esc(r.by) + '<br>Status: <b>' + esc(r.status) + '</b>' +
        (clTrail({ sup: r.sup, eng: r.eng, pm: r.pm }) ? '<br>' + clTrail({ sup: r.sup, eng: r.eng, pm: r.pm }) : '') + (r.rem ? '<br><span style="color:#f87171">' + esc(r.rem) + '</span>' : '') + '</div>';
      (d.items || []).forEach(function (x) {
        if (x.h) { h += '<div class="sub-section-header" style="margin-top:8px">' + esc(x.h) + '</div>'; return; }
        n++; var bad = optKind(x.s) === 'bad';
        h += '<div style="border-bottom:1px dashed rgba(212,175,55,.2);padding:6px 0;font-size:.8rem;color:#e2e8f0"><div>' + esc(x.sr || n) + '. ' + esc(x.t) + '</div><div style="color:' + (bad ? '#f87171' : '#34d399') + ';font-weight:700">' + esc(x.s) + (x.v ? ' · ' + esc(x.v) : '') + '</div>' + (x.r ? '<div style="color:var(--text-muted)">' + esc(x.r) + '</div>' : '') + '</div>';
      });
      if (d.note) h += '<div class="ghq-note" style="margin-top:6px">Remarks: ' + esc(d.note) + '</div>';
      if (r.can) h += '<label class="ghq-lbl" style="margin-top:8px">Reason (needed only to reject)</label><input id="cv-note" class="ghq-input" placeholder="Reason">' +
        '<div class="ghq-grid2" style="margin-top:8px"><button class="ghq-btn ghost" onclick="GHQ.clAct(\'' + esc(id) + '\',\'reject\')">Reject</button><button class="ghq-btn" onclick="GHQ.clAct(\'' + esc(id) + '\',\'approve\')">Approve</button></div><button class="ghq-btn ghost" style="margin-top:6px" onclick="GHQ.closeModal()">Close</button>';
      else h += '<button class="ghq-btn ghost" style="margin-top:8px" onclick="GHQ.closeModal()">Close</button>';
      modal(h);
    }).catch(function (e) { closeModal(); toast('Could not open: ' + (e && e.message || e)); });
  }
  function clAct(id, act) {
    var note = ($('cv-note') || {}).value || '';
    if (act === 'reject' && !note.trim()) { toast('Enter the reason to reject'); return; }
    toast('Please wait…');
    api('cl_act', { id: id, act: act, note: note.trim() }).then(function (r) {
      if (!r.ok) throw new Error(r.error || 'error');
      closeModal();
      toast(r.status === 'Approved' ? '✔ Approved — final PDF created' : r.status === 'Rejected' ? 'Checklist rejected' : '✔ Approved — sent to ' + clWaiting(r.status));
      return pullChecklists().then(pullPpm).then(pullReports).then(function () { renderPPM(); });
    }).catch(function (e) { toast(String(e && e.message) === 'Failed to fetch' ? 'Internet required' : 'Error: ' + (e && e.message || e)); });
  }
  function updateBell() {
    var b = document.querySelector('.action-btn .fa-bell'); b = b && b.parentNode; if (!b) return;
    var c = clItems.filter(function (r) { return r.can; }).length + dgItems.filter(function (r) { return r.can; }).length + repItems.filter(function (r) { return r.can; }).length, bd = b.querySelector('.ghq-badge');
    if (!b._ghq) { b._ghq = 1; b.style.position = 'relative'; b.setAttribute('onclick', ''); b.onclick = function () { if (!clItems.some(function (r) { return r.can; }) && dgItems.some(function (r) { return r.can; })) { openModule('screen-dg'); return; } if (!clItems.some(function (r) { return r.can; }) && repItems.some(function (r) { return r.can; })) { openModule('screen-reports'); return; } openModule('screen-ppm'); setTimeout(function () { var a = $('ppm-approvals'); if (a) a.scrollIntoView({ behavior: 'smooth' }); }, 150); }; }
    if (!bd) { bd = document.createElement('span'); bd.className = 'ghq-badge'; b.appendChild(bd); }
    bd.textContent = c > 9 ? '9+' : c; bd.style.display = c ? 'flex' : 'none';
  }
  function pullChecklists() {
    if (LOCAL || !session) return Promise.resolve();
    return api('cl_list').then(function (r) {
      if (!r || !r.ok || !Array.isArray(r.list)) return;
      clItems = r.list; LS.set('ghq_cl_items', clItems);
      clRej = {}; clItems.forEach(function (x) { if (x.status === 'Rejected') clRej[(x.eq + '|' + (x.loc || '')).toLowerCase() + '|' + x.date] = 1; });
      var seenN = LS.get('ghq_cl_seen', null), first = !seenN, todo = 0, msgs = [];
      seenN = seenN || {};
      clItems.forEach(function (x) {
        if (x.can && seenN['a' + x.id] !== x.status) { todo++; seenN['a' + x.id] = x.status; }
        if (session && x.by === session.name) {
          var prev = seenN['m' + x.id];
          if (prev !== x.status && (x.status === 'Approved' || x.status === 'Rejected') && !(first && !prev)) msgs.push(x.no + ' ' + x.status.toLowerCase());
          seenN['m' + x.id] = x.status;
        }
      });
      LS.set('ghq_cl_seen', seenN);
      if (todo) toast('🔔 ' + todo + ' checklist' + (todo > 1 ? 's' : '') + ' waiting for your approval');
      else if (msgs.length) toast('🔔 ' + msgs.join(', '));
      updateBell(); rebuildPpmViews();
    }).catch(function () {});
  }
  function rebuildPpmViews() { var sc = $('screen-ppm'); if (sc && sc.classList.contains('active')) { try { renderPPM(); } catch (e) {} } }

  /* ---------- DG & Fuel: monthly DG load trial checklist (Engineer/Admin/PM/APM start -> Supervisor fills -> Engineer -> PM/APM -> PDF) ---------- */
  var DGT = LS.get('ghq_dg_t', null), dgCtx = null;
  function dgWait(st) { return st === 'Awaiting readings' ? 'Supervisor (readings)' : st === 'Pending Engineer' ? 'Engineer' : st === 'Pending PM/APM' ? 'PM / APM' : ''; }
  function dgNum(x) { var v = parseFloat(String(x == null ? '' : x).replace(',', '.')); return isNaN(v) ? null : v; }
  function dgR(v, n) { return v == null || !isFinite(v) ? '' : Number(v.toFixed(n)); }
  function dgCalc(d) {                                     // same formulas as the Excel sheet
    var V = function (k) { var x = (d.vals || {})[k]; return x ? dgNum(x.v) : null; };
    function avg(a) { var t = a.filter(function (x) { return x != null; }); return t.length ? t.reduce(function (p, c) { return p + c; }, 0) / t.length : null; }
    var dur = null, m1 = /^(\d{1,2}):(\d\d)/.exec(d.start || ''), m2 = /^(\d{1,2}):(\d\d)/.exec(d.stop || '');
    if (m1 && m2) { dur = (+m2[1] * 60 + +m2[2]) - (+m1[1] * 60 + +m1[2]); if (dur < 0) dur += 1440; }
    var mf = dgNum(d.mf); if (mf == null) mf = 10;
    var units = (V(10) != null && V(9) != null) ? (V(10) - V(9)) * mf : null, dsl = (V(15) != null && V(16) != null) ? V(15) - V(16) : null;
    return { dur: dur == null ? '' : dur, avgV: dgR(avg([V(1), V(2), V(3)]), 1), avgI: dgR(avg([V(4), V(5), V(6)]), 1), units: dgR(units, 2), diesel: dgR(dsl, 2), upl: (units != null && dsl) ? dgR(units / dsl, 2) : '', ekw: (V(7) != null && dur != null) ? dgR(V(7) * dur / 60, 2) : '' };
  }
  function calcBlock(d) {
    var c = dgCalc(d);
    function row(l, u, v) { return '<div style="display:flex;justify-content:space-between;font-size:.8rem;padding:3px 0;color:#e2e8f0"><span>' + l + '</span><b style="color:var(--gold-light)">' + (v === '' ? '—' : esc(v)) + ' <small style="color:var(--text-muted)">' + u + '</small></b></div>'; }
    return '<div class="sub-section-header" style="margin-top:8px">Calculations (auto)</div>' + row('Trial duration', 'min', c.dur) + row('Average voltage', 'V', c.avgV) + row('Average current', 'A', c.avgI) +
      row('Total units generated', 'kWh', c.units) + row('Diesel consumed', 'ltr', c.diesel) + row('Units per litre', 'kWh/ltr', c.upl) + row('Energy check: kW × hours', 'kWh', c.ekw);
  }
  function renderDG() {
    var el = $('tab-dg-trial'); if (!el) return;
    var me = session && session.name, open = dgItems.filter(function (r) { return r.status !== 'Approved'; }), done = dgItems.filter(function (r) { return r.status === 'Approved'; });
    var h = '<div class="section-title"><span>DG Load Trial — monthly checklist</span><span style="font-size:0.72rem; color:var(--gold-primary)">' + open.filter(function (r) { return r.can; }).length + ' for you</span></div>';
    if (dgCanStart) h += '<button class="ghq-btn" style="margin:6px 0" onclick="GHQ.dgStart()"><i class="fa-solid fa-play"></i> Start load trial</button>';
    h += '<div class="sub-section-header" style="margin-top:8px">In progress</div>';
    h += open.length ? open.map(function (r) {
      return '<div class="op-item-card"><div class="op-item-top"><span class="tag-badge tag-trial">' + esc(r.no) + '</span><span style="font-size:.72rem;color:var(--gold-light)">⏳ Waiting for ' + esc(dgWait(r.status)) + '</span></div>' +
        '<div class="op-item-title">' + esc(r.dg) + ' — Load trial</div><div class="op-item-desc">' + esc(fmtDate(r.date, r.date)) + ' · ' + esc(r.start) + ' · Started by ' + esc(r.by) + '</div>' +
        (r.fby ? '<div class="op-item-desc" style="font-size:.7rem;color:#34d399">✔ Supervisor: ' + esc(r.fby) + (r.eng ? ' · Engineer: ' + esc(r.eng) : '') + '</div>' : '') +
        (r.rem ? '<div class="op-item-desc" style="color:#f87171;font-size:.72rem">' + esc(r.rem) + '</div>' : '') +
        '<div class="op-item-foot"><span></span><button class="btn-gold-solid" onclick="GHQ.dgOpen(\'' + esc(r.no) + '\')">' + (r.can ? (r.status === 'Awaiting readings' ? 'Fill checklist' : 'Review &amp; approve') : 'View') + '</button></div></div>';
    }).join('') : '<div class="ghq-note">No load trial in progress.' + (dgCanStart ? '' : ' Engineer / Admin / PM / APM start a trial.') + '</div>';
    h += '<div class="sub-section-header" style="margin-top:14px">Completed (month wise)</div>';
    if (!done.length) h += '<div class="ghq-note">Approved checklists appear here.</div>';
    var MN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'], groups = {}, order = [];
    done.forEach(function (r) { var k = String(r.date).slice(0, 7); if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(r); });
    order.sort().reverse().forEach(function (k) {
      h += '<div class="section-title" style="margin-top:8px"><span>' + MN[+k.slice(5, 7) - 1] + ' ' + k.slice(0, 4) + '</span><span style="font-size:.72rem;color:var(--cyan)">' + groups[k].length + '</span></div>';
      h += groups[k].map(function (r) {
        return '<div class="op-item-card"><div class="op-item-top"><span class="tag-badge tag-trial">' + esc(r.no) + '</span><span style="font-size:.72rem;color:#34d399">✔ Approved</span></div>' +
          '<div class="op-item-title">' + esc(r.dg) + '</div><div class="op-item-desc">' + esc(fmtDate(r.date, r.date)) + ' · ' + esc(r.start) + ' · Supervisor ' + esc(r.fby) + ' · Eng ' + esc(r.eng) + ' · PM/APM ' + esc(r.pm) + '</div>' +
          '<div class="op-item-foot"><button class="btn-gold-outline" onclick="GHQ.dgOpen(\'' + esc(r.no) + '\')">View</button>' + (r.pdf ? '<button class="btn-gold-solid" onclick="GHQ.ppmPdf(\'' + esc(r.pdf) + '\')">Download PDF</button>' : '<span></span>') + '</div></div>';
      }).join('');
    });
    el.innerHTML = h;
  }
  function dgStart() {
    var n = new Date();
    modal('<h3 class="ghq-h3">Start DG load trial</h3><div class="ghq-note">A separate checklist opens for each DG. The Supervisor will fill it.</div>' +
      '<div class="ghq-grid2"><div><label class="ghq-lbl">Trial date</label><input id="dg-date" type="date" class="ghq-input" value="' + ymdOf(n) + '"></div><div><label class="ghq-lbl">Start time</label><input id="dg-time" type="time" class="ghq-input" value="' + p2(n.getHours()) + ':' + p2(n.getMinutes()) + '"></div></div>' +
      '<div class="ghq-grid2"><div><label class="ghq-lbl">DG No. 1</label><input id="dg-1" class="ghq-input" value="DG-01"></div><div><label class="ghq-lbl">DG No. 2 (optional)</label><input id="dg-2" class="ghq-input" value="DG-02"></div></div>' +
      '<div class="ghq-grid2" style="margin-top:8px"><button class="ghq-btn ghost" onclick="GHQ.closeModal()">Cancel</button><button class="ghq-btn" onclick="GHQ.dgStartSubmit()">Open checklists</button></div>');
  }
  function dgStartSubmit() {
    var dgs = [$('dg-1').value, $('dg-2').value].map(function (x) { return x.trim(); }).filter(Boolean);
    if (!dgs.length) { toast('Enter the DG number'); return; }
    if (!navigator.onLine) { toast('Internet required'); return; }
    api('dg_start', { date: $('dg-date').value, start: $('dg-time').value, dgs: dgs }).then(function (r) {
      if (!r.ok) throw new Error(r.error || 'error');
      closeModal(); toast('✔ ' + r.nos.join(', ') + ' opened for the Supervisor'); return pullDg();
    }).catch(function (e) { toast(String(e && e.message) === 'Failed to fetch' ? 'Internet required' : 'Error: ' + (e && e.message || e)); });
  }
  function dgOpen(no) {
    if (!navigator.onLine) { toast('Internet required'); return; }
    modal('<div class="ghq-note">Loading…</div>');
    api('dg_get', { no: no }).then(function (r) {
      if (!r.ok) throw new Error(r.error || 'error');
      DGT = r.t; LS.set('ghq_dg_t', DGT);
      var d = r.d || {}, draft = LS.get('ghq_dg_draft_' + no, null);
      if (r.status === 'Awaiting readings' && r.can && draft) d = draft;
      dgCtx = { no: no, r: r, d: d, edit: r.status === 'Awaiting readings' && r.can };
      dgForm();
    }).catch(function (e) { closeModal(); toast('Could not open: ' + (e && e.message || e)); });
  }
  function dgForm() {
    var c = dgCtx, r = c.r, d = c.d, t = DGT, ed = c.edit; d.vals = d.vals || {};
    var h = '<h3 class="ghq-h3">' + esc(r.no) + '</h3><div class="ghq-note"><b>' + esc(t.title) + '</b><br>Status: <b>' + esc(r.status) + '</b>' + (r.fby ? '<br>✔ Supervisor: ' + esc(r.fby) : '') + (r.eng ? ' · ✔ Engineer: ' + esc(r.eng) : '') + (r.pm ? ' · ✔ PM/APM: ' + esc(r.pm) : '') + (r.rem ? '<br><span style="color:#f87171">' + esc(r.rem) + '</span>' : '') + '</div>' +
      '<div class="ghq-grid2"><div><label class="ghq-lbl">Date</label><input class="ghq-input" value="' + esc(d.date) + '" readonly></div><div><label class="ghq-lbl">DG No.</label><input class="ghq-input" value="' + esc(d.dg) + '" readonly></div></div>' +
      '<label class="ghq-lbl">Location</label><input class="ghq-input" value="' + esc(d.loc || t.loc) + '" readonly>' +
      '<div class="ghq-grid2"><div><label class="ghq-lbl">Start time</label><input id="dgf-start" type="time" class="ghq-input dg-in" value="' + esc(d.start || '') + '"' + (ed ? '' : ' readonly') + '></div><div><label class="ghq-lbl">Stop time</label><input id="dgf-stop" type="time" class="ghq-input dg-in" value="' + esc(d.stop || '') + '"' + (ed ? '' : ' readonly') + '></div></div>';
    t.sections.forEach(function (sec) {
      h += '<div class="sub-section-header" style="margin-top:8px">' + esc(sec.h) + '</div>';
      sec.items.forEach(function (it) {
        var x = d.vals[it.sr] || {};
        h += '<div class="dg-item" data-sr="' + it.sr + '" style="border-bottom:1px dashed rgba(212,175,55,.2);padding:8px 0"><div style="font-size:.82rem;color:#e2e8f0">' + it.sr + '. ' + esc(it.p) + (it.u ? ' <small style="color:var(--text-muted)">(' + esc(it.u) + ')</small>' : '') + '</div>' +
          (it.ref ? '<div style="font-size:.68rem;color:var(--text-muted);margin-bottom:4px">Reference: ' + esc(it.ref) + '</div>' : '') +
          '<input class="ghq-input dg-v dg-in" inputmode="decimal" placeholder="Reading" value="' + esc(x.v || '') + '"' + (ed ? '' : ' readonly') + '>' +
          '<div style="display:flex;gap:6px;margin:6px 0">' + ['OK', 'NOT OK', 'N/A'].map(function (o) { return '<button type="button" class="cl-b' + (x.s === o ? ' on' : '') + '" data-c="' + (o === 'NOT OK' ? 'bad' : o === 'N/A' ? 'na' : 'ok') + '" data-s="' + o + '"' + (ed ? ' onclick="GHQ.dgSet(this)"' : ' disabled') + '>' + o + '</button>'; }).join('') + '</div>' +
          '<input class="ghq-input dg-r dg-in" placeholder="Remarks" value="' + esc(x.r || '') + '"' + (ed ? '' : ' readonly') + '></div>';
      });
    });
    h += '<label class="ghq-lbl" style="margin-top:8px">Meter multiplying factor (MF)</label><input id="dgf-mf" class="ghq-input dg-in" inputmode="decimal" value="' + esc(d.mf == null ? t.mf : d.mf) + '"' + (ed ? '' : ' readonly') + '>' +
      '<div id="dg-calc">' + calcBlock(d) + '</div>' +
      '<label class="ghq-lbl" style="margin-top:8px">Overall remarks (optional)</label><input id="dgf-note" class="ghq-input dg-in" value="' + esc(d.note || '') + '"' + (ed ? '' : ' readonly') + '>';
    if (ed) h += '<div class="ghq-grid2" style="margin-top:8px"><button class="ghq-btn ghost" onclick="GHQ.closeModal()">Close (draft saved)</button><button class="ghq-btn" onclick="GHQ.dgSubmit()">Submit for approval</button></div>';
    else if (r.can) h += '<label class="ghq-lbl" style="margin-top:8px">Reason (needed only to send back)</label><input id="cv-note" class="ghq-input" placeholder="Reason">' +
      '<div class="ghq-grid2" style="margin-top:8px"><button class="ghq-btn ghost" onclick="GHQ.dgAct(\'reject\')">Send back</button><button class="ghq-btn" onclick="GHQ.dgAct(\'approve\')">Approve</button></div><button class="ghq-btn ghost" style="margin-top:6px" onclick="GHQ.closeModal()">Close</button>';
    else h += '<button class="ghq-btn ghost" style="margin-top:8px" onclick="GHQ.closeModal()">Close</button>';
    modal(h);
    if (ed) document.querySelectorAll('.ghq-ov-card .dg-in').forEach(function (i) { i.addEventListener('input', dgLive); });
  }
  function dgRead() {                                      // current form -> data object
    var d = JSON.parse(JSON.stringify(dgCtx.d)); d.vals = {};
    d.start = $('dgf-start').value; d.stop = $('dgf-stop').value; d.mf = $('dgf-mf').value; d.note = $('dgf-note').value.trim();
    document.querySelectorAll('.dg-item').forEach(function (it) {
      var on = it.querySelector('.cl-b.on');
      d.vals[it.getAttribute('data-sr')] = { v: it.querySelector('.dg-v').value.trim(), s: on ? on.getAttribute('data-s') : '', r: it.querySelector('.dg-r').value.trim() };
    });
    return d;
  }
  function dgLive() {
    if (!dgCtx || !dgCtx.edit) return;
    var d = dgRead(); LS.set('ghq_dg_draft_' + dgCtx.no, d);
    var b = $('dg-calc'); if (b) b.innerHTML = calcBlock(d);
  }
  function dgSet(btn) { var row = btn.parentNode; Array.prototype.forEach.call(row.children, function (b) { b.classList.remove('on'); }); btn.classList.add('on'); row.parentNode.style.background = ''; dgLive(); }
  function dgSubmit() {
    var d = dgRead(), bad = 0, first = null;
    if (!d.start || !d.stop) { toast('Enter the start and stop time'); return; }
    document.querySelectorAll('.dg-item').forEach(function (it) {
      var x = d.vals[it.getAttribute('data-sr')], miss = !x.s || (x.s !== 'N/A' && x.v === '');
      it.style.background = miss ? 'rgba(248,113,113,.12)' : ''; if (miss) { bad++; if (!first) first = it; }
    });
    if (bad) { toast('Fill reading and OK / NOT OK for ' + bad + ' more point' + (bad > 1 ? 's' : '')); if (first) first.scrollIntoView({ block: 'center' }); return; }
    if (!navigator.onLine) { toast('Internet required to submit — draft is saved'); return; }
    api('dg_submit', { no: dgCtx.no, d: d }).then(function (r) {
      if (!r.ok) throw new Error(r.error || 'error');
      LS.set('ghq_dg_draft_' + dgCtx.no, null); closeModal(); dgCtx = null; toast('✔ Submitted — sent to Engineer for approval'); return pullDg();
    }).catch(function (e) { toast(String(e && e.message) === 'Failed to fetch' ? 'Internet required — draft is saved' : 'Error: ' + (e && e.message || e)); });
  }
  function dgAct(act) {
    var note = ($('cv-note') || {}).value || '';
    if (act === 'reject' && !note.trim()) { toast('Enter the reason to send back'); return; }
    toast('Please wait…');
    api('dg_act', { no: dgCtx.no, act: act, note: note.trim() }).then(function (r) {
      if (!r.ok) throw new Error(r.error || 'error');
      closeModal(); dgCtx = null;
      toast(r.status === 'Approved' ? '✔ Approved — final PDF created' : act === 'reject' ? 'Sent back to the Supervisor' : '✔ Approved — sent to PM / APM');
      return pullDg();
    }).catch(function (e) { toast(String(e && e.message) === 'Failed to fetch' ? 'Internet required' : 'Error: ' + (e && e.message || e)); });
  }
  function pullDg() {
    if (LOCAL || !session) return Promise.resolve();
    return api('dg_list').then(function (r) {
      if (!r || !r.ok || !Array.isArray(r.list)) return;
      dgItems = r.list; dgCanStart = !!r.canStart; LS.set('ghq_dg_items', dgItems);
      var seenN = LS.get('ghq_dg_seen', {}), todo = 0;
      dgItems.forEach(function (x) { if (x.can && seenN[x.no] !== x.status) { todo++; seenN[x.no] = x.status; } });
      LS.set('ghq_dg_seen', seenN);
      if (todo) toast('🔔 ' + todo + ' DG load trial checklist' + (todo > 1 ? 's' : '') + ' need your action');
      updateBell();
      var sc = $('screen-dg'); if (sc && sc.classList.contains('active')) renderDG();
    }).catch(function () {});
  }

  /* ---------- O&M Reports: DSR / WSR / MMR (auto draft -> Engineer checks & edits -> PM/APM approves -> PDF + Excel) ---------- */
  var repItems = LS.get('ghq_rep_items', []), repInfo = LS.get('ghq_rep_info', { canGen: false, canDl: false, tpl: {} }), repCtx = null, repExtra = {};
  var P6 = ['GHQ', 'NMAEYC', 'HELIPAD', 'Facade Light & Logo', 'MMR Room', 'EV Charging'], PC = ['B', 'C', 'D', 'E', 'F', 'G'];
  var EQ_OPTS = P6.concat(['Transformer', 'LT Panel', 'APFC Panel', 'UPS', 'HVAC', 'Lift', 'Fire Fighting', 'Other']);
  var REPN = { DSR: 'Daily Status Report', WSR: 'Weekly Status Report', MMR: 'Monthly Maintenance Report' };
  function canRepDl() { return !!session && !(session.role === 'staff' && !isSupervisor()); }
  function repWait(st) { return st === 'Pending Engineer' ? 'Engineer' : st === 'Pending PM/APM' ? 'PM / APM' : ''; }
  function renderRep() {
    ['DSR', 'WSR', 'MMR'].forEach(function (t) {
      var el = $('tab-rep-' + t.toLowerCase()); if (!el) return;
      var list = repItems.filter(function (r) { return r.type === t; }), now = new Date(), h = '';
      h += '<div class="section-title"><span>' + REPN[t] + '</span><span style="font-size:.72rem;color:var(--cyan)">' + list.filter(function (r) { return r.can; }).length + ' for you</span></div>';
      if (repInfo.canGen) {
        var inp = t === 'MMR' ? '<input id="rg-' + t + '" type="month" class="ghq-input" value="' + now.getFullYear() + '-' + p2(now.getMonth() + 1) + '">' : '<input id="rg-' + t + '" type="date" class="ghq-input" value="' + ymdOf(now) + '">';
        h += '<div class="ghq-note">A draft is created automatically every morning. To make one now, choose ' + (t === 'DSR' ? 'the date' : t === 'WSR' ? 'the Monday of the week' : 'the month') + ':</div><div class="ghq-grid2">' + inp + '<button class="ghq-btn" onclick="GHQ.repGen(\'' + t + '\')">Generate draft</button></div>';
        if (!(repInfo.tpl || {})[t]) h += '<div class="ghq-note" style="color:#f87171">Template link for ' + t + ' is missing (ReportTemplates tab) — PDF / Excel cannot be created yet.</div>';
      }
      h += list.length ? list.map(function (r) {
        var per = r.type === 'DSR' ? fmtDate(r.start, r.start) : fmtDate(r.start, r.start) + ' → ' + fmtDate(r.end, r.end);
        return '<div class="op-item-card"><div class="op-item-top"><span class="tag-badge tag-pm">' + esc(r.no) + '</span>' +
          (r.status === 'Approved' ? '<span style="font-size:.72rem;color:#34d399">✔ Approved</span>' : '<span style="font-size:.72rem;color:var(--gold-light)">⏳ Waiting for ' + esc(repWait(r.status)) + '</span>') + '</div>' +
          '<div class="op-item-title">' + esc(per) + '</div>' +
          (r.eng ? '<div class="op-item-desc" style="font-size:.7rem;color:#34d399">✔ Engineer: ' + esc(r.eng) + (r.pm ? ' · PM/APM: ' + esc(r.pm) : '') + '</div>' : '') +
          (r.rem ? '<div class="op-item-desc" style="color:#f87171;font-size:.72rem">' + esc(r.rem) + '</div>' : '') +
          '<div class="op-item-foot"><button class="btn-gold-outline" onclick="GHQ.repOpen(\'' + esc(r.no) + '\')">' + (r.can ? (r.canEdit ? 'Check &amp; edit' : 'Review') : 'View') + '</button>' +
          (r.status === 'Approved' && !r.files && ['admin', 'engineer', 'pm', 'apm'].indexOf(session && session.role) >= 0 ? '<button class="btn-gold-solid" onclick="GHQ.repRegen(\'' + esc(r.no) + '\')">Create files again</button>' : '') + (r.status === 'Approved' && r.files && canRepDl() ? '<span style="display:flex;gap:6px"><button class="btn-gold-solid" onclick="GHQ.repDl(\'' + esc(r.no) + '\',\'pdf\')">PDF</button><button class="btn-gold-solid" onclick="GHQ.repDl(\'' + esc(r.no) + '\',\'xlsx\')">Excel</button></span>' : '<span></span>') + '</div></div>';
      }).join('') : '<div class="ghq-note">No report yet.</div>';
      el.innerHTML = h;
    });
  }
  function repGen(t) {
    var v = ($('rg-' + t) || {}).value; if (!v) { toast('Select the date / month'); return; }
    toast('Creating draft…');
    api('rep_generate', { type: t, start: t === 'MMR' ? v + '-01' : v }).then(function (r) {
      if (!r.ok) throw new Error(r.error || 'error'); toast('✔ Draft ' + r.no + ' created'); return pullRep();
    }).catch(function (e) { toast(String(e && e.message) === 'Failed to fetch' ? 'Internet required' : 'Error: ' + (e && e.message || e)); });
  }
  function pullRep() {
    if (LOCAL || !session) return Promise.resolve();
    return api('rep_list').then(function (r) {
      if (!r || !r.ok || !Array.isArray(r.list)) return;
      repItems = r.list; repInfo = { canGen: !!r.canGen, canDl: !!r.canDl, tpl: r.tpl || {} }; LS.set('ghq_rep_items', repItems); LS.set('ghq_rep_info', repInfo);
      var seenN = LS.get('ghq_rep_seen', {}), todo = 0;
      repItems.forEach(function (x) { if (x.can && seenN[x.no] !== x.status) { todo++; seenN[x.no] = x.status; } });
      LS.set('ghq_rep_seen', seenN);
      if (todo) toast('🔔 ' + todo + ' report' + (todo > 1 ? 's' : '') + ' waiting for your approval');
      updateBell();
      var sc = $('screen-reports'); if (sc && sc.classList.contains('active') && !repCtx) renderRep();
    }).catch(function () {});
  }
  function repRegen(no) {
    toast('Creating PDF and Excel — please wait…');
    api('rep_regen', { no: no }).then(function (r) { if (!r.ok) throw new Error(r.error || 'error'); toast(r.fileError ? 'Some files failed: ' + r.fileError : '✔ PDF and Excel are ready'); return pullRep().then(renderRep); }).catch(function (e) { toast('Error: ' + (e && e.message || e)); });
  }
  function repDl(no, kind) {
    if (!canRepDl()) { toast('Download is not allowed'); return; }
    toast('Preparing ' + (kind === 'xlsx' ? 'Excel' : 'PDF') + '…');
    api('rep_file', { no: no, kind: kind }).then(function (r) {
      if (!r.ok) throw new Error(r.error || 'error');
      var bin = atob(r.b64), bytes = new Uint8Array(bin.length); for (var k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      return saveBytes(r.name, r.mime || 'application/octet-stream', bytes);
    }).catch(function (e) { toast(String(e && e.message) === 'Failed to fetch' ? 'Internet required' : 'Could not download: ' + (e && e.message || e)); });
  }
  /* --- editor --- */
  function rcv(a) { var v = repCtx.cells[a]; return v == null ? '' : String(v).replace(/^[dt]:/, ''); }
  function rnum(a) { var v = repCtx.cells[a]; if (v === '' || v == null) return null; var n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.')); return isNaN(n) ? null : n; }
  function rtm(a) { var m = /^t:(\d{1,2}):(\d\d)$/.exec(String(repCtx.cells[a] || '')); return m ? +m[1] * 60 + +m[2] : null; }
  function rfld(a, l, t, opts, wide) {
    var ro = !repCtx.edit, h = '<div' + (wide ? ' style="grid-column:1/-1"' : '') + '><label class="ghq-lbl" style="font-size:.66rem">' + esc(l) + '</label>';
    if (t === 'sel') { var cur = rcv(a), list = opts.slice(); if (cur && list.indexOf(cur) < 0) list.push(cur); h += '<select class="cal-select rp" data-a="' + a + '" data-t="sel" style="width:100%"' + (ro ? ' disabled' : '') + '><option value=""></option>' + list.map(function (o) { return '<option' + (cur === o ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') + '</select>'; }
    else if (t === 'area') h += '<textarea class="ghq-input rp" data-a="' + a + '" data-t="text" rows="2"' + (ro ? ' readonly' : '') + '>' + esc(rcv(a)) + '</textarea>';
    else h += '<input class="ghq-input rp" data-a="' + a + '" data-t="' + (t === 'eq' ? 'text' : t || 'text') + '"' + (t === 'num' ? ' inputmode="decimal"' : '') + (t === 'date' ? ' type="date"' : t === 'time' ? ' type="time"' : '') + (t === 'eq' ? ' list="rp-eq"' : '') + ' value="' + esc(rcv(a)) + '"' + (ro ? ' readonly' : '') + '>';
    return h + '</div>';
  }
  function rcalc(key, label, unit) { return '<div style="display:flex;justify-content:space-between;font-size:.76rem;color:#e2e8f0;padding:2px 0"><span>' + esc(label) + '</span><b style="color:var(--gold-light)"><span class="rc" data-c="' + key + '">—</span> <small style="color:var(--text-muted)">' + (unit || '') + '</small></b></div>'; }
  function rhead(t) { return '<div class="sub-section-header" style="margin-top:12px">' + esc(t) + '</div>'; }
  function rcard(title, inner) { return '<div style="border:1px solid rgba(212,175,55,.18);border-radius:10px;padding:8px;margin:6px 0"><div style="font-size:.78rem;color:var(--gold-light);margin-bottom:4px">' + title + '</div><div class="ghq-grid2">' + inner + '</div></div>'; }
  function rrows(sec, r0, max, cols) {                 // how many repeating rows to show (filled ones + 1 blank + added)
    var last = -1; for (var i = 0; i < max; i++) { if (cols.some(function (c) { return rcv(c + (r0 + i)) !== ''; })) last = i; }
    return Math.min(max, last + 2 + (repExtra[sec] || 0));
  }
  function raddBtn(sec) { return repCtx.edit ? '<button class="ghq-btn ghost" style="margin-top:4px" onclick="GHQ.repAddRow(\'' + sec + '\')">+ Add row</button>' : ''; }
  function rgrid(r0, days, startDate) {
    var h = '<div style="overflow-x:auto"><table style="border-collapse:collapse;font-size:.7rem;color:#e2e8f0"><tr><th style="padding:3px 6px;text-align:left">Date</th>' + P6.map(function (p) { return '<th style="padding:3px 4px;min-width:78px">' + esc(p) + '</th>'; }).join('') + '<th style="padding:3px 6px">Total</th></tr>';
    for (var i = 0; i < days; i++) {
      var d = new Date(parseYmd(startDate).getTime() + i * 864e5), r = r0 + i;
      h += '<tr><td style="padding:2px 6px;white-space:nowrap">' + ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] + ' ' + p2(d.getDate()) + '</td>' + PC.map(function (c) { return '<td style="padding:1px"><input class="ghq-input rp" style="padding:4px;width:78px" inputmode="decimal" data-a="' + c + r + '" data-t="num" value="' + esc(rcv(c + r)) + '"' + (repCtx.edit ? '' : ' readonly') + '></td>'; }).join('') + '<td style="padding:2px 6px"><b class="rc" data-c="rt' + r + '">—</b></td></tr>';
    }
    return h + '<tr><td style="padding:3px 6px"><b>TOTAL</b></td>' + PC.map(function (c) { return '<td style="padding:3px;text-align:center"><b class="rc" data-c="ct' + c + '">—</b></td>'; }).join('') + '<td style="padding:3px 6px"><b class="rc" data-c="ctall">—</b></td></tr></table></div>';
  }
  function rform() {
    var c = repCtx, t = c.type, h = '<datalist id="rp-eq">' + EQ_OPTS.map(function (o) { return '<option value="' + esc(o) + '">'; }).join('') + '</datalist>';
    h += '<h3 class="ghq-h3">' + esc(c.no) + '</h3><div class="ghq-note"><b>' + esc(REPN[t]) + '</b> · ' + esc(fmtDate(c.start, c.start)) + (t === 'DSR' ? '' : ' → ' + esc(fmtDate(c.end, c.end))) + '<br>Status: <b>' + esc(c.status) + '</b>' + (c.eng ? '<br>✔ Engineer: ' + esc(c.eng) : '') + (c.pm ? ' · ✔ PM/APM: ' + esc(c.pm) : '') + (c.rem ? '<br><span style="color:#f87171">' + esc(c.rem) + '</span>' : '') +
      (c.edit ? '<br>Numbers are filled automatically from the app. Check them and correct anything that is wrong.' : '') + '</div>';
    var pairs = '<div class="ghq-grid2">' + (t === 'DSR' ? rfld('E3', 'Shift', 'sel', ['General', 'Morning', 'Evening', 'Night']) : '') + rfld('B4', 'Prepared by', 'text') + (t === 'DSR' ? '' : rfld('E4', 'Checked by', 'text')) + '</div>';
    h += pairs;
    if (t === 'DSR') {
      h += rhead('A. Meter readings & energy consumption');
      P6.forEach(function (p, i) { var r = 8 + i; h += rcard(esc(p) + ' — consumption <b class="rc" data-c="dc' + r + '">—</b> kWh', rfld('B' + r, 'Opening (kWh)', 'num') + rfld('C' + r, 'Closing (kWh)', 'num') + rfld('E' + r, 'Max demand (kVA)', 'num') + rfld('F' + r, 'Avg PF', 'num') + rfld('G' + r, 'Avg voltage (V)', 'num') + rfld('H' + r, 'Status', 'sel', ['Running', 'Standby', 'Off', 'Under Maintenance', 'Breakdown']) + rfld('I' + r, 'Remarks', 'text', null, true)); });
      h += rcalc('dtot', 'TOTAL consumption', 'kWh');
      h += rhead('B. Breakdown / fault log');
      var nf = rrows('f', 18, 5, ['A', 'B']); for (var i = 0; i < nf; i++) { var r = 18 + i; h += rcard('Fault ' + (i + 1) + ' — downtime <b class="rc" data-c="fd' + r + '">—</b> hrs', rfld('A' + r, 'Point / equipment', 'eq', null, true) + rfld('B' + r, 'Fault / complaint', 'text', null, true) + rfld('C' + r, 'Start time', 'time') + rfld('D' + r, 'End time', 'time') + rfld('F' + r, 'Root cause', 'text') + rfld('G' + r, 'Action taken', 'text') + rfld('H' + r, 'Attended by', 'text') + rfld('I' + r, 'Status', 'sel', ['Open', 'Closed'])); }
      h += raddBtn('f') + rcalc('fcount', 'Total breakdowns', 'nos') + rcalc('fdt', 'Total downtime', 'hrs');
      h += rhead('C. Preventive maintenance done today');
      var np = rrows('p', 27, 4, ['A', 'B']); for (var j = 0; j < np; j++) { var q = 27 + j; h += rcard('PM ' + (j + 1), rfld('A' + q, 'Point / equipment', 'eq', null, true) + rfld('B' + q, 'PM activity', 'text', null, true) + rfld('E' + q, 'Status', 'sel', ['Planned', 'Done', 'Pending']) + rfld('F' + q, 'Done by', 'text') + rfld('G' + q, 'Remarks', 'text', null, true)); }
      h += raddBtn('p');
      h += rhead('D. Equipment status');
      ['Transformer', 'LT Panel', 'APFC Panel', 'UPS', 'HVAC', 'Lift', 'Fire Fighting System', 'EV Chargers', 'Helipad Lights'].forEach(function (n, i) { var r2 = 34 + i; h += rcard(esc(n), rfld('B' + r2, 'Status', 'sel', ['Running', 'Standby', 'Off', 'Under Maintenance', 'Breakdown']) + rfld('C' + r2, 'Remarks', 'text')); });
      h += rhead('E. Complaints, safety & manpower') + '<div class="ghq-grid2">' + [['Complaints received (nos)', 45], ['Complaints closed (nos)', 46], ['Complaints open (nos)', 47], ['Safety incidents (nos)', 48], ['Near misses (nos)', 49], ['Permit to Work issued (nos)', 50], ['Manpower present (nos)', 51], ['Manpower absent (nos)', 52]].map(function (x) { return rfld('B' + x[1], x[0], 'num'); }).join('') + '</div>';
      h += rhead('F. Other') + rfld('B55', 'Spares / consumables used', 'area') + rfld('B56', 'General remarks', 'area') + rfld('B57', 'Plan for tomorrow', 'area');
    } else {
      var W = t === 'WSR', days = W ? 7 : dayCount(c.start, c.end), r0 = W ? 20 : 44, fr = W ? 30 : 54, fmax = W ? 8 : 15, pr = W ? 41 : 72, pmax = W ? 10 : 15;
      h += rhead('A. Daily energy consumption (kWh)') + rgrid(9, days, c.start);
      h += rhead('B. Point-wise summary');
      P6.forEach(function (p, i) { var r = r0 + i; h += rcard(esc(p) + ' — total <b class="rc" data-c="pt' + i + '">—</b> kWh', rfld('F' + r, 'Peak demand (kVA)', 'num') + rfld('G' + r, 'Avg power factor', 'num') + rfld('H' + r, W ? 'Previous week (kWh)' : 'Previous month (kWh)', 'num') + '<div style="font-size:.7rem;color:var(--text-muted)">Avg/day <b class="rc" data-c="pa' + i + '">—</b> · Peak day <b class="rc" data-c="pk' + i + '">—</b> · Share <b class="rc" data-c="ps' + i + '">—</b> · Change <b class="rc" data-c="pc' + i + '">—</b></div>'); });
      h += rhead(W ? 'C. Breakdown summary' : 'C. Breakdown analysis');
      var nf2 = rrows('f', fr, fmax, ['C', 'D']); for (var k = 0; k < nf2; k++) { var r3 = fr + k; h += rcard('Breakdown ' + (k + 1), rfld('B' + r3, 'Date', 'date') + rfld('C' + r3, 'Point / equipment', 'eq') + rfld('D' + r3, 'Fault / complaint', 'text', null, true) + rfld('E' + r3, 'Downtime (hrs)', 'num') + rfld('F' + r3, 'Root cause', 'text') + rfld('G' + r3, 'Action taken', 'text') + rfld('H' + r3, 'Status', 'sel', ['Open', 'Closed'])); }
      h += raddBtn('f');
      h += rhead('D. Preventive maintenance — planned vs actual');
      var np2 = rrows('p', pr, pmax, ['C', 'D']); for (var m = 0; m < np2; m++) { var r4 = pr + m; h += rcard('PM ' + (m + 1), rfld('B' + r4, 'Planned date', 'date') + rfld('C' + r4, 'Point / equipment', 'eq') + rfld('D' + r4, 'PM activity', 'text', null, true) + rfld('E' + r4, 'Status', 'sel', ['Planned', 'Done', 'Pending']) + rfld('F' + r4, 'Done by', 'text') + rfld('G' + r4, 'Remarks', 'text', null, true)); }
      h += raddBtn('p');
      h += rhead('KPIs (automatic)') + rfld(W ? 'C53' : 'C89', 'Number of points / critical equipment monitored', 'num', null, true) + rcalc('k1', 'Breakdown count', 'nos') + rcalc('k2', 'Total downtime', 'hrs') + rcalc('k3', 'MTTR', 'hrs') + (W ? '' : rcalc('k4', 'MTBF', 'hrs')) + rcalc('k5', 'Equipment availability', '') + rcalc('k6', 'Open jobs', 'nos') + rcalc('k7', 'PM planned', 'nos') + rcalc('k8', 'PM done', 'nos') + rcalc('k9', 'PM compliance', '');
      if (W) {
        h += rhead('E. Pending / open jobs'); var no = rrows('o', 65, 6, ['B', 'D']); for (var o = 0; o < no; o++) { var r5 = 65 + o; h += rcard('Job ' + (o + 1), rfld('B' + r5, 'Job description', 'text', null, true) + rfld('D' + r5, 'Point / equipment', 'eq') + rfld('E' + r5, 'Reason for delay', 'text') + rfld('G' + r5, 'Target date', 'date') + rfld('H' + r5, 'Responsible', 'text') + rfld('I' + r5, 'Remarks', 'text', null, true)); }
        h += raddBtn('o') + rhead('F. Complaints, safety, spares & plan');
        [['Complaints received / closed (nos)', 73], ['Average complaint response time (hrs)', 74], ['Safety observations / toolbox talk', 75], ['Spares requirement / indent', 76], ['Remarks', 77], ['Plan for next week', 78]].forEach(function (x) { h += rfld('D' + x[1], x[0], 'area'); });
      } else {
        h += rhead('E. Maintenance cost (Rs)'); ['Spares & consumables', 'AMC / contractor', 'Repairs', 'Other'].forEach(function (n, i) { var r6 = 102 + i; h += rcard(esc(n) + ' — variance <b class="rc" data-c="cv' + r6 + '">—</b>', rfld('B' + r6, 'Budget (Rs)', 'num') + rfld('C' + r6, 'Actual (Rs)', 'num') + rfld('E' + r6, 'Remarks', 'text', null, true)); });
        h += rhead('F. Statutory / AMC compliance'); ['Fire safety / fire NOC', 'Lift inspection & licence', 'Transformer / HT testing', 'Earth pit testing', 'Thermography of panels', 'Meter / instrument calibration', 'EV charger service', 'AMC contracts review'].forEach(function (n, i) { var r7 = 110 + i; h += rcard(esc(n), rfld('B' + r7, 'Due date', 'date') + rfld('C' + r7, 'Done date', 'date') + rfld('D' + r7, 'Status', 'sel', ['Done', 'Pending', 'Not Due']) + rfld('E' + r7, 'Remarks', 'text')); });
        h += rhead('G. Other reporting'); ['Executive summary', 'Root cause analysis & corrective actions', 'Inventory / spares status', 'Safety report (incidents, audits, training)', 'Manpower (attendance, overtime, training)', 'Improvement / energy-saving proposals', 'Plan for next month'].forEach(function (n, i) { h += rfld('B' + (120 + i), n, 'area'); });
      }
    }
    if (c.edit) h += '<div class="ghq-grid2" style="margin-top:12px"><button class="ghq-btn ghost" onclick="GHQ.repSave()">Save changes</button><button class="ghq-btn" onclick="GHQ.repAct(\'approve\')">Approve → PM / APM</button></div><button class="ghq-btn ghost" style="margin-top:6px" onclick="GHQ.repClose()">Close</button>';
    else if (c.can) h += '<label class="ghq-lbl" style="margin-top:12px">Reason (needed only to send back)</label><input id="cv-note" class="ghq-input" placeholder="Reason"><div class="ghq-grid2" style="margin-top:8px"><button class="ghq-btn ghost" onclick="GHQ.repAct(\'reject\')">Send back</button><button class="ghq-btn" onclick="GHQ.repAct(\'approve\')">Approve &amp; create PDF + Excel</button></div><button class="ghq-btn ghost" style="margin-top:6px" onclick="GHQ.repClose()">Close</button>';
    else h += '<button class="ghq-btn ghost" style="margin-top:12px" onclick="GHQ.repClose()">Close</button>';
    modal(h);
    var card = document.querySelector('.ghq-ov-card'); if (card) { card.style.maxWidth = '640px'; card.style.width = '96vw'; }
    document.querySelectorAll('.ghq-ov-card .rp').forEach(function (i) { i.addEventListener('input', repLive); i.addEventListener('change', repLive); });
    repLive();
  }
  function dayCount(a, b) { return Math.round((parseYmd(b) - parseYmd(a)) / 864e5) + 1; }
  function repCollect() {
    var cl = JSON.parse(JSON.stringify(repCtx.cells));
    document.querySelectorAll('.ghq-ov-card .rp').forEach(function (i) {
      var a = i.getAttribute('data-a'), t = i.getAttribute('data-t'), v = (i.value || '').trim();
      if (t === 'num') { var n = parseFloat(v.replace(',', '.')); v = v !== '' && !isNaN(n) ? n : v; }
      else if (i.type === 'date') v = v ? 'd:' + v : '';
      else if (i.type === 'time') v = v ? 't:' + v : '';
      cl[a] = v;
    });
    repCtx.cells = cl; return cl;
  }
  function repLive() {
    if (!repCtx) return; if (repCtx.edit) repCollect();
    var R = {}, W = repCtx.type === 'WSR', M = repCtx.type === 'MMR';
    function f(v, n) { return v === '' || v == null || !isFinite(v) ? '—' : String(Math.round(v * Math.pow(10, n === undefined ? 2 : n)) / Math.pow(10, n === undefined ? 2 : n)); }
    function pct(v) { return v === '' || v == null || !isFinite(v) ? '—' : (Math.round(v * 1000) / 10) + '%'; }
    if (repCtx.type === 'DSR') {
      var tot = 0; for (var r = 8; r <= 13; r++) { var o = rnum('B' + r), cl = rnum('C' + r); R['dc' + r] = (o == null || cl == null) ? '—' : f(cl - o); if (o != null && cl != null) tot += cl - o; }
      R.dtot = f(tot); var cnt = 0, dt = 0;
      for (var q = 18; q <= 22; q++) { var a = rtm('C' + q), b = rtm('D' + q); if (rcv('A' + q) !== '') cnt++; if (a != null && b != null) { var h2 = Math.round((((b - a) % 1440 + 1440) % 1440) / 60 * 100) / 100; R['fd' + q] = f(h2); dt += h2; } else R['fd' + q] = '—'; }
      R.fcount = String(cnt); R.fdt = f(dt);
    } else {
      var days = W ? 7 : dayCount(repCtx.start, repCtx.end), colT = [0, 0, 0, 0, 0, 0], colN = [0, 0, 0, 0, 0, 0], colMax = [null, null, null, null, null, null], all = 0, rowTots = [];
      for (var i = 0; i < days; i++) { var rr = 9 + i, rs = 0, rn = 0; PC.forEach(function (c, j) { var v = rnum(c + rr); if (v != null) { colT[j] += v; colN[j]++; rs += v; rn++; if (colMax[j] == null || v > colMax[j]) colMax[j] = v; } }); R['rt' + rr] = rn ? f(rs) : '—'; if (rn) { rowTots.push(rs); all += rs; } }
      PC.forEach(function (c, j) { R['ct' + c] = f(colT[j]); }); R.ctall = f(all);
      var r0 = W ? 20 : 44, mx = null, pf = [], prev = 0;
      P6.forEach(function (p, i) {
        R['pt' + i] = f(colT[i]); R['pa' + i] = colN[i] ? f(colT[i] / colN[i]) : '—'; R['pk' + i] = f(colMax[i]); R['ps' + i] = all ? pct(colT[i] / all) : '—';
        var pv = rnum('H' + (r0 + i)); R['pc' + i] = pv ? pct(colT[i] / pv - 1) : '—';
      });
      var fr = W ? 30 : 54, fmax = W ? 8 : 15, pr = W ? 41 : 72, pmax = W ? 10 : 15, n = rnum(W ? 'C53' : 'C89'), hours = days * 24, bc = 0, bd = 0, op = 0, pl = 0, pd = 0;
      for (var x = 0; x < fmax; x++) { var rw = fr + x; if (rcv((W ? 'C' : 'D') + rw) !== '') bc++; var dv = rnum('E' + rw); if (dv != null) bd += dv; if (rcv('H' + rw) === 'Open') op++; }
      for (var y = 0; y < pmax; y++) { var rp = pr + y; if (rcv((W ? 'C' : 'D') + rp) !== '') pl++; if (rcv('E' + rp) === 'Done') pd++; }
      R.k1 = String(bc); R.k2 = f(bd); R.k3 = bc ? f(bd / bc) : '—'; R.k4 = bc && n ? f((hours * n - bd) / bc) : '—'; R.k5 = n ? pct(1 - bd / (hours * n)) : '—'; R.k6 = String(op); R.k7 = String(pl); R.k8 = String(pd); R.k9 = pl ? pct(pd / pl) : '—';
      if (M) for (var z = 102; z <= 105; z++) { var bu = rnum('B' + z), ac = rnum('C' + z); R['cv' + z] = (bu == null && ac == null) ? '—' : f((ac || 0) - (bu || 0)); }
    }
    document.querySelectorAll('.ghq-ov-card .rc').forEach(function (el) { var k = el.getAttribute('data-c'); if (R[k] !== undefined) el.textContent = R[k]; });
  }
  function repAddRow(sec) { repCollect(); repExtra[sec] = (repExtra[sec] || 0) + 1; rform(); }
  function repOpen(no) {
    if (!navigator.onLine) { toast('Internet required'); return; }
    modal('<div class="ghq-note">Loading…</div>');
    api('rep_get', { no: no }).then(function (r) {
      if (!r.ok) throw new Error(r.error || 'error');
      repExtra = {}; repCtx = { no: no, type: r.type, start: r.start, end: r.end, status: r.status, eng: r.eng, pm: r.pm, rem: r.rem, can: r.can, edit: !!r.canEdit, cells: r.cells || {} };
      rform();
    }).catch(function (e) { closeModal(); toast('Could not open: ' + (e && e.message || e)); });
  }
  function repClose() { repCtx = null; closeModal(); renderRep(); }
  function repSave(quiet) {
    var cells = repCollect();
    return api('rep_save', { no: repCtx.no, cells: cells }).then(function (r) { if (!r.ok) throw new Error(r.error || 'error'); if (!quiet) toast('✔ Changes saved'); }).catch(function (e) { toast(String(e && e.message) === 'Failed to fetch' ? 'Internet required' : 'Error: ' + (e && e.message || e)); throw e; });
  }
  function repAct(act) {
    var note = ($('cv-note') || {}).value || '';
    if (act === 'reject' && !note.trim()) { toast('Enter the reason to send back'); return; }
    var go = function () {
      toast(act === 'approve' && !repCtx.edit ? 'Creating PDF and Excel — please wait…' : 'Please wait…');
      return api('rep_act', { no: repCtx.no, act: act, note: note.trim() }).then(function (r) {
        if (!r.ok) throw new Error(r.error || 'error');
        repCtx = null; closeModal();
        toast(r.status === 'Approved' ? (r.fileError ? '✔ Approved, but files failed: ' + r.fileError : '✔ Approved — PDF and Excel are ready') : r.status === 'Pending Engineer' ? 'Sent back to Engineer' : '✔ Approved — sent to PM / APM');
        return pullRep().then(renderRep);
      });
    };
    (repCtx.edit ? repSave(true) : Promise.resolve()).then(go).catch(function (e) { if (e && e.message) toast(String(e.message) === 'Failed to fetch' ? 'Internet required' : 'Error: ' + e.message); });
  }

  /* ---------- Assets: equipment register per category, QR labels, QR scan ---------- */
  var LOGO_B64 = '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';
  try { var lb = atob(LOGO_B64), lu = new Uint8Array(lb.length); for (var li = 0; li < lb.length; li++) lu[li] = lb.charCodeAt(li); if (window.XlsxLite) window.XlsxLite.logo = lu; } catch (e) {}
  var assets = LS.get('ghq_assets', { cats: ['Electrical', 'HVAC', 'Plumbing', 'Other'], items: [], canEdit: false }), astCat = null, astQ = '', scanStream = null, scanTimer = null;
  var AST_STATUS = ['Running', 'Standby', 'Under Maintenance', 'Breakdown', 'Scrapped'];
  function pullAssets() {
    if (LOCAL || !session) return Promise.resolve();
    return api('asset_list').then(function (r) {
      if (!r || !r.ok || !Array.isArray(r.items)) return;
      assets = { cats: r.cats, items: r.items, canEdit: !!r.canEdit }; LS.set('ghq_assets', assets);
      var sc = $('screen-assets'); if (sc && sc.classList.contains('active') && !$('ghq-ov')) renderAssets();
    }).catch(function () {});
  }
  function astItems() {
    var q = astQ.toLowerCase();
    return assets.items.filter(function (a) { return (!astCat || a.cat === astCat) && (!q || [a.tag, a.name, a.loc, a.id, a.make, a.model, a.serial].join(' ').toLowerCase().indexOf(q) >= 0); });
  }
  function renderAssets() {
    var scr = $('screen-assets'); if (!scr) return;
    ['assets-category-view', 'assets-sheet-view'].forEach(function (id) { var e = $(id); if (e) e.style.display = 'none'; });
    var root = $('ast-root'); if (!root) { root = document.createElement('div'); root.id = 'ast-root'; root.style.cssText = 'display:flex;flex-direction:column;gap:10px'; scr.appendChild(root); }
    var h = '<div class="ghq-grid2"><button class="ghq-btn" onclick="GHQ.astScan()"><i class="fa-solid fa-qrcode"></i> Scan QR</button>' + (assets.canEdit || canHold() ? '<button class="ghq-btn ghost" onclick="GHQ.astForm()"><i class="fa-solid fa-plus"></i> Add equipment</button>' : '<span></span>') + '</div>';
    if (canAdmin() && !astCat) h += '<button class="ghq-btn ghost" onclick="GHQ.astImport()">Import old equipment from PPM sheet (Admin)</button>';
    h += '<input class="ghq-input" placeholder="Search tag, name, location, ID…" value="' + esc(astQ) + '" oninput="GHQ.astSearch(this.value)">';
    if (!astCat && !astQ) {
      h += '<div class="section-title"><span>Asset categories</span><span style="font-size:.72rem;color:var(--gold-primary)">' + assets.items.length + ' equipment</span></div>';
      h += assets.cats.map(function (c) { var n = assets.items.filter(function (a) { return a.cat === c; }).length; return '<div class="op-item-card" onclick="GHQ.astOpen(\'' + esc(c) + '\')" style="cursor:pointer"><div class="op-item-top"><span class="tag-badge tag-pm">' + esc(c) + '</span><span style="font-size:.72rem;color:var(--cyan)">' + n + ' equipment</span></div><div class="op-item-title">' + esc(c) + ' assets</div></div>'; }).join('');
    } else {
      var list = astItems();
      h += '<div class="section-title"><span>' + (astCat ? '<a href="javascript:GHQ.astOpen(null)" style="color:var(--gold-light)">← All</a> · ' + esc(astCat) : 'Search results') + '</span><span style="font-size:.72rem;color:var(--cyan)">' + list.length + '</span></div>';
      if (astCat && list.length) h += '<button class="ghq-btn ghost" onclick="GHQ.astLabels()">Download QR labels (this category)</button>';
      h += list.length ? list.map(function (a) {
        return '<div class="op-item-card"><div class="op-item-top"><span class="tag-badge tag-pm">' + esc(a.tag || a.id) + '</span><span style="font-size:.72rem;color:' + (a.status === 'Breakdown' ? '#f87171' : a.status === 'Running' ? '#34d399' : 'var(--gold-light)') + '">' + esc(a.status || '') + '</span></div>' +
          '<div class="op-item-title">' + esc(a.name) + '</div><div class="op-item-desc">' + esc(a.loc || '') + (a.make ? ' · ' + esc(a.make) : '') + '</div>' +
          '<div class="op-item-foot"><span style="font-size:.66rem;color:var(--text-muted)">' + esc(a.id) + '</span><button class="btn-gold-solid" onclick="GHQ.astShow(\'' + esc(a.id) + '\')">Details &amp; QR</button></div></div>';
      }).join('') : '<div class="ghq-note">No equipment found.</div>';
    }
    root.innerHTML = h;
  }
  function astSearch(v) { astQ = v; var root = $('ast-root'), pos = root && root.querySelector('input.ghq-input'); renderAssets(); var i = $('ast-root').querySelector('input.ghq-input'); if (i) { i.focus(); try { i.setSelectionRange(v.length, v.length); } catch (e) {} } }
  function astImport() {
    if (!navigator.onLine) { toast('Internet required'); return; }
    if (!confirm('Copy all equipment from the PPM sheet into Assets? Existing ones are skipped.')) return;
    toast('Importing…');
    api('asset_import').then(function (r) { if (!r.ok) throw new Error(r.error || 'error'); toast('✔ ' + r.added + ' added, ' + r.skipped + ' already there'); return pullAssets(); }).then(renderAssets).catch(function (e) { toast('Error: ' + (e && e.message || e)); });
  }
  function astOpen(c) { astCat = c; astQ = ''; renderAssets(); }
  /* QR */
  function qrCanvas(text, px) {
    var qr = qrcode(0, 'M'); qr.addData(text); qr.make();
    var n = qr.getModuleCount(), m = 3, sc = Math.max(2, Math.floor(px / (n + 2 * m))), size = (n + 2 * m) * sc, c = document.createElement('canvas'); c.width = c.height = size;
    var x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, size, size); x.fillStyle = '#000';
    for (var r = 0; r < n; r++) for (var q = 0; q < n; q++) if (qr.isDark(r, q)) x.fillRect((q + m) * sc, (r + m) * sc, sc, sc);
    return c;
  }
  var logoImg = null; (function () { var i = new Image(); i.onload = function () { logoImg = i; }; i.src = 'data:image/png;base64,' + LOGO_B64; })();
  function labelCanvas(a, w, h) {                        // sticker: QR + names + logo
    var c = document.createElement('canvas'); c.width = w; c.height = h; var x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.strokeStyle = '#999'; x.lineWidth = 2; x.strokeRect(1, 1, w - 2, h - 2);
    var q = qrCanvas('GHQ-ASSET:' + a.id, h - 20); x.drawImage(q, 10, 10, h - 20, h - 20);
    var tx = h, fs = Math.round(h / 11); x.fillStyle = '#000'; x.textBaseline = 'top';
    if (logoImg) { var lh = Math.round(h * 0.24), lw = Math.round(lh * logoImg.width / logoImg.height); x.drawImage(logoImg, tx, 12, lw, lh); }
    function wrap(t, y, size, bold, maxLines) { x.font = (bold ? 'bold ' : '') + size + 'px Arial'; var words = String(t).split(' '), line = '', lines = 0; for (var i = 0; i < words.length; i++) { var test = line ? line + ' ' + words[i] : words[i]; if (x.measureText(test).width > w - tx - 12 && line) { x.fillText(line, tx, y); y += size * 1.2; line = words[i]; if (++lines >= maxLines) return y; } else line = test; } x.fillText(line, tx, y); return y + size * 1.2; }
    var y = Math.round(h * 0.32);
    y = wrap(a.name, y, fs * 1.25, true, 2); if (a.tag) y = wrap('Tag: ' + a.tag, y, fs, true, 1); y = wrap(a.id, y, fs * 0.85, false, 1); if (a.loc) wrap(a.loc, y, fs * 0.85, false, 2);
    return c;
  }
  function canvasBytes(c) { return new Promise(function (res) { c.toBlob(function (b) { var fr = new FileReader(); fr.onload = function () { res(new Uint8Array(fr.result)); }; fr.readAsArrayBuffer(b); }, 'image/png'); }); }
  function astLabel(id) { var a = assets.items.filter(function (x) { return x.id === id; })[0]; if (!a) return; canvasBytes(labelCanvas(a, 900, 360)).then(function (b) { return saveBytes('QR_' + (a.tag || a.id).replace(/[^\w\-]+/g, '_') + '.png', 'image/png', b); }); }
  function astLabels() {
    var list = astItems(), per = 12, pages = Math.ceil(list.length / per), chain = Promise.resolve();
    for (var p = 0; p < pages; p++) (function (p) {
      chain = chain.then(function () {
        var W = 1240, H = 1754, c = document.createElement('canvas'); c.width = W; c.height = H; var x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
        list.slice(p * per, p * per + per).forEach(function (a, i) { var lc = labelCanvas(a, 580, 250); x.drawImage(lc, 40 + (i % 2) * 600, 40 + Math.floor(i / 2) * 280); });
        return canvasBytes(c).then(function (b) { return saveBytes('QR_labels_' + astCat + '_p' + (p + 1) + '.png', 'image/png', b); });
      });
    })(p);
    toast('Preparing ' + pages + ' page' + (pages > 1 ? 's' : '') + ' of QR labels…');
  }
  /* details */
  function astShow(id) {
    var cached = assets.items.filter(function (x) { return x.id === id; })[0];
    function draw(a) {
      var row = function (l, v) { return v ? '<div style="display:flex;justify-content:space-between;gap:8px;font-size:.78rem;padding:3px 0;border-bottom:1px dashed rgba(212,175,55,.15)"><span style="color:var(--text-muted)">' + l + '</span><b style="color:#e2e8f0;text-align:right">' + esc(v) + '</b></div>' : ''; };
      var today = ymdOf(new Date()), p = a.ppm, h = '<h3 class="ghq-h3">' + esc(a.name) + '</h3><div class="ghq-note">' + esc(a.cat) + ' · ' + esc(a.id) + '</div><div style="text-align:center"><canvas id="ast-qr" style="max-width:190px;width:60%;border:6px solid #fff;border-radius:6px"></canvas></div>' +
        row('Tag', a.tag) + row('Make', a.make) + row('Model', a.model) + row('Serial no', a.serial) + row('Capacity / rating', a.cap) + row('Location', a.loc) + row('Installed on', a.inst ? fmtDate(a.inst, a.inst) : '') + row('Vendor / AMC', a.vendor) + row('Status', a.status) + row('Remarks', a.rem);
      h += '<div class="sub-section-header" style="margin-top:10px">Preventive maintenance</div>';
      if (a.ppm === undefined) h += '<div class="ghq-note">Open with internet to see PPM details.</div>';
      else if (!p) h += '<div class="ghq-note">No PPM scheduled for this equipment.</div>';
      else h += row('Frequency', p.freq) + row('Team / vendor', p.team) + row('Last PPM', p.last ? fmtDate(p.last, p.last) : 'Not done yet') + '<div style="display:flex;justify-content:space-between;font-size:.78rem;padding:3px 0"><span style="color:var(--text-muted)">Next PPM due</span><b style="color:' + (p.next && p.next < today ? '#f87171' : '#34d399') + '">' + (p.next ? fmtDate(p.next, p.next) + (p.next < today ? ' (overdue)' : '') : 'Today / not scheduled') + '</b></div>' +
        (p.history && p.history.length ? '<div class="ghq-note" style="margin-top:4px">Recent: ' + p.history.map(function (x) { return esc(fmtDate(x.date, x.date)) + ' (' + esc(x.by) + ')'; }).join(' · ') + '</div>' : '');
      if (a.tickets && a.tickets.length) h += '<div class="sub-section-header" style="margin-top:10px">Recent tickets</div>' + a.tickets.map(function (t) { return '<div style="font-size:.76rem;color:#e2e8f0;padding:2px 0">' + esc(t.id) + ' · ' + esc(t.title) + ' <span style="color:' + (t.status === 'Closed' ? '#34d399' : '#f87171') + '">' + esc(t.status) + '</span></div>'; }).join('');
      h += '<div class="ghq-grid2" style="margin-top:12px"><button class="ghq-btn ghost" onclick="GHQ.astLabel(\'' + esc(a.id) + '\')">Download QR</button>' + (a.canEdit || canHold() ? '<button class="ghq-btn ghost" onclick="GHQ.astForm(\'' + esc(a.id) + '\')">Edit</button>' : '<span></span>') + '</div><button class="ghq-btn" style="margin-top:6px" onclick="GHQ.closeModal()">Close</button>';
      modal(h); var cv = $('ast-qr'); if (cv) { var q = qrCanvas('GHQ-ASSET:' + a.id, 380); cv.width = q.width; cv.height = q.height; cv.getContext('2d').drawImage(q, 0, 0); }
    }
    if (!navigator.onLine || LOCAL) { if (cached) draw(cached); else toast('Not found'); return; }
    modal('<div class="ghq-note">Loading…</div>');
    api('asset_get', { id: id }).then(function (r) { if (!r.ok) throw new Error(r.error || 'error'); draw(r); }).catch(function (e) { if (cached) draw(cached); else { closeModal(); toast('Could not open: ' + (e && e.message || e)); } });
  }
  /* add / edit */
  function astForm(id) {
    if (!canHold()) { toast('Only Supervisor / Engineer / Admin can add equipment'); return; }
    var a = id ? assets.items.filter(function (x) { return x.id === id; })[0] : null, e = a || { cat: astCat || 'Electrical', status: 'Running' };
    function f(i, l, v, ph, t) { return '<label class="ghq-lbl">' + l + '</label><input id="af-' + i + '" class="ghq-input"' + (t ? ' type="' + t + '"' : '') + ' value="' + esc(v || '') + '" placeholder="' + esc(ph || '') + '">'; }
    var h = '<h3 class="ghq-h3">' + (a ? 'Edit equipment' : 'Add equipment') + '</h3>' +
      '<label class="ghq-lbl">Category</label><select id="af-cat" class="cal-select" style="width:100%"' + (a ? ' disabled' : '') + '>' + assets.cats.map(function (c) { return '<option' + (c === e.cat ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select>' +
      f('name', 'Equipment name *', e.name, 'e.g. Chiller 1') + f('tag', 'Tag no.', e.tag, 'e.g. CH-01') + '<div class="ghq-grid2"><div>' + f('make', 'Make', e.make) + '</div><div>' + f('model', 'Model', e.model) + '</div></div>' +
      '<div class="ghq-grid2"><div>' + f('serial', 'Serial no.', e.serial) + '</div><div>' + f('cap', 'Capacity / rating', e.cap, 'e.g. 500 TR') + '</div></div>' + f('loc', 'Location', e.loc, 'e.g. Office Tower / L-11') +
      '<div class="ghq-grid2"><div>' + f('inst', 'Installed on', e.inst, '', 'date') + '</div><div><label class="ghq-lbl">Status</label><select id="af-status" class="cal-select" style="width:100%">' + AST_STATUS.map(function (s) { return '<option' + (s === e.status ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select></div></div>' +
      f('vendor', 'Vendor / AMC', e.vendor) + f('rem', 'Remarks', e.rem) +
      '<div class="sub-section-header" style="margin-top:10px">Add to PPM schedule (optional — Electrical / HVAC / Plumbing)</div><div class="ghq-grid2"><div><label class="ghq-lbl">PPM frequency</label><select id="af-pf" class="cal-select" style="width:100%"><option value="">No PPM</option><option>Weekly</option><option>Fortnightly</option><option>Monthly</option><option>Quarterly</option><option>Half-yearly</option><option>Yearly</option></select></div><div>' + f('pl', 'Last PPM done', '', '', 'date') + '</div></div>' + f('pt', 'PPM team / vendor', '') + (canAdmin() ? f('plink', 'Checklist Google Sheet link or name (Admin only)', '') : '') +
      '<div class="ghq-grid2" style="margin-top:8px"><button class="ghq-btn ghost" onclick="GHQ.closeModal()">Cancel</button><button class="ghq-btn" onclick="GHQ.astSave(' + (a ? '\'' + esc(a.id) + '\'' : '') + ')">Save</button></div>';
    modal(h);
  }
  function astSave(id) {
    var g = function (k) { return ($('af-' + k) || {}).value || ''; }, e = { cat: g('cat'), name: g('name').trim(), tag: g('tag').trim(), make: g('make').trim(), model: g('model').trim(), serial: g('serial').trim(), cap: g('cap').trim(), loc: g('loc').trim(), inst: g('inst'), vendor: g('vendor').trim(), status: g('status'), rem: g('rem').trim(), ppmFreq: g('pf'), ppmLast: g('pl'), team: g('pt').trim(), link: canAdmin() ? g('plink').trim() : '' };
    if (!e.name) { toast('Enter the equipment name'); return; }
    if (!navigator.onLine) { toast('Internet required'); return; }
    api(id ? 'asset_update' : 'asset_add', id ? { id: id, e: e } : { e: e }).then(function (r) {
      if (!r.ok) throw new Error(r.error || 'error');
      toast(r.ppmError ? 'Saved. PPM not added: ' + r.ppmError : '✔ Saved' + (r.ppm ? ' · added to PPM' : ''));
      closeModal(); return Promise.all([pullAssets(), r.ppm ? pullPpm() : null]).then(function () { renderAssets(); if (!id && r.id) astShow(r.id); });
    }).catch(function (er) { toast(String(er && er.message) === 'Failed to fetch' ? 'Internet required' : 'Error: ' + (er && er.message || er)); });
  }
  /* QR scan */
  function stopScan() { if (scanTimer) { clearInterval(scanTimer); scanTimer = null; } if (scanStream) { scanStream.getTracks().forEach(function (t) { t.stop(); }); scanStream = null; } }
  function astScan() {
    modal('<h3 class="ghq-h3">Scan equipment QR</h3><video id="scan-v" playsinline muted style="width:100%;border-radius:10px;background:#000;max-height:50vh"></video><div class="ghq-note" id="scan-msg">Starting camera…</div>' +
      '<label class="ghq-lbl">Or type the Asset ID / Tag</label><div class="ghq-grid2"><input id="scan-id" class="ghq-input" placeholder="JWC-GHQ-EL-0001 or CH-01"><button class="ghq-btn" onclick="GHQ.astFind()">Find</button></div><button class="ghq-btn ghost" style="margin-top:6px" onclick="GHQ.closeModal()">Close</button>');
    var v = $('scan-v'), cv = document.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $('scan-msg').textContent = 'Camera not available — type the ID below.'; return; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }).then(function (st) {
      scanStream = st; v.srcObject = st; v.play(); $('scan-msg').textContent = 'Point the camera at the QR sticker';
      scanTimer = setInterval(function () {
        if (!v.videoWidth) return; cv.width = v.videoWidth; cv.height = v.videoHeight; cx.drawImage(v, 0, 0);
        var im = cx.getImageData(0, 0, cv.width, cv.height), code = jsQR(im.data, im.width, im.height, { inversionAttempts: 'dontInvert' });
        if (code && /^GHQ-ASSET:/.test(code.data)) { var id = code.data.replace('GHQ-ASSET:', '').trim(); stopScan(); closeModal(); astShow(id); }
      }, 250);
    }).catch(function (er) { var m = $('scan-msg'); if (m) m.textContent = 'Could not open the camera (' + (er && er.name || 'error') + '). Allow Camera permission, or type the ID below.'; });
  }
  function astFind() {
    var q = (($('scan-id') || {}).value || '').trim().toLowerCase(); if (!q) return;
    var a = assets.items.filter(function (x) { return x.id.toLowerCase() === q || (x.tag && x.tag.toLowerCase() === q); })[0];
    if (!a) { toast('No equipment found for “' + q + '”'); return; } stopScan(); closeModal(); astShow(a.id);
  }
  function ppmDone(i) {
    var e = ppmRows[i]; if (!e) return;
    var date = $('pd-date').value, note = $('pd-note').value.trim();
    if (!date) { toast('Select the date'); return; }
    if (date > ymdOf(new Date())) { toast('Date cannot be in the future'); return; }
    commit('ppm.done', { key: eqKey(e), eq: e.name, loc: e.loc || '', date: date, note: note }).then(function () { closeModal(); toast('✔ PPM marked done: ' + e.name); });
  }
  function pullPpm() {
    return api('ppm_list').then(function (r) {
      if (!r || !r.ok || !Array.isArray(r.equipment)) return;
      ppmRows = r.equipment; LS.set('ghq_ppm', ppmRows);
      var sc = $('screen-ppm'); if (sc && sc.classList.contains('active')) renderPPM();
    }).catch(function () {});
  }


  /* ---------- Duty Shift Roster: Admin uploads Excel/CSV (+ PDF); everyone sees PDF, calendar and who is on which shift ---------- */
  var roY = new Date().getFullYear(), roM = new Date().getMonth(), roDay = new Date().getDate(), roInit = false;
  var PALETTE = ['#38bdf8', '#34d399', '#fbbf24', '#c084fc', '#fb7185', '#2dd4bf', '#f97316', '#a3e635'];
  var OFF_CODES = ['WO', 'W/O', 'OFF', 'L', 'H', 'PH', 'CO', 'LV', 'SL', 'CL', 'PL', '-'];
  function isOff(c) { return OFF_CODES.indexOf(c) >= 0; }
  function monthKey() { return roY + '-' + p2(roM + 1); }
  function shiftColor(code) {
    if (isOff(code)) return '#94a3b8';
    var order = shiftsInfo.map(function (x) { return x.code; }), i = order.indexOf(code);
    if (i < 0) { i = 0; for (var k = 0; k < code.length; k++) i += code.charCodeAt(k); }
    return PALETTE[i % PALETTE.length];
  }
  function chip(code, big) {
    var c = shiftColor(code);
    return '<span style="display:inline-block;min-width:' + (big ? 26 : 18) + 'px;text-align:center;padding:' + (big ? '2px 7px' : '0 4px') + ';border-radius:6px;font-weight:800;font-size:' + (big ? '.8rem' : '.62rem') + ';color:#0b0f19;background:' + c + '">' + esc(code) + '</span>';
  }
  function shiftLabel(code) {
    var x = shiftsInfo.filter(function (s) { return s.code === code; })[0];
    return x ? ((x.name || '') + (x.timing ? ' · ' + x.timing : '')) : '';
  }
  function meOf(r) { var n = String(session && session.name || '').toLowerCase(); return r.people.filter(function (pp) { return String(pp.n).toLowerCase() === n; })[0]; }

  function dayOfCell(v) {
    if (typeof v === 'number') {
      if (v >= 1 && v <= 31 && Math.floor(v) === v) return v;
      if (v > 30000) return new Date(Math.round((v - 25569) * 864e5)).getUTCDate();
      return 0;
    }
    var t = String(v).trim(), m = /^(\d{1,2})$/.exec(t);
    if (!m) m = /^(\d{1,2})[-\/ .]([A-Za-z]{3,}|\d{1,2})/.exec(t);
    if (!m) return 0;
    var n = +m[1]; return n >= 1 && n <= 31 ? n : 0;
  }
  function parseRoster(rows) {                           // rows: array of arrays -> {people:[{n, c:[31 codes]}]}
    var hdr = -1, map = null;
    for (var r = 0; r < Math.min(rows.length, 15) && hdr < 0; r++) {
      var mp = {}, cnt = 0;
      (rows[r] || []).forEach(function (v, c) { var d = dayOfCell(v); if (d && !mp[d]) { mp[d] = c; cnt++; } });
      if (cnt >= 25) { hdr = r; map = mp; }
    }
    if (hdr < 0) throw new Error('Day numbers (1, 2, 3 … 31) not found in a header row');
    var minCol = Math.min.apply(null, Object.keys(map).map(function (k) { return map[k]; })), people = [], seen = {};
    for (var i = hdr + 1; i < rows.length; i++) {
      var row = rows[i] || [], name = '';
      for (var c = 0; c < minCol; c++) { var t = String(row[c] === undefined ? '' : row[c]).trim(); if (t && /[A-Za-zऀ-ॿ]/.test(t)) { name = t; break; } }
      if (!name) continue;
      var codes = [], any = false;
      for (var d = 1; d <= 31; d++) {
        var cell = map[d] === undefined ? '' : row[map[d]];
        var code = String(cell === undefined || cell === null ? '' : cell).trim().toUpperCase();
        codes.push(code); if (code) any = true;
      }
      if (!any) continue;
      if (seen[name.toLowerCase()]) continue; seen[name.toLowerCase()] = 1;
      people.push({ n: name, c: codes });
    }
    if (!people.length) throw new Error('No names with shifts found');
    return { people: people };
  }
  function parseCsv(text) {
    var rows = [], row = [], cur = '', q = false;
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    var delim = (text.split('\n')[0].split(';').length > text.split('\n')[0].split(',').length) ? ';' : ',';
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cur); cur = ''; }
      else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (ch !== '\r') cur += ch;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }

  function renderRoster() {
    if (!roInit) { var n = new Date(); roY = n.getFullYear(); roM = n.getMonth(); roDay = n.getDate(); roInit = true; }
    var key = monthKey(), r = roster[key], n = new Date(roY, roM + 1, 0).getDate(), first = new Date(roY, roM, 1).getDay();
    if (roDay > n) roDay = n;
    $('ro-title').textContent = new Date(roY, roM, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    $('ro-sub').textContent = r ? r.people.length + ' people' : 'No roster uploaded for this month';

    // my shift today / selected
    var mine = r && meOf(r), mineBox = $('ro-mine');
    var todayD = new Date(), isCur = todayD.getFullYear() === roY && todayD.getMonth() === roM;
    var mc = mine && isCur ? (mine.c[todayD.getDate() - 1] || '') : '';
    mineBox.innerHTML = mc ? '<div class="sub-section-box" style="padding:8px 12px"><div class="ghq-note" style="margin:0">Your shift today</div><div style="margin-top:4px">' + chip(mc, true) + ' <span style="font-size:.78rem;color:var(--text-muted)">' + esc(shiftLabel(mc)) + '</span></div></div>' : '';

    // PDF
    var pdf = rosterPdf[key], pbox = $('ro-pdf');
    pbox.innerHTML = pdf ? '<div class="sub-section-box" style="padding:10px 12px"><div style="display:flex;gap:8px;align-items:center;justify-content:space-between"><span style="font-size:.82rem;font-weight:700;color:var(--gold-light)"><i class="fa-solid fa-file-pdf"></i> Roster PDF</span>' +
      '<span><button class="ghq-btn ghost" style="width:auto;padding:6px 10px" onclick="GHQ.roTogglePdf()">View</button> <a class="ghq-btn ghost" style="width:auto;padding:6px 10px;text-decoration:none;display:inline-block" target="_blank" rel="noopener" href="https://drive.google.com/file/d/' + esc(pdf.id) + '/view">Open</a></span></div>' +
      '<div id="ro-pdf-frame"></div></div>' : '';

    // calendar
    var g = '';
    for (var i = 0; i < first; i++) g += '<div class="cal-day empty"></div>';
    for (var d = 1; d <= n; d++) {
      var cls = 'cal-day' + (isCur && d === todayD.getDate() ? ' today' : '') + (d === roDay ? ' selected' : '');
      var mycode = mine ? (mine.c[d - 1] || '') : '';
      g += '<div class="' + cls + '" onclick="GHQ.roPick(' + d + ')"><span class="cal-day-num">' + d + '</span>' + (mycode ? chip(mycode, false) : '') + '</div>';
    }
    $('ro-grid').innerHTML = g;

    // selected day: who is on which shift
    var dbox = $('ro-day');
    if (!r) dbox.innerHTML = '<div class="ghq-note">' + (canAdmin() ? 'Upload the roster below.' : 'Roster not uploaded yet — Admin will upload it.') + '</div>';
    else {
      var groups = {}, order = [];
      r.people.forEach(function (pp) { var c = pp.c[roDay - 1] || ''; if (!c) return; if (!groups[c]) { groups[c] = []; order.push(c); } groups[c].push(pp.n); });
      var known = shiftsInfo.map(function (x) { return x.code; });
      order.sort(function (a, b) { var oa = isOff(a) ? 1 : 0, ob = isOff(b) ? 1 : 0; if (oa !== ob) return oa - ob; var ia = known.indexOf(a), ib = known.indexOf(b); if (ia < 0) ia = 99; if (ib < 0) ib = 99; return ia - ib || (a < b ? -1 : 1); });
      var dt = new Date(roY, roM, roDay);
      dbox.innerHTML = '<div class="sub-section-box"><div class="sub-section-header">' + dt.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }) + '</div>' +
        (order.length ? order.map(function (c) {
          return '<div style="display:flex;gap:10px;align-items:flex-start;padding:6px 0;border-bottom:1px dashed rgba(212,175,55,.15)">' + chip(c, true) +
            '<div style="flex:1"><div style="font-size:.7rem;color:var(--text-muted)">' + esc(shiftLabel(c) || (isOff(c) ? 'Off / leave' : '')) + '</div>' +
            '<div style="font-size:.85rem;color:#e2e8f0;font-weight:600">' + groups[c].map(function (x) { return esc(x); }).join(', ') + '</div></div></div>';
        }).join('') : '<div class="ghq-note">No shifts entered for this day.</div>') + '</div>';
    }

    // legend
    var used = {}; if (r) r.people.forEach(function (pp) { pp.c.forEach(function (c) { if (c) used[c] = 1; }); });
    var codes = Object.keys(used);
    $('ro-legend').innerHTML = codes.length ? '<div class="ghq-note" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">' + codes.map(function (c) { return chip(c, false) + ' ' + esc(shiftLabel(c)); }).join(' &nbsp; ') + '</div>' : '';

    // admin tools
    var ab = $('ro-admin');
    ab.innerHTML = !canAdmin() ? '' : '<div class="sub-section-box"><div class="sub-section-header">Admin — ' + esc($('ro-title').textContent) + '</div>' +
      '<div class="ghq-note">1) Download the template, fill names (left) and shift codes (A, A1, B, C, G, WO…) under each date. 2) Upload it here. Uploading again replaces this month.</div>' +
      '<button class="ghq-btn ghost" onclick="GHQ.roTemplate()">Download template (Excel)</button>' +
      '<label class="ghq-lbl">Roster file (.xlsx or .csv)</label><input type="file" id="ro-file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" style="font-size:.75rem;color:var(--text-muted)">' +
      '<button class="ghq-btn" onclick="GHQ.roUpload()">Upload roster</button>' +
      '<label class="ghq-lbl">Roster PDF (for everyone to view)</label><input type="file" id="ro-pdf-file" accept=".pdf,application/pdf" style="font-size:.75rem;color:var(--text-muted)">' +
      '<button class="ghq-btn" onclick="GHQ.roUploadPdf()">Upload PDF</button></div>';
  }
  function canAdmin() { return !!session && session.role === 'admin'; }
  function roMonth(delta) { roM += delta; if (roM < 0) { roM = 11; roY--; } if (roM > 11) { roM = 0; roY++; } roDay = 1; renderRoster(); }
  function roPick(d) { roDay = d; renderRoster(); }
  function roTogglePdf() {
    var pdf = rosterPdf[monthKey()], box = $('ro-pdf-frame'); if (!pdf || !box) return;
    box.innerHTML = box.innerHTML ? '' : '<iframe src="https://drive.google.com/file/d/' + esc(pdf.id) + '/preview" style="width:100%;height:440px;border:0;margin-top:8px;border-radius:8px;background:#fff"></iframe>';
  }
  function roTemplate() {
    var n = new Date(roY, roM + 1, 0).getDate(), H = function (t) { return { v: t, s: 1 }; };
    var head = [H('Name')], wd = ['Day'], WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], cols = [18];
    for (var d = 1; d <= n; d++) { head.push(H(d)); wd.push(WD[new Date(roY, roM, d).getDay()]); cols.push(5); }
    var rows = [head, wd];
    ['Name 1', 'Name 2', 'Name 3'].forEach(function (x) { rows.push([x]); });
    saveBytes('Roster_template_' + monthKey() + '.xlsx', XLSX_MIME, XlsxLite.build([{ name: monthKey(), cols: cols, rows: rows, freeze: { r: 1, c: 1 }, noLogo: true }]));
  }
  function readFile(file, asText) {
    return new Promise(function (res, rej) {
      var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = function () { rej(new Error('Could not read the file')); };
      asText ? fr.readAsText(file) : fr.readAsArrayBuffer(file);
    });
  }
  function roUpload() {
    if (!canAdmin()) { toast('Only Admin can upload the roster'); return; }
    var f = $('ro-file') && $('ro-file').files[0]; if (!f) { toast('Choose the roster file'); return; }
    var isCsv = /\.csv$/i.test(f.name);
    (isCsv ? readFile(f, true).then(parseCsv) : readFile(f, false).then(XlsxRead.parse))
      .then(function (rows) { return parseRoster(rows); })
      .then(function (res) {
        var key = monthKey();
        return commit('roster.set', { month: key, people: res.people }).then(function () { toast('✔ Roster saved: ' + res.people.length + ' people'); renderRoster(); });
      }).catch(function (e) { toast('Roster not saved: ' + (e && e.message || e)); });
  }
  function roUploadPdf() {
    if (!canAdmin()) { toast('Only Admin can upload the PDF'); return; }
    var f = $('ro-pdf-file') && $('ro-pdf-file').files[0]; if (!f) { toast('Choose the PDF file'); return; }
    if (f.size > 6 * 1024 * 1024) { toast('PDF is too big (max 6 MB)'); return; }
    if (LOCAL) { toast('PDF upload needs the server connection'); return; }
    var key = monthKey();
    readFile(f, false).then(function (buf) { return api('roster_pdf', { month: key, b64: toB64(new Uint8Array(buf)) }); })
      .then(function (r) { if (!r.ok) throw new Error(r.error); return commit('roster.pdf', { month: key, id: r.id, name: f.name }); })
      .then(function () { toast('✔ PDF uploaded'); renderRoster(); })
      .catch(function (e) { toast(String(e && e.message) === 'Failed to fetch' ? 'Internet required' : 'PDF not saved: ' + (e && e.message || e)); });
  }
  function pullShifts() {
    return api('shifts_list').then(function (r) {
      if (!r || !r.ok || !Array.isArray(r.shifts)) return;
      shiftsInfo = r.shifts; LS.set('ghq_shifts', shiftsInfo);
      var sc = $('screen-roster'); if (sc && sc.classList.contains('active')) renderRoster();
    }).catch(function () {});
  }

  /* ---------- auto-update: new app files are published to GitHub Pages; the app fetches and runs them (no new APK) ---------- */
  function showUpdateBanner() {
    if ($('ghq-upd')) return;
    var b = document.createElement('div'); b.id = 'ghq-upd'; b.className = 'ghq-upd';
    b.innerHTML = '<i class="fa-solid fa-circle-arrow-up"></i> New version ready — tap to update';
    b.onclick = function () { location.href = 'index.html'; };
    document.body.appendChild(b);
  }
  function checkUpdate() {
    var U = window.GHQ_UPDATE_URL;
    if (!U || !navigator.onLine || !window.GHQ_BUILD) return;
    fetch(U + 'version.json?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (v) {
      var have = (LS.get('ghq_bundle', null) || {}).version || '0';
      if (!v || !v.version || v.version <= window.GHQ_BUILD || v.version <= have || v.version <= BUILD) return;
      return fetch(U + 'bundle.json?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (b) {
        if (b && b.html && b.version === v.version) { LS.set('ghq_bundle', b); showUpdateBanner(); }
      });
    }).catch(function () {});
  }

  /* ---------- public API + boot ---------- */
  window.GHQ = {
    saveReading: saveReading, login: login, logout: logout, syncNow: function () { lastErr = ''; sync().then(function () { toast(lastErr ? 'Sync error: ' + lastErr : feedersInfo.err ? 'Feeders list not loaded: ' + feedersInfo.err : '✔ Synced' + (feedersInfo.n ? ' · ' + feedersInfo.n + ' feeders' : '')); var b = $('bk-status'); if (b) renderBackup(); }); },
    monthlyReport: monthlyReport, addFeeders: addFeeders, checkServer: checkServer, renderEntries: renderEntries, saveUser: saveUser, editUser: editUser, removeUser: removeUser,
    roMonth: roMonth, roPick: roPick, roTogglePdf: roTogglePdf, roTemplate: roTemplate, roUpload: roUpload, roUploadPdf: roUploadPdf, _parseRoster: parseRoster, _parseCsv: parseCsv, _clShow: clShow, _lastEvent: function () { return events[events.length - 1] || queue[queue.length - 1] || null; }, clSet: clSet, clAllOk: clAllOk, clSubmit: clSubmit, clView: clView, _ppmTest: function (rows, evs, items) { ppmRows = rows; ppmLog = {}; ppmLogId = {}; evs.forEach(apply); clItems = items; var out = {}; rows.forEach(function (e) { var ev = ppmEval(e); out[e.name] = { dates: ev.dates, wait: ev.wait, last: lastDone(e), next: ymdOf(nextDue(e)) }; }); return out; }, _astTest: function (items) { assets = { cats: ['Electrical', 'HVAC', 'Plumbing', 'Other'], items: items, canEdit: true }; renderAssets(); }, astScan: astScan, astImport: astImport, astFind: astFind, astForm: astForm, astSave: astSave, astShow: astShow, astOpen: astOpen, astSearch: astSearch, astLabel: astLabel, astLabels: astLabels, _repTest: function (t, st, en, cells, edit) { repExtra = {}; repCtx = { no: 'TEST', type: t, start: st, end: en, status: 'Pending Engineer', can: true, edit: !!edit, cells: cells }; rform(); }, repGen: repGen, repOpen: repOpen, repClose: repClose, repSave: repSave, repAct: repAct, repAddRow: repAddRow, repDl: repDl, repRegen: repRegen, dgStart: dgStart, dgStartSubmit: dgStartSubmit, dgOpen: dgOpen, dgSet: dgSet, dgSubmit: dgSubmit, dgAct: dgAct, _dgCalc: dgCalc, clAct: clAct, clEdit: clEdit, ppmPdf: ppmPdf, ppmAdd: ppmAdd, ppmAddSubmit: ppmAddSubmit, ppmOpen: ppmOpen, ppmDone: ppmDone, closeModal: closeModal, backupNow: backupNow, downloadJSON: downloadJSON, downloadReadings: downloadReadings, restore: restore,
    _buildSheets: buildPanelSheets, _monthTasks: monthTasks, _state: function () { return { session: session, queue: queue.length, events: events.length }; }
  };

  injectPhotoFields(); injectReportBox(); checkUpdate(); window.__GHQ_BOOTED = true;
  idbOpen().then(qAll).then(function (q) {
    queue = q;
    if (NOT_CONFIGURED) { showLogin(''); return; }
    if (LOCAL) { session = { name: 'Local Admin', pin: '', role: 'admin', work: 'Supervisor' }; start(); return; }
    if (session) start(); else showLogin('');
  });
})();
