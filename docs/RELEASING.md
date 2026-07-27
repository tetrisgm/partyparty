# Releasing

Verified product work lands on clean `main` and is pushed once. Releases are Mac
App Store submissions; there is no background direct-distribution ship daemon.

Before uploading:

```sh
go build ./... && go vet ./... && go test ./...
(cd app && swift build)
(cd cloudflare && node test/smoke.mjs)
scripts/test-app-store.sh
```

Create the signed package with `scripts/package-app-store.sh`, validate it, and
upload that exact package to App Store Connect. Worker or website changes are
deployed independently with Wrangler after their tests pass.
