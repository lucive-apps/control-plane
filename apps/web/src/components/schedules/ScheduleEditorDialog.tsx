import {
  cronToPreset,
  DEFAULT_SCHEDULE_PRESET,
  formatScheduleRunTime,
  presetToCron,
  schedulePresetError,
  type ScheduleDraft,
  type SchedulePreset,
  type SchedulePresetKind,
  type ScheduleTargetOption,
} from "@t3tools/client-runtime/state/schedules";
import {
  PROJECT_SCHEDULE_NAME_MAX,
  PROJECT_SCHEDULE_PROMPT_MAX,
  type ProjectSchedule,
  type ProjectScheduleTarget,
} from "@t3tools/contracts";
import {
  describeCron,
  newScheduleId,
  nextScheduleRuns,
  validateScheduleCron,
} from "@t3tools/shared/schedules";
import { useId, useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

const PRESET_LABELS: Record<SchedulePresetKind, string> = {
  daily: "Every day",
  weekdays: "Weekdays",
  weekly: "Weekly on",
  hourly: "Every N hours",
  monthly: "Monthly",
  custom: "Custom",
};
const PRESET_KINDS = Object.keys(PRESET_LABELS) as SchedulePresetKind[];
// Monday first, the way people read a week; values are cron weekdays (Sunday = 0).
const WEEK_DAYS = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [0, "Sun"],
] as const;
const HOUR_STEPS = Array.from({ length: 12 }, (_, index) => `${index + 1}`);
const MONTH_DAYS = Array.from({ length: 28 }, (_, index) => `${index + 1}`);

const pad = (value: number) => (value < 10 ? `0${value}` : `${value}`);

/**
 * New and edit schedule sheet. Presets come first and Custom takes a cron;
 * an untouched cadence saves the stored cron as it is. `prompt` is the stored
 * prompt from `schedules.status`, undefined until it loads. `changed` says the
 * stored schedule moved on since the sheet opened, which the server would
 * refuse to overwrite.
 */
export function ScheduleEditorDialog(props: {
  readonly schedule: ProjectSchedule | null;
  readonly prompt: string | undefined;
  readonly promptPending: boolean;
  readonly promptFailed: boolean;
  readonly changed: "edited" | "deleted" | null;
  readonly targetOptions: readonly ScheduleTargetOption[];
  readonly timeZone: string;
  readonly onSave: (draft: ScheduleDraft) => Promise<boolean>;
  readonly onDelete: (schedule: ProjectSchedule) => Promise<boolean>;
  readonly onClose: () => void;
}) {
  const { schedule, targetOptions, timeZone } = props;
  const id = useId();
  const [name, setName] = useState(schedule?.name ?? "");
  const [target, setTarget] = useState<ProjectScheduleTarget>(schedule?.target ?? "coordinator");
  const [typedPrompt, setTypedPrompt] = useState<string | null>(null);
  const [preset, setPreset] = useState<SchedulePreset>(() =>
    schedule ? cronToPreset(schedule.cron) : DEFAULT_SCHEDULE_PRESET,
  );
  const [cadenceTouched, setCadenceTouched] = useState(schedule === null);
  const [isSaving, setIsSaving] = useState(false);

  const prompt = typedPrompt ?? props.prompt ?? "";
  // Unknown until status loads; an untouched field then saves the stored prompt.
  const promptUnknown = schedule !== null && typedPrompt === null && props.prompt === undefined;
  const changed = isSaving ? null : props.changed;
  const cron = cadenceTouched || schedule === null ? presetToCron(preset) : schedule.cron;
  const cadenceError =
    cadenceTouched || schedule === null ? schedulePresetError(preset) : validateScheduleCron(cron);
  const nextRuns = cadenceError === null ? nextScheduleRuns(cron, timeZone, new Date(), 3) : [];
  const trimmedName = name.trim();
  const targetKnown = targetOptions.some((option) => option.value === target);
  const promptRequired = schedule === null || typedPrompt !== null;
  const canSave =
    !isSaving &&
    changed === null &&
    trimmedName.length > 0 &&
    cadenceError === null &&
    targetKnown &&
    (!promptRequired || prompt.trim().length > 0);

  const changePreset = (next: Partial<SchedulePreset>) => {
    setCadenceTouched(true);
    setPreset((current) => ({ ...current, ...next }));
  };

  const save = async () => {
    if (!canSave) return;
    setIsSaving(true);
    const saved = await props.onSave({
      id: schedule?.id ?? newScheduleId(trimmedName),
      name: trimmedName,
      cron,
      target,
      enabled: schedule?.enabled ?? true,
      // Only a new or edited prompt travels; omitted keeps the stored one.
      ...(promptRequired ? { prompt } : {}),
      updatedAt: schedule?.updatedAt,
    });
    setIsSaving(false);
    if (saved) props.onClose();
  };

  const remove = async () => {
    if (schedule === null) return;
    setIsSaving(true);
    const deleted = await props.onDelete(schedule);
    setIsSaving(false);
    if (deleted) props.onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isSaving) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{schedule ? "Edit schedule" : "New schedule"}</DialogTitle>
            <DialogDescription>
              Sends a prompt on a cadence, in this host's time zone.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4 text-base sm:text-sm">
            {changed !== null ? (
              <p role="alert" className="text-warning-foreground">
                {changed === "deleted"
                  ? "This schedule was deleted since you opened it."
                  : "This schedule changed since you opened it. Close and reopen it to edit the latest version."}
              </p>
            ) : null}
            <Field label="Name" htmlFor={`${id}-name`}>
              <Input
                nativeInput
                id={`${id}-name`}
                autoFocus={schedule === null}
                autoComplete="off"
                placeholder="Morning brief"
                maxLength={PROJECT_SCHEDULE_NAME_MAX}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>

            <Field label="Runs in" htmlFor={`${id}-target`}>
              <Select
                value={targetKnown ? (target as string) : null}
                items={Object.fromEntries(
                  targetOptions.map((option) => [option.value, option.label]),
                )}
                onValueChange={(value) => {
                  if (value) setTarget(value as ProjectScheduleTarget);
                }}
              >
                <SelectTrigger id={`${id}-target`}>
                  <SelectValue placeholder="Pick where it runs" />
                </SelectTrigger>
                <SelectPopup>
                  {targetOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <Label htmlFor={`${id}-prompt`}>Prompt</Label>
                {!promptUnknown ? (
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {prompt.length}/{PROJECT_SCHEDULE_PROMPT_MAX}
                  </span>
                ) : null}
              </div>
              <Textarea
                id={`${id}-prompt`}
                rows={4}
                maxLength={PROJECT_SCHEDULE_PROMPT_MAX}
                disabled={schedule !== null && typedPrompt === null && props.promptPending}
                placeholder={
                  promptUnknown && props.promptPending
                    ? "Loading…"
                    : promptUnknown && props.promptFailed
                      ? "Couldn't load the prompt. It stays as it is unless you type a new one."
                      : "Summarize what changed since yesterday and what needs me today."
                }
                value={prompt}
                onChange={(event) => setTypedPrompt(event.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-cadence`}>Cadence</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={preset.kind}
                  items={PRESET_LABELS}
                  onValueChange={(value) => {
                    if (!value) return;
                    // Custom starts from the cadence on screen, not a stale cron.
                    changePreset(
                      value === "custom" && preset.kind !== "custom"
                        ? { kind: "custom", cron }
                        : { kind: value as SchedulePresetKind },
                    );
                  }}
                >
                  <SelectTrigger id={`${id}-cadence`} className="w-auto min-w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {PRESET_KINDS.map((kind) => (
                      <SelectItem key={kind} value={kind}>
                        {PRESET_LABELS[kind]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <PresetFields preset={preset} onChange={changePreset} />
              </div>
              {preset.kind === "weekly" ? (
                <ToggleGroup
                  aria-label="Days"
                  multiple
                  value={preset.days.map(String)}
                  onValueChange={(values) => changePreset({ days: values.map(Number) })}
                >
                  {WEEK_DAYS.map(([day, label]) => (
                    <Toggle key={day} value={`${day}`}>
                      {label}
                    </Toggle>
                  ))}
                </ToggleGroup>
              ) : null}
              {preset.kind === "custom" ? (
                <>
                  <Input
                    nativeInput
                    aria-label="Cron expression"
                    className="font-mono"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="0 7 * * 1-5"
                    value={preset.cron}
                    onChange={(event) => changePreset({ cron: event.target.value })}
                  />
                  {cadenceError === null ? (
                    <p className="text-muted-foreground">{describeCron(preset.cron)}</p>
                  ) : null}
                </>
              ) : null}
              {cadenceError !== null ? (
                <p role="alert" className="text-destructive-foreground">
                  {cadenceError}
                </p>
              ) : (
                <div className="flex flex-col gap-0.5 text-muted-foreground">
                  <p className="text-xs">Next runs</p>
                  {nextRuns.map((run) => (
                    <p key={run.toISOString()} className="tabular-nums">
                      {formatScheduleRunTime(run, timeZone)} {timeZone} (host)
                    </p>
                  ))}
                </div>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            {schedule !== null ? (
              <Button
                type="button"
                variant="destructive-outline"
                className="sm:me-auto"
                disabled={isSaving}
                onClick={() => void remove()}
              >
                Delete
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={props.onClose} disabled={isSaving}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** The fields beside the preset: a time, the hour step, or the day of the month. */
function PresetFields(props: {
  readonly preset: SchedulePreset;
  readonly onChange: (next: Partial<SchedulePreset>) => void;
}) {
  const { preset, onChange } = props;
  const time = (
    <Input
      nativeInput
      type="time"
      aria-label="Time"
      className="w-auto"
      value={`${pad(preset.hour)}:${pad(preset.minute)}`}
      onChange={(event) => {
        const [hour, minute] = event.target.value.split(":").map(Number);
        if (hour !== undefined && minute !== undefined && Number.isFinite(hour + minute)) {
          onChange({ hour, minute });
        }
      }}
    />
  );
  switch (preset.kind) {
    case "daily":
    case "weekdays":
    case "weekly":
      return <Labeled text="at">{time}</Labeled>;
    case "monthly":
      return (
        <>
          <Labeled text="on day">
            <NumberSelect
              label="Day of the month"
              values={MONTH_DAYS}
              value={preset.dayOfMonth}
              onChange={(dayOfMonth) => onChange({ dayOfMonth })}
            />
          </Labeled>
          <Labeled text="at">{time}</Labeled>
        </>
      );
    case "hourly":
      return (
        <Labeled text="every">
          <NumberSelect
            label="Hours between runs"
            values={HOUR_STEPS}
            value={preset.everyHours}
            onChange={(everyHours) => onChange({ everyHours })}
          />
          <span className="text-muted-foreground">
            {preset.everyHours === 1 ? "hour" : "hours"}
          </span>
        </Labeled>
      );
    case "custom":
      return null;
  }
}

function Labeled(props: { readonly text: string; readonly children: ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      <span className="text-muted-foreground">{props.text}</span>
      {props.children}
    </span>
  );
}

function NumberSelect(props: {
  readonly label: string;
  readonly values: readonly string[];
  readonly value: number;
  readonly onChange: (value: number) => void;
}) {
  return (
    <Select
      value={`${props.value}`}
      onValueChange={(value) => {
        if (value) props.onChange(Number(value));
      }}
    >
      <SelectTrigger aria-label={props.label} className="w-auto min-w-16">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {props.values.map((value) => (
          <SelectItem key={value} value={value}>
            {value}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function Field(props: {
  readonly label: string;
  readonly htmlFor: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", props.className)}>
      <Label htmlFor={props.htmlFor}>{props.label}</Label>
      {props.children}
    </div>
  );
}
