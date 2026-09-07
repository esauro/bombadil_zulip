# Django half of the seeding step. Executed as:
#
#     manage.py shell < /opt/seed/seed.py
#
# (Django's `shell` command exec()s stdin when it is not a TTY.)
#
# Everything here is idempotent, and the script raises if the realm or the two
# Bombadil users are missing -- seed.sh tolerates "already exists" failures
# from the management commands, so this is where we actually assert that the
# instance ended up in the shape the test needs.
#
# Reads its inputs from a JSON file written by seed.sh, rather than from the
# environment, because `su` does not reliably forward arbitrary variables.

import json
from importlib import import_module

from django.conf import settings
from django.contrib.auth import BACKEND_SESSION_KEY, HASH_SESSION_KEY, SESSION_KEY

from zerver.actions.create_realm import do_create_realm
from zerver.actions.create_user import do_create_user
from zerver.actions.message_send import internal_send_stream_message
from zerver.actions.streams import bulk_add_subscriptions
from zerver.actions.user_settings import do_change_user_setting
from zerver.lib.streams import ensure_stream
from zerver.models import Message, Realm, UserProfile

CONFIG_PATH = "/run/zulip-seed/config.json"
AUTH_BACKEND = "zproject.backends.EmailAuthBackend"
SEED_MESSAGE_MARKER = "seed-message"

with open(CONFIG_PATH) as f:
    config = json.load(f)

# ---------------------------------------------------------------------------
# 1. Realm and users.
#
# Created here through the same two actions the `create_realm` and
# `create_user` management commands call, rather than by shelling out to those
# commands. Three reasons, in order of how much they cost us:
#
#  * `create_realm` takes `<email>` and `<full name>` as optional positional
#    arguments alongside a required `realm_name`. Passing them with options
#    mixed in was rejected by the 12.2-0 image with
#
#      create_realm: error: unrecognized arguments: admin@zulip.test Realm Admin
#
#    which could not be reproduced against the parser in the 12.0-dev
#    checkout this was written against -- that one accepts the same argv on
#    both Python 3.12 and 3.13. The error matches argparse's behaviour when
#    the three positionals are registered in a different order, but the
#    image's own `--help` reports the same order as the checkout, so the
#    discrepancy was never pinned down. Calling the actions directly removes
#    argument parsing from the picture rather than guessing at it.
#  * It removes a shell round trip per command, and with it the business of
#    rebuilding a command string for `su -c` to re-parse.
#  * Idempotency becomes an explicit `if not ... .exists()` rather than
#    pattern-matching "already exists" out of a CommandError message.
#
# tos_version is passed as None rather than the commands'
# TOS_VERSION_BEFORE_FIRST_LOGIN ("-1"), which is what makes
# zerver.views.home redirect to /accounts/accept_terms/ on first load. With
# TERMS_OF_SERVICE_VERSION unset (the production default) that is all it takes
# to land a pre-minted session straight in the app.
# ---------------------------------------------------------------------------
realm = Realm.objects.filter(string_id=Realm.SUBDOMAIN_FOR_ROOT_DOMAIN).first()
if realm is None:
    realm = do_create_realm(
        string_id=Realm.SUBDOMAIN_FOR_ROOT_DOMAIN, name=config["realm_name"]
    )
    print(f"seed.py: created realm {realm.id} {realm.name!r} at {realm.url}")
else:
    print(f"seed.py: realm {realm.id} {realm.name!r} already exists at {realm.url}")


def ensure_user(spec, *, role, realm_creation=False):
    existing = UserProfile.objects.filter(
        realm=realm, delivery_email__iexact=spec["email"]
    ).first()
    if existing is not None:
        print(f"seed.py: user {existing.delivery_email} already exists")
        return existing
    user = do_create_user(
        spec["email"],
        spec["password"],
        realm,
        spec["full_name"],
        role=role,
        realm_creation=realm_creation,
        tos_version=None,
        acting_user=None,
    )
    print(f"seed.py: created user {user.delivery_email} (role {user.role})")
    return user


# Every realm needs an owner, and it must not be one of the Bombadil users: a
# random explorer with owner permissions can deactivate the realm and end its
# own test.
admin = ensure_user(
    config["admin"], role=UserProfile.ROLE_REALM_OWNER, realm_creation=True
)
users = [ensure_user(spec, role=UserProfile.ROLE_MEMBER) for spec in config["users"]]

# Belt and braces for a realm that predates this script, or was created by the
# management command in an earlier version of it.
for user in [admin, *users]:
    if user.tos_version == UserProfile.TOS_VERSION_BEFORE_FIRST_LOGIN:
        user.tos_version = None
        user.save(update_fields=["tos_version"])
        print(f"seed.py: cleared tos_version for {user.delivery_email}")

# ---------------------------------------------------------------------------
# 2. Land in the combined feed rather than the inbox, so the message list and
#    the compose box are both on screen in the very first state Bombadil sees.
# ---------------------------------------------------------------------------
for user in users:
    if user.web_home_view != "all_messages":
        do_change_user_setting(user, "web_home_view", "all_messages", acting_user=None)
        print(f"seed.py: web_home_view=all_messages for {user.delivery_email}")

# ---------------------------------------------------------------------------
# 3. One shared channel, both Bombadil users subscribed.
#
# This is what makes running two instances worthwhile: whatever instance 1
# sends has to become visible to instance 2.
# ---------------------------------------------------------------------------
channel_name = config["channel"]
topic_name = config["topic"]

stream = ensure_stream(realm, channel_name, invite_only=False, acting_user=None)
print(f"seed.py: channel #{stream.name} (id {stream.id})")

subscribed, already = bulk_add_subscriptions(realm, [stream], [admin, *users], acting_user=None)
for info in subscribed:
    print(f"seed.py: subscribed {info.user.delivery_email} to #{stream.name}")
for info in already:
    print(f"seed.py: {info.user.delivery_email} already subscribed to #{stream.name}")

# ---------------------------------------------------------------------------
# 4. A few messages, so the feed is not empty in the first state.
# ---------------------------------------------------------------------------
existing_seed_messages = Message.objects.filter(
    realm=realm, recipient=stream.recipient, content__contains=SEED_MESSAGE_MARKER
).count()
if existing_seed_messages == 0:
    internal_send_stream_message(
        admin,
        stream,
        topic_name,
        f"Welcome to the {realm.name} instance. ({SEED_MESSAGE_MARKER} 1)",
    )
    for index, user in enumerate(users, start=2):
        internal_send_stream_message(
            user,
            stream,
            topic_name,
            f"{user.full_name} reporting in. ({SEED_MESSAGE_MARKER} {index})",
        )
    print(f"seed.py: posted {1 + len(users)} seed messages to #{stream.name}")
else:
    print(f"seed.py: {existing_seed_messages} seed messages already present")

# ---------------------------------------------------------------------------
# 5. Pre-minted sessions.
#
# Under PRODUCTION, Zulip forces SESSION_COOKIE_SECURE and renames the cookie
# to "__Host-sessionid" (zproject/computed_settings.py). Those are set after
# /etc/zulip/settings.py is imported, so they cannot be turned off from
# configuration -- which is why this stack speaks HTTPS.
#
# Rather than hand a freshly generated session key from this container to the
# Bombadil containers, we create sessions under keys chosen up front in .env.
# Each Bombadil instance then gets a static --cookie value. No shared volume,
# no host glue, deterministic.
#
# SessionStore.save() asserts it is not inside an atomic block
# (zerver/lib/safe_session_cached_db.py), which holds here.
# ---------------------------------------------------------------------------
SessionStore = import_module(settings.SESSION_ENGINE).SessionStore

assert AUTH_BACKEND in settings.AUTHENTICATION_BACKENDS, (
    f"{AUTH_BACKEND} is not in AUTHENTICATION_BACKENDS: {settings.AUTHENTICATION_BACKENDS}"
)

for spec, user in zip(config["users"], users, strict=True):
    session_key = spec["session_key"]
    assert len(session_key) >= 8, "session keys must be at least 8 characters"
    assert session_key.isalnum(), "session keys must be alphanumeric"

    # Drop any previous session under this key, in both the database and the
    # memcached write-through cache, so the create below is unambiguous.
    SessionStore(session_key=session_key).delete()

    session = SessionStore(session_key=session_key)
    session[SESSION_KEY] = str(user.id)
    session[BACKEND_SESSION_KEY] = AUTH_BACKEND
    session[HASH_SESSION_KEY] = user.get_session_auth_hash()
    session.save(must_create=True)
    print(
        f"seed.py: session {session_key} -> {user.delivery_email} "
        f"(cookie {settings.SESSION_COOKIE_NAME})"
    )

# ---------------------------------------------------------------------------
# 6. Assert the instance is actually usable.
# ---------------------------------------------------------------------------
assert not realm.deactivated, "realm is deactivated"
for user in users:
    assert user.is_active, f"{user.delivery_email} is not active"
    assert user.tos_version != UserProfile.TOS_VERSION_BEFORE_FIRST_LOGIN
    # Bombadil explores randomly; an owner could deactivate the realm and end
    # the test, so the two test users are deliberately plain members.
    assert user.role == UserProfile.ROLE_MEMBER, (
        f"{user.delivery_email} has role {user.role}, expected member"
    )

print("seed.py: ok")
