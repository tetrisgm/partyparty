#!/usr/bin/env bash
# Shared notarytool submission, retry, and failure-diagnostic helpers.

NOTARY_PROFILE="${PP_NOTARY_PROFILE:-pp-notary}"
NOTARY_MAX_ATTEMPTS=3

notary_output_value() {
  local key="$1"
  local output_file="$2"

  sed -nE "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"([^\"]+)\".*/\1/p" "$output_file" \
    | tail -n 1 \
    | tr -d '\r'
}

notary_submission_id() {
  local output_file="$1"
  local submission_id

  submission_id="$(notary_output_value id "$output_file")"
  if [ -z "$submission_id" ]; then
    submission_id="$(sed -nE 's/.*(^|[[:space:]])id:[[:space:]]*([^[:space:]]+).*/\2/p' "$output_file" \
      | tail -n 1 \
      | tr -d '\r')"
  fi
  printf '%s' "$submission_id"
}

notary_submission_status() {
  local output_file="$1"
  local status

  status="$(notary_output_value status "$output_file")"
  if [ -z "$status" ]; then
    status="$(sed -nE 's/.*[Ss]tatus:[[:space:]]*([^[:space:]]+).*/\1/p' "$output_file" \
      | tail -n 1 \
      | tr -d '\r')"
  fi
  printf '%s' "$status"
}

notary_failure_is_transient() {
  local output_file="$1"

  grep -Eiq \
    'timed? out|timeout|network|connection (was )?(reset|refused|closed|failed)|could not connect|couldn.t connect|could not resolve|unable to resolve|temporary failure|temporarily unavailable|service unavailable|internal server error|bad gateway|gateway timeout|request timeout|S3[^[:cntrl:]]*(failed|failure|error)|(failed|failure|error)[^[:cntrl:]]*S3|upload[^[:cntrl:]]*(failed|failure|error)|(failed|failure|error)[^[:cntrl:]]*upload|could not upload|couldn.t upload|unable to upload|HTTP[^[:cntrl:]]*5[0-9]{2}|status( code)?[^[:cntrl:]]*5[0-9]{2}|server returned[^[:cntrl:]]*5[0-9]{2}' \
    "$output_file"
}

notary_print_log() {
  local submission_id="$1"
  local label="$2"

  [ -n "$submission_id" ] || return 0
  echo ">> $label notarization log ($submission_id)"
  if ! xcrun notarytool log "$submission_id" --keychain-profile "$NOTARY_PROFILE"; then
    echo ">> unable to fetch the $label notarization log" >&2
  fi
}

notary_submit_with_retry() {
  local artifact="$1"
  local label="$2"
  local submission_id_file="$3"
  local attempt=1
  local delay_seconds=5
  local output_file
  local submit_rc
  local submission_id
  local status

  : > "$submission_id_file"

  while [ "$attempt" -le "$NOTARY_MAX_ATTEMPTS" ]; do
    output_file="$(mktemp "${TMPDIR:-/tmp}/partyparty-notary-${label}.XXXXXX")"
    echo ">> submitting $label to Apple notary service (attempt $attempt/$NOTARY_MAX_ATTEMPTS)"

    submit_rc=0
    if xcrun notarytool submit "$artifact" \
      --keychain-profile "$NOTARY_PROFILE" \
      --wait \
      --output-format json > "$output_file" 2>&1; then
      submit_rc=0
    else
      submit_rc=$?
    fi

    cat "$output_file"
    submission_id="$(notary_submission_id "$output_file")"
    status="$(notary_submission_status "$output_file")"
    if [ -n "$submission_id" ]; then
      printf '%s\n' "$submission_id" > "$submission_id_file"
      echo ">> $label submission id: $submission_id"
    fi

    if [ "$status" = "Accepted" ]; then
      if [ -z "$submission_id" ]; then
        echo ">> $label notarization was accepted but no submission id was returned" >&2
        rm -f "$output_file"
        return 1
      fi
      rm -f "$output_file"
      return 0
    fi

    # A rejected signature is deterministic; resubmitting the same artifact
    # only wastes time and hides the useful notary log.
    case "$status" in
      Invalid|Rejected)
        echo ">> $label notarization failed with terminal status: $status" >&2
        notary_print_log "$submission_id" "$label"
        rm -f "$output_file"
        return 1
        ;;
    esac

    if [ "$submit_rc" -ne 0 ] && notary_failure_is_transient "$output_file"; then
      if [ "$attempt" -lt "$NOTARY_MAX_ATTEMPTS" ]; then
        echo ">> transient $label notarization failure; retrying in ${delay_seconds}s" >&2
        rm -f "$output_file"
        sleep "$delay_seconds"
        attempt=$((attempt + 1))
        delay_seconds=$((delay_seconds * 2))
        continue
      fi
      echo ">> $label notarization still failing after $NOTARY_MAX_ATTEMPTS attempts" >&2
      notary_print_log "$submission_id" "$label"
      rm -f "$output_file"
      return 1
    fi

    if [ -n "$status" ]; then
      echo ">> $label notarization failed with status: $status" >&2
    else
      echo ">> $label notarization failed without a final status (exit $submit_rc)" >&2
    fi
    notary_print_log "$submission_id" "$label"
    rm -f "$output_file"
    return 1
  done
}
