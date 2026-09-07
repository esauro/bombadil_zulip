# A thin layer over the published Zulip server image that makes the instance
# self-seeding and HTTPS-capable with no bind mounts and no host orchestration.
#
# Nothing in docker-zulip/ is modified; this only uses that image's documented
# extension points (CERTIFICATES=manual and $DATA_DIR/post-setup.d/).
ARG ZULIP_IMAGE=ghcr.io/zulip/zulip-server:12.2-0
FROM ${ZULIP_IMAGE}

# The hostname the certificate is issued for. Must match the network alias the
# Bombadil containers use, and SETTING_EXTERNAL_HOST in compose.yaml.
ARG ZULIP_TEST_HOST=zulip.test

COPY gen-cert.sh /opt/seed/gen-cert.sh
RUN bash /opt/seed/gen-cert.sh "${ZULIP_TEST_HOST}" /opt/seed/certs

COPY seed.sh seed.py entrypoint.sh healthcheck.sh /opt/seed/
RUN chmod 755 /opt/seed \
    && chmod 755 /opt/seed/seed.sh /opt/seed/entrypoint.sh /opt/seed/healthcheck.sh \
    && chmod 644 /opt/seed/seed.py

# A cold boot applies ~950 migrations before the seed script even runs, which
# takes far longer than the base image's 300s start period on an ordinary
# machine. During the start period a failing probe does not count towards
# --retries, so a generous value here costs nothing: `make up` polls the health
# status itself, prints migration and seeding progress as it goes, and bails
# early if the probe reports that seeding failed.
HEALTHCHECK --interval=10s --timeout=10s --retries=3 --start-period=1800s \
    CMD ["/opt/seed/healthcheck.sh"]

ENTRYPOINT ["/opt/seed/entrypoint.sh"]
CMD ["app:run"]
