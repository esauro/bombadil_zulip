#!/usr/bin/env bash
# The upstream image's healthcheck probes http://localhost/health, but with
# CERTIFICATES set the container serves only HTTPS on 443 (see
# docker-zulip/docs/reference/ports.md), so we replace it.
#
# We also require the seed marker. runPostSetupScripts in the upstream
# entrypoint swallows a failing post-setup script and starts supervisord
# anyway; without this check /health would go green on an unseeded server and
# `depends_on: service_healthy` would hand Bombadil a useless instance.
#
# Everything printed here is retained by Docker in
# .State.Health.Log[].Output, which is what `make health` shows -- so say
# something specific enough to act on.
set -uo pipefail

DATA_DIR="${DATA_DIR:-/data}"

if [ -e "$DATA_DIR/seed-failed" ]; then
    echo "unhealthy: seeding FAILED and will not be retried. Reason:"
    cat "$DATA_DIR/seed-failed" 2>/dev/null
    echo "Full output: make logs-zulip (or make seed-log)"
    exit 1
fi

if [ ! -e "$DATA_DIR/seed-complete" ]; then
    # No failure marker and no success marker: either seeding has not been
    # reached yet (migrations still running on first boot) or it is in flight.
    echo "unhealthy (yet): $DATA_DIR/seed-complete is missing; seeding has not finished."
    if [ -d "$DATA_DIR/post-setup.d" ]; then
        echo "post-setup.d: $(ls -A "$DATA_DIR/post-setup.d" 2>/dev/null | tr '\n' ' ')"
    else
        echo "post-setup.d: MISSING -- our entrypoint did not run, or DATA_DIR is not $DATA_DIR"
    fi
    exit 1
fi

# Seeded; the only remaining question is whether nginx and Django are serving.
body="$(curl -sS -L --insecure --max-time 5 -w '\nhttp_code=%{http_code}' \
    https://localhost/health 2>&1)"
case "$body" in
    *http_code=200*)
        echo "healthy: seeded, and https://localhost/health returned 200"
        exit 0
        ;;
esac
echo "unhealthy: seeded, but https://localhost/health did not return 200:"
echo "$body" | tail -5
exit 1
