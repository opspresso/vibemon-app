#!/usr/bin/env bash
set -euo pipefail

directory="${1:?Windows artifact directory is required}"
certificate="$directory/signing-certificate.pem"
digest="$(openssl x509 -in "$certificate" -outform DER | sha256sum | cut -d ' ' -f 1)"
shopt -s nullglob
installers=("$directory"/*.exe)
(( ${#installers[@]} == 2 )) || { echo 'Expected NSIS and portable Windows packages' >&2; exit 1; }

for installer in "${installers[@]}"; do
  osslsigncode verify \
    -CAfile "$certificate" \
    -TSA-CAfile /etc/ssl/certs/ca-certificates.crt \
    -require-leaf-hash "sha256:$digest" \
    -in "$installer"
done
