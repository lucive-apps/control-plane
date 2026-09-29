import {
  buildScheduleEditorDraft,
  formatScheduleRunTime,
  initialScheduleEditorForm,
  resolveScheduleEditor,
  SCHEDULE_PRESET_KINDS,
  SCHEDULE_PRESET_LABELS,
  SCHEDULE_WEEK_DAYS,
  scheduleEditorChangeText,
  switchSchedulePreset,
  type ScheduleDraft,
  type ScheduleEditorChange,
  type ScheduleEditorForm,
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
import { describeCron } from "@t3tools/shared/schedules";
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
  readonly changed: ScheduleEditorChange;
  readonly targetOptions: readonly ScheduleTargetOption[];
  readonly timeZone: string;
  readonly onSave: (draft: ScheduleDraft) => Promise<boolean>;
  readonly onDelete: (schedule: ProjectSchedule) => Promise<boolean>;
  readonly onClose: () => void;
}) {
  const { schedule, targetOptions, timeZone } = props;
  const id = useId();
  const [form, setForm] = useState<ScheduleEditorForm>(() => initialScheduleEditorForm(schedule));
  const [isSaving, setIsSaving] = useState(false);
  const { name, target, preset } = form;
  const view = resolveScheduleEditor({
    opened: schedule,
    form,
    storedPrompt: props.prompt,
    targetOptions,
    changed: props.changed,
    saving: isSaving,
    now: new Date(),
    timeZone,
  });
  const { prompt, promptUnknown, cron, cadenceError, nextRuns, targetKnown, changed, canSave } =
    view;
  const update = (next: Partial<ScheduleEditorForm>) =>
    setForm((current) => ({ ...current, ...next }));
  const setName = (value: string) => update({ name: value });
  const setTarget = (value: ProjectScheduleTarget) => update({ target: value });
  const setTypedPrompt = (value: string) => update({ typedPrompt: value });

  const changePreset = (next: Partial<SchedulePreset>) =>
    setForm((current) => ({
      ...current,
      cadenceTouched: true,
      preset: { ...current.preset, ...next },
    }));

  const save = async () => {
    if (!canSave) return;
    setIsSaving(true);
    const saved = await props.onSave(buildScheduleEditorDraft({ opened: schedule, form, view }));
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
                {scheduleEditorChangeText(changed)}
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
                disabled={schedule !== null && form.typedPrompt === null && props.promptPending}
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
                  items={SCHEDULE_PRESET_LABELS}
                  onValueChange={(value) => {
                    if (!value) return;
                    changePreset(switchSchedulePreset(preset, value as SchedulePresetKind, cron));
                  }}
                >
                  <SelectTrigger id={`${id}-cadence`} className="w-auto min-w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {SCHEDULE_PRESET_KINDS.map((kind) => (
                      <SelectItem key={kind} value={kind}>
                        {SCHEDULE_PRESET_LABELS[kind]}
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
                  {SCHEDULE_WEEK_DAYS.map(([day, label]) => (
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
