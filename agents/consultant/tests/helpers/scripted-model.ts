/**
 * A Strands model that plays a script instead of calling a provider. The tests register it under
 * the agent's model name, so the workflow, the harness and the model activity all run for real and
 * only the model's answers are canned.
 *
 * Each model call takes the next step. It also records the messages it was given, which is how the
 * injection test sees exactly what reached "the model".
 */
import { Model, type BaseModelConfig, type Message, type ModelStreamEvent } from '@strands-agents/sdk';

export type Step =
  | { text: string; usage?: Usage; stopReason?: string }
  | { tool: string; input: Record<string, unknown>; usage?: Usage };

type Usage = { inputTokens: number; outputTokens: number; totalTokens?: number; cacheReadInputTokens?: number };

export class Script {
  steps: Step[] = [];
  /** Every call's messages, as JSON, in call order. */
  seen: string[] = [];
  calls = 0;

  set(steps: Step[]): void {
    this.steps = [...steps];
    this.seen = [];
    this.calls = 0;
  }
}

let toolUseCounter = 0;

export class ScriptedModel extends Model<BaseModelConfig> {
  #config: BaseModelConfig = { modelId: 'scripted' };

  constructor(private readonly script: Script) {
    super();
  }

  updateConfig(config: BaseModelConfig): void {
    this.#config = { ...this.#config, ...config };
  }

  getConfig(): BaseModelConfig {
    return this.#config;
  }

  async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.script.calls += 1;
    this.script.seen.push(JSON.stringify(messages));
    const step = this.script.steps.shift() ?? { text: 'Script exhausted.' };
    const usage = step.usage ?? { inputTokens: 100, outputTokens: 20 };
    yield { type: 'modelMessageStartEvent', role: 'assistant' } as ModelStreamEvent;
    if ('tool' in step) {
      toolUseCounter += 1;
      yield {
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: step.tool, toolUseId: `tooluse_${toolUseCounter}` },
      } as ModelStreamEvent;
      yield {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: JSON.stringify(step.input) },
      } as ModelStreamEvent;
      yield { type: 'modelContentBlockStopEvent' } as ModelStreamEvent;
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' } as ModelStreamEvent;
    } else {
      yield { type: 'modelContentBlockStartEvent' } as ModelStreamEvent;
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: step.text } } as ModelStreamEvent;
      yield { type: 'modelContentBlockStopEvent' } as ModelStreamEvent;
      yield { type: 'modelMessageStopEvent', stopReason: step.stopReason ?? 'endTurn' } as ModelStreamEvent;
    }
    yield {
      type: 'modelMetadataEvent',
      usage: { totalTokens: usage.inputTokens + usage.outputTokens, ...usage },
    } as ModelStreamEvent;
  }
}
