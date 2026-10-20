import { reservePaperCandidate } from '../paperRisk.js';

const request = JSON.parse(process.env.OMNIMOD_TEST_RESERVATION || 'null');
const result = await reservePaperCandidate(request.candidate, request.decision, {
  statePath: request.statePath,
  now: request.now,
  emergencyStop: false,
});
process.stdout.write(JSON.stringify(result));
