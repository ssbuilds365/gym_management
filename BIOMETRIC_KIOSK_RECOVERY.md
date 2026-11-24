# Biometric Kiosk Recovery

## Previous architecture

The repository's known working design used the kiosk as the single biometric attendance workflow:

- Angular loaded face-api.js tiny-face, landmark, and recognition models for camera guidance.
- The backend used the browser-captured JPEGs to generate face-api.js 128D descriptors.
- `BiometricCredential` stored encrypted descriptors with model version
  `face-api.js-v1-128d`.
- Kiosk credentials and signed kiosk sessions isolated device authorization.
- Staff enrollment and kiosk enrollment shared the tenant-scoped biometric identity service.
- Duplicate identity checks used Euclidean distance, and attendance check-in validated gym, member, membership, and existing attendance state.

Git history was audited back through the earliest biometric commits. Git did not contain a complete standalone recognition implementation that predates face-api.js or TensorFlow.js.

## Root cause

TensorFlow was added to the existing face-api.js implementation to enable backend/native inference. This created deployment, binary-loading, version-mismatch, and runtime compatibility failures, while preserving the same 128D face-api.js embedding space.

The code that introduced the native backend also attempted multiple backend fallbacks and had to account for Node, TensorFlow core, TensorFlow converter, and native package compatibility. This did not provide an independent legacy algorithm to recover.

### Current local kiosk error

The reported `400` response text, `A valid 128-value face template is required.`, is emitted by the persistence validator when `isValidDescriptor(descriptor)` is false. A valid descriptor is a JavaScript array with exactly 128 finite numbers, each within `[-2, 2]`, and a nonzero norm. The response itself does not reveal which predicate failed.

The local API process on port 5000 was started on November 23, 2026. Its error message does not match the current kiosk controller, which first calls `assertGeneratedDescriptor()` using the same validator and maps generation/persistence errors to distinct safe messages. Therefore the observed response came from a stale backend process relative to the current source, not from the current guarded enrollment path. Restart the backend so Node reloads the updated controller and recognition service. If a new `INVALID_FACE_DESCRIPTOR` appears, the development diagnostics below identify the failing predicate without logging descriptor values.

The actual enrollment payload contains three JPEG data URLs, the short-lived enrollment token, and the consent flag. The browser uses YuNet for camera guidance; it does not generate or submit a descriptor. The backend detects/alines each sample and generates the embedding with the SFace ONNX recognition model. `backend/models/onnx/face_recognition_sface_2021dec.onnx` and the YuNet model are present in the repository. Startup tests load the ONNX CPU sessions and test 128-value, finite, normalized SFace output. Git history contains the earlier face-api/TensorFlow approach and the later ONNX replacement; it contains no separate, TensorFlow-free older recognizer to restore.

YuNet expects BGR input, matching the browser detector and OpenCV reference preprocessing. The backend now packs decoded RGB camera pixels into BGR planes before detection. SFace receives its 112x112 aligned face in RGB order, matching the OpenCV SFace path that swaps BGR to RGB before inference.

Development logs report model readiness, decoded/captured frame dimensions, detection count, crop size, sample failure code, descriptor length, and finite/range validity only. They never log image bytes, descriptor values, member identifiers, or enrollment tokens. Production disables these development diagnostics.

### `INVALID_FACE_DESCRIPTOR` investigation

The reported `400 INVALID_FACE_DESCRIPTOR` is thrown by the shared persistence service when the generated descriptor is not an array of exactly 128 finite numbers, each with absolute value at most 2, and a nonzero norm. The frontend does not send an embedding. It sends captured JPEG samples, which the backend processes through SFace.

The kiosk request contract is:

```json
{
  "images": ["data:image/jpeg;base64,..."],
  "enrollmentToken": "short-lived enrollment token",
  "consentGranted": true
}
```

The staff registration request also sends `images` and `consentGranted`, plus its consent text version and explicit replacement choice. The frontend now checks that there are exactly three bounded JPEG data URLs before submitting either flow. The backend asserts that model output is a valid, normalized 128-value descriptor before calling the shared persistence service. A malformed model output is therefore reported as a recognition/template-generation `503`, not mislabeled as a malformed client-supplied descriptor.

With the current shared validator and these call paths, a descriptor rejected by persistence should already have been rejected by the controller assertion. The observed local process predates the guarded path, so the exact failed descriptor predicate is not recoverable from that stale response. Restart the local backend or deploy this revision; a reproduction against the current process will log the failed predicate metadata without exposing descriptor contents.

## Final replacement

TensorFlow.js and face-api.js were removed. The integrated system now uses:

- YuNet ONNX for backend and browser face detection.
- SFace ONNX for 128D face embedding generation.
- ONNX Runtime Node CPU on the backend.
- ONNX Runtime Web/WASM for frontend detector guidance.
- AES-256-GCM encrypted 128D templates.
- Cosine similarity with the SFace threshold `0.363`.
- Gym and member scoped transaction locks.

This is a biometric replacement, not face-detection-only functionality.

## Model compatibility

Existing face-api.js descriptors and SFace descriptors are both 128D but occupy incompatible embedding spaces. They are not silently compared.

Existing records remain encrypted in MongoDB. They are tagged as legacy `face-api.js-v1-128d` templates and reported by staff status as `MigrationRequired`. The member must be explicitly re-enrolled with fresh informed consent under the current SFace model version. No production record was modified.

## Face registration

Staff registration:

`POST /api/biometric/credentials/member/:memberId/face`

Kiosk enrollment:

`POST /api/kiosk/enrollment/face`

Both flows require valid samples and consent. The backend:

- Rejects invalid, overlarge, poor-quality, or multiple-face images.
- Requires a gym/tenant-matching active member.
- Requires explicit consent and a valid enrollment authorization.
- Generates exactly one averaged normalized 128D SFace embedding.
- Detects cross-member duplicate matches.
- Prevents accidental replacement unless replacement is explicitly authorized.
- Encrypts and stores the template in MongoDB.

Identifier-only kiosk self-enrollment remains disabled. A member identifier or phone number alone is not strong identity verification.

## Face identification

`POST /api/kiosk/face/identify`

The backend:

- Validates the kiosk session.
- Confirms face attendance is enabled for the gym.
- Generates and normalizes an SFace embedding.
- Compares only active, granted-consent templates using the current model version.
- Rejects unknown, ambiguous, and multiple-member identities.
- Returns a short-lived signed match proof bound to the gym, kiosk credential, member, and exact template.

## Duplicate face prevention

Duplicate checks are performed server-side against active current-model templates in the same gym. Records are tenant and business scoped. Gym transaction locking serializes enrollment and replacement. Ambiguous and cross-member matches fail closed.

## Attendance validation

The existing kiosk attendance flow must continue to validate:

- Authorized kiosk credential and active kiosk session.
- Gym/tenant ownership.
- Active member status.
- Membership validity and expiration.
- Existing open or current-period attendance.
- Duplicate attendance cooldown and concurrency.

QR check-in remains a separate workflow and was not removed.

## MongoDB data handling

Existing collections and records are preserved. Raw JPEG camera frames are transiently processed and are not stored by the biometric implementation. Biometric templates are AES-256-GCM encrypted.

Legacy face-api templates are retained and marked for re-enrollment. No collection, index, record, or production database was dropped or modified.

## Environment variables

Required or existing configuration:

- `PORT`
- `MONGODB_URI`
- `JWT_SECRET`
- `FRONTEND_URL`
- `KIOSK_TOKEN_SECRET`
- `BIOMETRIC_TEMPLATE_KEY`
- `NODE_ENV`

`BIOMETRIC_TEMPLATE_KEY` must decode to exactly 32 bytes. It must remain stable while encrypted templates exist.

Optional existing settings include `BIOMETRIC_KEY_VERSION`, `ALLOWED_ORIGINS`, and the SMTP/Razorpay configuration. No secret values are stored in this document or frontend source.

## Local setup

1. Use Node.js 22.23.5.
2. Install backend dependencies from `backend/package-lock.json`.
3. Install frontend dependencies from `frontend/package-lock.json`.
4. Configure the required server-side variables locally.
5. Start MongoDB and use a transaction-capable replica-set topology for biometric replacement operations.
6. Start the backend on port 5000.
7. Start Angular on port 4200.
8. Access the kiosk and member workflows only over localhost or HTTPS.

## Render deployment

1. Set Render runtime to Node 22.x.
2. Configure the backend root directory and install command.
3. Set the environment variable names listed above with deployment-specific values.
4. Keep the ONNX model files in `backend/models/onnx`.
5. Redeploy after changing dependencies or runtime configuration.
6. Keep `KIOSK_TOKEN_SECRET` and `BIOMETRIC_TEMPLATE_KEY` stable across redeployments.
7. Do not expose secrets in logs or frontend environment files.

### CPU-only ONNX Runtime install

The backend pins `onnxruntime-node@1.23.2`. Version 1.22.0's Linux x64 postinstall selected the CUDA 12 NuGet package by default and its Linux manifest incorrectly requested a file under `runtimes/win-x64`. Version 1.23.2 corrects the Linux package path, but still defaults to requesting CUDA extras on Linux.

Set the Render environment variable `ONNXRUNTIME_NODE_INSTALL=skip` before running the existing `npm install` build command. This skips those optional NuGet provider downloads. The 1.23.2 npm package already bundles `bin/napi-v6/linux/x64/libonnxruntime.so.1` and `onnxruntime_binding.node`, so CPU inference does not depend on the skipped CUDA/TensorRT provider files. Backend inference continues to explicitly select `executionProviders: ['cpu']`. Windows installs do not select a GPU manifest and do not require this variable.

The local Windows install completed on Node 22.23.5 and `require('onnxruntime-node')` loaded version 1.23.2; npm reported zero vulnerabilities. The install emitted a non-fatal cleanup warning because the already-running old backend held its previous ONNX DLL open. All 163 backend tests passed, including initialization of the detector and SFace sessions and normalized 128-value output from SFace using a synthetic aligned test input. This is a runtime smoke test, not a real-person recognition test. Render Linux deployment was not run; do not treat the local tests or package contents as proof of a successful Render deploy. Redeploy and confirm the Render build skips NuGet downloads, starts the backend, and initializes both ONNX sessions.

## Vercel and Android Chrome

- Deploy the frontend without secret environment values.
- Serve ONNX WASM and YuNet assets with the Angular build.
- Android Chrome camera access requires HTTPS and browser camera permission.
- Kiosk authorization must target the Render backend URL, not the Vercel origin.
- Camera streams open only when a capture or scan action starts.

## API endpoints

- `POST /api/biometric/credentials/member/:memberId/face`
- `DELETE /api/biometric/credentials/member/:memberId/face`
- `GET /api/biometric/credentials/status/:memberId`
- `GET /api/biometric/duplicates`
- `POST /api/biometric/kiosk-credentials`
- `GET /api/biometric/kiosk-credentials`
- `POST /api/biometric/kiosk-credentials/:id/rotate`
- `DELETE /api/biometric/kiosk-credentials/:id`
- `POST /api/kiosk/auth`
- `POST /api/kiosk/renew`
- `POST /api/kiosk/enrollment/face`
- `POST /api/kiosk/face/identify`
- `POST /api/kiosk/attendance/check-in`
- `POST /api/kiosk/qr/check-in`

## Testing and actual results

Verified locally on Windows with Node 22.23.5:

- Backend suite: 163 passed, 0 failed.
- Angular suite: 117 passed across 22 test files.
- ONNX Node and SFace model sessions initialize.
- SFace returns a normalized 128-value embedding.
- Synthetic blank images reject as `NO_FACE`.
- Angular production build passed.
- `npm audit` reported zero vulnerabilities in backend and frontend.
- Dependency trees contain `onnxruntime-node@1.23.2` and `onnxruntime-web@1.22.0`.
- No TensorFlow.js or face-api.js package remains in either lockfile.
- The final Angular bundle contains YuNet, YuNet license, and ONNX WASM runtime assets.
- The production Render `/api/health` endpoint returned `Healthy` during a read-only check.

Not verified:

- Real three-frame kiosk or staff enrollment using a consenting person.
- Real-member face enrollment accuracy.
- Real-face cross-person duplicate detection.
- MongoDB replica-set persistence.
- Render Linux binary loading.
- Android Chrome or desktop camera hardware.
- Physical attendance, membership renewal, and kiosk authorization against production.
- Vercel production asset delivery: HTTP HEAD checks for the YuNet model and ONNX WASM file returned the SPA `index.html`, not the expected static assets. The Vercel deployment/root configuration must be corrected or redeployed from the frontend build containing `dist/frontend/browser/models` and `assets/ort`, then verified by content type and bytes. `environment.production.ts` uses `/api`, and `frontend/vercel.json` rewrites that path to Render.

## Troubleshooting

- `BIOMETRIC_RECOGNITION_UNAVAILABLE`: verify ONNX model files and backend startup logs.
- `INVALID_FACE_IMAGE`: ensure the frontend sends a bounded JPEG data URL.
- `NO_FACE` or `MULTIPLE_FACES`: improve lighting, centering, and ensure one person is visible.
- `DUPLICATE_FACE_DETECTED`: compare or re-identify the member before registration.
- `FACE_REREGISTRATION_REQUIRED`: staff must explicitly re-enroll the legacy face record.
- `BIOMETRIC_TRANSACTION_REQUIRED`: configure MongoDB transactions/replica set.
- Kiosk authorization unavailable: verify kiosk token and credential configuration.

## Known limitations

- Neither YuNet nor SFace provides liveness detection.
- The replacement does not prove that a live person is present; it can still accept a replayed image.
- Real recognition thresholds require acceptance testing with representative approved data.
- Identifier-only kiosk self-enrollment is intentionally disabled.
