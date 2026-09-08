# Upstream checkouts

`zulip/`, `docker-zulip/` and `bombadil/` are read-only upstream clones, each
with its own `.git`, and they are **not** tracked here -- they are ~2.7 GB and
belong to their own projects. This file records exactly which commits this
project was developed against, so a fresh working copy can be made to match.

```bash
git clone git@github.com:zulip/zulip.git
git -C zulip checkout fc6d57b801293505f9bdc30d9f51b1bcb70a252c   # 12.0-1037-gfc6d57b801

git clone https://github.com/zulip/docker-zulip.git
git -C docker-zulip checkout 4e575b63ba2fdbaff1f2a6d1409d15ebfe4e6202   # helm-2.2.0

git clone git@github.com:antithesishq/bombadil.git
git -C bombadil checkout 4d4871162b1841742682b56dfb2a2e982242a81b   # v0.7.2
```

## What actually needs them

Nothing at runtime. The stack runs entirely from published images, pinned in
`.env`:

| `.env` variable  | Value                                |
| ---------------- | ------------------------------------ |
| `ZULIP_IMAGE`    | `ghcr.io/zulip/zulip-server:12.2-0`  |
| `BOMBADIL_IMAGE` | `antithesishq/bombadil:0.7.2`        |

So `make test` works on a machine with none of the three cloned. The checkouts
are needed only for:

- **`make typecheck`** -- `spec/tsconfig.json` maps
  `@antithesishq/bombadil/*` onto `../bombadil/lib/bombadil/src/specification/`,
  so the specification type-checks against the same sources the pinned image
  runs. Without `bombadil/`, run `cd spec && npm install` instead and the
  `@antithesishq/bombadil` devDependency (pinned to the same 0.7.2) serves the
  same purpose.
- **`make inspect`** -- falls back to `bombadil/target/debug/bombadil` if no
  `bombadil` is on `PATH`; otherwise it uses the container image.
- **Reading Zulip's source** to check a selector or a settings default, which
  is how most of the design decisions here were made.

## Version skew to keep in mind

`zulip/` is `12.0-dev+git` while the image it runs is `12.2-0`. That gap has
already caused one real failure: the `12.2-0` image rejected the
`create_realm` / `create_user` management-command invocation that the checkout's
argument parser accepted, which is why `seed.py` calls `do_create_realm` and
`do_create_user` directly instead. When checking behaviour, prefer asking the
running container -- `make manage ARGS="<command> --help"` -- over reading the
checkout.
