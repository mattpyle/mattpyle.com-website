import { InteractionType, type HandlerResult, type Interaction, type InteractionHandler } from './interactions.js';

/**
 * Slash commands as a list: each entry is what Discord is told about the
 * command (`definition`, which `register.ts` sends) and what the service does
 * when it arrives (`handle`). {@link commandHandler} turns the list into one
 * interaction handler, so a new command is one more entry.
 */

/** Discord's `STRING` option type. */
export const OPTION_STRING = 3;

/** Discord's `CHAT_INPUT` command type: a slash command. */
export const COMMAND_CHAT_INPUT = 1;

export interface CommandOptionDefinition {
  type: typeof OPTION_STRING;
  name: string;
  description: string;
  required: boolean;
  max_length?: number;
}

export interface CommandDefinition {
  type: typeof COMMAND_CHAT_INPUT;
  name: string;
  description: string;
  /** `"0"`: hidden from every member but the server's administrators. The owner check is the gate. */
  default_member_permissions: string;
  /** Required options first, as Discord requires. */
  options: CommandOptionDefinition[];
}

export interface SlashCommand {
  definition: CommandDefinition;
  /** The command's string options by name; an absent option is the empty string. */
  handle(option: (name: string) => string, interaction: Interaction): HandlerResult;
}

/** The handler for `APPLICATION_COMMAND` interactions that name one of `commands`. */
export function commandHandler(commands: readonly SlashCommand[]): InteractionHandler {
  const byName = new Map(commands.map((command) => [command.definition.name, command]));
  return (interaction) => {
    if (interaction.type !== InteractionType.APPLICATION_COMMAND) return null;
    const command = byName.get(interaction.data?.name ?? '');
    if (!command) return null;
    const options = interaction.data?.options ?? [];
    const option = (name: string): string => {
      const value = options.find((each) => each.name === name)?.value;
      return typeof value === 'string' ? value.trim() : '';
    };
    return command.handle(option, interaction);
  };
}
