# SecuGen HU20 SDK discovery and verification

**Audit date:** 2026-11-03  
**Scope:** Read-only SDK discovery and documentation review. No enrollment,
identification, application integration, or source changes were performed.

## Executive result

The PC has the **64-bit SecuGen WebAPI over HTTPS for Windows v1.1.0.16**
capture client installed. The vendor's v1.1 documentation supports fingerprint
image/template capture, client-side 1:1 matching, and the HU20 family. A running
`sgibiosrv.exe` process listens on TCP 8443, and the official WebAPI demo source
uses HTTPS `POST` to `/SGIFPCapture` on that port.

**This is not evidence that 1:N identification works on this PC.** SecuGen
documents 1:N as a separate server-side product made from WebAPI plus
**SecuSearch Pro 3**. The SecuSearch engine/libraries were not found in the
searched installation locations. The official 1:N manual also requires server
configuration and privileges not verified here. No capture request was sent to
the local scanner endpoint, and no HU20 1:1 or 1:N match was run. The user's
reported successful SGDX scan is retained as user-provided evidence, not an
independently repeated test.

## Installed environment evidence

| Item | Verified value |
|---|---|
| Windows | Windows 11 Home Single Language, 64-bit, build 26200 |
| Installed product | `SecuGen WebAPI over HTTPS for Windows ver. 1.1.0.16 64-bit` |
| WebAPI client path | `C:\Program Files\SecuGen\SgiBioSrv\sgibiosrv.exe` |
| WebAPI process | `sgibiosrv.exe`, running in session 1; not registered with Windows Service Control Manager (`tasklist /svc` reported `N/A`) |
| Installed client version | File/product version `1.1.0.16` |
| Local listener | `0.0.0.0:8443`, owned by `sgibiosrv.exe` |
| HTTP observation | HTTPS `HEAD /` timed out; HTTP `HEAD /` was reset. No capture path was invoked in this audit. |
| Diagnostic tool | `C:\Users\suraj\Downloads\SGDX_v508\sgdx_v508.exe`, file version `5.0.8.0`, product version `5.0.0.0`; its Authenticode signature validated to SecuGen Corporation |
| WebAPI installer | `C:\Users\suraj\Downloads\SGI_BWAPI_Win_64bit.exe`, version `1.1.0.16`; its Authenticode signature validated to SecuGen Corporation |
| Driver package | Registry lists `SecuGen-x64-Windows-Drivers` v`3.0.0.2`. The connected device currently reports driver `1.4.9.1`, provider SecuGen, INF `oem61.inf`, service `SGFDU05`. |
| Connected device | Device Manager/PnP name `SecuGen U20 USB FRD`; USB `VID_1162`, `PID_2200`. The owner identifies the product as HU20. |
| Installed WebAPI files | `sgibiosrv.exe`, SecuGen fingerprint libraries (`sgfplib.dll`, `sgfpamx.dll`), OpenSSL libraries, certificates, and `sgiwebsrv.lic` are present under the client directory. The license file contents were not read or disclosed. |

The downloaded `WinDrivers_v3003_Installer.zip` and its SecuGen driver PDF were
also present. Common Windows install/data folders, Downloads, Desktop/OneDrive
Desktop, and both `gym-management` and `gym-website-repo` project folders were
searched by SecuGen/WebAPI/SGDX/HU20/SecuSearch-related names. No SecuSearch
engine, WebAPI 1:N server installation, SDK sample project, or local WebAPI
programmer manual was found in those locations. The WebAPI and driver versions
above come from installed-app metadata, binary version metadata, and the
connected device's PnP properties.

The local listener is bound to all IPv4 interfaces (`0.0.0.0`), rather than
loopback only. This is an observed exposure surface, not a confirmed exploitable
vulnerability: no network access-control test was performed. Before production,
restrict the listener with vendor-supported configuration and Windows Firewall
rules, and confirm the required browser-origin policy.

## Official documentation and sources

The following SecuGen-published sources were reviewed on 2026-11-03:

1. [SecuGen WebAPI Programmer's Manual, SDK v1.1, document SG1-0121A-008](https://webapi.secugen.com/docs/SECUGEN_WEB_SERVICE_API_DOC.pdf)
2. [SecuGen WebAPI 1:N Programmer's Manual, SDK v1.1, document SG1-0121N-000](https://webapi-1-n.secugen.com/docs/SECUGEN_WEB_SERVICE_API_DOC.pdf)
3. [Official WebAPI Demo 1 page](https://webapi.secugen.com/Demo1) and its linked [Demo 1 sample page](https://webapi.secugen.com/Demo1.aspx)
4. [SecuGen WebAPI product page](https://secugen.com/products/webapi/)
5. [SecuSearch Pro 3 product page](https://secugen.com/products/secusearch/)
6. [SecuGen SDK product page](https://secugen.com/products/sdk/)
7. [Official WebAPI 1:N demo site](https://webapi-1-n.secugen.com/)

The manuals identify SDK version 1.1 and document the product interfaces. They
do not establish that the exact binaries currently installed were used in the
manual's demonstrations. The installed v1.1.0.16 client version is independently
verified from this PC's registry and file metadata.

## Verified WebAPI protocol and API contract

### Browser-to-local-client capture

The standard WebAPI manual describes a REST-style web service using JSON
responses. It documents the `SGIFPCapture` route as
`https://localhost:8000/SGIFPCapture`, with port 8000 as the documented default
and a note that configuration may change the port. The SecuGen Demo 1 sample
source explicitly constructs
`https://localhost:8443/SGIFPCapture`, uses `XMLHttpRequest.open("POST", ...)`,
and submits form-encoded parameters. This agrees with the observed local listener
port, but the local endpoint itself was not called during this audit.

Documented capture inputs include:

- `Timeout` (default 10,000 ms);
- `TemplateFormat` (`ISO` or `ANSI`, default `ISO`);
- `ImageWSQRate`;
- fake-finger-detection setting; and
- a domain license string (`Licstr`/`licstr`).

The official sample also supplies `Quality`. The capture response is JSON and
includes an error code and device metadata, with fields that can include
`ImageDataBase64`, `BMPBase64`, `WSQImage`, and `TemplateBase64`. The manual says
the template may be encrypted when a session-key parameter is used; its
application-level encryption details and key exchange still need review before
relying on it.

**Privacy implication:** the standard WebAPI deliberately returns image and
template material to its caller. Calling it from Angular would put those values
in the browser's JavaScript/response path. That conflicts with the existing
requirement not to expose biometric templates to Angular. A future integration
must keep the WebAPI response inside a controlled local native/helper process
and send only the minimum required result to the backend; do not bind template
responses to ordinary frontend API responses or browser storage.

### Client-side 1:1 matching

The manual documents `SGIMatchScore`, which accepts two Base64 templates and a
template format (`ISO` or `ANSI`) and returns a JSON `MatchingScore` from 0 to
199 (199 is described as very close to identical). It documents a default URI
of `https://localhost:8000/SGIMatchScore`; the port may be configured. This is a
two-template comparison, not a search across an enrolled member population.
The score is not itself a membership identity or an attendance decision.

The WebAPI product page describes this original WebAPI version as client-side
1:1 matching. The separate SecuGen FDx SDK Pro product is also documented as a
low-level capture, minutiae extraction, and 1:1 SDK; it is not the 1:N engine.

### Separate server-side 1:N engine

The official WebAPI 1:N manual describes WebAPI 1:N as a combination of:

- WebAPI for capture/template generation; and
- **SecuSearch Pro 3** for 1:N search on a server.

The 1:N product page and manual identify server-side 1:N matching and candidate
search. The manual's SecuSearch interface includes the following documented
operations:

- `RegisterFP` / `RegisterFPBatch` to add template IDs and templates;
- `IdentifyFP` to find a match at a selected security level;
- `SearchFP` to return possible matching candidates;
- `RemoveFP` / `RemoveFPBatch` to remove templates;
- `GetTemplate` to retrieve a stored template; and
- `SaveFPDB` / `LoadFPDB` to persist and reload the in-memory fingerprint
  database.

The documented SecuSearch registration format is SecuGen `SG400`; the manual
also describes `ExtractTemplate` to convert a view in ANSI 378 or ISO 19794
input to an SG400 template. That is a compatibility and conversion step that
must be tested against the exact captured templates before adopting the
encrypted Phase 2 storage format. The SecuSearch index is in memory and the
manual says it should be saved to disk periodically. It does not establish that
the saved index is encrypted at rest.

The 1:N interface documented in this manual is the SecuSearch server-side
.NET API, not an `SGIMatchScore` endpoint. The manual does not provide a complete
HTTP route/method contract for a custom WebAPI 1:N server integration. Use the
vendor's matching server sample/installation package or obtain the missing
server integration details from SecuGen; do not infer a 1:N REST endpoint from
the capture route.

## Capability matrix

“Documented” indicates a vendor manual or product page explicitly describes the
feature. “Observed/tested here” distinguishes installed components from an
actual HU20 integration test.

| Capability | Vendor-documented support | Verified on this PC / HU20 | Result |
|---|---|---|---|
| Fingerprint image capture | `SGIFPCapture` returns image fields; HU20 family listed as supported. | Owner reports scan works in SGDX. No WebAPI capture request was made. | **PASS — documented; BLOCKED — WebAPI-on-HU20 retest** |
| Template extraction | Capture API returns a Base64 template; `ISO` and `ANSI` formats documented. | No template was captured or inspected in this audit. | **PASS — documented; BLOCKED — device/API retest** |
| Template persistence | Application may store returned templates; SecuSearch offers `SaveFPDB`/`LoadFPDB`. | No biometric data was created or persisted. SecuSearch was not found. | **PASS — API capability; BLOCKED — installed engine/configuration** |
| 1:1 verification | `SGIMatchScore` compares two templates and returns a score. | No HU20 1:1 comparison was performed. | **PASS — documented; BLOCKED — actual match test** |
| 1:N identification | Separate WebAPI 1:N + SecuSearch product documents `IdentifyFP` and `SearchFP`. | No SecuSearch engine or 1:N server installation found; no actual identification test. | **PASS — separate product capability; FAIL — installed 1:N engine absent; BLOCKED — HU20 identification test** |
| Multiple fingers | WebAPI product page lists multiple-finger capture/enroll; SecuSearch registration accepts multiple template IDs/batches. The single `SGIFPCapture` manual entry describes a single scan. | No multi-finger workflow was tested. | **PASS — separate template registrations documented; BLOCKED — exact multi-finger enrollment workflow/API** |
| Template export/import | Capture returns a transferable template; SecuSearch exposes `GetTemplate`, `RegisterFP`, and database load/save operations. | No import/export run. | **PASS — documented data operations; BLOCKED — actual format/interoperability test** |
| Local 1:1 matching | Original WebAPI provides client-side 1:1 matching. | SDK score call not run locally. | **PASS — documented; BLOCKED — local HU20 match test** |
| Local 1:N matching | 1:N is supported by SecuSearch on the server side; it is not part of the installed WebAPI client alone. | SecuSearch files/configuration not located. | **FAIL — with currently discovered installation; separate Windows engine required** |
| HU20 and Windows 11 compatibility | Both WebAPI and WebAPI 1:N manuals list HU20 (including HU20 variants); WebAPI product page lists Windows 11 64-bit. | Windows 11 and a SecuGen U20 USB FRD device/driver are present; device family is consistent with the owner's HU20 identification. | **PASS — documentation and device enumeration; BLOCKED — direct SDK capture test** |
| Windows Service operation | Manuals describe a WebAPI client and a server-side engine, but do not state that the scanner client supports Windows Service/Session 0 operation. | `sgibiosrv.exe` runs in session 1 and is not an SCM service. | **BLOCKED — vendor confirmation required** |

## Licensing and redistribution

- Both v1.1 WebAPI manuals state that a license key is required for each domain
  hosting the web application; without a key, the WebAPI service works for a
  limited 60-day period. The current WebAPI product page describes the scope as
  each subdomain. No key or license-file content is reproduced in this report.
- The WebAPI 1:N manual states that the SecuSearch in-memory database supports
  up to 1,000 templates without a SecuSearch license; more than 1,000 requires a
  license. SecuGen's SecuSearch Pro 3 product page advertises commercial
  licensing up to 2 million templates.
- The manuals state that the software is supplied under a license agreement or
  NDA and must be used under those terms. The public materials reviewed do not
  settle redistribution/OEM rights, number of customer-gym installations,
  per-device versus per-domain entitlements, the 1:N license treatment for a
  SaaS tenant base, or whether the local capture client can be bundled with SS
  Fitness Manager.
- **Before customer deployment:** obtain written SecuGen confirmation and the
  applicable commercial license for the WebAPI client, SecuSearch 1:N engine,
  template volume, domain/subdomain arrangement, customer installations,
  redistribution, and support. Do not rely on the 60-day mode in production.

## Windows Service and unattended-start findings

The running `sgibiosrv.exe` process is in session 1, is not associated with a
Windows Service Control Manager entry, and `tasklist /svc` reports no service
for it. The manuals call SgiBioSrv the WebAPI client/service and describe an
HTTPS localhost API, but do not say whether it can run as a Windows Service,
whether it needs an interactive desktop, or what happens after user logout or
startup without sign-in. These observations do **not** prove that Session 0 is
unsupported.

For the 1:N server component, the manual explicitly requires SecuSearch
libraries on the Windows PATH and grants the engine account the Windows
**“Lock pages in memory”** privilege. It instructs periodic in-memory database
save/reload. This is a separate requirement from scanner capture and does not
make the SgiBioSrv client a Windows Service.

## Blockers and missing dependencies

1. **1:N engine missing:** no SecuSearch Pro 3 library, server installation, or
   WebAPI 1:N server configuration was located. The installed product entry is
   the original WebAPI over HTTPS client.
2. **No 1:N integration sample locally:** public docs describe SecuSearch .NET
   methods, but the exact hosted/custom server integration endpoints and
   complete sample project are not part of the local installation.
3. **No real SDK endpoint test:** only the listener was observed. The documented
   capture route was not called because a capture could acquire biometric data
   and requires an intentional device test. Root requests are not a valid test
   of the documented API route.
4. **No 1:1/1:N matching test:** the user's prior demo has not established a
   successful 1:N identification. No synthetic or dummy template was used.
5. **Session model unknown:** SecuGen has not confirmed service/Session 0,
   logoff, reboot, or unattended USB access requirements for this client/driver.
6. **Production licensing unresolved:** per-domain WebAPI and SecuSearch
   licensing/redistribution must be agreed before deployment.
7. **Template/index protection unresolved:** vendor docs describe returned
   Base64 templates and SecuSearch database persistence but do not establish
   encryption-at-rest for the `.tbd`/in-memory database or secure
   synchronization. This must be reconciled with SS Fitness Manager's
   encrypted-template requirement.
8. **1:N host mismatch risk:** the documented SecuSearch integration is a
   Windows-side .NET/native library with Windows PATH and memory-lock
   requirements. Do not assume it can be loaded by the current Node/Express
   Render deployment; validate a supported Windows host/sidecar design with
   SecuGen.
9. **Listener network exposure:** the local listener is bound to all IPv4
   interfaces. Verify supported bind/origin controls and restrict firewall
   access before using it with production member data.

## Recommended integration architecture

1. Keep the existing backend and Angular application free of SecuGen-specific
   behavior until the customer/deployment license and supported 1:N runtime are
   confirmed.
2. For future capture, use a small Windows-side native/helper process in the
   context SecuGen supports. It should call the documented local HTTPS client
   and keep image/template bytes out of Angular, logs, browser storage, and
   ordinary attendance responses. Have it send a short-lived authenticated
   result/template directly to the backend over TLS only after the biometric
   trust boundary has been designed.
3. For 1:N, obtain the WebAPI 1:N/SecuSearch package and sample. Initially
   evaluate a dedicated Windows-side SecuSearch host close to the scanner,
   isolated per gym tenant, with encrypted enrollment/index storage and a
   tested removal/update path. Do not send all templates to Angular or assume
   Render can load the Windows matching libraries.
4. Make a deliberate deployment choice only after SecuGen confirms whether
   SgiBioSrv can run unattended as a service. If only interactive-session
   operation is supported, document the logged-in user/startup dependency and
   do not represent the installation as 24/7 service-ready.
5. Verify the supported license model, exact 1:N service contract, template
   formats/conversion, matching thresholds, local storage security, and
   redistribution rights in writing before implementation.

## Next steps

1. Ask SecuGen for the commercial WebAPI 1:N/SecuSearch Pro 3 Windows package,
   server integration sample, full deployment license terms, and confirmation
   for HU20/PID `VID_1162&PID_2200`.
2. Ask specifically whether SgiBioSrv and SecuSearch can run as Windows
   Services under Session 0, and whether scanner capture remains available
   after logout/reboot without an interactive user.
3. On a scheduled device test, verify capture from the documented API using a
   consenting test operator; record only non-biometric status/version facts,
   not image/template contents.
4. Run two controlled, consented 1:1 tests (match and non-match), then a real
   1:N registration/identify/non-match test against the actual HU20 and the
   licensed SecuSearch build. Record the exact component versions and test
   results. Do not promote 1:N until these pass.
5. Validate ISO/ANSI-to-SG400 conversion, multiple fingers mapped to one member,
   persistent index restart/recovery, template deletion propagation, index
   encryption, and tenant separation.
6. Only after these checks, design the Windows agent and its backend trust,
   replay/idempotency, offline queue, origin, firewall, and audit controls.

## Final PASS / FAIL / BLOCKED summary

- **PASS (documentation):** HU20 family is listed as supported; Windows 11
  64-bit is listed for WebAPI; capture, image/template extraction, template
  formats, and client-side 1:1 are documented.
- **PASS (documentation):** SecuGen provides a separate server-side 1:N product
  based on SecuSearch Pro 3, with registration, identify/search, removal, and
  index persistence APIs.
- **PASS (local enumeration):** the signed 64-bit WebAPI v1.1.0.16 installer
  and client are present, `sgibiosrv.exe` is running, the HU20-family SecuGen
  device is enumerated, and the process owns TCP 8443.
- **FAIL (current discovered installation):** SecuSearch 1:N engine/server
  components were not found; installed WebAPI client alone is not the documented
  1:N solution.
- **BLOCKED (actual HU20 WebAPI verification):** no WebAPI capture/template
  request was executed against the connected device in this audit.
- **BLOCKED (actual 1:1 verification):** no template pair was matched on HU20.
- **BLOCKED (actual 1:N verification):** no SecuSearch engine is installed or
  configured here, and no HU20 1:N identification test passed.
- **BLOCKED (unattended service suitability):** vendor documentation does not
  settle Windows Service/Session 0 or user-session requirements; observed
  SgiBioSrv is a session-1 process, not an SCM service.
- **BLOCKED (customer deployment):** WebAPI/SecuSearch commercial licensing,
  redistribution, and per-customer deployment rights need written vendor
  confirmation.
