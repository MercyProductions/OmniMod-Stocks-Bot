import { resolve } from 'node:path';
import { getPaperLedgerWorkspaceRoot } from './paperStatePath.js';
import { createSharedRequestBudget, inspectSharedRequestBudget, namespaceRequestBudget, providerBudgetError } from './filesystemRequestBudget.js';

export const ALPACA_BUDGET_VERSION = 'alpaca-shared-rest-budget-v1';
const DEFAULT_RPM = 180, MAX_RPM = 10000;
const validLimit = n => Number.isInteger(n) && n >= 1 && n <= MAX_RPM;
const failure = code => Object.assign(new Error(code), { code });

export function alpacaBudgetConfiguration(env = process.env, root = getPaperLedgerWorkspaceRoot()) {
  const value = String(env.ALPACA_REQUESTS_PER_MINUTE ?? '').trim();
  const requestsPerMinute = value ? Number(value) : DEFAULT_RPM;
  const group = String(env.ALPACA_RATE_LIMIT_GROUP ?? '').trim();
  if (!validLimit(requestsPerMinute) || (group && !/^[A-Za-z0-9._-]{1,100}$/.test(group))) throw failure('ALPACA_BUDGET_CONFIG_INVALID');
  return { directory: resolve(root, String(env.ALPACA_SHARED_RATE_DIR || 'shared/data/provider-limits/alpaca')),
    requestsPerMinute, group };
}

export function createSharedAlpacaRequestGate(options = {}) {
  try { return namespaceRequestBudget(createSharedRequestBudget({ ...options, version: ALPACA_BUDGET_VERSION }), 'ALPACA'); }
  catch (error) { throw providerBudgetError(error, 'ALPACA'); }
}
export async function inspectAlpacaSharedBudget({ directory = alpacaBudgetConfiguration().directory, ...options } = {}) {
  try { return await inspectSharedRequestBudget({ ...options, directory, version: ALPACA_BUDGET_VERSION }); }
  catch (error) { throw providerBudgetError(error, 'ALPACA'); }
}
