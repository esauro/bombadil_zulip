#!/usr/bin/env bash
# Build-time generation of a long-lived self-signed certificate for the
# ephemeral test instance.
#
# Doing this at build time (rather than letting the container's
# CERTIFICATES=self-signed path do it at boot) means:
#   * no entropy is consumed and no RSA keygen happens during a test run,
#   * the certificate is identical for every boot of a given image, which
#     matters once this runs under Antithesis.
set -euo pipefail

HOST="${1:?usage: gen-cert.sh <hostname> <output-dir>}"
OUT="${2:?usage: gen-cert.sh <hostname> <output-dir>}"

mkdir -p "$OUT"

openssl req -x509 -nodes \
    -newkey rsa:2048 \
    -days 3650 \
    -keyout "$OUT/zulip.key" \
    -out "$OUT/zulip.combined-chain.crt" \
    -subj "/CN=$HOST" \
    -addext "subjectAltName=DNS:$HOST,DNS:localhost,IP:127.0.0.1" \
    -addext "basicConstraints=critical,CA:FALSE" \
    -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
    -addext "extendedKeyUsage=serverAuth"

chmod 600 "$OUT/zulip.key"
chmod 644 "$OUT/zulip.combined-chain.crt"

echo "gen-cert: wrote self-signed certificate for $HOST to $OUT"
openssl x509 -in "$OUT/zulip.combined-chain.crt" -noout -subject -ext subjectAltName
