const ADDRESS = /^0x[a-f\d]{40}$/i;
const WORD = 64;
const SELECTOR = 'd06ca61f'; // Uniswap V2 Router02 getAmountsOut(uint256,address[])

const word = (value) => BigInt(value).toString(16).padStart(WORD, '0');

export function formatRawAmount(raw, decimals) {
  if (!/^\d+$/.test(String(raw)) || !Number.isInteger(Number(decimals)) || Number(decimals) < 0 || Number(decimals) > 36) throw new Error('Invalid raw token amount or decimals');
  const scale = 10n ** BigInt(decimals), value = BigInt(raw);
  const whole = value / scale, fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function encodeGetAmountsOut(amountIn, path) {
  if (BigInt(amountIn) <= 0n || !Array.isArray(path) || path.length < 3 || path.length > 8
    || path.some((address) => !ADDRESS.test(String(address)))
    || String(path[0]).toLowerCase() !== String(path.at(-1)).toLowerCase()) {
    throw new Error('A cycle route needs a positive raw input and 3–8 valid token addresses returning to the start token');
  }
  const addressWords = path.map((address) => String(address).slice(2).toLowerCase().padStart(WORD, '0')).join('');
  return `0x${SELECTOR}${word(amountIn)}${word(64)}${word(path.length)}${addressWords}`;
}

export function decodeAmountsOut(data, expectedLength) {
  if (typeof data !== 'string' || !/^0x[\da-f]+$/i.test(data)) throw new Error('Malformed router return data');
  const hex = data.slice(2);
  if (hex.length < 128) throw new Error('Router return data is too short');
  const offset = Number(BigInt(`0x${hex.slice(0, WORD)}`));
  const start = offset * 2;
  if (!Number.isSafeInteger(offset) || start + WORD > hex.length) throw new Error('Invalid dynamic-array offset');
  const length = Number(BigInt(`0x${hex.slice(start, start + WORD)}`));
  if (length !== expectedLength || start + WORD * (length + 1) > hex.length) throw new Error('Unexpected amount array length');
  return Array.from({ length }, (_, i) => BigInt(`0x${hex.slice(start + WORD * (i + 1), start + WORD * (i + 2))}`).toString());
}

async function rpc(url, method, params, fetcher) {
  const response = await fetcher(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`RPC ${body.error.code ?? 'error'}: ${String(body.error.message || 'request failed').slice(0, 160)}`);
  if (body.result == null) throw new Error('RPC response omitted result');
  return body.result;
}

export async function fetchV2CycleQuotes(routes, rpcUrl, { fetcher = fetch, now = Date.now(), maxAgeMs = 10_000 } = {}) {
  if (!rpcUrl) throw new Error('RPC_URL is required for evm-v2 quote scanning');
  if (!Array.isArray(routes)) throw new Error('Route file must contain a JSON array');
  if (!routes.length) return { chainId: null, blockNumber: null, quotes: [], errors: [] };
  const expectedChain = Number(routes[0].chainId);
  if (!Number.isInteger(expectedChain) || routes.some((route) => Number(route.chainId) !== expectedChain)) throw new Error('One RPC_URL can scan routes for only one configured chain');
  for (const route of routes) {
    encodeGetAmountsOut(route.amountInRaw, route.path);
    if ((route.tokenSymbols != null && (!Array.isArray(route.tokenSymbols) || route.tokenSymbols.length !== route.path.length))
      || (route.tokenDecimals != null && (!Array.isArray(route.tokenDecimals) || route.tokenDecimals.length !== route.path.length
        || route.tokenDecimals.some((value) => !Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 36)))) {
      throw new Error(`Route ${route.id || '(unnamed)'} has invalid token display metadata`);
    }
    if (!ADDRESS.test(String(route.routerAddress)) || !route.venue) throw new Error(`Route ${route.id || '(unnamed)'} needs a router address and venue`);
    if (!(Number(route.inputUsd) > 0) || !Number.isFinite(Number(route.inputUsd))
      || !(Number(route.gasUsd) >= 0) || !Number.isFinite(Number(route.gasUsd))
      || !(Number(route.slippageReserveBps) >= 0) || !Number.isFinite(Number(route.slippageReserveBps))) throw new Error(`Route ${route.id || '(unnamed)'} has invalid USD costs or notional`);
  }
  const rpcChainId = Number(BigInt(await rpc(rpcUrl, 'eth_chainId', [], fetcher)));
  if (rpcChainId !== expectedChain) throw new Error(`Configured route chain ${expectedChain} does not match RPC chain ${rpcChainId}`);
  const blockTag = await rpc(rpcUrl, 'eth_blockNumber', [], fetcher);
  const blockNumber = Number(BigInt(blockTag));
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 1) throw new Error('RPC returned an invalid block number');
  const block = await rpc(rpcUrl, 'eth_getBlockByNumber', [blockTag, false], fetcher);
  const blockTimestamp = Number(BigInt(block?.timestamp)) * 1000;
  const blockAgeMs = now - blockTimestamp;
  if (!Number.isFinite(blockTimestamp) || blockAgeMs < -1000 || blockAgeMs > maxAgeMs) throw new Error('RPC latest block timestamp is invalid, future-dated, or outside the configured freshness window');
  const outcomes = await Promise.all(routes.map(async (route) => {
    try {
      const data = encodeGetAmountsOut(route.amountInRaw, route.path);
      const result = await rpc(rpcUrl, 'eth_call', [{ to: route.routerAddress, data }, blockTag], fetcher);
      const amountsRaw = decodeAmountsOut(result, route.path.length);
      if (amountsRaw.at(-1) === '0') throw new Error('Router returned zero output');
      return { quote: {
        id: route.id, venue: route.venue, chainId: expectedChain, blockNumber,
        routerAddress: route.routerAddress, path: route.path, amountInRaw: String(route.amountInRaw), amountsRaw,
        tokenSymbols: route.tokenSymbols ?? null,
        amountIn: route.tokenDecimals ? formatRawAmount(amountsRaw[0], route.tokenDecimals[0]) : null,
        amountOut: route.tokenDecimals ? formatRawAmount(amountsRaw.at(-1), route.tokenDecimals.at(-1)) : null,
        inputUsd: Number(route.inputUsd), gasUsd: Number(route.gasUsd), slippageReserveBps: Number(route.slippageReserveBps),
        assumptions: route.assumptions ?? null,
        observedAt: new Date(blockTimestamp).toISOString(), blockAgeMs,
        source: 'Uniswap V2-compatible Router02 eth_call'
      } };
    } catch (error) { return { error: { routeId: route.id, venue: route.venue, message: error.message } }; }
  }));
  return { chainId: expectedChain, blockNumber, blockTag, quotes: outcomes.flatMap((x) => x.quote ? [x.quote] : []), errors: outcomes.flatMap((x) => x.error ? [x.error] : []) };
}
