import type { HomeResolution } from "@t3tools/shared/home";

export type JoinPath = (first: string, ...segments: string[]) => string;

/**
 * `<home>/dev` for a development desktop on an implicit home, else
 * `<home>/userdata`. An explicit home always holds `userdata`.
 */
export function resolveDesktopStateDir(input: {
  readonly home: HomeResolution;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
}): string {
  const useDevSubdir = input.isDevelopment && !input.home.explicit;
  return input.joinPath(input.home.baseDir, useDevSubdir ? "dev" : "userdata");
}
