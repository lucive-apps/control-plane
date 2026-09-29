# Settings and workspace overrides

On web and desktop, the Settings breadcrumb ends with the environment and workspace a change applies to. They start
at **All environments** and **All workspaces** and stay selected as you move between categories or
search for a setting.

Preferences saved on this device, such as appearance, confirmations and browser profiles, always
show and ignore the selection. Everything else is stored on a server. Choose one environment to
edit its settings, or leave **All environments** to edit every connected environment at once.
Offline environments keep their current values; this is a bulk edit, not a synced global default.

Choose a workspace to override settings for it on the selected environments. A layers icon beside
each server row's title shows where the value comes from: the built-in default, the environment,
or a workspace override. Click it to see that chain on every selected environment. An override can
be reset to inherit again. Settings that cannot be overridden by a workspace are shown read-only
while a workspace is selected.

When the selected environments disagree, the control shows **Mixed** in place of a value and the
layers icon turns amber. Picking a value applies it to every selected environment.

Changing an environment value never touches a workspace's own override. When workspaces override the
setting you are editing, the layers icon counts them and the chain lists each one with its value:
click a workspace to jump to it, or **Reset all** to make those workspaces follow the environment
again.

Providers and diagnostics are per machine: they show one environment at a time, the primary
one until you pick another. Every other setting fans out to the selection.

On mobile, open **Settings** and use the filter in its header to choose connected environments
and a workspace. The filter stays available in server-setting pages. With **All workspaces** selected,
the **Server settings** categories and auto-settle controls in **Thread behavior** edit the
selected environments' defaults. Choosing a workspace edits its overrides on the selected
environments. Use **Use defaults** in a page to remove that page's workspace overrides.
Open **Settings → Workspaces & threads → Overview** to rename the workspace across its selected
connected checkouts and see where those checkouts live.
Settings that are environment-wide stay read-only while a workspace is selected. When selected
targets disagree, a control shows **Mixed** until you choose one value. Appearance, keyboard,
and other phone-only settings ignore the filter.

## Defaults and inheritance

General contains the model and checkout for new threads. Integrations controls agent browser
access. Source Control contains automatic pull, the default pull request merge method and text
generation. The same rows edit environment defaults or workspace overrides depending on the
workspace crumb.

The Workspace category, shown while a workspace is selected, holds the workspace's name, icon, actions,
checkouts and removal. On web and desktop, right-click a workspace in the sidebar and choose
**Remove** for the same action. Actions belong to a workspace: editing them creates the workspace's
own list on each selected environment, and reset returns to the environment's shared list. A
workspace's `t3.json` actions can be imported there.

When the selected workspace is a [Project](./projects.md), the category holds Project settings
instead: name, icon, folder, the default model for new agents, the shared instructions, a
Schedules row that opens the Project's [schedules](./projects.md#schedules), Archive, Move to
Tasks and Delete. The model is the Project's override of the environment default.

For the checkout setting, a workspace's `t3.json` preference applies when the workspace has no override.
Browser access changes apply when an agent session next starts.

New worktrees initialize git submodules recursively. If that step is slow because the repository
declares many nested submodules, set `"worktreeSubmodules"` in `t3.json` to `"top-level"` to stop
at the ones the repository declares itself, or `"none"` to leave them for a setup script.

## Storage cleanup

Open **Settings → Storage** to enable automatic cleanup on one machine or all connected
environments. Policies are off by default and run on the server at startup, when changed, and
hourly. Offline machines keep their existing policies.

Select a workspace to set **Automatic worktree cleanup** to **Inherit**, **Off**, or **Custom**.
Inherit follows each machine's rules; Off keeps that workspace's worktrees until you remove them
manually. Custom applies separate worktree rules to the selected workspace or checkout. Browser
captures and log retention remain machine-wide.

Worktrees can be removed after a chosen number of inactive days, after merging, or when they
have no commits beyond the default branch. Only T3-managed worktrees are eligible. Active
sessions, shared worktrees, uncommitted changes, and ignored files other than `node_modules`
prevent removal. Branches and thread history stay; starting another turn recreates the checkout.
Merge cleanup requires the commits to be included in the remote default branch, so squash merges
may need the inactivity rule instead.

Enable **Delete worktrees with deleted threads** to remove safe worktrees after their last
thread is deleted, including archived threads and worktrees left by earlier deletions. The
server waits for sessions and terminals to stop and retries skipped worktrees after restart.
Existing prompts for deleting a worktree manually remain available when this policy is off.

Browser captures and rotated logs have separate retention periods. Expired capture links stop
working. Current logs, message attachments, and browser profiles are kept.

## Workspace icons

Select the workspace and open Workspace to choose an icon, emoji, monogram, or image. The choice applies to
every checkout in the workspace group and appears on connected clients. Choose **Automatic** to let
T3 Code detect an icon again.

Choose **Monogram** in the icon picker to set one or two letters or numbers and a color.

When no image is found, web and desktop show a two-character monogram with a color
from the icon palette, derived from the saved workspace name. For example, `Nebula` becomes `NA`,
`Silver Orchard` becomes `SO`, and `M7 Forge` becomes `M7`.

## Keep the default branch current

In Source Control, enable **Automatically pull** to keep the default-branch checkout up to date
with its configured upstream. Choose an environment to set the default or a workspace to override it.
On mobile, use **Settings → Source control** to change selected environment defaults or workspace overrides.

T3 Code only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.
