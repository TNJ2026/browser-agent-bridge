# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-06-18

### Added
- **Python Native Host**: Rewrote the Native Messaging Host from Node.js (`host.js`) to a multi-threaded Python 3 implementation (`native/host.py`). Removed Node.js as a runtime dependency.
- **Iframe & Shadow DOM Support**: Upgraded accessibility tree traversal in `extension/content/accessibility-tree.js` to recursively traverse same-origin iframes and Shadow DOMs. Added offset-accumulation to project iframe elements' bounds back to top-level viewport coordinates.
- **Stable Extension ID**: Added `scripts/stabilize_extension_id.py` which generates a local stable private key (`key.pem`), injects it into `manifest.json`, and updates the Chrome Native Messaging manifest registration.
- **Unit and E2E Tests**:
  - `tests/test_host.py`: Unit tests for data URL decoding, folder confinement, token auth, and safe filenames.
  - `tests/test_doctor.py`: Unit tests for the doctor diagnosis checks.
  - `tests/test_smoke.py` / `tests/smoke_test.html`: Fully offline local E2E smoke test loading local HTML pages to verify query/click/type/select actions.
  - `scripts/test_e2e.py`: E2E verification test running against Wikipedia.
- **Version Bumping Script**: Added `scripts/bump-version.py` to automate Semantic Versioning increments.

### Fixed
- **Extension Memory Leak**: Fixed background memory leak in `extension/service-worker.js` by adding `chrome.tabs.onRemoved` listener to delete tab-bound console/network event buffers and auto-stop tab-scoped recordings when tabs are closed.
