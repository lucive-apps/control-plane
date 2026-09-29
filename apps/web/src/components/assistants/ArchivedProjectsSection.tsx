import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { partitionAssistants } from "@t3tools/client-runtime/state/assistants";
import { ArchiveX } from "lucide-react";
import { useMemo } from "react";

import { useProjects, useThreadShells } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ProjectFavicon } from "../ProjectFavicon";
import { useSettingsScope } from "../settings/SettingsScopeContext";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { useAssistantActions } from "./useAssistantActions";

/** Settings > Archived: archived Projects, above the per-workspace thread groups. */
export function ArchivedProjectsSection() {
  const { scope } = useSettingsScope();
  const projects = useProjects();
  const threads = useThreadShells();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { unarchive } = useAssistantActions();

  const archived = useMemo(() => {
    const environmentIds = new Set(scope.environmentIds);
    const selectedProjectKeys =
      scope.kind === "project" || scope.kind === "checkout"
        ? new Set(scope.members.map((member) => `${member.environmentId}:${member.id}`))
        : null;
    return partitionAssistants(projects, threads, primaryEnvironmentId).archivedAssistants.filter(
      ({ project }) =>
        environmentIds.has(project.environmentId) &&
        (selectedProjectKeys === null ||
          selectedProjectKeys.has(`${project.environmentId}:${project.id}`)),
    );
  }, [primaryEnvironmentId, projects, scope, threads]);

  if (archived.length === 0) return null;
  return (
    <SettingsSection title="Projects">
      {archived.map(({ project, agents }) => (
        <SettingsRow
          key={`${project.environmentId}:${project.id}`}
          title={
            <span className="inline-flex min-w-0 items-center gap-2">
              <ProjectFavicon project={project} className="size-4" />
              <span className="truncate">{project.title}</span>
            </span>
          }
          description={[
            `${agents.length} ${agents.length === 1 ? "agent" : "agents"}`,
            project.assistant?.archivedAt
              ? formatRelativeTimeLabel(project.assistant.archivedAt)
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          control={
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="shrink-0"
              onClick={() => void unarchive(scopeProjectRef(project.environmentId, project.id))}
            >
              <ArchiveX className="size-3.5" />
              <span>Unarchive</span>
            </Button>
          }
        />
      ))}
    </SettingsSection>
  );
}
