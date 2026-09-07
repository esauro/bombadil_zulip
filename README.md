# Two Bombadil instances property-testing an ephemeral Zulip

[Bombadil](https://github.com/antithesishq/bombadil) is a property-based
testing tool for UIs. This directory wires two Bombadil instances, each driving
its own Chromium and logged in as its own Zulip user, against a single
throwaway Zulip server brought up with Docker Compose.

Nothing under `zulip/`, `docker-zulip/` or `bombadil/` is modified. Those three
checkouts are read-only inputs; everything here is new and lives at the
repository root.

They are also not tracked in this repository -- they are ~2.7 GB and each has
its own `.git`. Clone them yourself; `CHECKOUTS.md` records the exact commits
and explains what does and does not need them. Nothing at runtime does: the
stack runs from the images pinned in `.env`, so `make test` works on a machine
with none of the three present.

## Quick start

```bash
cp .env.example .env      # or: make env
make test                 # build, boot, seed, then run both instances
```

If your uid is not 1000, set `BOMBADIL_USER=$(id -u):$(id -g)` in `.env` first,
so the traces written to `./out` end up owned by you. `make env` says so if it
notices.

The first `make test` pulls two images and applies Zulip's ~950 Django
migrations against an empty database, which takes **several minutes** -- often
five to fifteen, depending on the machine -- before seeding runs and the two
Bombadil containers start. `make up` prints migration and seeding progress
while it waits, so you can tell it apart from a hang. After that the run takes
exactly `BOMBADIL_TIME_LIMIT` (5 minutes by default).

Subsequent runs are only slow again after `make down`, which throws the
database away by design.

```bash
BOMBADIL_TIME_LIMIT=30m make test    # longer run
make inspect INSTANCE=user1          # browse the trace and screenshots
make down                            # throw the whole instance away
```

`make test` exits non-zero if either instance reported a property violation
(Bombadil exit code 2) or failed (exit code 1). Reaching the time limit counts
as normal completion.

`make typecheck` type-checks the specification without touching Docker at all,
which is the fastest loop while editing `spec/`.

Run `make` on its own for the full list of targets.

### Requirements

- Docker with Compose v2 (`docker compose version`). Compose ≥ 2.20 is needed
  for `attach: false`.
- About 4 GB of free RAM: Zulip plus two Chromium instances.

The stack was written against Docker Engine + Compose v2 on Linux. It does not
need `docker` on the host to do anything clever -- no bind-mounted sockets, no
`docker compose exec` during a run -- so a rootless or remote daemon works too,
with one caveat about published ports noted below.

## What comes up

| Service | What it is |
|---|---|
| `database`, `memcached`, `rabbitmq`, `redis` | Zulip's backing services, copied in shape from `docker-zulip/compose.yaml` |
| `zulip` | `ghcr.io/zulip/zulip-server:12.2-0` plus a thin layer that bakes in a certificate and a seed script |
| `bombadil-1`, `bombadil-2` | `antithesishq/bombadil:0.7.2` plus the specification and a launcher |

The seeded instance contains:

- one realm on the root domain, named from `ZULIP_REALM_NAME`;
- three users: a realm **owner** (`admin@zulip.test`) and two plain **members**
  (`bombadil1@zulip.test`, `bombadil2@zulip.test`) -- one per Bombadil
  instance;
- one public channel (`#bombadil`) that all three are subscribed to, with a
  few messages already in it;
- two Django sessions under keys fixed in `.env`, so each Bombadil container
  starts already logged in.

Everything is ephemeral. No named volumes are declared, so `make down` deletes
the database along with the containers and the next run re-seeds from scratch.

## The three design decisions worth knowing

### HTTPS is not optional

Under `PRODUCTION`, Zulip forces `SESSION_COOKIE_SECURE = True` and renames the
session cookie to `__Host-sessionid` (`zulip/zproject/computed_settings.py`).
Those assignments happen in a module imported *after* `/etc/zulip/settings.py`,
so no amount of configuration can turn them off -- and no browser will store or
send a `Secure` / `__Host-`-prefixed cookie on an `http://` origin. A
plain-HTTP Zulip therefore cannot hold a login session at all.

So the stack speaks HTTPS, with a self-signed certificate generated at **image
build time** (`docker/zulip-seeded/gen-cert.sh`) and installed where
`CERTIFICATES=manual` expects it. Building it into the image means no RSA
keygen during a run and an identical certificate on every boot, which matters
for the Antithesis phase.

### We launch Chromium ourselves

Bombadil's managed browser launcher hard-codes its Chromium flag list, with no
passthrough, so there is no way to tell it to accept our certificate.
`docker/bombadil/run.sh` therefore starts Chromium itself with
`--ignore-certificate-errors --remote-debugging-port=9222` and attaches with
`bombadil browser test-external`. That is also the natural seam for
Antithesis-specific browser flags later.

### The hostname is `zulip.test`, not `zulip.localhost`

Chromium hard-codes the `.localhost` suffix to loopback, so a Bombadil
container asked to open `https://zulip.localhost/` would talk to *itself*.
`zulip.test` is a plain name resolved by Docker's DNS through a network alias
on the `zulip` service.

## Browsing the instance yourself

Port 443 of the Zulip container is published on `ZULIP_HTTPS_PORT` (8443 by
default) purely for your own debugging; the test traffic stays inside the
compose network.

```bash
make up
# https://localhost:8443/  -- accept the self-signed certificate
# log in as bombadil1@zulip.test / bombadil1
```

Any hostname that is not a subdomain of `zulip.test` maps to the root realm, so
`localhost` works. Some absolute links will point at `https://zulip.test/`
though, because that is the realm's canonical URL. For a fully clean session,
set `ZULIP_HTTPS_PORT=443` in `.env`, add

```
127.0.0.1 zulip.test
```

to `/etc/hosts`, and browse `https://zulip.test/`. Binding port 443 needs a
daemon that can (rootful Docker, or `net.ipv4.ip_unprivileged_port_start`
lowered).

## Debugging a run

```bash
make logs-zulip     # follow the Zulip container, where seeding output appears
make seed-log       # just the seeding lines
make ps             # container status and exit codes
make manage ARGS="list_realms"
make shell          # a shell inside the Zulip container
```

### Bombadil sits on "waiting for https://zulip.test/"

```bash
make net-check
```

That asks each Bombadil container to probe Zulip verbosely and prints what it
gets -- DNS failure, connection refused, TLS error or HTTP status -- alongside
the proxy variables in its environment and the network aliases actually
registered on the zulip container. It also confirms Zulip answers on its own
`localhost`, which separates "Zulip is broken" from "Bombadil cannot reach it".

The wait loop in `run.sh` also reports the reason itself now, on the first
attempt and every ~30s, so `make logs` shows it without any extra step.

Note that `/health` is **not** the endpoint to probe from outside the Zulip
container. Zulip's nginx restricts it to
`allow 127.0.0.1; allow ::1; <loadbalancers>; deny all`
(`zulip/puppet/zulip/templates/nginx/healthcheck.conf.template.erb`), so it
answers 200 to the container's own healthcheck and 403 to everything else. The
readiness probe uses `/api/v1/server_settings`, which is public
(`@require_safe @csrf_exempt`, no auth), is served by Django through uwsgi so a
200 proves the whole chain is up, and still honours `ALLOWED_HOSTS` so a
hostname mismatch shows up as a 400.

Adding the compose subnet to `LOADBALANCER_IPS` would also open `/health`, but
it makes Zulip trust `X-Forwarded-For` from those addresses too -- a real
behavioural change to buy nothing but a probe. Not worth it.

Two things worth knowing:

- `run.sh` clears any inherited `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` and
  passes Chromium `--no-proxy-server`. Every request in this stack stays inside
  the compose network, so a proxy injected by the daemon's config or
  `~/.docker/config.json` can only break it. Set `KEEP_PROXY=1` if you
  genuinely need one.
- The hostname must not end in `.localhost` (Chromium hard-codes that to
  loopback) and must match `ZULIP_HOST` in `.env`, which is both the network
  alias on the zulip service and the name baked into the certificate at image
  build time. Changing it needs `make build`.

### Zulip never becomes healthy

```bash
make diagnose      # health-probe output + seeding log + tail of the container log
make health        # just the health-probe output
make logs-zulip    # everything
```

`make up` polls the health status itself rather than using `docker compose up
--wait`, so it prints progress (`Applying zerver.0789_...`, `seed: ...`) while
it waits and prints the reason when it gives up. `make diagnose` is run
automatically on failure.

The health probe reports one of three things, and its output is retained by
Docker where `make health` can show it:

| Probe says | Meaning |
|---|---|
| `seeding FAILED ... Reason:` | the seed script died; the reason and line number follow |
| `seed-complete is missing` | still booting -- migrations or seeding in flight |
| `seeded, but https://localhost/health did not return 200` | seeded, but nginx or Django is not serving |

`healthcheck.sh` requires both `/health` **and** the `/data/seed-complete`
marker, deliberately: the upstream entrypoint runs post-setup scripts under
`set +e` and starts supervisord regardless, so without the marker check
`/health` would go green on an unseeded server and hand Bombadil a useless
instance. `seed.sh` traps its own failures into `/data/seed-failed` so the
probe can say *why*.

If it is simply slow rather than broken, raise the budget:

```bash
ZULIP_WAIT_SECONDS=3600 make up
```

The image's health-check start period is 1800s, during which failing probes do
not count toward `--retries`, so a slow cold boot is tolerated rather than
being declared unhealthy.

Bombadil's own logging is controlled by `RUST_LOG` in `.env`; try
`RUST_LOG=info,chromiumoxide=error` when a container exits immediately.

### The build dies with "session healthcheck failed fatally"

```
WARN[...] healthcheck failed        error="... only one connection allowed"
ERRO[...] healthcheck failed fatally error="session healthcheck failed fatally:
          ... only one connection allowed"
```

These are **dockerd's** logs, not anything from the Zulip or Bombadil
containers (ours are prefixed `seed:`, `seeded-entrypoint:` or `[user1]`). All
four strings live in the `dockerd` binary.

A BuildKit build opens a long-lived connection to the daemon: the client
`POST`s `/session`, dockerd hijacks the connection, and runs a gRPC server over
that one connection for file sync and credential forwarding. When that
connection breaks, gRPC tries to redial, the session listener refuses --
because a hijacked connection allows exactly one -- and the daemon declares the
session dead. So `only one connection allowed` is the symptom; the cause is the
first connection dying. Two sessions failing together means Compose was
building both images in parallel.

The way past it is to not use a session at all:

```bash
CLASSIC_BUILDER=1 make test
```

That selects the legacy builder (`DOCKER_BUILDKIT=0`), turns off Compose's bake
path, and builds one image at a time. Every Dockerfile here is deliberately
classic-compatible -- no `RUN --mount`, no heredocs, no `COPY --link` -- so
this is a real fallback, not a degraded one. The knob is applied as `sudo`'s own
`VAR=VAL` arguments when `COMPOSE` is sudo-prefixed, since `sudo` would
otherwise strip the environment.

`make doctor` prints the client/daemon versions, the builder in use, and the
relevant environment variables, which is what to look at if the classic builder
does not help.

## The specification

`spec/zulip.ts` is the top-level specification; only properties and action
generators may be exported from it.

**Properties.** Three of Bombadil's defaults are kept (`noHttpErrorCodes`,
`noUncaughtExceptions`, `noUnhandledPromiseRejections`). `noConsoleErrors` is
replaced by a filtered version in `spec/lib/console.ts`, because Zulip is
chatty and the unfiltered default fires within seconds. On top of those,
`spec/lib/properties.ts` adds:

| Property | What it says |
|---|---|
| `noServerErrorPage` | never lands on a 500 / 502 / 504 page |
| `noDuplicateRenderedMessages` | a rendered message list never shows the same id twice |
| `messageIdsAscend` | message ids increase down a rendered list (fractional ids for locally echoed messages sort correctly) |
| `unreadCountsAreSane` | unread badges are empty or a non-negative integer |
| `connectionRecovers` | if the "unable to connect, reconnecting" banner appears, it goes away within 60s |
| `sentMessageAppears` | a marked message that leaves the compose box shows up in the feed, or Zulip says where it went |

`sentMessageAppears` is the reason for running *two* instances: each one sends
messages tagged `bombadil-<instance>-<n>`, and the property matches either
instance's marker, so it also covers instance 2 observing instance 1's traffic.

Properties are deliberately conservative. Random exploration produces plenty of
*legitimately* bad-looking UI -- missing topic, not subscribed to the channel,
4xx responses -- so, for example, compose-box validation banners are not
asserted on. If `noHttpErrorCodes` turns out to be noisy (it fires on any
navigation response of 400 or worse, and exploration does click its way into
the odd 404), drop it from `spec/zulip.ts` and rely on `noServerErrorPage`,
which only cares about 5xx.

**Actions.** `spec/zulip.ts` builds its own weighted root generator instead of
re-exporting `defaultActions`, so two staged Zulip flows can be mixed with the
generic ones:

- `login` drives the real `/login/` form, one field per state. Heavily
  weighted, but it contributes nothing at all unless the login form is on
  screen -- so it is free during normal exploration, and recovers quickly after
  random exploration inevitably clicks "log out".
- `composeAndSend` focuses the compose box, types a marked message, and presses
  Enter.

**Triaging console noise.** `spec/lib/console.ts` holds an allow-list of
console error patterns with a comment on each. To extend it, export
`strictConsoleErrors` from `spec/zulip.ts` instead of
`noUnexpectedConsoleErrors`, run once, read the violations out of `make
inspect`, and add the benign ones.

**Editing the spec.** `make typecheck` type-checks `spec/` in strict mode
against the TypeScript sources in the `bombadil/` checkout, so it needs no
`npm install` and cannot drift from the version this stack runs. Bombadil
bundles specifications with its own resolver, so no `node_modules` is needed at
runtime either. The spec is baked into the Bombadil image, so re-run
`make build` (or just `make test`, which builds) after editing it.

## How login without a login flow works

`docker/zulip-seeded/seed.py` creates Django sessions under keys fixed in
`.env`, and each Bombadil container is handed the matching value as
`--cookie "__Host-sessionid=<key>; Secure"`. No cross-container secret handoff,
no shared volume, no host orchestration -- and deterministic, which is what the
Antithesis phase wants.

The cookie must be given in plain `NAME=VALUE` form with only `Secure`: if
`Path` or `Domain` is present, Bombadil also sets `domain` on the CDP cookie
parameter (`bombadil/lib/bombadil-browser/src/cookie.rs`), and a
`__Host-`-prefixed cookie with a domain is invalid.

If that cookie is ever rejected, the run still works: the `login` action
generator drives the real form instead. That generator is worth having
regardless, for the "log out" case.

## Layout

```
compose.yaml                  the whole stack
.env.example                  weak fixed secrets and every tunable
Makefile                      up / test / inspect / logs / down
.dockerignore                 keeps the three upstream checkouts out of the build context
docker/zulip-seeded/
  Dockerfile                  FROM ghcr.io/zulip/zulip-server:12.2-0
  gen-cert.sh                 build-time self-signed certificate
  entrypoint.sh               installs the cert and the seed hook, then execs upstream
  seed.sh                     realm + 3 users, then runs seed.py
  seed.py                     channel, messages, sessions, and the assertions
  healthcheck.sh              /health plus the seed marker
docker/bombadil/
  Dockerfile                  FROM antithesishq/bombadil:0.7.2, bakes in spec/
  run.sh                      launches Chromium, then bombadil browser test-external
spec/
  zulip.ts                    top-level specification
  lib/dom.ts                  extractors
  lib/actions.ts              staged login and compose generators
  lib/properties.ts           Zulip properties
  lib/console.ts              filtered console-error property
  lib/credentials.ts          per-instance identity
  credentials.json            overwritten per instance at container start
out/                          traces and screenshots, one directory per instance
```

The directory is `spec/`, not `bombadil/` -- that name is taken by the upstream
checkout.

## Next: running this under Antithesis

The stack was built so this is a small delta, not a redesign. Both images are
self-contained (no bind mounts, no host orchestration, certificate and seed
data baked in), which is the whole point of building the certificate at image
build time and seeding through `post-setup.d`. The remaining changes:

- replace the `build:` stanzas with pushed image references;
- drop the `./out` bind mount and `--output-path`: with `ANTITHESIS_OUTPUT_DIR`
  set, Bombadil writes no trace file and reports properties as Antithesis
  assertions instead;
- drop `--time-limit` (Antithesis decides how long to run);
- confirm the fuzzer's state-boundary marking comes through
  `test-external` -- Bombadil marks boundaries in its driver-agnostic runner
  loop, but this deserves an explicit check;
- use the `antithesis-setup` / `antithesis-launch` skills for the harness
  layout rather than hand-rolling it.

`connectionRecovers` is the property to watch there: killing Tornado is exactly
the fault that should raise Zulip's reconnect banner and then clear it.
