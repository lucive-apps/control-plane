import { useSyncExternalStore } from "react";
import { File, Paths } from "expo-file-system";

type VisitMap = Record<string, string>;

let visits: VisitMap = {};
const listeners = new Set<() => void>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let loadStarted = false;

function emit() {
  for (const listener of listeners) listener();
}

function visitsFile(): InstanceType<typeof File> {
  return new File(Paths.document, "thread-visits.json");
}

async function loadVisits() {
  if (loadStarted) return;
  loadStarted = true;
  try {
    const file = visitsFile();
    if (!file.exists) return;
    const parsed: unknown = JSON.parse(await file.text());
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
    visits = parsed as VisitMap;
    emit();
  } catch {
    // Device-local cache. A corrupt file should not block the inbox.
  }
}

function persistVisits() {
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const file = visitsFile();
      file.write(JSON.stringify(visits));
    } catch {
      // Ignore write failures.
    }
  }, 200);
}

void loadVisits();

export function subscribeThreadVisits(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getThreadVisitMap(): VisitMap {
  return visits;
}

export function markThreadVisited(threadKey: string, visitedAt: string): void {
  const nextMs = Date.parse(visitedAt);
  if (!Number.isFinite(nextMs)) return;
  const previous = visits[threadKey];
  const previousMs = previous === undefined ? Number.NaN : Date.parse(previous);
  if (Number.isFinite(previousMs) && previousMs >= nextMs) return;
  visits = { ...visits, [threadKey]: visitedAt };
  emit();
  persistVisits();
}

export function useThreadVisitMap(): VisitMap {
  return useSyncExternalStore(subscribeThreadVisits, getThreadVisitMap);
}
