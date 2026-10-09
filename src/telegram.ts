/**
 * Minimal Telegram Bot API sender. Messages are serialized through a queue
 * with ~1s spacing (Bot API allows roughly 1 msg/s per chat); failures are
 * logged and dropped — the watcher never blocks or dies on Telegram.
 */
export class Telegram {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly token: string,
    private readonly chatId: string,
  ) {}

  send(text: string): void {
    this.queue = this.queue.then(async () => {
      try {
        const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
        });
        if (!res.ok) {
          console.warn(`telegram send failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
        }
        await new Promise((r) => setTimeout(r, 1100));
      } catch (err) {
        console.warn(`telegram send failed: ${String(err)}`);
      }
    });
  }

  /** Await all queued sends (call before process exit). */
  flush(): Promise<void> {
    return this.queue;
  }
}
