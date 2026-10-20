import { ChannelType, SlashCommandBuilder } from 'discord.js';

export function buildCommands() {
  return [new SlashCommandBuilder()
    .setName('stocks')
    .setDescription('OmniMod Stocks market research and paper setup tracking.')
    .addSubcommand((s) => s.setName('help').setDescription('Show setup, model, safety, and command guidance.'))
    .addSubcommand((s) => s.setName('momentum').setDescription('Show the strongest cached stock setups.')
      .addIntegerOption((o) => o.setName('count').setDescription('Rows to show.').setMinValue(1).setMaxValue(12)))
    .addSubcommand((s) => s.setName('ticker').setDescription('Inspect one ticker and its model factors.')
      .addStringOption((o) => o.setName('symbol').setDescription('U.S. ticker, such as NVDA.').setRequired(true).setMaxLength(12)))
    .addSubcommand((s) => s.setName('tracker').setDescription('Show active paper setups.')
      .addStringOption((o) => o.setName('symbol').setDescription('Optional ticker filter.').setMaxLength(12)))
    .addSubcommand((s) => s.setName('history').setDescription('Show recently graded outcomes.')
      .addIntegerOption((o) => o.setName('count').setDescription('Rows to show.').setMinValue(1).setMaxValue(20)))
    .addSubcommand((s) => s.setName('performance').setDescription('Show paper tracker outcome statistics.'))
    .addSubcommand((s) => s.setName('invest').setDescription('5/20/60-session price-trend research versus SPY; not fundamental underwriting.')
      .addIntegerOption((o) => o.setName('sessions').setDescription('Research holding period in trading sessions.').addChoices(
        { name: 'One week (5 sessions)', value: 5 }, { name: 'One month (20 sessions)', value: 20 }, { name: 'One quarter (60 sessions)', value: 60 }))
      .addStringOption((o) => o.setName('symbol').setDescription('Optional stock ticker; otherwise research up to 20 watchlist stocks.').setMaxLength(11))
      .addIntegerOption((o) => o.setName('count').setDescription('Number of research rows.').setMinValue(1).setMaxValue(5)))
    .addSubcommand((s) => s.setName('thesis').setDescription('Private, versioned long-term thesis notes; separate from daily signals.')
      .addStringOption((o) => o.setName('action').setDescription('Add, list, inspect, or review theses.').setRequired(true).addChoices(
        { name: 'Add revision', value: 'add' }, { name: 'List theses', value: 'list' }, { name: 'Show latest thesis', value: 'show' }, { name: 'Due reviews', value: 'due' }, { name: 'Capture evidence review', value: 'review' }, { name: 'Evidence history', value: 'history' }, { name: 'Evidence coverage', value: 'coverage' }, { name: 'Reference performance', value: 'performance' }, { name: 'Record your assessment', value: 'assess' }
      ))
      .addStringOption((o) => o.setName('asset').setDescription('Exact U.S. ticker (required for add/show/review/history/coverage/performance/assess).').setMaxLength(12))
      .addStringOption((o) => o.setName('thesis_type').setDescription('Primary long-term thesis classification.').addChoices(
        { name: 'Compounder', value: 'compounder' }, { name: 'Growth', value: 'growth' }, { name: 'Value', value: 'value' },
        { name: 'Turnaround', value: 'turnaround' }, { name: 'Cyclical', value: 'cyclical' }, { name: 'Income/dividend', value: 'income' },
        { name: 'Special situation', value: 'special_situation' }, { name: 'Secular theme', value: 'secular_theme' },
        { name: 'Core holding', value: 'core_holding' }, { name: 'Speculative long-duration', value: 'speculative_long_duration' }, { name: 'Other', value: 'other' }
      ))
      .addIntegerOption((o) => o.setName('horizon_months').setDescription('Intended holding horizon in months.').setMinValue(1).setMaxValue(120))
      .addStringOption((o) => o.setName('review_date').setDescription('Next planned thesis review date, YYYY-MM-DD.').setMaxLength(10))
      .addStringOption((o) => o.setName('thesis').setDescription('Why this business may create long-term value.').setMaxLength(1200))
      .addStringOption((o) => o.setName('assumptions').setDescription('Key assumptions required for the thesis to hold.').setMaxLength(800))
      .addStringOption((o) => o.setName('base_case').setDescription('Most reasonable expected path and evidence.').setMaxLength(800))
      .addStringOption((o) => o.setName('bull_case').setDescription('Conditions/evidence that would support the thesis.').setMaxLength(800))
      .addStringOption((o) => o.setName('bear_case').setDescription('Strongest counterargument and major risks.').setMaxLength(800))
      .addStringOption((o) => o.setName('invalidation').setDescription('Specific evidence that would invalidate the thesis.').setMaxLength(800))
      .addStringOption((o) => o.setName('catalysts').setDescription('Relevant catalysts, including verified dates.').setMaxLength(600))
      .addStringOption((o) => o.setName('source_urls').setDescription('At least one HTTPS evidence source; up to five, separated by spaces.').setMaxLength(2000))
      .addStringOption((o) => o.setName('assessment').setDescription('Your assessment after reviewing the thesis and evidence.').addChoices(
        { name: 'Thesis intact', value: 'thesis_intact' }, { name: 'Mixed evidence', value: 'mixed' }, { name: 'Thesis weakened', value: 'weakened' },
        { name: 'Invalidation condition met', value: 'invalidation_met' }, { name: 'Insufficient evidence', value: 'insufficient_evidence' }
      ))
      .addStringOption((o) => o.setName('assessment_notes').setDescription('Your evidence and reasoning (required when recording assessment).').setMaxLength(800)))
    .addSubcommand((s) => s.setName('catalyst').setDescription('Record or review manually sourced Stock catalyst context; no automatic signal effect. Admin only.')
      .addStringOption((o) => o.setName('action').setDescription('Catalyst action.').setRequired(true).addChoices(
        { name: 'List active/upcoming/retained', value: 'list' }, { name: 'Add classified catalyst', value: 'add' }, { name: 'Clear by symbol/id', value: 'clear' }
      ))
      .addStringOption((o) => o.setName('symbol').setDescription('U.S. ticker, * for market-wide, or event id when clearing.').setMaxLength(12))
      .addStringOption((o) => o.setName('reason').setDescription('Describe the catalyst and source evidence.').setMaxLength(300))
      .addStringOption((o) => o.setName('event_type').setDescription('Catalyst category.').addChoices(
        { name: 'Earnings', value: 'earnings' }, { name: 'Guidance', value: 'guidance' }, { name: 'FDA/regulatory', value: 'fda_regulatory' },
        { name: 'Merger/acquisition', value: 'merger_acquisition' }, { name: 'Contract', value: 'contract' }, { name: 'Product', value: 'product' },
        { name: 'Litigation', value: 'litigation' }, { name: 'SEC filing', value: 'sec_filing' }, { name: 'Offering/dilution', value: 'offering_dilution' },
        { name: 'Buyback', value: 'buyback' }, { name: 'Insider', value: 'insider' }, { name: 'Analyst', value: 'analyst' },
        { name: 'Leadership', value: 'leadership' }, { name: 'Macro', value: 'macro' }, { name: 'Other', value: 'other' }
      ))
      .addStringOption((o) => o.setName('direction').setDescription('Admin-assessed context, not a price forecast.').addChoices(
        { name: 'Positive', value: 'positive' }, { name: 'Negative', value: 'negative' }, { name: 'Neutral', value: 'neutral' }, { name: 'Unknown', value: 'unknown' }
      ))
      .addStringOption((o) => o.setName('expectedness').setDescription('Scheduled or unexpected.').addChoices(
        { name: 'Scheduled', value: 'scheduled' }, { name: 'Unexpected', value: 'unexpected' }, { name: 'Unknown', value: 'unknown' }
      ))
      .addStringOption((o) => o.setName('horizon').setDescription('Expected relevance window.').addChoices(
        { name: 'Intraday', value: 'intraday' }, { name: 'Swing', value: 'swing' }, { name: 'Long-term', value: 'long_term' }, { name: 'Unknown', value: 'unknown' }
      ))
      .addStringOption((o) => o.setName('impact').setDescription('Admin-assessed size; not a price target.').addChoices(
        { name: 'High', value: 'high' }, { name: 'Medium', value: 'medium' }, { name: 'Low', value: 'low' }, { name: 'Unknown', value: 'unknown' }
      ))
      .addStringOption((o) => o.setName('source_url').setDescription('Optional HTTPS source link.').setMaxLength(500))
      .addStringOption((o) => o.setName('starts_at').setDescription('Optional timezone-qualified ISO time; defaults to now.').setMaxLength(40))
      .addIntegerOption((o) => o.setName('duration_hours').setDescription('How long the catalyst is relevant (1–720 hours).').setMinValue(1).setMaxValue(720)))
    .addSubcommand((s) => s.setName('model').setDescription('Inspect or train the validated ensemble model.')
      .addStringOption((o) => o.setName('action').setDescription('Action.').setRequired(true).addChoices(
        { name: 'Status', value: 'status' }, { name: 'Train challenger (admin)', value: 'train' }
      )))
    .addSubcommand((s) => s.setName('status').setDescription('Show session, provider, scheduler, and cache status.'))
    .addSubcommand((s) => s.setName('diagnostics').setDescription('Show measured scan funnel, provider latency, and rejection reasons. Admin only.'))
    .addSubcommand((s) => s.setName('scan').setDescription('Run a stock screen. Admin only.')
      .addBooleanOption((o) => o.setName('force_provider').setDescription('Ignore the recent snapshot cache.')))
    .addSubcommand((s) => s.setName('watchlist').setDescription('View or change the screening universe. Admin changes only.')
      .addStringOption((o) => o.setName('action').setDescription('Action.').setRequired(true).addChoices(
        { name: 'Show', value: 'show' }, { name: 'Add symbols', value: 'add' },
        { name: 'Remove symbols', value: 'remove' }, { name: 'Reset defaults', value: 'reset' }
      ))
      .addStringOption((o) => o.setName('symbols').setDescription('Comma/space-separated tickers.').setMaxLength(500)))
    .addSubcommand((s) => s.setName('setup').setDescription('Assign channels and roles. Admin only.')
      .addChannelOption((o) => o.setName('signals_channel').setDescription('New stock setups.').addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addChannelOption((o) => o.setName('results_channel').setDescription('Graded outcomes.').addChannelTypes(ChannelType.GuildText))
      .addChannelOption((o) => o.setName('logs_channel').setDescription('Private health/provider logs.').addChannelTypes(ChannelType.GuildText))
      .addRoleOption((o) => o.setName('alert_role').setDescription('Optional signal notification role.'))
      .addRoleOption((o) => o.setName('admin_role').setDescription('Role to ping on provider failures.'))
      .addBooleanOption((o) => o.setName('scan_now').setDescription('Run the first scan now if the market session permits.')))
    .addSubcommand((s) => s.setName('configure').setDescription('Tune cadence and filters. Admin only.')
      .addIntegerOption((o) => o.setName('monitor_minutes').setDescription('Open setup refresh interval.').setMinValue(2).setMaxValue(30))
      .addIntegerOption((o) => o.setName('discovery_minutes').setDescription('New setup discovery interval.').setMinValue(5).setMaxValue(120))
      .addIntegerOption((o) => o.setName('minimum_score').setDescription('Minimum model score.').setMinValue(45).setMaxValue(95))
      .addIntegerOption((o) => o.setName('max_signals').setDescription('Maximum new setups each market day.').setMinValue(1).setMaxValue(12))
      .addIntegerOption((o) => o.setName('confirmation_scans').setDescription('Consecutive qualifying scans before a signal.').setMinValue(1).setMaxValue(5))
      .addIntegerOption((o) => o.setName('min_data_quality').setDescription('Minimum data-quality score.').setMinValue(30).setMaxValue(95))
      .addIntegerOption((o) => o.setName('earnings_blackout_days').setDescription('Avoid signals this many days before earnings.').setMinValue(0).setMaxValue(14))
      .addIntegerOption((o) => o.setName('slippage_bps').setDescription('Paper slippage per side, in basis points.').setMinValue(0).setMaxValue(100))
      .addIntegerOption((o) => o.setName('max_spread_bps').setDescription('Reject entries with a wider live spread.').setMinValue(5).setMaxValue(500))
      .addIntegerOption((o) => o.setName('model_min_samples').setDescription('Graded outcomes required before model training.').setMinValue(40).setMaxValue(10000))
      .addIntegerOption((o) => o.setName('ensemble_buy_percent').setDescription('Validated ensemble BUY probability threshold.').setMinValue(50).setMaxValue(95))
      .addIntegerOption((o) => o.setName('research_model_min_samples').setDescription('Per-horizon labels required for v4 training.').setMinValue(100).setMaxValue(1000000))
      .addIntegerOption((o) => o.setName('expert_min_samples').setDescription('Labels required for each regime expert.').setMinValue(60).setMaxValue(1000000))
      .addIntegerOption((o) => o.setName('model_embargo_minutes').setDescription('Gap between training and validation labels.').setMinValue(30).setMaxValue(1440))
      .addIntegerOption((o) => o.setName('model_lookback_days').setDescription('Recent days eligible for v4 training.').setMinValue(30).setMaxValue(1460))
      .addIntegerOption((o) => o.setName('max_sector_signals').setDescription('Maximum simultaneous setups from one sector.').setMinValue(1).setMaxValue(12))
      .addIntegerOption((o) => o.setName('max_correlation_percent').setDescription('Maximum pairwise return correlation.').setMinValue(20).setMaxValue(99))
      .addIntegerOption((o) => o.setName('min_portfolio_edge_hundredths_r').setDescription('Minimum utility in hundredths of R.').setMinValue(-100).setMaxValue(500))
      .addBooleanOption((o) => o.setName('allow_rule_only_signals').setDescription('Allow alerts before a validated model exists.'))
      .addIntegerOption((o) => o.setName('daily_loss_limit_r').setDescription('Daily paper-loss circuit breaker in R.').setMinValue(1).setMaxValue(20))
      .addIntegerOption((o) => o.setName('consecutive_loss_limit').setDescription('Consecutive losses before pausing signals.').setMinValue(1).setMaxValue(20))
      .addIntegerOption((o) => o.setName('sec_filing_blackout_hours').setDescription('Pause after high-impact SEC filings.').setMinValue(0).setMaxValue(168))
      .addIntegerOption((o) => o.setName('corporate_action_blackout_days').setDescription('Pause around corporate actions.').setMinValue(0).setMaxValue(30))
      .addIntegerOption((o) => o.setName('daily_hour').setDescription('Opening summary hour in bot timezone.').setMinValue(0).setMaxValue(23))
      .addIntegerOption((o) => o.setName('daily_minute').setDescription('Opening summary minute.').setMinValue(0).setMaxValue(59)))
    .addSubcommand((s) => s.setName('api-key').setDescription('Store or clear an optional stock provider key. Admin only.')
      .addStringOption((o) => o.setName('provider').setDescription('Provider.').setRequired(true).addChoices(
        { name: 'Alpha Vantage', value: 'alpha_vantage' }, { name: 'Finnhub', value: 'finnhub' },
        { name: 'Polygon', value: 'polygon' }, { name: 'Alpaca key ID', value: 'alpaca_key_id' },
        { name: 'Alpaca secret key', value: 'alpaca_secret_key' }, { name: 'FRED / ALFRED', value: 'fred' }
      ))
      .addStringOption((o) => o.setName('action').setDescription('Save or clear.').setRequired(true).addChoices(
        { name: 'Save', value: 'save' }, { name: 'Clear', value: 'clear' }
      ))
      .addStringOption((o) => o.setName('key').setDescription('API key; required when saving.').setMaxLength(512)))
    .addSubcommand((s) => s.setName('role').setDescription('Post the Stock Alerts opt-in panel. Admin only.'))
    .toJSON()];
}
