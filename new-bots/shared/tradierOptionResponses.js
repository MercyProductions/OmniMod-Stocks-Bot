import { validOptionDate } from './optionContractIdentity.js';

function hasPaging(payload) {
  return [payload, payload?.expirations, payload?.options, payload?.quotes].some((row) => row && typeof row === 'object'
    && ['next_page_token', 'nextPageToken', 'next', 'pagination', 'total_pages'].some((key) => row[key] != null && row[key] !== '' && row[key] !== false));
}
function collection(payload, container, member, code) {
  const invalid = () => Object.assign(new Error(`Incomplete or malformed Tradier ${container === 'options' ? 'chain' : container} response.`), { code });
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.hasOwn(payload, container) || hasPaging(payload)) throw invalid();
  const raw = payload[container];
  if (raw === null) return [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.hasOwn(raw, member)) throw invalid();
  return raw[member] === null ? [] : Array.isArray(raw[member]) ? raw[member] : [raw[member]];
}
export function parseExpirationInventory(payload) {
  const dates = collection(payload, 'expirations', 'date', 'invalid_expiration_response');
  if (!dates.every(validOptionDate)) throw Object.assign(new Error('Invalid expiration date.'), { code: 'invalid_expiration_date' });
  return { dates: [...new Set(dates)].sort(), duplicateDates: dates.length - new Set(dates).size };
}
export const tradierChainRows = (payload) => collection(payload, 'options', 'option', 'invalid_chain_response');
export const tradierQuoteRows = (payload) => collection(payload, 'quotes', 'quote', 'invalid_quote_response');
