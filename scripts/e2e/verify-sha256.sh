#!/bin/sh
set -eu

[ "$#" -eq 2 ] || {
  printf '%s\n' 'usage: verify-sha256.sh FILE EXPECTED_SHA256' >&2
  exit 64
}

argus_sha_file=$1
argus_sha_expected=$2
[ -f "$argus_sha_file" ] && [ ! -L "$argus_sha_file" ] || {
  printf '%s\n' 'SHA-256 target must be a regular file' >&2
  exit 1
}
[ "$(printf '%s' "$argus_sha_expected" | grep -Ec '^[a-f0-9]{64}$')" = 1 ] || {
  printf '%s\n' 'expected SHA-256 must be 64 lowercase hexadecimal characters' >&2
  exit 64
}

argus_sha_actual=$(sha256sum "$argus_sha_file" | awk 'NR == 1 { print $1 }')
[ "$argus_sha_actual" = "$argus_sha_expected" ] || {
  printf '%s\n' 'SHA-256 mismatch' >&2
  exit 1
}
