# Muse Code

Muse Code is a beta integration and is disabled by default. Install
[Muse Code](https://dev.meta.ai/docs/muse-code) on the machine hosting your
environment, then run `muse login` as the account that runs Control Plane.

Open **Settings → Providers**, add or enable **Muse Code**, and set **Binary
path** if Muse is not on the host's `PATH`. Refresh provider status after
installation or login, then pick a Muse model in a thread's model picker.

Provider status does not check your login or billing. If you are signed out, or
Meta cannot verify your payment method, messages fail with Muse's error until
you fix it on the host.

## Sign-in and API keys

Control Plane ignores a `META_API_KEY` inherited by its own server, so Muse uses
the credential saved by `muse login`. To use an API key instead, add
`META_API_KEY` to the Muse instance's environment variables in **Settings →
Providers**.

## Models

Models and reasoning choices come from Muse's own catalog on the host. Refresh
provider status in **Settings → Providers** after changing Muse configuration.
"Default" uses the model Muse marks as its default.

## Projects

Muse takes no system prompt, so Control Plane puts its runtime and Project
instructions at the start of the first message of each Muse session, and a
short pointer to the Project files on later messages.

## Permissions and limitations

**Supervised** asks before commands and edits; **Full access** runs them
without asking. Muse has no separate Plan mode in Control Plane.

Muse can use Control Plane's tools. If Muse cannot reach them, the turn
continues without them. Muse subagents and workflows show as agent rows in the
thread; they do not open child threads yet. Conversation rewind and manual
compaction are unavailable.
