<p align="center">
  <img src="assets/prod/black-macos-1024.png" width="160" alt="control plane" />
</p>

# Control Plane

This is our spin on [T3 Code](https://github.com/pingdotgg/t3code). It is not an official T3 Tools release.

Signed Mac builds are on [Releases](https://github.com/lucive-apps/control-plane/releases). Packaged apps check those releases for updates from Settings → General. Official installers, mobile, docs, and the rest of the project live in [pingdotgg/t3code](https://github.com/pingdotgg/t3code).

This flavor of T3 includes:

- A much cleaner interface
- A Cursor-style sidebar
- Missing key bindings for things like the pull requests and usage views

Ship a new signed Mac build with `vp run release:fork:desktop` after loading Apple notary credentials. That bumps the patch version, notarizes, and publishes a GitHub Release. Commit the version bump with the ship.

## Why do this?
I build with agents from different subscriptions all day, every day. I like having a surface I can control. I'm also very opinionated about interface clutter, and I wanted to bring a lot of the simplicity I enjoy from Codex/Cursor into my development experience. T3 has done a great job with the platform, I just want to take the front end in a different direction.

## Run from source

You need Node 24 and at least one provider CLI logged in (Codex, Claude, Cursor, Grok, OpenCode, or Antigravity).

### Install vp

```bash
curl -fsSL https://vite.plus | bash
```

Windows: `irm https://vite.plus/ps1 | iex`. More in the [Vite+ guide](https://viteplus.dev/guide/).

### Install and boot

```bash
vp i
vp run dev:desktop --home-dir "$PWD/.t3"
```

`--home-dir` keeps this checkout out of an installed T3 Code. The `[dev-runner]` line should print `baseDir=.../.t3`.

Server and web only:

```bash
vp run dev --home-dir "$PWD/.t3"
```
