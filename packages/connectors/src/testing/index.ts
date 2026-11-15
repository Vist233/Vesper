import { createMemoryProvider, type MemoryProvider } from "./memory-provider.ts";
import { type ProviderHarness, providerContract } from "./contract.ts";

export { createMemoryProvider, type MemoryProvider, type ProviderHarness, providerContract };

/** A harness for the reference provider, for the contract suite and for tests of the tools. */
export function memoryHarness(provider: MemoryProvider = createMemoryProvider()): ProviderHarness {
  return {
    provider,
    address: provider.address ?? "bot@example.test",
    async deliver(mail) {
      provider.deliver(mail);
    },
    async addExternalEvent(event) {
      provider.addExternalEvent(event);
    },
    async settle() {},
    async cleanup() {},
  };
}
