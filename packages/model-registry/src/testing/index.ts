import type { ChatClientOptions, LlmClient } from "sakura-agent";

/** A client that never touches the network. It remembers the options it was built with, so tests can see what the registry passed. */
export function createFakeClientFactory() {
  const built: ChatClientOptions[] = [];
  return {
    built,
    create(options: ChatClientOptions): LlmClient {
      built.push(options);
      return {
        model: { id: options.model, contextWindow: options.contextWindow, supportsImages: false },
        async *stream() {
          yield { type: "text_delta", delta: "fake reply" };
        },
      };
    },
  };
}
