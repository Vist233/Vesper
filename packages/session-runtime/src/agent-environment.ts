import { createLocalEnvironment, type Environment } from "sakura-agent";

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Where the agent's own tools (`bash`, `read`, `write`, ...) run: the session's files directory on this machine, like the
 * framework's local environment, except that every command starts from the workspace's environment and nothing else
 * (`env -i`). Without it a command would inherit the runtime's own process environment: no DISPLAY of its desktop, so a
 * program could land on another session's screen, and whatever variables the runtime holds.
 */
export function workspaceShell(cwd: string, variables: Readonly<Record<string, string>>): Environment {
  const base = createLocalEnvironment(cwd);
  const assignments = Object.entries(variables)
    .map(([name, value]) => `${name}=${quote(value)}`)
    .join(" ");
  const wrap = (command: string) => `exec /usr/bin/env -i ${assignments} /bin/bash -c ${quote(command)}`;
  return {
    ...base,
    exec: (command, options) => base.exec(wrap(command), options),
    spawn: (command, options) => base.spawn(wrap(command), options),
  };
}
