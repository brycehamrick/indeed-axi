import type { Page } from "playwright-core";

/** Shared canned payloads for Phase 1 tests. */

export function getConversationAndEventsQueryFake(
  messages: Array<{
    id: string;
    type: string;
    messageBody: string;
    publicationDateTime: string;
    author: { role: string };
  }>,
): Record<string, unknown> {
  return {
    conversation: {
      id: "conv1",
      title: "EA candidate",
      creationDateTime: "2026-09-28T00:00:00Z",
      eventsConnection: {
        edges: messages.map((message) => ({ node: { __typename: "ConversationEvent", ...message } })),
      },
    },
  };
}

/** A page whose evaluate() simulates in-page fetch against routes. */
export function pageWithRoutes(
  routes: Array<{ match: string; status?: number; body: () => unknown }>,
): Page {
  return {
    evaluate: async (_fn: unknown, arg: { body: string }) => {
      const parsed = JSON.parse(arg.body) as { query: string };
      for (const route of routes) {
        if (parsed.query.includes(route.match)) {
          return { status: route.status ?? 200, text: JSON.stringify(route.body()) };
        }
      }
      return { status: 200, text: JSON.stringify({ data: null, errors: [{ message: "no route" }] }) };
    },
  } as unknown as Page;
}
