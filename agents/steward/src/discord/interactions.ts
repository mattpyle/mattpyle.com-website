/**
 * The slice of Discord's interaction model this service reads and writes, and
 * the contract between the HTTP server and whatever handles an interaction.
 *
 * The server (`server.ts`) owns the transport: the signature, `PING`, the
 * owner check, the reply deadline and the follow-up. A handler owns the
 * meaning: it looks at one interaction and says what to answer. A new command,
 * or a button, is a new handler; the server does not change.
 *
 * Types only, plus Discord's numeric constants.
 */

export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
} as const;

export const CallbackType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
} as const;

/** `1 << 6`: only the invoking user sees the message. */
export const EPHEMERAL = 64;

/** Discord's limit on a message's `content`. */
export const MAX_CONTENT_CHARS = 2000;

export interface InteractionOption {
  name: string;
  type?: number;
  value?: unknown;
  options?: InteractionOption[];
}

export interface Interaction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  guild_id?: string;
  /** Sent when the interaction is invoked in a server. */
  member?: { user?: { id?: string } };
  /** Sent when it is invoked in a direct message. */
  user?: { id?: string };
  data?: {
    name?: string;
    options?: InteractionOption[];
    /** A component's developer-defined id, for a later button handler. */
    custom_id?: string;
  };
}

/** The invoking user's id: `member.user.id` in a server, `user.id` in a direct message. */
export function invokingUserId(interaction: Interaction): string | null {
  const id = interaction.member?.user?.id ?? interaction.user?.id;
  return typeof id === 'string' && id !== '' ? id : null;
}

/** A message for the invoking user. */
export interface InteractionMessage {
  content: string;
  /** True when only the invoking user should see it. */
  ephemeral?: boolean;
}

/**
 * What a handler answers:
 *
 * - `reply`: the message is known now, with no work to wait for.
 * - `work`: the message comes from `run`. The server waits for it inside the
 *   first reply window and otherwise defers and edits the answer in later.
 *   `ephemeral` is fixed before the work starts, because a deferred
 *   acknowledgement carries the flag and the later edit cannot change it.
 */
export type HandlerResult =
  | { kind: 'reply'; message: InteractionMessage }
  | { kind: 'work'; ephemeral?: boolean; run: () => Promise<string> };

/** Null when the handler does not know the interaction. */
export type InteractionHandler = (interaction: Interaction) => HandlerResult | null;

/** The first handler that knows the interaction answers it. */
export function firstHandler(handlers: readonly InteractionHandler[]): InteractionHandler {
  return (interaction) => {
    for (const handler of handlers) {
      const result = handler(interaction);
      if (result) return result;
    }
    return null;
  };
}

/** `content`, cut to Discord's limit. */
export function clipContent(content: string): string {
  return content.length <= MAX_CONTENT_CHARS ? content : `${content.slice(0, MAX_CONTENT_CHARS - 1)}…`;
}
