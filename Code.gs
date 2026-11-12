/**
 * GHQ O&M — Google Apps Script backend
 * Data  -> Google Sheet "GHQ O&M Data" (in your Drive)
 * Photos-> Drive folder "GHQ_OM_Photos"
 * Backup-> Drive folder "GHQ_OM_Backups" (nightly copy of the Sheet, last 30 kept)
 *
 * ONE-TIME SETUP: run setup() once, then Deploy > New deployment > Web app
 * (Execute as: Me, Who has access: Anyone). See README.
 */
const PROP = PropertiesService.getScriptProperties();
const KEEP_BACKUPS = 30;
const TZ = 'Asia/Kolkata';
const MAIN_ENABLED = false;                        // main-sheet copy is prepared but switched OFF for now
const ROLES = ['Admin', 'Engineer', 'RIL', 'PM', 'APM', 'Supervisor', 'Staff'];
const DOWNLOAD_ROLES = ['admin', 'engineer', 'ril', 'pm', 'apm'];     // may download Excel files
function isSup_(u) { return u.role === 'supervisor' || String(u.work).toLowerCase() === 'supervisor'; }
function canHold_(u) { return u.role === 'admin' || u.role === 'engineer' || isSup_(u); }      // e-ticket hold + add PPM equipment
const SHEETS = {
  Users:    ['Name', 'PIN', 'Role', 'Work', 'Active'],
  Entries:  ['Seq', 'ID', 'Time', 'User', 'Type', 'Data'],
  Readings: ['Time', 'User', 'Kind', 'Panel', 'Feeder', 'Previous', 'Current', 'Consumption', 'Main sheet', 'Entry ID'],
  Tickets:  ['Time', 'User', 'Action', 'Ticket ID', 'Title', 'Dept', 'Priority', 'Location', 'Tag', 'Technician', 'Details', 'Photo'],
  AMC:      ['Time', 'User', 'Action', 'AMC ID', 'Vendor', 'System', 'Start', 'End', 'Extra'],
  Feeders:  ['Type', 'Panel', 'Feeder', 'Active', 'Sheet Tab', 'Sheet Heading'],   // master list of meters shown in the app's Readings page (E/F optional: only if names differ from the main sheet)
  PPM:      ['Category', 'Equipment', 'Location', 'Frequency', 'Last done', 'Team / Vendor', 'Checklist', 'Active'],
  'PPM Log': ['Time', 'User', 'Equipment', 'Done date', 'Note'],
  MainSheets: ['Month', 'Sheet link', 'Note']          // which MAIN workbook (per month) receives the readings
};
const MAIN_SEED = [['2026-12', 'https://docs.google.com/spreadsheets/d/14Giibij5NlJq5t23yygz8Xoq4-ySC72nIECf6rRj6EY/edit', 'Dec-26 main sheet (30-Nov base row + December)']];

// Starting list (same panels/feeders as the original design). Only written when the Feeders sheet is empty.
const DEFAULT_FEEDERS = [["Electrical","Main Substation PMCC","Incomer 1 (11kV Grid)"],["Electrical","Main Substation PMCC","Incomer 2 (Bus Coupler)"],["Electrical","Main Substation PMCC","DG-01 Backup Feeder"],["Electrical","Main Substation PMCC","DG-02 Backup Feeder"],["Electrical","GHQ Main LT Panel","Floor 1-3 Lighting & Power"],["Electrical","GHQ Main LT Panel","Floor 4-6 Lighting & Power"],["Electrical","GHQ Main LT Panel","Elevators & Lift Bank Feeder"],["Electrical","GHQ Main LT Panel","Basement Parking & Sump Pumps"],["Electrical","Essential DG Sync Panel","Life Safety & Fire Pump Feeder"],["Electrical","Essential DG Sync Panel","Emergency Staircase Lighting"],["Electrical","NMAEYC Floor Distribution Panel","Main Office Incomer Feeder"],["Electrical","NMAEYC Floor Distribution Panel","Server PAC & Critical UPS Load"],["Electrical","HVAC Plant LT Panel","Chiller-01 Compressor Feeder"],["Electrical","HVAC Plant LT Panel","Chiller-02 Compressor Feeder"],["Electrical","HVAC Plant LT Panel","Primary & Secondary Pump Bank"],["Electrical","HVAC Plant LT Panel","Cooling Tower CT Fan Bank"],["Water","GHQ Main Water Header","DWS Domestic Water Header"],["Water","GHQ Main Water Header","FWS Flushing Water Header"],["Water","NMAEYC Sub-Header Panel","NMAEYC DWS Flow Meter"],["Water","NMAEYC Sub-Header Panel","NMAEYC FWS Flow Meter"],["Water","STP / WTP Treatment Plant","Raw Water Inflow Meter"],["Water","STP / WTP Treatment Plant","STP Treated Water Outflow"],["Water","Cooling Tower Makeup Panel","CT-01 & CT-02 Makeup Water"],["BTU","Central Chiller Plant Header","Chiller Plant Main BTU Header"],["BTU","Central Chiller Plant Header","Chiller-01 Dedicated Evaporator Loop"],["BTU","GHQ Office Tower BTU Panel","Floors 1-3 AHU BTU Line"],["BTU","GHQ Office Tower BTU Panel","Floors 4-6 AHU BTU Line"],["BTU","NMAEYC BTU Meter Panel","NMAEYC Tenant Primary Loop"],["BTU","Server PAC Chilled Loop","PAC High-Density Data Hall"]];

/* ---------- one-time setup ---------- */
function setup() {
  let ss;
  const id = PROP.getProperty('SHEET_ID');
  if (id) ss = SpreadsheetApp.openById(id);
  else { ss = SpreadsheetApp.create('GHQ O&M Data'); PROP.setProperty('SHEET_ID', ss.getId()); }

  Object.keys(SHEETS).forEach(function (name) {
    let sh = ss.getSheetByName(name) || ss.insertSheet(name);
    const hdr = SHEETS[name];
    if (sh.getLastColumn() > hdr.length) sh.getRange(1, hdr.length + 1, 1, sh.getLastColumn() - hdr.length).clearContent();   // drop retired columns
    sh.getRange(1, 1, 1, hdr.length).setValues([hdr]).setFontWeight('bold').setBackground('#f3e5ab');
    sh.setFrozenRows(1);
  });
  const def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);

  const users = ss.getSheetByName('Users');
  users.getRange('B:B').setNumberFormat('@');           // keep PINs as text (leading zeros)
  if (users.getLastRow() < 2) users.appendRow(['Parashram', '1234', 'admin', 'Supervisor', true]);

  users.getRange('C2:C500').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(ROLES, true).setAllowInvalid(true).build());
  const pp = ss.getSheetByName('PPM');
  pp.getRange('A2:A1000').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['Electrical', 'HVAC', 'Plumbing'], true).build());
  pp.getRange('D2:D1000').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['Weekly', 'Fortnightly', 'Monthly', 'Quarterly', 'Half-yearly', 'Yearly'], true).build());
  pp.getRange('H2:H1000').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['Yes', 'No'], true).setAllowInvalid(true).build());
  pp.getRange('E2:E1000').setNumberFormat('yyyy-mm-dd');
  pp.setColumnWidths(1, 1, 90); pp.setColumnWidths(2, 2, 240); pp.setColumnWidths(4, 3, 120); pp.setColumnWidths(7, 1, 420);

  const ms = ss.getSheetByName('MainSheets');
  ms.getRange('A:A').setNumberFormat('@');              // month as text: 2026-12
  if (ms.getLastRow() < 2) ms.getRange(2, 1, MAIN_SEED.length, 3).setValues(MAIN_SEED);
  ms.setColumnWidths(1, 1, 80); ms.setColumnWidths(2, 1, 520);

  if (!PROP.getProperty('PHOTO_FOLDER')) PROP.setProperty('PHOTO_FOLDER', DriveApp.createFolder('GHQ_OM_Photos').getId());
  if (!PROP.getProperty('BACKUP_FOLDER')) PROP.setProperty('BACKUP_FOLDER', DriveApp.createFolder('GHQ_OM_Backups').getId());

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'nightlyBackup') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('nightlyBackup').timeBased().everyDays(1).atHour(2).inTimezone(TZ).create();

  const fs = ss.getSheetByName('Feeders');
  fs.getRange('A2:A1000').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['Electrical', 'Water', 'BTU'], true).build());
  // Active column: dropdown Yes / No — a blank cell counts as Yes. (An earlier version used checkboxes that hid new rows; convert them.)
  const act = fs.getRange('D2:D1000');
  act.clearDataValidations();
  const lastF = fs.getLastRow();
  if (lastF >= 2) {
    const cur = fs.getRange(2, 1, lastF - 1, 4).getValues().map(function (r) {
      if (!String(r[1]).trim() && !String(r[2]).trim()) return [''];
      const v = String(r[3]).trim().toLowerCase();
      return [(v === 'no' || v === 'n' || v === 'inactive') ? 'No' : 'Yes'];
    });
    fs.getRange(2, 4, lastF - 1, 1).setValues(cur);
  }
  act.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['Yes', 'No'], true).setAllowInvalid(true).build());
  if (fs.getLastRow() < 2) {
    fs.getRange(2, 1, DEFAULT_FEEDERS.length, 3).setValues(DEFAULT_FEEDERS);
    fs.getRange(2, 4, DEFAULT_FEEDERS.length, 1).setValue('Yes');
  }
  fs.setColumnWidths(1, 1, 90); fs.setColumnWidths(2, 2, 300);

  Logger.log('READY. Sheet: ' + ss.getUrl() + '  | Default admin: Parashram / PIN 1234 (change it in the app!)');
}

/* ---------- web entry points ---------- */
function doGet() {
  return ContentService.createTextOutput('GHQ O&M API is running.');
}

function doPost(e) {
  let out;
  try {
    const req = JSON.parse(e.postData.contents);
    out = route_(req);
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function route_(req) {
  if (req.action === 'ping') return { ok: true, pong: true, ready: !!PROP.getProperty('SHEET_ID') };   // no login needed: connection check
  if (req.action === 'users_public') return { ok: true, users: activeUsers_().map(function (u) { return u.name; }) };

  const user = authUser_(req.name, req.pin);
  if (!user) return { ok: false, error: 'auth' };

  switch (req.action) {
    case 'login':       return { ok: true, name: user.name, role: user.role, work: user.work, canDownload: DOWNLOAD_ROLES.indexOf(user.role) >= 0, canHold: canHold_(user) };
    case 'push':        return push_(user, req);
    case 'pull':        return pull_(Number(req.since) || 0);
    case 'feeders':     return { ok: true, feeders: feeders_() };
    case 'users_list':  requireAdmin_(user); return { ok: true, users: listUsers_() };
    case 'user_save':   requireAdmin_(user); return saveUser_(req.u);
    case 'user_delete': requireAdmin_(user); return deleteUser_(user, req.target);
    case 'feeder_add':  requireAdmin_(user); return addFeeders_(req);
    case 'ppm_list':    return { ok: true, equipment: ppmList_() };
    case 'ppm_add':     if (!canHold_(user)) throw new Error('Only Supervisor / Engineer / Admin can add equipment'); return ppmAdd_(req);
    case 'prev_reading': return prevReading_(req);
    case 'main_resync': requireAdmin_(user); return mainResync_();
    case 'export_main': return exportMain_(req);
    case 'backup_now':  requireAdmin_(user); return { ok: true, file: backupNow_() };
    default:            return { ok: false, error: 'unknown action' };
  }
}

/* ---------- users / auth ---------- */
function sheet_(name) { return SpreadsheetApp.openById(PROP.getProperty('SHEET_ID')).getSheetByName(name); }

function allUsers_() {
  const sh = sheet_('Users');
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, 5).getValues().map(function (r, i) {
    return { row: i + 2, name: String(r[0]).trim(), pin: String(r[1]).trim(), role: String(r[2] || 'staff').toLowerCase(),
             work: String(r[3] || ''), active: !(r[4] === false || String(r[4]).toLowerCase() === 'false') };
  }).filter(function (u) { return u.name; });
}
function activeUsers_() { return allUsers_().filter(function (u) { return u.active; }); }

function authUser_(name, pin) {
  if (!name || pin === undefined || pin === null) return null;
  const n = String(name).trim().toLowerCase();
  const found = activeUsers_().filter(function (u) { return u.name.toLowerCase() === n && u.pin === String(pin).trim(); });
  return found.length ? found[0] : null;
}
function requireAdmin_(user) { if (user.role !== 'admin') throw new Error('admin only'); }

function listUsers_() {
  return allUsers_().map(function (u) { return { name: u.name, role: u.role, work: u.work, active: u.active }; });
}

function saveUser_(u) {
  if (!u || !u.name) throw new Error('name required');
  const name = String(u.name).trim();
  const role = ROLES.map(function (r) { return r.toLowerCase(); }).indexOf(String(u.role || '').toLowerCase()) >= 0 ? String(u.role).toLowerCase() : 'staff';
  const sh = sheet_('Users');
  const existing = allUsers_().filter(function (x) { return x.name.toLowerCase() === name.toLowerCase(); })[0];
  if (existing) {
    if (u.pin) sh.getRange(existing.row, 2).setNumberFormat('@').setValue(String(u.pin));
    sh.getRange(existing.row, 3, 1, 3).setValues([[role, u.work || existing.work, true]]);
  } else {
    if (!u.pin) throw new Error('PIN required for new user');
    const row = sh.getLastRow() + 1;
    sh.getRange(row, 2).setNumberFormat('@');
    sh.getRange(row, 1, 1, 5).setValues([[name, String(u.pin), role, u.work || '', true]]);
  }
  return { ok: true };
}

function deleteUser_(me, target) {
  const t = allUsers_().filter(function (x) { return x.name.toLowerCase() === String(target).trim().toLowerCase(); })[0];
  if (!t) throw new Error('user not found');
  if (t.name.toLowerCase() === me.name.toLowerCase()) throw new Error('cannot remove yourself');
  sheet_('Users').getRange(t.row, 5).setValue(false);   // soft delete — history keeps the name
  return { ok: true };
}

/* ---------- feeder master list (edit the 'Feeders' sheet — no app update needed) ---------- */
function feeders_() {
  const sh = sheet_('Feeders');
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const out = [];
  sh.getRange(2, 1, n, 4).getValues().forEach(function (r) {
    const t = String(r[0]).trim().toLowerCase(), panel = String(r[1]).trim(), feeder = String(r[2]).trim();
    const flag = String(r[3]).trim().toLowerCase();
    const active = !(flag === 'no' || flag === 'n' || flag === 'inactive');   // blank / Yes / old checkbox = active
    const type = t.indexOf('e') === 0 ? 'elec' : t.indexOf('w') === 0 ? 'water' : t.indexOf('b') === 0 ? 'btu' : '';
    if (type && panel && feeder && active) out.push({ type: type, panel: panel, feeder: feeder });
  });
  return out;
}

/* Admin adds a new panel / feeders from the app -> appended to the Feeders sheet */
function addFeeders_(req) {
  const T = { electrical: 'Electrical', water: 'Water', btu: 'BTU' }[String(req.type || '').trim().toLowerCase()];
  if (!T) throw new Error('Type must be Electrical, Water or BTU');
  const panel = String(req.panel || '').trim();
  if (!panel) throw new Error('Panel name is required');
  const names = (req.feeders || []).map(function (x) { return String(x).trim(); }).filter(function (x) { return x; });
  if (!names.length) throw new Error('Enter at least one feeder');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_('Feeders');
    const last = sh.getLastRow();
    const have = {};
    if (last > 1) sh.getRange(2, 1, last - 1, 3).getValues().forEach(function (r) {
      have[[r[0], r[1], r[2]].map(function (v) { return String(v).trim().toLowerCase(); }).join('|')] = 1;
    });
    const rows = [], skipped = [];
    names.forEach(function (n) {
      const k = [T, panel, n].map(function (v) { return v.toLowerCase(); }).join('|');
      if (have[k]) { skipped.push(n); return; }
      have[k] = 1; rows.push([T, panel, n, 'Yes']);
    });
    if (rows.length) sh.getRange(last + 1, 1, rows.length, 4).setValues(rows);
    return { ok: true, added: rows.length, skipped: skipped };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- entries ---------- */
function push_(user, req) {
  const lock = LockService.getScriptLock();
  lock.waitLock(28000);
  const jobs = [];                                       // readings to copy into the main sheet (after the lock is released)
  let accepted = [];
  try {
    const sh = sheet_('Entries');
    const last = sh.getLastRow();
    const known = {};
    if (last > 1) sh.getRange(2, 2, last - 1, 1).getValues().forEach(function (r) { known[r[0]] = 1; });

    const restore = !!req.restore && user.role === 'admin';
    const rows = [], flat = { Readings: [], Tickets: [], AMC: [], 'PPM Log': [] };
    let seq = last;                                      // row r has seq r-1; next row = last+1

    (req.events || []).forEach(function (ev) {
      if (!ev || !ev.id) return;
      if (known[ev.id]) { accepted.push(ev.id); return; }
      const type = String(ev.type || '');
      if (/^amc\./.test(type) && user.role !== 'admin' && !isSup_(user)) return;   // not accepted
      if (type === 'ticket.hold' && !canHold_(user) && !(req.restore && user.role === 'admin')) return;   // only Supervisor / Engineer / Admin
      const who = restore ? (ev.user || user.name) : user.name;
      // keep the time the entry was made on the phone (may have been offline); ignore bad / future clocks
      const t0 = new Date(ev.ts).getTime();
      const ts = (!isNaN(t0) && t0 <= Date.now() + 5 * 60000) ? new Date(t0).toISOString() : new Date().toISOString();
      const d = ev.d || {};
      stripPhotos_(d, ev.id, who);
      rows.push([seq++, ev.id, ts, who, type, JSON.stringify(d)]);
      known[ev.id] = 1;
      accepted.push(ev.id);
      addFlat_(flat, ts, who, type, d, ev.id, restore);
      if (MAIN_ENABLED && type === 'reading' && !restore) jobs.push({ ts: ts, d: d });
    });

    if (rows.length) sh.getRange(last + 1, 1, rows.length, 6).setValues(rows);
    let readStart = 0;
    Object.keys(flat).forEach(function (name) {
      if (flat[name].length) {
        const s = sheet_(name);
        const r0 = s.getLastRow() + 1;
        if (name === 'Readings') readStart = r0;
        s.getRange(r0, 1, flat[name].length, flat[name][0].length).setValues(flat[name]);
      }
    });
    jobs.forEach(function (j, i) { j.row = readStart + i; });
  } finally {
    lock.releaseLock();
  }

  // copy new readings into the MAIN sheet; a failure here never loses the reading (it stays in Readings, status shows why)
  if (jobs.length) {
    const ctx = {};
    const sr = sheet_('Readings');
    jobs.forEach(function (j) {
      let st;
      try { st = writeMain_(ctx, j.d.panel, j.d.feeder, ymd_(new Date(j.ts), TZ), j.d.value); }
      catch (err) { st = 'Error: ' + String(err && err.message || err).slice(0, 120); }
      try { sr.getRange(j.row, 9).setValue(st); } catch (e2) {}
    });
  }
  return { ok: true, accepted: accepted };
}

function pull_(since) {
  const sh = sheet_('Entries');
  const last = sh.getLastRow();
  const first = since + 2;                               // seq s lives in row s+1
  if (last < first) return { ok: true, events: [], more: false, last: Math.max(last - 1, 0) };
  const n = Math.min(last - first + 1, 400);
  const out = sh.getRange(first, 1, n, 6).getValues().map(function (r) {
    let d = {}; try { d = JSON.parse(r[5]); } catch (e) {}
    return { seq: Number(r[0]), id: r[1], ts: toIso_(r[2]), user: r[3], type: r[4], d: d };
  });
  return { ok: true, events: out, more: first + n - 1 < last, last: last - 1 };
}
function toIso_(v) { return (v instanceof Date) ? v.toISOString() : String(v); }

function addFlat_(flat, ts, who, type, d, id, restore) {
  const t = Utilities.formatDate(new Date(ts), TZ, 'yyyy-MM-dd HH:mm');
  if (type === 'reading') {
    flat.Readings.push([t, who, d.kind, d.panel, d.feeder, d.prev, d.value, d.consumption, !MAIN_ENABLED ? '' : (restore ? 'Skipped (restore)' : 'Pending'), id || '']);
  } else if (type === 'ticket.create' && d.ticket) {
    const k = d.ticket;
    flat.Tickets.push([t, who, 'created', k.id, k.title, k.dept, k.priority, k.loc, k.tag, k.tech, k.desc, k.photo || '']);
  } else if (type === 'ticket.close') {
    flat.Tickets.push([t, who, 'closed', d.id, '', '', '', '', '', '', d.notes || '', d.photo || '']);
  } else if (type === 'ticket.hold') {
    flat.Tickets.push([t, who, 'hold', d.id, '', '', '', '', '', '', 'Until ' + d.until + ' — ' + (d.reason || ''), '']);
  } else if (type === 'amc.create' && d.amc) {
    flat.AMC.push([t, who, 'created', d.amc.id, d.amc.vendor, d.amc.system, d.amc.start, d.amc.end, d.amc.scope || '']);
  } else if (type === 'ppm.done') {
    flat['PPM Log'].push([t, who, d.eq, d.date, d.note || '']);
  } else if (type === 'amc.renew') {
    flat.AMC.push([t, who, 'renewed', d.id, '', '', d.start, d.end, d.po || '']);
  }
}

/* Replace any inline base64 image in d with a Drive link (works on nested objects) */
function stripPhotos_(obj, id, who) {
  Object.keys(obj).forEach(function (k) {
    const v = obj[k];
    if (typeof v === 'string' && v.indexOf('data:image/') === 0) obj[k] = savePhoto_(v, id, who);
    else if (v && typeof v === 'object') stripPhotos_(v, id, who);
  });
}

function savePhoto_(dataUrl, id, who) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return '';
  const mime = dataUrl.substring(5, dataUrl.indexOf(';')) || 'image/jpeg';
  const blob = Utilities.newBlob(Utilities.base64Decode(dataUrl.substring(comma + 1)), mime,
    Utilities.formatDate(new Date(), TZ, 'yyyyMMdd_HHmmss') + '_' + String(who).replace(/\W+/g, '') + '_' + id + '.jpg');
  const f = DriveApp.getFolderById(PROP.getProperty('PHOTO_FOLDER')).createFile(blob);
  f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);   // unguessable link, needed so every staff phone can show it
  return 'https://drive.google.com/thumbnail?id=' + f.getId() + '&sz=w1000';
}

/* ---------- backup ---------- */
function backupNow_() {
  const ss = SpreadsheetApp.openById(PROP.getProperty('SHEET_ID'));
  const folder = DriveApp.getFolderById(PROP.getProperty('BACKUP_FOLDER'));
  const name = 'GHQ_OM_Backup_' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd_HHmm');
  DriveApp.getFileById(ss.getId()).makeCopy(name, folder);

  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) { const f = it.next(); files.push({ f: f, t: f.getDateCreated().getTime() }); }
  files.sort(function (a, b) { return b.t - a.t; });
  files.slice(KEEP_BACKUPS).forEach(function (x) { x.f.setTrashed(true); });
  return name;
}
function nightlyBackup() { backupNow_(); }


/* ================= MAIN SHEET (per-month workbook) =================
 * Layout of every panel tab: row 3 = feeder headings (merged over 2 columns: Reading | Consumption),
 * row 4 = "Reading" / "Consumption in kWh", a "Date" column (B), one row per day.
 * A reading is written into the feeder's Reading column on the row of its date. Consumption columns (formulas) are never touched.
 */
function norm_(v) { return String(v == null ? '' : v).toLowerCase().replace(/[\u00a0\s]+/g, ' ').replace(/[^a-z0-9()& \/.\-]/g, '').trim(); }
function ymd_(d, tz) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); }
function monthKey_(ymd) { return String(ymd).slice(0, 7); }
function nextMonthKey_(mk) { const y = Number(mk.slice(0, 4)), m = Number(mk.slice(5, 7)); return m === 12 ? (y + 1) + '-01' : y + '-' + (m < 9 ? '0' : '') + (m + 1); }
function sheetIdFromLink_(s) { const m = /\/d\/([a-zA-Z0-9_-]{20,})/.exec(String(s)); return m ? m[1] : (/^[a-zA-Z0-9_-]{25,}$/.test(String(s).trim()) ? String(s).trim() : ''); }

/* pick the tab for a panel name: exact -> without "(...)" -> tab name is a prefix of panel -> panel is a prefix of tab */
function resolveTabName_(tabNames, panel, override) {
  const names = tabNames.map(function (n) { return { n: n, k: norm_(n) }; });
  function find(k) { for (let i = 0; i < names.length; i++) if (names[i].k === k) return names[i].n; return ''; }
  if (override) return find(norm_(override));
  const p = norm_(panel), base = norm_(String(panel).replace(/\(.*?\)/g, ''));
  let r = find(p) || find(base);
  if (r) return r;
  let best = '', bl = 0;
  names.forEach(function (x) { if (x.k.length > bl && (p.indexOf(x.k) === 0 || base.indexOf(x.k) === 0)) { best = x.n; bl = x.k.length; } });
  return best;
}

/* top = first rows of the tab (array of arrays). Returns {col (1-based Reading column), dateCol} or {error} */
function locate_(top, panel, feeder, headingOverride) {
  const want = norm_(headingOverride || feeder);
  const qual = (/\(([^)]*)\)/.exec(String(panel)) || [])[1];         // e.g. "NMAEYC Ele (BTU)" -> "btu"
  const qn = qual ? norm_(qual) : '';
  const hits = [];
  for (let r = 0; r < Math.min(top.length, 5); r++) {
    for (let c = 0; c < top[r].length; c++) {
      const v = norm_(top[r][c]);
      if (!v) continue;
      if (v === want || v === norm_(String(panel) + ' ' + feeder) || v === norm_(feeder + ' ' + qual)) hits.push({ r: r, c: c, exact: 1 });
      else if (v.indexOf(want) >= 0 && want.length > 3) hits.push({ r: r, c: c, exact: 0 });
    }
  }
  if (!hits.length) return { error: 'Feeder not found in tab: ' + feeder };
  let pick = hits;
  if (pick.some(function (h) { return h.exact; })) pick = pick.filter(function (h) { return h.exact; });
  if (pick.length > 1 && qn) {                                         // two blocks with the same heading (Elevator / BTU): choose the one under the matching block title
    const f = pick.filter(function (h) { return blockTitle_(top, h.c).indexOf(qn) >= 0; });
    if (f.length) pick = f;
  }
  if (pick.length > 1) return { error: 'Feeder name is not unique in the tab: ' + feeder + ' (use Sheet Heading column in Feeders)' };
  let col = pick[0].c;
  const sub = norm_((top[3] || [])[col]);                              // if the heading cell sits on the Consumption half, step back
  if (sub.indexOf('consum') === 0 && col > 0) col -= 1;
  let dateCol = 2;
  for (let r = 0; r < Math.min(top.length, 5); r++) for (let c = 0; c < top[r].length; c++) if (norm_(top[r][c]) === 'date') { dateCol = c + 1; r = 9; break; }
  return { col: col + 1, dateCol: dateCol };
}
function blockTitle_(top, c) {                                         // nearest non-empty text to the left on rows 1-2 (block titles like "NMAEYC Ele (BTU)")
  for (let r = 0; r < Math.min(2, top.length); r++) for (let k = c; k >= 0; k--) { const v = norm_((top[r] || [])[k]); if (v) return v; }
  return '';
}

/* rows of the Date column -> row number (1-based) holding this yyyy-mm-dd, or 0 */
function rowForDate_(dateVals, startRow, ymd, tz) {
  for (let i = 0; i < dateVals.length; i++) {
    const v = dateVals[i][0];
    let k = '';
    if (v instanceof Date) k = ymd_(v, tz);
    else if (typeof v === 'string' && v.trim()) {
      const m = /^(\d{1,2})[-\/ ]([A-Za-z]{3})[a-z]*[-\/ ,]*(\d{2,4})$/.exec(v.trim());
      if (m) { const mi = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2].toLowerCase()); const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); if (mi >= 0) k = y + '-' + ('0' + (mi + 1)).slice(-2) + '-' + ('0' + Number(m[1])).slice(-2); }
    }
    if (k === ymd) return startRow + i;
  }
  return 0;
}

function mainLink_(mk) {
  const sh = sheet_('MainSheets');
  const n = sh.getLastRow() - 1;
  if (n < 1) return '';
  const rows = sh.getRange(2, 1, n, 2).getValues();
  for (let i = 0; i < rows.length; i++) {
    let m = rows[i][0];
    if (m instanceof Date) m = Utilities.formatDate(m, TZ, 'yyyy-MM');
    if (String(m).trim() === mk) return sheetIdFromLink_(rows[i][1]);
  }
  return '';
}

function overrideFor_(ctx, panel, feeder) {
  if (!ctx._fv) ctx._fv = sheet_('Feeders').getDataRange().getValues().slice(1);
  for (let i = 0; i < ctx._fv.length; i++) {
    const r = ctx._fv[i];
    if (String(r[1]).trim() === panel && String(r[2]).trim() === feeder) return { tab: String(r[4] || '').trim(), head: String(r[5] || '').trim() };
  }
  return { tab: '', head: '' };
}

/* write one reading into one workbook; returns '' if the date row is not in this workbook */
function writeOne_(ctx, ssId, panel, feeder, ymd, value) {
  let w = ctx[ssId];
  if (!w) { const ss = SpreadsheetApp.openById(ssId); w = ctx[ssId] = { ss: ss, tz: ss.getSpreadsheetTimeZone() || TZ, tabs: {}, names: ss.getSheets().map(function (x) { return x.getName(); }) }; }
  const ov = overrideFor_(ctx, panel, feeder);
  const tabName = resolveTabName_(w.names, panel, ov.tab);
  if (!tabName) return 'Error: tab not found for panel "' + panel + '"';
  let t = w.tabs[tabName];
  if (!t) {
    const sh = w.ss.getSheetByName(tabName);
    const lc = Math.max(sh.getLastColumn(), 1);
    t = w.tabs[tabName] = { sh: sh, top: sh.getRange(1, 1, 5, lc).getValues() };
  }
  const loc = locate_(t.top, panel, feeder, ov.head);
  if (loc.error) return 'Error: ' + loc.error;
  const lr = t.sh.getLastRow();
  if (lr < 5) return '';
  const dv = t.sh.getRange(5, loc.dateCol, lr - 4, 1).getValues();
  const row = rowForDate_(dv, 5, ymd, w.tz);
  if (!row) return '';
  const cell = t.sh.getRange(row, loc.col);
  const old = cell.getValue();
  const num = Number(value);
  cell.setValue(isNaN(num) ? value : num);
  return (old !== '' && old !== null && String(old) !== String(value)) ? 'OK (replaced ' + old + ')' : 'OK';
}

/* month sheet first; the last day of a month is also the base row of the next month's sheet */
function writeMain_(ctx, panel, feeder, ymd, value) {
  if (value === '' || value == null || isNaN(Number(value))) return 'Skipped (no value)';
  const mk = monthKey_(ymd);
  const keys = [mk, nextMonthKey_(mk)], done = [];
  let err = '', anyLink = false;
  keys.forEach(function (k) {
    const id = mainLink_(k);
    if (!id) return;
    anyLink = true;
    const r = writeOne_(ctx, id, panel, feeder, ymd, value);
    if (/^OK/.test(r)) done.push(r); else if (/^Error/.test(r) && !err) err = r;
  });
  if (done.length) return done[0];
  if (err) return err;
  return anyLink ? 'Error: date ' + ymd + ' not found in main sheet' : 'Error: no main sheet registered for ' + mk + ' (add it in MainSheets tab)';
}

/* admin: retry every Readings row whose Main sheet cell is not OK */
function mainResync_() {
  if (!MAIN_ENABLED) return { ok: false, error: 'main sheet is not enabled' };
  const sh = sheet_('Readings');
  const n = sh.getLastRow() - 1;
  if (n < 1) return { ok: true, done: 0, failed: 0, left: 0 };
  const vals = sh.getRange(2, 1, n, 10).getValues();
  const ctx = {};
  let done = 0, failed = 0, left = 0, handled = 0;
  for (let i = 0; i < vals.length; i++) {
    const st = String(vals[i][8]);
    if (/^(OK|Skipped)/.test(st)) continue;
    if (handled >= 150) { left++; continue; }
    handled++;
    const tm = vals[i][0] instanceof Date ? Utilities.formatDate(vals[i][0], TZ, 'yyyy-MM-dd') : String(vals[i][0]).slice(0, 10);
    let r;
    try { r = writeMain_(ctx, String(vals[i][3]), String(vals[i][4]), tm, vals[i][6]); } catch (e) { r = 'Error: ' + String(e.message || e).slice(0, 120); }
    sh.getRange(i + 2, 9).setValue(r);
    if (/^(OK|Skipped)/.test(r)) done++; else failed++;
  }
  return { ok: true, done: done, failed: failed, left: left };
}

/* last reading in the main sheet for a feeder on a date before req.date (opening-reading baseline for the app) */
function prevReading_(req) {
  if (!MAIN_ENABLED) return { ok: true, found: false };
  const ymd = String(req.date || '').slice(0, 10);
  const ctx = {};
  const keys = [monthKey_(ymd)];
  for (let k = 0; k < keys.length; k++) {
    const id = mainLink_(keys[k]);
    if (!id) continue;
    const ss = SpreadsheetApp.openById(id), tz = ss.getSpreadsheetTimeZone() || TZ;
    const ov = overrideFor_(ctx, String(req.panel), String(req.feeder));
    const tabName = resolveTabName_(ss.getSheets().map(function (x) { return x.getName(); }), String(req.panel), ov.tab);
    if (!tabName) return { ok: true, found: false };
    const sh = ss.getSheetByName(tabName);
    const top = sh.getRange(1, 1, 5, Math.max(sh.getLastColumn(), 1)).getValues();
    const loc = locate_(top, String(req.panel), String(req.feeder), ov.head);
    if (loc.error) return { ok: true, found: false };
    const lr = sh.getLastRow();
    if (lr < 5) return { ok: true, found: false };
    const dv = sh.getRange(5, loc.dateCol, lr - 4, 1).getValues();
    const rv = sh.getRange(5, loc.col, lr - 4, 1).getValues();
    let best = null;
    for (let i = 0; i < dv.length; i++) {
      const dd = dv[i][0];
      if (!(dd instanceof Date)) continue;
      const k = ymd_(dd, tz);
      if (k < ymd && rv[i][0] !== '' && !isNaN(Number(rv[i][0]))) best = { date: k, value: Number(rv[i][0]) };
    }
    if (best) return { ok: true, found: true, date: best.date, value: best.value };
  }
  return { ok: true, found: false };
}

/* export the month's MAIN workbook as .xlsx (base64) */
function exportMain_(req) {
  if (!MAIN_ENABLED) return { ok: false, error: 'main sheet is not enabled' };
  const mk = String(req.month || '').slice(0, 7);
  const id = mainLink_(mk);
  if (!id) return { ok: false, error: 'No main sheet registered for ' + mk + ' (add it in MainSheets tab)' };
  const f = DriveApp.getFileById(id);
  const blob = f.getAs('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return { ok: true, name: 'GHQ_Main_' + mk + '.xlsx', b64: Utilities.base64Encode(blob.getBytes()) };
}


/* ================= PPM equipment (edit the 'PPM' sheet, or add from the app) ================= */
function dstr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  const t = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = /^(\d{1,2})[-\/ ]([A-Za-z]{3})[a-z]*[-\/ ,]*(\d{2,4})$/.exec(t);
  if (m) { const mi = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2].toLowerCase()); if (mi >= 0) return (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) + '-' + ('0' + (mi + 1)).slice(-2) + '-' + ('0' + Number(m[1])).slice(-2); }
  const d2 = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(t);                    // 25/11/2026 (India: day first)
  if (d2) return d2[3] + '-' + ('0' + Number(d2[2])).slice(-2) + '-' + ('0' + Number(d2[1])).slice(-2);
  return '';
}
function ppmCat_(v) { const t = String(v || '').trim().toLowerCase(); return t.indexOf('e') === 0 ? 'elec' : t.indexOf('h') === 0 ? 'hvac' : t.indexOf('p') === 0 ? 'plumb' : ''; }
function ppmList_() {
  const sh = sheet_('PPM');
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const out = [];
  sh.getRange(2, 1, n, 8).getValues().forEach(function (r) {
    const cat = ppmCat_(r[0]), name = String(r[1]).trim();
    const flag = String(r[7]).trim().toLowerCase();
    if (!cat || !name || flag === 'no' || flag === 'n' || flag === 'inactive') return;
    out.push({ cat: cat, name: name, loc: String(r[2]).trim(), freq: String(r[3]).trim() || 'Monthly', last: dstr_(r[4]), team: String(r[5]).trim(),
               check: String(r[6]).split(/[\n;]+/).map(function (x) { return x.trim(); }).filter(Boolean) });
  });
  return out;
}
function ppmAdd_(req) {
  const e = req.e || {};
  const cat = { electrical: 'Electrical', hvac: 'HVAC', plumbing: 'Plumbing' }[String(e.cat || '').trim().toLowerCase()];
  const name = String(e.name || '').trim();
  if (!cat) throw new Error('Category must be Electrical, HVAC or Plumbing');
  if (!name) throw new Error('Equipment name is required');
  const freq = ['Weekly', 'Fortnightly', 'Monthly', 'Quarterly', 'Half-yearly', 'Yearly'].indexOf(e.freq) >= 0 ? e.freq : 'Monthly';
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const sh = sheet_('PPM');
    const dup = ppmList_().some(function (x) { return x.name.toLowerCase() === name.toLowerCase() && x.loc.toLowerCase() === String(e.loc || '').trim().toLowerCase(); });
    if (dup) throw new Error('This equipment already exists');
    const row = sh.getLastRow() + 1;
    sh.getRange(row, 5).setNumberFormat('yyyy-mm-dd');
    sh.getRange(row, 1, 1, 8).setValues([[cat, name, String(e.loc || '').trim(), freq, dstr_(e.last), String(e.team || '').trim(), String(e.check || '').trim(), 'Yes']]);
  } finally { lock.releaseLock(); }
  return { ok: true };
}
