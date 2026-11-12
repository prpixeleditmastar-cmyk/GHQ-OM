/* GHQ O&M — data layer: login, offline queue, Drive sync, photos, backup/restore.
   Loaded after the original dashboard script; it replaces the demo "alert" actions with real saving. */
(function () {
  'use strict';
  var CFG = window.GHQ_CONFIG || {};
  var API = (CFG.API_URL && !/PASTE/.test(CFG.API_URL)) ? CFG.API_URL : '';
  var LOCAL = !API;
  var BUILD = window.__GHQ_CACHED || window.GHQ_BUILD || 'dev';
  var VERSION = 'v5 · build ' + BUILD;
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
  var ppmRows = LS.get('ghq_ppm', []), ppmLog = {};
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
    ppmLog = {}; roster = {}; rosterPdf = {};
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
      var sub = $('top-bar-sub'), titles = { 'screen-entries': 'My Entries', 'screen-users': 'Admin · Users', 'screen-backup': 'Admin · Backup & Restore' };
      if (titles[id] && sub) sub.textContent = titles[id];
      if (id === 'screen-ppm') renderPPM();
      if (id === 'screen-roster') renderRoster();
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
    return pushAll().then(pullFeeders).then(pullPpm).then(pullShifts).then(pullAll).then(function () { lastErr = ''; lastSyncAt = Date.now(); })
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
  function doneDates(e) { var a = (ppmLog[eqKey(e)] || []).slice(); if (e.last) a.push(e.last); return a.sort(); }
  function lastDone(e) { var a = doneDates(e); return a.length ? a[a.length - 1] : ''; }
  function nextDue(e) { var l = lastDone(e); return l ? addPeriod(parseYmd(l), e.freq) : parseYmd(ymdOf(new Date())); }
  function monthTasks(y, mo) {                         // {day: [{i, e, kind:'due'|'done'}]}
    var from = new Date(y, mo, 1, 12), to = new Date(y, mo + 1, 0, 12), out = {};
    function put(day, i, e, kind) { (out[day] = out[day] || []).push({ i: i, e: e, kind: kind }); }
    ppmRows.forEach(function (e, i) {
      var seenD = {};
      doneDates(e).forEach(function (k) { var d = parseYmd(k); if (d >= from && d <= to && !seenD[k]) { seenD[k] = 1; put(d.getDate(), i, e, 'done'); } });
      var d = nextDue(e), g = 0;
      while (d <= to && g++ < 500) { if (d >= from) put(d.getDate(), i, e, 'due'); d = addPeriod(d, e.freq); }
    });
    return out;
  }
  function fillScheduled(y, mo) {
    Object.keys(scheduledTasks).forEach(function (k) { delete scheduledTasks[k]; });
    ppmMonth = monthTasks(y, mo);
    Object.keys(ppmMonth).forEach(function (day) {
      var L = ppmMonth[day], due = L.filter(function (t) { return t.kind === 'due'; }).length, done = L.length - due;
      var has = function (c) { return L.some(function (t) { return t.e.cat === c; }); };
      scheduledTasks[day] = { count: due ? due + (due > 1 ? ' Tasks' : ' Task') + ' Due' + (done ? ' · ' + done + ' Done' : '') : done + ' Done', elec: has('elec'), hvac: has('hvac'), plumb: has('plumb') };
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
    return '<div class="op-item-card"><div class="op-item-top"><span class="tag-badge tag-pm">' + esc(e.freq) + ' PM</span>' + st + '</div>' +
      '<div class="op-item-title">' + esc(e.name) + '</div><div class="op-item-desc">' + esc(e.loc || '') + (e.check && e.check.length ? ' · ' + e.check.length + ' checklist points' : '') + '</div>' +
      '<div class="op-item-foot"><span><i class="fa-solid fa-user-gear"></i> ' + esc(e.team || '—') + '</span>' +
      '<button class="btn-gold-solid" onclick="GHQ.ppmOpen(' + i + ')">Checklist / Done</button></div></div>';
  }
  function renderDayList() {
    var ban = $('cal-selected-banner'); if (!ban) return;
    var box = $('ppm-day-list');
    if (!box) { box = document.createElement('div'); box.id = 'ppm-day-list'; box.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:10px'; ban.insertAdjacentElement('afterend', box); }
    var L = (ppmMonth || {})[selectedCalDay] || [], y = +$('cal-year-select').value, mo = +$('cal-month-select').value;
    if (!ppmRows.length) { box.innerHTML = '<div class="ghq-note">No equipment yet. ' + (canHold() ? 'Tap “Add equipment” above, or fill the PPM sheet in Google Sheets.' : 'Ask a Supervisor / Engineer to add equipment.') + '</div>'; return; }
    box.innerHTML = L.length ? L.map(function (t) { return ppmCard(t.i, t.e, t.kind, new Date(y, mo, selectedCalDay, 12)); }).join('') : '<div class="ghq-note">No PPM on this day.</div>';
  }
  function renderCatLists() {
    ['elec', 'hvac', 'plumb'].forEach(function (c) {
      var el = $('tab-ppm-' + c); if (!el) return;
      var list = ppmRows.map(function (e, i) { return { e: e, i: i }; }).filter(function (x) { return x.e.cat === c; });
      list.sort(function (a, b) { return nextDue(a.e) - nextDue(b.e); });
      el.innerHTML = '<div class="section-title"><span>' + CATN[c] + ' PM Schedules</span><span style="font-size:0.72rem; color:var(--cyan)">' + list.length + ' equipment</span></div>' +
        (list.length ? list.map(function (x) { return ppmCard(x.i, x.e, 'due', nextDue(x.e)); }).join('') : '<div class="ghq-note">No ' + CATN[c] + ' equipment yet.</div>');
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
    injectPpmAdd(); renderCalendar(); renderCatLists();
  }
  window.updateMonthlyTotals = function (month, year) {
    var mt = ppmMonth || monthTasks(year, month), c = { elec: [0, 0], hvac: [0, 0], plumb: [0, 0] }, tot = 0;
    Object.keys(mt).forEach(function (d) { mt[d].forEach(function (t) { c[t.e.cat][t.kind === 'done' ? 0 : 1]++; tot++; }); });
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
  function closeModal() { var o = $('ghq-ov'); if (o) o.remove(); }
  function ppmAdd() {
    if (!canHold()) { toast('Only Supervisor / Engineer / Admin can add equipment'); return; }
    modal('<h3 class="ghq-h3">Add equipment (PPM)</h3>' +
      '<label class="ghq-lbl">Category</label><select id="pe-cat" class="cal-select" style="width:100%"><option>Electrical</option><option>HVAC</option><option>Plumbing</option></select>' +
      '<label class="ghq-lbl">Equipment name *</label><input id="pe-name" class="ghq-input" placeholder="e.g. 11kV VCB Panel TR-01">' +
      '<label class="ghq-lbl">Location</label><input id="pe-loc" class="ghq-input" placeholder="e.g. Main Substation">' +
      '<div class="ghq-grid2"><div><label class="ghq-lbl">Frequency</label><select id="pe-freq" class="cal-select" style="width:100%"><option>Weekly</option><option>Fortnightly</option><option selected>Monthly</option><option>Quarterly</option><option>Half-yearly</option><option>Yearly</option></select></div>' +
      '<div><label class="ghq-lbl">Last done date</label><input id="pe-last" type="date" class="ghq-input" max="' + ymdOf(new Date()) + '"></div></div>' +
      '<label class="ghq-lbl">Team / Vendor</label><input id="pe-team" class="ghq-input" placeholder="e.g. Electrical team / ABC Services">' +
      '<label class="ghq-lbl">Checklist — one point per line</label><textarea id="pe-check" class="ghq-input" rows="4" placeholder="Dust cleaning&#10;Terminal tightening"></textarea>' +
      '<div class="ghq-grid2"><button class="ghq-btn ghost" onclick="GHQ.closeModal()">Cancel</button><button class="ghq-btn" onclick="GHQ.ppmAddSubmit()">Save</button></div>');
  }
  function ppmAddSubmit() {
    var e = { cat: $('pe-cat').value, name: $('pe-name').value.trim(), loc: $('pe-loc').value.trim(), freq: $('pe-freq').value, last: $('pe-last').value, team: $('pe-team').value.trim(), check: $('pe-check').value.trim() };
    if (!e.name) { toast('Enter the equipment name'); return; }
    if (LOCAL) {
      ppmRows.push({ cat: { Electrical: 'elec', HVAC: 'hvac', Plumbing: 'plumb' }[e.cat], name: e.name, loc: e.loc, freq: e.freq, last: e.last, team: e.team, check: e.check.split('\n').map(function (x) { return x.trim(); }).filter(Boolean) });
      LS.set('ghq_ppm', ppmRows); closeModal(); renderPPM(); toast('✔ Equipment added'); return;
    }
    api('ppm_add', { e: e }).then(function (r) { if (!r.ok) throw new Error(r.error === 'auth' ? 'Not allowed' : r.error); return pullPpm(); })
      .then(function () { closeModal(); renderPPM(); toast('✔ Equipment added'); })
      .catch(function (err) { toast(String(err && err.message) === 'Failed to fetch' ? 'Internet required' : 'Error: ' + (err && err.message)); });
  }
  function ppmOpen(i) {
    var e = ppmRows[i]; if (!e) return;
    var chk = (e.check || []).map(function (c, k) { return '<label style="display:flex;gap:8px;align-items:flex-start;font-size:.8rem;color:#e2e8f0;margin:4px 0"><input type="checkbox" style="margin-top:3px"> ' + esc(c) + '</label>'; }).join('');
    modal('<h3 class="ghq-h3">' + esc(e.name) + '</h3><div class="ghq-note">' + esc(e.loc || '') + ' · ' + esc(e.freq) + ' · ' + esc(e.team || '—') + '<br>Last done: ' + (lastDone(e) ? fmtDate(lastDone(e), '—') : '—') + ' · Next due: ' + fmtDate(ymdOf(nextDue(e)), '—') + '</div>' +
      (chk ? '<div class="sub-section-header" style="margin-top:8px">Checklist</div>' + chk : '<div class="ghq-note">No checklist added for this equipment.</div>') +
      '<label class="ghq-lbl" style="margin-top:8px">Done on</label><input id="pd-date" type="date" class="ghq-input" value="' + ymdOf(new Date()) + '" max="' + ymdOf(new Date()) + '">' +
      '<label class="ghq-lbl">Note (optional)</label><input id="pd-note" class="ghq-input" placeholder="Remarks">' +
      '<div class="ghq-grid2" style="margin-top:8px"><button class="ghq-btn ghost" onclick="GHQ.closeModal()">Close</button><button class="ghq-btn" onclick="GHQ.ppmDone(' + i + ')">Mark done</button></div>');
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
    saveBytes('Roster_template_' + monthKey() + '.xlsx', XLSX_MIME, XlsxLite.build([{ name: monthKey(), cols: cols, rows: rows, freeze: { r: 1, c: 1 } }]));
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
    roMonth: roMonth, roPick: roPick, roTogglePdf: roTogglePdf, roTemplate: roTemplate, roUpload: roUpload, roUploadPdf: roUploadPdf, _parseRoster: parseRoster, _parseCsv: parseCsv, ppmAdd: ppmAdd, ppmAddSubmit: ppmAddSubmit, ppmOpen: ppmOpen, ppmDone: ppmDone, closeModal: closeModal, backupNow: backupNow, downloadJSON: downloadJSON, downloadReadings: downloadReadings, restore: restore,
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
