import {
  type AgentMachinePreference,
  type AgentMachineStatus,
  type AgentPlacementSettings,
  type AgentPlacementSettingsPatch,
  type EnvironmentId,
  type EnvironmentMachineKind,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { MoreVertical, PlusIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import { useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import {
  type EnvironmentPresentation,
  useEnvironments,
  usePrimaryEnvironment,
} from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { RefreshIcon } from "../ui/refresh-icon";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  agentMachineEntryPatch,
  agentMachineLinkInput,
  agentMachineStatusDotClassName,
  agentMachineStatusPresentation,
  agentMachinesErrorMessage,
  agentMachineStatusesById,
  agentPlacementModeOptions,
  isAgentPlacementMode,
  linkedAgentMachines,
  projectMatchText,
  singleAgentMachineOptions,
  singleAgentMachineValue,
  summarizeAgentPlacement,
} from "./AgentMachinesSettings.logic";
import { EnvironmentRow, environmentTransportLabel } from "./EnvironmentRow";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { loadPreferences } from "./LoadBalancingSettings";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";

/**
 * Folded section under Load balancing: where coordinators on the environment
 * being viewed start new agents, and the machines linked to it. Unlike Load
 * balancing this is a server setting, so it edits that environment only and
 * is hidden until the environment is connected.
 */
export function AgentMachinesSettings() {
  const scope = useOptionalSettingsScope();
  const primaryEnvironment = usePrimaryEnvironment();
  const environment = scope ? scope.environment : primaryEnvironment;
  if (
    environment === null ||
    environment.connection.phase !== "connected" ||
    environment.serverConfig === null
  ) {
    return null;
  }
  return (
    <AgentMachinesSection
      key={environment.environmentId}
      environment={environment}
      placement={environment.serverConfig.settings.agentPlacement}
    />
  );
}

function AgentMachinesSection({
  environment,
  placement,
}: {
  readonly environment: EnvironmentPresentation;
  readonly placement: AgentPlacementSettings;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environment.environmentId);
  const update = useCallback(
    (patch: AgentPlacementSettingsPatch | null) => {
      if (patch !== null) updateSettings({ agentPlacement: patch });
    },
    [updateSettings],
  );
  const { id, title } = searchableSetting("agent-machines");
  return (
    <FoldedSettingsSection id={id} title={title} summary={summarizeAgentPlacement(placement)}>
      <AgentMachinesBody environment={environment} placement={placement} update={update} />
    </FoldedSettingsSection>
  );
}

export interface AgentMachinesCheckState {
  readonly phase: "checking" | "done" | "failed";
  readonly statuses: ReadonlyMap<string, AgentMachineStatus>;
  /** When `statuses` arrived; token expiry is measured from here, not from render. */
  readonly checkedAt: number;
  readonly error?: string;
}

function checkedState(statuses: ReadonlyArray<AgentMachineStatus>): AgentMachinesCheckState {
  return { phase: "done", statuses: agentMachineStatusesById(statuses), checkedAt: Date.now() };
}

/** Mounts when the fold opens, so each opening checks the machines once. */
function AgentMachinesBody({
  environment,
  placement,
  update,
}: {
  readonly environment: EnvironmentPresentation;
  readonly placement: AgentPlacementSettings;
  readonly update: (patch: AgentPlacementSettingsPatch | null) => void;
}) {
  const environmentId = environment.environmentId;
  const agentMachines = useAtomCommand(serverEnvironment.agentMachines, { reportFailure: false });
  const { environments } = useEnvironments();
  const [check, setCheck] = useState<AgentMachinesCheckState>({
    phase: "checking",
    statuses: new Map(),
    checkedAt: 0,
  });
  const [addOpen, setAddOpen] = useState(false);
  const [unlinking, setUnlinking] = useState<string | null>(null);

  // Starts in "checking"; the caller sets that phase for a manual refresh.
  const requestCheck = useCallback(async () => {
    const result = await agentMachines({ environmentId, input: { action: "check" } });
    if (result._tag === "Success") {
      setCheck(checkedState(result.value.machines));
    } else if (!isAtomCommandInterrupted(result)) {
      setCheck((previous) => ({
        ...previous,
        phase: "failed",
        error: agentMachinesErrorMessage(squashAtomCommandFailure(result)),
      }));
    }
  }, [agentMachines, environmentId]);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- The check RPC is the external system; its state lands only after the await.
    void requestCheck();
  }, [requestCheck]);

  const refresh = () => {
    setCheck((previous) => ({ ...previous, phase: "checking" }));
    void requestCheck();
  };

  const unlink = async (machineId: string, label: string) => {
    setUnlinking(machineId);
    const result = await agentMachines({
      environmentId,
      input: { action: "unlink", id: machineId },
    });
    setUnlinking(null);
    if (result._tag === "Success") {
      setCheck(checkedState(result.value.machines));
      toastManager.add({
        type: "success",
        title: `Unlinked ${label}`,
        description: `To revoke its access fully, remove ${environment.label} from the clients list in Settings → Connections on ${label}.`,
      });
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: `Could not unlink ${label}`,
        description: agentMachinesErrorMessage(squashAtomCommandFailure(result)),
      });
    }
  };

  return (
    <>
      <AgentMachinesView
        environmentLabel={environment.label}
        localKind={resolveEnvironmentMachineKind(environment.serverConfig)}
        localSubtitle={environmentTransportLabel(environment)}
        machineKind={(machineId) =>
          resolveEnvironmentMachineKind(
            environments.find((candidate) => candidate.environmentId === machineId)?.serverConfig ??
              null,
          )
        }
        placement={placement}
        check={check}
        unlinking={unlinking}
        update={update}
        onRefresh={refresh}
        onAdd={() => setAddOpen(true)}
        onUnlink={(machineId, label) => void unlink(machineId, label)}
      />
      <AddAgentMachineDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        environmentId={environmentId}
        environmentLabel={environment.label}
        onLinked={(statuses) => setCheck(checkedState(statuses))}
      />
    </>
  );
}

/**
 * The open section's rows, from props only so it can be rendered against a
 * fixture. `AgentMachinesBody` owns the RPC state.
 */
export function AgentMachinesView({
  environmentLabel,
  localKind,
  localSubtitle,
  machineKind,
  placement,
  check,
  unlinking,
  update,
  onRefresh,
  onAdd,
  onUnlink,
}: {
  readonly environmentLabel: string;
  readonly localKind: EnvironmentMachineKind;
  readonly localSubtitle: ReactNode;
  readonly machineKind: (machineId: string) => EnvironmentMachineKind;
  readonly placement: AgentPlacementSettings;
  readonly check: AgentMachinesCheckState;
  readonly unlinking: string | null;
  readonly update: (patch: AgentPlacementSettingsPatch | null) => void;
  readonly onRefresh: () => void;
  readonly onAdd: () => void;
  readonly onUnlink: (machineId: string, label: string) => void;
}) {
  const balanced = placement.mode === "balanced";
  const machines = linkedAgentMachines(placement);
  const checking = check.phase === "checking";

  return (
    <>
      <div className="flex items-center gap-2 px-3 py-2.5 sm:px-4">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          Where coordinators on {environmentLabel} start new agents. A linked machine needs the same
          Project to take an agent.
        </p>
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={checking}
          onClick={onRefresh}
          aria-label="Refresh machine status"
        >
          <RefreshIcon refreshing={checking} className="size-3" />
          Refresh
        </Button>
        <Button size="xs" variant="outline" onClick={onAdd}>
          <PlusIcon className="size-3" />
          Add machine
        </Button>
      </div>
      {check.phase === "failed" ? (
        <p role="status" className="px-3 py-2.5 text-xs text-destructive sm:px-4">
          Could not check machines: {check.error}
        </p>
      ) : null}
      <SettingLine label="Where new agents run">
        <Select
          items={agentPlacementModeOptions}
          value={placement.mode}
          onValueChange={(value) => {
            if (value !== null && isAgentPlacementMode(value)) update({ mode: value });
          }}
        >
          <SelectTrigger size="xs" className="w-48" aria-label="Where new agents run">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {agentPlacementModeOptions.map(({ value, label }) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </SettingLine>
      {placement.mode === "single" ? (
        <SettingLine label="Machine">
          <Select
            items={singleAgentMachineOptions(placement)}
            value={singleAgentMachineValue(placement)}
            onValueChange={(value) => {
              if (value !== null) update({ singleMachineId: value });
            }}
          >
            <SelectTrigger size="xs" className="w-48" aria-label="Machine for new agents">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {singleAgentMachineOptions(placement).map(({ value, label }) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </SettingLine>
      ) : null}
      <SettingLine
        label="Use this machine if no other is available"
        description="An agent sent to a named machine never falls back."
      >
        <Switch
          aria-label="Use this machine if no other is available"
          checked={placement.allowLocalFallback}
          disabled={placement.mode === "local"}
          onCheckedChange={(allowLocalFallback) => update({ allowLocalFallback })}
        />
      </SettingLine>
      <EnvironmentRow kind={localKind} label={environmentLabel} subtitle={localSubtitle}>
        <PreferenceSelect
          label={environmentLabel}
          value={placement.localPreference}
          disabled={!balanced}
          onChange={(localPreference) => update({ localPreference })}
        />
        {/* Keeps the preference column aligned with the linked rows' menu button. */}
        <span aria-hidden className="size-8 sm:size-7" />
      </EnvironmentRow>
      {machines.map((machine) => {
        const status = check.statuses.get(machine.id);
        const presentation = checking
          ? { label: "Checking…", tone: "muted" as const }
          : agentMachineStatusPresentation(status, check.checkedAt);
        const matches = projectMatchText(status);
        return (
          <EnvironmentRow
            key={machine.id}
            kind={machineKind(machine.id)}
            label={machine.label}
            dimmed={!machine.enabled}
            subtitle={
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    agentMachineStatusDotClassName(presentation.tone),
                  )}
                />
                <span className="truncate">
                  {presentation.label}
                  {matches ? ` · ${matches}` : ""}
                </span>
              </span>
            }
            below={
              status?.detail && status.status !== "connected" ? (
                <p className="text-xs break-words text-muted-foreground/70">{status.detail}</p>
              ) : null
            }
          >
            <Switch
              aria-label={`Start agents on ${machine.label}`}
              checked={machine.enabled}
              onCheckedChange={(enabled) =>
                update(agentMachineEntryPatch(placement, machine.id, { enabled }))
              }
            />
            <PreferenceSelect
              label={machine.label}
              value={machine.preference}
              disabled={!balanced || !machine.enabled}
              onChange={(preference) =>
                update(agentMachineEntryPatch(placement, machine.id, { preference }))
              }
            />
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost-muted"
                    disabled={unlinking !== null}
                    aria-label={`${machine.label} options`}
                  />
                }
              >
                <MoreVertical />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem variant="destructive" onClick={() => onUnlink(machine.id, machine.label)}>
                  Unlink
                </MenuItem>
              </MenuPopup>
            </Menu>
          </EnvironmentRow>
        );
      })}
      {machines.length === 0 ? (
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
          No linked machines. Add one to start agents on it.
        </p>
      ) : null}
    </>
  );
}

function SettingLine({
  label,
  description,
  children,
}: {
  readonly label: string;
  readonly description?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">{label}</p>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  );
}

function PreferenceSelect({
  label,
  value,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: AgentMachinePreference;
  readonly disabled: boolean;
  readonly onChange: (value: AgentMachinePreference) => void;
}) {
  return (
    <Select
      items={loadPreferences}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <SelectTrigger size="xs" className="w-32" aria-label={`${label} agent preference`}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {loadPreferences.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function AddAgentMachineDialog({
  open,
  onOpenChange,
  environmentId,
  environmentLabel,
  onLinked,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onLinked: (statuses: ReadonlyArray<AgentMachineStatus>) => void;
}) {
  const agentMachines = useAtomCommand(serverEnvironment.agentMachines, { reportFailure: false });
  const [pairingUrl, setPairingUrl] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const canSubmit = pairingUrl.trim().length > 0 && !busy;

  const close = () => {
    setPairingUrl("");
    setBaseUrl("");
    onOpenChange(false);
  };

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    const result = await agentMachines({
      environmentId,
      input: agentMachineLinkInput(pairingUrl, baseUrl),
    });
    setBusy(false);
    if (result._tag === "Success") {
      onLinked(result.value.machines);
      toastManager.add({
        type: "success",
        title: result.value.linked ? `Linked ${result.value.linked.label}` : "Machine linked",
        description: `Coordinators on ${environmentLabel} can now start agents there.`,
      });
      close();
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Could not link machine",
        description: agentMachinesErrorMessage(squashAtomCommandFailure(result)),
      });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
        else onOpenChange(true);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a machine for agents</DialogTitle>
          <DialogDescription>
            On the other machine, create a pairing link in Settings → Connections, or run{" "}
            <code>t3 pair --tailscale</code>, and paste it here.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="agent-machine-pairing-url">Pairing link</Label>
              <Input
                id="agent-machine-pairing-url"
                placeholder="https://mini.tailnet.ts.net/pair#token=…"
                autoComplete="off"
                value={pairingUrl}
                onChange={(event) => setPairingUrl(event.target.value)}
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="agent-machine-base-url">Address (optional)</Label>
              <Input
                id="agent-machine-base-url"
                placeholder="Use when the link's address is not reachable from here"
                autoComplete="off"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Linking lets {environmentLabel} run agents on that machine with its full access.
              Access lasts 30 days, then the machine needs linking again.
            </p>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {busy ? "Linking…" : "Link machine"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
