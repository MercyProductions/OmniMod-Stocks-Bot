import { summarizeSharedPaperPortfolio } from '../operatorReport.js';
import { buildOptionDayTradeCandidate } from '../../options/src/strategies.js';
import { fixture as optionFixture, fillQuote } from '../../options/test/helpers/optionFillFixture.js';
import { coinbaseBookEvidence, cryptoRulesFixture } from '../fixtures/cryptoBookEvidence.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { evaluatePaperCandidate, reservePaperCandidate, processPaperQuote, readPaperRiskLedger, summarizePaperLedger } from '../paperRisk.js';
import { stockQuote, withStockCandidateEvidence } from '../fixtures/stockQuoteEvidence.js';

const NOW = Date.parse('2026-10-02T15:00:00Z');
const iso = at => new Date(at).toISOString();
const candidate = (symbol = 'AAA', overrides = {}) => withStockCandidateEvidence({ mode: 'paper', owner: 'etfs-etps', assetClass: 'etf',
  instrumentKey: symbol, exposureKey: symbol, idempotencyKey: `${symbol}:fill-risk`, strategyId: 'fill-risk-fixture',
  sessionDate: '2026-10-02', direction: 'long', bid: 100, ask: 100.01, entryPrice: 100.01, stopPrice: 99, targetPrice: 103,
  quoteTime: iso(NOW), quoteQuality: 'executable', sessionOpen: true, forceExitAt: iso(NOW + 3600000),
  multiplier: 1, lotSize: 1, roundTripFeesPerUnit: 0.02, slippageReservePerUnit: 0.03, ...overrides });
const policy = { now: NOW, maxSpreadPct: 0.2, maxTradeRiskPct: 0.25, maxTotalOpenRiskPct: 1,
  maxGrossExposurePct: 200, maxDailyLossPct: 1, maxOpenPositions: 5, maxOpenMarkAgeMs: 300000 };
const quote = (symbol = 'AAA', at = NOW + 1000, prices = {}) => stockQuote(symbol, { bid: 100, ask: 100.01, time: iso(at), quality: 'executable', ...prices });
const closed = (loss = -101, fields = {}) => ({ orderId: 'other-closed', idempotencyKey: 'other-closed', owner: 'stocks', assetClass: 'stock', instrumentKey: 'LOSS', exposureKey: 'LOSS',
  status: 'closed', closedAt: iso(NOW + 500), realizedPnlUsd: loss, grossPnlUsd: loss + 1, feesUsd: 0.5, slippageUsd: 0.5, ...fields });
async function fixture(t, overrides = {}, proposal = candidate()) {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-fill-risk-'));
  t.after(async () => { const rel = relative(tmpdir(), directory); assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..')); await rm(directory, { recursive: true, force: true }); });
  const statePath = join(directory, 'ledger.json');
  const decision = evaluatePaperCandidate(proposal, { accountEquity: 10000, openPositions: [], realizedPnlToday: 0 }, { ...policy, ...overrides });
  assert.equal(decision.status, 'paper-approved', JSON.stringify(decision.reasons));
  const reserved = await reservePaperCandidate(proposal, decision, { statePath, now: overrides.now ?? NOW, emergencyStop: false });
  assert.equal(reserved.status, 'reserved');
  const read = () => readPaperRiskLedger({ statePath });
  const edit = async fn => { const ledger = await read(); fn(ledger); await writeFile(statePath, JSON.stringify(ledger)); };
  return { directory, statePath, order: reserved.order, read, edit,
    fill: (options = {}, q = quote(proposal.instrumentKey)) => processPaperQuote(reserved.order.orderId, q, { statePath, now: NOW + 1000, emergencyStop: false, ...options }) };
}

test('a loss recorded after reservation blocks the later fill', async t => {
  const f = await fixture(t); await f.edit(l => l.orders.push(closed()));
  const result = await f.fill();
  assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'daily_loss_limit_at_fill');
  assert.equal((await f.read()).orders[0].filledAt, undefined);
});
test('an intervening stale open mark blocks a pending fill', async t => {
  const f = await fixture(t);
  await f.edit(l => l.orders.push({ ...l.orders[0], orderId: 'other', idempotencyKey: 'other', instrumentKey: 'BBB', exposureKey: 'BBB', exposureKeys: ['BBB'],
    status: 'filled', fillPrice: 100.01, filledAt: iso(NOW - 400000), markedAt: iso(NOW - 400000), markPrice: 100, unrealizedPnlUsd: -1 }));
  const result = await f.fill();
  assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'open_position_mark_stale_or_unavailable_at_fill');
});
test('new competing reservations cannot bypass the older saved combined-risk ceiling', async t => {
  const f = await fixture(t, { maxTotalOpenRiskPct: 0.25 });
  const other = candidate('BBB'); const d = evaluatePaperCandidate(other, { accountEquity: 10000 }, policy);
  assert.equal((await reservePaperCandidate(other, d, { statePath: f.statePath, now: NOW, emergencyStop: false })).status, 'reserved');
  const result = await f.fill();
  assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'combined_open_risk_limit_at_fill');
});
test('old pending records cannot invent missing fill-risk policy but can still cancel', async t => {
  const f = await fixture(t); await f.edit(l => { delete l.orders[0].entryRiskPolicy; });
  assert.equal((await f.fill()).reason, 'entry_risk_policy_unavailable');
  assert.equal((await f.fill({ emergencyStop: true }, null)).status, 'cancelled');
});

test('a valid fill counts its reservation once and persists the exact risk check', async t => {
  const f = await fixture(t, { maxOpenPositions: 1, maxTotalOpenRiskPct: 0.25 });
  const result = await f.fill(); assert.equal(result.status, 'filled');
  assert.equal(result.order.fillRiskEvidence.activeOrdersIncludingReservation, 1);
  assert.equal(result.order.fillRiskEvidence.combinedRiskUsd, f.order.riskUsd);
  assert.deepEqual((await f.read()).events.find(e => e.type === 'filled').fillRisk, result.order.fillRiskEvidence);
  assert.equal(result.order.entryRiskPolicy.maxDailyLossUsd, 100);
});
test('the new spread and modeled costs cannot themselves breach the loss ceiling', async t => {
  const f = await fixture(t); await f.edit(l => l.orders.push(closed(-99)));
  const result = await f.fill(); assert.equal(result.reason, 'daily_loss_limit_at_fill');
  assert.ok(result.fillRisk.entryLiquidationPnlUsd < -1);
  assert.equal(result.fillRisk.realizedPnlRiskDayUtcUsd, -99);
});
test('current open losses and malformed open P&L are rechecked without preventing exits', async t => {
  const f = await fixture(t); const b = candidate('BBB');
  const d = evaluatePaperCandidate(b, { accountEquity: 10000 }, policy);
  const r = await reservePaperCandidate(b,d,{statePath:f.statePath,now:NOW,emergencyStop:false});
  const mark = q => processPaperQuote(r.order.orderId,q,{statePath:f.statePath,now:NOW+500,emergencyStop:false});
  assert.equal((await mark(quote('BBB',NOW+500))).status,'filled');
  for (const value of [-100, null]) {
    await f.edit(l => { l.orders.find(o=>o.orderId===r.order.orderId).unrealizedPnlUsd=value; });
    assert.equal((await f.fill()).reason,value===null?'open_position_pnl_unavailable_at_fill':'daily_loss_limit_at_fill');
  }
  const exit = await processPaperQuote(r.order.orderId,quote('BBB',NOW+1000,{bid:98,ask:98.01}),{statePath:f.statePath,now:NOW+1000,emergencyStop:false});
  assert.equal(exit.status,'closed'); assert.equal(exit.order.exitReason,'stop');
});
for (const [settings, reason] of [[{maxConsecutiveLosses:1},'consecutive_loss_limit_at_fill'],[{maxClosedDrawdownPct:0.5},'maximum_closed_drawdown_limit_at_fill']])
  test(`fill applies the configured ${reason}`, async t=>{
    const f=await fixture(t,settings);await f.edit(l=>l.orders.push(closed(-60,{closedAt:iso(NOW-86400000)})));
    assert.equal((await f.fill()).reason,reason);
  });
test('unknown current-day accounting or risk date cannot be hidden at fill',async t=>{
  const f=await fixture(t);const original=await f.read();
  for(const [fields,reason] of [[{realizedPnlUsd:null},'closed_trade_realized_pnl_unknown_at_fill'],[{closedAt:null},'closed_trade_risk_day_unknown_at_fill'],[{feesUsd:null},'closed_trade_cost_accounting_unavailable_at_fill']]){
    await writeFile(f.statePath,JSON.stringify({...original,orders:[...original.orders,closed(-10,fields)]}));
    assert.equal((await f.fill()).reason,reason);
  }
});
test('fill failures are stored once per reason transition and retry can fill after risk recovers',async t=>{
  const f=await fixture(t);await f.edit(l=>l.orders.push(closed()));
  await f.fill();await f.fill();let ledger=await f.read();
  assert.equal(ledger.events.filter(e=>e.type==='fill_risk_blocked').length,1);
  assert.equal(ledger.orders[0].lastFillRiskCheck.reason,'daily_loss_limit_at_fill');
  await f.edit(l=>l.orders.push(closed(120,{orderId:'later-win',idempotencyKey:'later-win',closedAt:iso(NOW+750)})));
  assert.equal((await f.fill()).status,'filled');
});
for(const [owner,assetClass] of [['stocks','stock'],['crypto','crypto'],['forex','forex'],['futures','future'],['options','option'],['etfs-etps','etp']])
  test(`${owner} cannot fill after another bot records a loss`,async t=>{
    const identity={version:1,namespace:'coingecko',assetId:'bitcoin',provider:'Coinbase',pair:'BTC-USD',base:'BTC',quoteCurrency:'USD',verificationSource:'coingecko_tickers_complete',verifiedAt:iso(NOW)};
    const cryptoFields={cryptoIdentity:identity,lotSize:0.00000001,cryptoInstrumentRules:cryptoRulesFixture({time:NOW}),cryptoQuoteEvidence:coinbaseBookEvidence({bid:100,ask:100.01,time:NOW})};
    const proposal=owner==='options'?buildOptionDayTradeCandidate(optionFixture()).candidate:candidate(owner==='crypto'?'BTC':'AAA',{
      owner,assetClass,...(owner==='crypto'?cryptoFields:{}),...(owner==='futures'?{initialMarginUsd:100,maintenanceMarginUsd:80}:{})});
    const f=await fixture(t,{maxTradeRiskPct:owner==='options'?2:0.25,maxTotalOpenRiskPct:10,maxSpreadPct:25},proposal);
    await f.edit(l=>l.orders.push(closed()));
    const q=owner==='options'?fillQuote(optionFixture()):quote(proposal.instrumentKey);
    if(owner==='crypto')Object.assign(q,cryptoFields,{cryptoInstrumentRules:cryptoRulesFixture({time:NOW+1000}),cryptoQuoteEvidence:coinbaseBookEvidence({bid:100,ask:100.01,time:NOW+1000})});
    assert.equal((await f.fill({maxSpreadPct:25},q)).reason,'daily_loss_limit_at_fill');
  });
test('a restarted execution rechecks current UTC loss day instead of the reserved session date',async t=>{
  const base=Date.parse('2026-10-02T23:59:59Z');
  const proposal=candidate('AAA',{quoteTime:iso(base),forceExitAt:iso(base+3600000)});
  const f=await fixture(t,{now:base},proposal);
  await f.edit(l=>l.orders.push(closed(-1000,{closedAt:iso(base)})));
  assert.equal((await f.fill({now:base+1000},quote('AAA',base+1000))).status,'filled');
});

test('zero permitted margin for cash instruments does not disable valid fills',async t=>{
  const f=await fixture(t,{maxInitialMarginPct:0});assert.equal((await f.fill()).status,'filled');
});
for(const [overrides,reason] of [[{maxOpenPositions:1},'open_position_limit_at_fill'],[{maxGrossExposurePct:25},'gross_exposure_limit_at_fill']])
  test(`new queued exposure respects ${reason}`,async t=>{
    const f=await fixture(t,overrides);const b=candidate('BBB');const d=evaluatePaperCandidate(b,{accountEquity:10000},policy);
    assert.equal((await reservePaperCandidate(b,d,{statePath:f.statePath,now:NOW,emergencyStop:false})).status,'reserved');
    assert.equal((await f.fill()).reason,reason);
  });
test('a better short fill cannot increase notional past the frozen gross ceiling',async t=>{
  const f=await fixture(t,{maxGrossExposurePct:23.001},candidate('AAA',{direction:'short',entryPrice:100,bid:100,ask:100.01,stopPrice:101,targetPrice:97}));
  assert.equal((await f.fill({},quote('AAA',NOW+1000,{bid:100.5,ask:100.51}))).reason,'gross_exposure_limit_at_fill');
});
test('a strict new margin ceiling and invalid or conflicting peer metadata block a fill',async t=>{
  const f=await fixture(t,{maxInitialMarginPct:0.5});const original=await f.read();
  const peer={...f.order,orderId:'peer',idempotencyKey:'peer',instrumentKey:'BBB',exposureKey:'BBB',exposureKeys:['BBB']};
  for(const [fields,reason] of [[{marginRequirementUsd:60},'initial_margin_exposure_limit_at_fill'],[{riskUsd:null},'active_order_risk_metadata_invalid_at_fill'],
    [{accountEquityUsd:20000},'shared_account_equity_mismatch_at_fill'],[{instrumentKey:'AAA'},'duplicate_open_exposure_at_fill'],[{instrumentKey:'AAA',direction:'short'},'conflicting_open_exposure_at_fill']]){
    await writeFile(f.statePath,JSON.stringify({...original,orders:[...original.orders,{...peer,...fields}]}));
    assert.equal((await f.fill()).reason,reason);
  }
});

test('post-lock time, not scan time, bounds quote freshness before any portfolio fill',async t=>{
  const f=await fixture(t);
  const before=await readFile(f.statePath,'utf8');
  assert.equal((await f.fill({observationClock:()=>NOW+60000})).reason,'quote_not_current_and_executable');
  assert.equal(await readFile(f.statePath,'utf8'),before);
});
test('malformed fill policy cannot be supplied or loosened by a monitor',async t=>{
  const f=await fixture(t);const original=await f.read();
  for(const p of [null,{}, {...f.order.entryRiskPolicy,maxDailyLossUsd:null},{...f.order.entryRiskPolicy,closedTradeCircuit:{}},{...f.order.entryRiskPolicy,externalPortfolio:{mode:'independent'}}]){
    const l=structuredClone(original);l.orders[0].entryRiskPolicy=p;await writeFile(f.statePath,JSON.stringify(l));
    assert.equal((await f.fill({maxSpreadPct:99})).reason,'entry_risk_policy_unavailable');
  }
});
test('directional currency overlap introduced after reservation blocks the fill',async t=>{
  const f=await fixture(t,{},candidate('EUR_USD',{owner:'forex',assetClass:'forex'}));
  await f.edit(l=>l.orders.push({...f.order,orderId:'peer',idempotencyKey:'peer',instrumentKey:'GBP_USD',exposureKey:'GBP_USD',exposureKeys:['GBP_USD']}));
  assert.equal((await f.fill()).reason,'concentrated_currency_exposure_at_fill');
});
test('operator portfolio diagnostics expose saved pending fill-risk rejections',async t=>{
  const f=await fixture(t);await f.edit(l=>l.orders.push(closed()));await f.fill();
  const report=summarizePaperLedger(await f.read(),{accountEquity:10000,now:NOW+1000});
  assert.equal(report.pendingFillRisk.blocked,1);assert.equal(report.pendingFillRisk.checked,1);
  assert.equal(report.pendingFillRisk.reasons.daily_loss_limit_at_fill,1);
  const operator=summarizeSharedPaperPortfolio(await f.read(),{now:NOW+1000});
  assert.equal(operator.pendingFillRisk.blocked,1);
  assert.equal(operator.byBot['etfs-etps'].pendingFillRisk.reasons.daily_loss_limit_at_fill,1);
});
