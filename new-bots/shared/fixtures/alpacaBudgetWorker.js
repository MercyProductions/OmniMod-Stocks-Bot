import { waitForAlpacaRequest as shared } from '../alpacaRequestGate.js';
import { waitForAlpacaRequest as stocks } from '../../../stocks-bot/src/alpacaRequestGate.js';
const gate = process.env.BUDGET_FIXTURE_OWNER === 'stocks' ? stocks : shared;
const grants = [];
for (let i = 0; i < 4; i++) grants.push(await gate('synthetic-shared-key'));
console.log(JSON.stringify(grants));
