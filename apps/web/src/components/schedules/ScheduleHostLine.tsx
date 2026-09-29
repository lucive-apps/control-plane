import type {
  EnvironmentId,
  ProjectScheduler,
  ScheduleHostProblem,
  ScheduleHostStatus,
} from "@t3tools/contracts";
import { CopyIcon, EllipsisIcon } from "lucide-react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useOpenAtLogin } from "../settings/OpenAtLoginSetting";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import { useScheduleActions } from "./useScheduleActions";

/** What a host problem means for the user, in one line. */
function problemText(problem: ScheduleHostProblem, host: ScheduleHostStatus): string {
  switch (problem) {
    case "no-gui-session":
      return "Nobody is logged in to this Mac's desktop, so macOS won't run schedules until someone is.";
    case "no-user-manager":
      return "Schedules need systemd user services on this Linux host.";
    case "no-linger":
      return "Schedules run only while you are logged in to this host. Enable lingering to run them after you log out.";
    case "entry-disabled":
      return "The host's schedule entry is turned off (Login Items on macOS). Schedules won't run until it's back on.";
    case "zone-mismatch":
      return host.hostZone
        ? `The host's time zone is ${host.hostZone}, but Control Plane is using ${host.timeZone}. Restart Control Plane to switch.`
        : "The host's time zone changed. Restart Control Plane to switch.";
    case "ephemeral-path":
      return "Control Plane is running from a disk image or temporary folder. Move it to Applications so schedules can find it.";
    case "install-failed":
      return host.entry.detail
        ? `Couldn't install the schedule entry: ${host.entry.detail}`
        : "Couldn't install the schedule entry.";
    case "unsupported-platform":
      return "Schedules aren't available on Windows yet.";
    case "backend-off":
      return "Schedules are off on this host.";
  }
}

/**
 * Open at login as a host's panel sees it. The switch lives only in the
 * desktop app on the Project's own host; every other client names the host.
 */
export function useHostOpenAtLogin(environmentId: EnvironmentId) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const { state, setEnabled } = useOpenAtLogin();
  const onThisHost = environmentId === primaryEnvironmentId && window.desktopBridge !== undefined;
  const hostLabel =
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    "that host";
  return { onThisHost, hostLabel, state, setEnabled };
}

export type HostOpenAtLogin = ReturnType<typeof useHostOpenAtLogin>;

/**
 * The panel footer's host line: where and when schedules run, host
 * problems, Open at login, the dry-run entry, and "Remove from this host".
 */
export function ScheduleHostLine(props: {
  readonly environmentId: EnvironmentId;
  readonly scheduler: ProjectScheduler;
  readonly host: ScheduleHostStatus | null;
  readonly openAtLogin: HostOpenAtLogin;
}) {
  const { host } = props;
  const actions = useScheduleActions();
  const problems = host?.problems.filter((problem) => problem !== "backend-off") ?? [];
  const dryRun = host?.backend === "dry-run" ? host.entry : null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1">Runs while Control Plane is running on this host.</p>
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="-my-0.5 text-muted-foreground hover:text-foreground"
                aria-label="Host actions"
              />
            }
          >
            <EllipsisIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-48">
            <MenuItem
              variant="destructive"
              onClick={() => void actions.pauseAll(props.environmentId)}
            >
              Remove from this host
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      {problems.map((problem) => (
        <p key={problem} role="alert" className="text-warning-foreground">
          {problemText(problem, host!)}
        </p>
      ))}
      {props.scheduler === "launchd" ? <OpenAtLoginLine {...props.openAtLogin} /> : null}
      {dryRun ? <DryRunEntry path={dryRun.path} fireCommand={dryRun.fireCommand} /> : null}
    </div>
  );
}

function OpenAtLoginLine({ onThisHost, hostLabel, state, setEnabled }: HostOpenAtLogin) {
  if (!onThisHost) return <p>Turn on Open at login in Control Plane on {hostLabel}.</p>;
  if (state === null) return null;
  if (!state.supported) return <p>Open at login is available in the installed app.</p>;
  return (
    <div className="flex items-center gap-2">
      <p className="min-w-0 flex-1">
        {state.requiresApproval
          ? "Open at login: allow Control Plane in System Settings → General → Login Items."
          : "Open at login"}
      </p>
      <Switch
        size="sm"
        checked={state.enabled}
        onCheckedChange={(checked) => void setEnabled(checked)}
        aria-label="Open at login"
      />
    </div>
  );
}

/** Dev only: the entry file the OS would load, and the command it would run. */
function DryRunEntry(props: {
  readonly path?: string | undefined;
  readonly fireCommand?: string | undefined;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <div className="flex flex-col gap-1">
      <p>Dry run: the entry is written here and never installed.</p>
      {props.path ? <code className="break-all font-mono text-[11px]">{props.path}</code> : null}
      {props.fireCommand ? (
        <div className="flex items-start gap-1">
          <code className="min-w-0 flex-1 break-all font-mono text-[11px]">
            {props.fireCommand}
          </code>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={isCopied ? "Copied" : "Copy fire command"}
            onClick={() => copyToClipboard(props.fireCommand!, undefined)}
          >
            <CopyIcon className="size-3" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
