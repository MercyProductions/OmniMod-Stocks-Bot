export const now = Date.parse('2026-10-02T16:00:30Z'), start = '2026-10-02T15:30:00.000Z', end = '2026-10-02T16:00:00.000Z';
export const contract = (id, root = `R${id}`, extra = {}) => ({ identity: `GLBX.MDP3:2026-10-02:1:${id}`, providerDataset: 'GLBX.MDP3',
  providerPublisherId: '1', providerInstrumentId: String(id), providerRoot: root, providerRawSymbol: `${root}Z6`, providerExchange: 'XCME',
  expiry: '2026-12-20T00:00:00.000Z', providerInstrumentClass: 'F', configuredPriority: false, ...extra });
export const directory = (contracts) => ({ status: 'refreshed', contracts, archive: { sha256: 'fixture-source' },
  diagnostics: { version: 'databento-dataset-definitions-v1', streamComplete: true, dataset: 'GLBX.MDP3', observedFrom: '2026-10-02T00:00:00Z', observedThroughExclusive: end } });
export const bar = (c, minute = 59, extra = {}) => ({ hd: { rtype: 33, publisher_id: Number(c.providerPublisherId), instrument_id: Number(c.providerInstrumentId),
  ts_event: `2026-10-02T15:${minute}:00.000Z` }, symbol: c.providerRawSymbol, open: 100, high: 101, low: 99, close: 100, volume: 100, ...extra });
