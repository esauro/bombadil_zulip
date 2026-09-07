# Plan: two Bombadil instances property-testing an ephemeral Zulip

> **Status (implemented).** M1-M4 are built; see `README.md` for how to run it.
> M0 is resolved by decision rather than by fixing this environment: Docker and
> Docker Compose are assumed to be present wherever the stack is run, and are
> driven by hand. Nothing here was executed in this working environment, so
> §0's caveat still applies to *this* shell -- what was validated without a
> container runtime is listed in §8. M5 (Antithesis) is not built.

Target: `features/initial.md`. Written against this checkout — `zulip/` at
`12.0-dev+git`, `docker-zulip/` at `4e575b6` (image `12.2-0`), `bombadil/` at
`0.7.2`. Every non-obvious claim below cites `file:line` so it can be
re-verified.

**Constraint honoured throughout:** nothing under `zulip/`, `docker-zulip/`, or
`bombadil/` is modified. All new files live at the project root.

---

## 0. Blocker to resolve first

There is no usable container runtime in this working environment:

- `docker` is not on `PATH`; no `/var/run/docker.sock`.
- `docker.lima`/`podman.lima` wrappers exist but `limactl` panics with
  `user: unknown userid 1000` (uid 1000 has no `/etc/passwd` entry here).
- `podman` is on `PATH` but `podman info` fails with `no such file or directory`.

This shell appears to run inside a rootless `pasta`/podman container
(`hostname` = `pasta-esauro-desktop`, no systemd). Everything below can be
*written* here, but **nothing can be run or verified here**. Options:

1. Run the stack from the host shell (outside this container) — recommended.
2. Fix rootless podman inside this container (`newuidmap`/`newgidmap`,
   `/etc/subuid`, a passwd entry for uid 1000) and use `podman compose`.

Decision needed before Milestone 1 can be validated. Milestone 0 is "get
`docker compose version` working somewhere we can drive".

---

## 1. What the three trees give us

### 1.1 `docker-zulip/` — reusable, but not directly

`docker-zulip/compose.yaml` is a working 5-service stack (postgres, memcached,
rabbitmq, redis, zulip) on published images. Two things make it unsuitable as-is:

- It requires Docker **secrets** sourced from a `.env`
  (`compose.override.yaml:15-30`), and its `compose.override.yaml` is
  `.gitignore`d local config we should not depend on.
- We need extra services (two Bombadil containers) and a seeding step, i.e.
  edits to files we are told not to touch.

Compose `include:` is not a way out: it errors when the including file
re-declares a service from an included file, and its relative `build:`/path
resolution against `docker-zulip/` is fragile.

Two facts from `docker-zulip/entrypoint.sh` we *will* exploit:

- Secrets can be passed as **plain env vars** `SECRETS_<key>`
  (`entrypoint.sh:409-424`), so we can drop the Docker-secrets machinery
  entirely. `/run/secrets/zulip__*` merely overrides them
  (`entrypoint.sh:426-445`).
- `runPostSetupScripts` executes every executable in `/data/post-setup.d/`
  **after** migrations and **before** supervisord starts
  (`entrypoint.sh:537-564`, `appRun` at `entrypoint.sh:646-655`), and it is on
  by default (`entrypoint.sh:65`). This is our seeding hook.
- `CERTIFICATES=manual` serves TLS from `/data/certs/manual/zulip.key` +
  `zulip.combined-chain.crt` (`entrypoint.sh:313-379`).
- Any `SETTING_FOO` env var is appended to `/etc/zulip/settings.py`, with
  `True`/`False`/`None` auto-detected as booleans
  (`entrypoint.sh:465-490`, `setConfigurationValue`).

### 1.2 `zulip/` — how to create a realm and two users non-interactively

- `zerver/management/commands/create_realm.py` creates a realm **and** its
  owner in one shot; `--string-id=""` means the root domain
  (`create_realm.py:37-41`), which `check_subdomain_available` permits when the
  root domain is free (`zerver/forms.py:81-93`).
- `zerver/management/commands/create_user.py` adds further users with
  `-r <realm>` `<email> <full name> --password ...`
  (`zerver/lib/management.py:add_create_user_args`).
- Both commands set `tos_version=TOS_VERSION_BEFORE_FIRST_LOGIN` ("-1")
  (`create_realm.py:80`, `create_user.py:51`), which forces a first-login
  interstitial (`zerver/views/home.py:29-38`). The seed script must clear it so
  Bombadil lands straight in the app.
- Rate limiting is settable: `RATE_LIMITING` / `RATE_LIMITING_AUTHENTICATE`
  live in `zproject/default_settings.py:282-283`, so `SETTING_RATE_LIMITING:
  "False"` works.
- Sessions are plain Django `cached_db`
  (`zproject/computed_settings.py:413`, `zerver/lib/safe_session_cached_db.py`),
  and the cookie value is the Django session key. `user_matches_subdomain`
  (`zerver/decorator.py:301`) is satisfied by a root-domain realm.

### 1.3 The one hard architectural fact: **HTTPS is mandatory**

Under `PRODUCTION` (which is true whenever `/etc/zulip/zulip.conf` has
`machine.deploy_type`, `zproject/config.py:18`), Zulip forces:

```
SESSION_COOKIE_SECURE = True          # zproject/computed_settings.py:480
SESSION_COOKIE_NAME = "__Host-sessionid"   # :485
CSRF_COOKIE_NAME   = "__Host-csrftoken"    # :486
```

These are set in `computed_settings.py`, which is imported *after*
`/etc/zulip/settings.py` (`zproject/settings.py:41-45`, with an explicit "do
not add any code after these wildcard imports"). So `ZULIP_CUSTOM_SETTINGS`
**cannot** turn them off. A browser will neither store nor send a `Secure` /
`__Host-`-prefixed cookie on an `http://` origin. **Plain-HTTP Zulip cannot
hold a login session** — so the test stack must speak HTTPS.

### 1.4 `bombadil/` — what the CLI can and cannot do

- `bombadil browser test <ORIGIN> [SPEC.ts]` with `--time-limit`,
  `--output-path`, `--cookie`, `--header`, `--headless`, `--no-sandbox`
  (`docs/manual/src/partials/cli-reference.md`). Exit codes: `0` ok, `1` error,
  `2` property violation.
- `bombadil browser test-external --remote-debugger http://host:9222
  --create-target` attaches to a **browser we launch ourselves**.
- Its managed launcher hard-codes the Chromium flag list and exposes no
  escape hatch (`lib/bombadil-browser/src/browser.rs:1320-1364`) — notably no
  `--ignore-certificate-errors`. Combined with §1.3, this is why we use
  `test-external`.
- `--cookie` becomes a real browser cookie via CDP `Network.setCookies`,
  applied *before* the first navigation (`browser.rs:265-277`), in both managed
  and external modes.
- Cookie-attribute subtlety: if `Path` or `Domain` is given, Bombadil also sets
  `domain` on the CDP param (`lib/bombadil-browser/src/cookie.rs:107-118`).
  A `__Host-`-prefixed cookie must have **no** Domain, so the invocation must be
  `--cookie "__Host-sessionid=<key>; Secure"` — plain form, no `Path`.
- Specs are TypeScript resolved by Bombadil's own bundler (imports of
  `@antithesishq/bombadil/...` are internal, `lib/bombadil/src/specification/`),
  so **no `node_modules` is needed at runtime** — the npm package is only for
  editor types.
- Default generators are composable values, so we can build our own weighted
  root generator instead of re-exporting `defaultActions`
  (`lib/bombadil/src/specification/browser/defaults.ts:18-24`).
- Antithesis integration already exists: `ANTITHESIS_OUTPUT_DIR` switches
  Bombadil into guest mode — state boundaries are marked for the fuzzer and
  properties are reported as Antithesis assertions
  (`lib/bombadil/src/antithesis.rs`, `lib/bombadil/src/runner.rs:97-141`,
  `lib/bombadil-cli/src/browser.rs:416`).
- Release 0.7.2 is published as a Docker image (`antithesishq/bombadil:0.7.2`,
  `lib/nix/docker.nix`) that already contains chromium, bash, coreutils, curl
  and fonts, runs as user `browser`. The locally built
  `bombadil/target/debug/bombadil` is Nix-linked and **not** portable into a
  container.

---

## 2. Design decisions

| # | Decision | Why | Phase-2 (Antithesis) impact |
|---|---|---|---|
| D1 | Our own `compose.yaml` at the repo root, reusing docker-zulip's published images and env-var contract | Cannot edit `docker-zulip/`; need extra services and plain-env secrets | Antithesis wants one self-contained compose file anyway |
| D2 | `EXTERNAL_HOST=zulip.test`, reached over the compose network by alias | Chromium hard-codes `*.localhost` to loopback, so `zulip.localhost` would resolve to the *Bombadil* container | Same alias works in the Antithesis network |
| D3 | HTTPS with a **build-time** self-signed cert, `CERTIFICATES=manual` | §1.3 forces TLS; baking the cert avoids per-boot keygen | Deterministic: no entropy consumed at boot, no bind mounts |
| D4 | We launch Chromium ourselves with `--ignore-certificate-errors --remote-debugging-port=9222`, then `bombadil browser test-external` | §1.4: no flag passthrough in the managed launcher | Also gives us a place to add Antithesis-specific browser flags later |
| D5 | Seeding by a thin image `FROM ghcr.io/zulip/zulip-server:12.2-0` whose entrypoint copies our script into `/data/post-setup.d/` and then `exec`s `/sbin/entrypoint.sh app:run` | Uses the supported hook (§1.1) with zero edits to `docker-zulip/`; everything baked into the image | No bind mounts, no host orchestration, no `docker compose exec` |
| D6 | **Fixed, pre-minted session keys.** The seed script creates Django sessions with keys we choose, so each Bombadil gets a static `--cookie` value from compose | No cross-container secret handoff, no shared volume, no host glue; deterministic | Ideal for Antithesis |
| D7 | Bombadil's two users are plain **members**; a third user is the realm owner | A random explorer that is an owner can deactivate the realm and end the test | Same |
| D8 | Both users subscribed to one shared channel, seeded with a few messages | Makes the two instances *interact* (one types, the other must see it) — the interesting property surface | Same |
| D9 | Time limit from `BOMBADIL_TIME_LIMIT` (default `5m`) | `features/initial.md` requirement | Antithesis controls duration itself; the var just stops mattering |
| D10 | Security simplified: fixed weak secrets in `.env`, rate limiting off, no outgoing email, TLS trust bypassed, terms-of-service prompt cleared | Explicitly requested; instance is ephemeral | Fewer moving parts to make deterministic |

### Rejected alternatives (recorded so they are not re-litigated)

- *Plain HTTP + injected cookie* — impossible (§1.3): `Secure`/`__Host-`.
- *`DevAuthBackend` / `/devlogin/`* — the URL is only wired up in
  `zproject/dev_urls.py` under `DEVELOPMENT`.
- *Flipping `PRODUCTION` off* — `PRODUCTION` is derived from
  `/etc/zulip/zulip.conf` (`zproject/config.py:18`); the dev path expects a
  source tree, not the production image.
- *Trusting our CA inside the Bombadil image* — Chromium on Linux reads NSS
  (`~/.pki/nssdb`), and the Nix-built Bombadil image has no `certutil` and no
  package manager.
- *Letting Bombadil discover the login form on its own* — possible but wastes
  most of a 5-minute budget; kept only as the fallback in D6 (see §4, M2).

---

## 3. File layout (all new, all at the root)

```
compose.yaml                # the whole stack: 5 zulip services + 2 bombadil services
.env.example                # weak, fixed secrets + tunables (copy to .env)
Makefile                    # up / test / logs / inspect / down
docker/
  zulip-seeded/
    Dockerfile              # FROM ghcr.io/zulip/zulip-server:12.2-0
    entrypoint.sh           # install post-setup.d script, then exec upstream entrypoint
    seed.sh                 # realm + 3 users + channel + sessions (idempotent)
    seed.py                 # the Django half of seed.sh (run via manage.py shell)
    gen-cert.sh             # build-time self-signed cert for zulip.test
  bombadil/
    Dockerfile              # FROM antithesishq/bombadil:0.7.2, adds spec + runner
    run.sh                  # launch chromium, wait for CDP + zulip, run test-external
spec/
  zulip.ts                  # properties + action generators (top-level spec)
  lib/                      # helpers: selectors, login stages
  package.json              # devDependency @antithesishq/bombadil, for editor types only
  tsconfig.json
out/                        # gitignored; per-instance traces + screenshots
README.md                   # how to run, how to inspect, how to change the time limit
.gitignore
```

Note the deliberate name: `spec/`, not `bombadil/` — the latter is the upstream
checkout.

---

## 4. Milestones

### M0 — container runtime (blocking, §0)
Get `docker compose version` (or `podman compose`) working. Deliverable: a
one-line note in `README.md` saying which runtime the stack was verified on.

### M1 — ephemeral Zulip, seeded, over HTTPS
1. `docker/zulip-seeded/Dockerfile`: `FROM ghcr.io/zulip/zulip-server:12.2-0`;
   run `gen-cert.sh` at build time to write `/opt/seed/certs/zulip.key` and
   `zulip.combined-chain.crt` (CN/SAN `zulip.test`, 10-year); `COPY` `seed.sh`,
   `seed.py`, `entrypoint.sh`.
2. `entrypoint.sh` (ours): `mkdir -p /data/post-setup.d /data/certs/manual`,
   copy the cert pair and `seed.sh` into place, `chmod +x`, then
   `exec /sbin/entrypoint.sh "$@"` (default `app:run`).
3. `seed.sh` (idempotent, runs as root, drops to `zulip` for manage.py):
   - `list_realms` → if the root realm exists, exit 0.
   - `create_realm "Bombadil Test" --string-id="" admin@zulip.test "Admin"
     --password-file ...` → realm + owner.
   - `create_user -r "" bombadil1@zulip.test "Bombadil One" --password-file ...`
     and the same for `bombadil2@zulip.test`.
   - `manage.py shell < seed.py`.
4. `seed.py`:
   - clear the first-login interstitial: `tos_version = None` for all three
     users (§1.2);
   - create channel `#bombadil` and subscribe both bombadil users
     (`do_create_stream`/`bulk_add_subscriptions`, or the `create_stream` +
     `add_users_to_streams` management commands);
   - post 2–3 seed messages so the message list is non-empty;
   - mint the fixed sessions:
     ```python
     s = SessionStore(session_key=FIXED_KEY)          # one per user
     s[SESSION_KEY] = str(user.id)
     s[BACKEND_SESSION_KEY] = "zproject.backends.EmailAuthBackend"
     s[HASH_SESSION_KEY] = user.get_session_auth_hash()
     s.save(must_create=True)                          # must not be in a transaction
     ```
     (`safe_session_cached_db.SessionStore.save` asserts no open atomic block.)
5. `compose.yaml`: the four backing services copied in shape from
   `docker-zulip/compose.yaml` but with `SECRETS_*`/`POSTGRES_PASSWORD` plain
   env from `.env`; the `zulip` service built from `docker/zulip-seeded` with
   `CERTIFICATES: manual`, `SETTING_EXTERNAL_HOST: zulip.test`,
   `SETTING_RATE_LIMITING: "False"`,
   `SETTING_RATE_LIMITING_AUTHENTICATE: "False"`,
   `SETTING_EMAIL_BACKEND: django.core.mail.backends.dummy.EmailBackend`,
   a network alias `zulip.test`, **no named volume** on `/data` (ephemeral by
   design), `443:443` published for human debugging, and a healthcheck on
   `https://localhost/health` (`curl -k`).

   *Exit criteria:* `curl -k https://localhost/health` is 200; browsing
   `https://localhost/` in a real browser and logging in as
   `bombadil1@zulip.test` reaches the app with no interstitial.

### M2 — one Bombadil instance, logged in
1. `docker/bombadil/Dockerfile`: `FROM antithesishq/bombadil:0.7.2`,
   `COPY spec/ /spec/`, `COPY run.sh /run.sh`, `ENTRYPOINT ["/bin/bash","/run.sh"]`.
2. `run.sh`:
   - wait for Zulip: `until curl -ksf https://zulip.test/health; do sleep 1; done`;
   - `chromium --headless=new --no-sandbox --disable-dev-shm-usage
      --ignore-certificate-errors --remote-debugging-port=9222
      --remote-debugging-address=127.0.0.1 --user-data-dir=$(mktemp -d)
      --window-size=1440,900 about:blank &`
   - wait for CDP: `until curl -sf http://127.0.0.1:9222/json/version; do ...`;
   - `exec bombadil browser test-external
       --remote-debugger http://127.0.0.1:9222 --create-target
       --time-limit "$BOMBADIL_TIME_LIMIT"
       --cookie "__Host-sessionid=$ZULIP_SESSION_KEY; Secure"
       --output-path "/out/$INSTANCE" --output-path-overwrite
       https://zulip.test/ /spec/zulip.ts`
3. *Exit criteria:* the trace's first state is the logged-in app (not `/login/`),
   and `bombadil browser inspect out/user1` shows real Zulip screenshots.

   *Fallback if the `__Host-` cookie is rejected by CDP* (the one genuinely
   uncertain step — Chromium enforces cookie-prefix rules and I could not test
   it here): use the staged login generator described in §5, which drives the
   real `/login/` form. It is worth writing regardless, because Bombadil will
   eventually click "log out" during exploration and needs to recover.

### M3 — two instances, time-boxed, with collected output
1. Add `bombadil-1` / `bombadil-2` services differing only in
   `INSTANCE`, `ZULIP_SESSION_KEY`, and output subdirectory; both
   `depends_on: zulip: {condition: service_healthy}`; both mount `./out`
   locally (phase 1 only — see M5).
2. `make test` = `docker compose up --build --abort-on-container-exit
   --exit-code-from`… — actually, with two workloads we want *both* to finish,
   so: `docker compose up -d --wait zulip`, then
   `docker compose up bombadil-1 bombadil-2` attached, then read both exit codes
   via `docker compose ps -a --format json` and fail the make target if either
   is `2` (violation) or `1` (error).
3. `BOMBADIL_TIME_LIMIT` defaults to `5m` in `.env.example`; overridable per
   run (`BOMBADIL_TIME_LIMIT=30m make test`).
4. `make inspect INSTANCE=user1` runs `bombadil browser inspect out/user1`.

   *Exit criteria:* `make test` runs ~5 minutes, exits 0 on a clean run, and
   leaves two inspectable traces.

### M4 — make the specification actually about Zulip
Start from the defaults, then tighten. In `spec/zulip.ts`:

- **Keep** `noUncaughtExceptions`, `noUnhandledPromiseRejections`,
  `noHttpErrorCodes` — the last only inspects the *navigation* response status
  (`defaults/properties.ts:4-13`), so it is cheap and low-noise.
- **Replace** `noConsoleErrors` with a filtered version; Zulip is chatty and the
  unfiltered property will fire immediately. First run: log what appears, then
  allow-list the known-benign patterns.
- **Add** Zulip-specific properties, all as `always(...)` over extracted cells:
  - no "Ran into an error"/internal-error banner is ever shown;
  - the reconnect banner ("Zulip is reconnecting…") disappears
    `.within(30, "seconds")` — a guarantee property, the shape of
    `errorDisappears` in the manual;
  - message-list invariant: no duplicate message ids rendered, ids
    monotonically increasing down the list;
  - unread counts are never negative and never exceed the rendered message
    count;
  - after a successful compose-box send, the message eventually appears in the
    narrow — the "contextful guarantee" pattern from the manual, which is the
    property that makes running **two** instances worthwhile.
- **Action generators:** own weighted root instead of `defaultActions`:
  `[[300, loginStages], [100, clicks], [100, inputs], [50, scroll],
    [10, navigation], [40, composeAndSend], [1, waitOnce]]`, where
  `composeAndSend` clicks the compose box, types a recognisable marker
  (`bombadil-<instance>-<n>`), and presses Enter — so instance 1's messages are
  observable by instance 2.
- Consider `noResourceLeak({metric: "dom_nodes", ...})` from
  `@antithesishq/bombadil/browser/extras/resources` once the run is stable.

  *Exit criteria:* a 5-minute two-instance run with **zero** false-positive
  violations, and at least one property that provably fires when we break
  something on purpose (e.g. point one instance at a stopped Tornado).

### M5 — Antithesis readiness (phase 2, not built now)
Nothing in M1–M4 should need redesign; the deltas are:

- Replace `build:` with pushed image refs in the Antithesis compose
  (`docker/zulip-seeded` and `docker/bombadil` are already self-contained
  images, which is the whole point of D3/D5).
- Drop the `./out` bind mount and `--output-path`: in guest mode Bombadil
  writes no trace file and reports properties as Antithesis assertions instead
  (`bombadil-cli/src/browser.rs:414-426`, `runner.rs:97-141`).
- Drop `--time-limit` (Antithesis decides), drop `restart: unless-stopped`,
  and re-check `depends_on`/healthcheck usage against current Antithesis
  compose rules.
- Confirm the fuzzer's state-boundary marking works through
  `test-external` — Bombadil marks boundaries in the runner loop, which is
  driver-agnostic, but this deserves an explicit check.
- Use the `antithesis-setup` / `antithesis-launch` skills for the actual harness
  layout rather than hand-rolling it.

---

## 5. The login-recovery generator (design detail)

Bombadil picks one action per state, so a multi-field form login must be a
*staged* generator: it inspects the page and offers exactly one next step,
weighted far above everything else.

```
onLoginPage = extract(...)      # #id_username / #id_password present
stage:
  email empty, not focused   -> [Click #id_username]
  email empty, focused       -> [TypeText EMAIL]
  email set, password empty  -> [Click #id_password]  / [TypeText PASSWORD]
  both set                   -> [Click submit]
not on login page            -> []                    # generator contributes nothing
```

With weight 300 against the defaults' ~400 total, login completes in a handful
of states. Credentials come from the same env vars the seed script used, so
there is a single source of truth in `.env`.

---

## 6. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| CDP rejects the `__Host-`-prefixed cookie | medium — untestable here | Staged login generator (§5), which we want anyway |
| `noConsoleErrors` / reconnect banners produce false positives | high | M4 starts by *observing*, then tightening; keep the noisy defaults off until triaged |
| Bombadil destroys its own test (changes password, deactivates account, deletes the channel) | medium | Members not owners (D7); login generator recovers from logout; realm-level damage is capped because the instance is ephemeral |
| First boot is slow (migrations + provisioning) and the 5-minute budget starts before Zulip is ready | high | `run.sh` polls `/health` *before* starting the timer; `depends_on: service_healthy` |
| `/data` with no volume means a full re-seed on every `up` | by design | ~1–2 min; document it |
| Antithesis compose restrictions differ from my assumptions | medium | M5 explicitly re-verifies with the Antithesis skills instead of guessing |

---

## 7. Open questions for you

1. **Runtime** (§0): host Docker, or should I try to fix rootless podman here?
2. **Image source**: pull `antithesishq/bombadil:0.7.2` from Docker Hub, or
   build the image locally from `bombadil/flake.nix` (offline, but needs Nix +
   ~20 min)?
3. **Headless or headed?** Headless is the default above. Headed
   (`--window-size` + Xvfb, or a real X socket) is nicer for watching two
   browsers work, but adds an X dependency and will not survive to Antithesis.
4. Anything already known-broken in Zulip that you want the first properties
   aimed at, or is this purely exploratory for now?

---

## 8. What was validated without a container runtime

Recorded so the first real `make test` knows what is already known-good and
what is still unexercised.

Verified:

- `spec/zulip.ts` bundles and its exports classify: run through the locally
  built `bombadil/target/debug/bombadil browser test-external` against an
  unreachable debugger, which loads and verifies the specification *before*
  touching a browser (`bombadil_browser::runner::launch`). Bombadil rejects any
  export that is neither a `Formula` nor an `ActionGenerator`, so all ten
  properties and the action generator are well-formed.
- The same, from a copy of `spec/` in a temporary directory with a rewritten
  `credentials.json` -- the exact shape `docker/bombadil/run.sh` produces.
- `credentials.json` is really read at specification load: a deliberately
  invalid marker fails with
  `credentials.json: marker "bad marker!" must match /^[A-Za-z0-9-]+$/`.
- `spec/` type-checks clean in strict mode with `noUncheckedIndexedAccess`,
  against the TypeScript sources in `bombadil/` (`make typecheck`).
- Every `${VAR}` in `compose.yaml` is either defaulted or present in
  `.env.example`, and every key in `.env.example` is used.
- Every variable `seed.sh` requires is set on the `zulip` service, and every
  variable `run.sh` requires is set on both `bombadil-*` services.
- Shell and Python syntax of all five scripts.
- Every selector the specification uses was read out of this checkout's
  templates: `#login_form` / `#id_username` / `#id_password`
  (`templates/zerver/login.html`), `textarea#compose-textarea`
  (`web/templates/compose.hbs`), `.message-list[data-message-list-id]` /
  `.message_row[data-message-id]` / `.message_content`
  (`web/templates/message_list.hbs`, `single_message.hbs`, `message_body.hbs`),
  `.connection-error-banner` (`web/src/popup_banners.ts`),
  `.above_compose_banner.success`
  (`web/templates/compose_banner/message_sent_banner.hbs`), `.unread_count`
  (`web/src/ui_util.ts`, which only ever writes an integer or `""`).

Not exercised, and therefore the things to watch on the first run:

1. Whether Chromium accepts the `__Host-`-prefixed cookie over CDP. `run.sh`
   now checks the session server-side with `curl` first, so the log
   distinguishes a mis-seeded session from a rejected cookie. Either way the
   staged login generator recovers.
2. The seeding path end to end -- `manage.py shell < seed.py`, and the
   `SessionStore(...).save(must_create=True)` call.

   The realm and users are no longer created by shelling out to the
   `create_realm` / `create_user` management commands: the 12.2-0 image
   rejected the invocation with `unrecognized arguments: admin@zulip.test
   Realm Admin`, which could not be reproduced against the 12.0-dev
   checkout's parser on either Python 3.12 or 3.13. `seed.py` now calls
   `do_create_realm` / `do_create_user` directly, which is what those
   commands do anyway, and drops both the argparse ambiguity and the
   `su -c "$(printf %q ...)"` quoting layer.
2a. **Version skew.** Everything in §1.2 was read out of `zulip/`, which is
   `12.0-dev+git`, but the container runs the published `12.2-0` image
   (deployment `/home/zulip/deployments/2026-08-10-18-14-46/`). The management
   commands' arguments and the internals `seed.py` imports could differ from
   what was verified here. `make manage ARGS="create_realm --help"` against a
   running container is the way to check the signature that actually applies.
2b. **`/health` is localhost-only.** Zulip's nginx allow-lists it to
   127.0.0.1, ::1 and any configured load balancers, so it is usable by the
   container's own healthcheck and by nothing else. The Bombadil containers
   wait on `/api/v1/server_settings` instead. §1.2 did not record this, and
   it cost a round trip.
3. False-positive rate of `noUnexpectedConsoleErrors` (its allow-list is
   seeded with guesses, not observations) and of `noHttpErrorCodes`.
4. `messageIdsAscend` during a narrow change, where a transient out-of-order
   render is conceivable.
