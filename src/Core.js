/**
 * Core.js - pure business logic for the task tracker.
 *
 * Nothing in this file touches SpreadsheetApp, DriveApp or any other Google
 * service, so it can be unit-tested locally with Node (see tests/core.test.js).
 * Main.js is the thin layer that reads/writes Sheets and Drive and calls these.
 */

var TASK_HEADERS = ['TaskID', 'TaskName', 'AssignedTo', 'Status', 'DueDate', 'Note', 'CreatedAt', 'LastUpdated'];
var STATUSES = ['Not Started', 'In Progress', 'Blocked', 'Done'];
var ID_PREFIX = 'T-';
var ID_WIDTH = 4;

// Header names people actually type -> the canonical column name.
var HEADER_ALIASES = {
  taskid: 'TaskID', id: 'TaskID', task_id: 'TaskID',
  taskname: 'TaskName', task: 'TaskName', name: 'TaskName', title: 'TaskName', description: 'TaskName',
  assignedto: 'AssignedTo', assignee: 'AssignedTo', owner: 'AssignedTo', email: 'AssignedTo',
  status: 'Status', state: 'Status',
  duedate: 'DueDate', due: 'DueDate', deadline: 'DueDate',
  note: 'Note', notes: 'Note', comment: 'Note', comments: 'Note'
};

// Loose status spellings -> one of STATUSES.
var STATUS_ALIASES = {
  'not started': 'Not Started', 'todo': 'Not Started', 'to do': 'Not Started', 'new': 'Not Started', 'open': 'Not Started',
  'in progress': 'In Progress', 'in-progress': 'In Progress', 'wip': 'In Progress', 'started': 'In Progress',
  'blocked': 'Blocked', 'on hold': 'Blocked', 'waiting': 'Blocked',
  'done': 'Done', 'complete': 'Done', 'completed': 'Done', 'closed': 'Done'
};

/** "Assigned To " / "assigned_to" / "ASSIGNEE" -> "AssignedTo". Unknown headers come back trimmed. */
function normalizeHeader(h) {
  var key = String(h || '').trim().toLowerCase().replace(/[\s\-]+/g, '');
  if (HEADER_ALIASES[key]) return HEADER_ALIASES[key];
  key = key.replace(/_/g, '');
  return HEADER_ALIASES[key] || String(h || '').trim();
}

/** 2-D array from a CSV/sheet (first row = headers) -> array of objects with canonical keys. */
function rowsToObjects(values) {
  if (!values || values.length < 1) return [];
  var headers = values[0].map(normalizeHeader);
  return values.slice(1)
    .filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); })
    .map(function (r) {
      var o = {};
      headers.forEach(function (h, i) { o[h] = r[i] === undefined ? '' : String(r[i]).trim(); });
      return o;
    });
}

/** Array of objects -> 2-D array in TASK_HEADERS order (for writing back to the sheet). */
function objectsToRows(objs) {
  return objs.map(function (o) {
    return TASK_HEADERS.map(function (h) { return o[h] === undefined ? '' : o[h]; });
  });
}

/** Decide what kind of file this is from its headers alone (file names are unreliable). */
function detectFileType(values) {
  if (!values || !values.length) return 'unknown';
  var h = values[0].map(normalizeHeader);
  if (h.indexOf('TaskName') !== -1) return 'tasks';
  if (h.indexOf('TaskID') !== -1 && (h.indexOf('Status') !== -1 || h.indexOf('Note') !== -1)) return 'updates';
  return 'unknown';
}

function normalizeStatus(s) {
  var key = String(s || '').trim().toLowerCase();
  if (key === '') return 'Not Started';
  return STATUS_ALIASES[key] || null;
}

/** Accepts 2025-09-22, 2025/9/22, 9/22/2025 or a Date. Returns 'YYYY-MM-DD' or null. */
function normalizeDate(d) {
  if (d instanceof Date && !isNaN(d)) return formatDate(d);
  var s = String(d || '').trim();
  var m;
  if ((m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/))) return ymd(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return ymd(+m[3], +m[1], +m[2]);
  return null;
}

function ymd(y, mo, da) {
  var dt = new Date(Date.UTC(y, mo - 1, da));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== da) return null;
  return formatDate(dt);
}

function formatDate(dt) {
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return dt.getUTCFullYear() + '-' + p(dt.getUTCMonth() + 1) + '-' + p(dt.getUTCDate());
}

function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
}

/** Validate + normalise one incoming task. Returns {task} or {error}. */
function validateTask(raw) {
  var errors = [];
  var name = String(raw.TaskName || '').trim();
  if (!name) errors.push('TaskName is empty');

  var email = String(raw.AssignedTo || '').trim().toLowerCase();
  if (!isEmail(email)) errors.push('AssignedTo "' + (raw.AssignedTo || '') + '" is not an email');

  var status = normalizeStatus(raw.Status);
  if (!status) errors.push('Status "' + raw.Status + '" is not one of ' + STATUSES.join(', '));

  var due = normalizeDate(raw.DueDate);
  if (!due) errors.push('DueDate "' + (raw.DueDate || '') + '" is not a valid date');

  if (errors.length) return { error: errors.join('; ') };
  return { task: { TaskName: name, AssignedTo: email, Status: status, DueDate: due, Note: String(raw.Note || '').trim() } };
}

/** Highest existing T-#### number + 1, formatted. */
function nextTaskId(existingIds) {
  var max = 0;
  (existingIds || []).forEach(function (id) {
    var m = String(id).match(/^T-(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  var n = String(max + 1);
  while (n.length < ID_WIDTH) n = '0' + n;
  return ID_PREFIX + n;
}

/**
 * Merge incoming tasks into the existing list.
 * - assigns a fresh TaskID to each new task
 * - skips duplicates (same name + assignee as a task already in the sheet or earlier in the file)
 * - collects rejected rows with the reason, so nothing disappears silently
 */
function mergeTasks(existing, incoming, nowIso) {
  var rows = existing.slice();
  var ids = rows.map(function (t) { return t.TaskID; });
  var seen = {};
  rows.forEach(function (t) { seen[dupKey(t)] = t.TaskID; });

  var created = [], rejected = [], duplicates = [];
  incoming.forEach(function (raw, i) {
    var v = validateTask(raw);
    if (v.error) { rejected.push({ row: i + 2, reason: v.error, data: raw }); return; }
    var key = dupKey(v.task);
    if (seen[key]) { duplicates.push({ row: i + 2, existingId: seen[key], data: raw }); return; }

    var id = nextTaskId(ids);
    ids.push(id);
    var t = Object.assign({ TaskID: id, CreatedAt: nowIso, LastUpdated: nowIso }, v.task);
    seen[key] = id;
    rows.push(t);
    created.push(t);
  });
  return { rows: rows, created: created, rejected: rejected, duplicates: duplicates };
}

function dupKey(t) {
  return String(t.TaskName || '').trim().toLowerCase() + '|' + String(t.AssignedTo || '').trim().toLowerCase();
}

/**
 * Apply status/note updates by TaskID.
 * Notes are appended (with a date stamp) rather than overwritten, so history is kept.
 */
function applyUpdates(existing, updates, nowIso) {
  var rows = existing.map(function (t) { return Object.assign({}, t); });
  var byId = {};
  rows.forEach(function (t) { byId[t.TaskID] = t; });

  var changes = [], rejected = [];
  updates.forEach(function (u, i) {
    var id = String(u.TaskID || '').trim().toUpperCase();
    var t = byId[id];
    if (!t) { rejected.push({ row: i + 2, reason: 'Unknown TaskID "' + (u.TaskID || '') + '"', data: u }); return; }

    var diff = [];
    if (String(u.Status || '').trim() !== '') {
      var st = normalizeStatus(u.Status);
      if (!st) { rejected.push({ row: i + 2, reason: 'Status "' + u.Status + '" is not valid', data: u }); return; }
      if (st !== t.Status) { diff.push('Status: ' + t.Status + ' -> ' + st); t.Status = st; }
    }
    var note = String(u.Note || '').trim();
    if (note) {
      var stamp = '[' + nowIso.slice(0, 10) + '] ' + note;
      t.Note = t.Note ? t.Note + '\n' + stamp : stamp;
      diff.push('Note added');
    }
    if (diff.length) {
      t.LastUpdated = nowIso;
      changes.push({ TaskID: id, details: diff.join('; ') });
    }
  });
  return { rows: rows, changes: changes, rejected: rejected };
}

/** Numbers for the weekly summary. `today` is 'YYYY-MM-DD'. */
function summarize(tasks, today) {
  var byStatus = {};
  STATUSES.forEach(function (s) { byStatus[s] = 0; });
  var overdue = [], dueThisWeek = [], byAssignee = {};
  var weekEnd = addDays(today, 7);

  tasks.forEach(function (t) {
    byStatus[t.Status] = (byStatus[t.Status] || 0) + 1;
    var a = t.AssignedTo || '(unassigned)';
    byAssignee[a] = byAssignee[a] || { open: 0, done: 0, overdue: 0 };
    if (t.Status === 'Done') { byAssignee[a].done++; return; }
    byAssignee[a].open++;
    if (t.DueDate && t.DueDate < today) { overdue.push(t); byAssignee[a].overdue++; }
    else if (t.DueDate && t.DueDate <= weekEnd) dueThisWeek.push(t);
  });

  var byDue = function (a, b) { return a.DueDate < b.DueDate ? -1 : a.DueDate > b.DueDate ? 1 : 0; };
  var total = tasks.length;
  return {
    total: total,
    byStatus: byStatus,
    percentDone: total ? Math.round((byStatus['Done'] / total) * 100) : 0,
    overdue: overdue.sort(byDue),
    dueThisWeek: dueThisWeek.sort(byDue),
    byAssignee: byAssignee
  };
}

function addDays(isoDate, n) {
  var p = isoDate.split('-').map(Number);
  return formatDate(new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/** HTML for the weekly PDF. Kept here (not in Main.js) so it can be previewed/tested locally. */
function summaryHtml(s, today) {
  var row = function (t) {
    return '<tr><td>' + escapeHtml(t.TaskID) + '</td><td>' + escapeHtml(t.TaskName) + '</td><td>' +
      escapeHtml(t.AssignedTo) + '</td><td>' + escapeHtml(t.Status) + '</td><td>' + escapeHtml(t.DueDate) + '</td></tr>';
  };
  var table = function (list) {
    if (!list.length) return '<p class="muted">None</p>';
    return '<table><tr><th>ID</th><th>Task</th><th>Assigned to</th><th>Status</th><th>Due</th></tr>' +
      list.map(row).join('') + '</table>';
  };
  var people = Object.keys(s.byAssignee).sort().map(function (a) {
    var p = s.byAssignee[a];
    return '<tr><td>' + escapeHtml(a) + '</td><td>' + p.open + '</td><td>' + p.overdue + '</td><td>' + p.done + '</td></tr>';
  }).join('');

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    'body{font-family:Arial,sans-serif;color:#222;font-size:11px}h1{font-size:18px;margin:0}' +
    'h2{font-size:13px;margin:18px 0 6px;border-bottom:1px solid #ccc}' +
    'table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:4px 6px;border-bottom:1px solid #eee}' +
    'th{background:#f3f3f3}.kpi{display:inline-block;margin-right:24px}.kpi b{font-size:18px;display:block}' +
    '.muted{color:#888}.late{color:#b3261e}</style></head><body>' +
    '<h1>Weekly task summary</h1><p class="muted">Generated ' + escapeHtml(today) + '</p>' +
    '<div><span class="kpi"><b>' + s.total + '</b>tasks</span>' +
    '<span class="kpi"><b>' + s.percentDone + '%</b>done</span>' +
    '<span class="kpi"><b>' + s.byStatus['In Progress'] + '</b>in progress</span>' +
    '<span class="kpi"><b>' + s.byStatus['Blocked'] + '</b>blocked</span>' +
    '<span class="kpi late"><b>' + s.overdue.length + '</b>overdue</span></div>' +
    '<h2 class="late">Overdue</h2>' + table(s.overdue) +
    '<h2>Due in the next 7 days</h2>' + table(s.dueThisWeek) +
    '<h2>By person</h2><table><tr><th>Assigned to</th><th>Open</th><th>Overdue</th><th>Done</th></tr>' + people + '</table>' +
    '</body></html>';
}

// Let Node require() this file for tests; Apps Script ignores it.
if (typeof module !== 'undefined') {
  module.exports = {
    TASK_HEADERS: TASK_HEADERS, STATUSES: STATUSES, normalizeHeader: normalizeHeader, rowsToObjects: rowsToObjects,
    objectsToRows: objectsToRows, detectFileType: detectFileType, normalizeStatus: normalizeStatus,
    normalizeDate: normalizeDate, isEmail: isEmail, validateTask: validateTask, nextTaskId: nextTaskId,
    mergeTasks: mergeTasks, applyUpdates: applyUpdates, summarize: summarize, summaryHtml: summaryHtml, addDays: addDays
  };
}
