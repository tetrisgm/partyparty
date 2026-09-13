# Apple release work

- Apple work uses `asc`; start with `asc review doctor`. It reads `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY_PATH`; no custom API clients. Read exact App Review feedback first and classify binary/metadata/notes/account issues before code changes. Fix the requested issue before tooling work. Every submission requires owner intent (`APP_STORE_UPLOAD=1`/manual dispatch).
- Store builds require Apple-released macOS and `scripts/package-app-store.sh` for archive/export/verification. Never mix Sparkle, Developer ID entitlements, or standalone metadata into Store targets.
