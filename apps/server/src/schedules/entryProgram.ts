/**
 * What an OS schedule entry runs. Fork-owned.
 *
 * The entry runs `schedules fire` behind a `/bin/sh` guard. When the app is
 * dragged to the Trash, or an npx cache holding the entry script is cleared,
 * the program is gone and the OS would fail to spawn it on every slot, with
 * nothing left to clean up. The guard checks the program first; if it is
 * missing, the guard removes its own entry and exits 0. Otherwise it `exec`s
 * the program, so the shell is gone once the fire runs.
 *
 * @module entryProgram
 */

/**
 * Whether entries run through the guard. Login Items may show a guarded entry
 * as "sh" on a signed build; if it does, set this to false to render the bare
 * program and lose only the self-removal.
 */
export const ENTRY_GUARD = true;

/** Always single-quoted, for values embedded in the guard script. */
export const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/**
 * Paths that stop existing once the app is closed or moved: macOS App
 * Translocation, a mounted disk image, and a running AppImage's mount.
 */
function isEphemeralPath(value: string): boolean {
  return (
    value.includes("/AppTranslocation/") ||
    value.startsWith("/Volumes/") ||
    value.startsWith("/tmp/.mount_")
  );
}

interface EntryProgram {
  /** `execPath`, then the entry script when `hasEntryScript`, then the fire arguments. */
  readonly program: ReadonlyArray<string>;
  readonly hasEntryScript: boolean;
}

/**
 * The executable or entry script that would vanish after this session, if
 * any. Backends refuse such an entry and report `ephemeral-path`, so an app
 * run from its disk image never replaces the installed app's entry.
 */
export function ephemeralProgramPath(entry: EntryProgram): string | undefined {
  return entry.program.slice(0, entry.hasEntryScript ? 2 : 1).find(isEphemeralPath);
}

/**
 * The file the guard checks for an entry script. A packaged app's script
 * lives inside `app.asar`, which only Electron can read into, so the shell
 * checks the archive itself.
 */
function scriptCheckPath(script: string): string {
  const archiveEnd = /\.asar(?=[/\\])/.exec(script);
  return archiveEnd === null ? script : script.slice(0, archiveEnd.index + ".asar".length);
}

/**
 * The argv the OS entry runs. With the guard, `/bin/sh -c <guard> <program…>`,
 * where `cleanup` is the shell that removes this entry (the backend's own
 * commands). `test -f` runs only when the program has an entry script.
 */
export function entryProgramArguments(
  entry: EntryProgram & { readonly cleanup: string },
  guard: boolean = ENTRY_GUARD,
): ReadonlyArray<string> {
  if (!guard) return entry.program;
  const checks = [`test -x "$0"`];
  const script = entry.hasEntryScript ? entry.program[1] : undefined;
  if (script !== undefined) {
    const checkPath = scriptCheckPath(script);
    checks.push(checkPath === script ? `test -f "$1"` : `test -f ${shellQuote(checkPath)}`);
  }
  const guardScript = `${checks.join(" && ")} || { ${entry.cleanup}; exit 0; }; exec "$0" "$@"`;
  return ["/bin/sh", "-c", guardScript, ...entry.program];
}
