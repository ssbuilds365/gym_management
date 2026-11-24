# SS Fitness Manager implementation report

**Implementation date:** 2026-11-03  
**Status:** SaaS modules and safe partial biometric foundations implemented. The
application is **not production-ready for biometric attendance** and requires
the deployment actions and external decisions below.

## Biometric identity security update (2026-11-23)

- The biometric runtime was replaced on 2026-11-24 with ONNX Runtime CPU,
  OpenCV Zoo YuNet 2026 detector, and SFace 2021 recognition model. Backend
  model files are under `backend/models/onnx`; the frontend loads only the
  YuNet model from `frontend/public/models`. The browser uses
  `onnxruntime-web` WASM for detection; the backend performs detection and
  embedding generation with `onnxruntime-node`.
- Face enrollment through the Members tab and the kiosk enrollment controller
  now shares a backend comparison path. A gym-scoped transaction lock serializes
  enrollment, replacement, revocation, member deletion, and biometric check-in.
  SFace templates are normalized 128D vectors compared by cosine similarity
  with the model's documented `0.363` threshold; identification rejects
  multiple-member matches and near-tied candidates. Legacy face-api vectors
  are not compared to SFace vectors.
- Owner registration no longer silently overwrites an active template.
  Replacement requires owner authentication plus explicit confirmation, and
  is performed transactionally. A legacy encrypted template is preserved and
  marked `MigrationRequired` when replaced; the member must explicitly
  re-enroll with fresh consent. No production template was migrated or changed.
- Identifier-only kiosk self-enrollment is disabled because a member ID or
  phone number is not proof of identity. Staff must verify identity and enroll
  from the authenticated Members page. The kiosk enrollment endpoint still
  requires its existing enrollment authorization; this change does not enable
  the currently disabled identifier-only self-enrollment flow.
- The owner-only `GET /api/biometric/duplicates` report and Members-page audit
  list affected member IDs for manual review. The report never returns
  embeddings and does not change templates or attendance history.
- Transactions require a replica-set MongoDB deployment (MongoDB Atlas
  supports this). Apply the non-destructive scan index with
  `npm run migrate:biometric-duplicate-index` from `backend`. The per-gym lock
  collection is created on first use and relies on MongoDB's built-in unique
  `_id` index. No new environment variable is introduced.
- Liveness/photo-replay detection is not supported by YuNet or SFace. Frontend
  detection and stability checks are not liveness checks. The UI discloses this
  limitation; do not treat a camera preview or face match as proof of liveness.
- Angular uses YuNet only for camera guidance and sends bounded JPEG samples.
  The backend generates SFace embeddings, encrypts them at rest, and processes
  uploaded frames transiently without retaining them. Recognition remains
  unavailable if ONNX model initialization fails. Old TensorFlow.js weights
  and `face-api.js` / TensorFlow.js dependencies have been removed.

## Completed in this change

| Area | Implemented |
|---|---|
| Member deletion | Authenticated-owner and tenant-scoped transactional deletion. Removes attendance, QR credentials, and legacy biometric enrollment documents; revokes and erases current face templates; and removes eligible membership history. Retains payment records and paid membership records, anonymizes the member profile, and writes a minimal deletion audit. The operation returns a clear error if MongoDB transactions are unavailable. |
| Dashboard and payments | Dashboard and payments use membership `paidAmount` for consistent membership collection totals. Outstanding dues are calculated from non-cancelled memberships for non-deleted members, clamped to zero and rounded to cents. Pending transactions remain a separate payment-record status count. |
| Attendance sessions | Manual/QR check-in rejects an existing open session and applies a 30-second repeat-scan cooldown. Check-out finds open sessions across dates, allowing overnight checkout; duration is stored in minutes and reports include it. Check-in timestamps/date are server-generated. The ordinary manual route no longer accepts `Biometric` as an attendance type. |
| Dance Academy | Removed from registration and the business-type schema. Added an idempotent migration mapping existing records to `Other`; it has **not** been run against MongoDB. |
| Trainers & Staff | Tenant-scoped create, list, update, and delete endpoints and a working Angular team directory. Supports role, contact information, specialization, and active/inactive status. Payroll is not included. |
| Reports & Analytics | Tenant-scoped date-filtered summary and daily report for member joins, attendance visits/checkouts/duration, payment transactions, successful recorded transactions, and outstanding membership fees. Date ranges are limited to 366 days. |
| Settings | Tenant-scoped read/update of business name, type, phone, email, and address. The owner name and account security settings are not editable here. |
| Subscription | Displays the saved business subscription status. The API explicitly reports that billing is not configured; it does not invent plans, prices, renewal dates, or checkout actions. |
| Biometric identity security | Face templates are AES-256-GCM encrypted at rest. Owner registration and kiosk identification use gym-scoped credentials, backend-only descriptor generation, server-side duplicate comparison, explicit replacement, current-template match proofs, and fail-closed decryption. Camera frames are transiently processed in the backend and not persisted. The detector still does not provide liveness verification. |

## Important files

- Deletion and member records: [memberController.js](../backend/controllers/memberController.js), [Member.js](../backend/models/Member.js), [MemberDeletionAudit.js](../backend/models/MemberDeletionAudit.js)
- Dashboard, payments, and attendance: [dashboardController.js](../backend/controllers/dashboardController.js), [paymentController.js](../backend/controllers/paymentController.js), [attendanceController.js](../backend/controllers/attendanceController.js), [Attendance.js](../backend/models/Attendance.js)
- Team, reports, business settings/subscription: [trainerStaffController.js](../backend/controllers/trainerStaffController.js), [reportController.js](../backend/controllers/reportController.js), [businessController.js](../backend/controllers/businessController.js), [TrainerStaff.js](../backend/models/TrainerStaff.js)
- Biometric storage foundation: [BiometricEnrollment.js](../backend/models/BiometricEnrollment.js), [biometricEncryption.js](../backend/utils/biometricEncryption.js)
- Face identity matching and transaction lock: [biometricIdentity.js](../backend/services/biometricIdentity.js), [BiometricEnrollmentLock.js](../backend/models/BiometricEnrollmentLock.js), [kioskController.js](../backend/controllers/kioskController.js), [biometricController.js](../backend/controllers/biometricController.js)
- API registration: [server.js](../backend/server.js), routes under [backend/routes](../backend/routes)
- Angular shell and management modules: [app.ts](../frontend/src/app/app.ts), [app.html](../frontend/src/app/app.html), [management.ts](../frontend/src/app/services/management.ts)
- Business-type migration: [migrateDanceAcademyBusinessType.js](../backend/scripts/migrateDanceAcademyBusinessType.js)
- SecuGen evidence and blockers: [secugen-hu20-sdk-verification.md](./secugen-hu20-sdk-verification.md)

## 2026-11-24 biometric runtime replacement files

- Backend ONNX inference and model-versioned identity matching:
  [faceRecognition.js](../backend/services/faceRecognition.js),
  [biometricIdentity.js](../backend/services/biometricIdentity.js),
  [BiometricCredential.js](../backend/models/BiometricCredential.js).
- Backend routes/controllers and focused model, enrollment, and identification
  tests were updated to use the ONNX runtime and preserve legacy encrypted
  templates.
- Browser detection, model/WASM asset configuration, and legacy re-enrollment
  UI: [face-recognition.ts](../frontend/src/app/services/face-recognition.ts),
  [angular.json](../frontend/angular.json), and
  [members.html](../frontend/src/app/pages/members/members.html).
- Backend uses `onnxruntime-node@1.22.0`; frontend uses
  `onnxruntime-web@1.22.0`. TensorFlow.js and `face-api.js` packages and their
  old detector/landmark/recognition weights were removed.

## Complete changed-file inventory

**Backend modified:** `.env.example`, `controllers/attendanceController.js`,
`controllers/authController.js`, `controllers/dashboardController.js`,
`controllers/memberController.js`, `controllers/memberMembershipController.js`,
`controllers/paymentController.js`, `models/Attendance.js`,
`models/Business.js`, `models/Member.js`, `package.json`, and `server.js`.

**Backend added:** `controllers/businessController.js`,
`controllers/reportController.js`, `controllers/trainerStaffController.js`,
`models/BiometricEnrollment.js`, `models/MemberDeletionAudit.js`,
`models/TrainerStaff.js`, `routes/businessRoutes.js`,
`routes/reportRoutes.js`, `routes/trainerStaffRoutes.js`,
`scripts/migrateDanceAcademyBusinessType.js`,
`tests/biometricEncryption.test.js`, and `utils/biometricEncryption.js`.
`utils/currency.js` is also new.

**Frontend modified:** `src/app/app.html`, `src/app/app.ts`,
`src/app/pages/auth/register/register.ts`,
`src/app/pages/members/members.html`,
`src/app/pages/members/members.ts`,
`src/app/pages/payments/payments.html`,
`src/app/pages/payments/payments.scss`, and
`src/app/pages/payments/payments.ts`.

**Frontend added:** `src/app/pages/reports/reports.html`,
`src/app/pages/reports/reports.scss`, `src/app/pages/reports/reports.ts`,
`src/app/pages/settings/settings.html`,
`src/app/pages/settings/settings.scss`, `src/app/pages/settings/settings.ts`,
`src/app/pages/subscription/subscription.html`,
`src/app/pages/subscription/subscription.scss`,
`src/app/pages/subscription/subscription.ts`,
`src/app/pages/trainers-staff/trainers-staff.html`,
`src/app/pages/trainers-staff/trainers-staff.scss`,
`src/app/pages/trainers-staff/trainers-staff.ts`, and
`src/app/services/management.ts`.

**Documentation added:** `docs/implementation-report.md`. The previously
created SecuGen audit was not modified in this work.

## Database and migration notes

- Added `Member.deletedAt`; existing documents without that field remain visible
  because queries explicitly match `deletedAt: null`.
- Added `MemberDeletionAudit`, `TrainerStaff`, and `BiometricEnrollment`
  collections and their tenant-scoped indexes.
- Added the `BiometricEnrollmentLock` collection, created on demand with its
  built-in unique `_id` index, plus the non-unique
  `biometric_identity_scan` index on `BiometricCredential`. Run
  `npm run migrate:biometric-duplicate-index` before deployment if automatic
  index creation is disabled.
- Added optional `Attendance.durationMinutes`; reports derive duration from
  check-in/check-out timestamps, including for older attendance records.
- No production or staging MongoDB data was accessed or changed.
- Payment records created through the Payments module are date-attributed in
  transaction reports. Legacy/initial membership `paidAmount` values that have
  no corresponding `Payment` record have no reliable payment date; they are
  included in all-time membership collection totals but not retroactively
  assigned to a report date.
- Before deploying, back up the target database and run
  `npm run migrate:business-type` from `backend` with the intended database
  connection configured. It converts legacy `Dance Academy` business types to
  `Other`. The migration is idempotent.
- Member deletion requires a MongoDB replica set/transaction-capable topology
  (MongoDB Atlas supports transactions). Verify the target deployment before
  enabling the UI action.
- Establish and document retention periods for backups and legally retained
  payment records. This change retains payment records and paid membership
  records; backup expiry and downstream/local-agent cache purging are not
  automated because no such cache service exists yet.

## Deployment requirements

- Deploy the backend from `backend` and frontend from `frontend` using the
  existing Render/Vercel configuration.
- Backend runtime is Node.js `22.x` (`backend/.node-version` pins `22.23.5`).
  `onnxruntime-node@1.22.0` supplies the native CPU runtime; Render must install
  the lockfile on Linux and load its Linux ONNX Runtime binary.
- Keep existing `MONGODB_URI`, `JWT_SECRET`, and `FRONTEND_URL` server-side
  environment configuration intact.
- Kiosk and current biometric enrollment require `BIOMETRIC_TEMPLATE_KEY`,
  configured server-side as Base64 that decodes to exactly 32 bytes.
  `BIOMETRIC_KEY_VERSION` is optional and defaults to `v1`. Keep the key stable
  while encrypted templates exist; never put it in MongoDB, source control,
  Angular configuration, or logs. The legacy `BIOMETRIC_ENCRYPTION_KEY`
  utility setting does not configure kiosk enrollment.
- Backend face inference uses `onnxruntime-node@1.22.0` with YuNet and SFace
  under `backend/models/onnx`; the Angular app uses `onnxruntime-web@1.22.0`
  and the public YuNet model. No additional environment variable is required.
  Keep the ONNX model files in their deployment packages. Missing or failed
  initialization disables face capabilities without disabling QR attendance.
- Review the deployment index policy for the new tenant-scoped indexes.
- Biometric enrollment, replacement, revocation, and face check-in require
  MongoDB transactions and therefore a replica-set deployment. No new
  environment variables are required.
- Run the business-type migration only after verifying its target URI and
  taking a backup; the script was not run in this implementation session.

## Validation

- Backend: Node 22 `node --test` — **158 passed, 0 failed**. Includes ONNX CPU
  session startup, no-face and malformed-image rejection, normalized SFace
  embedding inference, cosine matching, legacy-template preservation,
  invalid/no-face image rejection, duplicate enrollment, cross-tenant
  rejection, ambiguous identity rejection, revoked-template checks, expiry,
  and existing QR and attendance tests. Controller security tests use
  synthetic descriptors; they do not prove recognition accuracy for a real
  member's face.
- Backend face inference: ONNX CPU sessions loaded successfully; SFace
  generated a normalized 128-value vector from a test tensor and a synthetic
  blank JPEG was rejected as `NO_FACE`. No real face was used, so detection and
  identity accuracy were not end-to-end verified.
- Dependency audit: `npm audit` reported **0 vulnerabilities** after removal of
  face-api.js and its vulnerable TensorFlow.js dependency tree.
- Angular: the biometric Members test is included among **105 passing** unit
  tests; the full run also has 6 unrelated Settings tests failing because their
  management-service mock lacks `listKioskCredentials`.
- Angular production build: **passed**. It reports existing CommonJS
  optimization warnings in unrelated libraries.
- Render Linux installation, Vercel deployment, Android Chrome, MongoDB
  persistence, a real member enrollment, recognition, attendance marking, and
  QR attendance were not exercised in this environment.
- No connected HU20 capture, template extraction, enrollment, 1:1, or 1:N test
  was performed.

## Remaining blockers and acceptance items

1. **HU20 identification is blocked.** The installed SecuGen WebAPI v1.1.0.16
   documents capture and 1:1 matching, not customer-population 1:N search.
   The installed-machine audit did not find SecuSearch Pro 3 / WebAPI 1:N.
   Actual device capture, template round-trip, and 1:N acceptance remain
   unverified; see the SecuGen verification report.
2. **No Windows agent or enrollment UI/API exists yet.** The SDK response can
   include fingerprint images/templates, so it must remain within a secured
   local native/helper process, not Angular. The agent still needs a verified
   SDK, supported interactive-session architecture, authenticated backend
   protocol, offline queue, startup/reconnect behavior, cache invalidation,
   and hardware/restart/network-outage tests.
3. **Licensing/redistribution needs vendor confirmation.** Obtain written terms
   covering WebAPI and any SecuSearch or SDK components on customer gym PCs.
4. **Subscription checkout is blocked by missing business decisions.** No plan
   catalog, approved pricing, or configured billing provider exists. The page
   only reports the stored status until those values are supplied.
5. **No database-backed integration tests were run.** Exercise tenant
   isolation, transaction rollback, deletion and financial retention,
   attendance concurrency/cooldown, overnight checkout, reporting boundaries,
   and migration behavior against a disposable replica-set database before
   production rollout.
6. **Biometric spoof protection and deployment validation remain incomplete.**
   Face-api.js does not provide liveness detection. Validate model startup and
   image processing on the target backend, any threshold/margin against an
   authorized, consented evaluation set, and transaction/concurrency behavior
   against a disposable replica-set database before production rollout. No
   production database was accessed or changed during this patch.

Do not treat this report as evidence that the full biometric system or
production acceptance suite is complete.
