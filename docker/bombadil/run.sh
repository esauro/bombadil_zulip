#!/usr/bin/env bash
# Entrypoint for one Bombadil instance.
#
# Bombadil's managed browser launcher hard-codes its Chromium flag list and
# offers no passthrough (lib/bombadil-browser/src/browser.rs), so there is no
# way to tell it to accept our self-signed certificate. We therefore launch
# Chromium ourselves with --ignore-certificate-errors and attach with
# `bombadil browser test-external`.
#
# This is also the seam where Antithesis-specific browser flags would go later.
set -euo pipefail

: "${INSTANCE:?INSTANCE must be set (e.g. user1)}"
: "${ZULIP_ORIGIN:?ZULIP_ORIGIN must be set (e.g. https://zulip.test/)}"
: "${ZULIP_EMAIL:?ZULIP_EMAIL must be set}"
: "${ZULIP_PASSWORD:?ZULIP_PASSWORD must be set}"
: "${ZULIP_CHANNEL:=bombadil}"
: "${ZULIP_TOPIC:=general}"
: "${BOMBADIL_TIME_LIMIT:=5m}"
: "${BOMBADIL_OUTPUT_DIR:=/out}"
: "${BOMBADIL_WIDTH:=1440}"
: "${BOMBADIL_HEIGHT:=900}"
: "${CDP_PORT:=9222}"
: "${CDP_HOST:=127.0.0.1}"
: "${BOMBADIL_REMOTE_DEBUGGER:=http://${CDP_HOST}:${CDP_PORT}}"
: "${WAIT_FOR_ZULIP_SECONDS:=900}"
: "${WAIT_FOR_CDP_SECONDS:=60}"

log() { echo "[$INSTANCE] $*"; }

# Every request this container makes stays inside the compose network, so an
# inherited proxy -- from the daemon's config, ~/.docker/config.json, or the
# build environment -- can only break things, for curl here and for Chromium's
# own fetches. Clear them unless explicitly told not to.
if [ -n "${HTTP_PROXY:-}${HTTPS_PROXY:-}${http_proxy:-}${https_proxy:-}${ALL_PROXY:-}${all_proxy:-}" ]; then
    if [ "${KEEP_PROXY:-0}" = "1" ]; then
        log "keeping inherited proxy settings (KEEP_PROXY=1)"
    else
        log "clearing inherited proxy settings: HTTP_PROXY=${HTTP_PROXY:-unset} HTTPS_PROXY=${HTTPS_PROXY:-unset} http_proxy=${http_proxy:-unset} https_proxy=${https_proxy:-unset}"
        log "  (set KEEP_PROXY=1 in the environment to keep them)"
        unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy
    fi
fi

# Chromium and fontconfig both need a writable HOME. The image's default user
# owns /home/browser, but compose may run us under the host's uid so that trace
# output lands with sane ownership on a bind mount.
if [ ! -w "${HOME:-/nonexistent}" ]; then
    HOME="$(mktemp -d)"
    export HOME
    log "HOME was not writable; using $HOME"
fi

output_path="$BOMBADIL_OUTPUT_DIR/$INSTANCE"
mkdir -p "$output_path" 2>/dev/null || true
if [ ! -w "$output_path" ]; then
    log "ERROR: $output_path is not writable by uid $(id -u)."
    log "       Set BOMBADIL_USER in .env to your host uid:gid, or chown ./out."
    exit 1
fi

# ---------------------------------------------------------------------------
# The specification needs to know which user this instance is: which
# credentials to type on the login page, which marker text to send so that the
# other instance's messages are distinguishable from its own, and which channel
# and topic the two instances exchange messages in. The spec
# runtime has no access to the environment, so we materialise the values into
# a JSON module the spec imports, in a writable copy of the spec tree.
# ---------------------------------------------------------------------------
# Minimal JSON string escaping, since this image has no python or jq.
json_escape() {
    local value="$1"
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    printf '%s' "$value"
}

work="$(mktemp -d)"
cp -r /spec "$work/spec"
cat >"$work/spec/credentials.json" <<EOF
{
  "instance": "$(json_escape "$INSTANCE")",
  "email": "$(json_escape "$ZULIP_EMAIL")",
  "password": "$(json_escape "$ZULIP_PASSWORD")",
  "marker": "bombadil-$(json_escape "$INSTANCE")",
  "channel": "$(json_escape "$ZULIP_CHANNEL")",
  "topic": "$(json_escape "$ZULIP_TOPIC")"
}
EOF
log "specification at $work/spec/zulip.ts"

# ---------------------------------------------------------------------------
# Wait for Zulip before starting the clock. First boot runs migrations and
# seeding, which takes a couple of minutes; --time-limit must not be spent on
# that. compose's `depends_on: service_healthy` already covers this, but this
# keeps the container correct when started on its own.
# ---------------------------------------------------------------------------
# Deliberately NOT /health. Zulip's nginx restricts that endpoint to
# "allow 127.0.0.1; allow ::1; <loadbalancers>; deny all"
# (zulip/puppet/zulip/templates/nginx/healthcheck.conf.template.erb), so from
# another container on the compose network it answers 403 -- which is exactly
# how this looked: nginx's own 403 page from 172.20.0.6 while the container's
# own healthcheck, running on localhost, got a clean 200.
#
# /api/v1/server_settings is public (@require_safe @csrf_exempt, no auth
# decorator) and is served by Django through uwsgi, so a 200 means nginx,
# uwsgi and Django are all up. It still honours ALLOWED_HOSTS, so a hostname
# mismatch shows up as 400 rather than being silently accepted.
#
# The alternative -- adding the compose subnet to LOADBALANCER_IPS -- would
# also make Zulip trust X-Forwarded-For from those addresses, which is a real
# behavioural change to buy nothing but a probe.
ready_url="${ZULIP_ORIGIN%/}/api/v1/server_settings"

# Why the probe is failing is the only interesting thing while waiting, and
# `curl -sf` suppresses exactly that.
#
# This reports it using curl's own --write-out fields rather than grepping
# verbose output: the Bombadil image is a Nix layered image containing only
# bombadil, coreutils, bash, fontconfig, fonts, chromium and curl -- and
# neither `grep` nor `sed` is part of coreutils, so neither exists here.
# %{errormsg} and %{exitcode} need curl >= 7.75; this image's is far newer.
probe_status() {
    curl -k -sS --max-time 5 -o /dev/null \
        -w 'http_code=%{http_code} exitcode=%{exitcode} remote=%{remote_ip}:%{remote_port} errormsg=%{errormsg}' \
        "$ready_url" 2>&1 | tr '\n' ' '
}

probe_code() {
    curl -k -s --max-time 5 -o /dev/null -w '%{http_code}' "$ready_url" 2>/dev/null || echo 000
}

log "waiting for $ready_url (up to ${WAIT_FOR_ZULIP_SECONDS}s)"
deadline=$((SECONDS + WAIT_FOR_ZULIP_SECONDS))
attempt=0
while [ "$(probe_code)" != "200" ]; do
    attempt=$((attempt + 1))
    # Report immediately, then every ~30s, rather than sitting silent.
    if [ "$attempt" -eq 1 ] || [ $((attempt % 15)) -eq 0 ]; then
        log "still waiting (attempt $attempt): $(probe_status)"
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
        log "ERROR: $ready_url did not return 200 in ${WAIT_FOR_ZULIP_SECONDS}s"
        log "last probe: $(probe_status)"
        log "proxy vars: HTTP_PROXY=${HTTP_PROXY:-unset} HTTPS_PROXY=${HTTPS_PROXY:-unset} NO_PROXY=${NO_PROXY:-unset}"
        log "lowercase:  http_proxy=${http_proxy:-unset} https_proxy=${https_proxy:-unset} no_proxy=${no_proxy:-unset}"
        exit 1
    fi
    sleep 2
done
log "Zulip is answering ($ready_url -> 200)"

# ---------------------------------------------------------------------------
# Our own Chromium. --ignore-certificate-errors is the whole reason this
# container does not use `bombadil browser test`.
# ---------------------------------------------------------------------------
user_data_dir="$(mktemp -d)"
log "launching chromium (user-data-dir=$user_data_dir)"
chromium \
    --headless=new \
    --no-sandbox \
    --disable-setuid-sandbox \
    --disable-dev-shm-usage \
    --disable-gpu \
    --ignore-certificate-errors \
    --no-proxy-server \
    --remote-debugging-address="$CDP_HOST" \
    --remote-debugging-port="$CDP_PORT" \
    --remote-allow-origins='*' \
    --user-data-dir="$user_data_dir" \
    --window-size="${BOMBADIL_WIDTH},${BOMBADIL_HEIGHT}" \
    --no-first-run \
    --no-default-browser-check \
    --disable-background-networking \
    --disable-background-timer-throttling \
    --disable-renderer-backgrounding \
    --disable-component-update \
    --disable-domain-reliability \
    --disable-crash-reporter \
    --no-crashpad \
    --no-pings \
    about:blank &
chromium_pid=$!
trap 'kill "$chromium_pid" 2>/dev/null || true' EXIT

log "waiting for CDP on $BOMBADIL_REMOTE_DEBUGGER (up to ${WAIT_FOR_CDP_SECONDS}s)"
deadline=$((SECONDS + WAIT_FOR_CDP_SECONDS))
until curl -sf --max-time 2 "http://${CDP_HOST}:${CDP_PORT}/json/version" >/dev/null; do
    if ! kill -0 "$chromium_pid" 2>/dev/null; then
        log "ERROR: chromium exited before opening the debugging port"
        exit 1
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
        log "ERROR: CDP did not come up in ${WAIT_FOR_CDP_SECONDS}s"
        exit 1
    fi
    sleep 1
done
# Logged so that, if chromiumoxide ever refuses the http form, the websocket
# URL to put in BOMBADIL_REMOTE_DEBUGGER is right here in the output.
log "CDP up: $(curl -sf "http://${CDP_HOST}:${CDP_PORT}/json/version" || true)"

# ---------------------------------------------------------------------------
# No cookie is handed over: the browser starts logged out at $ZULIP_ORIGIN,
# which redirects to /login/, and the specification's login stage types
# $ZULIP_EMAIL / $ZULIP_PASSWORD into the real form and submits it before any
# random exploration begins. The same stage runs again whenever exploration
# clicks "log out".
# ---------------------------------------------------------------------------
log "starting bombadil (time limit $BOMBADIL_TIME_LIMIT, output $output_path)"
log "logging in through the web form as $ZULIP_EMAIL"
# Bombadil's bundler resolves the specification relative to the working
# directory, so run from the copy rather than passing an absolute path.
cd "$work"
exec bombadil browser test-external \
    --remote-debugger "$BOMBADIL_REMOTE_DEBUGGER" \
    --create-target \
    --time-limit "$BOMBADIL_TIME_LIMIT" \
    --width "$BOMBADIL_WIDTH" \
    --height "$BOMBADIL_HEIGHT" \
    --output-path "$output_path" \
    --output-path-overwrite \
    "$ZULIP_ORIGIN" \
    spec/zulip.ts
