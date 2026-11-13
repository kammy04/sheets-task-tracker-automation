# AppSheet front end

A small mobile/desktop CRUD app on top of the `Tasks` sheet, so site leads can update tasks
from their phone instead of uploading CSVs.

## 1. Connect the data

*Create → App → Start with existing data → Google Sheets* → pick the tracker spreadsheet.
Add two tables: `Tasks` and `Audit`.

## 2. Tasks table columns

| Column | Type | Settings |
|---|---|---|
| TaskID | Text | **Key**. Initial value: `"T-" & RIGHT("0000" & (COUNT(Tasks[TaskID]) + 1), 4)`. Not editable |
| TaskName | Text | Label, required |
| AssignedTo | Email | Required |
| Status | Enum | Values: Not Started, In Progress, Blocked, Done. Display as buttons |
| DueDate | Date | Required |
| Note | LongText | |
| CreatedAt | DateTime | Initial value `NOW()`, hidden |
| LastUpdated | DateTime | App formula `NOW()` on every change, hidden |

`TaskID` is the same key the Apps Script uses, so rows created in AppSheet and rows imported from
CSV never collide. The script always continues from the highest existing ID.

## 3. Slices

| Slice | Row filter |
|---|---|
| My open tasks | `AND([AssignedTo] = USEREMAIL(), [Status] <> "Done")` |
| Overdue | `AND([DueDate] < TODAY(), [Status] <> "Done")` |
| Blocked | `[Status] = "Blocked"` |

## 4. Views

- **My tasks**: deck view on *My open tasks*, sorted by `DueDate`, grouped by `Status`.
- **Overdue**: table view on *Overdue*, sorted by `DueDate`.
- **Board**: table view on `Tasks` grouped by `Status`.
- **Audit**: read-only table view on `Audit`, newest first.

## 5. Security

- *Security → Require sign-in*.
- `Tasks` security filter for non-managers: `OR([AssignedTo] = USEREMAIL(), IN(USEREMAIL(), LIST("lead@company.com")))`.
- `Audit` table: *Are updates allowed?* = Read-Only.

## 6. Actions

- **Mark done**: set `Status` to `Done`. Shown only when `[Status] <> "Done"`.
- **Flag blocked**: set `Status` to `Blocked` and open the form to add a `Note`.
