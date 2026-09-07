#!/usr/bin/env bash
# Seeds the ephemeral Zulip instance. Installed by our entrypoint into
# $DATA_DIR/post-setup.d/10-seed.sh, so the upstream entrypoint runs it after
# database migrations and before supervisord starts.
#
# Idempotent: a marker file short-circuits a re-run on container restart, and
# the Python half (seed.py) is written to be safe to re-run regardless.
#
# If this script fails, the marker is never written and the container's
# healthcheck never turns healthy -- so `docker compose up --wait` fails loudly
# instead of handing an unseeded server to Bombadil.
set -euo pipefail

DATA_DIR="${DATA_DIR:-/data}"
MANAGE=/home/zulip/deployments/current/manage.py
SEED_DIR=/opt/seed
MARKER="$DATA_DIR/seed-complete"
FAILURE="$DATA_DIR/seed-failed"
CONFIG_DIR=/run/zulip-seed
CONFIG="$CONFIG_DIR/config.json"

: "${ZULIP_REALM_NAME:=Bombadil Test}"
: "${ZULIP_ADMIN_EMAIL:=admin@zulip.test}"
: "${ZULIP_ADMIN_NAME:=Realm Admin}"
: "${ZULIP_ADMIN_PASSWORD:?ZULIP_ADMIN_PASSWORD must be set}"
: "${ZULIP_USER1_EMAIL:=bombadil1@zulip.test}"
: "${ZULIP_USER1_NAME:=Bombadil One}"
: "${ZULIP_USER1_PASSWORD:?ZULIP_USER1_PASSWORD must be set}"
: "${ZULIP_USER1_SESSION_KEY:?ZULIP_USER1_SESSION_KEY must be set}"
: "${ZULIP_USER2_EMAIL:=bombadil2@zulip.test}"
: "${ZULIP_USER2_NAME:=Bombadil Two}"
: "${ZULIP_USER2_PASSWORD:?ZULIP_USER2_PASSWORD must be set}"
: "${ZULIP_USER2_SESSION_KEY:?ZULIP_USER2_SESSION_KEY must be set}"
: "${ZULIP_CHANNEL:=bombadil}"

if [ -e "$MARKER" ]; then
    echo "seed: $MARKER exists, nothing to do"
    exit 0
fi

echo "seed: starting"
rm -f "$FAILURE"

# runPostSetupScripts in the upstream entrypoint runs post-setup scripts under
# `set +e` and only echoes the return code, so a failure here does not stop the
# boot. Record it where the healthcheck can find it, so the container reports
# "seeding failed" rather than silently serving an unseeded Zulip.
on_error() {
    local code=$?
    local message="seed: FAILED (exit $code) at line ${BASH_LINENO[0]}: ${BASH_COMMAND}"
    echo "$message" >&2
    echo "$message" >"$FAILURE" 2>/dev/null || true
}
trap on_error ERR

rm -rf "$CONFIG_DIR"
mkdir -p "$CONFIG_DIR"
chmod 755 "$CONFIG_DIR"
trap 'rm -rf "$CONFIG_DIR"' EXIT

# Everything the Django half needs, in one file rather than in the
# environment: `su`/`sudo` do not reliably forward arbitrary variables, and
# passing passwords as command-line arguments would put them in the process
# table. The file lives in a directory removed on exit.
python3 - "$CONFIG" <<'PY'
import json
import os
import sys

config = {
    "realm_name": os.environ["ZULIP_REALM_NAME"],
    "channel": os.environ["ZULIP_CHANNEL"],
    "topic": os.environ.get("ZULIP_TOPIC", "general"),
    "admin": {
        "email": os.environ["ZULIP_ADMIN_EMAIL"],
        "full_name": os.environ["ZULIP_ADMIN_NAME"],
        "password": os.environ["ZULIP_ADMIN_PASSWORD"],
    },
    "users": [
        {
            "email": os.environ["ZULIP_USER1_EMAIL"],
            "full_name": os.environ["ZULIP_USER1_NAME"],
            "password": os.environ["ZULIP_USER1_PASSWORD"],
            "session_key": os.environ["ZULIP_USER1_SESSION_KEY"],
        },
        {
            "email": os.environ["ZULIP_USER2_EMAIL"],
            "full_name": os.environ["ZULIP_USER2_NAME"],
            "password": os.environ["ZULIP_USER2_PASSWORD"],
            "session_key": os.environ["ZULIP_USER2_SESSION_KEY"],
        },
    ],
}
with open(sys.argv[1], "w") as f:
    json.dump(config, f, indent=2)
os.chmod(sys.argv[1], 0o644)
PY

# One call does the whole job: realm, users, channel, messages and sessions.
# The redirect is performed by this shell, so sudo just inherits the fd -- no
# command string is rebuilt for a second shell to re-parse.
echo "seed: running seed.py"
# `$?` inside `if ! cmd; then` is the status of the negation, not of the
# command, so capture it explicitly.
set +e
sudo -u zulip -- "$MANAGE" shell <"$SEED_DIR/seed.py"
status=$?
set -e
if [ "$status" -ne 0 ]; then
    echo "seed: seed.py FAILED (exit $status). Its output is above." >&2
    {
        echo "seed: seed.py FAILED (exit $status)"
        echo "Run 'make seed-log' for the full traceback."
    } >"$FAILURE" 2>/dev/null || true
    exit "$status"
fi

touch "$MARKER"
echo "seed: done"
