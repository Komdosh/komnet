import { isAddressedTo, type Message } from "@komnet/protocol";

/**
 * Decide whether a recorded room message enters one agent's local inbox.
 *
 * A targeted `needs: human` request must not fan out to every subscriber: the
 * explicit mention is the routing decision. An unaddressed human request keeps
 * the broad fallback because there is no authoritative shared on-call owner.
 */
export function shouldDeliverMessage(
  message: Message,
  agentId: string,
  subscribed: ReadonlySet<string>,
): boolean {
  if (message.header.from === agentId) return false;
  if (isAddressedTo(message.header, agentId, subscribed)) return true;
  return message.header.needs === "human" && message.header.mentions.length === 0;
}
