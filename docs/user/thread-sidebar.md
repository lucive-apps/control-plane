# Working with threads

Use a new thread for a separate task. Choose **New worktree** when its code changes
need a separate branch and working directory.

The sidebar's **Tasks** section lists your threads grouped by workspace, the folder
they work in. Use **Add workspace** in that section to add another folder.

## Projects in the sidebar

When your server supports [Projects](./projects.md), the **Projects** section sits above
Tasks. Use **New Project** in its header to create one. Click a Project to open its
coordinator, and expand it to see its agents: standing agents first, then one-off and snoozed
agents. Settled agents stay under their Project instead of the Settled view; expand them ten
at a time. Hover a Project and click **+** to start an agent, or right-click it for Rename,
Settings, Archive, Move to Tasks and Delete. Each Project shows its number of running agents
and one dot for its most urgent thread. Its unread dot comes only from the coordinator, which
receives the results of work it hands out. Each agent still shows unread on its own row.

Click **Projects** or **Tasks** to collapse that section. A collapsed section or workspace also
shows one dot for its most urgent thread. Filtering the list to one workspace from a thread's
menu hides Projects until you clear the filter.

To turn a workspace into a Project, right-click its folder under Tasks and choose **Convert to
Project…**.

## Start a thread

On web and desktop, a new thread keeps the current workspace and carries your model
and mode selections, unless the destination workspace has its own model default.
Its branch and checkout come from your configured defaults. To continue in
an existing worktree, use **New thread in this worktree** from the branch toolbar.

When you change a new thread's workspace, T3 Code stays in the current environment
if that workspace exists there. Otherwise it selects an environment that has it.

### Start in the background

In a desktop browser or the desktop app, press `Cmd+Enter` on macOS or `Ctrl+Enter`
on Windows and Linux to start a new thread and immediately open another draft. The
next draft keeps the checkout and base branch you selected. With **New
worktree**, each background submission creates its own worktree.

To send the same prompt to several models on web or desktop, **Shift-click** models
in a new thread's model picker to add or remove them. A regular click returns to a
single model. Choose a base branch and send. Each selection starts a separate thread
and worktree while you stay in the new thread composer. This requires a Git workspace.

## Remove a workspace

On web and desktop, right-click a workspace folder in the sidebar and choose **Remove**.
This deletes the workspace entry and its threads. Files on disk stay. Grouped checkouts
show one Remove item per machine. You can also remove a workspace from
[Workspace settings](./project-settings.md).

## Pin and reorder threads

Pin a thread from its menu to keep it above your active work.

On web and desktop, you can also drag files from your computer onto any thread row:
the thread opens and the files are attached in its composer, ready for
your next message. The same per-message file limits apply as when attaching
files directly; see [Attach files](./composer.md#attach-files).

On web and desktop, pinning or unpinning a thread keeps the sidebar at your current
scroll position instead of following the thread to its new place in the list.

Pinning does not prevent automatic settlement. Settling a thread removes its pin. In a
[Project](./projects.md#agents), a pinned agent is a standing agent and never settles.

On web and desktop, expand a workspace folder and drag a thread up or down to change
its order within that workspace. Pinned threads reorder among pins, and active threads
reorder among active work. Use the thread menu to pin, unpin, settle, or snooze;
reordering keeps the thread's state. Snoozed and settled threads keep their time-based
order. Press Escape or release outside the workspace's thread rows to cancel a drag.

On mobile, open a thread's menu and choose **Arrange threads**. Drag a handle within or between
**Pinned** and **Active** to reorder, pin, or unpin. Drop onto the **Settled** divider to
settle a thread. The dragged card shows the action before you release it. Expand **Snoozed**
or **Settled** to drag a parked thread back into either live section. Each drop saves; **Done** returns to the thread list.
**Move up** and **Move down** are also available in the thread menu. The server
saves the order, so it survives a refresh and appears on your other connected devices.

On web and desktop, the list also animates section changes made with thread actions such as
**Pin**, **Settle**, and **Snooze**. These transitions respect your system's reduced-motion
preference. While dragging, rows follow the insertion gap without replaying a second transition
after the drop.

New threads appear above the active threads you have arranged. Settling clears a thread's active
position, so using **Un-settle** returns it to the top. Pinning and snoozing preserve its active
position until you move it again. Thread activity does not change the order. The settled shelf
continues to use settlement time.

If dragging is unavailable for one environment, update the T3 Code server running in that
environment. Pinned and active reordering require server support. Threads from older servers keep
their default order until the server is updated.

## Order of Projects and workspace folders

Drag a Project or a workspace folder (or press Alt+Up or Alt+Down on a focused Project row) to
change its place. The order is saved on the server that owns the Project or workspace, so it
appears on your other devices, mobile included. Mobile shows arranged folders first in that
order, then the rest by recent activity; it does not reorder yet.

New Projects and workspaces start after the arranged ones. The first time a device sees a
server with no saved order, it publishes its own saved order once; a device that connects later
adopts what is already there. The last drag wins. Dragging while the folder list is sorted by
activity adopts the order you see as the shared order. The sort setting itself stays per
device. Servers that predate this keep the order on each device.

## Order of agents in a Project

Expand a Project and drag an agent up or down, or press Alt+Up or Alt+Down on a focused agent
row. Pinned (standing) agents reorder among themselves and stay above the other agents; active
agents reorder among themselves. A drag never moves an agent into another Project or into
Tasks, and never pins or unpins it. Releasing anywhere else cancels the move.

The order is saved on the agent threads, so it appears on every connected device, mobile
included. On mobile, open an agent's menu and choose **Move up** or **Move down**. New agents
appear at the top of the active agents. An agent you pin appears at the top of the pinned ones;
a standing agent the coordinator creates appears below the pinned agents you have arranged.
Status changes and new messages never reorder agents; only a move does.

## Settle finished work

Choose **Settle thread** from its menu to move finished work out of the active list
without deleting the conversation. **Un-settle thread** restores it to active work
and prevents automatic settlement until new activity resumes the usual rules.
Manually settling an idle thread dismisses unanswered async questions without
sending an answer or restarting the agent.

By default, environments settle inactive threads after three days and settle
threads whose pull request merged. A closed pull request can also settle an idle
thread. Work in progress, pending questions or approvals, and live background work
prevent automatic settlement. A Project's coordinator and standing agents never settle. An open pull request does not prevent inactivity
settlement, but an old closed or merged pull request does not settle work you
resumed after it closed.

Change these rules in **Settings → General** on web and desktop, or **Settings → Thread behavior** on mobile.
They continue to run when your apps are closed. On web and desktop, choose an environment at the
top to change only its rules, or **All environments** to update connected environments together.
Mixed values show where the selected environments disagree. Mobile applies these
rules to connected environments that support shared settings. Offline environments
and older servers keep their previous values. Changing a rule does not reopen
already settled threads.

## Link a pull request

The server finds the PR for each unsettled thread's saved branch, even when your
apps are closed. Settled threads keep their saved links. Update the server if
automatic branch links do not appear.

On web and desktop, right-click a pull request link in a thread and choose
**Link to thread** to select a different PR. Use **Unlink from thread** on the
same link to return to the branch PR, if one exists.
The linked pull request participates in automatic settlement.

## Find and reference work

On web and desktop, open the command palette with `Cmd/Ctrl+K` to search threads
across connected environments. Message search starts after two characters and
includes your messages and final agent responses.

Use **Settings → Keybindings** to find or customize shortcuts for searching files
and copying a thread reference. A copied reference uses the thread's pull request
link when available, otherwise its thread ID. See [keybindings](./keybindings.md)
for custom configuration.

## Inspect agent work

On web and desktop, open the **Subagents** panel to follow delegated work.

Expand a tool call in the conversation to see its full command and output.
Summaries shorten shell wrappers and can still describe the latest call after it
finishes; the call's own result shows its status.

## Snooze until later

Choose **Snooze → Custom…** from a thread's menu to pick a date and time in your
local time zone, or a duration in minutes, hours, or days. Durations start when
you confirm; one day means 24 hours. On web and desktop, you can also snooze
several selected threads together. Choose **Wake thread** to bring a thread back early.
