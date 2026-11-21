import { AppError, Db, maybe, one, rows } from '../db.js';
import { Ctx, requirePerm } from '../perms.js';
import { now, nowIso } from '../clock.js';
import { audit, notify } from '../audit.js';
import { AVAILABILITY_SQL, lastVerification, localDate, reserve } from './inventory.js';
import { getPolicy, getVisibleCase, fmtLocal } from './cases.js';
import { receivingDeadline, nextReceivingOpen, fmtClock } from '../time.js';

/** How much to trust a location's answer: physical evidence vs paperwork, and how old it is. */
export function evidenceTier(kind: string | null, at: string | null, nowMs: number) {
  if (!kind || !at) return { tier: 'none', text: 'No physical scan on record here' };
  const ageMin = Math.round((nowMs - new Date(at).getTime()) / 60e3);
  const age = ageMin < 60 ? `${ageMin} min ago` : ageMin < 48 * 60 ? `${Math.round(ageMin / 60)} h ago` : `${Math.round(ageMin / 1440)} days ago`;
  if (/opening balance/.test(kind)) return { tier: 'unverified', text: `Never physically scanned here (opening import ${age})` };
  const verb = /count/.test(kind) ? 'Counted here' : /tray/.test(kind) ? 'Tray contents checked here' : /receiv/.test(kind) ? 'Received and checked here' : 'Adjusted here';
  return { tier: ageMin <= 120 ? 'fresh' : ageMin <= 24 * 60 ? 'recent' : 'stale', text: `${verb} ${age}` };
}

const HANDLING_MIN = 30; // seeded pick/pack/handoff allowance, labeled as an estimate

/**
 * Exact-item rescue search. Only the exact catalog item required by the case is considered;
 * clinical substitutes are never suggested. Eligible sources are ranked by: meets cutoff,
 * travel time, freshness of last physical verification, incremental cost.
 */
export async function rescueSearch(db: Db, ctx: Ctx, caseId: string, requirementId: string) {
  requirePerm(ctx, 'rescue.search');
  const c = await getVisibleCase(db, ctx, caseId);
  const req = await one(db, `select cr.*, ci.ref, ci.description, ci.item_type, ci.tracking from case_requirements cr join catalog_items ci on ci.id=cr.catalog_item_id where cr.id=$1 and cr.case_id=$2`, [requirementId, caseId]);
  const policy = await getPolicy(db, c.facility_id);
  const start = new Date(c.scheduled_start);
  const requiredBy = receivingDeadline(new Date(start.getTime() - (req.item_type === 'tray' ? policy.tray_due_hours_before : policy.implant_due_hours_before) * 3600e3), c.timezone, policy.receiving_open, policy.receiving_close).at;
  const plannedUse = localDate(start, c.timezone);
  const t = now();
  const already = (await one(db, `select coalesce(sum(qty),0)::int n from reservations where requirement_id=$1 and status='active'`, [requirementId])).n;
  const needed = Math.max(0, req.qty - already);

  const bals = await rows(db, `select a.*, s.serial_number, s.lot_number, s.expiry_date, p.name owner_name, p.kind owner_kind, te.minutes travel_min, te.courier_cost_cents, te.basis travel_basis,
      hu.display_name holder_name, fac.name loc_facility_name,
      (select h.reason from quality_holds h where h.stock_item_id=a.stock_item_id and h.status='active' limit 1) hold_reason
    from (${AVAILABILITY_SQL}) a join stock_items s on s.id=a.stock_item_id join parties p on p.id=a.owner_party_id
    left join travel_estimates te on te.from_location_id=a.location_id and te.to_facility_id=$2
    left join users hu on hu.id=a.holder_user_id left join facilities fac on fac.id=a.location_facility_id
    where s.catalog_item_id=$1 and a.location_kind not in ('consumed','wasted','missing')`, [req.catalog_item_id, c.facility_id]);

  const eligible: any[] = [];
  const excluded: any[] = [];
  for (const b of bals) {
    const label = b.serial_number ? `SN ${b.serial_number}` : `lot ${b.lot_number}`;
    const conflicts = await rows(db, `select c2.id, c2.case_ref, c2.scheduled_start, f2.name facility_name, f2.timezone, r.qty from reservations r join cases c2 on c2.id=r.case_id join facilities f2 on f2.id=c2.facility_id
      where r.stock_item_id=$1 and r.location_id=$2 and r.owner_party_id=$3 and r.status='active'`, [b.stock_item_id, b.location_id, b.owner_party_id]);
    const forThisCase = conflicts.filter((x) => x.id === caseId);
    const ver = await lastVerification(db, b.stock_item_id, b.location_id);
    const atDestination = b.location_facility_id === c.facility_id;
    const travel = atDestination ? 0 : b.travel_min;
    const rawArrival = travel != null ? new Date(t.getTime() + (travel + (atDestination ? 0 : HANDLING_MIN)) * 60e3) : null;
    // A delivery that lands outside receiving hours is received at the next opening (overnight transfers).
    const arrival = rawArrival && !atDestination ? nextReceivingOpen(rawArrival, c.timezone, policy.receiving_open, policy.receiving_close) : rawArrival;
    const waitsForOpen = !!(rawArrival && arrival && arrival.getTime() !== rawArrival.getTime());
    const row: any = {
      stockItemId: b.stock_item_id, locationId: b.location_id, ownerPartyId: b.owner_party_id, label, serial: b.serial_number, lot: b.lot_number, expiry: b.expiry_date,
      location: b.location_name, locationCode: b.location_code, locationKind: b.location_kind, custodian: b.holder_name ?? (b.loc_facility_name ?? 'Distributor warehouse'),
      owner: b.owner_name, ownerKind: b.owner_kind, condition: b.condition, onHand: b.on_hand, reserved: b.reserved, available: b.on_hold ? 0 : Math.max(0, b.on_hand - b.reserved),
      hold: b.hold_reason, travelMinutes: travel, travelBasis: atDestination ? 'Already at the facility' : b.travel_basis, handlingMinutes: atDestination ? 0 : HANDLING_MIN,
      estimatedArrival: arrival?.toISOString() ?? null, meetsCutoff: arrival ? arrival <= requiredBy : false,
      lastVerifiedAt: ver?.at ?? null, lastVerifiedKind: ver?.kind ?? null, verificationAgeHours: ver ? Math.round((t.getTime() - new Date(ver.at).getTime()) / 36e5) : null,
      evidence: evidenceTier(ver?.kind ?? null, ver?.at ?? null, t.getTime()), arrivalNote: waitsForOpen ? `Lands after receiving closes; received when ${c.facility_name} opens at ${fmtClock(policy.receiving_open)}` : null,
      incrementalCostCents: atDestination ? 0 : b.courier_cost_cents, expiryEligible: !b.expiry_date || b.expiry_date >= plannedUse,
      reservationConflicts: conflicts.map((x) => ({ caseRef: x.case_ref, caseId: x.id, when: fmtLocal(x.scheduled_start, x.timezone), facility: x.facility_name, qty: x.qty })),
      reasons: [] as string[],
    };
    if (b.condition !== 'sealed') row.reasons.push(`Condition is "${b.condition}"; only sealed stock can be sent to a case`);
    if (b.on_hold) row.reasons.push(`On quality hold: ${b.hold_reason}`);
    if (!row.expiryEligible) row.reasons.push(`Expires ${b.expiry_date}, before planned use on ${plannedUse}`);
    if (b.location_kind === 'quarantine') row.reasons.push('In quarantine');
    if (b.location_kind === 'in_transit') row.reasons.push('Already in transit on another shipment');
    if (!b.allocatable && !['quarantine', 'in_transit'].includes(b.location_kind)) row.reasons.push(`${b.location_kind.replace('_', ' ')} stock is not allocatable`);
    if (b.owner_kind === 'hospital' && !atDestination) row.reasons.push(`Owned by ${b.owner_name}; moving it requires that owner's approval`);
    if (forThisCase.length) row.reasons.push('Already reserved for this case');
    else if (row.available < 1 && conflicts.length) row.reasons.push(`Reserved for ${conflicts.map((x) => `case ${x.case_ref} (${fmtLocal(x.scheduled_start, x.timezone)})`).join(', ')}. Taking it would put that case at risk.`);
    if (travel == null) row.reasons.push(`No travel estimate from ${b.location_name} to ${c.facility_name}; cutoff cannot be evaluated`);
    if (row.reasons.length) excluded.push(row);
    else {
      if (!row.meetsCutoff) row.warning = `Estimated arrival ${fmtLocal(arrival!, c.timezone)} is after the required-by time ${fmtLocal(requiredBy, c.timezone)}`;
      eligible.push(row);
    }
  }
  eligible.sort((a, b) => Number(b.meetsCutoff) - Number(a.meetsCutoff) || a.travelMinutes - b.travelMinutes
    || (a.verificationAgeHours ?? 1e9) - (b.verificationAgeHours ?? 1e9) || a.incrementalCostCents - b.incrementalCostCents);
  eligible.forEach((e, i) => (e.rank = i + 1));
  const best = eligible[0];
  excluded.sort((a, b) => (a.travelMinutes ?? 1e9) - (b.travelMinutes ?? 1e9));
  for (const x of excluded) x.closerThanBest = best ? (x.travelMinutes ?? 1e9) < best.travelMinutes : false;
  await audit(db, ctx, 'rescue.search', 'case_requirement', requirementId, { eligible: eligible.length, excluded: excluded.length }, { caseId });
  return {
    case: { id: c.id, caseRef: c.case_ref, facility: c.facility_name, timezone: c.timezone, scheduledStart: c.scheduled_start },
    requirement: { id: req.id, ref: req.ref, description: req.description, itemType: req.item_type, qty: req.qty, reserved: already, needed },
    requiredBy: requiredBy.toISOString(), plannedUseDate: plannedUse, searchedAt: t.toISOString(),
    rankingRule: 'Meets cutoff, then shortest estimated travel, then most recent physical verification, then lowest incremental cost. Exact item only; no clinical substitutes.',
    travelDisclaimer: 'Travel times and courier costs are seeded estimates, not live traffic or courier quotes.',
    eligible, excluded,
  };
}

/** Which cases would be affected by taking this unit? Shows the destination case plus any other case that could need it. */
export async function previewTransfer(db: Db, ctx: Ctx, caseId: string, requirementId: string, src: { stockItemId: string; locationId: string; ownerPartyId: string }) {
  const search = await rescueSearch(db, ctx, caseId, requirementId);
  const cand = search.eligible.find((e) => e.stockItemId === src.stockItemId && e.locationId === src.locationId && e.ownerPartyId === src.ownerPartyId);
  if (!cand) {
    const ex = search.excluded.find((e) => e.stockItemId === src.stockItemId && e.locationId === src.locationId);
    throw new AppError(409, 'not_eligible', ex ? `Not eligible: ${ex.reasons.join('; ')}` : 'That source is not eligible');
  }
  const req = await one(db, `select catalog_item_id from case_requirements where id=$1`, [requirementId]);
  const loc = await one(db, `select * from locations where id=$1`, [src.locationId]);
  const t = now();
  // Other open cases in the next 72 h that need this exact item but are not fully covered.
  const others = await rows(db, `select c.id, c.case_ref, c.scheduled_start, f.name facility, f.timezone, cr.qty,
      coalesce((select sum(r.qty) from reservations r where r.requirement_id=cr.id and r.status='active'),0)::int reserved, c.rep_user_id
    from case_requirements cr join cases c on c.id=cr.case_id join facilities f on f.id=c.facility_id
    where cr.catalog_item_id=$1 and cr.active and cr.mandatory and c.status='scheduled' and c.id<>$2 and c.scheduled_start between $3 and $4`,
    [req.catalog_item_id, caseId, t.toISOString(), new Date(t.getTime() + 72 * 3600e3).toISOString()]);
  const otherAvail = (await one(db, `select coalesce(sum(greatest(a.on_hand - a.reserved,0)),0)::int n from (${AVAILABILITY_SQL}) a join stock_items s on s.id=a.stock_item_id
     where s.catalog_item_id=$1 and a.condition='sealed' and not a.on_hold and a.allocatable`, [req.catalog_item_id])).n;
  const affected = [{ caseRef: search.case.caseRef, effect: `Gains ${search.requirement.ref} ${cand.label}; estimated arrival ${fmtLocal(cand.estimatedArrival, search.case.timezone)} (${cand.meetsCutoff ? 'meets' : 'MISSES'} required-by ${fmtLocal(search.requiredBy, search.case.timezone)})` }];
  for (const o of others.filter((o) => o.reserved < o.qty)) {
    affected.push({ caseRef: o.case_ref, effect: `Also needs ${search.requirement.ref} on ${fmtLocal(o.scheduled_start, o.timezone)} with ${o.reserved}/${o.qty} reserved. After this transfer ${otherAvail - 1} unreserved eligible unit(s) remain across all locations.` });
  }
  if (loc.kind === 'trunk') {
    const repCases = await rows(db, `select c.case_ref, c.scheduled_start, f.timezone from cases c join facilities f on f.id=c.facility_id where c.rep_user_id=$1 and c.status='scheduled' and c.id<>$2 and c.scheduled_start between $3 and $4`,
      [loc.holder_user_id, caseId, t.toISOString(), new Date(t.getTime() + 72 * 3600e3).toISOString()]);
    for (const rc of repCases) if (!affected.find((a) => a.caseRef === rc.case_ref)) affected.push({ caseRef: rc.case_ref, effect: `Trunk holder has this case on ${fmtLocal(rc.scheduled_start, rc.timezone)}; it has no reservation on this unit, so it is not directly affected.` });
  }
  return { candidate: cand, affectedCases: affected, requiredBy: search.requiredBy, source: { code: loc.code, name: loc.name, kind: loc.kind } };
}

export async function nextShipmentRef(db: Db, prefix = 'SHP') {
  const r = await one(db, `select coalesce(max(substring(ref from '[0-9]+$')::int), 5000) n from shipments`);
  return `${prefix}-${r.n + 1}`;
}

/** Atomically reserve the unit and create the transfer shipment. Replays with the same key return the original. */
export async function reserveAndTransfer(db: Db, ctx: Ctx, caseId: string, requirementId: string, src: { stockItemId: string; locationId: string; ownerPartyId: string; idempotencyKey: string }) {
  requirePerm(ctx, 'rescue.reserve');
  if (!src.idempotencyKey) throw new AppError(400, 'idempotency_required', 'idempotencyKey is required');
  const prior = await maybe(db, `select * from shipments where tenant_id=$1 and idempotency_key=$2`, [ctx.tenantId, src.idempotencyKey]);
  if (prior) return { shipment: prior, replayed: true };
  const preview = await previewTransfer(db, ctx, caseId, requirementId, src);
  const c = await getVisibleCase(db, ctx, caseId);
  let reservation: any;
  try {
    ({ reservation } = await reserve(db, ctx, { caseId, requirementId, stockItemId: src.stockItemId, locationId: src.locationId, ownerPartyId: src.ownerPartyId, qty: 1, idempotencyKey: `${src.idempotencyKey}:resv` }));
  } catch (e: any) {
    if (!(e instanceof AppError) || e.status !== 409) throw e;
    // Availability is rechecked at confirmation. Tell the loser who got it and what to do next.
    const holder = await maybe(db, `select c2.case_ref, c2.scheduled_start, f2.timezone, u.display_name by_name, r.created_at from reservations r join cases c2 on c2.id=r.case_id join facilities f2 on f2.id=c2.facility_id join users u on u.id=r.created_by
       where r.stock_item_id=$1 and r.status='active' order by r.created_at desc limit 1`, [src.stockItemId]);
    const fresh = await rescueSearch(db, ctx, caseId, requirementId);
    const next = fresh.eligible.slice(0, 3).map((x: any) => ({ label: x.label, location: x.location, travelMinutes: x.travelMinutes, meetsCutoff: x.meetsCutoff, stockItemId: x.stockItemId, locationId: x.locationId, ownerPartyId: x.ownerPartyId }));
    const who = holder ? `${holder.by_name} reserved it for ${holder.case_ref} (${fmtLocal(holder.scheduled_start, holder.timezone)}) at ${fmtLocal(holder.created_at, holder.timezone)}` : 'Someone else reserved it first';
    const nextTxt = next.length ? `Next eligible: ${next[0].label} at ${next[0].location} (${next[0].travelMinutes} min, ${next[0].meetsCutoff ? 'meets' : 'MISSES'} cutoff).` : 'No other eligible unit of this exact item exists; escalate to ops.';
    throw new AppError(409, 'already_reserved', `That unit is no longer available. ${who}. ${nextTxt}`, { heldBy: holder, nextEligible: next });
  }
  const dest = await one(db, `select id from locations where facility_id=$1 and kind='hospital_receiving' limit 1`, [c.facility_id]);
  let shipment: any = null;
  if (src.locationId !== dest.id) {
    shipment = (await db.query(`insert into shipments(tenant_id, ref, case_id, from_location_id, to_location_id, kind, status, due_by, created_by, created_at, idempotency_key)
       values ($1,$2,$3,$4,$5,'rescue_transfer','planned',$6,$7,$8,$9) returning *`,
      [ctx.tenantId, await nextShipmentRef(db, 'XFR'), caseId, src.locationId, dest.id, preview.requiredBy, ctx.userId, nowIso(), src.idempotencyKey])).rows[0];
    await db.query(`insert into shipment_lines(tenant_id, shipment_id, stock_item_id, owner_party_id, reservation_id, qty_expected) values ($1,$2,$3,$4,$5,1)`,
      [ctx.tenantId, shipment.id, src.stockItemId, src.ownerPartyId, reservation.id]);
  }
  await audit(db, ctx, 'rescue.reserve_transfer', 'reservation', reservation.id, { shipment: shipment?.ref, source: preview.source, affected: preview.affectedCases }, { caseId });
  const loc = await one(db, `select * from locations where id=$1`, [src.locationId]);
  if (loc.holder_user_id && loc.holder_user_id !== ctx.userId) {
    await notify(db, ctx.tenantId, loc.holder_user_id, { kind: 'trunk_transfer', message: `${preview.candidate.label} in your trunk is reserved for case ${c.case_ref}. Transfer ${shipment?.ref} must reach ${c.facility_name} by ${fmtLocal(preview.requiredBy, c.timezone)}.`, caseId, facilityId: c.facility_id, dedupe: `xfr:${shipment?.id}` });
  }
  await notify(db, ctx.tenantId, c.rep_user_id, { kind: 'rescue', message: `Rescue transfer ${shipment?.ref ?? '(on site)'} created for ${c.case_ref}`, caseId, facilityId: c.facility_id, dedupe: `xfr-rep:${shipment?.id ?? reservation.id}` });
  return { shipment, reservation, preview, replayed: false };
}

/**
 * Exact catalog-number (or GTIN) availability for a rep. With a case that requires the item, this is
 * the full rescue ranking (cutoff, travel, evidence, cost). Without one, it lists every unit of that
 * exact item with usable quantity, custodian, physical-evidence freshness and why it is or is not usable.
 */
export async function exactItemAvailability(db: Db, ctx: Ctx, input: { q: string; caseId?: string | null; catalogItemId?: string | null }) {
  requirePerm(ctx, 'rescue.search');
  const q = String(input.q ?? '').trim();
  if (!q && !input.catalogItemId) throw new AppError(400, 'query_required', 'Enter an exact catalog number or GTIN');
  const matches = await rows(db, `select x.*, p.name manufacturer, x.pkg_units from (
       select ci.*, null::int pkg_units from catalog_items ci where ($2::uuid is not null and ci.id=$2) or ($2::uuid is null and (lower(ci.ref)=lower($1) or ci.unit_gtin=$1))
       union select ci.*, pk.units_per_package from packages pk join catalog_items ci on ci.id=pk.catalog_item_id where $2::uuid is null and pk.gtin=$1) x
     left join parties p on p.id=x.manufacturer_party_id`, [q, input.catalogItemId ?? null]);
  if (!matches.length) return { mode: 'none', message: `No catalog item matches "${q}" exactly. Search by exact catalog number or GTIN; substitutes are never suggested.` };
  if (matches.length > 1) {
    // Same catalog number from different manufacturers: never pick one silently.
    return { mode: 'ambiguous', message: `"${q}" matches ${matches.length} catalog items. Choose the manufacturer.`,
      choices: matches.map((m) => ({ catalogItemId: m.id, ref: m.ref, manufacturer: m.manufacturer, description: m.description, unitGtin: m.unit_gtin })) };
  }
  const item = matches[0];
  if (input.caseId) {
    const c = await getVisibleCase(db, ctx, input.caseId);
    const req = await maybe(db, `select id from case_requirements where case_id=$1 and catalog_item_id=$2 and active`, [c.id, item.id]);
    if (req) return { mode: 'case', item, ...(await rescueSearch(db, ctx, c.id, req.id)) };
  }
  const t = now();
  const bals = await rows(db, `select a.*, s.serial_number, s.lot_number, s.expiry_date, p.name owner_name, p.kind owner_kind, hu.display_name holder_name, fac.name loc_facility_name,
      (select h.reason from quality_holds h where h.stock_item_id=a.stock_item_id and h.status='active' limit 1) hold_reason,
      (select string_agg(c2.case_ref, ', ') from reservations r join cases c2 on c2.id=r.case_id where r.stock_item_id=a.stock_item_id and r.location_id=a.location_id and r.status='active') reserved_for
    from (${AVAILABILITY_SQL}) a join stock_items s on s.id=a.stock_item_id join parties p on p.id=a.owner_party_id
    left join users hu on hu.id=a.holder_user_id left join facilities fac on fac.id=a.location_facility_id
    where s.catalog_item_id=$1 and a.location_kind not in ('consumed','wasted','missing') order by a.location_code`, [item.id]);
  const out: any[] = [];
  for (const b of bals) {
    const ver = await lastVerification(db, b.stock_item_id, b.location_id);
    const usable = b.on_hold || b.condition !== 'sealed' || !b.allocatable || (b.expiry_date && b.expiry_date < localDate(t, 'America/Chicago')) ? 0 : Math.max(0, b.on_hand - b.reserved);
    const why: string[] = [];
    if (b.on_hold) why.push(`On quality hold: ${b.hold_reason}`);
    if (b.condition !== 'sealed') why.push(`Condition ${b.condition}`);
    if (!b.allocatable) why.push(`${b.location_kind.replace('_', ' ')} stock is not allocatable`);
    if (b.expiry_date && b.expiry_date < localDate(t, 'America/Chicago')) why.push(`Expired ${b.expiry_date}`);
    if (b.reserved_for) why.push(`Reserved for ${b.reserved_for}`);
    out.push({ stockItemId: b.stock_item_id, label: b.serial_number ? `SN ${b.serial_number}` : `lot ${b.lot_number}`, lot: b.lot_number, expiry: b.expiry_date, location: b.location_name, locationKind: b.location_kind,
      custodian: b.holder_name ?? b.loc_facility_name ?? 'Distributor warehouse', owner: b.owner_name, onHand: b.on_hand, reserved: b.reserved, usable, whyNot: why,
      evidence: evidenceTier(ver?.kind ?? null, ver?.at ?? null, t.getTime()), lastVerifiedAt: ver?.at ?? null });
  }
  out.sort((a, b) => b.usable - a.usable || String(a.location).localeCompare(String(b.location)));
  return { mode: 'stock', item, rows: out, usableTotal: out.reduce((a, r) => a + r.usable, 0), note: 'Pick one of your cases to see arrival estimates against that facility\'s cutoff.' };
}
