const records = JSON.parse(process.env.OMNIMOD_TEST_DATABENTO_DEFINITIONS || '[]');

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.hostname !== 'hist.databento.com') return { ok: false, status: 599, text: async () => 'Unexpected test network host.' };
  if (url.pathname.endsWith('/metadata.get_cost')) {
    if (url.searchParams.get('schema') !== 'definition' || url.searchParams.get('stype_in') !== 'continuous')
      return { ok: false, status: 400, text: async () => 'Unexpected cost-estimate request parameters.' };
    return { ok: true, status: 200, headers: new Headers(), text: async () => '0.01' };
  }
  if (url.pathname.endsWith('/timeseries.get_range')) {
    const form = new URLSearchParams(options.body);
    if (options.method !== 'POST' || form.get('schema') !== 'definition' || form.get('stype_in') !== 'continuous')
      return { ok: false, status: 400, headers: new Headers(), text: async () => 'Unexpected definition request parameters.' };
    return { ok: true, status: 200, headers: new Headers(), text: async () => records.map((row) => JSON.stringify(row)).join('\n') };
  }
  return { ok: false, status: 404, headers: new Headers(), text: async () => 'Unexpected Databento API path.' };
};
