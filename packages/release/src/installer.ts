import { createPublicKey } from "node:crypto";
import { isSafeReleaseAssetUrl } from "./manifest.js";

export interface InstallerOptions {
  manifestUrl: string;
  publicKeyPem: string;
}

const canonicalEd25519PublicKey = (pem: string): string => {
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    return key.export({ type: "spki", format: "pem" }).toString().trim();
  } catch {
    throw new TypeError(
      "Argus installer public key must be an Ed25519 SPKI PEM public key.",
    );
  }
};

const shellLiteral = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

export function renderInstaller(options: InstallerOptions): string {
  if (!isSafeReleaseAssetUrl(options.manifestUrl)) {
    throw new TypeError(
      "Argus installer manifest URL must be credential-free HTTPS with a valid host, optional port 1-65535, and explicit shell-safe path.",
    );
  }
  const publicKey = canonicalEd25519PublicKey(options.publicKeyPem);

  return `#!/bin/sh
set -eu

# Generated Argus stable installer. The embedded Ed25519 key is the trust root.
argus_default_manifest_url=${shellLiteral(options.manifestUrl)}
argus_default_target=/usr/local/bin/argus
argus_docker_key_fingerprint=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
argus_tmp=
argus_lock=
argus_target_tmp=
argus_backup_tmp=
argus_github_headers=

argus_die() {
  printf '%s\\n' "argus installer: $*" >&2
  exit 1
}

argus_cleanup() {
  if [ -n "$argus_target_tmp" ]; then
    if [ -w "$(dirname "$argus_target_tmp")" ]; then
      rm -f -- "$argus_target_tmp" 2>/dev/null || true
    elif command -v sudo >/dev/null 2>&1; then
      sudo -n rm -f -- "$argus_target_tmp" >/dev/null 2>&1 || true
    fi
  fi
  if [ -n "$argus_backup_tmp" ]; then
    if [ -w "$(dirname "$argus_backup_tmp")" ]; then
      rm -f -- "$argus_backup_tmp" 2>/dev/null || true
    elif command -v sudo >/dev/null 2>&1; then
      sudo -n rm -f -- "$argus_backup_tmp" >/dev/null 2>&1 || true
    fi
  fi
  if [ -n "$argus_lock" ]; then
    if [ -w "$(dirname "$argus_lock")" ]; then
      rmdir -- "$argus_lock" 2>/dev/null || true
    elif command -v sudo >/dev/null 2>&1; then
      sudo -n rmdir -- "$argus_lock" >/dev/null 2>&1 || true
    fi
  fi
  if [ -n "$argus_tmp" ]; then
    rm -rf -- "$argus_tmp"
  fi
}
trap argus_cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

argus_read_os_release() {
  argus_os_file=\${ARGUS_INSTALL_OS_RELEASE:-/etc/os-release}
  [ -f "$argus_os_file" ] || argus_die "cannot read $argus_os_file"
  [ ! -L "$argus_os_file" ] || argus_die "refusing symlinked os-release file"
  argus_os_id=
  argus_os_version=
  argus_os_codename=
  argus_ubuntu_codename=
  while IFS= read -r argus_os_line || [ -n "$argus_os_line" ]; do
    case "$argus_os_line" in
      ID=*) argus_os_id=\${argus_os_line#ID=} ;;
      VERSION_ID=*) argus_os_version=\${argus_os_line#VERSION_ID=} ;;
      VERSION_CODENAME=*) argus_os_codename=\${argus_os_line#VERSION_CODENAME=} ;;
      UBUNTU_CODENAME=*) argus_ubuntu_codename=\${argus_os_line#UBUNTU_CODENAME=} ;;
    esac
  done < "$argus_os_file"
  case "$argus_os_id" in
    \\"*\\") argus_os_id=\${argus_os_id#\\"}; argus_os_id=\${argus_os_id%\\"} ;;
    \\'*\\') argus_os_id=\${argus_os_id#\\'}; argus_os_id=\${argus_os_id%\\'} ;;
  esac
  case "$argus_os_version" in
    \\"*\\") argus_os_version=\${argus_os_version#\\"}; argus_os_version=\${argus_os_version%\\"} ;;
    \\'*\\') argus_os_version=\${argus_os_version#\\'}; argus_os_version=\${argus_os_version%\\'} ;;
  esac
  case "$argus_os_codename" in
    \\"*\\") argus_os_codename=\${argus_os_codename#\\"}; argus_os_codename=\${argus_os_codename%\\"} ;;
    \\'*\\') argus_os_codename=\${argus_os_codename#\\'}; argus_os_codename=\${argus_os_codename%\\'} ;;
  esac
  case "$argus_ubuntu_codename" in
    \\"*\\") argus_ubuntu_codename=\${argus_ubuntu_codename#\\"}; argus_ubuntu_codename=\${argus_ubuntu_codename%\\"} ;;
    \\'*\\') argus_ubuntu_codename=\${argus_ubuntu_codename#\\'}; argus_ubuntu_codename=\${argus_ubuntu_codename%\\'} ;;
  esac
  case "$argus_os_id:$argus_os_version:$argus_os_codename:$argus_ubuntu_codename" in
    *[!A-Za-z0-9._:-]*) argus_die "unsafe value in os-release" ;;
  esac
  case "$argus_os_id:$argus_os_version" in
    ubuntu:22.04) argus_codename=jammy ;;
    ubuntu:24.04) argus_codename=noble ;;
    ubuntu:25.10) argus_codename=questing ;;
    ubuntu:26.04) argus_codename=resolute ;;
    debian:12) argus_codename=bookworm ;;
    debian:13) argus_codename=trixie ;;
    ubuntu:*) argus_die "unsupported Ubuntu version $argus_os_version (supported: 22.04, 24.04, 25.10, 26.04)" ;;
    debian:*) argus_die "unsupported Debian version $argus_os_version (supported: 12, 13)" ;;
    *) argus_die "unsupported operating system $argus_os_id (supported: Ubuntu and Debian)" ;;
  esac
  if [ "$argus_os_id" = ubuntu ] && [ -n "$argus_ubuntu_codename" ] && [ "$argus_ubuntu_codename" != "$argus_codename" ]; then
    argus_die "Ubuntu codename does not match VERSION_ID"
  fi
  if [ -n "$argus_os_codename" ] && [ "$argus_os_codename" != "$argus_codename" ]; then
    argus_die "distribution codename does not match VERSION_ID"
  fi
}

argus_detect_arch() {
  case "$(uname -m 2>/dev/null || true)" in
    x86_64|amd64) argus_arch=amd64 ;;
    aarch64|arm64) argus_arch=arm64 ;;
    *) argus_die "unsupported architecture (supported: x86_64/amd64 and aarch64/arm64)" ;;
  esac
}

argus_validate_asset_url() {
  printf '%s\\n' "$1" | LC_ALL=C awk '
    $0 !~ /^https:\\/\\/[A-Za-z0-9.-]+(:[0-9]+)?\\/[A-Za-z0-9._~%+-][A-Za-z0-9._~\\/%+-]*$/ { exit 1 }
    {
      value = substr($0, 9)
      slash = index(value, "/")
      authority = substr(value, 1, slash - 1)
      path = substr(value, slash + 1)
      if (path == "") exit 1
      colon = index(authority, ":")
      host = colon > 0 ? substr(authority, 1, colon - 1) : authority
      if (colon > 0) {
        port = substr(authority, colon + 1)
        if (port !~ /^[1-9][0-9]*$/ || length(port) > 5 || port + 0 > 65535) exit 1
      }
      count = split(host, labels, ".")
      if (count < 2) exit 1
      for (i = 1; i <= count; i++) {
        if (length(labels[i]) < 1 || length(labels[i]) > 63) exit 1
        if (labels[i] !~ /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/) exit 1
      }
    }
  '
}

argus_validate_manifest_url() {
  case "$1" in
    https://*) argus_validate_asset_url "$1" ;;
    http://127.0.0.1:*|http://localhost:*)
      [ "\${ARGUS_INSTALL_FIXTURE:-0}" = 1 ] &&
        printf '%s\\n' "$1" |
          LC_ALL=C grep -Eq '^http://(127\\.0\\.0\\.1|localhost):[1-9][0-9]{0,4}/[A-Za-z0-9._~%+-][A-Za-z0-9._~/%+-]*$'
      ;;
    *) return 1 ;;
  esac
}

argus_read_os_release
argus_detect_arch
argus_manifest_url=\${ARGUS_MANIFEST_URL:-$argus_default_manifest_url}
argus_validate_manifest_url "$argus_manifest_url" ||
  argus_die "ARGUS_MANIFEST_URL must use the production HTTPS grammar (loopback HTTP requires ARGUS_INSTALL_FIXTURE=1)"
argus_target=\${ARGUS_INSTALL_TARGET:-$argus_default_target}
case "$argus_target" in
  /*) ;;
  *) argus_die "installation target must be absolute" ;;
esac
printf '%s\\n' "$argus_target" | LC_ALL=C grep -Eq '^/[A-Za-z0-9._/+:-]+$' ||
  argus_die "unsafe installation target"

case "\${ARGUS_INSTALL_INSPECT:-0}" in
  1)
    printf '%s\\n' "Argus installer inspection"
    printf '%s\\n' "  platform: $argus_os_id $argus_os_version ($argus_arch)"
    printf '%s\\n' "  signed manifest: $argus_manifest_url"
    printf '%s\\n' "  target: $argus_target"
    if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
      printf '%s\\n' "  Docker Engine and Compose: usable"
    else
      printf '%s\\n' "  Docker Engine and Compose: installation or access may be required"
    fi
    printf '%s\\n' "No files were downloaded or changed."
    exit 0
    ;;
  0|'') ;;
  *) argus_die "ARGUS_INSTALL_INSPECT must be 0 or 1" ;;
esac

command -v curl >/dev/null 2>&1 || argus_die "curl is required"
command -v openssl >/dev/null 2>&1 || argus_die "OpenSSL with Ed25519 pkeyutl support is required"
argus_openssl_major=$(openssl version 2>/dev/null | awk '$1 == "OpenSSL" { split($2, parts, "."); print parts[1]; exit }')
[ -n "$argus_openssl_major" ] && [ "$argus_openssl_major" -ge 3 ] ||
  argus_die "OpenSSL 3 or newer is required (supported Ubuntu and Debian releases provide it)"
openssl pkeyutl -help 2>&1 | grep -q -- -rawin || argus_die "OpenSSL is too old; install a version with pkeyutl -rawin support"
command -v sha256sum >/dev/null 2>&1 || argus_die "sha256sum is required"
command -v mktemp >/dev/null 2>&1 || argus_die "mktemp is required"
command -v sync >/dev/null 2>&1 || argus_die "sync from GNU coreutils is required"
argus_requested_lock=\${ARGUS_INSTALL_LOCK:-\${TMPDIR:-/tmp}/argus-installer.lock}
printf '%s\\n' "$argus_requested_lock" | LC_ALL=C grep -Eq '^/[A-Za-z0-9._/+:-]+$' ||
  argus_die "unsafe installer lock path"
mkdir "$argus_requested_lock" 2>/dev/null || argus_die "another Argus installation is in progress"
argus_lock=$argus_requested_lock
argus_tmp=$(mktemp -d "\${TMPDIR:-/tmp}/argus-install.XXXXXX") || argus_die "could not create temporary directory"
chmod 700 "$argus_tmp"

if [ -n "\${ARGUS_GITHUB_TOKEN:-}" ]; then
  command -v jq >/dev/null 2>&1 || argus_die "GitHub token requires jq"
  printf '%s\\n' "$ARGUS_GITHUB_TOKEN" | LC_ALL=C grep -Eq '^[A-Za-z0-9_]+$' ||
    argus_die "ARGUS_GITHUB_TOKEN contains unsafe characters"
  argus_github_headers="$argus_tmp/github.headers"
  {
    printf 'Authorization: Bearer %s\\n' "$ARGUS_GITHUB_TOKEN"
    printf '%s\\n' 'X-GitHub-Api-Version: 2022-11-28'
  } > "$argus_github_headers"
  chmod 600 "$argus_github_headers"
fi

cat > "$argus_tmp/release-public.pem" <<'ARGUS_RELEASE_PUBLIC_KEY'
${publicKey}
ARGUS_RELEASE_PUBLIC_KEY
chmod 600 "$argus_tmp/release-public.pem"

case "$argus_manifest_url" in
  */manifest.json) argus_signature_url=\${argus_manifest_url%manifest.json}manifest.sig ;;
  *) argus_signature_url=$argus_manifest_url.sig ;;
esac

argus_curl() {
  argus_fetch_url=$1
  argus_fetch_output=$2
  if [ -n "$argus_github_headers" ]; then
    case "$argus_fetch_url" in
      https://github.com/*/*/releases/download/*/*)
        argus_github_path=\${argus_fetch_url#https://github.com/}
        argus_github_owner=\${argus_github_path%%/*}
        argus_github_path=\${argus_github_path#*/}
        argus_github_repo=\${argus_github_path%%/*}
        argus_github_path=\${argus_github_path#*/releases/download/}
        argus_github_tag=\${argus_github_path%%/*}
        argus_github_asset=\${argus_github_path#*/}
        printf '%s\\n' "$argus_github_owner/$argus_github_repo/$argus_github_tag/$argus_github_asset" |
          LC_ALL=C grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/[A-Za-z0-9_.+-]+/[A-Za-z0-9_.+-]+$' ||
          return 1
        argus_release_api="https://api.github.com/repos/$argus_github_owner/$argus_github_repo/releases/tags/$argus_github_tag"
        argus_release_json="$argus_tmp/github-release.json"
        curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 60 --retry 3 --retry-all-errors \
          --header @"$argus_github_headers" --header 'Accept: application/vnd.github+json' \
          --output "$argus_release_json" "$argus_release_api" ||
          return 1
        [ "$(jq --arg name "$argus_github_asset" '[.assets[] | select(.name == $name and .state == "uploaded")] | length' "$argus_release_json")" -eq 1 ] ||
          return 1
        argus_asset_api=$(jq -er --arg name "$argus_github_asset" '.assets[] | select(.name == $name and .state == "uploaded") | .url' "$argus_release_json") ||
          return 1
        printf '%s\\n' "$argus_asset_api" |
          LC_ALL=C grep -Eq "^https://api\\\\.github\\\\.com/repos/$argus_github_owner/$argus_github_repo/releases/assets/[1-9][0-9]*$" ||
          return 1
        curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 60 --retry 3 --retry-all-errors \
          --header @"$argus_github_headers" --header 'Accept: application/octet-stream' \
          --output "$argus_fetch_output" "$argus_asset_api"
        return
        ;;
    esac
  fi
  case "$argus_fetch_url" in
    http://127.0.0.1:*|http://localhost:*)
      curl --fail --silent --show-error --location --proto '=http' --connect-timeout 10 --max-time 60 --retry 3 --retry-all-errors --output "$argus_fetch_output" "$argus_fetch_url"
      ;;
    *)
      curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 60 --retry 3 --retry-all-errors --output "$argus_fetch_output" "$argus_fetch_url"
      ;;
  esac
}

argus_curl "$argus_manifest_url" "$argus_tmp/manifest.json" || argus_die "failed to download release manifest"
argus_curl "$argus_signature_url" "$argus_tmp/manifest.sig" || argus_die "failed to download release signature"
[ "$(wc -c < "$argus_tmp/manifest.json" | tr -d ' ')" -le 1048576 ] || argus_die "release manifest is too large"
[ "$(wc -c < "$argus_tmp/manifest.sig" | tr -d ' ')" -eq 64 ] || argus_die "release signature has invalid length"

openssl pkeyutl -verify -pubin -inkey "$argus_tmp/release-public.pem" -rawin -in "$argus_tmp/manifest.json" -sigfile "$argus_tmp/manifest.sig" >/dev/null 2>&1 ||
  argus_die "release manifest signature is invalid"

[ "$(tail -c 1 "$argus_tmp/manifest.json" | od -An -tuC | tr -d ' ')" = 125 ] ||
  argus_die "signed release manifest must have canonical bytes without BOM or trailing newline"
[ "$(awk 'END { print NR }' "$argus_tmp/manifest.json")" -eq 1 ] || argus_die "signed release manifest must be canonical single-line JSON"
sed 's/,"installer":{"url":"[^"]*","sha256":"[a-f0-9]\\{64\\}"},"publicKey":{"url":"[^"]*","sha256":"[a-f0-9]\\{64\\}"},"fxembedLicense":{"url":"[^"]*","sha256":"[a-f0-9]\\{64\\}"},"fxembedProvenance":{"url":"[^"]*","sha256":"[a-f0-9]\\{64\\}"}//' \
  "$argus_tmp/manifest.json" > "$argus_tmp/schema-manifest.json" ||
  argus_die "could not normalize the signed release manifest schema"
mv "$argus_tmp/schema-manifest.json" "$argus_tmp/manifest.json" ||
  argus_die "could not normalize the signed release manifest schema"
LC_ALL=C grep -Eq '^\\{"schemaVersion":1,"version":"(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?","publishedAt":"[0-9]{4}-(0[1-9]|1[0-2])-([012][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\.[0-9]{3}Z","images":\\{"app":\\{"reference":"[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}","digest":"sha256:[a-f0-9]{64}"\\},"cli":\\{"reference":"[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}","digest":"sha256:[a-f0-9]{64}"\\},"searxng":\\{"reference":"[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}","digest":"sha256:[a-f0-9]{64}"\\},"postgres":\\{"reference":"[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}","digest":"sha256:[a-f0-9]{64}"\\}\\},"assets":\\{"fxembed":\\{"url":"https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/[A-Za-z0-9._~%+-][A-Za-z0-9._~/%+-]*","sha256":"[a-f0-9]{64}","compatibilityDate":"[0-9]{4}-(0[1-9]|1[0-2])-([012][0-9]|3[01])"\\},"wrapper":\\{"url":"https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/[A-Za-z0-9._~%+-][A-Za-z0-9._~/%+-]*","sha256":"[a-f0-9]{64}"\\}\\},"minimumStateSchema":1\\}$' "$argus_tmp/manifest.json" ||
  argus_die "signed release manifest does not match the supported canonical schema"

argus_manifest_line=$(cat "$argus_tmp/manifest.json")
argus_version=$(printf '%s\\n' "$argus_manifest_line" | sed -n 's/^{"schemaVersion":1,"version":"\\([^"]*\\)".*/\\1/p')
argus_published_at=$(printf '%s\\n' "$argus_manifest_line" | sed -n 's/.*"publishedAt":"\\([0-9TZ:.-]*\\)","images".*/\\1/p')
argus_compatibility_date=$(printf '%s\\n' "$argus_manifest_line" | sed -n 's/.*"compatibilityDate":"\\([0-9-]*\\)"}.*/\\1/p')
argus_fxembed_url=$(printf '%s\\n' "$argus_manifest_line" | sed -n 's/.*"fxembed":{"url":"\\([^"]*\\)","sha256".*/\\1/p')
argus_wrapper_url=$(printf '%s\\n' "$argus_manifest_line" | sed -n 's/.*"wrapper":{"url":"\\([^"]*\\)","sha256":"[a-f0-9]*"}.*/\\1/p')
argus_wrapper_sha=$(printf '%s\\n' "$argus_manifest_line" | sed -n 's/.*"wrapper":{"url":"[^"]*","sha256":"\\([a-f0-9]*\\)"}.*/\\1/p')
[ -n "$argus_version" ] && [ -n "$argus_wrapper_url" ] && [ -n "$argus_wrapper_sha" ] ||
  argus_die "could not read verified manifest fields"

argus_validate_calendar_date() {
  printf '%s\\n' "$1" | awk -F- '
    NF != 3 { exit 1 }
    {
      year = $1 + 0; month = $2 + 0; day = $3 + 0
      if (month < 1 || month > 12 || day < 1) exit 1
      days = 31
      if (month == 4 || month == 6 || month == 9 || month == 11) days = 30
      if (month == 2) {
        days = 28
        if (year % 400 == 0 || (year % 4 == 0 && year % 100 != 0)) days = 29
      }
      if (day > days) exit 1
    }
  '
}
argus_validate_calendar_date "$argus_compatibility_date" ||
  argus_die "signed release manifest contains an invalid compatibility date"
argus_validate_calendar_date "\${argus_published_at%T*}" ||
  argus_die "signed release manifest contains an invalid publication date"

argus_validate_pinned_image() {
  printf '%s\\n' "$1" | LC_ALL=C awk '
    length($0) < 1 || length($0) > 255 { exit 1 }
    {
      marker = index($0, "@sha256:")
      if (marker < 1) exit 1
      name = substr($0, 1, marker - 1)
      digest = substr($0, marker + 8)
      if (digest !~ /^[a-f0-9]+$/ || length(digest) != 64) exit 1
      slash = index(name, "/")
      if (slash < 2) exit 1
      registry = substr(name, 1, slash - 1)
      repository = substr(name, slash + 1)
      colon = index(registry, ":")
      host = colon > 0 ? substr(registry, 1, colon - 1) : registry
      if (colon > 0) {
        port = substr(registry, colon + 1)
        if (port !~ /^[1-9][0-9]*$/ || length(port) > 5 || port + 0 > 65535) exit 1
      } else if (host != "localhost" && index(host, ".") == 0) {
        exit 1
      }
      count = split(host, labels, ".")
      for (i = 1; i <= count; i++) {
        if (labels[i] !~ /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/) exit 1
      }
      count = split(repository, parts, "/")
      for (i = 1; i <= count; i++) {
        if (parts[i] !~ /^[a-z0-9]+([._-][a-z0-9]+)*$/) exit 1
      }
    }
  '
}

argus_check_image_identity() {
  argus_validate_pinned_image "$1" &&
    [ -n "$2" ] &&
    [ "\${1##*@}" = "$2" ] ||
    argus_die "signed release manifest contains an invalid or mismatched pinned image"
}
argus_app_ref=$(printf '%s\\n' "$argus_manifest_line" | sed -n 's/.*"app":{"reference":"\\([^"]*\\)","digest":"[^"]*"}.*/\\1/p')
argus_app_digest=$(printf '%s\\n' "$argus_manifest_line" | sed -n 's/.*"app":{"reference":"[^"]*","digest":"\\([^"]*\\)"}.*/\\1/p')
argus_cli_ref=$(printf '%s\\n' "$argus_manifest_line" | sed -n 's/.*"cli":{"reference":"\\([^"]*\\)","digest":"[^"]*"}.*/\\1/p')
argus_cli_digest=$(printf '%s\\n' "$argus_manifest_line" | sed -n 's/.*"cli":{"reference":"[^"]*","digest":"\\([^"]*\\)"}.*/\\1/p')
argus_searxng_ref=$(printf '%s\\n' "$argus_manifest_line" | sed -n 's/.*"searxng":{"reference":"\\([^"]*\\)","digest":"[^"]*"}.*/\\1/p')
argus_searxng_digest=$(printf '%s\\n' "$argus_manifest_line" | sed -n 's/.*"searxng":{"reference":"[^"]*","digest":"\\([^"]*\\)"}.*/\\1/p')
argus_postgres_ref=$(printf '%s\\n' "$argus_manifest_line" | sed -n 's/.*"postgres":{"reference":"\\([^"]*\\)","digest":"[^"]*"}.*/\\1/p')
argus_postgres_digest=$(printf '%s\\n' "$argus_manifest_line" | sed -n 's/.*"postgres":{"reference":"[^"]*","digest":"\\([^"]*\\)"}.*/\\1/p')
argus_check_image_identity "$argus_app_ref" "$argus_app_digest"
argus_check_image_identity "$argus_cli_ref" "$argus_cli_digest"
argus_check_image_identity "$argus_searxng_ref" "$argus_searxng_digest"
argus_check_image_identity "$argus_postgres_ref" "$argus_postgres_digest"
argus_validate_semver() {
  printf '%s\\n' "$1" | awk '
    !/^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?$/ { exit 1 }
    {
      value = $0
      build = ""
      plus = index(value, "+")
      if (plus > 0) {
        build = substr(value, plus + 1)
        value = substr(value, 1, plus - 1)
      }
      dash = index(value, "-")
      prerelease = dash > 0 ? substr(value, dash + 1) : ""
      if (prerelease != "") {
        count = split(prerelease, ids, ".")
        for (i = 1; i <= count; i++) {
          if (ids[i] == "" || ids[i] !~ /^[0-9A-Za-z-]+$/) exit 1
          if (ids[i] ~ /^[0-9]+$/ && length(ids[i]) > 1 && substr(ids[i], 1, 1) == "0") exit 1
        }
      }
      if (build != "") {
        count = split(build, ids, ".")
        for (i = 1; i <= count; i++) {
          if (ids[i] == "" || ids[i] !~ /^[0-9A-Za-z-]+$/) exit 1
        }
      }
    }
  '
}
argus_validate_semver "$argus_version" ||
  argus_die "signed release manifest version is not normalized SemVer"
case "\${ARGUS_VERSION:-}" in
  '') ;;
  *)
    argus_validate_semver "$ARGUS_VERSION" ||
      argus_die "ARGUS_VERSION must be normalized SemVer"
    [ "$ARGUS_VERSION" = "$argus_version" ] ||
      argus_die "signed manifest version $argus_version does not match requested ARGUS_VERSION $ARGUS_VERSION"
    ;;
esac
argus_validate_asset_url "$argus_fxembed_url" || argus_die "verified manifest contains an unsafe FxEmbed URL"
argus_validate_asset_url "$argus_wrapper_url" || argus_die "verified manifest contains an unsafe wrapper URL"

argus_curl "$argus_wrapper_url" "$argus_tmp/argus" || argus_die "failed to download Argus wrapper"
printf '%s  %s\\n' "$argus_wrapper_sha" "$argus_tmp/argus" | sha256sum -c - >/dev/null 2>&1 ||
  argus_die "Argus wrapper checksum does not match the signed manifest"
sh -n "$argus_tmp/argus" || argus_die "Argus wrapper is not valid POSIX shell"
argus_is_wrapper() {
  [ "$(sed -n '1p' "$1")" = '#!/bin/sh' ] &&
    [ "$(sed -n '2p' "$1")" = '# argus-host-wrapper schema=1' ] &&
    [ "$(sed -n '3p' "$1")" = '# generated-by=@argus/release' ] &&
    [ "$(sed -n '4p' "$1")" = 'set -eu' ] &&
    sed -n '6p' "$1" | LC_ALL=C grep -Eq "^argus_version='(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?'$" &&
    sed -n '7p' "$1" | LC_ALL=C grep -Eq "^argus_cli_image='[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}'$" &&
    [ "$(grep -Ec '^argus_version=' "$1")" -eq 1 ] &&
    [ "$(grep -Ec '^argus_cli_image=' "$1")" -eq 1 ] &&
    [ "$(grep -Ec -- "--env 'ARGUS_INSTALL_ROOT=/opt/argus'" "$1")" -ge 1 ]
}
argus_is_wrapper "$argus_tmp/argus" ||
  argus_die "signed wrapper is not a recognizable Argus host command"
chmod 755 "$argus_tmp/argus"

argus_as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    command -v sudo >/dev/null 2>&1 || argus_die "root privileges are required; install sudo or run as root"
    sudo "$@"
  fi
}

argus_docker_mode=
argus_check_docker() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    argus_docker_mode=user
    return 0
  fi
  if command -v docker >/dev/null 2>&1; then
    if [ "$(id -u)" -eq 0 ]; then
      if docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
        argus_docker_mode=root
        return 0
      fi
    elif command -v sudo >/dev/null 2>&1 &&
      sudo -n docker info >/dev/null 2>&1 &&
      sudo -n docker compose version >/dev/null 2>&1; then
      argus_docker_mode=root
      return 0
    fi
  fi
  return 1
}

argus_install_docker() {
  command -v apt-get >/dev/null 2>&1 || argus_die "apt-get is required to install Docker Engine"
  command -v dpkg >/dev/null 2>&1 || argus_die "dpkg is required to install Docker Engine"
  command -v dpkg-query >/dev/null 2>&1 || argus_die "dpkg-query is required to check Docker package conflicts"
  command -v timeout >/dev/null 2>&1 || argus_die "timeout from GNU coreutils is required to install Docker Engine safely"
  argus_conflicts=
  for argus_package in docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc; do
    if [ "$(dpkg-query -W -f='\${Status}' "$argus_package" 2>/dev/null || true)" = 'install ok installed' ]; then
      argus_conflicts="$argus_conflicts $argus_package"
    fi
  done
  [ -z "$argus_conflicts" ] ||
    argus_die "conflicting distro Docker packages are installed:$argus_conflicts; remove them explicitly, then rerun Argus"
  argus_as_root timeout 300 apt-get -o Acquire::Retries=3 update
  argus_as_root timeout 300 apt-get -o Acquire::Retries=3 install -y ca-certificates curl gnupg
  argus_as_root install -d -m 0755 /etc/apt/keyrings
  argus_curl "https://download.docker.com/linux/$argus_os_id/gpg" "$argus_tmp/docker.asc" ||
    argus_die "failed to download Docker repository key"
  install -d -m 0700 "$argus_tmp/docker-gnupg"
  gpg --homedir "$argus_tmp/docker-gnupg" --batch --import-options import-minimal --import "$argus_tmp/docker.asc" >/dev/null 2>&1 ||
    argus_die "Docker repository key could not be imported"
  argus_primary_fingerprints=$(gpg --homedir "$argus_tmp/docker-gnupg" --batch --with-colons --list-keys 2>/dev/null |
    awk -F: '$1 == "pub" { primary = 1; next } $1 == "sub" { primary = 0; next } $1 == "fpr" && primary { print $10; primary = 0 }')
  [ "$(printf '%s\\n' "$argus_primary_fingerprints" | awk 'NF { count++ } END { print count + 0 }')" -eq 1 ] ||
    argus_die "Docker repository key bundle must contain exactly one primary key"
  argus_key_fingerprint=$argus_primary_fingerprints
  [ "$argus_key_fingerprint" = "$argus_docker_key_fingerprint" ] ||
    argus_die "Docker repository key fingerprint did not match the pinned official key"
  gpg --homedir "$argus_tmp/docker-gnupg" --batch --armor --export "$argus_docker_key_fingerprint" > "$argus_tmp/docker.filtered.asc" ||
    argus_die "Docker repository key could not be exported"
  [ -s "$argus_tmp/docker.filtered.asc" ] ||
    argus_die "Docker repository key export was empty"
  argus_as_root install -m 0644 "$argus_tmp/docker.filtered.asc" /etc/apt/keyrings/docker.asc
  cat > "$argus_tmp/docker.sources" <<ARGUS_DOCKER_SOURCES
Types: deb
URIs: https://download.docker.com/linux/$argus_os_id
Suites: $argus_codename
Components: stable
Architectures: $argus_arch
Signed-By: /etc/apt/keyrings/docker.asc
ARGUS_DOCKER_SOURCES
  argus_as_root install -m 0644 "$argus_tmp/docker.sources" /etc/apt/sources.list.d/docker.sources
  argus_as_root timeout 300 apt-get -o Acquire::Retries=3 update
  argus_as_root timeout 300 apt-get -o Acquire::Retries=3 install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  if command -v systemctl >/dev/null 2>&1; then
    argus_as_root systemctl enable --now docker
  fi
}

if ! argus_check_docker; then
  case "\${ARGUS_INSTALL_DOCKER:-}" in
    0) argus_die "Docker Engine and Compose are required; ARGUS_INSTALL_DOCKER=0 forbids installation" ;;
    1) argus_install_docker ;;
    '')
      if ! (exec 3<>/dev/tty) 2>/dev/null; then
        argus_die "Docker is missing and no controlling terminal is available; set ARGUS_INSTALL_DOCKER=1 to approve installation"
      fi
      exec 3<>/dev/tty
      printf '%s' "Docker Engine and Compose are required. Install from Docker's official apt repository? [y/N] " >&3
      IFS= read -r argus_answer <&3 || argus_die "could not read Docker installation approval"
      exec 3>&-
      case "$argus_answer" in
        y|Y|yes|YES|Yes) argus_install_docker ;;
        *) argus_die "Docker installation declined" ;;
      esac
      ;;
    *) argus_die "ARGUS_INSTALL_DOCKER must be 0 or 1" ;;
  esac
  argus_check_docker || argus_die "Docker Engine or the Compose plugin is not usable after installation"
fi

argus_target_dir=$(dirname "$argus_target")
if [ ! -d "$argus_target_dir" ]; then
  if [ -w "$(dirname "$argus_target_dir")" ]; then
    install -d -m 0755 "$argus_target_dir"
  else
    argus_as_root install -d -m 0755 "$argus_target_dir"
  fi
fi

if [ -L "$argus_target" ]; then
  argus_die "refusing to replace symlink $argus_target"
fi
if [ -e "$argus_target" ]; then
  argus_target_identity=$(stat -c '%d:%i:%s' "$argus_target" 2>/dev/null || stat -f '%d:%i:%z' "$argus_target" 2>/dev/null) ||
    argus_die "could not inspect existing installation target"
  if cmp -s "$argus_tmp/argus" "$argus_target"; then
    argus_existing_exact=1
  elif argus_is_wrapper "$argus_target" 2>/dev/null; then
    argus_existing_exact=0
  else
    argus_die "refusing to replace unrelated file $argus_target"
  fi
else
  argus_target_identity=absent
  argus_existing_exact=0
fi

argus_run_wrapper_version() {
  if [ "$argus_docker_mode" = root ]; then
    argus_as_root "$1" --version
  else
    "$1" --version
  fi
}

if [ "$argus_existing_exact" -eq 0 ]; then
  if [ -w "$argus_target_dir" ]; then
    argus_target_tmp=$(mktemp "$argus_target_dir/.argus.tmp.XXXXXX")
    install -m 0755 "$argus_tmp/argus" "$argus_target_tmp"
  else
    argus_target_tmp=$(argus_as_root mktemp "$argus_target_dir/.argus.tmp.XXXXXX")
    argus_as_root install -m 0755 "$argus_tmp/argus" "$argus_target_tmp"
  fi
  argus_temp_version=$(argus_run_wrapper_version "$argus_target_tmp") ||
    argus_die "new Argus wrapper failed its version check; existing installation was preserved"
  [ "$argus_temp_version" = "$argus_version" ] ||
    argus_die "new Argus wrapper reported version $argus_temp_version, expected $argus_version; existing installation was preserved"
  sync -f "$argus_target_tmp" ||
    argus_die "could not durably sync the new Argus wrapper; existing installation was preserved"
  [ ! -L "$argus_target" ] || argus_die "target became a symlink during installation"
  if [ "$argus_target_identity" = absent ]; then
    [ ! -e "$argus_target" ] || argus_die "installation target changed during installation"
  else
    [ "$(stat -c '%d:%i:%s' "$argus_target" 2>/dev/null || stat -f '%d:%i:%z' "$argus_target" 2>/dev/null || true)" = "$argus_target_identity" ] ||
      argus_die "installation target changed during installation"
    if [ -w "$argus_target_dir" ]; then
      argus_backup_tmp=$(mktemp "$argus_target_dir/.argus.backup.XXXXXX")
      install -m 0755 "$argus_target" "$argus_backup_tmp"
    else
      argus_backup_tmp=$(argus_as_root mktemp "$argus_target_dir/.argus.backup.XXXXXX")
      argus_as_root install -m 0755 "$argus_target" "$argus_backup_tmp"
    fi
    sync -f "$argus_backup_tmp" ||
      argus_die "could not durably preserve the existing Argus wrapper"
  fi
  if [ -w "$argus_target_dir" ]; then
    mv -f -- "$argus_target_tmp" "$argus_target"
  else
    argus_as_root mv -f -- "$argus_target_tmp" "$argus_target"
  fi
  argus_target_tmp=
  if ! sync -f "$argus_target" || ! sync -f "$argus_target_dir"; then
    if [ -n "$argus_backup_tmp" ]; then
      if [ -w "$argus_target_dir" ]; then
        mv -f -- "$argus_backup_tmp" "$argus_target"
      else
        argus_as_root mv -f -- "$argus_backup_tmp" "$argus_target"
      fi
      argus_backup_tmp=
    else
      if [ -w "$argus_target_dir" ]; then
        rm -f -- "$argus_target"
      else
        argus_as_root rm -f -- "$argus_target"
      fi
    fi
    sync -f "$argus_target_dir" 2>/dev/null || true
    argus_die "could not durably sync the Argus installation; previous state was restored"
  fi
  if [ -n "$argus_backup_tmp" ]; then
    if [ -w "$argus_target_dir" ]; then
      rm -f -- "$argus_backup_tmp"
    else
      argus_as_root rm -f -- "$argus_backup_tmp"
    fi
    argus_backup_tmp=
    sync -f "$argus_target_dir"
  fi
fi

argus_installed_version=$(argus_run_wrapper_version "$argus_target") ||
  argus_die "installed Argus wrapper failed its version check"
[ "$argus_installed_version" = "$argus_version" ] ||
  argus_die "installed Argus wrapper reported version $argus_installed_version, expected $argus_version"
if [ "$argus_docker_mode" = root ]; then
  printf '%s\\n' "Docker is usable only with root privileges in this session." >&2
  printf '%s\\n' "Run 'sudo argus onboard', or explicitly configure Docker socket access and start a new login session." >&2
  printf '%s\\n' "Argus did not modify user groups." >&2
fi
printf '%s\\n' "argus onboard"
`;
}
