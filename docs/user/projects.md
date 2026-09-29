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

Any thread you start inside a Project is an agent. New agents start Local in the Project folder
and use the Project's default model.

Pin an agent to make it a standing agent: a reused role that never settles. Unpin it to turn it
back into a one-off agent that you can settle when its work is done. Snoozing keeps the pin.

A standing agent's role can live in `<slug>/AGENTS.md` inside the Project folder, where `<slug>`
is the agent's title in lowercase with dashes. An agent titled `Sales Ops` uses
`sales-ops/AGENTS.md`. It is an ordinary file, so you or the coordinator can edit it.

The coordinator's title always matches the Project name, and renaming the Project renames it.
To replace a stuck coordinator, choose **Set as coordinator** on a Local agent. The old
coordinator stays as a pinned agent, so you can switch back.

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
agents, open the shared instructions, and archive it, move it to Tasks or delete it. A
Project's folder cannot be changed. The coordinator's own model is changed in its composer,
like any thread.

## Archive, Move to Tasks and Delete

- **Archive** stops the Project's running sessions and hides the Project and its threads.
  Archived Projects are listed at the top of **Settings → Archived**, where **Unarchive** brings
  them back.
- **Move to Tasks** turns the Project back into a plain workspace. Its coordinator and agents
  stay as ordinary threads.
- **Delete** removes the Project, its coordinator and its agent threads after you type the
  Project name. The folder and its files stay on disk.
