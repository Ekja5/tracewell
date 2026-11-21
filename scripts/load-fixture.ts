/**
 * Isolated, reproducible load fixture + benchmark. Builds a large synthetic tenant in LOAD_DATABASE_URL
 * (default tracewell_load) with deterministic generate_series data, then times the three hot paths:
 * readiness board (72 h), exact-item search, and lot recall trace. Prints a markdown report.
 *
 *   npx tsx scripts/load-fixture.ts            # build + measure
 *   SKIP_BUILD=1 npx tsx scripts/load-fixture.ts  # measure only
 */
process.env.DATABASE_URL = process.env.LOAD_DATABASE_URL ?? 'postgres://orthoapp:orthoapp_local_only@127.0.0.1:5433/tracewell_load';
process.env.ACCESS_LOG = 'off';
const { execFileSync } = await import('node:child_process');
const os = await import('node:os');
const admin = (process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/postgres');
const { pool, withTenant, q } = await import('../src/server/db.js');
const { resetDb } = await import('../src/server/seed/seed.js');
const { setClock } = await import('../src/server/clock.js');
const { readinessBoard } = await import('../src/server/domain/cases.js');
const { exactItemAvailability, rescueSearch } = await import('../src/server/domain/rescue.js');
const { recallMatches } = await import('../src/server/domain/recall.js');

const SIZE = { hospitals: 30, reps: 60, warehouses: 4, items: 400, unitsPerSerialItem: 150, lotsPerLotItem: 10, upcomingCases: Number(process.env.LOAD_CASES ?? 600), historicalUsed: 5000 };
const ANCHOR = new Date('2027-06-01T21:00:00Z'); // 4 p.m. Central

if (!process.env.SKIP_BUILD) {
  try { execFileSync('psql', [admin, '-qc', 'create database tracewell_load owner orthoapp']); } catch { /* exists */ }
  await resetDb();
  await setClock(new Date(ANCHOR.getTime() - 40 * 864e5));
  const [t] = await q(`insert into tenants(slug,name) values ('loadtest','Load Test Distributor (synthetic)') returning id`);
  await withTenant(t.id, async (db) => {
    const T = t.id;
    const x = (sql: string, p: any[] = []) => db.query(sql, [T, ...p]);
    await x(`insert into parties(tenant_id,name,kind) values ($1::uuid,'LoadDist','distributor'),($1::uuid,'LoadMfr','manufacturer')`);
    await x(`insert into territories(tenant_id,name) values ($1::uuid,'All')`);
    await x(`insert into facilities(tenant_id,code,name,kind,timezone) select $1::uuid,'H'||g,'Hospital '||g||' (synthetic)','hospital', (array['America/Chicago','America/New_York','America/Denver','America/Los_Angeles'])[1+g%4] from generate_series(1,$2) g`, [SIZE.hospitals]);
    await x(`insert into facilities(tenant_id,code,name,kind,timezone) values ($1::uuid,'WHF','Warehouses','warehouse','America/Chicago')`);
    await x(`insert into facility_policies(tenant_id,facility_id,version,tray_due_hours_before,implant_due_hours_before,required_evidence,effective_from,approved_by,receiving_open,receiving_close)
             select $1::uuid,id,1,12+(row_number() over ())%3*6,2+(row_number() over ())%4,'{spd_ref}','2026-01-01','synthetic','06:00','19:00' from facilities where kind='hospital'`);
    await x(`insert into users(tenant_id,email,display_name,password_hash,role,territory_id) select $1::uuid,'rep'||g||'@load.example','Load rep '||g,'x','rep',(select id from territories limit 1) from generate_series(1,$2) g`, [SIZE.reps]);
    await x(`insert into users(tenant_id,email,display_name,password_hash,role) values ($1::uuid,'ops@load.example','Load ops','x','ops_manager'),($1::uuid,'wh@load.example','Load wh','x','warehouse'),($1::uuid,'qa@load.example','Load qa','x','quality_manager')`);
    await x(`insert into locations(tenant_id,code,name,kind,facility_id,allocatable) select $1::uuid,f.code||'-RCV',f.name||' receiving','hospital_receiving',f.id,true from facilities f where kind='hospital'`);
    await x(`insert into locations(tenant_id,code,name,kind,facility_id,allocatable) select $1::uuid,'WH'||g,'Warehouse '||g,'warehouse',(select id from facilities where code='WHF'),true from generate_series(1,$2) g`, [SIZE.warehouses]);
    await x(`insert into locations(tenant_id,code,name,kind,holder_user_id,allocatable) select $1::uuid,'TR-'||u.email,'Trunk '||u.display_name,'trunk',u.id,true from users u where u.role='rep'`);
    await x(`insert into locations(tenant_id,code,name,kind,allocatable) values ($1::uuid,'TRANSIT','In transit','in_transit',false),($1::uuid,'USED','Consumed','consumed',false),($1::uuid,'Q','Quarantine','quarantine',false),($1::uuid,'WASTE','Wasted','wasted',false),($1::uuid,'MISS','Missing','missing',false),($1::uuid,'RET','Returns','returns',false)`);
    await x(`insert into travel_estimates(tenant_id,from_location_id,to_facility_id,minutes,courier_cost_cents) select $1::uuid,l.id,f.id,20+abs(hashtext(l.code||f.code))%400,1000+abs(hashtext(f.code||l.code))%9000 from locations l cross join facilities f where l.kind in ('warehouse','trunk') and f.kind='hospital'`);
    await x(`insert into catalog_items(tenant_id,manufacturer_party_id,ref,description,item_type,tracking,unit_gtin)
             select $1::uuid,(select id from parties where kind='manufacturer'),'LD-'||lpad(g::text,4,'0'),'Load item '||g, case when g<=20 then 'tray' else 'implant' end, case when g between 21 and 100 then 'lot' else 'serial' end, null from generate_series(1,$2) g`, [SIZE.items]);
    // Serialized units (lot shared by 25 units so recalls hit many units) and lot quantities.
    await x(`insert into stock_items(tenant_id,catalog_item_id,lot_number,serial_number,expiry_date,is_serial,data_source)
             select $1::uuid,ci.id,'L'||ci.ref||'-'||(g/25),ci.ref||'-S'||g, date '2028-01-01' + (g%300), true,'seed' from catalog_items ci cross join generate_series(1,$2) g where ci.tracking='serial'`, [SIZE.unitsPerSerialItem]);
    await x(`insert into stock_items(tenant_id,catalog_item_id,lot_number,serial_number,expiry_date,is_serial,data_source)
             select $1::uuid,ci.id,'LOT'||ci.ref||'-'||g,null,date '2028-06-01',false,'seed' from catalog_items ci cross join generate_series(1,$2) g where ci.tracking='lot'`, [SIZE.lotsPerLotItem]);
    const ops = (await db.query(`select id from users where role='ops_manager'`)).rows[0].id;
    // Opening movements + balances spread across warehouses and trunks (consistent ledger).
    await x(`with src as (
        select s.id sid, case when s.is_serial then 1 else 40 end qty,
          (select id from locations l where l.kind in ('warehouse','trunk') order by l.code offset (abs(hashtext(s.id::text)) % ($2::int + $3::int)) limit 1) loc
        from stock_items s),
      mv as (insert into inventory_movements(tenant_id,stock_item_id,qty,owner_party_id,to_location_id,to_condition,movement_type,reason,actor_user_id,occurred_at,recorded_at)
        select $1::uuid,sid,qty,(select id from parties where kind='distributor'),loc,'sealed','opening_balance','load fixture',$4,now()-interval '40 days',now()-interval '40 days' from src returning id, stock_item_id, qty, to_location_id)
      insert into stock_balances(tenant_id,stock_item_id,location_id,owner_party_id,condition,qty,last_movement_id) select $1::uuid,stock_item_id,to_location_id,(select id from parties where kind='distributor'),'sealed',qty,id from mv`, [SIZE.warehouses, SIZE.reps, ops]);
    // Historical consumption (moved to CONSUMED, with usage events) for recall-trace depth.
    await x(`insert into cases(tenant_id,case_ref,facility_id,procedure,surgeon_ref,scheduled_start,status,rep_user_id,completed_at)
             select $1::uuid,'HIST-'||g,(select id from facilities where kind='hospital' order by code offset g%$2 limit 1),'Hist','S-'||g%50,now()-((g%30)+1)*interval '1 day','completed',(select id from users where role='rep' order by email offset g%$3 limit 1),now()-((g%30)+1)*interval '1 day' from generate_series(1,1000) g`, [SIZE.hospitals, SIZE.reps]);
    await x(`with pick as (select s.id sid, b.location_id loc, row_number() over () rn from stock_items s join stock_balances b on b.stock_item_id=s.id where s.is_serial and b.qty=1 order by s.id limit $2),
      mv as (insert into inventory_movements(tenant_id,stock_item_id,qty,owner_party_id,from_location_id,from_condition,to_location_id,to_condition,movement_type,reason,actor_user_id,occurred_at,recorded_at)
        select $1::uuid,sid,1,(select id from parties where kind='distributor'),loc,'sealed',(select id from locations where kind='consumed'),'used','consume','hist',$3,now()-interval '5 days',now()-interval '5 days' from pick returning stock_item_id)
      update stock_balances b set location_id=(select id from locations where kind='consumed'), condition='used' from mv where b.stock_item_id=mv.stock_item_id`, [SIZE.historicalUsed, ops]);
    await x(`insert into usage_events(tenant_id,case_id,client_event_id,catalog_item_id,stock_item_id,disposition,qty_units,entry_method,status,actor_user_id,occurred_at,recorded_at)
             select $1::uuid,c.id,'hist-'||x.sid,x.catalog_item_id,x.sid,'implanted',1,'scanner','recorded',$2,now()-interval '5 days',now()-interval '5 days'
             from (select s.id sid, s.catalog_item_id, row_number() over (order by s.id) rn from stock_items s join stock_balances b on b.stock_item_id=s.id join locations l on l.id=b.location_id where l.kind='consumed') x
             join cases c on c.case_ref='HIST-'||(1+x.rn%1000)`, [ops]);
    // Upcoming cases in the 72 h window, 5 requirements each, ~70% reserved from warehouses/trunks.
    await x(`insert into cases(tenant_id,case_ref,facility_id,procedure,surgeon_ref,scheduled_start,status,rep_user_id)
             select $1::uuid,'LD-'||g,(select id from facilities where kind='hospital' order by code offset g%$2 limit 1),'Load case','S-'||g%50,$4::timestamptz + (g%70)*interval '1 hour' + interval '2 hours','scheduled',(select id from users where role='rep' order by email offset g%$3 limit 1) from generate_series(1,$5) g`,
      [SIZE.hospitals, SIZE.reps, new Date(ANCHOR.getTime() - 40 * 864e5 + 40 * 864e5).toISOString(), SIZE.upcomingCases]);
    await x(`insert into case_requirements(tenant_id,case_id,catalog_item_id,qty,mandatory)
             select $1::uuid,c.id,(select id from catalog_items order by ref offset ((abs(hashtext(c.case_ref||k)) % 380) + 20) limit 1),1,true from cases c cross join generate_series(1,4) k where c.status='scheduled'
             union all select $1::uuid,c.id,(select id from catalog_items where item_type='tray' order by ref offset abs(hashtext(c.case_ref))%20 limit 1),1,true from cases c where c.status='scheduled'`);
    await x(`with req as (select cr.id rid, cr.case_id, cr.catalog_item_id, row_number() over (partition by cr.catalog_item_id order by cr.id) rn from case_requirements cr where abs(hashtext(cr.id::text))%10 < 7),
      units as (select s.id sid, s.catalog_item_id, b.location_id, b.owner_party_id, row_number() over (partition by s.catalog_item_id order by s.id) rn
        from stock_items s join stock_balances b on b.stock_item_id=s.id join locations l on l.id=b.location_id where l.kind in ('warehouse','trunk') and s.is_serial)
      insert into reservations(tenant_id,case_id,requirement_id,stock_item_id,location_id,owner_party_id,qty,is_serial,status,created_by,created_at)
      select $1::uuid,req.case_id,req.rid,u.sid,u.location_id,u.owner_party_id,1,true,'active',$2,now() from req join units u on u.catalog_item_id=req.catalog_item_id and u.rn=req.rn`, [ops]);
    await db.query(`analyze`);
  });
  console.error('[load] fixture built');
}

await setClock(ANCHOR);
const [t] = await q(`select id from tenants where slug='loadtest'`);
const counts = await withTenant(t.id, async (db) => (await db.query(`select (select count(*) from stock_items) stock_items, (select count(*) from inventory_movements) movements, (select count(*) from stock_balances) balances,
  (select count(*) from cases) cases, (select count(*) from cases where status='scheduled') upcoming, (select count(*) from case_requirements) requirements, (select count(*) from reservations) reservations,
  (select count(*) from usage_events) usage_events, (select count(*) from facilities where kind='hospital') hospitals, (select count(*) from locations) locations`)).rows[0]);
const opsU = (await q(`select * from users where tenant_id=$1 and role='ops_manager'`, [t.id]))[0];
const repU = (await q(`select * from users where tenant_id=$1 and role='rep' order by email limit 1`, [t.id]))[0];
const qaU = (await q(`select * from users where tenant_id=$1 and role='quality_manager'`, [t.id]))[0];
const mk = (u: any) => ({ userId: u.id, tenantId: t.id, role: u.role, facilityId: null, territoryId: u.territory_id, displayName: u.display_name });

async function time(label: string, n: number, fn: () => Promise<any>) {
  const xs: number[] = []; let last: any;
  for (let i = 0; i < n; i++) { const s = performance.now(); last = await fn(); xs.push(performance.now() - s); }
  xs.sort((a, b) => a - b);
  return { label, runs: n, medianMs: Math.round(xs[Math.floor(n / 2)]), maxMs: Math.round(xs[n - 1]), firstMs: Math.round(xs[0]), last };
}
const ref = (await withTenant(t.id, async (db) => (await db.query(`select ci.ref from catalog_items ci where tracking='serial' and item_type='implant' order by ref limit 1`)).rows[0].ref));
const someCase = await withTenant(t.id, async (db) => (await db.query(`select cr.case_id, cr.id from case_requirements cr join catalog_items ci on ci.id=cr.catalog_item_id where ci.ref=$1 limit 1`, [ref])).rows[0]);
const lot = await withTenant(t.id, async (db) => (await db.query(`select s.catalog_item_id, s.lot_number from stock_items s where s.is_serial group by 1,2 order by count(*) desc limit 1`)).rows[0]);

const results = [];
results.push(await time('Readiness board, 72 h, ops manager (first load creates issues)', 1, () => withTenant(t.id, (db) => readinessBoard(db, mk(opsU) as any, 72))));
results.push(await time('Readiness board, 72 h, ops manager (steady state)', 3, () => withTenant(t.id, (db) => readinessBoard(db, mk(opsU) as any, 72))));
results.push(await time(`Exact-item search "${ref}" (no case)`, 5, () => withTenant(t.id, (db) => exactItemAvailability(db, mk(repU) as any, { q: ref }))));
if (someCase) results.push(await time(`Exact-item rescue ranking for a case requirement`, 5, () => withTenant(t.id, (db) => rescueSearch(db, mk(opsU) as any, someCase.case_id, someCase.id))));
const rid = await withTenant(t.id, async (db) => (await db.query(`insert into recalls(tenant_id,ref,manufacturer_party_id,catalog_item_id,scope_type,scope_values,manufacturer_notice_ref,description,status,entered_by,entered_at)
   values ($1::uuid,'RCL-LOAD-'||floor(random()*1e6),(select id from parties where kind='manufacturer'),$2,'lot',$3,'n','load','draft',$4,now()) returning id`, [t.id, lot.catalog_item_id, [lot.lot_number], qaU.id])).rows[0].id);
results.push(await time(`Lot recall trace (${lot.lot_number})`, 5, () => withTenant(t.id, (db) => recallMatches(db, rid))));
await withTenant(t.id, async (db) => db.query(`delete from recalls where id=$1`, [rid]));

const board = results[0].last;
console.log(`## Load measurement (${new Date().toISOString()})\n`);
console.log(`Environment: ${os.cpus().length} vCPU (${os.cpus()[0]?.model ?? 'unknown'}), ${Math.round(os.totalmem() / 1e9)} GB RAM, Node ${process.version}, PostgreSQL 16 local, single process, no network hop (domain functions called directly inside one transaction per call; HTTP overhead excluded).\n`);
console.log(`Dataset: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')}. Board window held ${board.cases.length} cases.\n`);
console.log(`| Operation | Runs | Median ms | Max ms |\n|---|---|---|---|`);
for (const r of results) console.log(`| ${r.label} | ${r.runs} | ${r.medianMs} | ${r.maxMs} |`);
await pool.end();
