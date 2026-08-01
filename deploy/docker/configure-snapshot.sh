#!/bin/sh
set -eu

: "${DEBIAN_SNAPSHOT:?DEBIAN_SNAPSHOT must be set}"

rm -f /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources
cat > /etc/apt/sources.list.d/snapshot.sources <<EOF
Types: deb
URIs: http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}
Suites: bookworm bookworm-updates
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
Check-Valid-Until: no

Types: deb
URIs: http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}
Suites: bookworm-security
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
Check-Valid-Until: no
EOF

cat > /etc/apt/apt.conf.d/99argus-snapshot <<'EOF'
Acquire::Check-Valid-Until "false";
Acquire::Retries "3";
Acquire::http::Timeout "30";
APT::Get::Assume-Yes "true";
EOF
