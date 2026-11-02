import type { ForwardResult } from "../forward";
import type { Message } from "../message";
import type { RequestView } from "../request-view";

/** Detection strength used by `all`. */
export enum Tier {
  Weak = 1,
  Strong = 2,
  Definitive = 3,
}

export interface RespondContext {
  view: RequestView;
  message: Message;
  result: ForwardResult;
}

export interface InboundAdapter {
  type: string;
  label: string;
  /** Values found where this format carries its key. */
  tokens(v: RequestView): (string | undefined)[];
  /** Raw message fields; `finalize` cleans them up. */
  parse(v: RequestView): Partial<Message>;
  /** Success response in the shape this format's senders expect. */
  respond(ctx: RespondContext): Response;
  /** How strongly the request looks like this format (called only when the token matched here). */
  detect(v: RequestView): Tier | null;
  /** Copyable URL for the admin UI; {base} = origin/type/subscription, {token} = token. */
  urlTemplate: string;
}
