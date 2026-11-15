/**
 * One line of the start-up report, as `/api/options` returns it and the page shows it. `warn` is for a real problem only
 * (no model key, the desk-daemon is not reachable, a tool the profiles need is missing); everything else is `info`.
 */
export interface StartupLine {
  level: "info" | "warn";
  text: string;
}
