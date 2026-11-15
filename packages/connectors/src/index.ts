export { createWatchSources, type EventSource, type WatchOptions } from "./event-source.ts";
export { ProviderRegistry, type ProviderFactory } from "./registry.ts";
export { createConnectorTools, untrusted } from "./tools.ts";
export type {
  Account,
  CalendarEvent,
  CalendarProvider,
  MailDraft,
  MailMessage,
  MailQuery,
  MailReader,
  MailSender,
  MailSummary,
  NewCalendarEvent,
  Provider,
  Provisioner,
  Stop,
} from "./types.ts";
