import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { messageText } from "../../src/telegram/attachments.ts";
import { ALLOWED_UPDATES } from "../../src/telegram/client.ts";
import { telegramRichMessage } from "../../src/telegram/format.ts";
import { command, updateSchema } from "../../src/telegram/router.ts";
import { privateTopicUrl } from "../../src/telegram/topic-fallback.ts";
import {
  handleWidgetQuery,
  queueWidgetDataEdit,
} from "../../src/telegram/widgets.ts";
import { AccessLinks } from "../../src/workspaces/access-links.ts";
import { workspace } from "../fixtures.ts";

const base = {
  message_id: 10,
  date: 1_760_000_000,
  from: { id: 101, is_bot: false, first_name: "Alice" },
  chat: { id: 101, type: "private" as const },
};

describe("Bot API 10.4 / 10.5 rich messages and quotes", () => {
  test("parses expandable_blockquote with blocks (10.5) and never grants command/mention authority", () => {
    const groupMsg = updateSchema.parse({
      update_id: 1,
      message: {
        ...base,
        chat: { id: -100, type: "supergroup" },
        rich_message: {
          blocks: [
            {
              type: "expandable_blockquote",
              blocks: [
                {
                  type: "paragraph",
                  text: [
                    "Details for ",
                    {
                      type: "mention",
                      text: "@telo_bot",
                      mention: "@telo_bot",
                    },
                  ],
                },
                { type: "paragraph", text: "Second line" },
              ],
            },
          ],
        },
      },
    }).message;
    expect(groupMsg?.text).toBe("Details for @telo_bot\nSecond line");
    if (!groupMsg) throw Error("missing groupMsg");
    expect(
      command(groupMsg, { id: "999", username: "telo_bot" }),
    ).toBeUndefined();
  });

  test("emits expandable_blockquote for long blockquotes and preserves short blockquotes", () => {
    const shortQuote = telegramRichMessage("> Brief note");
    expect(shortQuote.blocks[0]?.type).toBe("blockquote");

    const longQuote = telegramRichMessage(
      Array.from({ length: 8 }, (_, i) => `> Line ${i + 1}`).join("\n"),
    );
    expect(longQuote.blocks[0]?.type).toBe("expandable_blockquote");
    expect(longQuote.blocks[0]).toHaveProperty("blocks");
  });

  test("normalizes TextQuote.rich_texts and includes untrusted quoted excerpt in messageText", () => {
    const msg = updateSchema.parse({
      update_id: 2,
      message: {
        ...base,
        text: "Why did this check fail?",
        quote: {
          text: "",
          is_manual: true,
          rich_texts: [
            ["Step ", { type: "bold", text: "lint" }, " exited with code 1"],
            { type: "code", text: "src/app.ts:42" },
          ],
        },
      },
    }).message;
    if (!msg) throw Error("missing msg");
    expect(msg.quote).toEqual({
      text: "Step lint exited with code 1\nsrc/app.ts:42",
      is_manual: true,
    });
    expect(messageText(msg)).toBe(
      "Why did this check fail?\n\nQuoted excerpt (untrusted):\nStep lint exited with code 1\nsrc/app.ts:42",
    );
  });
});

describe("Bot API 10.5 active_usernames and botinvite", () => {
  test("matches group mentions and slash commands against activeUsernames", () => {
    const bot = {
      id: "999",
      username: "telo_main_bot",
      activeUsernames: ["telo_main_bot", "telo_ai", "telo_agent"],
    };
    const mentionMsg = updateSchema.parse({
      update_id: 3,
      message: {
        ...base,
        chat: { id: -200, type: "supergroup" },
        text: "@Telo_AI summarize PR #12",
        entities: [{ type: "mention", offset: 0, length: 8 }],
      },
    }).message;
    if (!mentionMsg) throw Error("missing mentionMsg");
    expect(command(mentionMsg, bot)).toEqual({
      name: "ask",
      args: "summarize PR #12",
    });

    const cmdMsg = updateSchema.parse({
      update_id: 4,
      message: {
        ...base,
        chat: { id: -200, type: "supergroup" },
        text: "/status@telo_agent",
        entities: [{ type: "bot_command", offset: 0, length: 18 }],
      },
    }).message;
    if (!cmdMsg) throw Error("missing cmdMsg");
    expect(command(cmdMsg, bot)).toEqual({ name: "status", args: "" });
  });

  test("exposes botInviteUrl in AccessLinks.view and parses write_access_allowed.inviter", () => {
    const links = new AccessLinks(randomBytes(32).toString("hex"));
    const w = workspace();
    const view = links.view(w, { id: "999", username: "telo_bot" });
    expect(view.botInviteUrl).toBe("https://t.me/botinvite/telo_bot");
    expect(links.view(w, undefined).botInviteUrl).toBeNull();

    const parsed = updateSchema.parse({
      update_id: 5,
      message: {
        ...base,
        write_access_allowed: {
          inviter: { id: 101, is_bot: false, username: "owner" },
        },
      },
    });
    expect(parsed.message?.write_access_allowed?.inviter?.id).toBe(101);
  });
});

describe("Bot API 10.4 topic deep links, widget data edits and widget_query", () => {
  test("builds private topic deep links only for positive topic IDs", () => {
    expect(privateTopicUrl("telo_bot", 42)).toBe("https://t.me/telo_bot/42");
    expect(privateTopicUrl("telo_bot", 0)).toBeUndefined();
    expect(privateTopicUrl(undefined, 42)).toBeUndefined();
  });

  test("ALLOWED_UPDATES includes widget_query", () => {
    expect(ALLOWED_UPDATES).toContain("widget_query");
  });

  test("queueWidgetDataEdit enforces private chat and 1024-byte data bounds", () => {
    const w = workspace();
    const id = queueWidgetDataEdit(w, {
      id: "widget:edit:1",
      actor: "101",
      chatId: "101",
      botId: "999",
      messageId: 77,
      chatData: JSON.stringify({ step: "check" }),
    });
    const intent = w.deliveries.find((d) => d.id === id);
    expect(intent?.widgetDataEdit).toEqual({
      messageId: 77,
      chatData: JSON.stringify({ step: "check" }),
    });
    expect(() =>
      queueWidgetDataEdit(w, {
        id: "widget:edit:bad",
        actor: "101",
        chatId: "-100",
        botId: "999",
        messageId: 77,
        chatData: "x",
      }),
    ).toThrow("widget_private_chat_required");
    expect(() =>
      queueWidgetDataEdit(w, {
        id: "widget:edit:big",
        actor: "101",
        chatId: "101",
        botId: "999",
        messageId: 77,
        chatData: "x".repeat(1025),
      }),
    ).toThrow("widget_data_too_large");
  });

  test("handleWidgetQuery authorizes only sent private app-owned interactive widgets", () => {
    const w = workspace();
    w.deliveries.push({
      id: "widget:interactive:1",
      actor: "101",
      chatId: "101",
      topicId: 0,
      botId: "999",
      remoteId: 500,
      text: "Dashboard",
      widget: {
        html: "<p>Live</p>",
        caption: "Dashboard",
        botId: "999",
        allowQueries: true,
      },
      state: "sent",
      at: new Date().toISOString(),
      attempts: 1,
    });
    w.deliveries.push({
      id: "widget:static:2",
      actor: "101",
      chatId: "101",
      topicId: 0,
      botId: "999",
      remoteId: 501,
      text: "Model widget",
      widget: {
        html: "<p>Static</p>",
        caption: "Model widget",
        botId: "999",
        allowQueries: false,
      },
      state: "sent",
      at: new Date().toISOString(),
      attempts: 1,
    });

    const parsed = updateSchema.parse({
      update_id: 6,
      widget_query: {
        id: "wq-1",
        from: { id: 101, is_bot: false },
        chat: { id: 101, type: "private" },
        message_id: 500,
        chat_instance: "inst-1",
        type: { type: "data" },
        data: "refresh",
      },
    }).widget_query;
    if (!parsed) throw Error("missing widget_query");

    expect(handleWidgetQuery(w, parsed, "999")).toEqual({
      accepted: true,
      data: JSON.stringify({ ok: true, query: "refresh" }),
    });
    expect(
      handleWidgetQuery(w, { ...parsed, message_id: 501 }, "999").accepted,
    ).toBe(false);
    expect(
      handleWidgetQuery(
        w,
        {
          ...parsed,
          from: { id: 999999, is_bot: false },
          chat: { id: 999999, type: "private" },
        },
        "999",
      ).accepted,
    ).toBe(false);
  });
});
