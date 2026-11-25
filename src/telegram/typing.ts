import type { Telegram } from "./client.ts";
import { TelegramError } from "./client.ts";

/**
 * Ephemeral native Telegram "typing" indicator for group chats (where message
 * drafts are unsupported) and as a fallback when private drafts are disabled.
 * Never throws or blocks final delivery.
 */
export class TelegramTyping {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private acknowledgeTimer: ReturnType<typeof setTimeout> | undefined;
  private active = false;
  private disabled = false;
  private sending = false;
  private acknowledged = false;
  private abortHandler: (() => void) | undefined;

  constructor(
    private destination: { chatId: string; topicId: number },
    private client: () => Promise<Telegram>,
    private guard: () => Promise<void>,
    private signal: AbortSignal,
    private options: {
      initialDelayMs?: number;
      intervalMs?: number;
      acknowledgeMessageId?: number;
      acknowledgeDelayMs?: number;
    } = {},
  ) {}

  start() {
    if (this.active || this.disabled || this.signal.aborted) return;
    this.active = true;
    this.abortHandler = () => this.stop();
    this.signal.addEventListener("abort", this.abortHandler, { once: true });
    this.schedule(this.options.initialDelayMs ?? 1500);
    const messageId = this.options.acknowledgeMessageId;
    if (
      !this.acknowledged &&
      Number.isSafeInteger(messageId) &&
      (messageId ?? 0) > 0
    ) {
      this.acknowledgeTimer = setTimeout(
        () => {
          this.acknowledgeTimer = undefined;
          void this.acknowledge(messageId as number);
        },
        Math.max(0, this.options.acknowledgeDelayMs ?? 3000),
      );
      this.acknowledgeTimer.unref?.();
    }
  }

  stop() {
    this.active = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.acknowledgeTimer) {
      clearTimeout(this.acknowledgeTimer);
      this.acknowledgeTimer = undefined;
    }
    if (this.abortHandler) {
      this.signal.removeEventListener("abort", this.abortHandler);
      this.abortHandler = undefined;
    }
  }

  private async acknowledge(messageId: number) {
    if (!this.active || this.acknowledged || this.signal.aborted) return;
    this.acknowledged = true;
    try {
      const client = await this.client();
      await this.guard();
      if (!this.active || this.signal.aborted) return;
      await client.call(
        "setMessageReaction",
        {
          chat_id: Number(this.destination.chatId),
          message_id: messageId,
          reaction: [{ type: "emoji", emoji: "👀" }],
        },
        { signal: this.signal, timeoutMs: 2000 },
      );
    } catch {
      /* Ephemeral acknowledgement reactions never block typing or final delivery. */
    }
  }

  private schedule(delayMs: number) {
    if (!this.active || this.disabled || this.signal.aborted) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.tick();
      },
      Math.max(0, delayMs),
    );
    this.timer.unref?.();
  }

  private async tick() {
    if (!this.active || this.disabled || this.signal.aborted || this.sending)
      return;
    this.sending = true;
    let nextDelay = this.options.intervalMs ?? 4500;
    try {
      const client = await this.client();
      await this.guard();
      if (!this.active || this.signal.aborted) return;
      await client.call(
        "sendChatAction",
        {
          chat_id: Number(this.destination.chatId),
          message_thread_id: this.destination.topicId || undefined,
          action: "typing",
        },
        { signal: this.signal, timeoutMs: 2000 },
      );
    } catch (error) {
      if (error instanceof TelegramError && error.disposition === "retry") {
        nextDelay = Math.max(nextDelay, error.retryAfter * 1000);
      } else if (
        error instanceof TelegramError &&
        error.disposition === "permanent"
      ) {
        this.disabled = true;
        this.stop();
        return;
      } else if (this.signal.aborted) {
        this.stop();
        return;
      }
    } finally {
      this.sending = false;
    }
    if (this.active && !this.disabled && !this.signal.aborted) {
      this.schedule(nextDelay);
    }
  }
}
