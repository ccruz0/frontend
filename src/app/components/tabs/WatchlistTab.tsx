/**
 * Watchlist Tab Component
 * Complete implementation with full table functionality
 */

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { TopCoin, TradingSignals, saveCoinSettings, updateWatchlistAlert, updateBuyAlert, updateSellAlert, StrategyDecision, updateCoinConfig, TradingConfig } from '@/app/api';
import { formatDateTime, formatNumber, normalizeSymbolKey } from '@/utils/formatting';
import { logger } from '@/utils/logger';
import { useWatchlist } from '@/hooks/useWatchlist';

interface WatchlistTabProps {
  botStatus: { is_running: boolean; status: 'running' | 'stopped'; reason: string | null; live_trading_enabled?: boolean; mode?: 'LIVE' | 'DRY_RUN' } | null;
  togglingLiveTrading: boolean;
  isUpdating: boolean;
  topCoinsLoading: boolean;
  portfolioLoading: boolean;
  dataSourceStatus: Record<string, { available: boolean; priority: number; response_time: number | null; last_check: string | null }> | null;
  fastQueueRateLimited: boolean;
  onToggleLiveTrading: () => Promise<void>;
  // Pass data from parent component
  topCoins?: TopCoin[];
  signals?: Record<string, TradingSignals | null>;
  coinTradeStatus?: Record<string, boolean>;
  coinMarginStatus?: Record<string, boolean>;
  coinAmounts?: Record<string, string>;
  coinSLPercent?: Record<string, string>;
  coinTPPercent?: Record<string, string>;
  coinBuyAlertStatus?: Record<string, boolean>;
  coinSellAlertStatus?: Record<string, boolean>;
  coinAlertStatus?: Record<string, boolean>;
  watchlistFilter?: string;
  onWatchlistFilterChange?: (filter: string) => void;
  tradingConfig?: TradingConfig | null;
  coinPresets?: Record<string, string>;
  onCoinPresetChange?: (symbol: string, preset: string) => void;
}

type SortField = 'symbol' | 'last_price' | 'rsi' | 'ema10' | 'ma50' | 'ma200' | 'volume' | 'amount_usd';
type SortDirection = 'asc' | 'desc';

export default function WatchlistTab({
  botStatus,
  togglingLiveTrading,
  isUpdating,
  topCoinsLoading,
  portfolioLoading,
  dataSourceStatus,
  fastQueueRateLimited,
  onToggleLiveTrading,
  topCoins: parentTopCoins,
  signals: parentSignals,
  coinTradeStatus: parentCoinTradeStatus,
  coinMarginStatus: parentCoinMarginStatus,
  coinAmounts: parentCoinAmounts,
  coinSLPercent: parentCoinSLPercent,
  coinTPPercent: parentCoinTPPercent,
  coinBuyAlertStatus: parentCoinBuyAlertStatus,
  coinSellAlertStatus: parentCoinSellAlertStatus,
  coinAlertStatus: parentCoinAlertStatus,
  watchlistFilter: parentWatchlistFilter,
  onWatchlistFilterChange,
  tradingConfig: parentTradingConfig,
  coinPresets: parentCoinPresets,
  onCoinPresetChange,
}: WatchlistTabProps) {
  const {
    topCoins: hookTopCoins,
    topCoinsLoading: watchlistLoading,
    lastTopCoinsFetchAt,
    coinTradeStatus: hookCoinTradeStatus,
    coinAmounts: hookCoinAmounts,
    coinSLPercent: hookCoinSLPercent,
    coinTPPercent: hookCoinTPPercent,
    coinBuyAlertStatus: hookCoinBuyAlertStatus,
    coinSellAlertStatus: hookCoinSellAlertStatus,
    coinAlertStatus: hookCoinAlertStatus,
    setCoinTradeStatus,
    setCoinAmounts,
    setCoinSLPercent,
    setCoinTPPercent,
    setCoinBuyAlertStatus,
    setCoinSellAlertStatus,
    setCoinAlertStatus,
  } = useWatchlist();

  // Use parent data if provided, otherwise use hook data
  const topCoins = parentTopCoins || hookTopCoins;
  const signals = parentSignals || {};
  const coinTradeStatus = parentCoinTradeStatus || hookCoinTradeStatus;
  const coinAmounts = parentCoinAmounts || hookCoinAmounts;
  const coinSLPercent = parentCoinSLPercent || hookCoinSLPercent;
  const coinTPPercent = parentCoinTPPercent || hookCoinTPPercent;
  const coinBuyAlertStatus = parentCoinBuyAlertStatus || hookCoinBuyAlertStatus;
  const coinSellAlertStatus = parentCoinSellAlertStatus || hookCoinSellAlertStatus;
  const coinAlertStatus = parentCoinAlertStatus || hookCoinAlertStatus;

  const [watchlistFilter, setWatchlistFilter] = useState(parentWatchlistFilter || '');
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [updatingCoins, setUpdatingCoins] = useState<Set<string>>(new Set());
  const [editingAmount, setEditingAmount] = useState<Record<string, string>>({});
  const [editingSLPercent, setEditingSLPercent] = useState<Record<string, string>>({});
  const [editingTPPercent, setEditingTPPercent] = useState<Record<string, string>>({});
  
  // Initialize margin status from parent or use empty object
  const [localCoinMarginStatus, setLocalCoinMarginStatus] = useState<Record<string, boolean>>(parentCoinMarginStatus || {});
  
  // Initialize coin presets from parent or use empty object
  const [localCoinPresets, setLocalCoinPresets] = useState<Record<string, string>>(parentCoinPresets || {});
  
  // Sync with parent when it changes
  useEffect(() => {
    if (parentCoinPresets) {
      setLocalCoinPresets(parentCoinPresets);
    }
  }, [parentCoinPresets]);
  
  // Sync with parent when it changes
  useEffect(() => {
    if (parentCoinMarginStatus) {
      setLocalCoinMarginStatus(parentCoinMarginStatus);
    }
  }, [parentCoinMarginStatus]);
  
  const coinMarginStatus = parentCoinMarginStatus || localCoinMarginStatus;

  // Filter coins
  const filteredCoins = useMemo(() => {
    if (!topCoins || topCoins.length === 0) return [];
    
    let filtered = topCoins;
    
    // Apply search filter
    if (watchlistFilter.trim()) {
      const filterUpper = watchlistFilter.trim().toUpperCase();
      filtered = filtered.filter(coin => 
        coin?.instrument_name.toUpperCase().includes(filterUpper)
      );
    }
    
    return filtered;
  }, [topCoins, watchlistFilter]);

  // Sort coins
  const sortedCoins = useMemo(() => {
    if (!sortField) return filteredCoins;
    
    const sorted = [...filteredCoins].sort((a, b) => {
      let aValue: number | string = 0;
      let bValue: number | string = 0;
      
      switch (sortField) {
        case 'symbol':
          aValue = a.instrument_name || '';
          bValue = b.instrument_name || '';
          break;
        case 'last_price':
          aValue = a.current_price || 0;
          bValue = b.current_price || 0;
          break;
        case 'rsi':
          aValue = signals[a.instrument_name]?.rsi || 0;
          bValue = signals[b.instrument_name]?.rsi || 0;
          break;
        case 'ema10':
          aValue = signals[a.instrument_name]?.ema10 || 0;
          bValue = signals[b.instrument_name]?.ema10 || 0;
          break;
        case 'ma50':
          aValue = signals[a.instrument_name]?.ma50 || 0;
          bValue = signals[b.instrument_name]?.ma50 || 0;
          break;
        case 'ma200':
          aValue = signals[a.instrument_name]?.ma200 || 0;
          bValue = signals[b.instrument_name]?.ma200 || 0;
          break;
        case 'volume':
          aValue = signals[a.instrument_name]?.volume_ratio || 0;
          bValue = signals[b.instrument_name]?.volume_ratio || 0;
          break;
        case 'amount_usd':
          aValue = parseFloat(coinAmounts[normalizeSymbolKey(a.instrument_name)] || '0');
          bValue = parseFloat(coinAmounts[normalizeSymbolKey(b.instrument_name)] || '0');
          break;
      }
      
      if (typeof aValue === 'string' && typeof bValue === 'string') {
        return sortDirection === 'asc' 
          ? aValue.localeCompare(bValue)
          : bValue.localeCompare(aValue);
      }
      
      return sortDirection === 'asc'
        ? (aValue as number) - (bValue as number)
        : (bValue as number) - (aValue as number);
    });
    
    return sorted;
  }, [filteredCoins, sortField, sortDirection, signals, coinAmounts]);

  const handleSort = useCallback((field: SortField) => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  }, [sortField]);

  const handleFilterChange = useCallback((value: string) => {
    setWatchlistFilter(value);
    if (onWatchlistFilterChange) {
      onWatchlistFilterChange(value);
    }
  }, [onWatchlistFilterChange]);

  const handleTradeToggle = useCallback(async (symbol: string) => {
    const symbolKey = normalizeSymbolKey(symbol);
    const currentStatus = coinTradeStatus[symbolKey] || false;
    const newStatus = !currentStatus;
    
    setUpdatingCoins(prev => new Set(prev).add(symbol));
    
    try {
      // Optimistic update
      setCoinTradeStatus(prev => ({ ...prev, [symbolKey]: newStatus }));
      
      // Save to backend
      await saveCoinSettings(symbol, {
        trade_enabled: newStatus,
      });
      
      logger.info(`✅ Trade status updated for ${symbol}: ${newStatus}`);
    } catch (err) {
      logger.error(`Failed to update trade status for ${symbol}:`, err);
      // Revert optimistic update
      setCoinTradeStatus(prev => ({ ...prev, [symbolKey]: currentStatus }));
    } finally {
      setUpdatingCoins(prev => {
        const next = new Set(prev);
        next.delete(symbol);
        return next;
      });
    }
  }, [coinTradeStatus, setCoinTradeStatus]);

  const handleAlertToggle = useCallback(async (symbol: string, alertType: 'master' | 'buy' | 'sell') => {
    const symbolKey = normalizeSymbolKey(symbol);
    setUpdatingCoins(prev => new Set(prev).add(symbol));
    
    try {
      if (alertType === 'master') {
        const currentStatus = coinAlertStatus[symbolKey] || false;
        const newStatus = !currentStatus;
        
        // Optimistic update
        setCoinAlertStatus(prev => ({ ...prev, [symbolKey]: newStatus }));
        
        await updateWatchlistAlert(symbol, newStatus);
        logger.info(`✅ Master alert status updated for ${symbol}: ${newStatus}`);
      } else if (alertType === 'buy') {
        const currentStatus = coinBuyAlertStatus[symbolKey] || false;
        const newStatus = !currentStatus;
        
        // Optimistic update
        setCoinBuyAlertStatus(prev => ({ ...prev, [symbolKey]: newStatus }));
        
        await updateBuyAlert(symbol, newStatus);
        logger.info(`✅ Buy alert status updated for ${symbol}: ${newStatus}`);
      } else if (alertType === 'sell') {
        const currentStatus = coinSellAlertStatus[symbolKey] || false;
        const newStatus = !currentStatus;
        
        // Optimistic update
        setCoinSellAlertStatus(prev => ({ ...prev, [symbolKey]: newStatus }));
        
        await updateSellAlert(symbol, newStatus);
        logger.info(`✅ Sell alert status updated for ${symbol}: ${newStatus}`);
      }
    } catch (err) {
      logger.error(`Failed to update ${alertType} alert for ${symbol}:`, err);
      // Revert would require storing previous state, simplified for now
    } finally {
      setUpdatingCoins(prev => {
        const next = new Set(prev);
        next.delete(symbol);
        return next;
      });
    }
  }, [coinAlertStatus, coinBuyAlertStatus, coinSellAlertStatus, setCoinAlertStatus, setCoinBuyAlertStatus, setCoinSellAlertStatus]);

  const handleMarginToggle = useCallback(async (symbol: string) => {
    const symbolKey = normalizeSymbolKey(symbol);
    const currentStatus = coinMarginStatus[symbolKey] || false;
    const newStatus = !currentStatus;
    
    setUpdatingCoins(prev => new Set(prev).add(symbol));
    
    try {
      // Optimistic update
      setLocalCoinMarginStatus(prev => ({ ...prev, [symbolKey]: newStatus }));
      
      // Save to backend
      await saveCoinSettings(symbol, {
        trade_on_margin: newStatus,
      });
      
      logger.info(`✅ Margin status updated for ${symbol}: ${newStatus}`);
    } catch (err) {
      logger.error(`Failed to update margin status for ${symbol}:`, err);
      // Revert optimistic update
      setLocalCoinMarginStatus(prev => ({ ...prev, [symbolKey]: currentStatus }));
    } finally {
      setUpdatingCoins(prev => {
        const next = new Set(prev);
        next.delete(symbol);
        return next;
      });
    }
  }, [coinMarginStatus]);

  const handleAmountSave = useCallback(async (symbol: string, value: string) => {
    const symbolKey = normalizeSymbolKey(symbol);
    setUpdatingCoins(prev => new Set(prev).add(symbol));
    
    try {
      const numValue = parseFloat(value);
      if (isNaN(numValue) || numValue < 0) {
        logger.warn(`Invalid amount value for ${symbol}: ${value}`);
        return;
      }
      
      // Optimistic update
      setCoinAmounts(prev => ({ ...prev, [symbolKey]: value }));
      
      // Save to backend
      await saveCoinSettings(symbol, {
        trade_amount_usd: numValue,
      });
      
      logger.info(`✅ Amount updated for ${symbol}: $${value}`);
    } catch (err) {
      logger.error(`Failed to update amount for ${symbol}:`, err);
      // Revert optimistic update
      setCoinAmounts(prev => {
        const updated = { ...prev };
        delete updated[symbolKey];
        return updated;
      });
    } finally {
      setUpdatingCoins(prev => {
        const next = new Set(prev);
        next.delete(symbol);
        return next;
      });
      setEditingAmount(prev => {
        const updated = { ...prev };
        delete updated[symbol];
        return updated;
      });
    }
  }, [setCoinAmounts]);

  const handleSLPercentSave = useCallback(async (symbol: string, value: string) => {
    const symbolKey = normalizeSymbolKey(symbol);
    setUpdatingCoins(prev => new Set(prev).add(symbol));
    
    try {
      const numValue = value === '' ? null : parseFloat(value);
      if (value !== '' && (isNaN(numValue!) || numValue! < 0)) {
        logger.warn(`Invalid SL% value for ${symbol}: ${value}`);
        return;
      }
      
      // Optimistic update
      setCoinSLPercent(prev => ({ ...prev, [symbolKey]: value }));
      
      // Save to backend
      await saveCoinSettings(symbol, {
        sl_percentage: numValue,
      });
      
      logger.info(`✅ SL% updated for ${symbol}: ${value || 'null'}`);
    } catch (err) {
      logger.error(`Failed to update SL% for ${symbol}:`, err);
    } finally {
      setUpdatingCoins(prev => {
        const next = new Set(prev);
        next.delete(symbol);
        return next;
      });
      setEditingSLPercent(prev => {
        const updated = { ...prev };
        delete updated[symbol];
        return updated;
      });
    }
  }, [setCoinSLPercent]);

  const handleTPPercentSave = useCallback(async (symbol: string, value: string) => {
    const symbolKey = normalizeSymbolKey(symbol);
    setUpdatingCoins(prev => new Set(prev).add(symbol));
    
    try {
      const numValue = value === '' ? null : parseFloat(value);
      if (value !== '' && (isNaN(numValue!) || numValue! < 0)) {
        logger.warn(`Invalid TP% value for ${symbol}: ${value}`);
        return;
      }
      
      // Optimistic update
      setCoinTPPercent(prev => ({ ...prev, [symbolKey]: value }));
      
      // Save to backend
      await saveCoinSettings(symbol, {
        tp_percentage: numValue,
      });
      
      logger.info(`✅ TP% updated for ${symbol}: ${value || 'null'}`);
    } catch (err) {
      logger.error(`Failed to update TP% for ${symbol}:`, err);
    } finally {
      setUpdatingCoins(prev => {
        const next = new Set(prev);
        next.delete(symbol);
        return next;
      });
      setEditingTPPercent(prev => {
        const updated = { ...prev };
        delete updated[symbol];
        return updated;
      });
    }
  }, [setCoinTPPercent]);

  // Handler for changing coin strategy
  const handleStrategyChange = useCallback(async (symbol: string, preset: string) => {
    const symbolKey = normalizeSymbolKey(symbol);
    setUpdatingCoins(prev => new Set(prev).add(symbol));
    
    try {
      // Update local state optimistically
      setLocalCoinPresets(prev => ({ ...prev, [symbolKey]: preset }));
      
      // Save to backend
      await updateCoinConfig(symbol, { preset });
      
      // Notify parent if callback provided
      if (onCoinPresetChange) {
        onCoinPresetChange(symbol, preset);
      }
      
      logger.info(`✅ Strategy updated for ${symbol}: ${preset}`);
    } catch (err) {
      logger.error(`Failed to update strategy for ${symbol}:`, err);
      // Revert on error
      setLocalCoinPresets(prev => {
        const updated = { ...prev };
        delete updated[symbolKey];
        return updated;
      });
    } finally {
      setUpdatingCoins(prev => {
        const next = new Set(prev);
        next.delete(symbol);
        return next;
      });
    }
  }, [onCoinPresetChange]);

  // Available strategy options
  const strategyOptions = [
    { value: 'swing-conservative', label: 'Swing Conservadora' },
    { value: 'swing-aggressive', label: 'Swing Agresiva' },
    { value: 'intraday-conservative', label: 'Intradia Conservadora' },
    { value: 'intraday-aggressive', label: 'Intradia Agresiva' },
    { value: 'scalp-conservative', label: 'Scalp Conservadora' },
    { value: 'scalp-aggressive', label: 'Scalp Agresiva' },
  ];

  // Helper function to format strategy name
  const formatStrategyName = useCallback((strategy?: string | null): string => {
    if (!strategy || typeof strategy !== 'string') return 'No strategy';
    // Format: "swing-conservative" -> "Swing Conservadora"
    const parts = strategy.split('-');
    const presetMap: Record<string, string> = {
      'swing': 'Swing',
      'intraday': 'Intradia',
      'scalp': 'Scalp'
    };
    const riskMap: Record<string, string> = {
      'conservative': 'Conservadora',
      'aggressive': 'Agresiva'
    };
    const preset = presetMap[parts[0]?.toLowerCase()] || parts[0] || 'Unknown';
    const risk = riskMap[parts[1]?.toLowerCase()] || parts[1] || '';
    return risk ? `${preset} ${risk}` : preset;
  }, []);

  // Helper function to determine if buy criteria are met
  const isBuyCriteriaMet = useCallback((signal: TradingSignals | null | undefined): boolean => {
    if (!signal) return false;
    // Check if buy signal is true
    return signal.signals?.buy === true;
  }, []);

  // Helper function to determine if sell criteria are met
  const isSellCriteriaMet = useCallback((signal: TradingSignals | null | undefined): boolean => {
    if (!signal) return false;
    // Check if sell signal is true
    return signal.signals?.sell === true;
  }, []);

  // Helper function to get strategy for a coin
  const getCoinStrategy = useCallback((coin: TopCoin, signal: TradingSignals | null | undefined): string | undefined => {
    const symbolKey = normalizeSymbolKey(coin?.instrument_name);
    // Priority: localCoinPresets > coin.strategy > signal.strategy > tradingConfig
    if (localCoinPresets[symbolKey]) {
      return localCoinPresets[symbolKey];
    }
    if (coin?.strategy) {
      return coin.strategy;
    }
    if (signal?.strategy) {
      return signal.strategy;
    }
    if (parentTradingConfig?.coins?.[symbolKey]?.preset) {
      return parentTradingConfig.coins[symbolKey].preset;
    }
    // Default to swing-conservative if no strategy is set
    return 'swing-conservative';
  }, [localCoinPresets, parentTradingConfig]);

  // Helper function to build strategy tooltip
  const buildStrategyTooltip = useCallback((coin: TopCoin, signal: TradingSignals | null | undefined): string => {
    const strategy = getCoinStrategy(coin, signal);
    const strategyName = formatStrategyName(strategy);
    const lines: string[] = [];
    lines.push(`📊 Estrategia: ${strategyName}`);
    
    if (signal) {
      lines.push('');
      lines.push('📈 Indicadores:');
      if (signal.rsi !== undefined) lines.push(`  • RSI: ${signal.rsi.toFixed(2)}`);
      if (signal.ema10 !== undefined) lines.push(`  • EMA10: $${formatNumber(signal.ema10, coin?.instrument_name)}`);
      if (signal.ma50 !== undefined) lines.push(`  • MA50: $${formatNumber(signal.ma50, coin?.instrument_name)}`);
      if (signal.ma200 !== undefined) lines.push(`  • MA200: $${formatNumber(signal.ma200, coin?.instrument_name)}`);
      if (signal.volume_ratio !== undefined) lines.push(`  • Volume Ratio: ${signal.volume_ratio.toFixed(2)}x`);
      
      lines.push('');
      lines.push('🎯 Señales:');
      lines.push(`  • BUY: ${signal.signals?.buy ? '✓' : '✗'}`);
      lines.push(`  • SELL: ${signal.signals?.sell ? '✓' : '✗'}`);
      
      if (signal.rationale && signal.rationale.length > 0) {
        lines.push('');
        lines.push('💡 Razón:');
        signal.rationale.forEach(r => lines.push(`  • ${r}`));
      }
    }
    
    return lines.join('\n');
  }, [formatStrategyName]);

  // Helper function to build trade button tooltip with all indicators
  const buildTradeTooltip = useCallback((coin: TopCoin, signal: TradingSignals | null | undefined): string => {
    const strategy = getCoinStrategy(coin, signal);
    const strategyName = formatStrategyName(strategy);
    const lines: string[] = [];
    lines.push(`📊 Estrategia: ${strategyName}`);
    lines.push('');
    lines.push('📈 Indicadores y Estado:');
    
    if (signal) {
      // RSI - check if below buy threshold (typically 40)
      const rsiOk = signal.rsi !== undefined && signal.rsi < 40;
      lines.push(`  • RSI: ${signal.rsi !== undefined ? signal.rsi.toFixed(2) : 'N/A'} ${rsiOk ? '✓' : '✗'}`);
      
      // EMA10 - always shown
      lines.push(`  • EMA10: ${signal.ema10 !== undefined ? `$${formatNumber(signal.ema10, coin?.instrument_name)}` : 'N/A'} ✓`);
      
      // MA50 - check if MA50 > EMA10
      const ma50Ok = signal.ma50 !== undefined && signal.ema10 !== undefined && signal.ma50 > signal.ema10;
      lines.push(`  • MA50: ${signal.ma50 !== undefined ? `$${formatNumber(signal.ma50, coin?.instrument_name)}` : 'N/A'} ${ma50Ok ? '✓' : '✗'}`);
      if (signal.ma50 !== undefined && signal.ema10 !== undefined) {
        lines.push(`    (MA50 ${signal.ma50 > signal.ema10 ? '>' : '<'} EMA10)`);
      }
      
      // MA200 - check if Price > MA200
      const ma200Ok = coin?.current_price !== undefined && signal.ma200 !== undefined && coin.current_price > signal.ma200;
      lines.push(`  • MA200: ${signal.ma200 !== undefined ? `$${formatNumber(signal.ma200, coin?.instrument_name)}` : 'N/A'} ${ma200Ok ? '✓' : '✗'}`);
      if (coin?.current_price !== undefined && signal.ma200 !== undefined) {
        lines.push(`    (Precio ${coin.current_price > signal.ma200 ? '>' : '<'} MA200)`);
      }
      
      // Volume Ratio
      const volumeOk = signal.volume_ratio !== undefined && signal.volume_ratio >= 0.5;
      lines.push(`  • Volume Ratio: ${signal.volume_ratio !== undefined ? `${signal.volume_ratio.toFixed(2)}x` : 'N/A'} ${volumeOk ? '✓' : '✗'}`);
      
      lines.push('');
      lines.push('🎯 Señales del Backend:');
      lines.push(`  • BUY: ${signal.signals?.buy ? '✓' : '✗'}`);
      lines.push(`  • SELL: ${signal.signals?.sell ? '✓' : '✗'}`);
      
      if (signal.rationale && signal.rationale.length > 0) {
        lines.push('');
        lines.push('💡 Razón:');
        signal.rationale.forEach(r => lines.push(`  • ${r}`));
      }
    } else {
      lines.push('  • Datos no disponibles');
    }
    
    return lines.join('\n');
  }, [formatStrategyName]);

  // Helper function to get indicator color class based on criteria
  const getIndicatorColorClass = useCallback((
    indicatorType: 'rsi' | 'ema10' | 'ma50' | 'ma200',
    signal: TradingSignals | null | undefined,
    coin: TopCoin
  ): string => {
    if (!signal) return 'text-gray-400';
    
    const isBuy = isBuyCriteriaMet(signal);
    const isSell = isSellCriteriaMet(signal);
    
    switch (indicatorType) {
      case 'rsi':
        // RSI should be low for buy, high for sell
        if (isBuy && signal.rsi !== undefined && signal.rsi < 40) return 'text-green-600 font-semibold';
        if (isSell && signal.rsi !== undefined && signal.rsi > 60) return 'text-red-600 font-semibold';
        return 'text-gray-600';
      case 'ema10':
        // EMA10 is always shown (neutral for now, can be enhanced)
        return isBuy ? 'text-green-600' : isSell ? 'text-red-600' : 'text-gray-600';
      case 'ma50':
        // MA50 > EMA10 for buy
        if (isBuy && signal.ma50 !== undefined && signal.ema10 !== undefined && signal.ma50 > signal.ema10) {
          return 'text-green-600 font-semibold';
        }
        return 'text-gray-600';
      case 'ma200':
        // Price > MA200 for buy
        if (isBuy && coin?.current_price !== undefined && signal.ma200 !== undefined && coin.current_price > signal.ma200) {
          return 'text-green-600 font-semibold';
        }
        return 'text-gray-600';
      default:
        return 'text-gray-600';
    }
  }, [isBuyCriteriaMet, isSellCriteriaMet]);

  // Helper function to build SL/TP tooltip
  const buildSLTPTooltip = useCallback((coin: TopCoin, signal: TradingSignals | null | undefined): string => {
    const strategy = getCoinStrategy(coin, signal);
    const strategyName = formatStrategyName(strategy);
    const lines: string[] = [];
    lines.push(`📊 Estrategia: ${strategyName}`);
    lines.push('');
    
    const symbolKey = normalizeSymbolKey(coin?.instrument_name);
    const slPercent = coinSLPercent[symbolKey];
    const tpPercent = coinTPPercent[symbolKey];
    
    // Show manual SL/TP if set, otherwise show calculated from strategy
    if (slPercent) {
      lines.push(`🛑 Stop Loss (manual): ${slPercent}%`);
    } else if (signal?.stop_loss_take_profit?.stop_loss) {
      const sl = signal.stop_loss_take_profit.stop_loss;
      lines.push(`🛑 Stop Loss:`);
      lines.push(`  • Conservadora: ${sl.conservative.percentage.toFixed(2)}%`);
      lines.push(`  • Agresiva: ${sl.aggressive.percentage.toFixed(2)}%`);
    }
    
    if (tpPercent) {
      lines.push(`🎯 Take Profit (manual): ${tpPercent}%`);
    } else if (signal?.stop_loss_take_profit?.take_profit) {
      const tp = signal.stop_loss_take_profit.take_profit;
      lines.push(`🎯 Take Profit:`);
      lines.push(`  • Conservadora: ${tp.conservative.percentage.toFixed(2)}%`);
      lines.push(`  • Agresiva: ${tp.aggressive.percentage.toFixed(2)}%`);
    }
    
    if (signal) {
      lines.push('');
      lines.push('📈 Indicadores actuales:');
      if (signal.rsi !== undefined) lines.push(`  • RSI: ${signal.rsi.toFixed(2)}`);
      if (signal.ema10 !== undefined) lines.push(`  • EMA10: $${formatNumber(signal.ema10, coin?.instrument_name)}`);
      if (signal.ma50 !== undefined) lines.push(`  • MA50: $${formatNumber(signal.ma50, coin?.instrument_name)}`);
      if (signal.ma200 !== undefined) lines.push(`  • MA200: $${formatNumber(signal.ma200, coin?.instrument_name)}`);
    }
    
    return lines.join('\n');
  }, [formatStrategyName, coinSLPercent, coinTPPercent]);

  const SortableHeader: React.FC<{ field: SortField; children: React.ReactNode }> = ({ field, children }) => (
    <th
      className="px-4 py-2 text-left cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800"
      onClick={() => handleSort(field)}
    >
      <div className="flex items-center gap-2">
        {children}
        {sortField === field && (
          <span>{sortDirection === 'asc' ? '↑' : '↓'}</span>
        )}
      </div>
    </th>
  );

  if (watchlistLoading && topCoins.length === 0) {
    return <div>Loading watchlist...</div>;
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold">Watchlist</h2>
          {lastTopCoinsFetchAt && (
            <div className="text-xs text-gray-500">
              🕐 {formatDateTime(lastTopCoinsFetchAt)}
            </div>
          )}
          {botStatus && (
            <>
              <div className={`px-3 py-1 rounded-full text-xs font-semibold ${
                botStatus.is_running 
                  ? 'bg-green-100 text-green-700' 
                  : 'bg-red-100 text-red-700'
              }`} title={botStatus.reason || undefined}>
                {botStatus.is_running ? '🟢 Bot Activo' : '🔴 Bot Detenido'}
              </div>
              <button
                onClick={onToggleLiveTrading}
                disabled={togglingLiveTrading || isUpdating || topCoinsLoading || portfolioLoading}
                className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
                  botStatus.live_trading_enabled
                    ? 'bg-green-600 text-white hover:bg-green-700'
                    : 'bg-gray-400 text-white hover:bg-gray-500'
                }`}
              >
                {togglingLiveTrading ? '⏳' : botStatus.live_trading_enabled ? '🟢 LIVE' : '🔴 DRY RUN'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Filter */}
      <div className="mb-4">
        <input
          type="text"
          placeholder="Filter by symbol..."
          value={watchlistFilter}
          onChange={(e) => handleFilterChange(e.target.value)}
          className="px-4 py-2 border border-gray-300 rounded-md w-full max-w-md"
        />
      </div>

      {sortedCoins.length === 0 ? (
        <div className="text-center py-12">
          <div className="text-gray-500 text-lg mb-2">No watchlist data available</div>
          <div className="text-gray-400 text-sm">The watchlist will appear here once data is loaded.</div>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-900">
              <tr>
                <SortableHeader field="symbol">Symbol</SortableHeader>
                <th className="px-4 py-2 text-left">Strategy</th>
                <SortableHeader field="last_price">Price</SortableHeader>
                <SortableHeader field="rsi">RSI</SortableHeader>
                <SortableHeader field="ema10">EMA10</SortableHeader>
                <SortableHeader field="ma50">MA50</SortableHeader>
                <SortableHeader field="ma200">MA200</SortableHeader>
                <SortableHeader field="volume">Volume</SortableHeader>
                <SortableHeader field="amount_usd">Amount USD</SortableHeader>
                <th className="px-4 py-2 text-left">SL%</th>
                <th className="px-4 py-2 text-left">TP%</th>
                <th className="px-4 py-2 text-left">Trade</th>
                <th className="px-4 py-2 text-left">Margin</th>
                <th className="px-4 py-2 text-left">Alerts</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {sortedCoins.map((coin) => {
                const symbolKey = normalizeSymbolKey(coin?.instrument_name);
                const signal = signals[coin?.instrument_name];
                const tradeEnabled = coinTradeStatus[symbolKey] || false;
                const masterAlertEnabled = coinAlertStatus[symbolKey] || false;
                const buyAlertEnabled = coinBuyAlertStatus[symbolKey] || false;
                const sellAlertEnabled = coinSellAlertStatus[symbolKey] || false;
                const isCoinUpdating = updatingCoins.has(coin?.instrument_name);
                
                // Determine if buy or sell criteria are met
                const buyCriteriaMet = isBuyCriteriaMet(signal);
                const sellCriteriaMet = isSellCriteriaMet(signal);
                
                // Get symbol color class based on criteria
                const symbolColorClass = buyCriteriaMet 
                  ? 'text-green-600 font-bold' 
                  : sellCriteriaMet 
                    ? 'text-red-600 font-bold' 
                    : 'font-medium';
                
                return (
                  <tr key={coin?.instrument_name} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                    <td 
                      className={`px-4 py-2 ${symbolColorClass} cursor-help`}
                      title={buildStrategyTooltip(coin, signal)}
                    >
                      {coin?.instrument_name}
                    </td>
                    <td className="px-4 py-2">
                      <select
                        value={getCoinStrategy(coin, signal) || 'swing-conservative'}
                        onChange={(e) => handleStrategyChange(coin?.instrument_name, e.target.value)}
                        disabled={isCoinUpdating}
                        className="px-2 py-1 text-xs border border-gray-300 rounded bg-white dark:bg-gray-700 dark:border-gray-600 dark:text-white disabled:opacity-50"
                        title="Select strategy for this coin"
                      >
                        {strategyOptions.map(option => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-2">${formatNumber(coin?.current_price, coin?.instrument_name)}</td>
                    <td className={`px-4 py-2 ${getIndicatorColorClass('rsi', signal, coin)}`}>
                      {signal?.rsi ? signal.rsi.toFixed(2) : '-'}
                    </td>
                    <td className={`px-4 py-2 ${getIndicatorColorClass('ema10', signal, coin)}`}>
                      {signal?.ema10 ? formatNumber(signal.ema10, coin?.instrument_name) : '-'}
                    </td>
                    <td className={`px-4 py-2 ${getIndicatorColorClass('ma50', signal, coin)}`}>
                      {signal?.ma50 ? formatNumber(signal.ma50, coin?.instrument_name) : '-'}
                    </td>
                    <td className={`px-4 py-2 ${getIndicatorColorClass('ma200', signal, coin)}`}>
                      {signal?.ma200 ? formatNumber(signal.ma200, coin?.instrument_name) : '-'}
                    </td>
                    <td className="px-4 py-2">
                      {signal?.volume_ratio ? `${signal.volume_ratio.toFixed(2)}x` : '-'}
                    </td>
                    <td className="px-4 py-2">
                      {editingAmount[coin?.instrument_name] !== undefined ? (
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={editingAmount[coin?.instrument_name]}
                          onChange={(e) => setEditingAmount(prev => ({ ...prev, [coin?.instrument_name]: e.target.value }))}
                          onBlur={() => {
                            const value = editingAmount[coin?.instrument_name];
                            if (value !== undefined) {
                              handleAmountSave(coin?.instrument_name, value);
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              const value = editingAmount[coin?.instrument_name];
                              if (value !== undefined) {
                                handleAmountSave(coin?.instrument_name, value);
                              }
                            } else if (e.key === 'Escape') {
                              setEditingAmount(prev => {
                                const updated = { ...prev };
                                delete updated[coin?.instrument_name];
                                return updated;
                              });
                            }
                          }}
                          className="w-20 px-2 py-1 border border-gray-300 rounded text-sm"
                          autoFocus
                        />
                      ) : (
                        <span
                          onClick={() => setEditingAmount(prev => ({ ...prev, [coin?.instrument_name]: coinAmounts[symbolKey] || '' }))}
                          className="cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 px-2 py-1 rounded border border-transparent hover:border-gray-300"
                          title="Click to edit Amount USD"
                        >
                          {coinAmounts[symbolKey] ? `$${coinAmounts[symbolKey]}` : '-'}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {editingSLPercent[coin?.instrument_name] !== undefined ? (
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={editingSLPercent[coin?.instrument_name]}
                          onChange={(e) => setEditingSLPercent(prev => ({ ...prev, [coin?.instrument_name]: e.target.value }))}
                          onBlur={() => {
                            const value = editingSLPercent[coin?.instrument_name];
                            if (value !== undefined) {
                              handleSLPercentSave(coin?.instrument_name, value);
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              const value = editingSLPercent[coin?.instrument_name];
                              if (value !== undefined) {
                                handleSLPercentSave(coin?.instrument_name, value);
                              }
                            } else if (e.key === 'Escape') {
                              setEditingSLPercent(prev => {
                                const updated = { ...prev };
                                delete updated[coin?.instrument_name];
                                return updated;
                              });
                            }
                          }}
                          className="w-16 px-2 py-1 border border-gray-300 rounded text-sm"
                          autoFocus
                          placeholder="%"
                        />
                      ) : (
                        <span
                          onClick={() => setEditingSLPercent(prev => ({ ...prev, [coin?.instrument_name]: coinSLPercent[symbolKey] || '' }))}
                          className="cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 px-2 py-1 rounded border border-transparent hover:border-gray-300 cursor-help"
                          title={buildSLTPTooltip(coin, signal)}
                        >
                          {coinSLPercent[symbolKey] ? `${coinSLPercent[symbolKey]}%` : '-'}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {editingTPPercent[coin?.instrument_name] !== undefined ? (
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={editingTPPercent[coin?.instrument_name]}
                          onChange={(e) => setEditingTPPercent(prev => ({ ...prev, [coin?.instrument_name]: e.target.value }))}
                          onBlur={() => {
                            const value = editingTPPercent[coin?.instrument_name];
                            if (value !== undefined) {
                              handleTPPercentSave(coin?.instrument_name, value);
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              const value = editingTPPercent[coin?.instrument_name];
                              if (value !== undefined) {
                                handleTPPercentSave(coin?.instrument_name, value);
                              }
                            } else if (e.key === 'Escape') {
                              setEditingTPPercent(prev => {
                                const updated = { ...prev };
                                delete updated[coin?.instrument_name];
                                return updated;
                              });
                            }
                          }}
                          className="w-16 px-2 py-1 border border-gray-300 rounded text-sm"
                          autoFocus
                          placeholder="%"
                        />
                      ) : (
                        <span
                          onClick={() => setEditingTPPercent(prev => ({ ...prev, [coin?.instrument_name]: coinTPPercent[symbolKey] || '' }))}
                          className="cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 px-2 py-1 rounded border border-transparent hover:border-gray-300 cursor-help"
                          title={buildSLTPTooltip(coin, signal)}
                        >
                          {coinTPPercent[symbolKey] ? `${coinTPPercent[symbolKey]}%` : '-'}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <button
                        onClick={() => handleTradeToggle(coin?.instrument_name)}
                        disabled={isCoinUpdating}
                        className={`px-3 py-1 rounded text-xs font-semibold transition-colors cursor-help ${
                          tradeEnabled
                            ? 'bg-green-500 text-white hover:bg-green-600'
                            : 'bg-red-500 text-white hover:bg-red-600'
                        } disabled:opacity-50`}
                        title={buildTradeTooltip(coin, signal)}
                      >
                        {isCoinUpdating ? '...' : tradeEnabled ? 'YES' : 'NO'}
                      </button>
                    </td>
                    <td className="px-4 py-2">
                      <button
                        onClick={() => handleMarginToggle(coin?.instrument_name)}
                        disabled={isCoinUpdating}
                        className={`px-3 py-1 rounded text-xs font-semibold transition-colors ${
                          coinMarginStatus[symbolKey]
                            ? 'bg-green-500 text-white hover:bg-green-600'
                            : 'bg-red-500 text-white hover:bg-red-600'
                        } disabled:opacity-50`}
                      >
                        {isCoinUpdating ? '...' : coinMarginStatus[symbolKey] ? 'YES' : 'NO'}
                      </button>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleAlertToggle(coin?.instrument_name, 'master')}
                          disabled={isCoinUpdating}
                          className={`px-2 py-1 rounded text-xs ${
                            masterAlertEnabled
                              ? 'bg-blue-500 text-white'
                              : 'bg-gray-300 text-gray-700'
                          } disabled:opacity-50`}
                          title="Master Alert"
                        >
                          M
                        </button>
                        <button
                          onClick={() => handleAlertToggle(coin?.instrument_name, 'buy')}
                          disabled={isCoinUpdating}
                          className={`px-2 py-1 rounded text-xs ${
                            buyAlertEnabled
                              ? 'bg-green-500 text-white'
                              : 'bg-gray-300 text-gray-700'
                          } disabled:opacity-50`}
                          title="Buy Alert"
                        >
                          B
                        </button>
                        <button
                          onClick={() => handleAlertToggle(coin?.instrument_name, 'sell')}
                          disabled={isCoinUpdating}
                          className={`px-2 py-1 rounded text-xs ${
                            sellAlertEnabled
                              ? 'bg-red-500 text-white'
                              : 'bg-gray-300 text-gray-700'
                          } disabled:opacity-50`}
                          title="Sell Alert"
                        >
                          S
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      
      <div className="mt-4 text-sm text-gray-500">
        Showing {sortedCoins.length} of {topCoins.length} coins
      </div>
    </div>
  );
}
