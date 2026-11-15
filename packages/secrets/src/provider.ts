import type { SecretResolver } from "@vesper/contracts";

/** A source of secret values. What a reference looks like is the provider's business. */
export interface SecretProvider extends SecretResolver {}
