// node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src/Core.js');

const NOW = '2025-09-19T09:00:00.000Z';

test('normalizeHeader maps common spellings', () => {
  assert.equal(c.normalizeHeader('Task ID'), 'TaskID');
  assert.equal(c.normalizeHeader(' assigned_to '), 'AssignedTo');
  assert.equal(c.normalizeHeader('Due Date'), 'DueDate');
  assert.equal(c.normalizeHeader('Deadline'), 'DueDate');
  assert.equal(c.normalizeHeader('Weird Column'), 'Weird Column');
});

test('normalizeDate accepts ISO and US formats, rejects junk', () => {
  assert.equal(c.normalizeDate('2025-09-22'), '2025-09-22');
  assert.equal(c.normalizeDate('2025/9/2'), '2025-09-02');
  assert.equal(c.normalizeDate('9/22/2025'), '2025-09-22');
  assert.equal(c.normalizeDate('2025-02-30'), null);
  assert.equal(c.normalizeDate('next week'), null);
});

test('normalizeStatus handles aliases and blanks', () => {
  assert.equal(c.normalizeStatus('wip'), 'In Progress');
  assert.equal(c.normalizeStatus(' DONE '), 'Done');
  assert.equal(c.normalizeStatus(''), 'Not Started');
  assert.equal(c.normalizeStatus('someday'), null);
});

test('detectFileType uses headers, not file names', () => {
  assert.equal(c.detectFileType([['TaskID', 'TaskName', 'AssignedTo']]), 'tasks');
  assert.equal(c.detectFileType([['Task ID', 'Status', 'Notes']]), 'updates');
  assert.equal(c.detectFileType([['foo', 'bar']]), 'unknown');
});

test('nextTaskId continues from the highest existing id', () => {
  assert.equal(c.nextTaskId([]), 'T-0001');
  assert.equal(c.nextTaskId(['T-0002', 'T-0010', 'junk']), 'T-0011');
});

test('mergeTasks assigns ids, skips duplicates, rejects invalid rows', () => {
  const existing = [{ TaskID: 'T-0001', TaskName: 'Dig trench', AssignedTo: 'jane@example.com', Status: 'Done', DueDate: '2025-09-01' }];
  const incoming = c.rowsToObjects([
    ['Task Name', 'Assigned To', 'Status', 'Due Date'],
    ['Pour footing', 'SAM@example.com', 'todo', '9/22/2025'],
    ['dig trench', 'jane@example.com', '', '2025-09-01'],     // duplicate (case-insensitive)
    ['Scaffolding', 'not-an-email', '', '2025-09-21'],         // bad email
    ['', '', '', '']                                            // blank row ignored
  ]);
  const m = c.mergeTasks(existing, incoming, NOW);
  assert.equal(m.created.length, 1);
  assert.deepEqual(
    { id: m.created[0].TaskID, who: m.created[0].AssignedTo, st: m.created[0].Status, due: m.created[0].DueDate },
    { id: 'T-0002', who: 'sam@example.com', st: 'Not Started', due: '2025-09-22' });
  assert.equal(m.duplicates.length, 1);
  assert.equal(m.duplicates[0].existingId, 'T-0001');
  assert.equal(m.rejected.length, 1);
  assert.match(m.rejected[0].reason, /not an email/);
  assert.equal(m.rows.length, 2);
});

test('applyUpdates changes status, appends notes, rejects unknown ids', () => {
  const existing = [{ TaskID: 'T-0001', TaskName: 'A', AssignedTo: 'a@example.com', Status: 'In Progress', DueDate: '2025-09-20', Note: '[2025-09-10] started' }];
  const u = c.applyUpdates(existing, [
    { TaskID: 't-0001', Status: 'complete', Note: 'finished' },
    { TaskID: 'T-0099', Status: 'Done', Note: '' }
  ], NOW);
  assert.equal(u.rows[0].Status, 'Done');
  assert.equal(u.rows[0].Note, '[2025-09-10] started\n[2025-09-19] finished');
  assert.equal(u.rows[0].LastUpdated, NOW);
  assert.equal(existing[0].Status, 'In Progress', 'input is not mutated');
  assert.equal(u.changes.length, 1);
  assert.equal(u.rejected.length, 1);
});

test('summarize counts statuses, overdue and due-this-week', () => {
  const tasks = [
    { TaskID: 'T-1', Status: 'Done', DueDate: '2025-09-01', AssignedTo: 'a@x.com' },
    { TaskID: 'T-2', Status: 'In Progress', DueDate: '2025-09-10', AssignedTo: 'a@x.com' },   // overdue
    { TaskID: 'T-3', Status: 'Not Started', DueDate: '2025-09-24', AssignedTo: 'b@x.com' },   // this week
    { TaskID: 'T-4', Status: 'Blocked', DueDate: '2025-10-30', AssignedTo: 'b@x.com' }
  ];
  const s = c.summarize(tasks, '2025-09-19');
  assert.equal(s.total, 4);
  assert.equal(s.percentDone, 25);
  assert.deepEqual(s.overdue.map(t => t.TaskID), ['T-2']);
  assert.deepEqual(s.dueThisWeek.map(t => t.TaskID), ['T-3']);
  assert.deepEqual(s.byAssignee['a@x.com'], { open: 1, done: 1, overdue: 1 });
});

test('summaryHtml escapes user text', () => {
  const s = c.summarize([{ TaskID: 'T-1', TaskName: '<script>x</script>', Status: 'Not Started', DueDate: '2025-01-01', AssignedTo: 'a@x.com' }], '2025-09-19');
  const html = c.summaryHtml(s, '2025-09-19');
  assert.ok(!html.includes('<script>x'));
  assert.ok(html.includes('&lt;script&gt;'));
});
