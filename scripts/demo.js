// Run the tracker's core logic locally against sample-data/, no Google account needed.
//   node scripts/demo.js
// Prints the resulting Tasks table and Audit log, and writes docs/sample-summary.html.
const fs = require('fs');
const path = require('path');
const core = require('../src/Core.js');
const { parseCsv } = require('./csv.js');

const dir = path.join(__dirname, '..', 'sample-data');
const files = ['tasks_batch1.csv', 'updates_batch1.csv', 'tasks_batch2.csv', 'updates_batch2.csv'];
const NOW = '2025-09-19T09:00:00.000Z';
const TODAY = '2025-09-19';

let tasks = [];
const audit = [];
const log = (action, id, details) => audit.push({ action, id, details });

for (const f of files) {
  const values = parseCsv(fs.readFileSync(path.join(dir, f), 'utf8'));
  const type = core.detectFileType(values);
  const incoming = core.rowsToObjects(values);
  if (type === 'tasks') {
    const m = core.mergeTasks(tasks, incoming, NOW);
    tasks = m.rows;
    m.created.forEach(t => log('CREATED', t.TaskID, t.TaskName));
    m.duplicates.forEach(d => log('DUPLICATE', d.existingId, `row ${d.row} of ${f}`));
    m.rejected.forEach(r => log('REJECTED', '', `row ${r.row} of ${f}: ${r.reason}`));
  } else if (type === 'updates') {
    const u = core.applyUpdates(tasks, incoming, NOW);
    tasks = u.rows;
    u.changes.forEach(c => log('UPDATED', c.TaskID, c.details));
    u.rejected.forEach(r => log('REJECTED', '', `row ${r.row} of ${f}: ${r.reason}`));
  }
}

console.log('\nTasks sheet');
console.table(tasks.map(t => ({ TaskID: t.TaskID, TaskName: t.TaskName, AssignedTo: t.AssignedTo, Status: t.Status, DueDate: t.DueDate })));
console.log('\nAudit log');
console.table(audit);

const s = core.summarize(tasks, TODAY);
console.log(`\nSummary for ${TODAY}: ${s.total} tasks, ${s.percentDone}% done, ${s.overdue.length} overdue, ${s.dueThisWeek.length} due this week`);
const out = path.join(__dirname, '..', 'docs', 'sample-summary.html');
fs.writeFileSync(out, core.summaryHtml(s, TODAY));
console.log(`Wrote ${path.relative(process.cwd(), out)}`);
