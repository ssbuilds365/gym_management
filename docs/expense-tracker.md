# Expense Tracker

The Expense Tracker is available to authenticated owners in **Management → Expense Tracker**.
It uses the existing owner session cookie and derives `tenantId` and `businessId` from the
verified backend session; clients must not provide either scope value.

## API

All routes are mounted at `/api/expenses` and require `protectOwner`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Filtered expense rows, pagination and summary totals |
| POST | `/` | Create an expense and, when explicitly paid, its initial payment entry |
| GET | `/:id` | Read one non-archived expense and its payment history |
| PUT | `/:id` | Edit expense details or append an additional payment |
| DELETE | `/:id` | Archive an expense; does not physically delete financial history |
| GET | `/categories` | List default and tenant-owned custom categories |
| POST | `/categories` | Create a tenant-owned custom category |
| PUT | `/categories/:id` | Rename or deactivate a tenant-owned custom category |
| GET | `/reports` | Date-range totals with category, vendor and payment-status breakdowns |
| GET | `/export?format=csv` | Stream every row matching the current filters as CSV |
| GET | `/export?format=xlsx` | Stream a workbook with summary and transaction sheets |

List and export filters support `search`, `category`, `status`, `period`, `from`, `to`,
`sortBy`, and `sortDirection`. Supported periods are `today`, `yesterday`, `week`, `month`,
`lastMonth`, `year`, `custom`, and `all`. Custom date boundaries and calendar periods use the
business's configured timezone. List pagination accepts `page` and `limit` (maximum 100).
Exports are not limited to the visible page.

## Financial and audit behavior

- Amounts are stored as integer minor units (paise); API values are decimal INR amounts.
- `PAID`, `PENDING`, and `PARTIALLY_PAID` are calculated from the total obligation and
  append-only payment entries. An expense's status cannot be set independently of its
  payment history.
- Pending amounts are not counted as paid. Additional payments cannot exceed the remaining
  balance.
- Updates and archival are recorded in `ExpenseAudit`; deletion is a soft archive, preserving
  the original payment history and audit trail.
- Default categories are defined in `backend/utils/expenses.js`. Custom categories have a
  unique tenant-scoped normalized-name index.
- Expense collection indexes are declared in `backend/models/Expense.js`. Category changes
  also have a tenant-scoped unique index in `backend/models/ExpenseCategory.js`.

## Deployment

Deploy the backend and frontend through the existing Render and Vercel projects. No new
environment variables are required. The backend uses MongoDB transactions to commit expense
mutations and their audit records together; the configured Atlas deployment must support
transactions. Mongoose creates the declared indexes when automatic index creation is enabled.
If production disables `autoIndex`, create the declared indexes through the normal approved
database change process. No production migration is included.

ExcelJS was added to the backend to generate real `.xlsx` files. CSV is streamed with formula
injection protection. PDF and print reports are generated in the browser from all matching
paginated records using the existing `jspdf` dependency.

## Deferred infrastructure monitor

The database storage monitor is intentionally not exposed to owners. This deployment has a
shared MongoDB connection and currently authenticates owners only; exposing shared cluster
statistics would disclose infrastructure details to tenant owners. Add a platform-admin-only
authorization model before implementing that monitor.
