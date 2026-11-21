/**
 * DEMO MODE: a deterministic, rule-based planner that maps a question to the SAME tools the model
 * would use, and writes answers from the tools' typed results with fixed templates. No model call,
 * no cost. Because it reads the live database through the tools, changing a reservation changes
 * the next answer. It understands a small, documented set of phrasings (see docs/assistant.md).
 */
import type { Card, ConvContext } from './types.js';

export interface PlannedCall { tool: string; input: any }

export function planDemo(message: string, conv: ConvContext, known: { caseRefs: string[]; catalogRefs: string[] }): PlannedCall[] {
  const m = message.toLowerCase();
  const caseRef = known.caseRefs[0];
  const catRef = known.catalogRefs[0];
  const name = message.match(/\b(?:send|text|message|tell|for)\s+([A-Z][a-z]+)\b/)?.[1];
  const withCase = (o: any) => (caseRef ? { ...o, case_ref: caseRef } : o);
  if (/draft (the |a )?transfer|prepare (the |a )?transfer/.test(m)) return [{ tool: 'draft_action', input: { kind: 'transfer', ...(name ? { to: name } : {}) } }];
  if (/(draft|write|give me).*(text|message)/.test(m)) return [{ tool: 'draft_action', input: { kind: 'message', to: name ?? (/receiv/.test(m) ? 'receiver' : 'rep'), about: 'transfer' } }];
  if (/\bassign/.test(m)) return [{ tool: 'draft_action', input: { kind: 'assign_followup', ...(name ? { assignee_name: name } : {}) } }];
  // Pilot questions about spreadsheet uploads and hospital receipt.
  if (/what changed|what's different|what is different|difference/.test(m) && /upload|file|spreadsheet|workbook|import|sheet/.test(m)) return [{ tool: 'upload_changes', input: {} }];
  if (/confirm(ed)? receipt|acknowledg|check(ed)?[- ]in|(hospital|someone at).*(confirm|receiv|sign)|waiting (on|for) the hospital/.test(m)) return [{ tool: 'awaiting_receipt', input: {} }];
  if (/\bcalls?\b/.test(m) || /before \d/.test(m)) {
    const t = m.match(/before\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/);
    let hh = t ? Number(t[1]) : null;
    if (hh != null && (t![3]?.startsWith('p') || (!t![3] && hh < 8))) hh = hh % 12 + 12;
    return [{ tool: 'call_list', input: { day: /tomorrow/.test(m) ? 'tomorrow' : /today'?s cases/.test(m) ? 'today' : 'upcoming', act_before_local_time: hh != null ? `${String(hh).padStart(2, '0')}:${t![2] ?? '00'}` : null } }];
  }
  if (/if i move|move .*tray|which other cases/.test(m)) {
    const unit = message.match(/tray\s*#?\s*\d+/i)?.[0] ?? message.match(/\b[A-Z0-9]{2,}-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/)?.[0] ?? '';
    return [{ tool: 'transfer_impact', input: { unit, ...(caseRef ? { to_case_ref: caseRef } : /urgent/.test(m) ? { to_case_hint: 'urgent case' } : {}) } }];
  }
  if (/what changed|since i (checked|looked)|what's new|what is new/.test(m)) {
    const since = /yesterday afternoon/.test(m) ? 'yesterday_afternoon' : /yesterday morning/.test(m) ? 'yesterday_morning' : /yesterday/.test(m) ? 'yesterday' : /this morning|today/.test(m) ? 'today_morning' : 'last_24h';
    return [{ tool: 'case_history', input: withCase({ since }) }];
  }
  if (/short|on hand/.test(m)) return [{ tool: 'shortage_explanation', input: withCase(catRef ? { catalog_ref: catRef } : { item_hint: message }) }];
  if (/where can i get|one more|get another|find .*(unit|item)|available|exact item/.test(m)) return [{ tool: 'find_exact_item', input: withCase(catRef ? { catalog_ref: catRef } : {}) }];
  if (/at risk|which cases|region|ready|status|block|holding (it|this) up/.test(m)) {
    if (caseRef || (conv.caseId && !/which cases|region/.test(m))) return [{ tool: 'case_readiness', input: withCase({}) }];
    return [{ tool: 'call_list', input: { day: /today/.test(m) ? 'today' : 'tomorrow', act_before_local_time: null } }];
  }
  if (catRef) return [{ tool: 'find_exact_item', input: withCase({ catalog_ref: catRef }) }];
  if (caseRef) return [{ tool: 'case_readiness', input: { case_ref: caseRef } }];
  return [];
}

const n = (x: number, w: string) => `${x} ${w}${x === 1 ? '' : 's'}`;

/** Fixed-template answer text from typed cards (demo mode only). */
export function demoText(cards: Card[]): string {
  const parts: string[] = [];
  for (const c of cards) {
    const d = c.data;
    switch (c.type) {
      case 'call_list': {
        const un = d.upcoming.filter((e: any) => e.owner === 'Unassigned').length;
        parts.push(`${n(d.upcoming.length, 'call')} to make${d.cutoffLocal ? ` before ${d.cutoffLocal}` : ''}, earliest deadline first (${n(d.casesChecked, 'case')} checked).`
          + (d.passed.length ? ` ${n(d.passed.length, 'deadline')} already passed; listed separately.` : '')
          + (un ? ` ${un} ${un === 1 ? 'has' : 'have'} no owner (Unassigned); I can draft an assignment.` : '')
          + (d.upcoming[0] ? ` First: ${d.upcoming[0].caseRef} at ${d.upcoming[0].facility}, act by ${d.upcoming[0].deadlineLocal} (${d.upcoming[0].owner}): ${String(d.upcoming[0].typeLabel ?? '').toLowerCase()}.` : ''));
        break;
      }
      case 'shortage': parts.push(`${d.caseRef} needs ${d.required} × ${d.ref} (${d.manufacturer}): ${d.sentence}${d.reservedThisCase < d.required ? ` ${d.reservedThisCase === 0 ? 'None is' : d.reservedThisCase === 1 ? 'Only 1 is' : `Only ${d.reservedThisCase} are`} reserved for this case yet, so the board shows it short.` : ''}${d.pendingDiscrepancies?.length ? ` Not confirmed yet: ${d.pendingDiscrepancies.join(', ')} is waiting to be reconciled.` : ''}${(d.evidence ?? []).find((e: any) => e.kind === 'spreadsheet_row') ? ` Source: ${(d.evidence as any[]).filter((e) => e.kind === 'spreadsheet_row').map((e) => `${e.label} (exported ${e.atLocal})`).join('; ')}.` : ''}`); break;
      case 'availability':
        if (d.mode === 'case') {
          parts.push(d.best ? `Best exact source: ${d.best.label} at ${d.best.location} (custodian ${d.best.custodian}). Estimated arrival ${d.eligible[0]?.arrivalLocal}, before the cutoff ${d.requiredByLocal}. ${d.best.evidence.text}.` : `No eligible unit of this exact item can arrive before ${d.requiredByLocal}. Escalate; no substitutes are suggested.`);
          for (const x of d.excluded.slice(0, 3)) parts.push(`Not ${x.label} at ${x.location}${x.travelMinutes != null ? ` (${x.travelMinutes} min away)` : ''}: ${x.reasons.join('; ').replace(/\.$/, '')}.`);
        } else if (d.mode === 'stock') parts.push(`${d.usableTotal} usable unit(s) of ${d.item.ref} across ${d.rows.length} location(s).`);
        break;
      case 'impact': {
        const risk = d.atRisk.filter((a: any) => !a.replacement);
        parts.push(`${risk.length ? `Moving ${d.unit}${d.target ? ` to ${d.target.ref}` : ''} would put ${risk.map((a: any) => `${a.caseRef} (${a.startLocal})`).join(', ')} at risk: no eligible replacement before ${risk.length === 1 ? 'its' : 'their'} cutoff.` : `Moving ${d.unit} puts no other reserved case at risk${d.atRisk.length ? ' (replacements exist)' : ''}.`}`
          + (d.turnaround.length ? ` Also: ${d.turnaround.map((x: any) => `${x.caseRef} ${x.note}`).join('; ')}.` : '') + (d.targetNote ? ` ${d.targetNote}` : '') + ' Nothing was changed.');
        break;
      }
      case 'history': parts.push(d.gap ? `${d.gapText}${d.events.length ? ` Since then: ${n(d.events.length, 'recorded change')}.` : ''}` : `${n(d.events.length, 'recorded change')} since ${d.sinceLabel}${d.events.length ? `; latest: ${d.events.slice(-3).map((e: any) => `${e.atLocal} ${e.kind.replace(/[._]/g, ' ')} (${e.actor})`).join('; ')}` : ''}.`); break;
      case 'readiness': parts.push(`${d.caseRef} is ${d.status.replace('_', ' ')}${d.blockers.length ? `: ${d.blockers[0].explanation}` : '.'}`); break;
      case 'draft': parts.push(`${c.title}. Review it below; nothing happens until you confirm.`); break;
      case 'notice': parts.push(d.text); break;
      case 'changes':
        if (d.gap) { parts.push(d.gap); break; }
        parts.push(`Comparing ${d.latest.filename} (exported ${d.latest.exportedAtLocal}) with ${d.previous.filename}: ${d.changes.length ? n(d.changes.length, 'line') + ' changed' : 'no line changed'}, ${d.unchangedCount} unchanged.`);
        for (const x of d.changes.slice(0, 4)) parts.push(`${x.ref} ${x.unit} at ${x.location}: ${x.before ?? 'not listed before'} → ${x.after}. ${x.statusText}`);
        for (const e of d.effects.slice(0, 3)) parts.push(`${e.caseRef} now: ${e.sentence}`);
        if (d.notListed.length) parts.push(`${n(d.notListed.length, 'item')} the system holds ${d.notListed.length === 1 ? 'is' : 'are'} not listed in the latest file; nothing was zeroed.`);
        break;
      case 'awaiting':
        parts.push(d.entries.map((e: any) => `${e.caseRef} at ${e.facility} (surgery ${e.startLocal}): the courier recorded delivery, but ${e.facility} has not confirmed receipt. ${e.whoCanResolve.length ? `${e.whoCanResolve.join(' or ')} can confirm it` : 'No receiving user is set up there'}${e.actByLocal ? `; needed by ${e.actByLocal}` : ''}.`).join(' '));
        break;
    }
  }
  return parts.join(' ');
}

export const DEMO_HELP = 'Demo mode understands questions like: "What changed since the previous upload?", "Which case still needs someone at the hospital to confirm receipt?", "Which of tomorrow\'s cases do I need to make calls on before 3 today?", "Why does this case still show short?", "Where can I get one more of this exact item before receiving closes?", "If I move Tray 14 to the urgent case, which other cases would I put at risk?", "What changed since I checked this case yesterday afternoon?", and "Draft the transfer and give me a text I can send Jordan."';
