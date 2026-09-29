# Projects

A Project is a named coordinator with its own folder. The coordinator is a long-running thread
titled with the Project name, and every other thread in the folder is one of its agents. Use a
Project for ongoing work you want one thread to keep track of, such as a personal assistant or a
research area, and start agents in it for individual jobs.

Projects need a Control Plane server that supports them. Older servers and upstream T3 Code
servers show only workspaces.

## Create a Project

Open the command palette and choose **New Project…**. Give it a name and an icon, then pick a
folder:

- **New folder** (the default) creates a folder named after the Project in the Add workspace
  base directory, or in `~/Projects` when none is set.
- **Existing folder** uses a folder that is already on the host. Paths can start with `~`.

Choose the coordinator's model and write the shared instructions that the coordinator and every
agent read. They are saved as `AGENTS.md` in the folder. Control Plane also adds a `CLAUDE.md`
that imports it and a `MEMORY.md` for the coordinator. Files that already exist are never
replaced.

When more than one connected environment supports Projects, choose where the Project lives. A
Project belongs to one environment.

## Convert a workspace

To turn a workspace into a Project, open the command palette from one of its threads and choose
**Convert to Project…**, or choose **Existing folder** in New Project and enter the workspace's
folder. Then pick the coordinator:

- **New thread** starts a fresh coordinator.
- **Existing thread** promotes one of the workspace's threads and keeps its history. Only Local
  threads can coordinate; threads in a worktree cannot.

The dialog shows how many threads become agents. Pinned threads stay pinned as standing agents.
If the workspace has several checkouts, only the chosen folder becomes a Project; the other
checkouts stay under Tasks.

## Agents

Every thread in a Project other than the coordinator is an agent. Start one yourself, or ask the
coordinator to start it for you (see [Delegate to agents](#delegate-to-agents)). New agents start
Local in the Project folder and use the Project's default model, unless you ask the coordinator
for another.

Pin an agent to make it a standing agent: a reused role that never settles. Unpin it to turn it
back into a one-off agent that you can settle when its work is done. Snoozing keeps the pin.

A standing agent's role can live in `<slug>/AGENTS.md` inside the Project folder, where `<slug>`
is the agent's title in lowercase with dashes. An agent titled `Sales Ops` uses
`sales-ops/AGENTS.md`. It is an ordinary file, so you or the coordinator can edit it.

The coordinator's title always matches the Project name, and renaming the Project renames it.
To replace a stuck coordinator, choose **Set as coordinator** on a Local agent. The old
coordinator stays as a pinned agent, so you can switch back.

## Delegate to agents

Ask the coordinator to hand work to agents, for example "Start two agents: one lists the
advantages of SQLite WAL mode, the other its drawbacks." It starts them and ends its turn. When
an agent finishes, its final message comes back to the coordinator on its own, including any
question it has for you. The result shows in the coordinator right away as a reply from that
agent, even while the coordinator is busy, and the coordinator picks it up when its turn ends.
Notifications come from the coordinator's reply, not from each agent finishing work it was asked
to do.

- A one-off agent settles after it reports. Message it to bring it back.
- A standing agent can start its own one-off agents. Their results go to the standing agent,
  which passes on the combined answer.
- The coordinator and standing agents can't start another agent while 4 are running in the
  Project.
- After 6 results in a row reach one thread, the rest wait until you message that thread. A
  notice in the coordinator says which thread.
- A message the coordinator sends to a busy agent waits until that agent's turn ends.
- To stop an agent, choose **Stop agent** from its menu or ask the coordinator. If you stop an
  agent that was working for the coordinator, the coordinator hears that it stopped before
  finishing. Message a stopped agent to start it again.

## Schedules

A Project can send a prompt on a cadence, such as a weekday morning brief. Choose **Schedules**
in the coordinator's header, the Project's menu, **Project settings** or the command palette's
**Project schedules**, then **New schedule**.

- Pick a preset (every day, weekdays, weekly on chosen days, every few hours, monthly) or
  **Custom** for a five-field cron expression. A schedule runs at most every 15 minutes. Times
  are in the host's time zone, and the editor lists the next three runs.
- **Runs in** sends the prompt to the coordinator or to a standing agent. A standing agent's
  result reaches the coordinator like any agent result, so the coordinator's reply is what
  notifies you. In the thread, the prompt shows as "Scheduled" with the schedule's name.
- Schedules run on the machine that hosts the Project, only while Control Plane is running
  there. Turn on **Open at login** in the desktop app on that machine (in the Schedules panel or
  **Settings → Connections**) so they survive a restart. Schedules need the installed desktop
  app on macOS. On Linux, a server started with `CPLANE_SCHEDULES_BACKEND=os` uses systemd user
  timers. Windows is not supported yet.
- If the target is busy, the run waits up to 15 minutes for it.
- **Missed** means the run never started: the host was off or asleep for over 2 hours, Control
  Plane was closed, or the target stayed busy. A run less than 2 hours late still runs once when
  the host wakes, and reads "after sleep". **Failed** means the run started and then errored.
  Both show red in the panel and on the Project's dot until the next run, an edit or a pause.
- The switch pauses and resumes a schedule. **Remove from this host**, in the host menu at the
  bottom of the panel, pauses every schedule on that machine. Turn each back on with its switch.
- Ask the coordinator to create or change a schedule and it will. Schedules it creates or edits
  stay paused, labeled "Created by" or "Edited by", until you turn them on.

## Memory

The coordinator keeps its notes in `MEMORY.md` in the Project folder: your preferences, how work
is routed between agents, and facts it should not forget. Instructions every agent needs belong
in `AGENTS.md` instead.

Choose **Memory** in the coordinator's header to open the file in the right panel, where you can
preview it or edit it. The coordinator loads the changes you save on its next turn. It also
updates the file itself as it works.

## Project settings

Open the command palette from any thread in the Project and choose **Project settings**. There
you can rename the Project, change its icon, open its folder, choose the default model for new
agents, open the shared instructions, manage its schedules, and archive it, move it to Tasks or
delete it. A Project's folder cannot be changed. The coordinator's own model is changed in its
composer, like any thread.

## Archive, Move to Tasks and Delete

- **Archive** stops the Project's running sessions and hides the Project and its threads. Its
  schedules stop running. Archived Projects are listed at the top of **Settings → Archived**,
  where **Unarchive** brings them back, with their schedules counting from that moment.
- **Move to Tasks** turns the Project back into a plain workspace. Its coordinator and agents
  stay as ordinary threads, and its schedules are deleted.
- **Delete** removes the Project, its coordinator and its agent threads after you type the
  Project name. The folder and its files stay on disk.

## On phone and iPad

Home lists Projects above Tasks. Tap a Project to open its coordinator, or tap its chevron to
show its agents and start a **New agent**. The **+** in the Projects header creates a Project.

- Long-press a Project, an agent or a Tasks folder for its actions. A Tasks folder's menu has
  **Convert to Project…**.
- Swipe an agent left to pin or unpin it, or tap **Stop** to stop its turn. A full swipe only
  pins or unpins; it never stops the agent.
- In the coordinator, **Memory** opens `MEMORY.md` in a sheet; choose **Edit** to change it. The
  Project menu next to it opens **Project settings** and has Rename, Archive, Move to Tasks
  and Delete. From an agent, the header takes you back to its coordinator.
- **Schedules**, the clock next to Memory, opens the Project's schedules in a sheet, as do
  **Schedules** in the Project's long-press menu on Home and **Project settings → Schedules**.
  Flip a switch to pause or resume, tap **Run now**, or tap a schedule to edit it. **Open at
  login** and **Remove from this host** are in the desktop app.
