import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { login } from "../../src/admin/auth.ts";
import { threadDetail } from "../../src/admin/thread-history.ts";
import { createApp } from "../../src/app.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import type { Admin, Workspace } from "../../src/domain.ts";
import { DeliveryWorker } from "../../src/jobs/delivery.ts";
import { encrypt, passwordHash } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import type { Telegram } from "../../src/telegram/client.ts";
import { updateSchema } from "../../src/telegram/router.ts";
import { Ingress } from "../../src/telegram/webhook.ts";
import { queueWidgetDataEdit } from "../../src/telegram/widgets.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

const rootUrl = process.env.TEST_DATABASE_URL;
(rootUrl ? describe : describe.skip)(
  "Telegram Bot API 10.4 / 10.5 integration flows",
  () => {
    const root = database(rootUrl ?? "postgres://unused@localhost/unused");
    const name = `botapi105_${randomUUID().replaceAll("-", "")}`;
    const key = "ab".repeat(32);
    let store: Store;
    let setup: SetupService;
    let ingress: Ingress;
    let delivery: DeliveryWorker;
    let w: Workspace;
    let calls: { method: string; params: Record<string, unknown> }[];
    let botInfo: Record<string, unknown>;
    const admin: Admin = {
      id: randomUUID(),
      username: "operator",
      telegramId: "101",
      operator: true,
    };

    const telegram: Telegram = {
      async call<T>(method: string, params: Record<string, unknown> = {}) {
        calls.push({ method, params });
        if (method === "getMe") return botInfo as T;
        if (method === "setMySettings") {
          if (params.can_join_groups !== undefined)
            botInfo.can_join_groups = params.can_join_groups;
          if (params.can_read_all_group_messages !== undefined)
            botInfo.can_read_all_group_messages =
              params.can_read_all_group_messages;
          if (params.has_topics_enabled !== undefined)
            botInfo.has_topics_enabled = params.has_topics_enabled;
          if (params.allows_users_to_create_topics !== undefined)
            botInfo.allows_users_to_create_topics =
              params.allows_users_to_create_topics;
          if (params.has_topic_sidebar !== undefined)
            botInfo.has_topic_sidebar = params.has_topic_sidebar;
          return true as T;
        }
        return { message_id: 9001 } as T;
      },
    };

    beforeAll(async () => {
      await root.query(`CREATE DATABASE ${name}`);
      const url = new URL(rootUrl ?? "");
      url.pathname = `/${name}`;
      store = new Store(database(url.toString()));
      await migrate(store.pool);
      await store.pool.query(
        "INSERT INTO admins(id,username,password_hash,telegram_id,operator) VALUES($1,$2,'hash',$3,true)",
        [admin.id, admin.username, admin.telegramId],
      );
      setup = new SetupService(
        store,
        key,
        "https://telo.example.com",
        () => telegram,
      );
      ingress = new Ingress(store, setup);
      delivery = new DeliveryWorker(store, setup);
    });

    afterAll(async () => {
      await store.pool.end();
      await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await root.end();
    });

    beforeEach(async () => {
      calls = [];
      botInfo = {
        id: 999,
        is_bot: true,
        username: "telo_bot",
        active_usernames: ["telo_bot", "telo_ai"],
        can_join_groups: true,
        can_read_all_group_messages: false,
        has_topics_enabled: false,
        allows_users_to_create_topics: false,
        has_topic_sidebar: false,
      };
      await store.pool.query(
        "TRUNCATE workspaces, inbox, outbox, control_deliveries, chat_bindings, telegram_selections, operator_audit RESTART IDENTITY CASCADE",
      );
      await store.pool.query("UPDATE deployment SET data=$1 WHERE id=true", [
        JSON.stringify({
          version: 1,
          active: true,
          paused: false,
          webhookReady: true,
          ownerVerified: true,
          model: "gpt-4.1-mini",
          bot: { id: "999", username: "telo_bot", visibleAll: false },
          credentials: {
            bot: encrypt(key, "bot", "123456:fixture-token"),
          },
        }),
      ]);
      w = workspace();
      w.operatorId = admin.id;
      w.chats.push({
        id: "-1001",
        title: "Engineering",
        active: true,
        collection: true,
        linkedAt: new Date().toISOString(),
        visibleAll: true,
      });
      await store.pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [w.id, w.operatorId, JSON.stringify(w)],
      );
      await store.pool.query(
        "INSERT INTO chat_bindings(chat_id,workspace_id) VALUES($1,$2)",
        ["-1001", w.id],
      );
    });

    test("issuing a group link token never calls setMySettings or alters deployment privacy mode", async () => {
      const wsAdminId = randomUUID();
      const encoded = await passwordHash("workspace admin test password");
      await store.pool.query(
        "INSERT INTO admins(id,username,password_hash,telegram_id,operator) VALUES($1,'wsadmin',$2,'303',false)",
        [wsAdminId, encoded],
      );
      const session = await login(
        store.pool,
        "wsadmin",
        "workspace admin test password",
      );
      const app = createApp(store, setup, "https://telo.example.com");
      const res = await app.request(
        `https://telo.example.com/api/admin/workspaces/${w.id}/chats/link-token`,
        {
          method: "POST",
          headers: {
            cookie: `telo_session=${session.raw}`,
            "x-csrf-token": session.csrf,
            origin: "https://telo.example.com",
          },
        },
      );
      expect(res.status).toBe(201);
      expect(calls.some((c) => c.method === "setMySettings")).toBe(false);
      expect((await store.deployment()).bot?.visibleAll).toBe(false);
    });

    test("saveCredentials never calls setMySettings on version conflict or success; only explicit operator saveBotSettings does", async () => {
      await expect(
        setup.saveCredentials(admin, {
          version: 999,
          botToken: "123456789:AAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKKLL",
        }),
      ).rejects.toThrow("version_conflict");
      expect(calls.some((c) => c.method === "setMySettings")).toBe(false);

      calls = [];
      const progress = await setup.saveCredentials(admin, {
        version: 1,
        botToken: "123456789:AAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKKLL",
      });
      expect(calls.some((c) => c.method === "setMySettings")).toBe(false);
      expect(progress.bot?.visibleAll).toBe(false);

      // Non-operator workspace admin cannot call saveBotSettings either.
      const nonOperator: Admin = {
        id: randomUUID(),
        username: "member-admin",
        telegramId: "303",
        operator: false,
      };
      await expect(
        setup.saveBotSettings(nonOperator, {
          version: progress.version,
          visibleAll: true,
        }),
      ).rejects.toThrow("operator_required");
      expect(calls.some((c) => c.method === "setMySettings")).toBe(false);
    });

    test("saveBotSettings calls setMySettings with callback_query_mode default and persists BotFullInfo", async () => {
      const progress = await setup.saveBotSettings(admin, {
        version: 1,
        canJoinGroups: true,
        visibleAll: true,
        hasTopicsEnabled: true,
        allowsUsersToCreateTopics: true,
        hasTopicSidebar: true,
      });
      expect(calls[0]).toEqual({
        method: "setMySettings",
        params: {
          callback_query_mode: "default",
          can_join_groups: true,
          can_read_all_group_messages: true,
          has_topics_enabled: true,
          allows_users_to_create_topics: true,
          has_topic_sidebar: true,
        },
      });
      expect(progress.bot).toEqual({
        id: "999",
        username: "telo_bot",
        visibleAll: true,
        activeUsernames: ["telo_bot", "telo_ai"],
        canJoinGroups: true,
        hasTopicsEnabled: true,
        allowsUsersToCreateTopics: true,
        hasTopicSidebar: true,
      });
    });

    test("group callback rejection sends ephemeral reply using callback_query_id", async () => {
      await ingress.accept(
        updateSchema.parse({
          update_id: 10,
          callback_query: {
            id: "cb-group-1",
            from: { id: 777, is_bot: false, first_name: "Bob" },
            data: `request_access:${w.id}`,
            message: {
              message_id: 44,
              date: 1_760_000_000,
              from: { id: 999, is_bot: true },
              chat: { id: -1001, type: "supergroup", title: "Engineering" },
              text: "Request access",
            },
          },
        }),
      );
      expect(calls).toContainEqual({
        method: "answerCallbackQuery",
        params: {
          callback_query_id: "cb-group-1",
          text: "Access requested. Your workspace admin can now review it.",
        },
      });
      expect(calls).toContainEqual({
        method: "sendMessage",
        params: {
          text: "Access requested. Your workspace admin can now review it.",
          ephemeral_message_parameters: { callback_query_id: "cb-group-1" },
        },
      });
    });

    test("widget_query answers authorized private widgets and DeliveryWorker sends editMessageWidgetData", async () => {
      await store.change(w.id, (current) => {
        current.deliveries.push({
          id: "widget:live:1",
          actor: "101",
          chatId: "101",
          topicId: 0,
          botId: "999",
          remoteId: 700,
          text: "Status widget",
          widget: {
            html: "<p>Live</p>",
            caption: "Status widget",
            botId: "999",
            allowQueries: true,
          },
          state: "sent",
          at: new Date().toISOString(),
          attempts: 1,
        });
        queueWidgetDataEdit(current, {
          id: "widget:edit:700",
          actor: "101",
          chatId: "101",
          botId: "999",
          messageId: 700,
          chatData: '{"progress":80}',
        });
      });

      await delivery.send(w.id, "widget:edit:700");
      expect(calls).toContainEqual({
        method: "editMessageWidgetData",
        params: {
          chat_id: "101",
          message_id: 700,
          chat_data: '{"progress":80}',
        },
      });

      await ingress.accept(
        updateSchema.parse({
          update_id: 11,
          widget_query: {
            id: "wq-live-1",
            from: { id: 101, is_bot: false },
            chat: { id: 101, type: "private" },
            message_id: 700,
            chat_instance: "inst-101",
            type: { type: "data" },
            data: "ping",
          },
        }),
      );
      expect(calls).toContainEqual({
        method: "answerWidgetQuery",
        params: {
          widget_query_id: "wq-live-1",
          data: '{"ok":true,"query":"ping"}',
        },
      });
    });

    test("write_access_allowed.inviter welcomes members and queues access request for owner-invited contacts", async () => {
      await ingress.accept(
        updateSchema.parse({
          update_id: 12,
          message: {
            message_id: 80,
            date: 1_760_000_000,
            from: { id: 888, is_bot: false, first_name: "Charlie" },
            chat: { id: 888, type: "private" },
            write_access_allowed: {
              inviter: { id: 101, is_bot: false, username: "owner" },
            },
          },
        }),
      );
      const updated = await store.read(w.id);
      expect(
        updated.accessRequests?.some(
          (r) => r.actor === "888" && r.status === "pending",
        ),
      ).toBe(true);
    });

    test("threadDetail includes private topic deep link when topicId > 0", () => {
      const local = workspace();
      const run = createRun(
        local,
        "101",
        "Check CI",
        "101",
        88,
        "gpt-4.1-mini",
        {
          botId: "999",
        },
      );
      const detail = threadDetail(
        local,
        run.threadId ?? `run-${run.id}`,
        0,
        25,
        "telo_bot",
      );
      expect(detail.thread.telegramUrl).toBe("https://t.me/telo_bot/88");
    });
  },
);
