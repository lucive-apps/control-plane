# Remote access

Connect a phone, browser, or another desktop app to T3 Code running on a different
machine. That machine must stay running and reachable while you work.

Control Plane connects your devices over [Tailscale](https://tailscale.com).
Put the host and each device on the same tailnet, then pair each device with a
link from the host. See [Tailscale HTTPS](#tailscale-https) below.

## Pair over Tailscale or a private network

Use direct pairing when the other device can reach the host's network address.

On a desktop host, open **Settings → Connections**, enable **Network access**,
then create a pairing link using an address the other device can reach. Changing
network access restarts the desktop app. You can turn it off in the same place.

For a command-line host, replace `<private-ip>` with the host's LAN or tailnet
address:

```bash
t3 serve --host <private-ip>
```

If a server is already running, generate a fresh link without restarting it:

```bash
t3 pair
```

Scan the QR code on your phone or paste the pairing URL into **Add environment**
in the receiving app. Connection settings are under **Settings → Connections**
on web and desktop and **Settings → Environments** on mobile. A loopback address
such as `127.0.0.1` reaches only the device opening the link.

Pairing authorizes that device for future connections. Use a fresh one-time link
for each new device; you do not need the original token to reconnect. Links
created in Settings can only be copied from the client that created them while
its Connections page stays open. If you leave or reload that page, create
another link to share.

### Balance new threads across machines

Auto balance is off by default. On web and desktop, enable it in
**Settings → Connections → Load balancing** to automatically choose a machine for
new threads in workspaces grouped across connected environments. The section
appears once two or more machines are switched on.
Each machine starts at **Normal**. Choose **Prefer** to favor it when it has CPU and
memory available, **Less often** to reduce its share, or **Manual only** to exclude
it from automatic selection. These are preferences, not fixed traffic percentages.
Preferences are saved separately in each client.

The composer checks eligible machines when choosing a draft's environment, then keeps
that choice stable. Choose **Auto balance** again to check current resources, or choose
a specific machine to override it. Choosing a branch or worktree also keeps the draft
on that machine. Existing threads stay where they started. If resource checks are
unavailable or all eligible machines are full, choose a machine manually to continue.
Mobile keeps its manual environment selection.

### Start agents on other machines

A coordinator can start its agents on another machine, such as a Mac Mini on the
same tailnet. Set this up in **Settings → Connections → Agent machines** while viewing
the machine the coordinator runs on.

To link a machine, create a pairing link on it (in **Settings → Connections** there, or
with `t3 pair --tailscale`), then choose **Add machine** and paste the link. If the
link's address is not reachable from the coordinator's machine, enter one that is under
**Address**. Linking lets the coordinator's machine run agents there with full access,
so link only machines you trust it with.

**Where new agents run** has three modes:

- **This machine** starts every agent on the coordinator's machine. This is the default.
- **One machine** sends every agent to the machine you pick.
- **Balance across machines** sends each agent to the machine with the fewest running
  agents, weighted by each machine's preference. **Manual only** keeps a machine out of
  automatic choice; a coordinator can still name it.

An agent runs in the matching Project on the other machine, so the Project must exist on
both. Machines are matched by repository, or by Project title and folder name. A machine
without the Project is skipped, and each row shows how many of your Projects it matches.
The agent uses that machine's folder, files and `AGENTS.md`, and its edits stay there.
The thread appears in that machine's sidebar.

When the chosen machine is offline or has no matching Project, the agent starts on this
machine instead. Turn off **Use this machine if no other is available** to fail instead.
Standing agents always stay on the coordinator's machine.

A link lasts 30 days. After that the row shows **Needs re-link**; add the machine again
with a new pairing link. Unlinking removes the saved access here; to revoke it fully,
remove the client from **Settings → Connections** on the other machine.

### Tailscale HTTPS

Join both devices to the same tailnet. In the desktop app, enable **Tailscale
HTTPS** in **Settings → Connections**, then create a pairing link that uses its
`ts.net` address. Turn it off there to remove that route.

To start a command-line server with Tailscale HTTPS:

```bash
t3 serve --tailscale-serve
```

For an already-running server:

```bash
t3 pair --tailscale
```

The pairing link uses an address such as `https://machine.tailnet.ts.net/`.
The mapping created by `pair --tailscale` persists across restarts. Remove its
default-port mapping with:

```bash
tailscale serve --https=443 off
```

If that port is already in use, choose another with
`--tailscale-serve-port`. See `t3 pair --help` for other pairing options.

### Hosted web app

[app.t3.codes](https://app.t3.codes) needs an HTTPS endpoint. It connects directly
to your server; a hosted pairing link does not make an unreachable backend
reachable or convert HTTP to HTTPS.

For a plain HTTP LAN endpoint, use the direct pairing URL in a browser that can
open it, or pair from the desktop app. On mobile, an IP address entered without a
scheme uses HTTP, so include `https://` when your server uses HTTPS.

## Desktop-managed SSH

In the desktop app, open **Settings → Connections → Add environment**, choose
**SSH**, and enter a host or SSH alias such as `user@example.com`. T3 Code starts
or reuses a server there and opens the port forward for you. Workspaces, provider
credentials, and agent work stay on the remote machine.

The remote host must be Linux or an Apple Silicon Mac with `curl` or `wget`,
`tar`, `sha256sum` or `shasum`, and [provider setup](./install.md#providers).
The first launch downloads T3 Code's server to `~/.t3/runtime` on the host, so
it takes longer than later ones.
Provider CLIs must be on the `PATH` of a non-interactive login shell there;
check with:

```bash
ssh user@example.com 'sh -lc "command -v claude codex"'
```

If SSH reconnecting fails after an app update, retry the launch once. Removing
the connection stops a server that T3 Code launched; a server that was already
running is left alone.

For Antigravity's Google callback on a remote host, see
[remote sign-in](./providers-antigravity.md#sign-in-from-a-remote-device).

## Manage or revoke access

On the host, **Settings → Connections** lets authorized administrators create
pairing links and revoke client sessions. Revoking an unused link prevents new
pairings; revoke a device's session to remove its existing access. Command-line
management is available through `t3 auth --help`.

A session with an open connection stays listed after its access credential
expires.

Treat pairing URLs and authorization codes as passwords. Do not include them in
screenshots, logs, or bug reports.

## Troubleshooting

If a paired device cannot reach the host, check that both show as connected in
Tailscale (`tailscale status`) and that the host is running. If the host
disappears when SSH closes, see
[background-service troubleshooting](./background-service.md#troubleshooting).
For a connection that still fails, check the date and time on both devices. For
server version warnings, follow [Updating T3 Code](./updating.md).

## Using the Desktop App as a Remote Only

If a computer should only drive work running elsewhere, turn off its local environment. In the
desktop app, open **Settings → Connections** and switch off **Local
environment**. T3 Code restarts without a local server: no local agents or terminals run, WSL
backends stay off, and other devices can no longer connect to this computer. Your workspaces,
history, and saved connections are kept, and you keep working through pairing or SSH.

Switch **Local environment** back on in the same place to restart with your previous local
settings.
