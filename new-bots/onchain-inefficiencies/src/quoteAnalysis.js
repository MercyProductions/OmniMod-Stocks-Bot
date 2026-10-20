const addressIsValid = (value) => /^0x[a-f\d]{40}$/i.test(String(value));

function validQuote(quote) {
  const timestamp = Date.parse(quote?.observedAt);
  return quote && Number.isInteger(Number(quote.chainId)) && Number.isInteger(Number(quote.blockNumber))
    && addressIsValid(quote.baseTokenAddress) && addressIsValid(quote.quoteTokenAddress)
    && Number(quote.quantity) > 0 && Number.isFinite(Number(quote.quantity))
    && Number(quote.price) > 0 && Number.isFinite(Number(quote.price))
    && Number(quote.quoteTokenUsd) > 0 && Number.isFinite(Number(quote.quoteTokenUsd))
    && quote.feeBps != null && Number(quote.feeBps) >= 0 && Number.isFinite(Number(quote.feeBps))
    && quote.slippageReserveBps != null && Number(quote.slippageReserveBps) >= 0 && Number.isFinite(Number(quote.slippageReserveBps))
    && quote.gasUsd != null && Number(quote.gasUsd) >= 0 && Number.isFinite(Number(quote.gasUsd))
    && Number.isFinite(timestamp);
}

export function isUsableQuote(quote, { now = Date.now(), maxAgeMs = 10_000 } = {}) {
  if (!validQuote(quote)) return false;
  const timestamp = Date.parse(quote.observedAt);
  return timestamp <= now && now - timestamp <= maxAgeMs;
}

export function compareSameBlockQuotes(buy, sell, { now = Date.now(), maxAgeMs = 10_000, minNetUsd = 0.25 } = {}) {
  if (!isUsableQuote(buy, { now, maxAgeMs }) || !isUsableQuote(sell, { now, maxAgeMs }) || buy.side !== 'buy' || sell.side !== 'sell'
    || buy.venue === sell.venue || Number(buy.chainId) !== Number(sell.chainId)
    || Number(buy.blockNumber) !== Number(sell.blockNumber)
    || String(buy.baseTokenAddress).toLowerCase() !== String(sell.baseTokenAddress).toLowerCase()
    || String(buy.quoteTokenAddress).toLowerCase() !== String(sell.quoteTokenAddress).toLowerCase()
    || Number(buy.quantity) !== Number(sell.quantity)) return null;

  const buyTime = Date.parse(buy.observedAt), sellTime = Date.parse(sell.observedAt);
  const newest = Math.max(buyTime, sellTime), skew = Math.abs(buyTime - sellTime);
  if (skew > maxAgeMs) return null;
  const buyNotionalUsd = Number(buy.price) * Number(buy.quantity) * Number(buy.quoteTokenUsd);
  const sellNotionalUsd = Number(sell.price) * Number(sell.quantity) * Number(sell.quoteTokenUsd);
  const gross = sellNotionalUsd - buyNotionalUsd;
  const fees = (buyNotionalUsd * Number(buy.feeBps) + sellNotionalUsd * Number(sell.feeBps)) / 10_000;
  const slippage = (buyNotionalUsd * Number(buy.slippageReserveBps) + sellNotionalUsd * Number(sell.slippageReserveBps)) / 10_000;
  const net = gross - fees - slippage - Number(buy.gasUsd) - Number(sell.gasUsd);
  if (!Number.isFinite(net) || net < minNetUsd) return null;
  return {
    chainId: Number(buy.chainId), blockNumber: Number(buy.blockNumber), baseTokenAddress: buy.baseTokenAddress,
    quoteTokenAddress: buy.quoteTokenAddress, buyQuoteTokenUsd: Number(buy.quoteTokenUsd), sellQuoteTokenUsd: Number(sell.quoteTokenUsd),
    quantity: Number(buy.quantity), buyVenue: buy.venue, sellVenue: sell.venue,
    grossEdgeUsd: Number(gross.toFixed(4)), estimatedNetUsd: Number(net.toFixed(4)), quoteSkewMs: skew,
    observedAgeSeconds: Number(((now - newest) / 1000).toFixed(2)),
    warning: 'Same-block quote estimate only; no atomic execution. Gas changes, MEV, reverts, quote availability, and fill failure can erase the apparent edge.'
  };
}

export function evaluateCycleQuote(quote, { minNetUsd = 0.25 } = {}) {
  if (!quote || !Number.isInteger(Number(quote.chainId)) || !Number.isInteger(Number(quote.blockNumber))
    || !Array.isArray(quote.path) || quote.path.length < 3
    || String(quote.path[0]).toLowerCase() !== String(quote.path.at(-1)).toLowerCase()
    || !Array.isArray(quote.amountsRaw) || quote.amountsRaw.length !== quote.path.length
    || quote.amountsRaw.some((amount) => !/^\d+$/.test(String(amount)))
    || BigInt(quote.amountsRaw[0]) <= 0n || BigInt(quote.amountsRaw.at(-1)) <= 0n
    || !(Number(quote.inputUsd) > 0) || !Number.isFinite(Number(quote.inputUsd))
    || !(Number(quote.gasUsd) >= 0) || !Number.isFinite(Number(quote.gasUsd))
    || !(Number(quote.slippageReserveBps) >= 0) || !Number.isFinite(Number(quote.slippageReserveBps))) return null;
  const outputMultiple = Number(BigInt(quote.amountsRaw.at(-1))) / Number(BigInt(quote.amountsRaw[0]));
  if (!Number.isFinite(outputMultiple) || outputMultiple <= 0) return null;
  const grossProfitUsd = Number(quote.inputUsd) * (outputMultiple - 1);
  const slippageReserveUsd = Number(quote.inputUsd) * Number(quote.slippageReserveBps) / 10000;
  const estimatedNetUsd = grossProfitUsd - slippageReserveUsd - Number(quote.gasUsd);
  return {
    routeId: quote.id, venue: quote.venue, chainId: Number(quote.chainId), blockNumber: Number(quote.blockNumber),
    path: quote.path, tokenSymbols: quote.tokenSymbols ?? null, inputAmount: quote.amountIn ?? null, outputAmount: quote.amountOut ?? null,
    assumptions: quote.assumptions ?? null, inputUsd: Number(quote.inputUsd), outputMultiple: Number(outputMultiple.toFixed(12)),
    grossProfitUsd: Number(grossProfitUsd.toFixed(4)), slippageReserveUsd: Number(slippageReserveUsd.toFixed(4)),
    gasUsd: Number(quote.gasUsd), estimatedNetUsd: Number(estimatedNetUsd.toFixed(4)),
    observedAt: quote.observedAt, source: quote.source,
    status: estimatedNetUsd >= minNetUsd ? 'candidate' : grossProfitUsd <= 0 ? 'negative-gross-edge' : 'costs-exceed-gross-edge',
    warning: 'Read-only Router02 quote at one block; pool fees are embedded in router output and gas/slippage are configured estimates. No balance, allowance, transfer tax, atomic execution, MEV, or transaction simulation is checked.'
  };
}

export function analyzeCycleQuote(quote, options) {
  const result = evaluateCycleQuote(quote, options);
  return result?.status === 'candidate' ? result : null;
}
