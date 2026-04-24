# Changelog

## [2.0.0] - 2026-04-24

### Architecture
- **Modularized backend utilities**: Extracted validation, security, and process-runner logic into `lib/validation.js`, `lib/security.js`, and `lib/process-runner.js`.
- **Input validation layer**: All device serials, router IDs, actions, and usernames are now validated before processing. Invalid inputs return HTTP 400 instead of reaching PowerShell or the file system.
- **Path traversal guards**: Sanitization rejects `..`, absolute paths, and drive-colon segments in path parameters.

### Security
- **Renamed session cookie** from `phonefarm_session` to `routerfarm_session`.
- **Renamed IPC channels** in Electron from `phonefarm:*` to `routerfarm:*` (preload still exposes legacy bridge for compatibility).
- **Fixed AUTH_DISABLED initialization order bug**: `AUTH_DISABLED` is now evaluated after `settings` is loaded, respecting `settings.authDisabled` and `ROUTERFARM_AUTH_DISABLED` correctly.
- **Added `hashPassword` helper** in `lib/security.js` for programmatic user provisioning.
- **Hardened login endpoint** with username format validation.

### DevOps
- **Added GitHub Actions CI/CD** workflow (`.github/workflows/ci.yml`) for automated testing and desktop builds on Windows runners.

### Versioning
- Bumped version to **2.0.0** across `package.json`, `VERSION`, and frontend cache-busting strings.

### Notes
- Android IP Helper package name updated from `com.phonefarm.iphelper` to `com.routerfarm.iphelper`; APK must be rebuilt and reinstalled on all devices.
- PowerShell script pool remains the same; shared-module extraction is planned for v2.1.
