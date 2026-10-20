// Deployment maps this small loader to crypto-bot/app.js. Strategies remain untouched.
if (['1', 'true', 'yes', 'on'].includes(String(process.env.OMNIMOD_WORKER_ONLY || '').toLowerCase())) {
  await import('./hosting/manager.js');
} else {
  await import('./hosting/passenger.js');
}
