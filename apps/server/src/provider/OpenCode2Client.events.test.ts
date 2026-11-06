import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe } from "vite-plus/test";

import * as OpenCode2Client from "@t3tools/provider-opencode/server/v2/OpenCode2Client";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const layerServing = (events: ReadonlyArray<unknown>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(events.map((event) => `data: ${encodeJson(event)}\n\n`).join(""), {
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      ),
    ),
  );

const connect = Effect.gen(function* () {
  const opencode = yield* OpenCode2Client.OpenCode2Client;
  return yield* opencode.connect({ baseUrl: "http://127.0.0.1:4096", password: "secret" });
});

describe("OpenCode2Client events", () => {
  it.effect(
    "keeps an execution's end and start it cannot decode, and skips other unknown events",
    () =>
      Effect.gen(function* () {
        const { events } = yield* connect.pipe(
          Effect.provide(
            OpenCode2Client.layer.pipe(
              Layer.provide(
                layerServing([
                  {
                    id: "evt_1",
                    created: 1,
                    type: "session.hologram.projected",
                    data: { sessionID: "ses_x" },
                  },
                  {
                    id: "evt_0",
                    created: 1,
                    type: "session.execution.started",
                    data: { sessionID: "ses_x", lane: 7 },
                    durable: "not-an-envelope",
                  },
                  {
                    id: "evt_2",
                    created: 1,
                    type: "session.execution.interrupted",
                    data: { sessionID: "ses_x", reason: "budget" },
                    durable: { aggregateID: "ses_x", seq: 1, version: 1 },
                  },
                ]),
              ),
            ),
          ),
        );
        const received = yield* (yield* events).pipe(Stream.runCollect);
        assert.deepStrictEqual(received, [
          { type: "unreadable.execution.started", sessionID: "ses_x" },
          {
            type: "unreadable.execution.ended",
            executionType: "session.execution.interrupted",
            sessionID: "ses_x",
          },
        ]);
      }),
  );

  it.effect(
    "keeps a failed execution's retryAfterMs and nothing else the schema does not know",
    () =>
      Effect.gen(function* () {
        const durable = { aggregateID: "ses_x", seq: 1, version: 1 };
        const error = {
          type: "provider.free-limit",
          message: "Free usage limit reached.",
          status: 429,
          retryAfterMs: 1000,
          foo: "dropped",
        };
        const { events } = yield* connect.pipe(
          Effect.provide(
            OpenCode2Client.layer.pipe(
              Layer.provide(
                layerServing([
                  {
                    id: "evt_1",
                    created: 1,
                    type: "session.execution.failed",
                    data: { sessionID: "ses_x", error },
                    durable,
                  },
                  {
                    id: "evt_2",
                    created: 2,
                    type: "session.retry.scheduled",
                    data: {
                      sessionID: "ses_x",
                      assistantMessageID: "msg_0eb735d5b001oAFVeY5jz3WD4Z",
                      attempt: 2,
                      at: 3,
                      error,
                    },
                    durable,
                  },
                  {
                    id: "evt_3",
                    created: 3,
                    type: "session.execution.failed",
                    data: { sessionID: "ses_x", error: "boom" },
                    durable,
                  },
                ]),
              ),
            ),
          ),
        );
        const received = yield* (yield* events).pipe(Stream.runCollect);
        const [failed, retry, unreadable] = received as unknown as ReadonlyArray<{
          readonly type: string;
          readonly data?: { readonly error: Readonly<Record<string, unknown>> };
        }>;
        assert.strictEqual(failed?.type, "session.execution.failed");
        assert.strictEqual(failed?.data?.error.retryAfterMs, 1000);
        assert.isFalse("foo" in (failed?.data?.error ?? {}));
        assert.strictEqual(retry?.type, "session.retry.scheduled");
        assert.isFalse("retryAfterMs" in (retry?.data?.error ?? {}));
        assert.strictEqual(unreadable?.type, "unreadable.execution.ended");
      }),
  );
});
