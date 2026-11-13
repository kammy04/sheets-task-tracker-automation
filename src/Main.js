/**
 * Main.js - the Google Sheets / Drive side of the task tracker.
 *
 * Sheets used (created by setup()):
 *   Tasks  - the live task list, one row per task
 *   Audit  - append-only log of every import, update, rejection and edit
 *
 * Script properties (Project Settings -> Script properties), set by setup():
 *   INBOX_FOLDER_ID      Drive folder people drop CSVs into
 *   PROCESSED_FOLDER_ID  where CSVs are moved once imported
 *   REPORTS_FOLDER_ID    where weekly PDF summaries are saved
 *   SUMMARY_EMAILS       optional, comma-separated list to email the PDF to
 */

var SHEET_TASKS = 'Tasks';
var SHEET_AUDIT = 'Audit';
var AUDIT_HEADERS = ['Timestamp', 'User', 'Action', 'TaskID', 'Details'];

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Task Tracker')
    .addItem('Import CSVs from Drive inbox', 'processInbox')
    .addItem('Import a CSV by file ID...', 'importCsvPrompt')
    .addSeparator()
    .addItem('Generate weekly summary PDF', 'generateWeeklySummary')
    .addSeparator()
    .addItem('Setup / repair sheets & folders', 'setup')
    .addItem('Install automatic triggers', 'installTriggers')
    .addToUi();
}

// ---------------------------------------------------------------------------
// One-time setup
// ---------------------------------------------------------------------------
function setup() {
  var ss = SpreadsheetApp.getActive();
  var tasks = getOrCreateSheet_(ss, SHEET_TASKS, TASK_HEADERS);
  getOrCreateSheet_(ss, SHEET_AUDIT, AUDIT_HEADERS);

  // Status dropdown + due-date validation on the Tasks sheet
  var statusCol = TASK_HEADERS.indexOf('Status') + 1;
  var dueCol = TASK_HEADERS.indexOf('DueDate') + 1;
  tasks.getRange(2, statusCol, tasks.getMaxRows() - 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).setAllowInvalid(false).build());
  tasks.getRange(2, dueCol, tasks.getMaxRows() - 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false)
      .setHelpText('Enter a date, e.g. 2025-09-22').build());
  tasks.getRange(2, dueCol, tasks.getMaxRows() - 1).setNumberFormat('yyyy-mm-dd');

  addConditionalFormatting_(tasks);

  // Drive folders, created next to the spreadsheet if they don't exist yet
  var props = PropertiesService.getScriptProperties();
  var parent = DriveApp.getFileById(ss.getId()).getParents().next();
  ['INBOX', 'PROCESSED', 'REPORTS'].forEach(function (name) {
    var key = name + '_FOLDER_ID';
    if (!props.getProperty(key)) {
      var folder = parent.createFolder('Task Tracker - ' + name.charAt(0) + name.slice(1).toLowerCase());
      props.setProperty(key, folder.getId());
    }
  });

  audit_('SETUP', '', 'Sheets, validation and Drive folders ready');
  SpreadsheetApp.getActive().toast('Setup complete. Drop CSVs into the "Task Tracker - Inbox" folder.');
}

function getOrCreateSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  var current = sh.getRange(1, 1, 1, headers.length).getValues()[0];
  if (current.join() !== headers.join()) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function addConditionalFormatting_(sh) {
  var range = sh.getRange('A2:H');
  var rules = [
    // overdue and not done -> red
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND($E2<>"", $E2<TODAY(), $D2<>"Done")')
      .setBackground('#fce8e6').setFontColor('#b3261e').setRanges([range]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$D2="Blocked"').setBackground('#fef7e0').setRanges([range]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$D2="Done"').setFontColor('#80868b').setRanges([range]).build()
  ];
  sh.setConditionalFormatRules(rules);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** Import every CSV in the inbox folder, then move it to Processed. Safe to run on a timer. */
function processInbox() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) { audit_('SKIPPED', '', 'Another import is already running'); return; }
  try {
    var props = PropertiesService.getScriptProperties();
    var inbox = DriveApp.getFolderById(props.getProperty('INBOX_FOLDER_ID'));
    var processed = DriveApp.getFolderById(props.getProperty('PROCESSED_FOLDER_ID'));

    // tasks before updates, so an update can refer to a task created in the same batch
    var files = [];
    var it = inbox.getFilesByType(MimeType.CSV);
    while (it.hasNext()) files.push(it.next());
    var parsed = files.map(function (f) {
      var values = Utilities.parseCsv(f.getBlob().getDataAsString('UTF-8'));
      return { file: f, values: values, type: detectFileType(values) };
    });
    parsed.sort(function (a, b) { return (a.type === 'tasks' ? 0 : 1) - (b.type === 'tasks' ? 0 : 1); });

    parsed.forEach(function (p) {
      importValues_(p.values, p.type, p.file.getName());
      p.file.moveTo(processed);
    });
    if (files.length) SpreadsheetApp.getActive().toast('Imported ' + files.length + ' file(s). See the Audit tab.');
  } finally {
    lock.releaseLock();
  }
}

function importCsvPrompt() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt('Import CSV', 'Paste the Drive file ID of the CSV:', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var file = DriveApp.getFileById(res.getResponseText().trim());
  var values = Utilities.parseCsv(file.getBlob().getDataAsString('UTF-8'));
  importValues_(values, detectFileType(values), file.getName());
}

function importValues_(values, type, sourceName) {
  var now = new Date().toISOString();
  var existing = readTasks_();
  var incoming = rowsToObjects(values);

  if (type === 'tasks') {
    var m = mergeTasks(existing, incoming, now);
    writeTasks_(m.rows);
    m.created.forEach(function (t) { audit_('CREATED', t.TaskID, t.TaskName + ' (from ' + sourceName + ')'); });
    m.duplicates.forEach(function (d) { audit_('DUPLICATE', d.existingId, 'Row ' + d.row + ' of ' + sourceName + ' already exists'); });
    m.rejected.forEach(function (r) { audit_('REJECTED', '', 'Row ' + r.row + ' of ' + sourceName + ': ' + r.reason); });
  } else if (type === 'updates') {
    var u = applyUpdates(existing, incoming, now);
    writeTasks_(u.rows);
    u.changes.forEach(function (c) { audit_('UPDATED', c.TaskID, c.details + ' (from ' + sourceName + ')'); });
    u.rejected.forEach(function (r) { audit_('REJECTED', '', 'Row ' + r.row + ' of ' + sourceName + ': ' + r.reason); });
  } else {
    audit_('REJECTED', '', sourceName + ': headers not recognised as tasks or updates');
  }
}

function readTasks_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_TASKS);
  var values = sh.getDataRange().getValues();
  // Sheets returns Date objects for date cells; normalise them back to text
  var objs = rowsToObjects(values.map(function (r) {
    return r.map(function (c) { return c instanceof Date ? normalizeDate(c) : c; });
  }));
  return objs.filter(function (o) { return o.TaskID; });
}

function writeTasks_(rows) {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_TASKS);
  var data = objectsToRows(rows);
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, TASK_HEADERS.length).clearContent();
  if (data.length) sh.getRange(2, 1, data.length, TASK_HEADERS.length).setValues(data);
}

// ---------------------------------------------------------------------------
// Edits made by hand in the sheet
// ---------------------------------------------------------------------------

/** Installable onEdit: stamp LastUpdated and log manual status changes. */
function onTaskEdit(e) {
  var sh = e.range.getSheet();
  if (sh.getName() !== SHEET_TASKS || e.range.getRow() === 1) return;

  var statusCol = TASK_HEADERS.indexOf('Status') + 1;
  var updatedCol = TASK_HEADERS.indexOf('LastUpdated') + 1;
  var row = e.range.getRow();
  var id = sh.getRange(row, 1).getValue();
  if (!id) return;

  sh.getRange(row, updatedCol).setValue(new Date().toISOString());
  if (e.range.getColumn() === statusCol && e.range.getNumRows() === 1) {
    audit_('EDITED', id, 'Status: ' + (e.oldValue || '(blank)') + ' -> ' + e.value);
  }
}

// ---------------------------------------------------------------------------
// Weekly summary PDF
// ---------------------------------------------------------------------------
function generateWeeklySummary() {
  var tz = Session.getScriptTimeZone();
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var s = summarize(readTasks_(), today);
  var html = summaryHtml(s, today);

  var pdf = Utilities.newBlob(html, MimeType.HTML, 'summary.html')
    .getAs(MimeType.PDF).setName('Task summary ' + today + '.pdf');
  var props = PropertiesService.getScriptProperties();
  var file = DriveApp.getFolderById(props.getProperty('REPORTS_FOLDER_ID')).createFile(pdf);

  var to = props.getProperty('SUMMARY_EMAILS');
  if (to) {
    MailApp.sendEmail({
      to: to,
      subject: 'Weekly task summary - ' + today,
      htmlBody: html,
      attachments: [pdf]
    });
  }
  audit_('REPORT', '', 'Weekly summary saved: ' + file.getUrl() + (to ? ' (emailed)' : ''));
  return file.getUrl();
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  var ss = SpreadsheetApp.getActive();
  ScriptApp.newTrigger('onTaskEdit').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('processInbox').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('generateWeeklySummary').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(7).create();
  audit_('SETUP', '', 'Triggers installed: onEdit, inbox every 15 min, summary Mondays 7am');
  ss.toast('Triggers installed.');
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
function audit_(action, taskId, details) {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_AUDIT);
  var user = Session.getActiveUser().getEmail() || 'trigger';
  sh.appendRow([new Date(), user, action, taskId, details]);
}
