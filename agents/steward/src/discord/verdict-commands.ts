import { COMMAND_CHAT_INPUT, OPTION_STRING, type CommandDefinition, type SlashCommand } from './commands.js';
import { splitIdsAndWords } from '../lib/finding-ids.js';
import { DISCORD_APPROVE_REASON, MAX_REASON_CHARS, decideFindings, type VerdictDeps } from './verdicts.js';
import type { HandlerResult } from './interactions.js';

/**
 * `/approve` and `/reject`.
 *
 * - `/approve ids:<ids then words> [reason:<words>]`. One or more findings.
 *   The words after the ids, then the `reason` option, are the verdict reason;
 *   with neither, the reason is {@link DISCORD_APPROVE_REASON}.
 * - `/reject id:<one id> reason:<why>`. One finding, and the reason goes into
 *   the file as typed.
 *
 * A command that cannot be read is answered at once, to the invoking user
 * alone. A verdict's answer is posted in the channel.
 */

const usage = (text: string): HandlerResult => ({ kind: 'reply', message: { content: text, ephemeral: true } });

const TOO_LONG = `The reason is over ${MAX_REASON_CHARS} characters.`;

export function verdictCommands(deps: VerdictDeps): SlashCommand[] {
  const approve: SlashCommand = {
    definition: {
      type: COMMAND_CHAT_INPUT,
      name: 'approve',
      description: 'Approve one or more findings',
      default_member_permissions: '0',
      options: [
        {
          type: OPTION_STRING,
          name: 'ids',
          description: 'Short ids such as MP-121 MP-124, then any words for the fix',
          required: true,
          max_length: MAX_REASON_CHARS,
        },
        {
          type: OPTION_STRING,
          name: 'reason',
          description: 'Words for the fix, added after any typed with the ids',
          required: false,
          max_length: MAX_REASON_CHARS,
        },
      ],
    },
    handle(option) {
      const { refs, words } = splitIdsAndWords(option('ids'));
      if (refs.length === 0) return usage('Name at least one finding first: `/approve MP-121 MP-124 words for the fix`.');
      const reason = [words, option('reason')].filter(Boolean).join(' ') || DISCORD_APPROVE_REASON;
      if (reason.length > MAX_REASON_CHARS) return usage(TOO_LONG);
      return { kind: 'work', run: () => decideFindings(refs, 'approved', reason, deps) };
    },
  };

  const reject: SlashCommand = {
    definition: {
      type: COMMAND_CHAT_INPUT,
      name: 'reject',
      description: 'Reject one finding, with the reason',
      default_member_permissions: '0',
      options: [
        { type: OPTION_STRING, name: 'id', description: 'One short id, such as MP-121', required: true, max_length: 250 },
        { type: OPTION_STRING, name: 'reason', description: 'Why: kept as typed in the finding', required: true, max_length: MAX_REASON_CHARS },
      ],
    },
    handle(option) {
      const { refs, words } = splitIdsAndWords(option('id'));
      if (refs.length !== 1 || words !== '') return usage('A reject takes one finding: `/reject id:MP-121 reason:why`.');
      const reason = option('reason');
      if (reason === '') return usage('A reject needs a reason: say why.');
      if (reason.length > MAX_REASON_CHARS) return usage(TOO_LONG);
      return { kind: 'work', run: () => decideFindings(refs, 'rejected', reason, deps) };
    },
  };

  return [approve, reject];
}

/** What Discord is told about the two commands, for `register.ts`: the definitions need no backend. */
export function verdictCommandDefinitions(): CommandDefinition[] {
  const unused = (): never => {
    throw new Error('a command definition has no backend');
  };
  return verdictCommands({ resolve: unused, sendVerdict: unused }).map((command) => command.definition);
}
