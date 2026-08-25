/**
 * Minimal Telegram Bot API client πάνω στο built-in `fetch`.
 *
 * Χωρίς telegraf/node-telegram-bot-api επίτηδες: χρειαζόμαστε τρία methods (`getUpdates`,
 * `sendMessage`, `getMe`) και το Bot API είναι απλό HTTPS. Ένα framework θα έφερνε
 * δεκάδες transitive deps για μηδενικό όφελος.
 */

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; username?: string };
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly errorCode?: number,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

export interface TelegramClientOptions {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class TelegramClient {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: TelegramClientOptions) {
    this.#token = options.token;
    this.#baseUrl = options.baseUrl ?? 'https://api.telegram.org';
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async call<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const response = await this.#fetch(`${this.#baseUrl}/bot${this.#token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      ...(signal ? { signal } : {}),
    });

    const payload = (await response.json()) as { ok: boolean; result?: T; description?: string; error_code?: number };
    if (!payload.ok) {
      throw new TelegramApiError(
        payload.description ?? `HTTP ${response.status}`,
        method,
        payload.error_code,
      );
    }
    return payload.result as T;
  }

  /** Long polling. Το `timeoutSec` κρατά τη σύνδεση ανοιχτή αντί για busy-loop. */
  async getUpdates(offset: number, timeoutSec = 25, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>(
      'getUpdates',
      { offset, timeout: timeoutSec, allowed_updates: ['message'] },
      signal,
    );
  }

  async sendMessage(chatId: number, text: string, signal?: AbortSignal): Promise<void> {
    await this.call(
      'sendMessage',
      // Χωρίς parse_mode: τα wallet addresses και τα μηνύματα λάθους περιέχουν χαρακτήρες
      // που το Markdown θα έσπαγε, και ένα αποτυχημένο alert είναι χειρότερο από άσχημο.
      { chat_id: chatId, text, disable_web_page_preview: true },
      signal,
    );
  }

  async getMe(signal?: AbortSignal): Promise<{ id: number; username?: string }> {
    return this.call<{ id: number; username?: string }>('getMe', {}, signal);
  }
}
