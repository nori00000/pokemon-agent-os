import type { AgentEvent, AgentRun } from "@minpeter/pss-runtime";
import type { RunnerEvent } from "../runner";

export interface CommandAgentRunnerOptions {
  onEvent?: (event: CommandAgentRunnerEvent) => void;
}

export type CommandAgentRunnerEvent =
  | RunnerEvent
  | {
      ignoredEvent: AgentEvent;
      reason: "one-game-action-per-turn";
      type: "command-agent-runner-intervention";
    };

export class CommandAgentRunner {
  readonly #run: AgentRun;

  constructor(run: AgentRun) {
    this.#run = run;
  }

  async run({ onEvent = console.dir }: CommandAgentRunnerOptions = {}): Promise<void> {
    let gameActionSeen = false;
    for await (const event of this.#run.stream()) {
      if (isGameActionEvent(event)) {
        if (gameActionSeen) {
          onEvent({
            ignoredEvent: event,
            reason: "one-game-action-per-turn",
            type: "command-agent-runner-intervention",
          });
          continue;
        }
        gameActionSeen = true;
      }
      onEvent(event);
    }
  }
}

function isGameActionEvent(event: AgentEvent): boolean {
  return event.type === "tool-call" && event.toolName.startsWith("mgba_");
}
