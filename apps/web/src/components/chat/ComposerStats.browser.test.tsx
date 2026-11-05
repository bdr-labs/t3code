import {
  NodeId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { ComposerStats } from "./ComposerStats";

const measured: OrchestrationV2ProviderTurn = {
  id: ProviderTurnId.make("turn"),
  providerThreadId: ProviderThreadId.make("thread"),
  nodeId: NodeId.make("node"),
  runAttemptId: null,
  nativeTurnRef: {
    driver: ProviderDriverKind.make("claudeAgent"),
    nativeId: "native",
    strength: "strong",
  },
  ordinal: 1,
  status: "completed",
  startedAt: DateTime.makeUnsafe("2026-11-06T10:00:00.000Z"),
  completedAt: DateTime.makeUnsafe("2026-11-06T10:01:00.000Z"),
  responseThroughput: { outputTokens: 400, elapsedMs: 4000, responseCount: 1, partial: false },
};

const note = "From the turn starting on the server, so a queued turn's wait is not counted.";

const stats = (turn: OrchestrationV2ProviderTurn) => (
  <ComposerStats
    context={null}
    turn={turn}
    compactions={[]}
    usageLimits={null}
    contextDriver={undefined}
    configuredClaudeThreshold={undefined}
    onCompact={() => {}}
    compactDisabled
    compactDisabledReason={null}
    isCompacting={false}
  />
);

it("shows the figure before the rate and explains it on hover", async () => {
  await using screen = await render(stats({ ...measured, timeToFirstTokenMs: 1234 }));

  const trigger = screen.getByRole("button", { name: "Turn token details" });
  await expect.element(trigger).toHaveTextContent("1.2sttft100tok/s");
  await userEvent.hover(trigger);
  const hint = page.getByText(note);
  await expect.element(hint).toBeVisible();
  const details = [...hint.element().closest("div")!.querySelectorAll("dt")].map(
    (term) => term.textContent,
  );
  expect(details.indexOf("Time to first token")).toBe(details.indexOf("Elapsed wall time") - 1);
});

it("shows nothing for a turn without a figure", async () => {
  await using screen = await render(stats(measured));

  const trigger = screen.getByRole("button", { name: "Turn token details" });
  await expect.element(trigger).toHaveTextContent("100tok/s");
  await userEvent.hover(trigger);
  await expect.element(page.getByText("Elapsed wall time")).toBeVisible();
  await expect.element(page.getByText("Time to first token")).not.toBeInTheDocument();
  await expect.element(page.getByText(note)).not.toBeInTheDocument();
});

it("keeps the figure on the line for a turn with no rate", async () => {
  await using screen = await render(
    stats({
      ...measured,
      responseThroughput: undefined,
      timeToFirstTokenMs: 12_345,
    } as OrchestrationV2ProviderTurn),
  );

  const trigger = screen.getByRole("button", { name: "Turn token details" });
  await expect.element(trigger).toBeVisible();
  expect(trigger.element().textContent).toBe("12sttft");
});
