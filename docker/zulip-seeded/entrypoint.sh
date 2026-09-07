#!/usr/bin/env bash
# Wrapper entrypoint around the upstream zulip-server entrypoint.
#
# It only does two things before handing over, both of which use documented
# extension points of the upstream image (see docker-zulip/entrypoint.sh):
#
#   1. installs the baked-in certificate pair where CERTIFICATES=manual
#      expects it ($DATA_DIR/certs/manual/), and
#   2. installs our seed script into $DATA_DIR/post-setup.d/, which the
#      upstream entrypoint runs after `manage.py migrate` and before
#      supervisord starts (runPostSetupScripts / appRun).
#
# Nothing under docker-zulip/ or zulip/ is modified.
set -euo pipefail

DATA_DIR="${DATA_DIR:-/data}"
SEED_DIR=/opt/seed

echo "seeded-entrypoint: preparing $DATA_DIR"
mkdir -p "$DATA_DIR/certs/manual" "$DATA_DIR/post-setup.d"

install -m 600 "$SEED_DIR/certs/zulip.key" "$DATA_DIR/certs/manual/zulip.key"
install -m 644 "$SEED_DIR/certs/zulip.combined-chain.crt" \
    "$DATA_DIR/certs/manual/zulip.combined-chain.crt"

install -m 755 "$SEED_DIR/seed.sh" "$DATA_DIR/post-setup.d/10-seed.sh"

echo "seeded-entrypoint: handing over to /sbin/entrypoint.sh $*"
exec /sbin/entrypoint.sh "$@"
