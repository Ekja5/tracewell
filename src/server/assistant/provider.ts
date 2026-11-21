/**
 * Claude provider adapter (Anthropic Messages API via the official SDK, app-hosted tool loop).
 * The loop runs here because every tool must execute inside the app, against the database, under
 * the signed-in user's permissions. Credentials stay server-side (ANTHROPIC_API_KEY); the browser
 * never sees them. The whole exchange has one deadline; on timeout/error the caller degrades.
 */
import Anthropic from '@anthropic-ai/sdk';

export interface ProviderConfig { apiKey: string | null; model: string; timeoutMs: number; baseURL: string; effort: string; maxToolRounds: number }

export function providerConfig(): ProviderConfig {
  return {
    apiKey: process.env.ANTHROPIC_API_KEY || null,
    model: process.env.ASSISTANT_MODEL || 'claude-opus-5-5',
    timeoutMs: Number(process.env.ASSISTANT_TIMEOUT_MS ?? 20000),
    // Explicit so an unrelated ANTHROPIC_BASE_URL in the host environment is never picked up silently.
    baseURL: process.env.ASSISTANT_BASE_URL || 'https://api.anthropic.com',
    effort: process.env.ASSISTANT_EFFORT || 'medium',
    maxToolRounds: Number(process.env.ASSISTANT_MAX_TOOL_ROUNDS ?? 6),
  };
}

export class ProviderUnavailable extends Error {
  constructor(public reason: 'not_configured' | 'timeout' | 'error' | 'refused', message: string) { super(message); }
}

export interface LoopResult { text: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; toolCalls: number; model: string }

/**
 * Run the tool loop. `runTool` executes a tool in the app and returns { forModel, stop? }:
 * `stop` ends the loop early (e.g. a clarification the user must answer; the model must not guess).
 */
export async function runProviderLoop(opts: {
  system: string; tools: Anthropic.Tool[]; messages: Anthropic.MessageParam[];
  runTool: (name: string, input: unknown) => Promise<{ forModel: string; isError?: boolean; stop?: boolean }>;
}): Promise<LoopResult> {
  const cfg = providerConfig();
  if (!cfg.apiKey) throw new ProviderUnavailable('not_configured', 'No model provider is configured (ANTHROPIC_API_KEY is not set).');
  const client = new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, timeout: cfg.timeoutMs, maxRetries: 1 });
  const deadline = AbortSignal.timeout(cfg.timeoutMs);
  const messages = [...opts.messages];
  const out: LoopResult = { text: '', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, toolCalls: 0, model: cfg.model };
  try {
    for (let round = 0; round <= cfg.maxToolRounds; round++) {
      const params: any = {
        model: cfg.model, max_tokens: 4000,
        system: [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }],
        tools: opts.tools, messages,
        output_config: { effort: cfg.effort },
        // Server-side refusal fallback (opt-in): the API retries a declined request on a fallback model.
        betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      };
      const resp: any = await client.beta.messages.create(params, { signal: deadline });
      out.inputTokens += resp.usage?.input_tokens ?? 0; out.outputTokens += resp.usage?.output_tokens ?? 0; out.cacheReadTokens += resp.usage?.cache_read_input_tokens ?? 0;
      out.model = resp.model ?? out.model;
      if (resp.stop_reason === 'refusal') throw new ProviderUnavailable('refused', 'The model declined to answer this request.');
      const text = (resp.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
      const toolUses = (resp.content ?? []).filter((b: any) => b.type === 'tool_use');
      if (resp.stop_reason !== 'tool_use' || !toolUses.length) { out.text = text; return out; }
      messages.push({ role: 'assistant', content: resp.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      let stop = false;
      for (const tu of toolUses) {
        out.toolCalls++;
        const r = await opts.runTool(tu.name, tu.input);
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: r.forModel, is_error: r.isError ?? false });
        if (r.stop) stop = true;
      }
      if (stop) { out.text = text; return out; }
      messages.push({ role: 'user', content: results });
    }
    out.text = 'I needed more steps than allowed to answer this. The facts gathered are shown below.';
    return out;
  } catch (e: any) {
    if (e instanceof ProviderUnavailable) throw e;
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || e instanceof Anthropic.APIConnectionTimeoutError || e instanceof Anthropic.APIUserAbortError || deadline.aborted) throw new ProviderUnavailable('timeout', `The model did not answer within ${Math.round(cfg.timeoutMs / 1000)} s.`);
    if (e instanceof Anthropic.RateLimitError) throw new ProviderUnavailable('error', 'The model service is rate-limited right now.');
    if (e instanceof Anthropic.AuthenticationError) throw new ProviderUnavailable('error', 'The model service rejected the server credentials.');
    if (e instanceof Anthropic.APIError) throw new ProviderUnavailable('error', `The model service returned an error (${e.status ?? 'network'}).`);
    throw new ProviderUnavailable('error', 'The model service could not be reached.');
  }
}
