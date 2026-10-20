export function validateWorkerConfiguration(crypto, stocks) {
  if (!crypto.discordToken || !stocks.discordToken) {
    throw new Error('Combined worker requires separate Crypto and Stocks Discord bot tokens. Configure STOCKS_DISCORD_TOKEN or stocks-bot/.env.');
  }
  if (crypto.discordToken === stocks.discordToken) {
    throw new Error('Combined worker cannot share one Discord token between Crypto and Stocks. Configure a distinct Stocks bot token.');
  }
}
