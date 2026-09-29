# Project schedules

A Project can send a prompt on a cadence. The OS scheduler on the environment's host decides when
to wake up; the server decides what runs. No in-process timer ever runs a schedule, so a schedule
only runs while the server is running on that host.

## One entry per home

[`ScheduleHost`](../../apps/server/src/schedules/ScheduleHost.ts) keeps a single OS entry per T3
home, labeled `<appId>.schedules.<homeKey>` (`homeKey` hashes the environment id, so it survives a
home move). Its calendar is the union of every enabled schedule in an unarchived Project, and it is
removed when none is left. The entry runs the hidden
[`schedules fire`](../../apps/server/src/cli/schedules.ts) command, which POSTs the server and
returns in seconds.

Per-schedule entries would overlap: a fire that retries a down server and then waits on a busy
target can outlive the next slot, and launchd and systemd drop a fire while the previous one runs.
One entry with a fast command avoids that, gives one Background Items prompt, and leaves one label
to own and remove. Each fire runs every schedule's latest slot that has not run yet (up to 2 hours
late), so a dropped or coalesced OS fire is covered by the next one. The entry never holds prompt
text or schedule names.

`schedules fire` never opens `state.sqlite`: building the server's auth layers runs migrations, so
a fire could migrate a database under a running server of another version. It signs its own token
instead (below). When the server is down it retries for 10 minutes and logs the attempt to
`logs/schedules/attempts.jsonl`, which the next startup turns into `missed: not-running`.

## Backends

The desktop's bootstrap, or else `CPLANE_SCHEDULES_BACKEND`, picks the backend
([`scheduleBackend.ts`](../../apps/server/src/schedules/scheduleBackend.ts)). `none` is the
default. `dry-run` writes the would-be entry (a JSON summary plus the rendered `.plist`, or
`.service` and `.timer`) to `<stateDir>/schedules/dry-run/` and shows a fire command to paste,
which is how dev is verified. `os` installs a LaunchAgent
([`launchdBackend.ts`](../../apps/server/src/schedules/launchdBackend.ts)) or a systemd user timer
([`systemdBackend.ts`](../../apps/server/src/schedules/systemdBackend.ts)); Windows has none.

Only the packaged desktop app asks for `os`. The desktop forces `dry-run` in dev builds, so does the
dev runner, and `os` becomes `dry-run` whenever `VITEST` is set in the injected env or the real
process. A dev worktree or a test that installed a LaunchAgent would fire into a home that may be
gone, on the developer's real account. The desktop sends its choice in the fd 3 bootstrap, not in
env: every terminal and agent inherits the server's env, and a server an agent starts by hand in a
temp home would otherwise install a real entry.

The reconciler rewrites its own label only, and only when the bytes change. A hand-deleted entry is
reinstalled. An entry the user turned off (Login Items, a disabled or masked timer) is reported as
`entry-disabled` and never re-enabled: launchd's disable override refuses `bootstrap`, and running
`launchctl enable` would take that choice away.

The entry's output goes outside the home (`~/Library/Logs/<label>.log`, or the journal): launchd
and systemd refuse to start a job whose log directory is gone, which would stop the fire that
removes a deleted home's entry.

The entry runs its program through a `/bin/sh` guard
([`entryProgram.ts`](../../apps/server/src/schedules/entryProgram.ts)). An app moved to the Trash,
or a cleared npx cache, would otherwise fail to spawn on every slot with nothing left to clean up;
the guard removes its own entry instead. A packaged app's entry script sits inside `app.asar`, which
the shell cannot see into, so the guard checks the archive. `schedules fire` also removes its entry
when its state dir is gone, and `uninstall` removes the home's entry.

## Host zone

launchd and systemd fire in the OS zone. The server process can run with another `TZ` (a shell
env, a container) or keep a zone it read before the user changed it. A 07:00 Boise schedule read
in UTC would compute a slot 6 hours off and record every run as late. So slots are read in the zone
`/etc/localtime` names ([`hostZone.ts`](../../apps/server/src/schedules/hostZone.ts)), resolved on
every fire and status call, and a mismatch with the process zone is reported as a host problem.

## The fire token

The fire route (`POST /api/orchestration/schedules/fire`) takes no parameters and accepts only a
two-minute token of kind `schedule-fire`, signed with the home's `server-signing-key`
([`fireToken.ts`](../../apps/server/src/schedules/fireToken.ts)). Session and websocket tokens use
the same key but other kinds, so none of them verifies here and a fire token verifies nowhere else.
A leaked token can only run slots that are already due.

## Prompts stay off the shell

Prompts live in `assistant.schedulePrompts`, which the shell never carries; `schedules.status`
returns them for the editor. Every recorded run updates the Project marker, and carrying up to 20
prompts of 2,000 characters would resend them to every client on each run.

## Delivery

A due run waits in the [runner](../../apps/server/src/schedules/ScheduleRunner.ts) until its
target is idle, for up to 15 minutes, then is appended as `cp-schedule:<key>` and joins the
[agent result delivery](./providers.md#agent-result-delivery) queue. That reactor is the only thing
that starts it, so a thread has one starter and a scheduled prompt never steers a running turn. A
standing agent's scheduled prompt names the coordinator in `source.replyTo`, so its result reaches
the coordinator like any request. Scheduled turns release the push budget, and pushes answering a
schedule are not counted. How a sent run ended is read back from projections and receipts, so a
restart mid-turn still records it as failed.
