import type { Ctx } from '../perms.js';

/** A link to a record the user may open; produced by the server from records it read under the user's scope. */
export interface Source { label: string; href: string; kind: string }

/**
 * A typed, server-computed result shown to the user as a card. The model never writes cards:
 * it can only choose which tool to call. Facts and links are therefore independent of phrasing.
 */
export interface Card {
  type: 'call_list' | 'readiness' | 'shortage' | 'availability' | 'impact' | 'history' | 'draft' | 'notice' | 'choice' | 'changes' | 'awaiting' | 'queue';
  title: string;
  checkedAt: string;
  data: any;
  sources: Source[];
  caveats: string[];
  actions?: { kind: 'assign_followup' | 'transfer' | 'message'; label: string; params: any }[];
}

export interface Clarification { question: string; options: { label: string; contextPatch: Record<string, any> }[] }

export interface ToolOutput {
  card?: Card;
  /** Minimal fields sent to the model (never credentials, emails, or more than the question needs). */
  modelData: any;
  clarification?: Clarification;
  extraCards?: Card[];
  contextPatch?: Record<string, any>;
}

/** Carried through follow-up questions so the manager does not repeat the case or item. */
export interface ConvContext {
  caseId?: string | null; caseRef?: string | null; facilityId?: string | null; requirementId?: string | null;
  catalogItemId?: string | null; catalogRef?: string | null; manufacturer?: string | null; packageUnits?: number | null;
  stockItemId?: string | null; lastEligible?: any; lastCallList?: any[]; pendingQuestion?: string | null; pendingTool?: any;
}

export interface AssistantCtx extends Ctx { tenantTz: string }

export interface ToolDef {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, any>; required?: string[]; additionalProperties: false };
  /** Permission required to call the tool at all (checked on every call). */
  perm: string | null;
  run: (db: any, actx: AssistantCtx, input: any, conv: ConvContext) => Promise<ToolOutput>;
}
