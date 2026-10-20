import { ChannelType, SlashCommandBuilder } from 'discord.js';

export function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName('crypto')
      .setDescription('OmniMod Crypto momentum research and paper signal tracking.')
      .addSubcommand((sub) => sub.setName('help').setDescription('Show setup steps, model factors, colors, and command guidance.'))
      .addSubcommand((sub) => sub.setName('momentum').setDescription('Show the strongest currently cached momentum candidates.')
        .addIntegerOption((option) => option.setName('count').setDescription('Number of assets to show.').setMinValue(1).setMaxValue(12)))
      .addSubcommand((sub) => sub.setName('invest').setDescription('5/20/60-day price-trend research vs BTC; not protocol underwriting.')
        .addStringOption((option) => option.setName('query').setDescription('Optional coin symbol/name; otherwise researches a balanced pool of up to 12 liquid assets.').setMaxLength(80)))
      .addSubcommand((sub) => sub.setName('thesis').setDescription('Private, versioned long-term thesis notes; separate from daily signals.')
        .addStringOption((option) => option.setName('action').setDescription('Add, list, inspect, or review theses.').addChoices(
          { name: 'Add revision', value: 'add' }, { name: 'List theses', value: 'list' }, { name: 'Show latest thesis', value: 'show' }, { name: 'Due reviews', value: 'due' }, { name: 'Capture evidence review', value: 'review' }, { name: 'Evidence history', value: 'history' }, { name: 'Evidence coverage', value: 'coverage' }, { name: 'Reference performance', value: 'performance' }, { name: 'Record your assessment', value: 'assess' }
        ).setRequired(true))
        .addStringOption((option) => option.setName('asset').setDescription('Exact asset id or ticker (required for add/show/review/history/coverage/performance/assess).').setMaxLength(80))
        .addStringOption((option) => option.setName('thesis_type').setDescription('Primary long-term thesis classification.').addChoices(
          { name: 'Network adoption', value: 'network_adoption' }, { name: 'Token value capture', value: 'token_value_capture' },
          { name: 'Infrastructure', value: 'infrastructure' }, { name: 'DeFi', value: 'defi' },
          { name: 'Store of value', value: 'store_of_value' }, { name: 'Payments/settlement', value: 'payments' },
          { name: 'Speculative long-duration', value: 'speculative_long_duration' }, { name: 'Other', value: 'other' }
        ))
        .addIntegerOption((option) => option.setName('horizon_months').setDescription('Intended holding horizon in months.').setMinValue(1).setMaxValue(120))
        .addStringOption((option) => option.setName('review_date').setDescription('Next planned thesis review date, YYYY-MM-DD.').setMaxLength(10))
        .addStringOption((option) => option.setName('protocol_slug').setDescription('Exact DeFiLlama protocol slug for protocol metrics (optional; not a token ticker).').setMaxLength(64))
        .addStringOption((option) => option.setName('github_repo').setDescription('Exact public GitHub owner/repo mapping; optional, never inferred from ticker.').setMaxLength(140))
        .addStringOption((option) => option.setName('thesis').setDescription('Why this asset may create long-term value.').setMaxLength(1200))
        .addStringOption((option) => option.setName('assumptions').setDescription('Key assumptions required for the thesis to hold.').setMaxLength(800))
        .addStringOption((option) => option.setName('base_case').setDescription('Most reasonable expected path and evidence.').setMaxLength(800))
        .addStringOption((option) => option.setName('bull_case').setDescription('Conditions and evidence that would support the thesis.').setMaxLength(800))
        .addStringOption((option) => option.setName('bear_case').setDescription('Strongest counterargument and important risks.').setMaxLength(800))
        .addStringOption((option) => option.setName('invalidation').setDescription('Specific evidence that would invalidate the thesis.').setMaxLength(800))
        .addStringOption((option) => option.setName('catalysts').setDescription('Relevant catalysts, including known dates if verified.').setMaxLength(600))
        .addStringOption((option) => option.setName('source_urls').setDescription('At least one HTTPS evidence source; up to five, separated by spaces.').setMaxLength(2000))
        .addStringOption((option) => option.setName('assessment').setDescription('Your assessment after reviewing the thesis and evidence.').addChoices(
          { name: 'Thesis intact', value: 'thesis_intact' }, { name: 'Mixed evidence', value: 'mixed' }, { name: 'Thesis weakened', value: 'weakened' },
          { name: 'Invalidation condition met', value: 'invalidation_met' }, { name: 'Insufficient evidence', value: 'insufficient_evidence' }
        ))
        .addStringOption((option) => option.setName('assessment_notes').setDescription('Your evidence and reasoning (required when recording assessment).').setMaxLength(800)))
      .addSubcommand((sub) => sub.setName('asset').setDescription('Inspect one cached asset and its model factors.')
        .addStringOption((option) => option.setName('query').setDescription('Coin name, symbol, or CoinGecko id.').setMaxLength(80).setRequired(true)))
      .addSubcommand((sub) => sub.setName('tracker').setDescription('Show active paper signals and their current target/stop progress.')
        .addStringOption((option) => option.setName('symbol').setDescription('Optional symbol filter.').setMaxLength(20)))
      .addSubcommand((sub) => sub.setName('history').setDescription('Show recently completed signal outcomes.')
        .addIntegerOption((option) => option.setName('count').setDescription('Number of outcomes.').setMinValue(1).setMaxValue(20)))
      .addSubcommand((sub) => sub.setName('performance').setDescription('Show the paper tracker win, loss, shortfall, and exceeded summary.'))
      .addSubcommand((sub) => sub.setName('model').setDescription('Show learning-model sample size and untouched holdout quality.'))
      .addSubcommand((sub) => sub.setName('research').setDescription('Show shadow-observation and label collection status.'))
      .addSubcommand((sub) => sub.setName('train').setDescription('Retrain and validate the learning model now. Admin only.'))
      .addSubcommand((sub) => sub.setName('import-data').setDescription('Import normalized licensed/history NDJSON from the configured directory. Admin only.'))
      .addSubcommand((sub) => sub.setName('guard').setDescription('Inspect or change the automatic risk shutdown. Admin only.')
        .addStringOption((option) => option.setName('action').setDescription('Guard action.').addChoices(
          { name: 'Status', value: 'status' }, { name: 'Pause new signals', value: 'pause' }, { name: 'Resume automatic mode', value: 'resume' }
        ).setRequired(true))
        .addStringOption((option) => option.setName('reason').setDescription('Optional audit reason for a manual pause.').setMaxLength(200)))
      .addSubcommand((sub) => sub.setName('event').setDescription('Record and manage manually classified crypto catalysts and event controls. Admin only.')
        .addStringOption((option) => option.setName('action').setDescription('Event action.').addChoices(
          { name: 'List active or upcoming', value: 'list' }, { name: 'Add catalyst/event', value: 'add' }, { name: 'Clear by symbol/id', value: 'clear' }
        ).setRequired(true))
        .addStringOption((option) => option.setName('symbol').setDescription('Crypto symbol, * for market-wide, or event id when clearing.').setMaxLength(80))
        .addStringOption((option) => option.setName('severity').setDescription('Block vetoes; caution is a model feature; observe is context only.').addChoices(
          { name: 'Block new signal approvals', value: 'block' }, { name: 'Caution; learned-model feature', value: 'caution' }, { name: 'Observe only; no gate effect', value: 'observe' }
        ))
        .addIntegerOption((option) => option.setName('duration_hours').setDescription('How long the event remains active.').setMinValue(1).setMaxValue(720))
        .addStringOption((option) => option.setName('reason').setDescription('Describe the event and evidence; tags are manually supplied.').setMaxLength(300))
        .addStringOption((option) => option.setName('event_type').setDescription('Catalyst category.').addChoices(
          { name: 'Token unlock', value: 'token_unlock' }, { name: 'Exchange listing', value: 'exchange_listing' },
          { name: 'Exchange delisting', value: 'exchange_delisting' }, { name: 'Network upgrade', value: 'network_upgrade' },
          { name: 'Protocol incident', value: 'protocol_incident' }, { name: 'Regulatory', value: 'regulatory' },
          { name: 'Governance', value: 'governance' }, { name: 'Macro', value: 'macro' }, { name: 'Other', value: 'other' }))
        .addStringOption((option) => option.setName('direction').setDescription('Reported expected direction; not an inferred price forecast.').addChoices(
          { name: 'Positive', value: 'positive' }, { name: 'Negative', value: 'negative' }, { name: 'Neutral', value: 'neutral' }, { name: 'Unknown', value: 'unknown' }))
        .addStringOption((option) => option.setName('expectedness').setDescription('Was the event scheduled or unexpected?').addChoices(
          { name: 'Scheduled / known', value: 'scheduled' }, { name: 'Unexpected', value: 'unexpected' }, { name: 'Unknown', value: 'unknown' }))
        .addStringOption((option) => option.setName('horizon').setDescription('Primary expected relevance window.').addChoices(
          { name: 'Intraday', value: 'intraday' }, { name: 'Swing', value: 'swing' }, { name: 'Long-term', value: 'long_term' }, { name: 'Unknown', value: 'unknown' }))
        .addStringOption((option) => option.setName('impact').setDescription('Admin-assessed impact size; not a price target.').addChoices(
          { name: 'High', value: 'high' }, { name: 'Medium', value: 'medium' }, { name: 'Low', value: 'low' }, { name: 'Unknown', value: 'unknown' }))
        .addStringOption((option) => option.setName('source_url').setDescription('Optional HTTPS source link.').setMaxLength(500))
        .addStringOption((option) => option.setName('starts_at').setDescription('Optional ISO timestamp; defaults to now.').setMaxLength(40)))
      .addSubcommand((sub) => sub.setName('status').setDescription('Show scheduler, provider, cache, and tracker status.'))
      .addSubcommand((sub) => sub.setName('diagnostics').setDescription('Show recent scan funnel, rejection, provider, and latency diagnostics. Admin only.'))
      .addSubcommand((sub) => sub.setName('validate').setDescription('Walk-forward check one asset on recent 15-minute candles. Admin only.')
        .addStringOption((option) => option.setName('query').setDescription('Coin name, symbol, or market-data id.').setMaxLength(80).setRequired(true)))
      .addSubcommand((sub) => sub.setName('scan').setDescription('Run the configured momentum scan. Admin only.')
        .addBooleanOption((option) => option.setName('force_provider').setDescription('Ignore the recent snapshot cache and request a new market snapshot.')))
      .addSubcommand((sub) => sub.setName('setup').setDescription('Assign channels and roles for this server. Admin only.')
        .addChannelOption((option) => option.setName('signals_channel').setDescription('Channel for new momentum calls.').addChannelTypes(ChannelType.GuildText).setRequired(true))
        .addChannelOption((option) => option.setName('results_channel').setDescription('Channel for graded outcomes.').addChannelTypes(ChannelType.GuildText))
        .addChannelOption((option) => option.setName('logs_channel').setDescription('Private channel for health and provider alerts.').addChannelTypes(ChannelType.GuildText))
        .addRoleOption((option) => option.setName('alert_role').setDescription('Optional opt-in role for signal notifications.'))
        .addRoleOption((option) => option.setName('admin_role').setDescription('Optional role to ping for provider failures.'))
        .addBooleanOption((option) => option.setName('scan_now').setDescription('Run the first scan immediately.')))
      .addSubcommand((sub) => sub.setName('configure').setDescription('Tune the model and scheduler for this server. Admin only.')
        .addIntegerOption((option) => option.setName('monitor_minutes').setDescription('Fresh-price interval while paper signals are open.').setMinValue(2).setMaxValue(30))
        .addIntegerOption((option) => option.setName('discovery_minutes').setDescription('Interval for discovering new momentum setups.').setMinValue(5).setMaxValue(120))
        .addIntegerOption((option) => option.setName('minimum_score').setDescription('Minimum momentum screen score; this is not a probability.').setMinValue(50).setMaxValue(95))
        .addIntegerOption((option) => option.setName('max_signals').setDescription('Maximum new calls per day.').setMinValue(1).setMaxValue(12))
        .addIntegerOption((option) => option.setName('min_providers').setDescription('Minimum independent price providers required.').setMinValue(2).setMaxValue(4))
        .addIntegerOption((option) => option.setName('risk_basis_points').setDescription('Maximum account risk per signal (50 = 0.50%).').setMinValue(10).setMaxValue(100))
        .addIntegerOption((option) => option.setName('round_trip_fee_bps').setDescription('Estimated entry plus exit fees/slippage in basis points.').setMinValue(0).setMaxValue(100))
        .addIntegerOption((option) => option.setName('minimum_rr_tenths').setDescription('Minimum reward/risk in tenths (17 = 1.7R).').setMinValue(13).setMaxValue(40))
        .addIntegerOption((option) => option.setName('simulated_order_usd').setDescription('Paper order size used for depth/slippage checks.').setMinValue(100).setMaxValue(1000000))
        .addIntegerOption((option) => option.setName('max_slippage_bps').setDescription('Maximum estimated one-way execution slippage.').setMinValue(5).setMaxValue(300))
        .addIntegerOption((option) => option.setName('max_concurrent_signals').setDescription('Portfolio-wide maximum active signals.').setMinValue(1).setMaxValue(12))
        .addIntegerOption((option) => option.setName('max_correlation_percent').setDescription('Maximum seven-day return correlation (40-99).').setMinValue(40).setMaxValue(99))
        .addIntegerOption((option) => option.setName('daily_hour').setDescription('Opening discovery hour in the configured timezone.').setMinValue(0).setMaxValue(23))
        .addIntegerOption((option) => option.setName('daily_minute').setDescription('Opening discovery minute.').setMinValue(0).setMaxValue(59)))
      .addSubcommand((sub) => sub.setName('api-key').setDescription('Store or clear a server-specific CoinGecko key. Admin only.')
        .addStringOption((option) => option.setName('tier').setDescription('CoinGecko API tier.').addChoices(
          { name: 'Keyless public', value: 'public' }, { name: 'Demo', value: 'demo' }, { name: 'Pro', value: 'pro' }
        ).setRequired(true))
        .addStringOption((option) => option.setName('key').setDescription('API key, omitted for keyless public mode.').setMaxLength(256)))
      .addSubcommand((sub) => sub.setName('role').setDescription('Post the Crypto Alerts opt-in panel. Admin only.'))
      .toJSON()
  ];
}
