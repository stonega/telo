import { deflateSync } from "node:zlib";
import { Type } from "typebox";
import { z } from "zod";
import {
  type Delivery,
  type Run,
  requireThat,
  type Workspace,
} from "../domain.ts";
import { fingerprint } from "../setup/credentials.ts";
import { eligible, runAllowed } from "../workspaces/policy.ts";
import { deliver } from "../workspaces/service.ts";
import type { WidgetQuery } from "./router.ts";

const argumentsSchema = z.strictObject({
  html: z.string().min(1).max(32768),
  caption: z.string().trim().min(1).max(1024),
  width: z.number().int().min(200).max(430).optional(),
  height: z.number().int().min(50).max(600).optional(),
});
export const widgetParameters = Type.Object(
  {
    html: Type.String({ minLength: 1, maxLength: 32768 }),
    caption: Type.String({ minLength: 1, maxLength: 1024 }),
    width: Type.Optional(Type.Integer({ minimum: 200, maximum: 430 })),
    height: Type.Optional(Type.Integer({ minimum: 50, maximum: 600 })),
  },
  { additionalProperties: false },
);

/** The application fixes the audience and disables bot requests and sharing. */
function widgetBot(w: Workspace, r: Run) {
  requireThat(r.chatId === r.actor, "widget_private_chat_required", 403);
  if (r.workflowId) {
    const workflow = w.workflows.find((f) => f.id === r.workflowId);
    requireThat(
      workflow?.status === "active" &&
        workflow.version === r.workflowVersion &&
        workflow.owner === r.actor &&
        workflow.spec.chatId === r.chatId &&
        workflow.spec.topicId === r.topicId,
      "widget_workflow_changed",
      403,
    );
    // Scheduled runs have no conversation thread. The first staged widget binds
    // the current deployment bot; subsequent calls and delivery retain that pin.
    return r.widget?.botId;
  }
  const thread = w.threads?.find((t) => t.id === r.threadId);
  requireThat(
    thread?.botId &&
      thread.actor === r.actor &&
      thread.chatId === r.chatId &&
      (thread.topicId ?? 0) === r.topicId,
    "widget_private_thread_required",
    403,
  );
  return thread.botId;
}
/** Prompt guidance uses the same private audience and current run restrictions as tools. */
export function telegramWidgetAvailable(w: Workspace, r: Run) {
  if (!runAllowed(w, r)) return false;
  try {
    widgetBot(w, r);
  } catch {
    return false;
  }
  return r.skillPins.some((pin) => {
    const skill = w.skills.find((s) => s.id === pin.id);
    const spec = skill?.published[pin.version - 1];
    return (
      skill?.enabled &&
      !skill.archived &&
      spec?.slug === "telegram-widgets" &&
      spec.tools.includes("send_telegram_widget") &&
      spec.tools.includes("load_skill") &&
      spec.resources?.some(
        (resource) => resource.path === "references/rendering.md",
      )
    );
  });
}
export function authorizeWidget(
  w: Workspace,
  r: Run,
  args: Record<string, unknown>,
) {
  widgetBot(w, r);
  const parsed = argumentsSchema.parse(args);
  requireThat(!parsed.html.includes("\0"), "widget_html_invalid");
  requireThat(
    Buffer.byteLength(parsed.html) <= 32768 &&
      deflateSync(parsed.html, { level: 9 }).byteLength <= 4096,
    "widget_too_large",
  );
  return parsed;
}
export function stageWidget(
  w: Workspace,
  r: Run,
  args: Record<string, unknown>,
  botId?: string,
) {
  const value = authorizeWidget(w, r, args);
  const currentBot = authorizeWidgetBot(w, r, botId);
  r.widget = { ...value, botId: currentBot, requestMessageId: r.replyTo };
  return {
    status: "staged",
    guidance:
      "Publishes with a successful answer. Keep the final reply useful as text; do not claim delivery yet.",
  };
}
export function authorizeWidgetBot(w: Workspace, r: Run, botId?: string) {
  const expected = widgetBot(w, r);
  requireThat(
    botId && (!expected || expected === botId),
    "widget_bot_changed",
    403,
  );
  return botId;
}
export function publishWidget(w: Workspace, r: Run, botId?: string) {
  if (
    !r.widget ||
    r.status !== "succeeded" ||
    r.codingTaskId ||
    r.pendingInputs?.length ||
    r.widget.requestMessageId !== r.replyTo
  )
    return;
  requireThat(
    widgetBot(w, r) === botId && r.widget.botId === botId,
    "widget_bot_changed",
    403,
  );
  const id = deliver(w, r.actor, r.chatId, r.widget.caption, {
    id: `run:${r.id}:widget`,
    runId: r.id,
    topicId: r.topicId,
    replyTo: r.replyTo,
  });
  const d = w.deliveries.find((d) => d.id === id);
  requireThat(d, "widget_intent_missing");
  d.botId = botId;
  d.widget = structuredClone(r.widget);
}
export function widgetDeliveryAllowed(
  w: Workspace,
  d: Delivery,
  botId?: string,
) {
  if (!d.widget) return true;
  const r = w.runs.find((r) => r.id === d.runId);
  if (r?.status !== "succeeded" || !r.widget || r.codingTaskId) return false;
  try {
    return (
      widgetBot(w, r) === botId &&
      r.widget.botId === botId &&
      d.botId === botId &&
      d.id === `run:${r.id}:widget` &&
      d.actor === r.actor &&
      d.chatId === r.chatId &&
      d.topicId === r.topicId &&
      d.replyTo === r.replyTo &&
      d.text === r.widget.caption &&
      fingerprint(d.widget) === fingerprint(r.widget)
    );
  } catch {
    return false;
  }
}

/** Queue an in-place data update for an already-sent widget (Bot API 10.4 editMessageWidgetData). */
export function queueWidgetDataEdit(
  w: Workspace,
  input: {
    id: string;
    actor: string;
    chatId: string;
    topicId?: number;
    botId: string;
    messageId: number;
    publicData?: string;
    chatData?: string;
  },
) {
  requireThat(
    input.chatId === input.actor,
    "widget_private_chat_required",
    403,
  );
  requireThat(
    input.publicData !== undefined || input.chatData !== undefined,
    "widget_data_required",
  );
  if (input.publicData !== undefined)
    requireThat(
      Buffer.byteLength(input.publicData) <= 1024,
      "widget_data_too_large",
    );
  if (input.chatData !== undefined)
    requireThat(
      Buffer.byteLength(input.chatData) <= 1024,
      "widget_data_too_large",
    );
  const id = deliver(w, input.actor, input.chatId, "", {
    id: input.id,
    topicId: input.topicId,
  });
  const d = w.deliveries.find((entry) => entry.id === id);
  requireThat(d, "widget_intent_missing");
  d.botId = input.botId;
  d.widgetDataEdit = {
    messageId: input.messageId,
    ...(input.publicData !== undefined ? { publicData: input.publicData } : {}),
    ...(input.chatData !== undefined ? { chatData: input.chatData } : {}),
  };
  return id;
}

/** Authorize and answer a private-chat widget_query for an app-owned interactive widget. */
export function handleWidgetQuery(
  w: Workspace | undefined,
  query: WidgetQuery,
  botId: string,
): { accepted: boolean; data: string } {
  if (
    !w ||
    w.deletion ||
    query.from.is_bot ||
    query.chat?.type !== "private" ||
    String(query.chat.id) !== String(query.from.id) ||
    !query.message_id
  )
    return {
      accepted: false,
      data: JSON.stringify({ ok: false, error: "unauthorized" }),
    };
  const actor = String(query.from.id);
  if (!eligible(w, actor))
    return {
      accepted: false,
      data: JSON.stringify({ ok: false, error: "access_denied" }),
    };
  const source = w.deliveries.find(
    (d) =>
      d.state === "sent" &&
      d.botId === botId &&
      d.actor === actor &&
      d.chatId === actor &&
      d.remoteId === query.message_id &&
      d.widget?.allowQueries === true,
  );
  if (!source)
    return {
      accepted: false,
      data: JSON.stringify({ ok: false, error: "widget_not_interactive" }),
    };
  if (query.data === "status" && source.runId) {
    const run = w.runs.find((r) => r.id === source.runId && r.actor === actor);
    if (run) {
      return {
        accepted: true,
        data: JSON.stringify({
          ok: true,
          runId: run.id,
          status: run.status,
        }).slice(0, 1024),
      };
    }
  }
  return {
    accepted: true,
    data: JSON.stringify({ ok: true, query: query.data }).slice(0, 1024),
  };
}
