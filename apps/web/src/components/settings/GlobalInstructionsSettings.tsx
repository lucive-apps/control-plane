import type { GlobalInstructionsScopes, GlobalInstructionsScopesPatch } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useState } from "react";

import { useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { type EnvironmentPresentation, usePrimaryEnvironment } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  globalInstructionsErrorMessage,
  globalInstructionsUsage,
} from "./GlobalInstructionsSettings.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";

const SCOPE_ROWS: ReadonlyArray<{
  readonly key: keyof GlobalInstructionsScopes;
  readonly title: string;
  readonly description: string;
}> = [
  {
    key: "coordinators",
    title: "Coordinators",
    description: "Each Project's coordinator thread.",
  },
  {
    key: "projectAgents",
    title: "Project agents",
    description: "One-off and standing agents in a Project.",
  },
  {
    key: "tasks",
    title: "Tasks threads",
    description: "Threads outside a Project.",
  },
];

/**
 * The user's own rules for every session on the environment being viewed,
 * whatever the provider. The text lives in that server's GLOBAL_AGENTS.md, so
 * agents and editors can change it on disk too. Hidden until connected.
 */
export function GlobalInstructionsSettings() {
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
    <GlobalInstructionsSection
      key={environment.environmentId}
      environment={environment}
      scopes={environment.serverConfig.settings.globalInstructions}
    />
  );
}

type LoadState =
  | { readonly phase: "loading" }
  | { readonly phase: "failed"; readonly error: string }
  | { readonly phase: "ready"; readonly path: string; readonly saved: string };

function GlobalInstructionsSection({
  environment,
  scopes,
}: {
  readonly environment: EnvironmentPresentation;
  /** Absent on a server older than this setting. */
  readonly scopes: GlobalInstructionsScopes | undefined;
}) {
  const environmentId = environment.environmentId;
  const globalInstructions = useAtomCommand(serverEnvironment.globalInstructions, {
    reportFailure: false,
  });
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [load, setLoad] = useState<LoadState>({ phase: "loading" });
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const { id, title } = searchableSetting("global-instructions");

  const read = useCallback(async () => {
    const result = await globalInstructions({ environmentId, input: { action: "read" } });
    if (result._tag === "Success") {
      setLoad({ phase: "ready", path: result.value.path, saved: result.value.text });
      setDraft(result.value.text);
    } else if (!isAtomCommandInterrupted(result)) {
      setLoad({
        phase: "failed",
        error: globalInstructionsErrorMessage(squashAtomCommandFailure(result)),
      });
    }
  }, [environmentId, globalInstructions]);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- The read RPC is the external system; its state lands only after the await.
    void read();
  }, [read]);

  const save = async () => {
    setSaving(true);
    const result = await globalInstructions({
      environmentId,
      input: { action: "write", text: draft },
    });
    setSaving(false);
    if (result._tag === "Success") {
      setLoad({ phase: "ready", path: result.value.path, saved: result.value.text });
      toastManager.add({
        type: "success",
        title: "Global instructions saved",
        description: "New sessions use them. Running sessions keep what they started with.",
      });
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Could not save global instructions",
        description: globalInstructionsErrorMessage(squashAtomCommandFailure(result)),
      });
    }
  };

  const setScope = (patch: GlobalInstructionsScopesPatch) =>
    updateSettings({ globalInstructions: patch });

  const usage = globalInstructionsUsage(draft);
  const dirty = load.phase === "ready" && draft !== load.saved;

  return (
    <SettingsSection id={id} title={title}>
      <SettingsRow
        title="Instructions"
        description={
          <>
            Rules every session on {environment.label} gets, whatever the provider, ahead of the
            Project's AGENTS.md and MEMORY.md, which win where they conflict. New sessions pick up
            edits; running sessions keep the text they started with.
            {load.phase === "ready" ? (
              <>
                {" "}
                Also editable on disk at <code className="break-all">{load.path}</code>.
              </>
            ) : null}
          </>
        }
      >
        <div className="mt-3 space-y-2">
          {load.phase === "failed" ? (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <span>{load.error}</span>
              <Button size="xs" variant="outline" type="button" onClick={() => void read()}>
                Retry
              </Button>
            </div>
          ) : (
            <Textarea
              aria-label="Global instructions"
              className="font-mono text-xs"
              placeholder={
                "- Never use em dashes.\n- Run tests, typecheck and lint locally before merging."
              }
              rows={10}
              disabled={load.phase === "loading"}
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p
              className={cn(
                "text-xs tabular-nums",
                usage.tone === "over"
                  ? "text-destructive"
                  : usage.tone === "near"
                    ? "text-warning"
                    : "text-muted-foreground",
              )}
            >
              {usage.label}
            </p>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                type="button"
                disabled={!dirty || saving}
                onClick={() => load.phase === "ready" && setDraft(load.saved)}
              >
                Revert
              </Button>
              <Button
                size="sm"
                type="button"
                disabled={!dirty || saving}
                onClick={() => void save()}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
          {usage.warning ? (
            <p role="alert" className="text-xs text-destructive">
              {usage.warning}
            </p>
          ) : null}
        </div>
      </SettingsRow>
      {scopes
        ? SCOPE_ROWS.map((row) => (
            <SettingsRow
              key={row.key}
              title={row.title}
              description={row.description}
              control={
                <Switch
                  checked={scopes[row.key]}
                  onCheckedChange={(checked) => setScope({ [row.key]: checked })}
                  aria-label={`Global instructions for ${row.title.toLowerCase()}`}
                />
              }
            />
          ))
        : null}
    </SettingsSection>
  );
}
