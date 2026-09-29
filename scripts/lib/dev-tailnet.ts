import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import { TailscaleUnavailableError } from "./dev-share.ts";

export interface TailnetMapping {
  readonly url: string;
  readonly close: () => Promise<void>;
}
export interface TailnetHelper {
  readonly prepareTailnet: (port: number) => Promise<TailnetMapping | null>;
}

export const shareAutomaticDevServer = (
  port: number,
  helperPath: string,
  loadHelper: (path: string) => Promise<TailnetHelper> = (path) =>
    import(NodeURL.pathToFileURL(path).href),
) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => (await loadHelper(helperPath)).prepareTailnet(port),
      catch: (cause) => new TailscaleUnavailableError({ cause }),
    }),
    (mapping) =>
      mapping
        ? Effect.tryPromise({
            try: () => mapping.close(),
            catch: (cause) => new TailscaleUnavailableError({ cause }),
          }).pipe(
            Effect.catch(() =>
              Effect.logWarning("[dev-runner] could not close the automatic tailnet session"),
            ),
          )
        : Effect.void,
  );
