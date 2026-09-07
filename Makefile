# Two Bombadil instances property-testing one ephemeral Zulip.
#
#   make env      # create .env from .env.example
#   make test     # the whole thing: build, boot, seed, run both instances
#   make inspect INSTANCE=user1
#
# See README.md for what each target actually does.

# bash, resolved from PATH -- some distros (and Nix environments) have no /bin/bash.
SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

COMPOSE ?= sudo docker compose
INSTANCE ?= user1
INSPECT_PORT ?= 1073
BOMBADIL_LOCAL := bombadil/target/debug/bombadil

# ---------------------------------------------------------------------------
# Builder selection
#
# A BuildKit build opens a long-lived connection to the daemon: the client
# POSTs /session, dockerd hijacks the connection, and runs a gRPC server over
# that single connection for file sync and credentials. When that connection
# dies, dockerd logs exactly this and the build fails:
#
#   WARN[...] healthcheck failed  error="... only one connection allowed"
#   ERRO[...] healthcheck failed fatally  error="session healthcheck failed
#             fatally: ... only one connection allowed"
#
# (All four strings live in dockerd itself -- they are daemon logs, not
# anything from the Zulip or Bombadil containers.) "only one connection
# allowed" is the session listener refusing gRPC's attempt to redial after the
# first connection broke, so it is a symptom, not the cause.
#
# CLASSIC_BUILDER=1 uses the legacy builder, which opens no session at all,
# and builds one image at a time. Every Dockerfile here is deliberately
# classic-compatible (no --mount, no heredocs, no COPY --link), so this is a
# real fallback rather than a degraded one:
#
#   CLASSIC_BUILDER=1 make test
# ---------------------------------------------------------------------------
ifeq ($(CLASSIC_BUILDER),1)
  BUILD_VARS := DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 COMPOSE_BAKE=false COMPOSE_PARALLEL_LIMIT=1
else
  BUILD_VARS :=
endif

# `sudo` resets the environment, so a plain `VAR=1 sudo docker ...` prefix
# would be dropped before docker ever sees it. When COMPOSE is sudo-prefixed,
# pass the variables as sudo's own VAR=VAL arguments instead.
ifeq ($(firstword $(COMPOSE)),sudo)
  COMPOSE_BUILD := sudo $(BUILD_VARS) $(wordlist 2,$(words $(COMPOSE)),$(COMPOSE))
else
  COMPOSE_BUILD := $(BUILD_VARS) $(COMPOSE)
endif

# Plain `docker`, for the handful of things compose cannot do (reading exit
# codes and health logs). It has to match COMPOSE: if compose needs sudo to
# reach the daemon, so does docker.
ifeq ($(firstword $(COMPOSE)),sudo)
  DOCKER ?= sudo docker
else
  DOCKER ?= docker
endif

# How long `make up` waits for Zulip to seed and come up healthy. A cold boot
# applies ~950 Django migrations before seeding starts, so this is minutes, not
# seconds. The wait is not silent: progress is printed as it goes.
ZULIP_WAIT_SECONDS ?= 1800

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

.PHONY: env
env: .env ## Create .env from .env.example if it does not exist

.env:
	cp .env.example .env
	@echo "Wrote .env from .env.example. Everything in it is a weak, fixed test secret."
	@if [ "$$(id -u):$$(id -g)" != "1000:1000" ]; then \
	    echo; \
	    echo "NOTE: your uid:gid is $$(id -u):$$(id -g), not 1000:1000."; \
	    echo "      Set BOMBADIL_USER=$$(id -u):$$(id -g) in .env so the traces"; \
	    echo "      written to ./out are owned by you."; \
	fi

.PHONY: build
build: env ## Build both images (Zulip with the baked cert and seed hook, Bombadil with the spec)
	$(COMPOSE_BUILD) build

.PHONY: up
up: env ## Boot Zulip and wait until it is seeded and healthy (cold boot: several minutes of migrations)
	mkdir -p out/user1 out/user2
	$(COMPOSE_BUILD) up --build --detach zulip
	@# Polling the health status ourselves rather than using `docker compose
	@# up --wait`, for two reasons: seeding progress stays visible while first
	@# boot runs migrations, and a failure prints the reason instead of just
	@# "container ... is unhealthy" after a ten-minute silence.
	@#
	@# The loop also greps the health-probe output for "seeding FAILED": the
	@# image's start period is deliberately long, so a failed seed would
	@# otherwise sit in "starting" for ten minutes before Docker declares it
	@# unhealthy. No comments inside the loop below -- a `#` in a
	@# backslash-continued shell line swallows the continuation.
	@container="$$($(COMPOSE) ps -aq zulip)"; \
	if [ -z "$$container" ]; then echo "no zulip container was created"; exit 1; fi; \
	deadline=$$(( $$(date +%s) + $(ZULIP_WAIT_SECONDS) )); \
	last=""; \
	while :; do \
	    state="$$($(DOCKER) inspect -f '{{.State.Status}}' "$$container" 2>/dev/null || echo gone)"; \
	    health="$$($(DOCKER) inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$$container" 2>/dev/null || echo none)"; \
	    if [ "$$health" = "healthy" ]; then echo "zulip is healthy."; break; fi; \
	    if [ "$$state" != "running" ]; then \
	        echo; echo "zulip container is $$state, not running."; \
	        $(MAKE) --no-print-directory diagnose; exit 1; \
	    fi; \
	    if [ "$$health" = "unhealthy" ]; then \
	        echo; echo "zulip went unhealthy."; \
	        $(MAKE) --no-print-directory diagnose; exit 1; \
	    fi; \
	    if $(DOCKER) inspect -f '{{if .State.Health}}{{range .State.Health.Log}}{{.Output}}{{end}}{{end}}' \
	        "$$container" 2>/dev/null | grep -q "seeding FAILED"; then \
	        echo; echo "seeding failed; not waiting out the start period."; \
	        $(MAKE) --no-print-directory diagnose; exit 1; \
	    fi; \
	    if [ "$$(date +%s)" -ge "$$deadline" ]; then \
	        echo; echo "zulip did not become healthy within $(ZULIP_WAIT_SECONDS)s (health=$$health)."; \
	        $(MAKE) --no-print-directory diagnose; exit 1; \
	    fi; \
	    line="$$($(COMPOSE) logs --tail 400 zulip 2>/dev/null \
	        | grep -aE 'seed(\.py)?:|seeded-entrypoint:|Applying [a-z_]+\.[0-9]|Running new database migrations|Database migrations completed|=== (Begin|End)' \
	        | tail -1 | cut -c1-160)"; \
	    if [ -n "$$line" ] && [ "$$line" != "$$last" ]; then echo "  $$line"; last="$$line"; fi; \
	    sleep 5; \
	done

.PHONY: health
health: ## Print the zulip container's health-check log (the last few probe outputs)
	@container="$$($(COMPOSE) ps -aq zulip)"; \
	if [ -z "$$container" ]; then echo "no zulip container"; exit 1; fi; \
	$(DOCKER) inspect -f '{{if .State.Health}}status={{.State.Health.Status}} failing_streak={{.State.Health.FailingStreak}}{{range .State.Health.Log}}{{"\n--- probe exit="}}{{.ExitCode}}{{" at "}}{{.Start}}{{"\n"}}{{.Output}}{{end}}{{else}}no healthcheck defined{{end}}' "$$container"

.PHONY: diagnose
diagnose: ## Show why Zulip is not healthy: health-check output plus the seeding log
	@echo
	@echo "===== zulip health-check output ====="
	@$(MAKE) --no-print-directory health || true
	@echo
	@echo "===== seeding log ====="
	@$(MAKE) --no-print-directory seed-log || true
	@echo
	@echo "===== last 60 lines of the zulip container log ====="
	@$(COMPOSE) logs --tail 60 --no-log-prefix zulip 2>&1 | tail -60 || true
	@echo
	@echo "Full log: make logs-zulip"

.PHONY: test
test: up ## Run both Bombadil instances to completion and fail if either reports a violation
	@echo "==> running two Bombadil instances (time limit from BOMBADIL_TIME_LIMIT in .env)"
	$(COMPOSE_BUILD) up --build --detach bombadil-1 bombadil-2
	@# Attached `up` is not usable here: compose would also wait for the
	@# long-running zulip container. `logs --follow` streams both workloads
	@# interleaved and returns once they have both stopped.
	@#
	@# Nor --abort-on-container-exit: we want *both* workloads to finish, and
	@# then to look at both exit codes. Bombadil exits 0 on a clean run
	@# (reaching the time limit counts as normal completion), 1 on an error,
	@# and 2 when a property was violated.
	-$(COMPOSE) logs --follow bombadil-1 bombadil-2
	@# Belt and braces, in case `logs --follow` returned early.
	@for service in bombadil-1 bombadil-2; do \
	    container="$$($(COMPOSE) ps -aq "$$service")"; \
	    [ -n "$$container" ] || continue; \
	    for _ in $$(seq 1 150); do \
	        [ "$$($(DOCKER) inspect -f '{{.State.Running}}' "$$container")" = "false" ] && break; \
	        sleep 2; \
	    done; \
	done
	@failed=0; \
	for service in bombadil-1 bombadil-2; do \
	    container="$$($(COMPOSE) ps -aq "$$service")"; \
	    if [ -z "$$container" ]; then \
	        echo "FAIL $$service: no container found"; failed=1; continue; \
	    fi; \
	    code="$$($(DOCKER) inspect -f '{{.State.ExitCode}}' "$$container")"; \
	    case "$$code" in \
	        0) echo "ok   $$service: completed cleanly" ;; \
	        2) echo "FAIL $$service: property violation (exit 2)"; failed=1 ;; \
	        *) echo "FAIL $$service: error (exit $$code)"; failed=1 ;; \
	    esac; \
	done; \
	echo; \
	echo "Traces: ./out/user1 and ./out/user2 -- inspect with 'make inspect INSTANCE=user1'"; \
	exit $$failed

.PHONY: inspect
inspect: ## Open Bombadil Inspect on a trace: make inspect INSTANCE=user1
	@if [ ! -f "out/$(INSTANCE)/trace.jsonl" ]; then \
	    echo "No trace at out/$(INSTANCE)/trace.jsonl -- run 'make test' first."; exit 1; \
	fi
	@# Bombadil Inspect binds 127.0.0.1 inside the container, so the
	@# containerised fallback needs the host network namespace.
	@if command -v bombadil >/dev/null 2>&1; then \
	    bombadil browser inspect --port $(INSPECT_PORT) "out/$(INSTANCE)"; \
	elif [ -x "$(BOMBADIL_LOCAL)" ]; then \
	    "$(BOMBADIL_LOCAL)" browser inspect --port $(INSPECT_PORT) "out/$(INSTANCE)"; \
	else \
	    echo "Using the container image; open http://127.0.0.1:$(INSPECT_PORT)/ yourself."; \
	    $(DOCKER) run --rm -it --network host \
	      --entrypoint bombadil \
	      -v "$$PWD/out:/out:ro" \
	      bombadil-zulip/bombadil:local \
	      browser inspect --no-open --port $(INSPECT_PORT) "/out/$(INSTANCE)"; \
	fi

.PHONY: typecheck
typecheck: ## Type-check spec/ against the bombadil/ checkout's TypeScript sources
	@# spec/tsconfig.json maps @antithesishq/bombadil/* onto the bombadil/
	@# checkout, which is not tracked in this repo (see CHECKOUTS.md). Say so
	@# plainly rather than emitting a wall of "cannot find module".
	@if [ ! -d bombadil/lib/bombadil/src/specification ]; then \
	    echo "SKIPPED: bombadil/ is not present, and spec/tsconfig.json resolves"; \
	    echo "         @antithesishq/bombadil/* from it. Either clone it (see"; \
	    echo "         CHECKOUTS.md) or run 'cd spec && npm install' to resolve"; \
	    echo "         the same 0.7.2 types from node_modules instead."; \
	    exit 0; \
	fi; \
	if command -v tsc >/dev/null 2>&1; then \
	    tsc -p spec && echo "spec/ type-checks clean."; \
	elif command -v npx >/dev/null 2>&1; then \
	    npx --yes --package=typescript@5 -- tsc -p spec \
	      && echo "spec/ type-checks clean."; \
	else \
	    echo "SKIPPED: neither tsc nor npx is on PATH."; \
	fi

.PHONY: doctor
doctor: ## Print the versions and builder settings needed to diagnose a build failure
	@echo "== how this Makefile talks to docker =="
	@echo "COMPOSE       = $(COMPOSE)"
	@echo "COMPOSE_BUILD = $(COMPOSE_BUILD)"
	@echo "CLASSIC_BUILDER = $(if $(BUILD_VARS),1 (legacy builder),0 (BuildKit))"
	@echo
	@echo "== client environment =="
	@echo "DOCKER_HOST              = $${DOCKER_HOST:-(unset)}"
	@echo "DOCKER_BUILDKIT          = $${DOCKER_BUILDKIT:-(unset)}"
	@echo "COMPOSE_BAKE             = $${COMPOSE_BAKE:-(unset)}"
	@echo "COMPOSE_DOCKER_CLI_BUILD = $${COMPOSE_DOCKER_CLI_BUILD:-(unset)}"
	@echo "COMPOSE_PARALLEL_LIMIT   = $${COMPOSE_PARALLEL_LIMIT:-(unset)}"
	@echo
	@echo "== versions =="
	@$(COMPOSE) version 2>&1 | head -2 || true
	@$(DOCKER) buildx version 2>&1 | head -2 || true
	@echo
	@# Client and daemon versions on separate lines: a session that dies
	@# instantly is often a client/daemon or buildx mismatch.
	@$(firstword $(COMPOSE)) $(if $(filter sudo,$(firstword $(COMPOSE))),docker,) version \
	    --format 'client: {{.Client.Version}}  daemon: {{.Server.Version}}' 2>&1 | head -2 || true
	@echo
	@echo "== builders =="
	@$(DOCKER) buildx ls 2>&1 | head -10 || true

.PHONY: net-check
net-check: ## Ask each Bombadil container whether it can reach Zulip (run while the stack is up)
	@for svc in bombadil-1 bombadil-2; do \
	    echo "===== $$svc ====="; \
	    $(COMPOSE) exec -T $$svc bash -c 'echo "origin     : $$ZULIP_ORIGIN"; echo "proxy vars : HTTP_PROXY=$${HTTP_PROXY:-unset} HTTPS_PROXY=$${HTTPS_PROXY:-unset} http_proxy=$${http_proxy:-unset} https_proxy=$${https_proxy:-unset} NO_PROXY=$${NO_PROXY:-unset}"; echo "commands   : curl=$$(command -v curl || echo MISSING) grep=$$(command -v grep || echo MISSING) sed=$$(command -v sed || echo MISSING)"; echo "summary    :"; curl -k -sS --max-time 5 -o /dev/null -w "  http_code=%{http_code} exitcode=%{exitcode} remote=%{remote_ip}:%{remote_port} errormsg=%{errormsg}\n" "$${ZULIP_ORIGIN%/}/api/v1/server_settings" 2>&1; echo "verbose    :"; curl -kv --max-time 5 -o /dev/null "$${ZULIP_ORIGIN%/}/api/v1/server_settings"' 2>&1 \
	      | tail -40 || echo "  (exec failed -- is $$svc running?)"; \
	    echo; \
	done
	@echo "===== zulip, from inside its own container ====="
	@# /health is allow-listed to 127.0.0.1 in Zulip's nginx config, so it
	@# answers here and 403s from anywhere else. Show both endpoints so the
	@# difference is visible rather than surprising.
	@$(COMPOSE) exec -T zulip bash -c 'curl -ksS --max-time 5 -o /dev/null -w "  localhost/health                     -> %{http_code}\n" https://localhost/health; curl -ksS --max-time 5 -o /dev/null -w "  localhost/api/v1/server_settings     -> %{http_code}\n" https://localhost/api/v1/server_settings' || true
	@echo
	@echo "===== network aliases actually registered for the zulip container ====="
	@container="$$($(COMPOSE) ps -aq zulip)"; \
	if [ -n "$$container" ]; then \
	    $(DOCKER) inspect -f '{{range $$net, $$conf := .NetworkSettings.Networks}}  {{$$net}}: ip={{$$conf.IPAddress}} aliases={{$$conf.Aliases}}{{"\n"}}{{end}}' "$$container"; \
	else \
	    echo "  (no zulip container)"; \
	fi
	@echo "ZULIP_HOST from .env: $$(grep -E '^ZULIP_HOST=' .env 2>/dev/null || echo '(not set; compose default zulip.test applies)')"
	@echo
	@echo "===== from the host, via the published port ====="
	@# If this answers but the in-container probe does not, nginx is reachable
	@# and the problem is name resolution inside the Bombadil image. If neither
	@# answers, nginx is only listening on the container's loopback.
	@port="$$(grep -E '^ZULIP_HTTPS_PORT=' .env 2>/dev/null | cut -d= -f2)"; \
	port="$${port:-8443}"; \
	curl -k -sS --max-time 5 -o /dev/null \
	    -w "  https://localhost:$$port/api/v1/server_settings -> http_code=%{http_code} exitcode=%{exitcode} errormsg=%{errormsg}\n" \
	    "https://localhost:$$port/api/v1/server_settings" 2>&1 || true

.PHONY: logs
logs: ## Follow logs from every service
	$(COMPOSE) logs --follow

.PHONY: logs-zulip
logs-zulip: ## Follow the Zulip container's logs (this is where seeding output shows up)
	$(COMPOSE) logs --follow zulip

.PHONY: seed-log
seed-log: ## Print the whole post-setup/seeding section of the log, tracebacks included
	@block="$$($(COMPOSE) logs --no-log-prefix zulip 2>&1 \
	    | sed -n '/Post setup scripts execution/,$$p')"; \
	if [ -n "$$block" ]; then \
	    printf '%s\n' "$$block" | head -300; \
	else \
	    echo "Seeding has not started yet (still running migrations?)."; \
	    $(COMPOSE) logs --no-log-prefix --tail 5 zulip 2>&1 || true; \
	fi

.PHONY: ps
ps: ## Show container status
	$(COMPOSE) ps -a

.PHONY: manage
manage: ## Run a Zulip management command: make manage ARGS="list_realms"
	$(COMPOSE) exec zulip /sbin/entrypoint.sh app:managepy $(ARGS)

.PHONY: shell
shell: ## Open a shell in the running Zulip container
	$(COMPOSE) exec zulip bash

.PHONY: down
down: ## Stop and remove everything, including the anonymous data volumes
	$(COMPOSE) down --volumes --remove-orphans

.PHONY: clean
clean: down ## Also delete collected traces
	rm -rf out/user1 out/user2
