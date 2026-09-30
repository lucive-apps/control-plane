import {
  EnvironmentHttpApi,
  EnvironmentHttpCommonError,
  type EnvironmentAuthInvalidError,
  type EnvironmentInternalError,
  type EnvironmentOperationForbiddenError,
  type EnvironmentRequestInvalidError,
  type EnvironmentResourceNotFoundError,
  type EnvironmentScopeRequiredError,
} from "@t3tools/contracts";
import { httpHeaderRedactionLayer } from "@t3tools/shared/httpObservability";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);

export class RemoteEnvironmentAuthFetchError extends Data.TaggedError(
  "RemoteEnvironmentAuthFetchError",
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class RemoteEnvironmentAuthInvalidJsonError extends Data.TaggedError(
  "RemoteEnvironmentAuthInvalidJsonError",
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class RemoteEnvironmentAuthUndeclaredStatusError extends Data.TaggedError(
  "RemoteEnvironmentAuthUndeclaredStatusError",
)<{
  readonly message: string;
  readonly status: number;
  readonly requestUrl: string;
  /** From the response's Retry-After header, when it had a usable one. */
  readonly retryAfterMs?: number;
}> {
  constructor(requestUrl: string, status: number, retryAfterMs?: number) {
    super({
      message: `Remote environment endpoint ${requestUrl} returned undeclared status ${status}.`,
      requestUrl,
      status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
}

/** Reads a Retry-After header given as delay seconds or an HTTP date. */
export function parseRetryAfterMs(
  value: string | null | undefined,
  nowMs: number,
): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  const dateMs = Date.parse(trimmed);
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - nowMs);
}

export class RemoteEnvironmentAuthTimeoutError extends Data.TaggedError(
  "RemoteEnvironmentAuthTimeoutError",
)<{
  readonly message: string;
  readonly requestUrl: string;
  readonly timeoutMs: number;
}> {
  constructor(requestUrl: string, timeoutMs: number) {
    super({
      message: `Remote environment endpoint ${requestUrl} timed out after ${timeoutMs}ms.`,
      requestUrl,
      timeoutMs,
    });
  }
}

export type RemoteEnvironmentRequestError =
  | EnvironmentRequestInvalidError
  | EnvironmentAuthInvalidError
  | EnvironmentScopeRequiredError
  | EnvironmentOperationForbiddenError
  | EnvironmentResourceNotFoundError
  | EnvironmentInternalError
  | RemoteEnvironmentAuthFetchError
  | RemoteEnvironmentAuthInvalidJsonError
  | RemoteEnvironmentAuthUndeclaredStatusError
  | RemoteEnvironmentAuthTimeoutError;

export const remoteHttpClientLayer = (
  fetchFn: typeof globalThis.fetch,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.merge(
    FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn))),
    httpHeaderRedactionLayer,
  );

const remoteApiBaseUrl = (httpBaseUrl: string): string => {
  const url = new URL(httpBaseUrl);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
};

export const makeEnvironmentHttpApiClient = (httpBaseUrl: string) =>
  HttpApiClient.make(EnvironmentHttpApi, {
    baseUrl: remoteApiBaseUrl(httpBaseUrl),
  });

export const makeEnvironmentHttpApiGroupClient = <
  Group extends keyof typeof EnvironmentHttpApi.groups,
>(
  httpBaseUrl: string,
  group: Group,
) =>
  Effect.flatMap(HttpClient.HttpClient, (httpClient) =>
    HttpApiClient.group(EnvironmentHttpApi, {
      httpClient,
      group,
      baseUrl: remoteApiBaseUrl(httpBaseUrl),
    }),
  );

/** Contract-derived request URLs for authentication proofs, tracing, and structured errors. */
export const makeEnvironmentHttpApiUrlBuilder = (httpBaseUrl: string) =>
  HttpApiClient.urlBuilder(EnvironmentHttpApi, {
    baseUrl: remoteApiBaseUrl(httpBaseUrl),
  });

const failRemoteRequest = (
  requestUrl: string,
  cause: unknown,
): Effect.Effect<never, RemoteEnvironmentRequestError> => {
  if (cause instanceof RemoteEnvironmentAuthTimeoutError) {
    return Effect.fail(cause);
  }
  if (isEnvironmentHttpCommonError(cause)) {
    return Effect.fail(cause);
  }
  if (Schema.isSchemaError(cause)) {
    return Effect.fail(
      new RemoteEnvironmentAuthInvalidJsonError({
        message: `Remote environment endpoint returned an invalid response from ${requestUrl}.`,
        cause,
      }),
    );
  }
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    const response = cause.response;
    if (response.status < 200 || response.status >= 300) {
      return Clock.currentTimeMillis.pipe(
        Effect.flatMap((nowMs) =>
          Effect.fail(
            new RemoteEnvironmentAuthUndeclaredStatusError(
              requestUrl,
              response.status,
              parseRetryAfterMs(response.headers["retry-after"], nowMs),
            ),
          ),
        ),
      );
    }
    return Effect.fail(
      new RemoteEnvironmentAuthInvalidJsonError({
        message: `Remote environment endpoint returned an invalid response from ${requestUrl}.`,
        cause,
      }),
    );
  }
  return Effect.fail(
    new RemoteEnvironmentAuthFetchError({
      message: `Failed to fetch remote environment endpoint ${requestUrl} (${String(cause)}).`,
      cause,
    }),
  );
};

export const executeEnvironmentHttpRequest = <A, E, R>(
  requestUrl: string,
  timeoutMs: number,
  request: Effect.Effect<A, E, R>,
): Effect.Effect<A, RemoteEnvironmentRequestError, R> =>
  request.pipe(
    Effect.timeoutOption(Duration.millis(timeoutMs)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new RemoteEnvironmentAuthTimeoutError(requestUrl, timeoutMs)),
        onSome: Effect.succeed,
      }),
    ),
    Effect.catch((cause) => failRemoteRequest(requestUrl, cause)),
  );
