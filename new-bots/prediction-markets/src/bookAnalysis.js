export function buyCost(book, shares) {
  const asks = [...(book.asks || [])].map((x) => ({ price: Number(x.price), size: Number(x.size) }))
    .filter((x) => x.price > 0 && x.price <= 1 && x.size > 0).sort((a, b) => a.price - b.price);
  let left = shares, cost = 0;
  for (const level of asks) {
    const take = Math.min(left, level.size);
    cost += take * level.price;
    left -= take;
    if (left <= 1e-9) break;
  }
  return left > 1e-9 ? null : cost;
}

function normalizedFeeSchedule(schedule) {
  const rate = Number(schedule?.rate), exponent = Number(schedule?.exponent);
  if (!(Number.isFinite(rate) && rate >= 0 && rate <= 1 && Number.isFinite(exponent) && exponent >= 0 && exponent <= 10)
    || typeof schedule?.takerOnly !== 'boolean') return null;
  return { rate, exponent, takerOnly: schedule.takerOnly };
}

export function feeForFill(shares, price, schedule, { feesEnabled = true, liquidityRole = 'taker' } = {}) {
  if (!feesEnabled || (liquidityRole === 'maker' && schedule?.takerOnly === true)) return 0;
  const parsed = normalizedFeeSchedule(schedule), count = Number(shares), p = Number(price);
  if (!parsed || !(Number.isFinite(count) && count >= 0 && Number.isFinite(p) && p > 0 && p < 1)) return null;
  const fee = count * parsed.rate * (p * (1 - p)) ** parsed.exponent;
  return Number((Math.round((fee + Number.EPSILON) * 100_000) / 100_000).toFixed(5));
}

export function buyCostWithFees(book, shares, { feesEnabled, feeSchedule } = {}) {
  if (typeof feesEnabled !== 'boolean') return null;
  const asks = askLevels(book);
  let left = Number(shares), cost = 0, fee = 0;
  if (!(Number.isFinite(left) && left > 0)) return null;
  for (const level of asks) {
    const take = Math.min(left, level.size);
    const levelFee = feeForFill(take, level.price, feeSchedule, { feesEnabled, liquidityRole: 'taker' });
    if (levelFee === null) return null;
    cost += take * level.price;
    fee += levelFee;
    left -= take;
    if (left <= 1e-9) break;
  }
  return left > 1e-9 ? null : { notionalUsd: cost, feeUsd: fee, totalUsd: cost + fee, filledShares: Number(shares) };
}

export function displayedSpreadWithFees(book, market) {
  const spread = displayedSpread(book);
  if (!spread) return null;
  const feeConfigKnown = typeof market?.feesEnabled === 'boolean';
  const makerBidFeeUsd = feeConfigKnown ? feeForFill(1, spread.bid, market.feeSchedule, { feesEnabled: market.feesEnabled, liquidityRole: 'maker' }) : null;
  const makerAskFeeUsd = feeConfigKnown ? feeForFill(1, spread.ask, market.feeSchedule, { feesEnabled: market.feesEnabled, liquidityRole: 'maker' }) : null;
  return { ...spread, makerFeePerShareUsd: makerBidFeeUsd === null || makerAskFeeUsd === null ? null : Number((makerBidFeeUsd + makerAskFeeUsd).toFixed(5)),
    netDisplayedSpreadCents: makerBidFeeUsd === null || makerAskFeeUsd === null ? null : Number(((spread.spreadCents / 100 - makerBidFeeUsd - makerAskFeeUsd) * 100).toFixed(4)),
    makerFeeStatus: market?.feesEnabled === false ? 'fees-disabled' : market?.feesEnabled !== true ? 'fee-status-unknown' : makerBidFeeUsd === null || makerAskFeeUsd === null ? 'fee-schedule-unavailable' : 'market-schedule-applied' };
}

export function sizeCompleteSetToBudget(yesBook, noBook, budgetUsd, market, { minOrderUsd = 0 } = {}) {
  const bestYes = askLevels(yesBook)[0], bestNo = askLevels(noBook)[0], budget = Number(budgetUsd);
  if (!bestYes || !bestNo || !(Number.isFinite(budget) && budget > 0) || typeof market?.feesEnabled !== 'boolean') return null;
  let low = 0, high = budget / (bestYes.price + bestNo.price);
  for (let i = 0; i < 48; i += 1) {
    const shares = (low + high) / 2;
    const yes = buyCostWithFees(yesBook, shares, market), no = buyCostWithFees(noBook, shares, market);
    if (yes && no && yes.totalUsd + no.totalUsd <= budget) low = shares;
    else high = shares;
  }
  if (!(low > 0)) return null;
  const yes = buyCostWithFees(yesBook, low, market), no = buyCostWithFees(noBook, low, market);
  if (!yes || !no || yes.notionalUsd < minOrderUsd || no.notionalUsd < minOrderUsd) return null;
  return { shares: low, yes, no, cashBudgetUsd: budget, totalCostUsd: yes.totalUsd + no.totalUsd,
    grossPairCostUsd: yes.notionalUsd + no.notionalUsd, totalFeeUsd: yes.feeUsd + no.feeUsd,
    payoutUsd: low, grossProfitUsd: low - yes.notionalUsd - no.notionalUsd,
    netProfitUsd: low - yes.totalUsd - no.totalUsd };
}

export function askLevels(book) {
  return [...(book.asks || [])].map((x) => ({ price: Number(x.price), size: Number(x.size) }))
    .filter((x) => x.price > 0 && x.price <= 1 && x.size > 0).sort((a, b) => a.price - b.price);
}

export function bidLevels(book) {
  return [...(book.bids || [])].map((x) => ({ price: Number(x.price), size: Number(x.size) }))
    .filter((x) => x.price > 0 && x.price <= 1 && x.size > 0).sort((a, b) => b.price - a.price);
}

export function displayedSpread(book) {
  const bid = bidLevels(book)[0], ask = askLevels(book)[0];
  if (!bid || !ask || ask.price < bid.price) return null;
  return { bid: bid.price, ask: ask.price, spreadCents: (ask.price - bid.price) * 100,
    visibleTwoSidedSize: Math.min(bid.size, ask.size), mid: (bid.price + ask.price) / 2 };
}
