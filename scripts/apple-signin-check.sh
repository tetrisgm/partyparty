#!/usr/bin/env bash
# Check that Sign in with Apple is actually wired, rather than assuming it.
#
# Apple's failure mode here is silence: a missing domain proof or a Services ID
# pointed at the wrong return URL produces a sign-in that simply never
# completes, with nothing in any log that says why. This asks the questions
# that have real answers.
set -euo pipefail

BASE="${1:-https://partyparty.party}"
fail=0
ok()   { printf '  ok    %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; fail=1; }

echo "==> $BASE"

# 1. The domain proof. NOT required for Sign in with Apple web auth - I assumed
#    it was, and Apple never asked: the Services ID's domain list is registered
#    directly, and the sender domain was verified by SPF when it was added as an
#    email source. The route stays because Apple Pay and other flows do use it,
#    so this reports rather than fails.
proof="$BASE/.well-known/apple-developer-domain-association.txt"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$proof" || echo 000)
if [ "$code" = "200" ]; then
  ok "domain association served (not required for sign-in)"
else
  printf '  note  no domain association file - not needed for Sign in with Apple\n'
fi

# 2. The route Apple will send the browser back to. It must exist and must not
#    be swallowed by the site Worker.
code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$BASE/auth/apple/callback" || echo 000)
if [ "$code" = "200" ] || [ "$code" = "302" ]; then
  ok "callback route reaches the platform Worker"
else
  bad "callback route returned $code - check the routes in cloudflare/app/wrangler.jsonc"
fi

# 3. Whether the Worker believes Apple is configured. /signin renders the
#    button only when every one of APPLE_CLIENT_ID, APPLE_TEAM_ID,
#    APPLE_KEY_ID and APPLE_SIWA_KEY is present.
if curl -s -m 10 "$BASE/signin" | grep -q 'href="/auth/apple"'; then
  ok "the Worker has all four Apple values"
else
  bad "the Worker is missing one of APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_SIWA_KEY"
fi

echo
if [ "$fail" = "0" ]; then
  echo "Sign in with Apple looks wired. The only thing left is to click it."
else
  echo "Not ready. Fix the FAILs above and run this again."
  exit 1
fi
