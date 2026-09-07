# One Bombadil instance, with its own Chromium.
#
# The published image already contains chromium, bash, coreutils, curl and
# fonts, and Bombadil bundles specification TypeScript with its own resolver,
# so spec/ is copied in as-is with no node_modules and no build step.
ARG BOMBADIL_IMAGE=antithesishq/bombadil:0.7.2
FROM ${BOMBADIL_IMAGE}

USER root

# The base image is a Nix layered image; be explicit about the shell used by RUN.
SHELL ["/bin/bash", "-c"]

COPY spec/ /spec/
COPY docker/bombadil/run.sh /run.sh
RUN chmod -R a+rX /spec && chmod 755 /run.sh

# Insurance against a known gap in minimal Nix images: dockerTools only runs
# shadowSetup, so /etc has no nsswitch.conf, protocols or services. Without
# nsswitch.conf glibc's getaddrinfo has no host database configured, which
# would make "zulip.test" unresolvable no matter how correct the compose
# network alias is; without protocols/services some socket lookups fail.
# Docker injects /etc/resolv.conf itself, so that one is already handled.
#
# Each is written only if absent, so a future base image that ships them wins.
RUN set -eu; \
    [ -e /etc/nsswitch.conf ] || printf 'hosts: files dns\n' >/etc/nsswitch.conf; \
    [ -e /etc/protocols ] || printf 'ip 0 IP\nicmp 1 ICMP\ntcp 6 TCP\nudp 17 UDP\n' >/etc/protocols; \
    [ -e /etc/services ] || printf 'http 80/tcp\nhttps 443/tcp\ndomain 53/udp\ndomain 53/tcp\n' >/etc/services; \
    chmod 644 /etc/nsswitch.conf /etc/protocols /etc/services

# The base image runs as the unprivileged "browser" user but sets no HOME;
# chromium and fontconfig both need a writable one. run.sh falls back to a
# temporary directory if this one is not writable, which is what happens when
# compose overrides the uid to match the host's.
ENV HOME=/home/browser
# The Nix layered image sets no PATH; rely on an explicit one rather than the
# daemon's default, so bombadil/chromium/curl are found under any runtime.
ENV PATH=/bin:/usr/bin:/usr/local/bin:/sbin:/usr/sbin

USER browser

ENTRYPOINT ["/bin/bash", "/run.sh"]
