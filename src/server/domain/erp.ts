import { createHash } from 'node:crypto';
import { AppError, Db, maybe, one, rows, withTenant, q } from '../db.js';
import { now, nowIso } from '../clock.js';
import { audit, raiseException } from '../audit.js';

/**
 * Mock ERP adapter (SIMULATED). It stands in for a future SAP / Salesforce / procurement adapter
 * so the outbox, retry, acknowledgment and exception paths can be exercised. It never reports
 * payment. Live connections are disabled until credentials, data mappings, permissions and
 * acceptance criteria exist (see docs/integrations.md).
 */
export const MAX_ATTEMPTS = 5;

function mockErpReceive(payload: any) {
  const doc = 'SIM-ERP-' + createHash('sha256').update(String(payload.packet_id)).digest('hex').slice(0, 10).toUpperCase();
  return { accepted: true, external_doc_ref: doc, message: 'Simulated ERP stored the draft billing document. Not an invoice, not payment.' };
}

export async function processOutboxForTenant(tenantId: string) {
  return withTenant(tenantId, async (db) => {
    const due = await rows(db, `select * from outbox where status in ('pending','failed') and next_attempt_at <= $1 order by created_at limit 20 for update skip locked`, [nowIso()]);
    const feed = await maybe(db, `select * from integration_feeds where code='erp-mock' for update`);
    let delivered = 0;
    for (const o of due) {
      const attempt = o.attempts + 1;
      const failNow = feed && feed.mock_fail_next > 0;
      if (failNow) {
        await db.query(`update integration_feeds set mock_fail_next=mock_fail_next-1, last_attempt_at=$1, last_error=$2 where id=$3`, [nowIso(), 'Simulated timeout from mock ERP', feed.id]);
        feed.mock_fail_next--;
        const dead = attempt >= MAX_ATTEMPTS;
        const backoff = Math.min(60, 2 ** attempt) * 1000;
        await db.query(`update outbox set attempts=$2, status=$3, last_error=$4, next_attempt_at=$5 where id=$1`, [o.id, attempt, dead ? 'dead' : 'failed', 'Simulated timeout', new Date(now().getTime() + backoff).toISOString()]);
        await db.query(`insert into outbox_attempts(tenant_id, outbox_id, attempted_at, result, detail) values ($1,$2,$3,'error',$4)`, [tenantId, o.id, nowIso(), { error: 'Simulated timeout', attempt }]);
        if (dead) await raiseException(db, tenantId, { kind: 'erp_delivery_failed', severity: 'critical', title: `ERP delivery failed after ${attempt} attempts`, detail: `${o.topic} for ${o.payload.case_ref ?? o.aggregate_id}`, refTable: 'outbox', refId: o.id, ownerRole: 'finance', dedupe: `outbox:${o.id}` });
        continue;
      }
      const resp = mockErpReceive(o.payload);
      await db.query(`insert into outbox_attempts(tenant_id, outbox_id, attempted_at, result, detail) values ($1,$2,$3,'delivered',$4)`, [tenantId, o.id, nowIso(), resp]);
      await db.query(`update outbox set attempts=$2, status='delivered', last_error=null where id=$1`, [o.id, attempt]);
      await ingestAck(db, tenantId, { outboxId: o.id, externalDocRef: resp.external_doc_ref, ackType: 'received', payload: resp });
      delivered++;
    }
    if (feed && delivered) await db.query(`update integration_feeds set last_success_at=$1, last_attempt_at=$1, last_error=null where id=$2`, [nowIso(), feed.id]);
    return { processed: due.length, delivered };
  });
}

/** Acknowledgments are idempotent: a replayed ack is stored once and changes nothing else. */
export async function ingestAck(db: Db, tenantId: string, a: { outboxId: string; externalDocRef: string; ackType: string; payload: any }) {
  const o = await one(db, `select * from outbox where id=$1`, [a.outboxId]);
  const ins = await db.query(`insert into erp_acks(tenant_id, outbox_id, external_doc_ref, ack_type, payload, received_at) values ($1,$2,$3,$4,$5,$6) on conflict (tenant_id, external_doc_ref, ack_type) do nothing returning id`,
    [tenantId, a.outboxId, a.externalDocRef, a.ackType, a.payload, nowIso()]);
  if (!ins.rowCount) return { duplicate: true };
  await db.query(`update outbox set status='acknowledged' where id=$1`, [a.outboxId]);
  if (o.topic === 'billing_packet.created') {
    await db.query(`update billing_packets set status='erp_received_simulated' where id=$1 and status='queued_to_erp'`, [o.aggregate_id]);
  }
  await audit(db, { tenantId, userId: null }, 'erp.ack', 'outbox', a.outboxId, { external_doc_ref: a.externalDocRef, ack_type: a.ackType, simulated: true });
  return { duplicate: false };
}

export async function integrationStatus(db: Db) {
  const feeds = await rows(db, `select f.*, (select count(*)::int from sync_differences d where d.feed_id=f.id and d.status='open') open_differences from integration_feeds f order by f.code`);
  const outbox = await rows(db, `select o.id, o.topic, o.status, o.attempts, o.last_error, o.next_attempt_at, o.created_at, o.payload->>'case_ref' case_ref,
     (select json_agg(json_build_object('at', a.attempted_at, 'result', a.result, 'detail', a.detail) order by a.attempted_at) from outbox_attempts a where a.outbox_id=o.id) attempts_log,
     (select json_agg(json_build_object('ref', k.external_doc_ref, 'type', k.ack_type, 'at', k.received_at)) from erp_acks k where k.outbox_id=o.id) acks
     from outbox o order by o.created_at desc limit 50`);
  const differences = await rows(db, `select d.*, f.name feed from sync_differences d join integration_feeds f on f.id=d.feed_id where d.status='open' order by d.created_at desc`);
  return { feeds, outbox, differences, liveIntegrationsEnabled: false };
}

export async function runSimulatedScheduleSync(db: Db, ctx: { tenantId: string; userId: string }, feedId: string) {
  const f = await one(db, `select * from integration_feeds where id=$1`, [feedId]);
  if (!f.simulated) throw new AppError(409, 'live_disabled', 'Live integrations are disabled in the pilot');
  if (f.code === 'erp-mock') throw new AppError(400, 'wrong_feed', 'ERP mock syncs through the outbox worker');
  await db.query(`update integration_feeds set last_success_at=$1, last_attempt_at=$1, last_error=null where id=$2`, [nowIso(), feedId]);
  await audit(db, ctx, 'integration.simulated_sync', 'integration_feed', feedId, { code: f.code });
  return { ok: true };
}

export async function tenantIds(): Promise<string[]> {
  return (await q<{ id: string }>(`select id from tenants order by created_at`)).map((r) => r.id);
}
