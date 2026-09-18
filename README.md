# T3 Code

This is my personal spin on [T3 Code](https://github.com/pingdotgg/t3code). It is not an official T3 Tools release.

Signed Mac builds are on [Releases](https://github.com/nickrroberts/t3/releases). Packaged apps check those releases for updates from Settings → General. Official installers, mobile, docs, and the rest of the project live in [pingdotgg/t3code](https://github.com/pingdotgg/t3code).

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
