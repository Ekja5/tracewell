import { AppError } from './db.js';

export type Role = 'admin' | 'ops_manager' | 'inventory_coordinator' | 'scheduler' | 'rep' | 'warehouse' | 'courier' | 'hospital_receiving' | 'hospital_spd' | 'finance' | 'quality_manager';

export interface Ctx {
  userId: string; tenantId: string; role: Role; facilityId: string | null; territoryId: string | null; displayName: string;
}

/** Least-privilege permission map. Server-side checks use this; the UI only hides what the server would refuse. */
export const PERMS: Record<string, Role[]> = {
  'board.view': ['ops_manager', 'scheduler', 'rep', 'warehouse', 'inventory_coordinator', 'finance', 'quality_manager', 'hospital_receiving', 'hospital_spd', 'courier'],
  'case.manage': ['ops_manager', 'scheduler'],
  'card.approve': ['ops_manager'],
  'import.run': ['inventory_coordinator'],
  'inventory.view': ['ops_manager', 'inventory_coordinator', 'rep', 'warehouse', 'finance', 'quality_manager'],
  'rescue.search': ['ops_manager', 'rep', 'inventory_coordinator'],
  'rescue.reserve': ['ops_manager', 'rep'],
  'reservation.manage': ['ops_manager', 'inventory_coordinator'],
  'shipment.plan': ['ops_manager', 'inventory_coordinator'],
  'shipment.pick': ['ops_manager', 'warehouse', 'inventory_coordinator', 'rep'],
  'shipment.dispatch': ['ops_manager', 'warehouse', 'rep'],
  'shipment.courier': ['courier', 'rep', 'warehouse'],
  'shipment.receive': ['ops_manager', 'warehouse', 'rep', 'hospital_receiving', 'hospital_spd'],
  'tray.verify': ['ops_manager', 'warehouse', 'hospital_receiving', 'hospital_spd'],
  'discrepancy.resolve': ['ops_manager'],
  'hospital.release': ['hospital_spd', 'hospital_receiving'],
  'closeout.record': ['ops_manager', 'rep'],
  'usage.review': ['ops_manager', 'inventory_coordinator'],
  'finance.manage': ['finance'],
  'recall.manage': ['quality_manager'],
  'recall.task': ['quality_manager', 'ops_manager', 'rep', 'warehouse', 'inventory_coordinator'],
  'count.perform': ['inventory_coordinator', 'warehouse', 'rep'],
  'count.approve': ['ops_manager', 'inventory_coordinator'],
  'exception.resolve': ['ops_manager', 'finance', 'quality_manager', 'inventory_coordinator'],
  'integration.manage': ['finance', 'ops_manager'],
  'metrics.view': ['ops_manager', 'finance', 'quality_manager', 'inventory_coordinator'],
  'export.run': ['ops_manager', 'finance', 'quality_manager', 'inventory_coordinator', 'hospital_receiving', 'hospital_spd'],
  'audit.view': ['ops_manager', 'quality_manager', 'finance'],
  'issue.assign': ['ops_manager', 'scheduler'],
  'integration.view': ['ops_manager', 'finance', 'inventory_coordinator', 'quality_manager'],
  'card.view': ['ops_manager', 'scheduler', 'rep', 'inventory_coordinator'],
  'usage.void': ['ops_manager', 'rep'],
};

/** Admin inherits every distributor permission but never hospital-only decisions. */
export function can(ctx: Pick<Ctx, 'role'>, perm: string) {
  if (ctx.role === 'admin') return perm !== 'hospital.release';
  return (PERMS[perm] ?? []).includes(ctx.role);
}
export function requirePerm(ctx: Ctx, perm: string) {
  if (!can(ctx, perm)) throw new AppError(403, 'forbidden', `Your role (${ctx.role}) is not permitted to perform ${perm}`);
}
export const isFacilityUser = (ctx: Pick<Ctx, 'role'>) => ctx.role === 'hospital_receiving' || ctx.role === 'hospital_spd';

/**
 * SQL predicate limiting which cases a user can see. `c` is the cases alias, `f` the facilities alias.
 * Returns [sql, params] where placeholders start at startIdx.
 */
export function caseScope(ctx: Ctx, startIdx: number, c = 'c', f = 'f'): [string, any[]] {
  if (isFacilityUser(ctx)) return [`${c}.facility_id = $${startIdx}`, [ctx.facilityId]];
  if (ctx.role === 'rep') return [`(${c}.rep_user_id = $${startIdx} OR ${f}.territory_id = $${startIdx + 1})`, [ctx.userId, ctx.territoryId]];
  if (ctx.role === 'courier') return [`EXISTS (select 1 from shipments s where s.case_id=${c}.id and s.status in ('dispatched','delivered'))`, []];
  return ['true', []];
}
