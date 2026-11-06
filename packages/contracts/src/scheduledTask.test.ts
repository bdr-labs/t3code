import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  resolveUsageWindow,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertSchedule,
  usageScheduleLabel,
  usageWindowsOf,
} from "./scheduledTask.ts";
import { OrchestratorMcpSaveScheduledTaskInput } from "./orchestratorMcp.ts";

const decodeSchedule = Schema.decodeUnknownSync(ScheduledTaskSchedule);
const decodeUpsertSchedule = Schema.decodeUnknownSync(ScheduledTaskUpsertSchedule);
const decodeMcpSave = Schema.decodeUnknownSync(OrchestratorMcpSaveScheduledTaskInput);

describe("ScheduledTaskSchedule", () => {
  it("keeps legacy sub-minute persisted schedules readable", () => {
    expect(
      decodeSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
    });
  });

  it("accepts a one-time run only with an offset", () => {
    for (const runAt of ["2026-11-03T09:00Z", "2026-11-03T09:00:00.000-08:00"]) {
      expect(decodeUpsertSchedule({ type: "once", runAt })).toEqual({ type: "once", runAt });
    }
    for (const runAt of [
      "2026-11-03T09:00",
      "2026-13-03T09:00Z",
      "2026-02-30T09:00Z",
      "9999-12-31T23:30-01:00",
      "0000-01-01T00:00+00:01",
      "tomorrow",
    ]) {
      expect(() => decodeUpsertSchedule({ type: "once", runAt })).toThrow();
    }
  });
});

it.each(["literal", " ", "\t\n", "{{body.bad", "{{unknown.field}}"])(
  "rejects invalid dedupe template %s",
  (replayKey) => {
    expect(() => decodeUpsertSchedule({ type: "webhook", dedupe: { replayKey } })).toThrow();
    expect(() =>
      decodeUpsertSchedule({ type: "webhook", dedupe: { coalesceKey: replayKey } }),
    ).toThrow();
  },
);
describe("usage trigger", () => {
  const trigger = { type: "usage", window: "weekly", on: "above", usedPercent: 80 };

  it("no client or agent can set its state; the stored schedule keeps it", () => {
    const stored = { ...trigger, state: { armed: false } };
    expect(decodeUpsertSchedule(stored)).toEqual(trigger);
    expect(decodeSchedule(stored)).toEqual(stored);
    expect(
      decodeSchedule({
        type: "usage",
        window: "weekly",
        on: "reset",
        state: { resetsAt: null, usedPercent: 2.5, firedFor: "2026-09-09T12:00:00.000Z" },
      }),
    ).toMatchObject({ state: { resetsAt: null, usedPercent: 2.5 } });
  });

  it.each([
    ["an object", (schedule: unknown) => schedule],
    ["JSON text", (schedule: unknown) => JSON.stringify(schedule)],
  ])("an agent's schedule as %s loses any state it brings", (_form, form) => {
    const { schedule } = decodeMcpSave({ schedule: form({ ...trigger, state: { armed: true } }) });
    expect(schedule).toEqual(trigger);
  });

  it.each([0, 100, 12.5, "80"])("refuses a usedPercent of %s", (usedPercent) => {
    expect(() => decodeUpsertSchedule({ ...trigger, usedPercent })).toThrow();
  });

  it.each([1, 99])("accepts a usedPercent of %s", (usedPercent) => {
    expect(decodeUpsertSchedule({ ...trigger, usedPercent })).toMatchObject({ usedPercent });
  });

  it("refuses an unknown `on` and an empty window", () => {
    expect(() => decodeUpsertSchedule({ ...trigger, on: "near" })).toThrow();
    expect(() => decodeUpsertSchedule({ ...trigger, window: " " })).toThrow();
  });

  const account = { id: "seven_day", kind: "weekly", label: "Weekly" } as const;
  const model = { id: "seven_day_opus", kind: "weekly", label: "Weekly · Opus" } as const;

  it("resolves an id, or a kind to its first window in the sorted order", () => {
    expect(resolveUsageWindow([model, account], "weekly")).toBe(account);
    expect(resolveUsageWindow([account, model], "seven_day_opus")).toBe(model);
    expect(resolveUsageWindow([account], "monthly")).toBeUndefined();
  });

  it("finds an instance's windows, and none for one it does not hold", () => {
    const windows = [{ ...account, usedPercent: 10 }];
    const providers = [{ instanceId: "codex", usageLimits: { windows } }, { instanceId: "grok" }];
    expect(usageWindowsOf(providers, "codex")).toBe(windows);
    expect(usageWindowsOf(providers, "grok")).toEqual([]);
    expect(usageWindowsOf(providers, "gone")).toEqual([]);
  });

  it("reads as a person would say it", () => {
    const renews = { window: "seven_day", on: "reset" } as const;
    expect(usageScheduleLabel(renews, [account])).toBe("When Weekly renews");
    expect(usageScheduleLabel({ ...renews, on: "above", usedPercent: 80 }, [account])).toBe(
      "When Weekly is above 80%",
    );
    expect(usageScheduleLabel({ ...renews, on: "below", usedPercent: 20 }, [account])).toBe(
      "When Weekly is below 20%",
    );
    // Without live windows it still names what is stored.
    expect(usageScheduleLabel({ window: "weekly", on: "reset" })).toBe("When Weekly renews");
    expect(usageScheduleLabel(renews)).toBe("When Seven day renews");
  });
});

describe("webhook filters", () => {
  const accepts = (filters: unknown) => {
    try {
      decodeUpsertSchedule({ type: "webhook", filters });
      return true;
    } catch {
      return false;
    }
  };

  it("rejects empty or unknown paths, unknown ops, and values that do not fit the op", () => {
    expect(accepts([{ path: "", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "  ", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "request", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "header.x-github-event", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "in", value: "opened" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "in", value: [] }])).toBe(false);
    for (const value of ["", " opened", "opened ", "a,b"]) {
      expect(accepts([{ path: "body.action", op: "in", value: [value] }])).toBe(false);
    }
    expect(accepts([{ path: "body.label.name", op: "in", value: ["needs review"] }])).toBe(true);
    expect(accepts([{ path: "body.action", op: "equals" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "matches", value: "^opened$" }])).toBe(false);
  });
});
