'use client';

import '@/lib/polyfill';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { getDashboard, getOpenOrders, getOrderHistory, getTopCoins, saveCoinSettings, getTradingSignals, getDataSourcesStatus, getTradingConfig, saveTradingConfig, updateCoinConfig, addCustomTopCoin, removeCustomTopCoin, getDashboardState, getDashboardSnapshot, quickOrder, updateWatchlistAlert, updateBuyAlert, updateSellAlert, simulateAlert, deleteDashboardItemBySymbol, toggleLiveTrading, getTPSLOrderValues, getOpenOrdersSummary, dashboardBalancesToPortfolioAssets, getExpectedTakeProfitSummary, getExpectedTakeProfitDetails, getTelegramMessages, DashboardState, DashboardBalance, WatchlistItem, OpenOrder, PortfolioAsset, TradingSignals, TopCoin, DataSourceStatus, TradingConfig, CoinSettings, TPSLOrderValues, UnifiedOpenOrder, OpenPosition, ExpectedTPSummary, ExpectedTPDetails, SimulateAlertResponse, TelegramMessage, StrategyDecision } from '@/lib/api';
import { getApiUrl } from '@/lib/environment';
import { MonitoringNotificationsProvider, useMonitoringNotifications } from '@/app/context/MonitoringNotificationsContext';

const TELEGRAM_REFRESH_INTERVAL_MS = 20000;

// Cleaned duplicate error handlers in alert toggle logic (handleMasterAlertToggle, updateBuyAlert, updateSellAlert)
// All try-catch blocks for alert toggles now have single, clean error handling paths

// Extended OpenOrder type for additional properties
type ExtendedOpenOrder = OpenOrder & {
  symbol?: string;
  cumulative_value?: number | string;
  order_value?: number | string;
  cumulative_quantity?: number | string;
  avg_price?: number | string;
  // UnifiedOpenOrder/metadata fields that may exist depending on endpoint/source
  trigger_type?: string | null;
  is_trigger?: boolean;
  raw?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

// Transform UnifiedOpenOrder[] to OpenPosition[]
function transformOrdersToPositions(orders: UnifiedOpenOrder[], portfolioAssets?: PortfolioAsset[]): OpenPosition[] {
  // Group orders by symbol and client_oid to find related orders
  const positionsMap = new Map<string, OpenPosition>();
  
  if (!orders || orders.length === 0) {
    // Silently return empty array if no orders (normal condition)
    return [];
  }
  
  // First pass: group SELL orders by symbol and client_oid (to find related TP/SL orders)
  const sellOrdersByClientOid = new Map<string, UnifiedOpenOrder[]>();
  
  orders.forEach(order => {
    if (order.side === 'SELL') {
      const clientOid = order.client_oid || `standalone-${order.order_id}`;
      if (!sellOrdersByClientOid.has(clientOid)) {
        sellOrdersByClientOid.set(clientOid, []);
      }
      sellOrdersByClientOid.get(clientOid)!.push(order);
    }
  });
  
    // Debug: transformOrdersToPositions (silenced to reduce console noise)
  
  // Second pass: create positions from grouped SELL orders
  sellOrdersByClientOid.forEach((sellOrders, clientOid) => {
    if (sellOrders.length === 0) return;
    
    // All orders should have the same symbol (they're related)
    const symbol = sellOrders[0].symbol;
    
    // Calculate totals for SELL orders (TP/SL)
    const totalQuantity = sellOrders.reduce((sum, o) => sum + (o.quantity || 0), 0);
    const totalValue = sellOrders.reduce((sum, o) => sum + ((o.quantity || 0) * (o.price || 0)), 0);
    const avgPrice = totalQuantity > 0 ? totalValue / totalQuantity : null;
    
    // Count TP and SL orders and find limit prices
    const tpOrders = sellOrders.filter(o => 
      o.order_type === 'TAKE_PROFIT_LIMIT' || 
      o.order_type === 'TAKE_PROFIT' ||
      (o.is_trigger && o.trigger_type === 'TAKE_PROFIT')
    );
    const slOrders = sellOrders.filter(o => 
      o.order_type === 'STOP_LOSS_LIMIT' || 
      o.order_type === 'STOP_LOSS' ||
      (o.is_trigger && o.trigger_type === 'STOP_LOSS')
    );
    
    // Find TP price (highest limit price from TP orders)
    const tpPrices = tpOrders
      .map(o => o.price)
      .filter((p): p is number => p !== null && p !== undefined && p > 0);
    const tpPrice = tpPrices.length > 0 ? Math.max(...tpPrices) : null;
    
    // Find SL price (lowest limit price from SL orders)
    const slPrices = slOrders
      .map(o => o.price)
      .filter((p): p is number => p !== null && p !== undefined && p > 0);
    const slPrice = slPrices.length > 0 ? Math.min(...slPrices) : null;
    
    // Get entry price from portfolio if available, otherwise use avgPrice from orders
    let entryPrice: number | null = null;
    let entryQuantity: number = totalQuantity;
    
    if (portfolioAssets && portfolioAssets.length > 0) {
      // Try to find matching asset in portfolio
      const portfolioAsset = portfolioAssets.find(asset => 
        asset.coin === symbol || asset.coin === symbol.split('_')[0]
      );
      
      if (portfolioAsset && portfolioAsset.balance > 0 && portfolioAsset.value_usd > 0) {
        // Calculate entry price from portfolio: value_usd / balance
        entryPrice = portfolioAsset.value_usd / portfolioAsset.balance;
        entryQuantity = portfolioAsset.balance;
      }
    }
    
    // Fallback to avgPrice if portfolio data not available
    if (entryPrice === null) {
      entryPrice = avgPrice;
    }
    
    // Calculate TP/SL profits
    let tpProfit: number | null = null;
    let slProfit: number | null = null;
    
    if (entryPrice !== null && entryQuantity > 0) {
      if (tpPrice !== null) {
        // Profit = (TP price * quantity) - (entry price * quantity)
        tpProfit = (tpPrice * entryQuantity) - (entryPrice * entryQuantity);
      }
      if (slPrice !== null) {
        // Loss = (SL price * quantity) - (entry price * quantity) (should be negative)
        slProfit = (slPrice * entryQuantity) - (entryPrice * entryQuantity);
      }
    }
    
    // Use entry price from portfolio for basePrice if available
    const basePrice = entryPrice || avgPrice;
    
    // Use the first order's client_oid as baseOrderId (or generate one)
    const baseOrderId = clientOid.startsWith('standalone-') 
      ? sellOrders[0].order_id 
      : clientOid;
    
    // Find the earliest created_at
    const createdAts = sellOrders.map(o => o.created_at).filter(Boolean) as string[];
    const baseCreatedAt = createdAts.length > 0 
      ? new Date(Math.min(...createdAts.map(d => new Date(d).getTime()))).toISOString()
      : new Date().toISOString();
    
    // Transform child orders
    const childOrders = sellOrders.map(order => ({
      orderId: order.order_id,
      side: 'SELL' as const,
      type: (order.order_type === 'TAKE_PROFIT_LIMIT' || order.order_type === 'TAKE_PROFIT' || (order.is_trigger && order.trigger_type === 'TAKE_PROFIT'))
        ? 'TAKE_PROFIT' as const
        : (order.order_type === 'STOP_LOSS_LIMIT' || order.order_type === 'STOP_LOSS' || (order.is_trigger && order.trigger_type === 'STOP_LOSS'))
        ? 'STOP_LOSS' as const
        : 'SELL' as const,
      quantity: order.quantity || 0,
      price: order.price,
      createdAt: order.created_at || new Date().toISOString()
    }));
    
    const positionKey = `${symbol}_${baseOrderId}`;
    
    // Create or update position
    positionsMap.set(positionKey, {
      symbol,
      baseOrderId,
      baseSide: 'BUY' as const, // We assume there was a BUY order that created this position
      baseQuantity: entryQuantity,
      basePrice: basePrice,
      baseTotal: basePrice !== null && entryQuantity > 0 ? basePrice * entryQuantity : null,
      baseCreatedAt,
      netOpenQuantity: entryQuantity, // Use entry quantity from portfolio
      positionQuantity: entryQuantity,
      tpCount: tpOrders.length,
      slCount: slOrders.length,
      tpPrice,
      slPrice,
      tpProfit,
      slProfit,
      childOrders
    });
  });
  
  const result = Array.from(positionsMap.values());
  // Debug: transformOrdersToPositions result (silenced to reduce console noise)
  return result;
}

export default function DashboardPage() {
  return (
    <MonitoringNotificationsProvider>
      <DashboardPageContent />
    </MonitoringNotificationsProvider>
  );
}
import MonitoringPanel from '@/app/components/MonitoringPanel';
import ErrorBoundary from '@/app/components/ErrorBoundary';
import { palette } from '@/theme/palette';

const REFRESH_FAST_MS = 15000; // 15 seconds for coins with Trade YES
const REFRESH_SLOW_MS = 60000; // 60 seconds (1 minute) for coins with Trade NO
const FAST_STAGGER_MS = 1000; // Increased from 500ms to 1000ms
const MAX_FAST_BACKOFF_MS = REFRESH_SLOW_MS * 4;
const RATE_LIMIT_STATUS = 429;
const FAST_BATCH_SIZE = 1; // Reduced from 2 to 1
const SLOW_BATCH_SIZE = 1; // Reduced from 2 to 1
const PORTFOLIO_UNAVAILABLE_MESSAGE = 'Portfolio data unavailable from backend. Please check API /dashboard/state, then retry.';

type ApiError = Error & {
  status?: number;
  retryAfterMs?: number;
};

type Loan = {
  borrowed_usd_value?: number;
  [key: string]: unknown;
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// WATCHLIST_PAGE_SIZE removed - not used (showing all coins in watchlist)

// Inline components for better compatibility
const Badge = ({ variant, children, className = '', title }: { variant: 'success' | 'danger' | 'warning' | 'neutral'; children: React.ReactNode; className?: string; title?: string }) => {
  const baseClasses = 'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs border';
  const variantClasses = {
    success: palette.badge.success,
    danger: palette.badge.danger,
    warning: palette.badge.warning,
    neutral: palette.badge.neutral,
  };
  return <span className={`${baseClasses} ${variantClasses[variant]} ${className}`} title={title}>{children}</span>;
};

// Helper function to format timestamps - uses browser's local timezone automatically
const formatTimestamp = (ts?: number | string | Date): string => {
  if (!ts) return 'N/A';
  let date: Date;
  
  if (ts instanceof Date) {
    date = ts;
  } else if (typeof ts === 'number') {
    // Timestamp in milliseconds - JavaScript Date interprets this as UTC
    date = new Date(ts);
  } else {
    // String - could be ISO format or custom format
    const str = String(ts);
    // If it's an ISO string (contains 'T' or ends with 'Z' or '+'), parse directly
    if (str.includes('T') || str.endsWith('Z') || str.includes('+') || str.includes('-', 10)) {
      date = new Date(str);
    } else {
      // Custom format like "2024-11-11 14:30:00 UTC" - treat as UTC
      // Remove "UTC" suffix and parse, then manually set as UTC
      const cleaned = str.replace(/\s+UTC$/, '').trim();
      if (cleaned.match(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/)) {
        // Format: YYYY-MM-DD HH:MM:SS - treat as UTC
        date = new Date(cleaned + 'Z'); // Add Z to indicate UTC
      } else {
        date = new Date(str);
      }
    }
  }
  
  if (isNaN(date.getTime())) return 'N/A';
  // Always use browser's local timezone with timezone name visible
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
};

// Helper function to format dates with time - always uses browser's local timezone
const formatDateTime = (date: Date): string => {
  if (!date || isNaN(date.getTime())) return 'N/A';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
};

// Helper function to format time only - uses browser's local timezone
const formatTime = (date: Date): string => {
  if (!date || isNaN(date.getTime())) return 'Never';
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  });
};

const Table = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => {
  const baseClasses = 'table-wrap rounded-2xl border shadow-sm bg-white dark:bg-slate-900 dark:border-slate-700';
  const combinedClasses = className ? baseClasses + ' ' + className : baseClasses;
  return (
    <div className={combinedClasses}>
      <table className="min-w-full text-sm text-gray-800 dark:text-slate-200 border-collapse">
        {children}
      </table>
    </div>
  );
};

const SkeletonBlock = ({ className = '' }: { className?: string }) => (
  <div className={`animate-pulse bg-gray-200 dark:bg-slate-700 rounded ${className}`} />
);

type Tab = 'portfolio' | 'watchlist' | 'signals' | 'orders' | 'expected-take-profit' | 'executed-orders' | 'version-history' | 'monitoring';

// Helper function to add thousand separators
function addThousandSeparators(numStr: string): string {
  const parts = numStr.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.join('.');
}

// Helper function to format numbers with correct decimals
function formatNumber(num: number | null | undefined, symbol?: string): string {
  if (num === null || num === undefined) return '-';
  
  // If number is 0, return "0.00"
  if (num === 0) return '0.00';
  
  let formatted: string;
  
  // Adaptive rounding based on price magnitude (matching backend logic)
  // For low-value coins like VET, show more decimal places for better precision
  // Backend uses: price_precision = 2 if current_price >= 100 else 4
  // We'll use similar logic but with more granular precision for better display
  
  if (num >= 100) {
    // High-value coins >= $100 - use 2 decimal places
    formatted = num.toFixed(2);
  } else if (num >= 1) {
    // Medium-value coins $1-$99 - use 2 decimal places
    formatted = num.toFixed(2);
  } else if (num >= 0.01) {
    // Low-value coins $0.01-$0.99 - use 6 decimal places
    formatted = num.toFixed(6);
  } else {
    // Very low-value coins < $0.01 - use 10 decimal places
    formatted = num.toFixed(10);
  }
  
  // For values < 0.01, preserve all decimal places (don't remove trailing zeros)
  // This ensures precision for low-value coins like VET, XLM, etc.
  if (num < 0.01) {
    // Don't remove trailing zeros for very small values - they're significant
    return addThousandSeparators(formatted);
  }
  
  // For values < 0.01, preserve all decimal places (don't remove trailing zeros)
  // This ensures precision for very low-value coins like VET, XLM, etc.
  if (num < 0.01) {
    // Don't remove trailing zeros for very small values - they're significant
    return addThousandSeparators(formatted);
  }
  
  // For values >= 0.01, remove trailing zeros but preserve minimum decimals based on value range
  const parts = formatted.split('.');
  if (parts.length === 2) {
    // Determine minimum decimals to keep based on value magnitude
    let minDecimals = 2;
    if (num >= 100) {
      minDecimals = 2; // Values >= $100: keep at least 2 decimals
    } else if (num >= 1) {
      minDecimals = 2; // Values $1-$99: keep at least 2 decimals
    } else if (num >= 0.01) {
      minDecimals = 6; // Values $0.01-$0.99: keep at least 6 decimals
    }
    
    // Remove trailing zeros but keep at least minDecimals
    const decimals = parts[1].replace(/0+$/, '');
    if (decimals.length === 0) {
      // If all decimals were zeros, keep at least minDecimals
      formatted = parts[0] + '.' + parts[1].substring(0, Math.min(minDecimals, parts[1].length)).padEnd(Math.min(minDecimals, parts[1].length), '0');
    } else {
      // Keep meaningful decimals, but ensure at least minDecimals
      if (decimals.length < minDecimals) {
        formatted = parts[0] + '.' + decimals.padEnd(minDecimals, '0');
      } else {
        formatted = parts[0] + '.' + decimals;
      }
    }
  }
  
  // Add thousand separators
  return addThousandSeparators(formatted);
}

// Fixed-decimal formatter for P/L summary cards
function formatPLSummaryNumber(num: number | null | undefined): string {
  if (num === null || num === undefined) return '-';
  return addThousandSeparators((num ?? 0).toFixed(1));
}

const HANDLED_ERROR_SUPPRESSION_MS = 30000;
const handledErrorTimestamps = new Map<string, number>();

function logHandledError(
  key: string,
  message: string,
  error: unknown,
  level: 'warn' | 'error' = 'warn'
): void {
  const now = Date.now();
  const lastLoggedAt = handledErrorTimestamps.get(key) ?? 0;
  if (now - lastLoggedAt < HANDLED_ERROR_SUPPRESSION_MS) {
    return;
  }
  handledErrorTimestamps.set(key, now);

  const logger = level === 'warn' ? console.warn : console.error;
  if (error instanceof Error) {
    logger(message, { name: error.name, message: error.message, stack: error.stack });
  } else {
    logger(message, error);
  }
}

// CRITICAL: Helper to normalize symbol keys to uppercase for consistent state access
// All state keys are stored in UPPERCASE (from backend loading and mount effect normalization)
// This ensures UI access via coin.instrument_name (which may be mixed case) always finds the correct state value
function normalizeSymbolKey(symbol: string | undefined | null): string {
  return symbol ? symbol.toUpperCase() : '';
}

// Strategy configuration types and constants (moved outside component)
type Preset = 'Swing' | 'Intraday' | 'Scalp';
type RiskMode = 'Conservative' | 'Aggressive';

type StrategyRules = {
  rsi: { buyBelow?: number; sellAbove?: number };
  maChecks: { ema10: boolean; ma50: boolean; ma200: boolean };
  sl: { pct?: number; atrMult?: number };     // si hay ATR, usar atrMult; si no, pct
  tp: { pct?: number; rr?: number };          // rr = risk:reward basado en SL
  volumeMinRatio?: number;                    // Minimum volume ratio (e.g., 0.5, 1, 1.5, 2)
  minPriceChangePct?: number;                 // Minimum price change % required for order creation/alerts (default: 1.0)
  alertCooldownMinutes?: number;              // Cooldown in minutes between same-side alerts (default: 5.0)
  notes?: string[];
};

type PresetConfig = Record<Preset, {
  notificationProfile: 'swing' | 'intraday' | 'scalp';
  rules: Record<RiskMode, StrategyRules>;
}>;

const PRESET_CONFIG: PresetConfig = {
  Swing: {
    notificationProfile: 'swing',
    rules: {
      Conservative: {
        rsi: { buyBelow: 40, sellAbove: 70 },
        maChecks: { ema10: true, ma50: true, ma200: true },
        sl: { atrMult: 1.5 },
        tp: { rr: 1.5 },
        volumeMinRatio: 0.5,
        minPriceChangePct: 1.0,
        alertCooldownMinutes: 5.0,
        notes: ['Operaciones multi-día', 'Confirmación MA50/MA200']
      },
      Aggressive: {
        rsi: { buyBelow: 45, sellAbove: 68 },
        maChecks: { ema10: true, ma50: true, ma200: true },
        sl: { atrMult: 1.0 },
        tp: { rr: 1.2 },
        volumeMinRatio: 0.5,
        minPriceChangePct: 1.0,
        alertCooldownMinutes: 5.0,
        notes: ['Entrada más temprana', 'SL más estrecho']
      }
    }
  },
  Intraday: {
    notificationProfile: 'intraday',
    rules: {
      Conservative: {
        rsi: { buyBelow: 45, sellAbove: 70 },
        maChecks: { ema10: true, ma50: true, ma200: false },
        sl: { atrMult: 1.0 },
        tp: { rr: 1.2 },
        volumeMinRatio: 0.5,
        minPriceChangePct: 1.0,
        notes: ['Cierra en el día', 'Evita overnight']
      },
      Aggressive: {
        rsi: { buyBelow: 50, sellAbove: 65 },
        maChecks: { ema10: true, ma50: true, ma200: false },
        sl: { atrMult: 0.8 },
        tp: { rr: 1.0 },
        volumeMinRatio: 0.5,
        minPriceChangePct: 1.0,
        alertCooldownMinutes: 5.0,
        notes: ['Más señales', 'Más ruido']
      }
    }
  },
  Scalp: {
    notificationProfile: 'scalp',
    rules: {
      Conservative: {
        rsi: { buyBelow: 50, sellAbove: 70 },
        maChecks: { ema10: true, ma50: false, ma200: false },
        sl: { pct: 0.5 },
        tp: { pct: 0.8 },
        volumeMinRatio: 0.5,
        minPriceChangePct: 1.0,
        alertCooldownMinutes: 5.0,
        notes: ['Movimientos muy cortos', 'Slippage importa']
      },
      Aggressive: {
        rsi: { buyBelow: 55, sellAbove: 65 },
        maChecks: { ema10: true, ma50: false, ma200: false },
        sl: { pct: 0.35 },
        tp: { pct: 0.5 },
        volumeMinRatio: 0.5,
        minPriceChangePct: 1.0,
        alertCooldownMinutes: 5.0,
        notes: ['Entradas anticipadas', 'Muchas micro-salidas']
      }
    }
  }
};

// Version history entries - each change gets a new version number (shared constant)
const VERSION_HISTORY = [
  {
    version: '0.1',
    date: '2024-11-04',
    change: 'Initial version history system implementation',
    details: 'Created version history tab with expandable sections to document all changes and improvements systematically.'
  },
  {
    version: '0.2',
    date: '2024-11-04',
    change: 'Fixed port conflict between gluetun and backend',
    details: 'Removed port 8002 from gluetun container port mappings. Backend now uses bridge network on port 8002 without conflicts.'
  },
  {
    version: '0.3',
    date: '2024-11-04',
    change: 'Updated frontend API URL configuration',
    details: 'Changed frontend environment.ts and .env.local to use port 8002 instead of 8000 for backend API calls.'
  },
  {
    version: '0.4',
    date: '2024-11-04',
    change: 'Fixed frontend port mapping conflict',
    details: 'Changed frontend port from 3000:3000 to 3001:3000 in docker-compose.yml to avoid conflict with gluetun.'
  },
  {
    version: '0.5',
    date: '2024-11-04',
    change: 'Optimized backend startup event',
    details: 'Refactored startup event to run database initialization in thread pool executor to avoid blocking the event loop.'
  },
  {
    version: '0.6',
    date: '2024-11-04',
    change: 'Made service startup non-blocking',
    details: 'Changed exchange_sync_service and signal_monitor_service to start in background tasks using asyncio.create_task() instead of await.'
  },
  {
    version: '0.7',
    date: '2024-11-04',
    change: 'Simplified health endpoint',
    details: 'Removed VPN status checks from health endpoint to prevent blocking. Health endpoint now returns immediately.'
  },
  {
    version: '0.8',
    date: '2024-11-04',
    change: 'Adjusted Docker health check configuration',
    details: 'Increased health check interval from 10s to 30s, timeout from 3s to 10s, and start_period from 20s to 60s to prevent restart loops.'
  },
  {
    version: '0.9',
    date: '2024-11-04',
    change: 'Removed blocking VPN gate check from startup',
    details: 'Moved VPN gate monitor to background task to prevent blocking startup event.'
  },
  {
    version: '0.10',
    date: '2024-11-04',
    change: 'Fixed watchlist settings persistence on refresh',
    details: 'Added useEffect hook to load all watchlist settings from localStorage on initial component mount to persist settings across page refreshes.'
  },
  {
    version: '0.11',
    date: '2024-11-04',
    change: 'Fixed margin status not saving',
    details: 'Added localStorage.setItem() to margin toggle onClick handler to persist trade_on_margin status across refreshes.'
  },
  {
    version: '0.12',
    date: '2024-11-04',
    change: 'Fixed Telegram bot connectivity',
    details: 'Removed backend from VPN network to allow Telegram API access. Added Telegram IP ranges to firewall outbound subnets.'
  },
  {
    version: '0.13',
    date: '2024-11-04',
    change: 'Fixed Telegram /start command',
    details: 'Fixed message formatting (Markdown to HTML) and ensured scheduler starts correctly as async task.'
  },
  {
    version: '0.14',
    date: '2024-11-04',
    change: 'Updated Telegram /status command',
    details: 'Updated /status command to show accurate data: active positions and tracked coins based on trade_enabled=True, individual trade amounts per coin, removed Paper Trading line.'
  },
  {
    version: '0.15',
    date: '2024-11-04',
    change: 'Fixed frontend network configuration',
    details: 'Removed frontend from VPN network and changed port to 3001:3000 to allow direct access to backend on bridge network.'
  },
  {
    version: '0.16',
    date: '2024-11-04',
    change: 'Implemented /analyze command with coin selection menu',
    details: 'Modified /analyze command to show a menu with all available coins for selection instead of requiring symbol as argument.'
  },
  {
    version: '0.17',
    date: '2024-11-04',
    change: 'Fixed backend startup blocking',
    details: 'Made all background services start in fire-and-forget tasks to prevent blocking HTTP requests during startup.'
  },
  {
    version: '0.18',
    date: '2024-11-04',
    change: 'Fixed CORS preflight requests',
    details: 'Explicitly enabled CORS middleware and configured it to allow all HTTP methods including OPTIONS requests.'
  },
  {
    version: '0.19',
    date: '2024-11-04',
    change: 'Fixed backend startup blocking issue',
    details: 'Completely refactored startup event to be fully non-blocking. All background services now start in fire-and-forget tasks, allowing the server to respond to requests immediately after startup completes.'
  },
  {
    version: '0.20',
    date: '2024-11-04',
    change: 'Fixed watchlist, portfolio, and orders not loading',
    details: 'Resolved backend API timeout issues that were preventing watchlist, portfolio, and order history from loading. Backend now responds immediately to all API requests after non-blocking startup completes.'
  },
  {
    version: '0.21',
    date: '2024-11-04',
    change: 'Fixed watchlist, portfolio, and orders not loading',
    details: 'Resolved backend API timeout issues by making database dependencies non-blocking. Watchlist now loads 21 coins, portfolio shows 19 balances, and orders display 8 open orders correctly.'
  },
  {
    version: '0.22',
    date: '2024-11-04',
    change: 'Simplified root and health endpoints to avoid blocking',
    details: 'Removed async/await and environment checks from root endpoint. Simplified health endpoint to return immediately without VPN status checks.'
  },
  {
    version: '0.23',
    date: '2024-11-04',
    change: 'Fixed indicators not loading in watchlist table',
    details: 'Modified updateTopCoins function to extract technical indicators (RSI, ATR, MA50, MA200, EMA10) from coin objects returned by backend and populate the signals object. The table was reading indicators from signals but they were only present in the coin object, causing all indicators to show as empty.'
  },
  {
    version: '0.24',
    date: '2024-11-04',
    change: 'Fixed SL/TP calculation and resistance levels extraction',
    details: 'Added res_up and res_down resistance levels to backend /market/top-coins-data endpoint and frontend TopCoin interface. Modified updateTopCoins to extract resistance levels from coin data. Fixed SL/TP calculation to work even when resistance levels are missing (uses fallback percentages). Ensured all coins are processed, not just those with complete indicator data.'
  },
  {
    version: '0.25',
    date: '2024-11-04',
    change: 'Fixed volume calculation in watchlist table',
    details: 'Added avg_volume and volume_ratio to backend /market/top-coins-data endpoint from MarketData model. Modified frontend to use pre-calculated volume_ratio from backend when available, instead of incorrectly calculating from volume_24h. This ensures accurate volume ratio display in the watchlist table.'
  },
  {
    version: '0.26',
    date: '2024-11-04',
    change: 'Fixed alert status update timeout issue',
    details: 'Added specific 10-second timeout for watchlist alert updates. Implemented optimistic UI updates with immediate localStorage persistence. Added fallback to saveCoinSettings if updateWatchlistAlert endpoint times out or fails. This ensures alert status updates are responsive and reliable even if the dedicated endpoint has issues.'
  },
  {
    version: '0.27',
    date: '2024-11-04',
    change: 'Increased timeout for top-coins-data endpoint',
    details: 'Increased timeout for /market/top-coins-data endpoint from 30s to 60s to allow backend to return all coins. Added better logging for deleted coins filtering to help debug why only 2 coins are showing. This should allow all 21 coins from the backend to load properly.'
  },
  {
    version: '0.28',
    date: '2024-11-04',
    change: 'Optimized initial page load for faster startup',
    details: 'Changed initial data loading from sequential to parallel. All endpoints (top coins, portfolio, orders, config) now load simultaneously instead of waiting for each other. Signal hydration now loads first batch immediately in parallel, then continues in background. This significantly reduces initial load time and ensures fresh data from backend tables is loaded immediately.'
  },
  {
    version: '0.29',
    date: '2024-11-04',
    change: 'Optimized backend database queries for faster response',
    details: 'Optimized /market/top-coins-data endpoint to only query MarketData for symbols that have MarketPrice records, instead of querying all MarketData. This reduces database query time significantly. Improved logging to show query performance and warn if queries take longer than 0.5 seconds. This ensures backend responds faster to initial page load requests.'
  },
  {
    version: '0.30',
    date: '2024-11-04',
    change: 'Optimized portfolio and open orders endpoints for faster response',
    details: 'Optimized get_portfolio_summary to use SQL aggregation (func.sum) for total_usd calculation instead of Python sum, reducing query time. Optimized open orders endpoint to limit results and add composite database index (status, create_time) for faster queries. Added performance logging to both endpoints to track query times and warn if they exceed 0.3 seconds. This significantly improves portfolio and open orders loading speed.'
  },
  {
    version: '0.31',
    date: '2024-11-04',
    change: 'Fixed /watchlist command in Telegram not showing coins with Trade=YES',
    details: 'Fixed POST /dashboard endpoint to update existing watchlist items instead of raising error when item already exists. This ensures that when frontend saves trade_enabled=True, it updates the existing item in database instead of failing. Added debug logging to /watchlist command to help diagnose issues. Now when user changes Trade=YES in frontend, it correctly saves to database and Telegram /watchlist command will show the coins.'
  },
  {
    version: '0.32',
    date: '2024-11-04',
    change: 'Added detailed logging to debug trade_enabled save issue',
    details: 'Added comprehensive logging to PUT /dashboard/{item_id} endpoint to log all received data, check if trade_enabled is present in request, and log the update process. This will help identify why trade_enabled is not being saved to database when user changes Trade=YES in frontend. Frontend now also logs the save process with try/catch to show any errors.'
  },
  {
    version: '0.4',
    date: '2025-11-13',
    change: 'Major Release: Advanced Portfolio Management & Profit/Loss Tracking',
    details: `🎉 VERSIÓN 0.4 - RELEASE PRINCIPAL

📊 **Sistema Completo de Profit/Loss (P/L)**
• Cálculo automático de P/L para todas las órdenes ejecutadas
• Algoritmo inteligente de emparejamiento de órdenes BUY/SELL:
  - Prioriza órdenes creadas simultáneamente (ventana de 5 minutos)
  - Fallback a emparejamiento por volumen similar (tolerancia 20%)
  - Soporte para órdenes parciales y múltiples ejecuciones
• Visualización de P/L realizado (órdenes vendidas) y potencial (no vendidas)
• Cálculo de porcentaje de ganancia/pérdida por orden
• Columna P/L en tabla de órdenes ejecutadas con colores (verde/rojo)

💰 **Resumen de P/L por Períodos**
• Resumen diario, semanal, mensual y anual de P/L
• Selectores interactivos para mes y año
• Desglose en tres métricas:
  - Realized P/L: Ganancias/pérdidas de órdenes ya ejecutadas (vendidas)
  - Potential P/L: Ganancias/pérdidas potenciales de posiciones abiertas (precio actual)
  - Total P/L: Suma de realized + potential
• Visualización con tarjetas de colores y formato monetario

📈 **Mejoras en Portfolio**
• Separación automática de pares USD y USDT (ej: DOGE_USD, DOGE_USDT)
• Cálculo independiente de balances y valores USD por par
• Expansión automática de monedas base a pares específicos cuando hay órdenes abiertas
• Exclusión de monedas fiat (USD, USDT) de la expansión
• Cálculo preciso de valores USD usando precios de mercado actuales

🔄 **Sistema de Actualización de Precios Mejorado**
• Reducción de cache de precios de 5 minutos a 1 minuto para actualizaciones más frecuentes
• Actualización automática de todos los coins cada 3 minutos (cada 3er slow tick)
• Corrección del market_updater para funcionar correctamente
• Fix de errores de sintaxis en market_updater.py y market_cache_storage.py
• Mejor manejo de errores en actualización de precios

🎯 **Mejoras en Open Orders**
• Visualización de TP (Take Profit) y SL (Stop Loss) en columnas separadas
• Cálculo preciso de valores TP/SL usando cumulative_value u order_value cuando disponible
• Conteo de órdenes abiertas por moneda
• Suma total de valores TP/SL por moneda

⚙️ **Mejoras en LIVE/DRY RUN Toggle**
• Mejor manejo de errores con mensajes descriptivos
• Validación de conexión a base de datos
• Verificación de existencia de tabla TradingSettings
• Mensajes de error mejorados para debugging

🐛 **Correcciones de Bugs**
• Fix de error de sintaxis en bloques catch del frontend
• Corrección de errores de indentación en market_updater.py
• Fix de problemas de actualización de precios para BTC_USD y otras monedas
• Mejora en la estabilidad del dashboard con mejor manejo de errores

🔧 **Mejoras Técnicas**
• Optimización de useMemo hooks para mejor rendimiento
• Mejor manejo de estados null/undefined
• Logging mejorado para debugging
• Código más robusto con try-catch en funciones críticas

📱 **Mejoras de UX**
• Interfaz más clara y organizada
• Mejor feedback visual para estados de carga
• Mensajes de error más informativos
• Navegación mejorada entre tabs`
  },
  {
    version: '0.45',
    date: '2025-11-23',
    change: 'AWS-First Development Migration & Telegram Routing',
    details: `🚀 VERSIÓN 0.45 - MIGRACIÓN AWS-FIRST

📋 **Migración Completa a AWS**
• Local Docker runtime completamente deshabilitado
• Todos los contenedores corren exclusivamente en AWS
• Scripts de auto-start locales bloqueados para prevenir ejecución accidental
• Desarrollo local ahora solo edita código, nunca ejecuta Docker

🔧 **Configuración de Ambiente**
• Añadido soporte para variable ENVIRONMENT (aws/local)
• Añadido soporte para variable RUN_TELEGRAM (true/false)
• Configuración AWS requiere ENVIRONMENT=aws y RUN_TELEGRAM=true
• Configuración local requiere ENVIRONMENT=local o ausente, RUN_TELEGRAM=false o ausente

📱 **Telegram Routing - AWS Only**
• Todos los mensajes de Telegram SOLO se envían desde AWS
• Desarrollo local NUNCA envía mensajes de Telegram (código compila pero calls son neutralizadas)
• TelegramNotifier verifica automáticamente:
  - Si está en AWS (ENVIRONMENT=aws o APP_ENV=aws)
  - Si RUN_TELEGRAM=true
  - Solo habilita Telegram si ambas condiciones se cumplen
• Local development: todas las llamadas a Telegram retornan False silenciosamente
• AWS: todas las alertas, confirmaciones, y notificaciones se envían normalmente

🔐 **Seguridad y Prevención de Errores**
• Protección múltiple contra envío accidental de Telegram desde local:
  - Verificación de ambiente al inicializar TelegramNotifier
  - Verificación en cada método send_* (aunque todos usan send_message internamente)
  - Logging claro cuando Telegram está deshabilitado
• Código local compila y ejecuta sin errores, pero Telegram nunca se envía

🔄 **Workflow de Desarrollo**
• Local: Editar código → Commit → Push
• AWS: Pull → Rebuild → Test → Deploy
• Todos los comandos Docker ahora se ejecutan via SSH en AWS
• Documentación REMOTE_DEV.md creada con workflow completo

📝 **Mejoras de Código**
• Corregido bug en main.py: watchlist initialization ahora rastrea correctamente símbolos procesados
• Todos los métodos de TelegramNotifier respetan self.enabled
• Mejor logging para debugging de estado de Telegram

🎯 **Preparación AWS**
• Verificado SSH connectivity a AWS
• Validado existencia de proyecto en AWS
• Preparado para pull de cambios y rebuild

📚 **Documentación**
• REMOTE_DEV.md creado con:
  - Local workflow (sin Docker)
  - Remote workflow (AWS)
  - Production workflow
  - Comandos canónicos para todas las operaciones
  - Sección explícita sobre prohibición de Telegram local`
  },
  {
    version: '0.46',
    date: '2025-12-15',
    change: 'Monitoring hooks fix & cache bust',
    details: `🚀 VERSIÓN 0.46 - FIX MONITORING HOOKS

📋 **Cambios**
• Reconstrucción forzada del frontend para tomar el fix de hooks
• Evita React error #310 en el tab Monitoring
• Limpieza de caché y despliegue completo

🔧 **Notas Técnicas**
• useMemo movido antes de cualquier return condicional
• Hooks alineados para cumplir las reglas de React
• Nueva versión para bust de caché en build

---
`
  }
];

// Helper function to get current version (must be defined before component)
function getCurrentVersion(): string {
  return VERSION_HISTORY[VERSION_HISTORY.length - 1].version;
}

function DashboardPageContent() {
  const { unreadCount: unreadMonitoringCount, handleNewMessages, markAllAsRead } = useMonitoringNotifications();
  const [activeTab, setActiveTab] = useState<Tab>('portfolio');
  const [loading, setLoading] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [portfolio, setPortfolio] = useState<{ assets: PortfolioAsset[], total_value_usd: number } | null>(null);
  const [totalBorrowed, setTotalBorrowed] = useState<number>(0);
  const [realBalances, setRealBalances] = useState<DashboardBalance[]>([]);
  const [topCoins, setTopCoins] = useState<TopCoin[]>([]);
  const [topCoinsLoading, setTopCoinsLoading] = useState(true);
  const [topCoinsError, setTopCoinsError] = useState<string | null>(null);
  const [lastTopCoinsFetchAt, setLastTopCoinsFetchAt] = useState<Date | null>(null);
  const [portfolioLoading, setPortfolioLoading] = useState(true);
  // const [portfolioLastUpdate, setPortfolioLastUpdate] = useState<Date | null>(null); // Not currently used
  const [openOrdersLoading, setOpenOrdersLoading] = useState(true);
  const [openOrdersLastUpdate, setOpenOrdersLastUpdate] = useState<Date | null>(null);
  const [openOrdersError, setOpenOrdersError] = useState<string | null>(null);
  const [executedOrdersLoading, setExecutedOrdersLoading] = useState(true); // Start as true to show loading on initial page load
  const [executedOrdersLastUpdate, setExecutedOrdersLastUpdate] = useState<Date | null>(null);
  const [executedOrdersError, setExecutedOrdersError] = useState<string | null>(null);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);
  const [botStatus, setBotStatus] = useState<{ is_running: boolean; status: 'running' | 'stopped'; reason: string | null; live_trading_enabled?: boolean; mode?: 'LIVE' | 'DRY_RUN' } | null>(null);
  const [togglingLiveTrading, setTogglingLiveTrading] = useState(false);
  const [openOrders, setOpenOrders] = useState<OpenOrder[]>([]);
  const [executedOrders, setExecutedOrders] = useState<OpenOrder[]>([]);
  const [_openOrdersSummary, setOpenOrdersSummary] = useState<UnifiedOpenOrder[]>([]);
  const [openOrdersPositions, setOpenOrdersPositions] = useState<OpenPosition[]>([]);
  const [_openOrdersSummaryLoading, setOpenOrdersSummaryLoading] = useState(true);
  const [_openOrdersSummaryLastUpdate, setOpenOrdersSummaryLastUpdate] = useState<Date | null>(null);
  const [expectedTPSummary, setExpectedTPSummary] = useState<ExpectedTPSummary[]>([]);
  const [expectedTPDetails, setExpectedTPDetails] = useState<ExpectedTPDetails | null>(null);
  const [expectedTPLoading, setExpectedTPLoading] = useState<boolean>(true);
  const [expectedTPDetailsLoading, setExpectedTPDetailsLoading] = useState<boolean>(false);
  const [expectedTPLastUpdate, setExpectedTPLastUpdate] = useState<Date | null>(null);
  const [expectedTPDetailsSymbol, setExpectedTPDetailsSymbol] = useState<string | null>(null);
  const [showExpectedTPDetailsDialog, setShowExpectedTPDetailsDialog] = useState<boolean>(false);
  const [telegramMessages, setTelegramMessages] = useState<TelegramMessage[]>([]);
  const [telegramMessagesLoading, setTelegramMessagesLoading] = useState<boolean>(false);
  const [snapshotStale, setSnapshotStale] = useState<boolean>(false);
  const [snapshotStaleSeconds, setSnapshotStaleSeconds] = useState<number | null>(null);
  const [snapshotLastUpdated, setSnapshotLastUpdated] = useState<Date | null>(null);
  // const [expandedPositions, setExpandedPositions] = useState<Set<string>>(new Set()); // Not currently used
  const [orderFilter, setOrderFilter] = useState({ symbol: '', status: '', side: '', startDate: '', endDate: '' });
  const [hideCancelled, setHideCancelled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const stored = window.localStorage.getItem('executedOrdersHideCancelled');
    return stored === null ? true : stored === 'true';
  });
  const [hideCancelledOpenOrders, setHideCancelledOpenOrders] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const stored = window.localStorage.getItem('openOrdersHideCancelled');
    return stored === null ? true : stored === 'true';
  });
  const [plPeriod, setPlPeriod] = useState<'daily' | 'weekly' | 'monthly' | 'yearly'>('daily');
  const [selectedMonth, setSelectedMonth] = useState<number>(new Date().getMonth());
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear());
  const [coinTradeStatus, setCoinTradeStatus] = useState<Record<string, boolean>>({});
  const [coinAlertStatus, setCoinAlertStatus] = useState<Record<string, boolean>>({});  // Legacy - kept for backward compatibility
  const [coinBuyAlertStatus, setCoinBuyAlertStatus] = useState<Record<string, boolean>>({});
  const [coinSellAlertStatus, setCoinSellAlertStatus] = useState<Record<string, boolean>>({});
  // Subtle "Saved" confirmation messages: { [symbol_type]: { type: 'success' | 'error', timestamp: number } }
  const [alertSavedMessages, setAlertSavedMessages] = useState<Record<string, { type: 'success' | 'error', timestamp: number }>>({});
  const savedMessageTimersRef = useRef<Record<string, NodeJS.Timeout>>({});
  const isInitialLoadRef = useRef<boolean>(true); // Track if we're in initial load phase
  const [coinAmounts, setCoinAmounts] = useState<Record<string, string>>({});
  const [coinSLPercent, setCoinSLPercent] = useState<Record<string, string>>({});
  const [coinTPPercent, setCoinTPPercent] = useState<Record<string, string>>({});
  const [calculatedSL, setCalculatedSL] = useState<Record<string, number>>({});
  const [calculatedTP, setCalculatedTP] = useState<Record<string, number>>({});
  const [showOverrideValues, setShowOverrideValues] = useState<Record<string, {sl: boolean, tp: boolean}>>({});
  const [editingFields, setEditingFields] = useState<Record<string, {sl: boolean, tp: boolean}>>({});
  const [newSymbol, setNewSymbol] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [signals, setSignals] = useState<Record<string, TradingSignals | null>>({});
  const [showSignalConfig, setShowSignalConfig] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [dataSourceStatus, setDataSourceStatus] = useState<DataSourceStatus | null>(null);
  const [tradingConfig, setTradingConfig] = useState<TradingConfig | null>(null);
  const [lastUpdateTimes, setLastUpdateTimes] = useState<{[key: string]: {price: Date, signals: Date}}>({});
  const lastUpdateTimesRef = useRef(lastUpdateTimes);
  const [_selectedPreset, setSelectedPreset] = useState('swing'); // Only setSelectedPreset is used
  const [coinPresets, setCoinPresets] = useState<Record<string, string>>({});
  const [showPresetTooltip, setShowPresetTooltip] = useState<string | null>(null);
  const [watchlistOrder, setWatchlistOrder] = useState<Record<string, number>>({});
  const [watchlistItems, setWatchlistItems] = useState<WatchlistItem[]>([]);
  const [tpSlOrderValues, setTpSlOrderValues] = useState<TPSLOrderValues>({});
  const [watchlistFilter, setWatchlistFilter] = useState<string>('');

  // Sorting state for each tab
  const [portfolioSort, setPortfolioSort] = useState<{ field: string | null; direction: 'asc' | 'desc' }>({ field: null, direction: 'asc' });
  const [watchlistSort, setWatchlistSort] = useState<{ field: string | null; direction: 'asc' | 'desc' }>({ field: null, direction: 'asc' });
  const [openOrdersSort, setOpenOrdersSort] = useState<{ field: string | null; direction: 'asc' | 'desc' }>({ field: null, direction: 'asc' });
  const [expectedTPSort, setExpectedTPSort] = useState<{ field: string | null; direction: 'asc' | 'desc' }>({ field: null, direction: 'asc' });
  const [executedOrdersSort, setExecutedOrdersSort] = useState<{ field: string | null; direction: 'asc' | 'desc' }>({ field: null, direction: 'asc' });

  // Sorting utility function
  const handleSort = useCallback((
    field: string,
    sortState: { field: string | null; direction: 'asc' | 'desc' },
    setSortState: React.Dispatch<React.SetStateAction<{ field: string | null; direction: 'asc' | 'desc' }>>
  ) => {
    if (sortState.field === field) {
      // Toggle direction if same field
      setSortState({ field, direction: sortState.direction === 'asc' ? 'desc' : 'asc' });
    } else {
      // New field, start with ascending
      setSortState({ field, direction: 'asc' });
    }
  }, []);

  // Generic sorting function
  const sortData = useCallback(<T,>(
    data: T[],
    field: string | null,
    direction: 'asc' | 'desc',
    getValue: (item: T, field: string) => unknown
  ): T[] => {
    if (!field) return data;
    
    return [...data].sort((a, b) => {
      const aVal = getValue(a, field);
      const bVal = getValue(b, field);
      
      // Handle null/undefined values
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      
      // Handle numbers
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return direction === 'asc' ? aVal - bVal : bVal - aVal;
      }
      
      // Handle strings
      const aStr = String(aVal).toLowerCase();
      const bStr = String(bVal).toLowerCase();
      if (direction === 'asc') {
        return aStr < bStr ? -1 : aStr > bStr ? 1 : 0;
      } else {
        return aStr > bStr ? -1 : aStr < bStr ? 1 : 0;
      }
    });
  }, []);

  // Sortable header component
  const SortableHeader = ({ 
    field, 
    children, 
    sortState, 
    setSortState, 
    className = '' 
  }: { 
    field: string; 
    children: React.ReactNode; 
    sortState: { field: string | null; direction: 'asc' | 'desc' };
    setSortState: React.Dispatch<React.SetStateAction<{ field: string | null; direction: 'asc' | 'desc' }>>;
    className?: string;
  }) => {
    const isActive = sortState.field === field;
    const direction = isActive ? sortState.direction : null;
    
    return (
      <th 
        className={`${className} cursor-pointer select-none hover:bg-gray-600 transition-colors`}
        onClick={() => handleSort(field, sortState, setSortState)}
        title={`Click to sort by ${field}`}
      >
        <div className="flex items-center gap-1">
          <span>{children}</span>
          {direction === 'asc' && <span className="text-xs">▲</span>}
          {direction === 'desc' && <span className="text-xs">▼</span>}
          {!isActive && <span className="text-xs text-gray-400">⇅</span>}
        </div>
      </th>
    );
  };

  const persistAlertFlag = useCallback(
    (
      setter: React.Dispatch<React.SetStateAction<Record<string, boolean>>>,
      storageKey: string,
      symbolKey: string,
      value: boolean
    ) => {
      setter(prev => {
        const updated = { ...prev };
        if (value) {
          updated[symbolKey] = value;
        } else {
          delete updated[symbolKey];
        }
        try {
          localStorage.setItem(storageKey, JSON.stringify(updated));
        } catch (err) {
          console.warn(`Failed to persist ${storageKey}:`, err);
        }
        return updated;
      });
    },
    []
  );

  const handleMasterAlertToggle = useCallback(
    async (symbol: string) => {
      const normalizedSymbol = symbol.toUpperCase();
      const previousBuy = coinBuyAlertStatus[normalizedSymbol] ?? false;
      const previousSell = coinSellAlertStatus[normalizedSymbol] ?? false;
      const storedMaster = coinAlertStatus[normalizedSymbol];
      const previousMaster =
        storedMaster !== undefined ? storedMaster : previousBuy || previousSell;
      const newStatus = !previousMaster;

      const applyState = (masterValue: boolean, buyValue: boolean, sellValue: boolean) => {
        persistAlertFlag(setCoinAlertStatus, 'watchlist_alert_status', normalizedSymbol, masterValue);
        persistAlertFlag(setCoinBuyAlertStatus, 'watchlist_buy_alert_status', normalizedSymbol, buyValue);
        persistAlertFlag(setCoinSellAlertStatus, 'watchlist_sell_alert_status', normalizedSymbol, sellValue);
      };

      applyState(newStatus, newStatus, newStatus);

      const messageKey = `${normalizedSymbol}_alerts`;

      try {
        const baseResponse = await updateWatchlistAlert(normalizedSymbol, newStatus, {
          buyAlertEnabled: newStatus,
          sellAlertEnabled: newStatus,
        });
        const [buyResponse, sellResponse] = await Promise.all([
          updateBuyAlert(normalizedSymbol, newStatus),
          updateSellAlert(normalizedSymbol, newStatus)
        ]);

        const resolvedMaster =
          baseResponse?.alert_enabled !== undefined ? baseResponse.alert_enabled : newStatus;
        const resolvedBuy =
          buyResponse?.buy_alert_enabled !== undefined ? buyResponse.buy_alert_enabled : newStatus;
        const resolvedSell =
          sellResponse?.sell_alert_enabled !== undefined ? sellResponse.sell_alert_enabled : newStatus;

        applyState(!!resolvedMaster, !!resolvedBuy, !!resolvedSell);

        setAlertSavedMessages(prev => ({
          ...prev,
          [messageKey]: { type: 'success', timestamp: Date.now() }
        }));
        if (savedMessageTimersRef.current[messageKey]) {
          clearTimeout(savedMessageTimersRef.current[messageKey]);
        }
        savedMessageTimersRef.current[messageKey] = setTimeout(() => {
          setAlertSavedMessages(prev => {
            const updated = { ...prev };
            delete updated[messageKey];
            return updated;
          });
          delete savedMessageTimersRef.current[messageKey];
        }, 2500);
      } catch (error) {
        const errorObj = error as { detail?: string; message?: string };
        console.error(`❌ Failed to toggle alerts for ${normalizedSymbol}:`, error);
        applyState(previousMaster, previousBuy, previousSell);
        const errorMsg = errorObj.detail || errorObj.message || 'Error desconocido';
        alert(`Error updating alerts for ${normalizedSymbol}: ${errorMsg}`);
      }
    },
    [coinAlertStatus, coinBuyAlertStatus, coinSellAlertStatus, persistAlertFlag]
  );

  const fetchTelegramMessages = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent ?? false;
      if (!silent) {
        setTelegramMessagesLoading(true);
      }
      try {
        const response = await getTelegramMessages();
        const messages = response.messages || [];
        setTelegramMessages(messages);
        handleNewMessages(messages);
      } catch (err) {
        console.error('Failed to fetch Telegram messages:', err);
      } finally {
        if (!silent) {
          setTelegramMessagesLoading(false);
        }
      }
    },
    [handleNewMessages]
  );
  
  // Strategy presets configuration state (editable)
  const [presetsConfig, setPresetsConfig] = useState<PresetConfig>(() => PRESET_CONFIG);
  const [selectedConfigPreset, setSelectedConfigPreset] = useState<Preset>('Swing');
  const [selectedConfigRisk, setSelectedConfigRisk] = useState<RiskMode>('Conservative');
  const topCoinsRef = useRef<TopCoin[]>([]); // Keep ref to latest topCoins
  const schedulerRef = useRef<{
    fastTimer: ReturnType<typeof setTimeout> | null;
    slowTimer: ReturnType<typeof setTimeout> | null;
    fastBackoffMs: number;
    fastPausedUntil: number;
    fastErrorCount: number;
    slowErrorCount: number;
    slowBackoffMs: number;
    slowTickCount: number;
  }>({
    fastTimer: null,
    slowTimer: null,
    fastBackoffMs: REFRESH_FAST_MS,
    fastPausedUntil: 0,
    fastErrorCount: 0,
    slowErrorCount: 0,
    slowBackoffMs: REFRESH_SLOW_MS,
    slowTickCount: 0,
  });
  const fastQueueRef = useRef<string[]>([]);
  const slowQueueRef = useRef<string[]>([]);
  const lastFastErrorRef = useRef<ApiError | null>(null);
  const [fastQueueRateLimited, setFastQueueRateLimited] = useState(false);
  const activeJobsRef = useRef(0);
  const markJobStart = useCallback(() => {
    activeJobsRef.current += 1;
    setIsUpdating(true);
  }, []);
  const markJobEnd = useCallback(() => {
    activeJobsRef.current = Math.max(0, activeJobsRef.current - 1);
    if (activeJobsRef.current === 0) {
      setIsUpdating(false);
    }
  }, []);
  // Helper function to check if an order status is cancelled, rejected, or expired
  // NOTE: FILLED orders are NOT considered cancelled - they are valid executed orders
  // Must be defined before useMemo hooks that use it to avoid TDZ (Temporal Dead Zone) errors
  // Wrapped in useCallback to ensure stable reference for dependency arrays
  const isCancelledStatus = useCallback((status: string | null | undefined): boolean => {
    if (!status) return false;
    const normalized = status.toUpperCase();
    // Include only statuses that should be hidden when "Ocultar Canceladas" is ON:
    // - CANCELLED/CANCELED: explicitly cancelled orders
    // - REJECTED: orders that were rejected by the exchange
    // - EXPIRED: orders that expired
    // DO NOT include FILLED - those are valid executed orders that should be shown
    return normalized === 'CANCELLED' || 
           normalized === 'CANCELED' || 
           normalized === 'REJECTED' || 
           normalized === 'EXPIRED';
  }, []);

  const coinMembershipSignature = useMemo(
    () => {
      // Defensive check: ensure topCoins is an array and not undefined/null
      if (!topCoins || !Array.isArray(topCoins) || topCoins.length === 0) return '';
      try {
        return topCoins
          .map((coin) => coin?.instrument_name)
          .filter((name): name is string => Boolean(name))
          .sort()
          .join('|');
      } catch (err) {
        console.error('Error in coinMembershipSignature:', err);
        return '';
      }
    },
    [topCoins]
  );
  const filteredOpenOrders = useMemo(() => {
    // Defensive check: ensure openOrders is an array
    if (!Array.isArray(openOrders)) return [];
    // Sort orders by creation date (newest first)
    const sortedOrders = [...openOrders].sort((a, b) => {
      const aTime = a.create_time || 0;
      const bTime = b.create_time || 0;
      // Convert to numbers if they're strings
      const aNum = typeof aTime === 'number' ? aTime : (typeof aTime === 'string' ? new Date(aTime).getTime() : 0);
      const bNum = typeof bTime === 'number' ? bTime : (typeof bTime === 'string' ? new Date(bTime).getTime() : 0);
      return bNum - aNum; // Descending order (newest first)
    });
    
    return sortedOrders.filter(order => {
      // Filter out cancelled orders if hideCancelledOpenOrders is true
      if (hideCancelledOpenOrders && isCancelledStatus(order.status)) {
        return false;
      }
      
      const matchesSymbol = !orderFilter.symbol || order.instrument_name.toLowerCase().includes(orderFilter.symbol.toLowerCase());
      const matchesStatus = !orderFilter.status || order.status === orderFilter.status;
      const matchesSide = !orderFilter.side || order.side === orderFilter.side;
      
      // Date filtering
      let matchesDate = true;
      if (orderFilter.startDate || orderFilter.endDate) {
        // Get order date from create_time (timestamp in milliseconds)
        const orderDate = order.create_time 
          ? (typeof order.create_time === 'number' ? new Date(order.create_time) : new Date(order.create_time))
          : null;
        
        if (orderDate && !isNaN(orderDate.getTime())) {
          // Set time to start of day for comparison
          const orderDateOnly = new Date(orderDate.getFullYear(), orderDate.getMonth(), orderDate.getDate());
          
          if (orderFilter.startDate) {
            const startDate = new Date(orderFilter.startDate);
            startDate.setHours(0, 0, 0, 0);
            if (orderDateOnly < startDate) {
              matchesDate = false;
            }
          }
          
          if (orderFilter.endDate && matchesDate) {
            const endDate = new Date(orderFilter.endDate);
            endDate.setHours(23, 59, 59, 999);
            if (orderDateOnly > endDate) {
              matchesDate = false;
            }
          }
        } else {
          // If order has no valid date and date filter is set, exclude it
          matchesDate = false;
        }
      }
      
      return matchesSymbol && matchesStatus && matchesSide && matchesDate;
    });
  }, [openOrders, orderFilter, hideCancelledOpenOrders, isCancelledStatus]);
  // Helper function to calculate profit/loss for an executed order
  const calculateProfitLoss = useCallback((order: OpenOrder, allOrders: OpenOrder[]): { pnl: number; pnlPercent: number; isRealized: boolean } => {
    const orderSymbol = order.instrument_name;
    const orderSide = order.side?.toUpperCase();
    const orderPrice = parseFloat(order.price || order.avg_price || order.filled_price || '0');
    const orderQuantity = parseFloat(order.quantity || order.filled_quantity || order.cumulative_quantity || '0');
    const orderTime = order.update_time || order.create_time || 0;
    
    if (orderSide === 'SELL' && orderPrice > 0 && orderQuantity > 0) {
      // Strategy: 
      // 1. First, try to find a BUY order CREATED at the same time (paired orders like TP/SL)
      // 2. If no paired order, find an old BUY order with similar volume (within 20% difference)
      
      const TIME_WINDOW_MS = 5 * 60 * 1000; // 5 minutes tolerance for creation time matching
      const VOLUME_TOLERANCE = 0.20; // 20% tolerance for volume matching
      
      const orderCreateTime = order.create_time || orderTime;
      
      // Get all BUY orders for this symbol
      const allBuyOrders = allOrders
        .filter(o => 
          o.instrument_name === orderSymbol &&
          o.side?.toUpperCase() === 'BUY' &&
          o.status === 'FILLED'
        );
      
      if (allBuyOrders.length > 0) {
        let matchedBuyOrder: OpenOrder | null = null;
        let matchType: 'paired' | 'similar_volume' | null = null;
        
        // Step 1: Look for BUY order CREATED at the same time (paired orders)
        const pairedBuyOrders = allBuyOrders.filter(buyOrder => {
          const buyCreateTime = buyOrder.create_time || buyOrder.update_time || 0;
          const timeDiff = Math.abs(orderCreateTime - buyCreateTime);
          return timeDiff <= TIME_WINDOW_MS;
        });
        
        if (pairedBuyOrders.length > 0) {
          // If multiple paired orders, prefer the one with most similar volume
          matchedBuyOrder = pairedBuyOrders.reduce((best, current) => {
            const bestQty = parseFloat(best.quantity || best.filled_quantity || best.cumulative_quantity || '0');
            const currentQty = parseFloat(current.quantity || current.filled_quantity || current.cumulative_quantity || '0');
            const bestDiff = Math.abs(bestQty - orderQuantity);
            const currentDiff = Math.abs(currentQty - orderQuantity);
            return currentDiff < bestDiff ? current : best;
          });
          matchType = 'paired';
        } else {
          // Step 2: Look for old BUY order with similar volume (within 20% tolerance)
          const similarVolumeBuyOrders = allBuyOrders
            .filter(buyOrder => {
              const buyQty = parseFloat(buyOrder.quantity || buyOrder.filled_quantity || buyOrder.cumulative_quantity || '0');
              if (buyQty <= 0) return false;
              const volumeDiff = Math.abs(buyQty - orderQuantity) / orderQuantity;
              return volumeDiff <= VOLUME_TOLERANCE;
            })
            .sort((a, b) => {
              // Prefer older orders (executed before this SELL)
              const aTime = a.update_time || a.create_time || 0;
              const bTime = b.update_time || b.create_time || 0;
              // Prefer orders executed before the SELL
              if (aTime < orderTime && bTime >= orderTime) return -1;
              if (bTime < orderTime && aTime >= orderTime) return 1;
              // Among orders before SELL, prefer the most recent
              if (aTime < orderTime && bTime < orderTime) return bTime - aTime;
              // Among orders after SELL, prefer the oldest
              return aTime - bTime;
            });
          
          if (similarVolumeBuyOrders.length > 0) {
            matchedBuyOrder = similarVolumeBuyOrders[0];
            matchType = 'similar_volume';
          }
        }
        
        if (matchedBuyOrder) {
          const buyPrice = parseFloat(matchedBuyOrder.price || matchedBuyOrder.avg_price || matchedBuyOrder.filled_price || '0');
          const buyQty = parseFloat(matchedBuyOrder.quantity || matchedBuyOrder.filled_quantity || matchedBuyOrder.cumulative_quantity || '0');
          
          if (buyPrice > 0 && buyQty > 0) {
            const sellValue = orderPrice * orderQuantity;
            const buyValue = buyPrice * orderQuantity;
            const pnl = sellValue - buyValue;
            const pnlPercent = buyPrice > 0 ? ((orderPrice - buyPrice) / buyPrice) * 100 : 0;
            
            // Debug logging
            if (orderSymbol === 'ETH_USD' && orderPrice === 3649.25) {
              const buyCreateTime = matchedBuyOrder.create_time || matchedBuyOrder.update_time || 0;
              const sellCreateTime = order.create_time || orderTime;
              console.log(`📊 P/L Calculation for ETH_USD SELL:`, {
                sellOrder_id: order.order_id,
                sellQty: orderQuantity,
                sellPrice: orderPrice,
                sellValue: sellValue,
                sellCreateTime: sellCreateTime,
                matchType: matchType,
                matchedBuyOrder: {
                  order_id: matchedBuyOrder.order_id,
                  buyPrice: buyPrice,
                  buyQty: buyQty,
                  buyCreateTime: buyCreateTime,
                  createTimeDiff: Math.abs(sellCreateTime - buyCreateTime)
                },
                buyValue: buyValue,
                pnl: pnl,
                pnlPercent: pnlPercent,
                calculation: `(${orderPrice} - ${buyPrice.toFixed(2)}) × ${orderQuantity} = ${pnl.toFixed(2)}`
              });
            }
            
            // General logging for all SELL orders
            const buyCreateTime = matchedBuyOrder.create_time || matchedBuyOrder.update_time || 0;
            const sellCreateTime = order.create_time || orderTime;
            console.log(`💰 P/L for ${orderSymbol} SELL (${orderQuantity} @ ${orderPrice}):`, {
              matchType: matchType,
              matchedBuyOrder_id: matchedBuyOrder.order_id,
              buyPrice: buyPrice.toFixed(2),
              buyQty: buyQty,
              createTimeDiff: Math.abs(sellCreateTime - buyCreateTime),
              pnl: pnl.toFixed(2),
              pnlPercent: pnlPercent.toFixed(2) + '%'
            });
            
            return { pnl, pnlPercent, isRealized: true };
          }
        }
      }
    } else if (orderSide === 'BUY' && orderPrice > 0 && orderQuantity > 0) {
      // BUY orders only show theoretical P/L (not counted in realized P/L)
      // Calculate theoretical P/L using current market price
      const coin = topCoins.find(c => c.instrument_name === orderSymbol);
      if (coin && coin.current_price > 0) {
        const currentValue = coin.current_price * orderQuantity;
        const buyValue = orderPrice * orderQuantity;
        const pnl = currentValue - buyValue;
        const pnlPercent = orderPrice > 0 ? ((coin.current_price - orderPrice) / orderPrice) * 100 : 0;
        
        // Always return isRealized: false for BUY orders (theoretical P/L only)
        return { pnl, pnlPercent, isRealized: false };
      }
    }
    
    return { pnl: 0, pnlPercent: 0, isRealized: false };
  }, [topCoins]);

  const filteredExecutedOrders = useMemo(() => {
    // Defensive check: ensure executedOrders is an array
    if (!Array.isArray(executedOrders)) return [];
    const filtered = executedOrders.filter(order => {
      // Filter out cancelled/rejected/expired orders if hideCancelled is true
      // BUT NOT FILLED orders - those are the main executed orders we want to show
      if (hideCancelled && order.status) {
        const normalized = order.status.toUpperCase();
        // Only hide CANCELLED, REJECTED, EXPIRED - NOT FILLED
        // CRITICAL: FILLED orders should ALWAYS be shown in Executed Orders tab
        if (normalized === 'CANCELLED' || 
            normalized === 'CANCELED' || 
            normalized === 'REJECTED' || 
            normalized === 'EXPIRED') {
          return false; // Filter out cancelled/rejected/expired
        }
        // Explicitly allow FILLED orders to pass through
        if (normalized === 'FILLED') {
          return true; // Always show FILLED orders
        }
      }
      
      const matchesSymbol = !orderFilter.symbol || order.instrument_name.toLowerCase().includes(orderFilter.symbol.toLowerCase());
      const matchesStatus = !orderFilter.status || order.status === orderFilter.status;
      const matchesSide = !orderFilter.side || order.side === orderFilter.side;
      
      // Date filtering
      let matchesDate = true;
      if (orderFilter.startDate || orderFilter.endDate) {
        // Get order date from update_time or create_time (timestamp in milliseconds)
        const orderDate = order.update_time 
          ? (typeof order.update_time === 'number' ? new Date(order.update_time) : new Date(order.update_time))
          : (order.create_time 
            ? (typeof order.create_time === 'number' ? new Date(order.create_time) : new Date(order.create_time))
            : null);
        
        if (orderDate && !isNaN(orderDate.getTime())) {
          // Set time to start of day for comparison
          const orderDateOnly = new Date(orderDate.getFullYear(), orderDate.getMonth(), orderDate.getDate());
          
          if (orderFilter.startDate) {
            const startDate = new Date(orderFilter.startDate);
            startDate.setHours(0, 0, 0, 0);
            if (orderDateOnly < startDate) {
              matchesDate = false;
            }
          }
          
          if (orderFilter.endDate && matchesDate) {
            const endDate = new Date(orderFilter.endDate);
            endDate.setHours(23, 59, 59, 999);
            if (orderDateOnly > endDate) {
              matchesDate = false;
            }
          }
        } else {
          // If order has no valid date and date filter is set, exclude it
          matchesDate = false;
        }
      }
      
      return matchesSymbol && matchesStatus && matchesSide && matchesDate;
    });
    // Debug: Log filtered orders to help diagnose filtering issues
    if (filtered.length === 0 && executedOrders.length > 0) {
      console.warn(`⚠️ All ${executedOrders.length} executed orders were filtered out. Sample statuses:`, 
        executedOrders.slice(0, 5).map(o => o.status));
    }
    return filtered;
  }, [executedOrders, orderFilter, hideCancelled]);
  
  // Calculate total P&L for filtered orders (only SELL orders count as realized P/L)
  const filteredTotalPL = useMemo(() => {
    // Defensive checks: ensure dependencies are initialized
    if (!Array.isArray(filteredExecutedOrders) || !Array.isArray(executedOrders) || typeof calculateProfitLoss !== 'function') {
      return 0;
    }
    let totalPL = 0;
    filteredExecutedOrders.forEach(order => {
      if (order.side?.toUpperCase() === 'SELL') {
        const pnlData = calculateProfitLoss(order, executedOrders);
        if (pnlData.isRealized) {
          totalPL += pnlData.pnl;
        }
      }
    });
    return totalPL;
  }, [filteredExecutedOrders, executedOrders, calculateProfitLoss]);
  
  // Calculate P/L Summary
  const plSummary = useMemo(() => {
    try {
      const now = new Date();
      let startDate: Date;
      let endDate: Date = new Date();
      
      if (plPeriod === 'daily') {
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      } else if (plPeriod === 'weekly') {
        const dayOfWeek = now.getDay();
        const diff = now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
        startDate = new Date(now.getFullYear(), now.getMonth(), diff);
      } else if (plPeriod === 'monthly') {
        startDate = new Date(selectedYear, selectedMonth, 1);
        endDate = new Date(selectedYear, selectedMonth + 1, 0, 23, 59, 59);
      } else {
        startDate = new Date(selectedYear, 0, 1);
        endDate = new Date(selectedYear, 11, 31, 23, 59, 59);
      }
      
      const startTime = startDate.getTime();
      const endTime = endDate.getTime();
      
      let realizedPL = 0;
      // Additional defensive check
      if (Array.isArray(executedOrders) && executedOrders.length > 0 && typeof calculateProfitLoss === 'function') {
        const realizedOrders = executedOrders.filter(order => {
          if (!order || order.side?.toUpperCase() !== 'SELL' || order.status !== 'FILLED') return false;
          const orderTime = order.update_time || order.create_time || 0;
          return orderTime >= startTime && orderTime <= endTime;
        });
        
        realizedOrders.forEach(order => {
          try {
            const pnlData = calculateProfitLoss(order, executedOrders);
            if (pnlData && pnlData.isRealized) {
              realizedPL += pnlData.pnl || 0;
            }
          } catch {
            // Silently skip P/L calculation errors for individual orders
          }
        });
      }
      
      // Potential P/L: Theoretical gains from open positions purchased TODAY (not executed/sold yet)
      let potentialPL = 0;
      if (executedOrders && executedOrders.length > 0 && topCoins && topCoins.length > 0 && portfolio?.assets) {
        // For daily period, calculate potential P/L from open positions bought today
        const buyOrdersToday = executedOrders.filter(order => {
          if (!order || order.side?.toUpperCase() !== 'BUY' || order.status !== 'FILLED') return false;
          const orderTime = order.update_time || order.create_time || 0;
          return orderTime >= startTime && orderTime <= endTime;
        });
        
        // Check each buy order from today to see if position is still open
        buyOrdersToday.forEach(order => {
          try {
            const orderSymbol = order.instrument_name;
            const orderPrice = parseFloat(order.price || order.avg_price || order.filled_price || '0');
            const orderQuantity = parseFloat(order.quantity || order.filled_quantity || order.cumulative_quantity || '0');
            
            if (orderPrice <= 0 || orderQuantity <= 0) return;
            
            // Find matching portfolio asset to get current balance
            const portfolioAsset = portfolio.assets.find(a => {
              const assetSymbol = a.coin?.toUpperCase() || '';
              // Match by base currency (e.g., BTC_USDT matches BTC)
              const orderBase = orderSymbol.split('_')[0].toUpperCase();
              return assetSymbol === orderBase || assetSymbol === orderSymbol.toUpperCase();
            });
            
            // Only calculate if we have a portfolio balance (position is still open)
            if (portfolioAsset && portfolioAsset.balance > 0) {
              // Get current price from topCoins
              const coin = topCoins.find(c => c && c.instrument_name === orderSymbol || c?.instrument_name?.startsWith(orderSymbol.split('_')[0] + '_'));
              if (coin && coin.current_price > 0) {
                // Check if this order was already sold (has matching SELL order after today)
                const wasSold = executedOrders.some(sellOrder => {
                  if (!sellOrder || sellOrder.side?.toUpperCase() !== 'SELL' || sellOrder.instrument_name !== orderSymbol) return false;
                  const sellTime = sellOrder.update_time || sellOrder.create_time || 0;
                  const buyTime = order.update_time || order.create_time || 0;
                  return sellTime > buyTime && sellTime <= endTime;
                });
                
                // Only calculate if position is still open (not sold yet)
                if (!wasSold) {
                  // Calculate P/L based on quantity bought TODAY, not full portfolio balance
                  // Use the smaller of orderQuantity or portfolio balance (in case partial sell)
                  const quantityStillOpen = Math.min(orderQuantity, portfolioAsset.balance);
                  const currentValue = coin.current_price * quantityStillOpen;
                  const buyValue = orderPrice * quantityStillOpen;
                potentialPL += currentValue - buyValue;
              }
            }
            }
          } catch {
            // Silently skip potential P/L calculation errors for individual orders
          }
        });
      }
      
      return { realizedPL, potentialPL, totalPL: realizedPL + potentialPL };
    } catch (err) {
      console.error('Error calculating P/L summary:', err);
      return { realizedPL: 0, potentialPL: 0, totalPL: 0 };
    }
  }, [plPeriod, selectedMonth, selectedYear, executedOrders, topCoins, calculateProfitLoss]);

  const orderedWatchlistCoins = useMemo(() => {
    // Defensive check: ensure topCoins is an array
    if (!Array.isArray(topCoins) || topCoins.length === 0) {
      // Silently return empty array during initial load
      return [];
    }

    // Note: LDO_USD availability check removed - debug logs were cluttering console

    const coinsCopy = [...topCoins];
    coinsCopy.sort((a, b) => {
      const aTradeEnabled = coinTradeStatus[a.instrument_name] || false;
      const bTradeEnabled = coinTradeStatus[b.instrument_name] || false;

      if (aTradeEnabled && !bTradeEnabled) return -1;
      if (!aTradeEnabled && bTradeEnabled) return 1;

      const orderA = watchlistOrder[a.instrument_name];
      const orderB = watchlistOrder[b.instrument_name];

      if (orderA !== undefined || orderB !== undefined) {
        const normalizedA = orderA ?? Number.MAX_SAFE_INTEGER;
        const normalizedB = orderB ?? Number.MAX_SAFE_INTEGER;
        if (normalizedA !== normalizedB) {
          return normalizedA - normalizedB;
        }
      }

      return (a.rank || 0) - (b.rank || 0);
    });
    return coinsCopy;
  }, [topCoins, coinTradeStatus, watchlistOrder]);

  const watchlistPositionMap = useMemo(() => {
    if (!orderedWatchlistCoins.length) {
      return {};
    }
    return orderedWatchlistCoins.reduce<Record<string, number>>((acc, coin, index) => {
      acc[coin.instrument_name] = index;
      return acc;
    }, {});
  }, [orderedWatchlistCoins]);

  // Sorted portfolio data
  const sortedPortfolioData = useMemo(() => {
    if (!portfolio || !portfolio.assets || portfolio.assets.length === 0) {
      return [];
    }
    
    if (!portfolioSort.field) {
      // Default sort by USD value descending (original behavior)
      return [...portfolio.assets].sort((a, b) => (b.value_usd ?? 0) - (a.value_usd ?? 0));
    }
    
    return sortData(portfolio.assets, portfolioSort.field, portfolioSort.direction, (item, field) => {
      switch (field) {
        case 'coin':
          return item.coin || '';
        case 'balance':
          return item.balance ?? 0;
        case 'reserved':
          return item.reserved_qty ?? 0;
        case 'usd_value':
          return item.value_usd ?? 0;
        case 'percent':
          const totalValue = portfolio.total_value_usd ?? 0;
          return totalValue > 0 ? ((item.value_usd ?? 0) / totalValue) * 100 : 0;
        default:
          return 0;
      }
    });
  }, [portfolio, portfolioSort, sortData]);

  // Sorted open orders data
  const sortedOpenOrdersData = useMemo(() => {
    if (!filteredOpenOrders || filteredOpenOrders.length === 0) {
      return [];
    }
    
    if (!openOrdersSort.field) {
      return filteredOpenOrders;
    }
    
    return sortData(filteredOpenOrders, openOrdersSort.field, openOrdersSort.direction, (item, field) => {
      switch (field) {
        case 'created_date':
          return item.create_time ?? 0;
        case 'symbol':
          return item.instrument_name || '';
        case 'side':
          return item.side || '';
        case 'type':
          return item.order_type || '';
        case 'quantity':
          return parseFloat(item.quantity || '0');
        case 'price':
          return parseFloat(item.price || '0');
        case 'status':
          return item.status || '';
        default:
          return 0;
      }
    });
  }, [filteredOpenOrders, openOrdersSort, sortData]);

  // Sorted expected TP data
  const sortedExpectedTPData = useMemo(() => {
    if (!expectedTPSummary || expectedTPSummary.length === 0) {
      return [];
    }
    
    if (!expectedTPSort.field) {
      return expectedTPSummary;
    }
    
    return sortData(expectedTPSummary, expectedTPSort.field, expectedTPSort.direction, (item, field) => {
      switch (field) {
        case 'symbol':
          return item.symbol || '';
        case 'net_qty':
          return item.net_qty ?? 0;
        case 'current_price':
          return item.current_price ?? 0;
        case 'position_value':
          return item.position_value ?? 0;
        case 'covered_qty':
          return item.covered_qty ?? 0;
        case 'uncovered_qty':
          return item.uncovered_qty ?? 0;
        case 'expected_profit':
          return item.total_expected_profit ?? 0;
        case 'coverage':
          return item.net_qty > 0 ? (item.covered_qty / item.net_qty) * 100 : 0;
        default:
          return 0;
      }
    });
  }, [expectedTPSummary, expectedTPSort, sortData]);

  // Sorted executed orders data
  const sortedExecutedOrdersData = useMemo(() => {
    if (!filteredExecutedOrders || filteredExecutedOrders.length === 0) {
      return [];
    }
    
    if (!executedOrdersSort.field) {
      return filteredExecutedOrders;
    }
    
    return sortData(filteredExecutedOrders, executedOrdersSort.field, executedOrdersSort.direction, (item, field) => {
      switch (field) {
        case 'created_date':
          return item.create_time ?? 0;
        case 'symbol':
          return item.instrument_name || '';
        case 'side':
          return item.side || '';
        case 'type':
          return item.order_type || '';
        case 'quantity':
          return parseFloat(item.quantity || '0');
        case 'price':
          return parseFloat(item.price || '0');
        case 'total_value':
          return parseFloat(item.quantity || '0') * parseFloat(item.price || '0');
        case 'execution_time':
          return item.update_time ?? item.create_time ?? 0;
        case 'status':
          return item.status || '';
        default:
          return 0;
      }
    });
  }, [filteredExecutedOrders, executedOrdersSort, sortData]);

  const visibleWatchlistCoins = useMemo(
    () => {
      // Defensive check: ensure orderedWatchlistCoins is an array
      if (!Array.isArray(orderedWatchlistCoins)) return [];
      // Filter out deleted coins and show all remaining coins
      const deletedCoins = (() => {
        try {
          const deleted = localStorage.getItem('deleted_coins');
          return deleted ? JSON.parse(deleted) as string[] : [];
        } catch {
          return [];
        }
      })();
      
      const filtered = orderedWatchlistCoins.filter(coin => {
        const coinName = coin.instrument_name.toUpperCase();
        return !deletedCoins.some(deleted => deleted.toUpperCase() === coinName);
      });
      
      // Apply search filter if provided
      if (watchlistFilter.trim()) {
        const filterUpper = watchlistFilter.trim().toUpperCase();
        return filtered.filter(coin => {
          const coinName = coin.instrument_name.toUpperCase();
          return coinName.includes(filterUpper);
        });
      }
      
      return filtered;
    },
    [orderedWatchlistCoins, watchlistFilter]
  );

  // Sorted watchlist data (depends on visibleWatchlistCoins)
  const sortedWatchlistData = useMemo(() => {
    if (!visibleWatchlistCoins || visibleWatchlistCoins.length === 0) {
      return [];
    }
    
    if (!watchlistSort.field) {
      return visibleWatchlistCoins;
    }
    
    return sortData(visibleWatchlistCoins, watchlistSort.field, watchlistSort.direction, (item, field) => {
      switch (field) {
        case 'symbol':
          return item.instrument_name || '';
        case 'last_price':
          return item.current_price ?? 0;
        case 'amount_usd':
          return parseFloat(coinAmounts[normalizeSymbolKey(item.instrument_name)] || '0');
        case 'rsi':
          return signals[item.instrument_name]?.rsi ?? 0;
        case 'atr':
          return signals[item.instrument_name]?.atr ?? 0;
        case 'sl_price':
          return calculatedSL[item.instrument_name] ?? 0;
        case 'tp_price':
          return calculatedTP[item.instrument_name] ?? 0;
        default:
          return 0;
      }
    });
  }, [visibleWatchlistCoins, watchlistSort, sortData, coinAmounts, signals, calculatedSL, calculatedTP]);

  const moveCoin = useCallback((symbol: string, direction: -1 | 1) => {
    if (!symbol || !orderedWatchlistCoins.length) {
      return;
    }

    const orderedSymbols = orderedWatchlistCoins.map((coin) => coin.instrument_name);
    const currentIndex = orderedSymbols.indexOf(symbol);
    if (currentIndex === -1) {
      return;
    }
    const targetIndex = currentIndex + direction;
    if (targetIndex < 0 || targetIndex >= orderedSymbols.length) {
      return;
    }

    const reordered = [...orderedSymbols];
    const [moved] = reordered.splice(currentIndex, 1);
    reordered.splice(targetIndex, 0, moved);

    setWatchlistOrder(() => {
      const nextOrder: Record<string, number> = {};
      reordered.forEach((sym, idx) => {
        nextOrder[sym] = idx + 1;
      });
      return nextOrder;
    });
  }, [orderedWatchlistCoins]);

  // Helpers
  function suggestSLTP({
    price, atr, rules
  }: { price: number; atr?: number; rules: StrategyRules }) {
    let slPrice: number | undefined;
    if (rules.sl.atrMult && atr) slPrice = price - rules.sl.atrMult * atr;
    else if (rules.sl.pct)       slPrice = price * (1 - rules.sl.pct / 100);

    let tpPrice: number | undefined;
    if (rules.tp.rr && slPrice != null) tpPrice = price + rules.tp.rr * (price - slPrice);
    else if (rules.tp.pct)              tpPrice = price * (1 + rules.tp.pct / 100);

    return { slPrice, tpPrice };
  }

  // Helper function to format full strategy name (e.g., "intradia-agresiva")
  function formatFullStrategyName(preset: string, riskMode: RiskMode | string): string {
    const presetLower = preset.toLowerCase();
    const riskLower = riskMode.toLowerCase();
    
    // Map English to Spanish
    const presetMap: Record<string, string> = {
      'swing': 'swing',
      'intraday': 'intradia',
      'scalp': 'scalp'
    };
    
    const riskMap: Record<string, string> = {
      'conservative': 'conservadora',
      'aggressive': 'agresiva'
    };
    
    const presetSpanish = presetMap[presetLower] || presetLower;
    const riskSpanish = riskMap[riskLower] || riskLower;
    
    return `${presetSpanish}-${riskSpanish}`;
  }

  function buildTooltip(preset: Preset, risk: RiskMode, ctx: {
    rsi?: number; ema10?: number; ma50?: number; ma200?: number; atr?: number; currentPrice?: number;
  }, currentStrategy?: StrategyDecision) {
    // Use presetsConfig (editable) if available, fallback to PRESET_CONFIG (defaults)
    const cfg = presetsConfig[preset] || PRESET_CONFIG[preset];
    if (!cfg) {
      return `Preset "${preset}" not found`;
    }
    const rules = cfg.rules[risk];
    if (!rules) {
      return `Risk mode "${risk}" not found for preset "${preset}"`;
    }
    const fullStrategyName = formatFullStrategyName(preset, risk);
    const lines = [
      `📊 Estrategia: ${fullStrategyName}`,
      `RSI: buy<${rules.rsi.buyBelow ?? '-'} / sell>${rules.rsi.sellAbove ?? '-'}`,
    ];
    
    // Build MA conditions with real values if available
    const maConditions: string[] = [];
    if (rules.maChecks.ema10) {
      if (ctx.ema10 !== undefined) {
        maConditions.push(`EMA10=$${formatNumber(ctx.ema10)}`);
      } else {
        maConditions.push(`EMA10=✓`);
      }
    }
    if (rules.maChecks.ma50) {
      if (ctx.ma50 !== undefined && ctx.ema10 !== undefined) {
        const condition = ctx.ma50 > ctx.ema10 ? '✓' : '✗';
        maConditions.push(`MA50=$${formatNumber(ctx.ma50)} ${condition} MA50>EMA10`);
      } else if (ctx.ma50 !== undefined) {
        maConditions.push(`MA50=$${formatNumber(ctx.ma50)}`);
      } else {
        maConditions.push(`MA50=✓`);
      }
    }
    if (rules.maChecks.ma200) {
      if (ctx.ma200 !== undefined && ctx.currentPrice !== undefined) {
        const condition = ctx.currentPrice > ctx.ma200 ? '✓' : '✗';
        maConditions.push(`MA200=$${formatNumber(ctx.ma200)} ${condition} Price>MA200`);
      } else if (ctx.ma200 !== undefined) {
        maConditions.push(`MA200=$${formatNumber(ctx.ma200)}`);
      } else {
        maConditions.push(`MA200=✓`);
      }
    }
    
    if (maConditions.length > 0) {
      lines.push(`MAs: ${maConditions.join(' | ')}`);
    } else {
      lines.push(`MAs: no MA checks`);
    }
    
    lines.push(
      rules.sl.atrMult ? `SL≈ price - ${rules.sl.atrMult}×ATR` : `SL≈ -${rules.sl.pct ?? '-'}%`,
      rules.tp.rr ? `TP≈ price + ${rules.tp.rr}×(price-SL)` : `TP≈ +${rules.tp.pct ?? '-'}%`,
    );
    if (rules.notes?.length) lines.push(`Notas: ${rules.notes.join(' · ')}`);
    // Safely handle currentStrategy - validate it's a proper StrategyDecision before accessing
    const validStrategy = safeGetStrategyDecision(currentStrategy);
    if (validStrategy) {
      lines.push('');
      lines.push('⚙️ Estado actual (backend):');
      const reasonLabels: Record<string, string> = {
        buy_rsi_ok: 'RSI < umbral BUY',
        buy_ma_ok: 'Tendencia (MAs)',
        buy_volume_ok: 'Volumen BUY >= mínimo',
        buy_target_ok: 'Precio dentro de buy target',
        sell_rsi_ok: 'RSI > umbral SELL',
        sell_trend_ok: 'Reversa confirmada',
        sell_volume_ok: 'Volumen SELL >= mínimo',
      };
      // Safely access reasons with multiple layers of validation
      if (validStrategy.reasons && typeof validStrategy.reasons === 'object' && !Array.isArray(validStrategy.reasons)) {
        try {
          Object.entries(validStrategy.reasons).forEach(([key, val]) => {
            if (val === null || val === undefined) return;
            const label = reasonLabels[key] || key;
            lines.push(`  • ${label}: ${val ? '✓' : '✗'}`);
          });
        } catch (e) {
          // Silently ignore if reasons is malformed - don't break the tooltip
          console.debug('Error processing strategy reasons:', e);
        }
      }
      if (validStrategy.summary && typeof validStrategy.summary === 'string') {
        lines.push('');
        lines.push(`Resumen backend: ${validStrategy.summary}`);
      }
    }
    return lines.join('\n');
  }
  
  // Helper function to safely validate and extract StrategyDecision
  function safeGetStrategyDecision(
    strategyState: unknown,
    fallback?: StrategyDecision
  ): StrategyDecision | undefined {
    // Check if it's a valid object (not null, not array, has decision property)
    if (
      strategyState &&
      typeof strategyState === 'object' &&
      strategyState !== null &&
      !Array.isArray(strategyState) &&
      'decision' in strategyState &&
      typeof (strategyState as { decision?: unknown }).decision === 'string'
    ) {
      const decision = (strategyState as { decision: string }).decision;
      // Validate decision is one of the allowed values
      if (decision === 'BUY' || decision === 'SELL' || decision === 'WAIT') {
        return strategyState as StrategyDecision;
      }
    }
    return fallback;
  }

type StrategyDecisionValue = 'BUY' | 'SELL' | 'WAIT';

function getReasonPrefix(decision: StrategyDecisionValue): 'buy_' | 'sell_' {
  return decision === 'SELL' ? 'sell_' : 'buy_';
}

function hasBlockingStrategyReason(
  decision: StrategyDecisionValue,
  reasons: Record<string, unknown>
): boolean {
  const prefix = getReasonPrefix(decision);
  return Object.entries(reasons).some(([key, value]) => key.startsWith(prefix) && value === false);
}

function computeStrategyIndex(
  decision: StrategyDecisionValue,
  reasons: Record<string, unknown>
): number | null {
  // CANONICAL: Calculate index from backend buy_* reasons
  // Only count boolean flags (ignore None values which mean "not applicable/not blocking")
  // This matches the backend canonical rule logic
  const prefix = getReasonPrefix(decision);
  const relevant = Object.entries(reasons).filter(
    ([key, value]) => key.startsWith(prefix) && typeof value === 'boolean'
  );
  if (!relevant.length) {
    return null;
  }
  // Count how many are True (only False values block the decision)
  // When all are True, index = 100% (matches backend canonical rule)
  const satisfied = relevant.filter(([, value]) => value === true).length;
  return Math.round((satisfied / relevant.length) * 100);
}

function buildDecisionIndexTitle(
  decision: StrategyDecisionValue,
  reasons: Record<string, unknown>,
  indexValue: number
): string {
  const prefix = getReasonPrefix(decision);
  const summary = Object.entries(reasons)
    .filter(([key, value]) => key.startsWith(prefix) && typeof value === 'boolean')
    .map(([key, value]) => `${key.replace(prefix, '')}: ${value ? '✓' : '✗'}`)
    .join(' | ');
  const decisionLabel = decision === 'SELL' ? 'SELL readiness' : 'BUY readiness';
  return summary
    ? `${decisionLabel} index: ${indexValue}% (${summary})`
    : `${decisionLabel} index: ${indexValue}%`;
}

function resolveDecisionIndexColor(value: number): string {
  if (value >= 90) return 'text-green-600';
  if (value >= 70) return 'text-green-500';
  if (value >= 50) return 'text-gray-600';
  if (value >= 30) return 'text-orange-500';
  return 'text-red-500';
}

  // Helper function to build signal criteria explanation tooltip
  // CANONICAL: Uses backend strategyReasons as source of truth for green/red status
  function buildSignalCriteriaTooltip(
    preset: Preset,
    riskMode: RiskMode,
    rules: StrategyRules | undefined,
    rsi: number | undefined,
    ma50: number | undefined,
    ema10: number | undefined,
    ma200: number | undefined,
    currentPrice: number | undefined,
    volume: number | undefined,
    avgVolume: number | undefined,
    symbol?: string,
    currentStrategy?: StrategyDecision,
    strategyVolumeRatio?: number | null,  // Optional: canonical volume ratio from strategy (same as Volume column)
    volumeAvgPeriods?: number | null,  // Optional: number of periods used for avg_volume calculation
    backendMinVolumeRatio?: number  // CANONICAL: Backend configured threshold from Signal Config (source of truth)
  ): string {
    if (!rules) {
      return `Estrategia no configurada`;
    }

    // CANONICAL: Extract backend reasons - this is the source of truth for green/red status
    const strategyReasons = currentStrategy?.reasons && typeof currentStrategy.reasons === 'object' && !Array.isArray(currentStrategy.reasons)
      ? currentStrategy.reasons as Record<string, boolean | null | undefined>
      : {};

    // CANONICAL: Use backend min_volume_ratio if provided (Signal Config source of truth), otherwise fallback to rules
    // NOTE: Must use ?? (nullish coalescing) not || (falsy check) because 0 is a valid value
    // FIX: Add optional chaining to prevent TypeError if rules is undefined or doesn't have volumeMinRatio
    const minVolumeRatio = backendMinVolumeRatio !== undefined && backendMinVolumeRatio !== null
      ? backendMinVolumeRatio
      : (rules?.volumeMinRatio ?? 0.5);

    const lines: string[] = [];
    const fullStrategyName = formatFullStrategyName(preset, riskMode);
    lines.push(`📊 Estrategia: ${fullStrategyName}`);
    lines.push('');
    
    // BUY Criteria - CANONICAL: Use backend reasons for status, show values for context
    lines.push('🟢 CRITERIOS BUY (todos deben cumplirse):');
    const buyBelow = rules.rsi?.buyBelow ?? 40;
    // CANONICAL: Use backend buy_rsi_ok for status, not local calculation
    const buyRsiOk = strategyReasons.buy_rsi_ok;
    const rsiBuyStatus = buyRsiOk === true ? '✓' : buyRsiOk === false ? '✗' : '?';
    lines.push(`  • RSI < ${buyBelow} ${(rsi !== undefined && rsi !== null) ? `(actual: ${rsi.toFixed(2)}${rsiBuyStatus})` : rsiBuyStatus}`);
    
    // CANONICAL: Use backend buy_ma_ok for status
    const buyMaOk = strategyReasons.buy_ma_ok;
    if (rules.maChecks?.ma50 && ma50 !== undefined && ma50 !== null && ema10 !== undefined && ema10 !== null) {
      const ma50Status = buyMaOk === true ? '✓' : buyMaOk === false ? '✗' : '?';
      lines.push(`  • MA50 > EMA10 ${ma50Status}`);
      lines.push(`    - MA50: $${formatNumber(ma50, symbol)}`);
      lines.push(`    - EMA10: $${formatNumber(ema10, symbol)}`);
    }
    
    if (rules.maChecks?.ma200 && ma200 !== undefined && ma200 !== null && currentPrice !== undefined && currentPrice !== null) {
      // MA200 check is part of buy_ma_ok in backend
      const ma200Status = buyMaOk === true ? '✓' : buyMaOk === false ? '✗' : '?';
      lines.push(`  • Precio > MA200 ${ma200Status}`);
      lines.push(`    - Precio: $${formatNumber(currentPrice, symbol)}`);
      lines.push(`    - MA200: $${formatNumber(ma200, symbol)}`);
    }
    
    // Volume criterion: require volume >= minVolumeRatio x average (market reaction)
    // CANONICAL: Use backend buy_volume_ok for status, show ratio for context
    const buyVolumeOk = strategyReasons.buy_volume_ok;
    let volumeRatio: number | undefined;
    if (strategyVolumeRatio !== undefined && strategyVolumeRatio !== null && strategyVolumeRatio >= 0) {
      // Use canonical strategy volume_ratio (same calculation as Volume column and strategy decision)
      volumeRatio = strategyVolumeRatio;
    } else if (volume !== undefined && volume !== null && avgVolume !== undefined && avgVolume !== null && avgVolume > 0) {
      // Fallback: calculate from volume/avgVolume (should match strategy if same inputs)
      volumeRatio = volume / avgVolume;
    }
    
    if (volumeRatio !== undefined && volumeRatio !== null) {
      // CANONICAL: Use backend buy_volume_ok for status
      const volumeStatus = buyVolumeOk === true ? '✓' : buyVolumeOk === false ? '✗' : '?';
      lines.push(`  • Volume ≥ ${minVolumeRatio}x promedio ${volumeStatus}`);
      lines.push(`    - Ratio actual: ${volumeRatio.toFixed(2)}x (mismo valor que columna Volume)`);
      lines.push(`    - Volume (último período): ${formatNumber(volume, undefined)}`);
      // Show period count if available, otherwise fallback to generic text
      if (volumeAvgPeriods !== undefined && volumeAvgPeriods !== null && volumeAvgPeriods > 0) {
        lines.push(`    - Promedio (${volumeAvgPeriods} períodos): ${formatNumber(avgVolume, undefined)}`);
      } else {
        lines.push(`    - Promedio: ${formatNumber(avgVolume, undefined)}`);
      }
    } else {
      // CANONICAL: Use backend buy_volume_ok for status even when ratio unavailable
      const volumeStatus = buyVolumeOk === true ? '✓' : buyVolumeOk === false ? '✗' : '?';
      lines.push(`  • Volume ≥ ${minVolumeRatio}x promedio ${volumeStatus} (datos no disponibles)`);
    }
    
    // CANONICAL: Show buy_target_ok and buy_price_ok from backend
    const buyTargetOk = strategyReasons.buy_target_ok;
    if (buyTargetOk !== undefined && buyTargetOk !== null) {
      const targetStatus = buyTargetOk === true ? '✓' : '✗';
      lines.push(`  • Precio dentro de buy target ${targetStatus}`);
    }
    
    const buyPriceOk = strategyReasons.buy_price_ok;
    if (buyPriceOk !== undefined && buyPriceOk !== null && buyPriceOk === false) {
      lines.push(`  • Precio válido ✗`);
    }
    
    // Check if ANY MA is required (ema10, ma50, or ma200)
    // IMPORTANT: Only check if explicitly marked as required in config (maChecks.ema10=true)
    const requiresAnyMA = rules.maChecks?.ema10 || rules.maChecks?.ma50 || rules.maChecks?.ma200;
    
    // If EMA10 is required (maChecks.ema10=true) but not shown above (when ma50 is false), show it here
    // Only show EMA10 check if it's explicitly marked as required in the config
    if (rules.maChecks?.ema10 === true && !rules.maChecks?.ma50 && ema10 !== undefined && ema10 !== null && currentPrice !== undefined && currentPrice !== null) {
      // EMA10 check: Price > EMA10 (with tolerance for scalp strategies)
      const ma10Status = buyMaOk === true ? '✓' : buyMaOk === false ? '✗' : '?';
      lines.push(`  • Precio > EMA10 ${ma10Status}`);
      lines.push(`    - Precio: $${formatNumber(currentPrice, symbol)}`);
      lines.push(`    - EMA10: $${formatNumber(ema10, symbol)}`);
    }
    
    // Only show "No se requieren MAs" if NO MAs are required at all
    // This means all maChecks are false or undefined
    if (!requiresAnyMA) {
      lines.push(`  • No se requieren MAs`);
    }
    
    lines.push('');
    
    // SELL Criteria - More strict: require BOTH RSI AND MA reversal
    if (rules.maChecks?.ma50) {
      lines.push('🔴 CRITERIOS SELL (AMBOS deben cumplirse):');
    } else {
      lines.push('🔴 CRITERIOS SELL:');
    }
    const sellAbove = rules.rsi?.sellAbove ?? 70;
    // CANONICAL: Use backend sell_rsi_ok for status, not local calculation
    const sellRsiOk = strategyReasons.sell_rsi_ok;
    const rsiSellStatus = sellRsiOk === true ? '✓' : sellRsiOk === false ? '✗' : '?';
    lines.push(`  • RSI > ${sellAbove} ${(rsi !== undefined && rsi !== null) ? `(actual: ${rsi.toFixed(2)}${rsiSellStatus})` : rsiSellStatus}`);
    
    if (rules.maChecks?.ma50 && ma50 !== undefined && ema10 !== undefined) {
      // Calculate percentage difference
      const priceDiff = Math.abs(ma50 - ema10);
      const avgPrice = (ma50 + ema10) / 2;
      const percentDiff = (priceDiff / avgPrice) * 100;
      const ma50Reversal = ma50 < ema10 && percentDiff >= 0.5;
      const ma50ReversalStatus = ma50Reversal ? '✓' : '✗';
      
      lines.push(`  • MA50 < EMA10 (diferencia ≥0.5%) ${ma50ReversalStatus}`);
      lines.push(`    - MA50: $${formatNumber(ma50, symbol)}`);
      lines.push(`    - EMA10: $${formatNumber(ema10, symbol)}`);
      lines.push(`    - Diferencia: ${percentDiff.toFixed(2)}% ${ma50 < ema10 ? '(requiere ≥0.5%)' : ''}`);
    }
    
    // Volume criterion: require volume >= minVolumeRatio x average for SELL (market reaction)
    // CANONICAL: Use strategy volume_ratio if provided (same as Volume column), otherwise calculate
    volumeRatio = undefined;
    if (strategyVolumeRatio !== undefined && strategyVolumeRatio !== null && strategyVolumeRatio >= 0) {
      // Use canonical strategy volume_ratio (same calculation as Volume column and strategy decision)
      volumeRatio = strategyVolumeRatio;
    } else if (volume !== undefined && volume !== null && avgVolume !== undefined && avgVolume !== null && avgVolume > 0) {
      // Fallback: calculate from volume/avgVolume (should match strategy if same inputs)
      volumeRatio = volume / avgVolume;
    }
    
    if (volumeRatio !== undefined && volumeRatio !== null) {
      const volumeStatus = volumeRatio >= minVolumeRatio ? '✓' : '✗';
      lines.push(`  • Volume ≥ ${minVolumeRatio}x promedio ${volumeStatus}`);
      lines.push(`    - Ratio actual: ${volumeRatio.toFixed(2)}x (mismo valor que columna Volume)`);
      lines.push(`    - Volume (último período): ${formatNumber(volume, undefined)}`);
      // Show period count if available, otherwise fallback to generic text
      if (volumeAvgPeriods !== undefined && volumeAvgPeriods !== null && volumeAvgPeriods > 0) {
        lines.push(`    - Promedio (${volumeAvgPeriods} períodos): ${formatNumber(avgVolume, undefined)}`);
      } else {
        lines.push(`    - Promedio: ${formatNumber(avgVolume, undefined)}`);
      }
    } else {
      lines.push(`  • Volume ≥ ${minVolumeRatio}x promedio ? (datos no disponibles)`);
    }
    
    lines.push('');
    
    // Current Status - CANONICAL: Use backend decision and reasons as source of truth
    const backendDecision = currentStrategy?.decision;
    lines.push('📌 ESTADO ACTUAL (backend):');
    
    // CANONICAL: Use backend decision, not local calculation
    if (backendDecision === 'BUY') {
      lines.push('  → Señal: BUY (todos los criterios BUY cumplidos según backend)');
      // Show which criteria are met
      const metCriteria: string[] = [];
      if (buyRsiOk === true) metCriteria.push('RSI');
      if (buyMaOk === true) metCriteria.push('MA');
      if (buyVolumeOk === true) metCriteria.push('Volume');
      if (buyTargetOk === true) metCriteria.push('Target');
      if (buyPriceOk === true) metCriteria.push('Price');
      if (metCriteria.length > 0) {
        lines.push(`  ✓ Criterios cumplidos: ${metCriteria.join(', ')}`);
      }
    } else if (backendDecision === 'SELL') {
      lines.push('  → Señal: SELL (todos los criterios SELL cumplidos según backend)');
      const sellRsiOk = strategyReasons.sell_rsi_ok;
      const sellTrendOk = strategyReasons.sell_trend_ok;
      const sellVolumeOk = strategyReasons.sell_volume_ok;
      const sellCriteria: string[] = [];
      if (sellRsiOk === true) sellCriteria.push('RSI');
      if (sellTrendOk === true) sellCriteria.push('Trend');
      if (sellVolumeOk === true) sellCriteria.push('Volume');
      if (sellCriteria.length > 0) {
        lines.push(`  ✓ Criterios cumplidos: ${sellCriteria.join(', ')}`);
      }
    } else {
      lines.push('  → Señal: WAIT (no se cumplen todos los criterios BUY según backend)');
      // Show which criteria are blocking - be specific about which MA
      const blockingCriteria: string[] = [];
      if (buyRsiOk === false) blockingCriteria.push('RSI');
      if (buyMaOk === false) {
        // Be specific about which MA is blocking - ONLY show if explicitly enabled in config
        // CRITICAL: Only show EMA10 if it's explicitly enabled (ema10 === true)
        // If ema10 is false or undefined, don't show it as blocking
        const ema10Enabled = rules.maChecks?.ema10 === true;
        const ma50Enabled = rules.maChecks?.ma50 === true;
        const ma200Enabled = rules.maChecks?.ma200 === true;
        
        if (ema10Enabled && !ma50Enabled && !ma200Enabled) {
          blockingCriteria.push('EMA10');
        } else if (ma50Enabled) {
          blockingCriteria.push('MA50');
        } else if (ma200Enabled) {
          blockingCriteria.push('MA200');
        } else if (ema10Enabled || ma50Enabled || ma200Enabled) {
          // At least one MA is enabled, but we can't determine which one is blocking
          blockingCriteria.push('MA');
        }
        // If no MAs are enabled (all false or undefined), don't add 'MA' to blocking criteria
      }
      if (buyVolumeOk === false) blockingCriteria.push('Volume');
      if (buyTargetOk === false) blockingCriteria.push('Target');
      if (buyPriceOk === false) blockingCriteria.push('Price');
      if (blockingCriteria.length > 0) {
        lines.push(`  ✗ Criterios bloqueantes: ${blockingCriteria.join(', ')}`);
      } else {
        lines.push('  ℹ️ Algunos criterios no están disponibles (None)');
      }
      
      // Show volume ratio if available for context
      if (volumeRatio !== undefined && volumeRatio !== null && volumeRatio < minVolumeRatio) {
        lines.push(`  ⚠️ Volume ratio (${volumeRatio.toFixed(2)}x) < ${minVolumeRatio}x`);
      }
    }
    
    return lines.join('\n');
  }

  // Helper function to get MA color and explanation based on strategy
  function getMAColorAndTooltip(
    coin: TopCoin,
    maType: 'EMA10' | 'MA50' | 'MA200' | 'MA10w',
    signals: TradingSignals | null | undefined,
    coinPresets: Record<string, string>
  ): { colorClass: string; tooltip: string } {
    if (!signals) {
      return { colorClass: 'text-gray-400', tooltip: 'Signal data not available' };
    }

    const preset = coinPresets[normalizeSymbolKey(coin.instrument_name)] || 'swing';
    let presetType: Preset;
    let riskMode: RiskMode;
    
    if (preset === 'swing' || preset === 'intraday' || preset === 'scalp') {
      presetType = (preset.charAt(0).toUpperCase() + preset.slice(1)) as Preset;
      riskMode = 'Conservative';
    } else if (preset.includes('-conservative')) {
      const basePreset = preset.replace('-conservative', '');
      presetType = (basePreset.charAt(0).toUpperCase() + basePreset.slice(1)) as Preset;
      riskMode = 'Conservative';
    } else if (preset.includes('-aggressive')) {
      const basePreset = preset.replace('-aggressive', '');
      presetType = (basePreset.charAt(0).toUpperCase() + basePreset.slice(1)) as Preset;
      riskMode = 'Aggressive';
    } else {
      presetType = 'Swing';
      riskMode = 'Conservative';
    }

    // Use presetsConfig (editable) if available, fallback to PRESET_CONFIG (defaults)
    const rules = presetsConfig[presetType]?.rules[riskMode] || PRESET_CONFIG[presetType]?.rules[riskMode];
    const currentPrice = coin.current_price;
    const ma50 = signals.ma50;
    const ema10 = signals.ema10;
    const ma200 = signals.ma200;
    const ma10w = signals.ma10w;

    // Determine color and tooltip based on MA type and strategy rules
    switch (maType) {
      case 'EMA10':
        if (ema10 === undefined) {
          return { colorClass: 'text-gray-400', tooltip: 'EMA10 data not available' };
        }
        if (!currentPrice || currentPrice === 0) {
          return { colorClass: 'text-gray-400', tooltip: `EMA10: $${formatNumber(ema10, coin.instrument_name)} (precio no disponible)` };
        }
        if (currentPrice >= ema10) {
          return {
            colorClass: 'palette-text-profit-strong text-green-600',
            tooltip: `🟢 COMPRAR: Precio ($${formatNumber(currentPrice, coin.instrument_name)}) ${currentPrice > ema10 ? '>' : '='} EMA10 ($${formatNumber(ema10, coin.instrument_name)}). Tendencia alcista a corto plazo.`
          };
        } else {
          return {
            colorClass: 'palette-text-loss-strong text-red-600',
            tooltip: `🔴 VENDER: Precio ($${formatNumber(currentPrice, coin.instrument_name)}) < EMA10 ($${formatNumber(ema10, coin.instrument_name)}). Tendencia bajista a corto plazo.`
          };
        }

      case 'MA50':
        if (ma50 === undefined) {
          return { colorClass: 'text-gray-400', tooltip: 'MA50 data not available' };
        }
        // Check if MA50 is used in strategy
        const ma50Check = rules?.maChecks?.ma50;
        if (ma50Check && ema10 !== undefined) {
          // MA50 is active in strategy: MA50 > EMA10 is required for BUY, MA50 < EMA10 suggests SELL
          if (ma50 > ema10) {
            return {
              colorClass: 'palette-text-profit-strong text-green-600',
              tooltip: `✅ Criterio COMPRA cumplido: MA50 ($${formatNumber(ma50, coin.instrument_name)}) > EMA10 ($${formatNumber(ema10, coin.instrument_name)}). Condición necesaria para señal BUY.`
            };
          } else {
            return {
              colorClass: 'palette-text-loss-strong text-red-600',
              tooltip: `❌ Criterio COMPRA NO cumplido: MA50 ($${formatNumber(ma50, coin.instrument_name)}) < EMA10 ($${formatNumber(ema10, coin.instrument_name)}). Esta condición bloquea señal BUY, sugiere SELL.`
            };
          }
        } else {
          // MA50 not used in strategy, just show price comparison for reference
          if (!currentPrice || currentPrice === 0) {
            return { colorClass: 'text-gray-400', tooltip: `MA50: $${formatNumber(ma50, coin.instrument_name)} (precio no disponible)` };
          }
          if (currentPrice >= ma50) {
            return {
              colorClass: 'text-gray-600',
              tooltip: `Precio ($${formatNumber(currentPrice, coin.instrument_name)}) ${currentPrice > ma50 ? '>' : '='} MA50 ($${formatNumber(ma50, coin.instrument_name)}). Tendencia alcista a medio plazo. (No usado en estrategia actual)`
            };
          } else {
            return {
              colorClass: 'text-gray-600',
              tooltip: `Precio ($${formatNumber(currentPrice, coin.instrument_name)}) < MA50 ($${formatNumber(ma50, coin.instrument_name)}). Tendencia bajista a medio plazo. (No usado en estrategia actual)`
            };
          }
        }

      case 'MA200':
        if (ma200 === undefined) {
          return { colorClass: 'text-gray-400', tooltip: 'MA200 data not available' };
        }
        // Check if MA200 is used in strategy
        const ma200Check = rules?.maChecks?.ma200;
        if (!currentPrice || currentPrice === 0) {
          return { colorClass: 'text-gray-400', tooltip: `MA200: $${formatNumber(ma200, coin.instrument_name)} (precio no disponible)` };
        }
        if (ma200Check) {
          // MA200 is active in strategy: Precio > MA200 is required for BUY
          // Important: If MA200 is green (Precio > MA200), this is NOT a sell criterion
          // Green = BUY criterion met, Red = BUY criterion NOT met (blocks BUY, suggests WAIT/SELL)
          if (currentPrice >= ma200) {
            return {
              colorClass: 'palette-text-profit-strong text-green-600',
              tooltip: `✅ Criterio COMPRA cumplido: Precio ($${formatNumber(currentPrice, coin.instrument_name)}) ${currentPrice > ma200 ? '>' : '='} MA200 ($${formatNumber(ma200, coin.instrument_name)}). Condición necesaria para señal BUY. Este criterio NO es para vender - si está verde, NO es razón para SELL.`
            };
          } else {
            return {
              colorClass: 'palette-text-loss-strong text-red-600',
              tooltip: `❌ Criterio COMPRA bloqueado: Precio ($${formatNumber(currentPrice, coin.instrument_name)}) < MA200 ($${formatNumber(ma200, coin.instrument_name)}). Esta condición bloquea señal BUY. Si la señal es SELL, viene de otros criterios (RSI > sellAbove o MA50 < EMA10), NO de MA200.`
            };
          }
        } else {
          // MA200 not used in strategy, just show price comparison for reference
          if (currentPrice >= ma200) {
            return {
              colorClass: 'text-gray-600',
              tooltip: `Precio ($${formatNumber(currentPrice, coin.instrument_name)}) ${currentPrice > ma200 ? '>' : '='} MA200 ($${formatNumber(ma200, coin.instrument_name)}). Tendencia alcista a largo plazo. (No usado en estrategia actual)`
            };
          } else {
            return {
              colorClass: 'text-gray-600',
              tooltip: `Precio ($${formatNumber(currentPrice, coin.instrument_name)}) < MA200 ($${formatNumber(ma200, coin.instrument_name)}). Tendencia bajista a largo plazo. (No usado en estrategia actual)`
            };
          }
        }

      case 'MA10w':
        if (ma10w === undefined) {
          return { colorClass: 'text-gray-400', tooltip: 'MA10w data not available' };
        }
        // MA10w is NOT used in any strategy preset (only EMA10, MA50, MA200 are checked)
        // So we should show it as neutral/informational, not as buy/sell signal
        if (!currentPrice || currentPrice === 0) {
          return { colorClass: 'text-gray-400', tooltip: `MA10w: $${formatNumber(ma10w, coin.instrument_name)} (precio no disponible)` };
        }
        // Show as neutral gray - MA10w is not a strategy criterion
        return {
          colorClass: 'text-gray-600',
          tooltip: `MA10w: $${formatNumber(ma10w, coin.instrument_name)} | Precio: $${formatNumber(currentPrice, coin.instrument_name)}. Este indicador NO se usa en la estrategia actual (solo se usan EMA10, MA50, MA200 según preset). Mostrado solo como referencia informativa.`
        };

      default:
        return { colorClass: 'text-gray-400', tooltip: 'Unknown MA type' };
    }
  }

  // Helper function to update both state and ref - now supports filtering for specific coins
  const mergeCoinData = useCallback((existing: TopCoin | undefined, incoming: TopCoin): TopCoin => {
    if (!existing) {
      return incoming;
    }

    function chooseValue<T>(nextValue: T | undefined, fallbackValue: T, allowZero?: boolean): T;
    function chooseValue<T>(nextValue: T | undefined, fallbackValue: T | undefined, allowZero?: boolean): T | undefined;
    function chooseValue<T>(nextValue: T | undefined, fallbackValue: T | undefined, allowZero = false): T | undefined {
      if (nextValue === undefined || nextValue === null) {
        return fallbackValue;
      }
      if (!allowZero && typeof nextValue === 'number' && nextValue === 0 && typeof fallbackValue === 'number' && fallbackValue !== 0) {
        return fallbackValue;
      }
      return nextValue;
    }

    return {
      ...existing,
      ...incoming,
      current_price: chooseValue<number>(incoming.current_price, existing.current_price),
      volume_24h: chooseValue<number>(incoming.volume_24h, existing.volume_24h, true),
      updated_at: chooseValue<string>(incoming.updated_at, existing.updated_at),
      rsi: chooseValue(incoming.rsi, existing.rsi),
      ma50: chooseValue(incoming.ma50, existing.ma50),
      ma200: chooseValue(incoming.ma200, existing.ma200),
      ema10: chooseValue(incoming.ema10, existing.ema10),
      atr: chooseValue(incoming.atr, existing.atr),
      avg_volume: chooseValue(incoming.avg_volume, existing.avg_volume, true),
      volume_ratio: chooseValue(incoming.volume_ratio, existing.volume_ratio, true),
      res_up: chooseValue(incoming.res_up, existing.res_up),
      res_down: chooseValue(incoming.res_down, existing.res_down),
      strategy: incoming.strategy ?? existing.strategy,
    };
  }, []);

  useEffect(() => {
    lastUpdateTimesRef.current = lastUpdateTimes;
  }, [lastUpdateTimes]);

  const updateTopCoins = useCallback((newCoins: TopCoin[], filterSymbols?: string[]) => {
    console.log('🔄 updateTopCoins called with', newCoins.length, 'coins', filterSymbols ? `(filtered to ${filterSymbols.length})` : '');
    console.log('📊 First few coins:', newCoins.slice(0, 3).map(c => c.instrument_name));
    
    // Merge new coins with existing coins, updating only filtered symbols
      // CRITICAL FIX: Always preserve existing coins, even when filtering
      // This prevents symbols from disappearing when filterTradeYes is used
    let coinsToUpdate: TopCoin[];
    if (filterSymbols && filterSymbols.length > 0) {
      const existingCoins = topCoinsRef.current;
      const coinMap = new Map(existingCoins.map(coin => [coin.instrument_name, coin]));
      
        // CRITICAL: Start with ALL existing coins (preserve them)
        // Then update only the filtered coins with new data
        // This ensures symbols not in the filtered response remain visible
        const mergedMap = new Map<string, TopCoin>();
        
        // First, preserve all existing coins
        existingCoins.forEach(coin => {
          mergedMap.set(coin.instrument_name, coin);
        });
        
        // Then, update only the filtered coins with new data
      newCoins.forEach(coin => {
        if (filterSymbols.includes(coin.instrument_name)) {
            const existingCoin = coinMap.get(coin.instrument_name);
            mergedMap.set(coin.instrument_name, mergeCoinData(existingCoin, coin));
        }
      });
      
        coinsToUpdate = Array.from(mergedMap.values());
        
        // Log if any coins were preserved that aren't in filtered response
        const preservedInFilter = existingCoins
          .filter(coin => !filterSymbols.includes(coin.instrument_name))
          .map(coin => coin.instrument_name);
        if (preservedInFilter.length > 0) {
          console.log(`🛡️ Preserved ${preservedInFilter.length} coins not in filtered response:`, preservedInFilter.slice(0, 5));
        }
        
      topCoinsRef.current = coinsToUpdate;
      setTopCoins(coinsToUpdate);
        console.log(`✅ Updated ${coinsToUpdate.length} coins (${newCoins.length} filtered, ${preservedInFilter.length} preserved)`);
      
      // Only update timestamps for filtered coins
      const now = new Date();
      const updateTimes: {[key: string]: {price: Date, signals: Date}} = {};
      filterSymbols.forEach(symbol => {
        updateTimes[symbol] = {
          price: now,
          signals: lastUpdateTimesRef.current[symbol]?.signals || now
        };
      });
      setLastUpdateTimes(prev => ({...prev, ...updateTimes}));
    } else {
      // No filter - update all coins (initial load)
      // CRITICAL FIX: Preserve existing coins that are not in the new response
      // This prevents symbols from disappearing when they're not in MarketPrice but are in watchlist
      const existingCoins = topCoinsRef.current;
      const existingMap = new Map(existingCoins.map(coin => [coin.instrument_name, coin]));
      const newCoinsMap = new Map(newCoins.map(coin => [coin.instrument_name, coin]));
      
      // Start with existing coins and update/merge with new data
      const mergedMap = new Map<string, TopCoin>();
      
      // First, add all existing coins (preserve them even if not in new response)
      existingCoins.forEach(coin => {
        mergedMap.set(coin.instrument_name, coin);
      });
      
      // Then, update/merge with new coins from backend
      newCoins.forEach(coin => {
        const existingCoin = existingMap.get(coin.instrument_name);
        mergedMap.set(coin.instrument_name, mergeCoinData(existingCoin, coin));
      });
      
      coinsToUpdate = Array.from(mergedMap.values());
      
      // Log if any existing coins were preserved that aren't in new response
      const preservedSymbols = existingCoins
        .filter(coin => !newCoinsMap.has(coin.instrument_name))
        .map(coin => coin.instrument_name);
      if (preservedSymbols.length > 0) {
        console.log(`🛡️ Preserved ${preservedSymbols.length} existing coins not in backend response:`, preservedSymbols);
      }
      
      topCoinsRef.current = coinsToUpdate;
      setTopCoins(coinsToUpdate);
      console.log(`✅ setTopCoins called with ${coinsToUpdate.length} coins (${newCoins.length} from backend, ${preservedSymbols.length} preserved)`);
      
      // Record price update time for all coins
      const now = new Date();
      const updateTimes: {[key: string]: {price: Date, signals: Date}} = {};
      newCoins.forEach(coin => {
        updateTimes[coin.instrument_name] = {
          price: now,
          signals: lastUpdateTimes[coin.instrument_name]?.signals || now
        };
      });
      setLastUpdateTimes(prev => ({...prev, ...updateTimes}));
    }
    
    // Extract indicators from coins and populate signals object
    // This is critical: indicators are returned in the coin object from backend,
    // but the table reads them from the signals object
    const now = new Date();
    setSignals(prev => {
      const updated = { ...prev };
      const coinsToProcess = filterSymbols 
        ? coinsToUpdate.filter(coin => filterSymbols.includes(coin.instrument_name))
        : coinsToUpdate;
      
      coinsToProcess.forEach(coin => {
        // Always update signals for all coins (even if indicators are missing)
        // This ensures coins are tracked even if some indicators are missing
        const existingSignal = updated[coin.instrument_name] || {} as Partial<TradingSignals>;
        
        // Build signal object with available fields
        const signalData: Partial<TradingSignals> = {
          ...existingSignal,
          symbol: coin.instrument_name,
          exchange: 'CRYPTO_COM',
          price: coin.current_price || existingSignal.price || 0,
        };
        
        // Only set fields that are actually present in coin data
        // For numeric fields, also check for null (not just undefined) and allow 0 values
        if (coin.rsi !== undefined && coin.rsi !== null) signalData.rsi = coin.rsi;
        if (coin.atr !== undefined && coin.atr !== null) signalData.atr = coin.atr;
        if (coin.ma50 !== undefined && coin.ma50 !== null) signalData.ma50 = coin.ma50;
        if (coin.ma200 !== undefined && coin.ma200 !== null) signalData.ma200 = coin.ma200;
        if (coin.ema10 !== undefined && coin.ema10 !== null) signalData.ema10 = coin.ema10;
        if (coin.ma10w !== undefined && coin.ma10w !== null) signalData.ma10w = coin.ma10w;
        if (coin.volume_24h !== undefined) signalData.volume_24h = coin.volume_24h;
        if (coin.current_volume !== undefined) signalData.current_volume = coin.current_volume;
        if (coin.avg_volume !== undefined) signalData.avg_volume = coin.avg_volume;
        if (coin.volume_ratio !== undefined) signalData.volume_ratio = coin.volume_ratio;
        
        // Extract resistance levels from coin data (newly added from backend)
        if (coin.res_up !== undefined) signalData.res_up = coin.res_up;
        if (coin.res_down !== undefined) signalData.res_down = coin.res_down;
        if (coin.strategy) {
          signalData.strategy = coin.strategy;
        } else if (!signalData.strategy && existingSignal?.strategy) {
          signalData.strategy = existingSignal.strategy;
        }
        
        // Preserve existing signal data if present (but allow override from coin data)
        if (existingSignal.res_up === undefined && coin.res_up === undefined) {
          // Keep existing if no new data
        }
        if (existingSignal.res_down === undefined && coin.res_down === undefined) {
          // Keep existing if no new data
        }
        // Note: ma10w is already copied from coin.ma10w above, no need to preserve from existingSignal
        if (existingSignal.signals) signalData.signals = existingSignal.signals;
        
        updated[coin.instrument_name] = signalData as TradingSignals;
        
        // Update signals timestamp
        setLastUpdateTimes(prevTimes => ({
          ...prevTimes,
          [coin.instrument_name]: {
            price: prevTimes[coin.instrument_name]?.price || now,
            signals: now
          }
        }));
        
        console.log(`✅ Extracted indicators for ${coin.instrument_name}:`, {
          rsi: coin.rsi,
          atr: coin.atr,
          ma50: coin.ma50,
          ma200: coin.ma200,
          ema10: coin.ema10,
          ma10w: coin.ma10w,
          res_up: coin.res_up,
          res_down: coin.res_down
        });
      });
      return updated;
    });
  }, [setTopCoins]);

  const applyPriceToTopCoins = useCallback(
    (symbol: string, price: number) => {
      if (!price || price <= 0) {
        return;
      }
      const updatedCoins = topCoinsRef.current.map(coin =>
        coin.instrument_name === symbol ? { ...coin, current_price: price } : coin
      );
      // Only update state if something actually changed
      const hasChanged = updatedCoins.some((coin, index) => coin !== topCoinsRef.current[index]);
      if (hasChanged) {
        updateTopCoins(updatedCoins);
      }
    },
    [updateTopCoins]
  );
  
  const [_signalConfig, setSignalConfig] = useState({
    rsiPeriod: 14,
    rsiBuyThreshold: 40,
    rsiSellThreshold: 70,
    ma50Period: 50,
    ema10Period: 10,
    ma10wPeriod: 70,
    atrPeriod: 14,
    volumePeriod: 10
  });

  // Helper function to normalize symbol (add _USDT if no pair specified)
  const normalizeSymbol = useCallback((symbol: string | null | undefined): string => {
    if (!symbol) return '';
    const upperSymbol = symbol.toString().toUpperCase().trim();
    if (!upperSymbol) return '';
    
    // Check if symbol already has a pair (USD, USDT, BTC, ETH, EUR, etc.)
    const hasPair = upperSymbol.includes('_') && 
      ['USDT', 'USD', 'BTC', 'ETH', 'EUR', 'USDC'].some(pair => upperSymbol.endsWith(`_${pair}`));
    
    if (!hasPair) {
      // No pair specified - add _USDT
      return `${upperSymbol}_USDT`;
    }
    
    return upperSymbol;
  }, []);

  // Helper function to get price for an asset (ONLY from backend data, NO external API calls)
  // Frontend should ONLY read from backend-processed data (topCoins, signals, dashboard state)
  const getAssetPrice = useCallback(async (asset: string): Promise<number> => {
    // Fiat currencies are 1.0 (or exchange rate for EUR, etc.)
    if (asset === 'USD' || asset === 'USDT') {
      return 1.0;
    }
    if (asset === 'EUR') {
      // Approximate EUR/USD exchange rate
      return 1.08;
    }
    
    // Try to find price from topCoins (backend-processed data)
    // This is the most reliable source as it comes from the backend
    const coin = topCoins.find(c => {
      const base = c.base_currency?.toUpperCase();
      const instrumentBase = c.instrument_name?.split('_')[0]?.toUpperCase();
      return base === asset.toUpperCase() || instrumentBase === asset.toUpperCase();
    });
    if (coin?.current_price && coin.current_price > 0) {
      console.log(`✅ Found price for ${asset} in topCoins: $${coin.current_price} (source: ${coin.instrument_name})`);
      return coin.current_price;
    }
    
    // Try to find price from signals (backend-processed data)
    const signalKey = Object.keys(signals).find(key => {
      const base = key.split('_')[0]?.toUpperCase();
      return base === asset.toUpperCase();
    });
    if (signalKey) {
      const signal = signals[signalKey];
      if (signal?.price && signal.price > 0) {
        console.log(`✅ Found price for ${asset} in signals: $${signal.price} (symbol: ${signalKey})`);
        return signal.price;
      }
    }
    
    // NO external API calls - backend should provide all prices
    // Return 0 if price not found in backend data
    console.debug(`⚠️ No price found for ${asset} in backend data (topCoins or signals)`);
    return 0;
  }, [topCoins, signals]);

  // Fetch portfolio from snapshot (fast, cached)
  const fetchPortfolio = useCallback(async (options: { showLoader?: boolean; backgroundRefresh?: boolean } = {}) => {
    const { showLoader = false, backgroundRefresh = false } = options;
    if (showLoader) {
      setPortfolioLoading(true);
    }
    
    // Helper function to update portfolio from dashboard state
    const updatePortfolioFromState = (dashboardState: DashboardState, source: string) => {
      try {
        // Expose latest dashboard state globally so helpers (like getOpenOrdersInfo)
        // can access unified open_position_counts without threading state through
        // multiple layers. This is read-only on the client.
        (window as Window & { __LAST_DASHBOARD_STATE__?: DashboardState }).__LAST_DASHBOARD_STATE__ = dashboardState;
      } catch {
        // Ignore if window is not available (e.g., during SSR)
      }
      
      // Set bot status - only update if we have valid status data
      // Preserve last known status on transient errors (don't immediately mark as stopped)
      if (dashboardState.bot_status) {
        // Only update to "stopped" if we have a clear reason or explicit stopped status
        // If reason is "Status unavailable (checking...)", preserve last known status
        if (dashboardState.bot_status.status === 'stopped' && 
            dashboardState.bot_status.reason === 'Status unavailable (checking...)') {
          // This is a transient error - don't update status
          // Bot status unavailable during initial load, using last known status
        } else {
          setBotStatus(dashboardState.bot_status);
        }
      }
      
      console.log(`🔍 ${source} - dashboardState:`, {
        source: dashboardState.source,
        balancesCount: dashboardState.balances?.length || 0,
        totalUsd: dashboardState.total_usd_value,
        hasBalances: !!dashboardState.balances && dashboardState.balances.length > 0,
        balances: dashboardState.balances?.slice(0, 5).map(b => ({
          asset: b.asset,
          balance: b.balance,
          total: b.total,
          usd_value: b.usd_value,
          market_value: b.market_value
        })) || []
      });
      
      const dashboardFetchFailed = dashboardState.errors?.some(err => err?.startsWith('FETCH_FAILED')) ?? false;

      const fallbackToEmbeddedPortfolio = (_reason?: string) => {
        // Silenced verbose warnings - this is expected behavior
        // if (reason) {
        //   console.warn(reason);
        // }
        const fallbackAssets = dashboardState.portfolio?.assets ?? [];
        const fallbackTotal =
          dashboardState.portfolio?.total_value_usd
          ?? dashboardState.total_usd_value
          ?? fallbackAssets.reduce((sum, asset) => sum + (asset.value_usd ?? 0), 0);
        console.log(`📊 Falling back to embedded portfolio data (${fallbackAssets.length} assets, total=$${fallbackTotal.toFixed(2)})`);
        setPortfolio({ assets: fallbackAssets, total_value_usd: fallbackTotal });
        // setPortfolioLastUpdate(new Date()); // Removed - not currently used
        setPortfolioError(dashboardFetchFailed ? PORTFOLIO_UNAVAILABLE_MESSAGE : null);
      };

      if (dashboardState.balances && dashboardState.balances.length > 0) {
        const normalizedBalances = dashboardState.balances.filter(bal => bal?.asset);
        setRealBalances(normalizedBalances);

        console.log(`${source} - normalized balance sample:`, normalizedBalances[0]);

        const assetsWithValues = dashboardBalancesToPortfolioAssets(normalizedBalances)
          .filter(asset => asset && asset.coin) // Additional safety filter
          .map(asset => ({
          ...asset,
          updated_at: new Date().toISOString()
        }));

        if (assetsWithValues.length > 0) {
          // Calculate total as sum of ALL asset values (including negatives)
          const calculatedTotal = assetsWithValues.reduce((sum, asset) => sum + (asset.value_usd ?? 0), 0);
          // Use calculated total (sum of all values) instead of backend value
          const totalUsd = calculatedTotal;
          
          // Calculate borrowed amount: sum of negative USD/USDT balances
          const borrowedAmount = assetsWithValues
            .filter(asset => {
              const coin = asset.coin?.toUpperCase() || '';
              return (coin === 'USD' || coin === 'USDT') && (asset.value_usd ?? 0) < 0;
            })
            .reduce((sum, asset) => sum + Math.abs(asset.value_usd ?? 0), 0);
          
          if (borrowedAmount > 0) {
            setTotalBorrowed(borrowedAmount);
          }

          console.log(`✅ Processed ${assetsWithValues.length} assets from ${normalizedBalances.length} balances`);
          console.log(`📊 Total Portfolio Value (backend=${dashboardState.total_usd_value ?? 0}, calculated=${calculatedTotal})`);

          const assetsWithUsd = assetsWithValues.filter(a => (a.value_usd ?? 0) > 0);
          if (assetsWithUsd.length === 0) {
            // Silenced: This is expected when backend hasn't computed USD values yet
            // console.warn('⚠️ WARNING: Portfolio has balances but USD values are 0. Backend should calculate USD values on next sync.');
          } else {
            // Silenced verbose logging
            // console.log(`💰 Assets with USD values (${assetsWithUsd.length}/${assetsWithValues.length}):`);
            assetsWithUsd.slice(0, 10).forEach(asset => {
              console.log(`   ${asset.coin}: $${asset.value_usd?.toFixed(2) ?? '0.00'} (balance: ${asset.balance.toFixed(8)})`);
            });
          }

          setPortfolio({ assets: assetsWithValues, total_value_usd: totalUsd });
          // setPortfolioLastUpdate(new Date()); // Removed - not currently used
          setPortfolioError(dashboardFetchFailed ? PORTFOLIO_UNAVAILABLE_MESSAGE : null);
          return true; // Successfully updated
        } else {
          // Silenced: This is expected when backend hasn't computed USD values yet
          // fallbackToEmbeddedPortfolio('⚠️ Balances returned but no USD values were computed. Using embedded portfolio object.');
          fallbackToEmbeddedPortfolio();
          return false;
        }
      } else {
        fallbackToEmbeddedPortfolio('⚠️ No balances in dashboardState, using embedded portfolio data');
        return false;
      }
    };
    
    try {
      // STEP 1: Load snapshot FIRST (fast, cached)
      console.log('📸 Loading dashboard snapshot (fast)...');
      let snapshotLoaded = false;
      try {
        const snapshot = await getDashboardSnapshot();
        const dashboardState = snapshot.data;
        
        // Update snapshot metadata
        setSnapshotStale(snapshot.stale);
        setSnapshotStaleSeconds(snapshot.stale_seconds);
        if (snapshot.last_updated_at) {
          setSnapshotLastUpdated(new Date(snapshot.last_updated_at));
        }
        
        // Only update portfolio if snapshot has data and is not empty
        if (!snapshot.empty && dashboardState.balances && dashboardState.balances.length > 0) {
          console.log(`✅ Snapshot loaded with ${dashboardState.balances.length} balances - displaying immediately`);
          snapshotLoaded = updatePortfolioFromState(dashboardState, 'fetchPortfolio:snapshot');

          if (Array.isArray(dashboardState.open_orders_summary)) {
            setOpenOrdersSummary(dashboardState.open_orders_summary);
            setOpenOrdersSummaryLoading(false);
            const updatedAt = snapshot.last_updated_at ? new Date(snapshot.last_updated_at) : new Date();
            setOpenOrdersSummaryLastUpdate(updatedAt);
          }
          
          // Fetch loan data and TP/SL values (non-blocking)
          (async () => {
      try {
        const loansUrl = `${getApiUrl()}/loans`;
        const loansResponse = await fetch(loansUrl, { signal: AbortSignal.timeout(5000) });
        if (loansResponse.ok) {
          const loans = await loansResponse.json() as Loan[];
          const totalBorrowedAmount = loans.reduce((sum: number, loan: Loan) => sum + (loan.borrowed_usd_value || 0), 0);
          setTotalBorrowed(totalBorrowedAmount);
        }
      } catch {
        // Silently handle loans fetch errors - not critical for dashboard
        setTotalBorrowed(0);
      }
      
      try {
        const tpSlValues = await getTPSLOrderValues();
        setTpSlOrderValues(tpSlValues);
      } catch {
        // Silently handle TP/SL fetch errors - optional feature
        setTpSlOrderValues({});
      }
          })();
        } else {
          // Snapshot is empty during initial load, will refresh in background
        }
      } catch (snapshotErr) {
        logHandledError(
          'fetchPortfolio:snapshot',
          'Failed to load snapshot - will try background refresh',
          snapshotErr,
          'warn'
        );
      }
      
      // STEP 2: Background refresh with full state (only if not already doing background refresh)
      if (!backgroundRefresh) {
        console.log('🔄 Starting background refresh with full dashboard state...');
        // Don't await - let it run in background without blocking UI
        (async () => {
          try {
            const dashboardState = await getDashboardState();
            console.log('✅ Background refresh completed - updating portfolio with fresh data');
            updatePortfolioFromState(dashboardState, 'fetchPortfolio:background');
            if (Array.isArray(dashboardState.open_orders_summary)) {
              setOpenOrdersSummary(dashboardState.open_orders_summary);
              setOpenOrdersSummaryLastUpdate(new Date());
              setOpenOrdersSummaryLoading(false);
            }
            
            // Also update snapshot metadata if available
            try {
              const freshSnapshot = await getDashboardSnapshot();
              setSnapshotStale(freshSnapshot.stale);
              setSnapshotStaleSeconds(freshSnapshot.stale_seconds);
              if (freshSnapshot.last_updated_at) {
                setSnapshotLastUpdated(new Date(freshSnapshot.last_updated_at));
              }
            } catch (snapshotErr) {
              const errorMsg = snapshotErr instanceof Error ? snapshotErr.message : String(snapshotErr);
              // Only log if it's not a network error (those are expected occasionally)
              if (!errorMsg.includes('Failed to fetch') && !errorMsg.includes('NetworkError')) {
                console.debug('Background snapshot refresh error:', snapshotErr);
              }
              // Ignore snapshot errors in background refresh - keep showing last good data
            }
          } catch (refreshErr) {
            logHandledError(
              'fetchPortfolio:background',
              'Background refresh failed - keeping snapshot data visible',
              refreshErr,
              'warn'
            );
            // Don't clear portfolio on background refresh failure - keep showing snapshot
            // Only show warning if we didn't have snapshot data
            if (!snapshotLoaded) {
              setPortfolioError('Background refresh failed. Showing cached data if available.');
            }
          }
        })();
      }
      
      // If snapshot didn't load any data, we still show empty but don't block
      if (!snapshotLoaded) {
        // Portfolio data not available yet, will load in background
      }
    } catch (err) {
      logHandledError(
        'fetchPortfolio',
        'Failed to fetch portfolio - keeping last known data visible',
        err,
        'warn'
      );
      // Don't clear portfolio on error - keep showing last known data
      setPortfolioError('Failed to load portfolio. Retrying in background...');
    } finally {
      setPortfolioLoading(false);
    }
  }, [getAssetPrice]);

  // Function to remove duplicate coins
  // Calculate SL/TP values based on current price and signals
  const calculateSLTPValues = useCallback((coin: TopCoin) => {
    const currentPrice = coin?.current_price;
    const signal = signals[coin?.instrument_name];
    const isAggressive = coinTradeStatus[coin?.instrument_name + '_sl_tp'];
    const slOverride = coinSLPercent[coin?.instrument_name];
    const tpOverride = coinTPPercent[coin?.instrument_name];
    
    console.log(`🔍 Calculating SL/TP for ${coin?.instrument_name}:`, {
      currentPrice,
      hasSignal: !!signal,
      isAggressive,
      slOverride,
      tpOverride,
      res_up: signal?.res_up,
      res_down: signal?.res_down
    });
    
    if (!currentPrice || !signal || !coin?.instrument_name) {
      // Missing data for coin during initial load (normal)
      return { sl: 0, tp: 0 };
    }
    
    let slPrice = 0;
    let tpPrice = 0;
    
    // Calculate SL Price
    if (slOverride && slOverride !== '') {
      // Override exists: currentPrice × (1 + value/100)
      const slValue = parseFloat(slOverride);
      if (!isNaN(slValue)) {
        slPrice = currentPrice * (1 + slValue / 100);
      }
    } else {
      // No override: Use resistance levels
      if (isAggressive) {
        // Aggressive: Use res_down for SL (below current price)
        slPrice = signal.res_down || (currentPrice * 0.98);
      } else {
        // Conservative: Use res_down for SL (below current price) - more conservative = lower SL
        slPrice = signal.res_down || (currentPrice * 0.97);
      }
    }
    
    // Calculate TP Price
    if (tpOverride && tpOverride !== '') {
      // Override exists: currentPrice × (1 + value/100)
      const tpValue = parseFloat(tpOverride);
      if (!isNaN(tpValue)) {
        tpPrice = currentPrice * (1 + tpValue / 100);
      }
    } else {
      // No override: Use resistance levels
      if (isAggressive) {
        // Aggressive: Use res_up for TP (above current price)
        tpPrice = signal.res_up || (currentPrice * 1.04);
      } else {
        // Conservative: Use res_up for TP (above current price) - more conservative = higher TP
        tpPrice = signal.res_up || (currentPrice * 1.06);
      }
    }
    
    const result = {
      sl: slPrice,
      tp: tpPrice
    };
    
    console.log(`✅ Final SL/TP for ${coin.instrument_name}:`, result);
    console.log(`🔍 SL Price details: ${slPrice} (type: ${typeof slPrice})`);
    console.log(`🔍 TP Price details: ${tpPrice} (type: ${typeof tpPrice})`);
    return result;
  }, [signals, coinTradeStatus, coinSLPercent, coinTPPercent]);

  const handleQueueSuccess = useCallback((queue: 'fast' | 'slow') => {
    const state = schedulerRef.current;
    if (queue === 'fast') {
      state.fastErrorCount = 0;
      state.fastBackoffMs = REFRESH_FAST_MS;
      state.fastPausedUntil = 0;
      lastFastErrorRef.current = null;
      setFastQueueRateLimited(false);
    } else {
      state.slowErrorCount = 0;
      state.slowBackoffMs = REFRESH_SLOW_MS;
    }
  }, [setFastQueueRateLimited]);

  const handleQueueError = useCallback((queue: 'fast' | 'slow', error: unknown) => {
    const apiError = error as ApiError | undefined;
    const state = schedulerRef.current;

    if (queue === 'fast') {
      state.fastErrorCount += 1;
      lastFastErrorRef.current = apiError ?? null;

      const retryFromHeader = apiError?.retryAfterMs ?? 0;
      if (apiError?.status === RATE_LIMIT_STATUS) {
        const penalty = Math.min(
          MAX_FAST_BACKOFF_MS,
          Math.max(REFRESH_SLOW_MS, retryFromHeader || REFRESH_SLOW_MS)
        );
        state.fastBackoffMs = penalty;
        state.fastPausedUntil = Date.now() + penalty;
        console.warn(`⚠️ Fast queue rate-limited. Backing off to ${penalty}ms`);
        setFastQueueRateLimited(true);
      } else if ((apiError?.status ?? 0) >= 500 || !apiError?.status) {
        const penalty = Math.min(
          MAX_FAST_BACKOFF_MS,
          Math.max(REFRESH_FAST_MS, state.fastBackoffMs * 2)
        );
        state.fastBackoffMs = penalty;
        state.fastPausedUntil = Date.now() + penalty;
        console.warn(`⚠️ Fast queue server error (${apiError?.status ?? 'n/a'}). Backoff=${penalty}ms`);
      } else {
        console.warn(`⚠️ Fast queue error without status`, apiError);
      }
    } else {
      state.slowErrorCount += 1;
      const penalty = Math.min(
        REFRESH_SLOW_MS * 4,
        Math.max(REFRESH_SLOW_MS, state.slowBackoffMs * 1.5)
      );
      state.slowBackoffMs = penalty;
      console.warn(`⚠️ Slow queue error (${apiError?.status ?? 'n/a'}). Backoff=${penalty}ms`);
    }
  }, [setFastQueueRateLimited]);

  const loadCachedTopCoins = useCallback(() => {
    try {
      const cached = localStorage.getItem('top_coins_cache');
      if (!cached) {
        return false;
      }
      const parsed = JSON.parse(cached) as {
        coins?: TopCoin[];
        fetchedAt?: string | number;
      };
      if (parsed?.coins?.length) {
        updateTopCoins(parsed.coins);
        if (parsed.fetchedAt) {
          const date = new Date(parsed.fetchedAt);
          if (!Number.isNaN(date.valueOf())) {
            setLastTopCoinsFetchAt(date);
          }
        }
        setTopCoinsError(null);
        setTopCoinsLoading(false);
        console.log(`💾 Loaded ${parsed.coins.length} cached top coins snapshot`);
        return true;
      }
    } catch (err) {
      console.warn('Failed to load cached top coins snapshot:', err);
    }
    return false;
  }, [updateTopCoins]);

  const formatTimeAgo = useCallback((date?: Date) => {
    if (!date) return '—';
    const diff = Date.now() - date.getTime();
    if (!Number.isFinite(diff) || diff < 0) return '—';
    if (diff < 1000) return 'now';
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  }, []);

  const buildLastUpdatedTitle = useCallback((symbol: string) => {
    const timestamps = lastUpdateTimes[symbol];
    if (!timestamps) {
      return 'Price: —\nSignals: —';
    }
    const priceLabel = timestamps.price ? formatDateTime(timestamps.price) : '—';
    const signalsLabel = timestamps.signals ? formatDateTime(timestamps.signals) : '—';
    return `Price: ${priceLabel}\nSignals: ${signalsLabel}`;
  }, [lastUpdateTimes]);

  // Fetch trading signals for a symbol
  const fetchSignals = useCallback(async (symbol: string) => {
    try {
      // OPTIMIZATION: Removed 500ms delay - batching in runFastTick already handles throttling
      // This reduces total processing time and prevents unnecessary delays
      
      // Load signal config from localStorage if available
      const savedConfig = localStorage.getItem('signal_config');
      const config = savedConfig ? JSON.parse(savedConfig) : null;

      const signalData = await getTradingSignals(symbol, config);
      let updatedSignal = signalData ? { ...signalData } : null;
      let price = updatedSignal?.price ?? 0;

      // NO external API calls - use only backend data
      // If price not available in signal, try to find it in topCoins (backend-processed data)
      if (!price || price <= 0) {
        const coin = topCoinsRef.current.find(c => c.instrument_name === symbol);
        if (coin?.current_price && coin.current_price > 0) {
          price = coin.current_price;
          if (updatedSignal) {
            updatedSignal = { ...updatedSignal, price: coin.current_price };
          }
          applyPriceToTopCoins(symbol, coin.current_price);
          console.log(`✅ Found price for ${symbol} in topCoins: $${coin.current_price}`);
        } else {
          console.debug(`⚠️ No price available for ${symbol} in backend data (signal or topCoins)`);
        }
      } else {
        applyPriceToTopCoins(symbol, price);
      }

      if (updatedSignal) {
        setSignals(prev => ({
          ...prev,
          [symbol]: { ...(prev[symbol] || {}), ...updatedSignal } as TradingSignals,
        }));
      }
      
      // Record signals update time - preserve existing price update time if available
      const now = new Date();
      setLastUpdateTimes(prev => ({
        ...prev,
        [symbol]: {
          price: prev[symbol]?.price || now,  // Preserve existing price time, use now if first time
          signals: now  // Always update signals time
        }
      }));
      
      console.log(`📊 Updated signals for ${symbol}:`, price || 'no price available');
    } catch (err) {
      // Handle circuit breaker errors gracefully - they're protection mechanisms, not real errors
      const error = err as Error & { status?: number; retryAfterMs?: number };
      if (error.message?.includes('Circuit breaker open')) {
        // Circuit breaker is open - this is expected behavior when endpoint is failing
        // Don't log as error, just skip this fetch silently
        // The circuit breaker will auto-reset after timeout
        const retryAfter = error.retryAfterMs ? Math.ceil(error.retryAfterMs / 1000) : 30;
        console.debug(`⏸️ Signals circuit breaker open for ${symbol}, skipping fetch. Will auto-retry in ~${retryAfter}s`);
        // Don't throw - just silently skip this fetch
        return;
      }
      
      // For other errors, log and re-throw
      logHandledError(
        `fetchSignals:${symbol}`,
        `Failed to fetch signals for ${symbol}; will retry`,
        err
      );
      throw err;
    }
  }, [applyPriceToTopCoins]);

  const runFastTick = useCallback(async () => {
    const symbols = fastQueueRef.current;
    if (!symbols.length) {
      return;
    }

    // Also update top coins data for Trade YES coins ONLY (they need frequent price updates)
    const fetchTopCoinsFn = (fetchTopCoinsRef.current || (() => Promise.resolve()));
    try {
      await fetchTopCoinsFn(true, true);
    } catch (err) {
      // Don't fail the entire fast tick if top coins fetch fails
      console.warn('⚠️ Failed to fetch top coins (Trade YES) in fast tick:', err);
      // Update timestamp even on error to show last attempt time
      setLastTopCoinsFetchAt(new Date());
    }

    console.log(`🔄 Fast tick: Processing ${symbols.length} symbols (Trade YES) at ${new Date().toLocaleTimeString()}`);
    for (let i = 0; i < symbols.length; i += FAST_BATCH_SIZE) {
      const batch = symbols.slice(i, i + FAST_BATCH_SIZE);
      console.log(`📊 Fast batch ${i / FAST_BATCH_SIZE + 1}:`, batch);
      const results = await Promise.allSettled(batch.map(symbol => fetchSignals(symbol)));
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure) {
        throw failure.reason;
      }
      if (i + FAST_BATCH_SIZE < symbols.length) {
        await wait(FAST_STAGGER_MS);
      }
    }
    console.log(`✅ Fast tick completed for ${symbols.length} symbols`);
  }, [fetchSignals]);

  // We need to use refs to avoid circular dependency issues
  const fetchTopCoinsRef = useRef<((preserveLocalChanges?: boolean, filterTradeYes?: boolean) => Promise<void>) | null>(null);
  const fetchPortfolioRef = useRef<(() => Promise<void>) | null>(null);
  const fetchOpenOrdersRef = useRef<(() => Promise<void>) | null>(null);
  const fetchOpenOrdersSummaryRef = useRef<((options?: { showLoader?: boolean; backgroundRefresh?: boolean }) => Promise<void>) | null>(null);
  const fetchExecutedOrdersRef = useRef<((options?: { showLoader?: boolean; limit?: number; offset?: number; loadAll?: boolean }) => Promise<void>) | null>(null);
  const fetchSignalsRef = useRef<((symbol: string) => Promise<void>) | null>(null);

  const runSlowTick = useCallback(async () => {
    // Use refs to avoid circular dependency - these will be set by useEffect hooks
    const fetchPortfolioFn = (fetchPortfolioRef.current || (() => Promise.resolve()));
    const fetchOpenOrdersFn = (fetchOpenOrdersRef.current || (() => Promise.resolve()));
    const fetchExecutedOrdersFn = (fetchExecutedOrdersRef.current || (() => Promise.resolve()));
    const fetchTopCoinsFn = (fetchTopCoinsRef.current || (() => Promise.resolve()));
    const fetchSignalsFn = (fetchSignalsRef.current || (() => Promise.resolve()));

    await Promise.allSettled([
      fetchPortfolioFn(),
      fetchOpenOrdersFn(),
      fetchExecutedOrdersFn({ showLoader: false }),
    ]);
    
    // Update top coins data for Trade NO coins (less frequent updates)
    // Also fetch ALL coins periodically to ensure all prices are updated
    try {
      await fetchTopCoinsFn(true, undefined);
      // Fetch ALL coins every 3rd slow tick to ensure all prices are updated
      // This ensures coins without Trade YES/NO status also get price updates
      const slowTickCount = schedulerRef.current.slowTickCount || 0;
      if (slowTickCount % 3 === 0) {
        console.log('🔄 Fetching ALL coins (no filter) to update all prices');
        await fetchTopCoinsFn(true, undefined);
      }
      schedulerRef.current.slowTickCount = slowTickCount + 1;
    } catch (err) {
      // Don't fail the entire slow tick if top coins fetch fails
      console.warn('⚠️ Failed to fetch top coins (Trade NO) in slow tick:', err);
      // Update timestamp even on error to show last attempt time
      setLastTopCoinsFetchAt(new Date());
    }

    const slowSymbols = slowQueueRef.current;
    if (!slowSymbols.length) {
      console.log('⏸️ Slow queue empty, skipping signals update');
      return;
    }

    console.log(`🔄 Slow tick: Processing ${slowSymbols.length} symbols (Trade NO) at ${new Date().toLocaleTimeString()}`);
    for (let i = 0; i < slowSymbols.length; i += SLOW_BATCH_SIZE) {
      const batch = slowSymbols.slice(i, i + SLOW_BATCH_SIZE);
      console.log(`📊 Slow batch ${i / SLOW_BATCH_SIZE + 1}:`, batch);
      const results = await Promise.allSettled(batch.map(symbol => fetchSignalsFn(symbol)));
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure) {
        throw failure.reason;
      }
      if (i + SLOW_BATCH_SIZE < slowSymbols.length) {
        await wait(FAST_STAGGER_MS * 2);
      }
    }
    console.log(`✅ Slow tick completed for ${slowSymbols.length} symbols`);
  }, []);

  const scheduleFastTick = useCallback((delay?: number) => {
    const state = schedulerRef.current;

    if (state.fastTimer) {
      clearTimeout(state.fastTimer);
      state.fastTimer = null;
    }

    if (fastQueueRef.current.length === 0) {
      return;
    }

    const now = Date.now();
    let waitMs = delay ?? state.fastBackoffMs;
    if (delay === undefined) {
      if (state.fastPausedUntil > now) {
        waitMs = Math.max(waitMs, state.fastPausedUntil - now);
      }
      waitMs = Math.max(REFRESH_FAST_MS, waitMs);
    }
    
    console.log(`⏰ Scheduling fast tick in ${waitMs}ms (${waitMs / 1000}s)`);

    const tick = async () => {
      markJobStart();
      try {
        await runFastTick();
        handleQueueSuccess('fast');
      } catch (err) {
        handleQueueError('fast', err);
      } finally {
        markJobEnd();
        const hasFast = fastQueueRef.current.length > 0;
        if (hasFast) {
          scheduleFastTick();
        } else {
          state.fastTimer = null;
        }
      }
    };

    state.fastTimer = setTimeout(tick, waitMs);
  }, [handleQueueError, handleQueueSuccess, markJobEnd, markJobStart, runFastTick]);

  const scheduleSlowTick = useCallback((delay?: number) => {
    const state = schedulerRef.current;

    if (state.slowTimer) {
      clearTimeout(state.slowTimer);
      state.slowTimer = null;
    }

    let waitMs = delay ?? state.slowBackoffMs;
    if (delay === undefined) {
      waitMs = Math.max(REFRESH_SLOW_MS, waitMs);
    }
    
    console.log(`⏰ Scheduling slow tick in ${waitMs}ms (${waitMs / 1000}s)`);

    const tick = async () => {
      markJobStart();
      try {
        await runSlowTick();
        handleQueueSuccess('slow');
      } catch (err) {
        handleQueueError('slow', err);
      } finally {
        markJobEnd();
        scheduleSlowTick();
      }
    };

    state.slowTimer = setTimeout(tick, waitMs);
  }, [handleQueueError, handleQueueSuccess, markJobEnd, markJobStart, runSlowTick]);

  useEffect(() => {
    const state = schedulerRef.current;

    const coins = topCoinsRef.current;
    if (coins.length === 0) {
      fastQueueRef.current = [];
      slowQueueRef.current = [];
      if (state.fastTimer) {
        clearTimeout(state.fastTimer);
        state.fastTimer = null;
      }
      if (!state.slowTimer) {
        scheduleSlowTick();
      }
      return;
    }

    const fastSymbolSet = new Set(
      coins
        .filter((coin) => coin.instrument_name && coinTradeStatus[coin.instrument_name] === true)
        .map((coin) => coin.instrument_name)
        .filter((symbol): symbol is string => Boolean(symbol))
    );
    const fastSymbols = Array.from(fastSymbolSet);
    const slowSymbolSet = new Set(
      coins
        .filter((coin) => coin.instrument_name && coinTradeStatus[normalizeSymbolKey(coin.instrument_name)] !== true)
        .map((coin) => coin.instrument_name)
        .filter((symbol): symbol is string => Boolean(symbol))
    );
    const slowSymbols = Array.from(slowSymbolSet).filter(symbol => !fastSymbolSet.has(symbol));
    
    console.log(`🔀 Queue separation: Fast (YES)=${fastSymbols.length}, Slow (NO)=${slowSymbols.length}`);
    if (fastSymbols.length > 0) console.log(`  Fast symbols:`, fastSymbols);
    if (slowSymbols.length > 0) console.log(`  Slow symbols:`, slowSymbols);

    const newFastSignature = fastSymbols.slice().sort().join('|');
    const currentFastSignature = fastQueueRef.current.slice().sort().join('|');

    if (newFastSignature !== currentFastSignature) {
      fastQueueRef.current = fastSymbols;
      if (fastSymbols.length === 0) {
        if (state.fastTimer) {
          clearTimeout(state.fastTimer);
          state.fastTimer = null;
        }
      } else {
        state.fastBackoffMs = Math.max(
          REFRESH_FAST_MS,
          Math.min(state.fastBackoffMs, MAX_FAST_BACKOFF_MS)
        );
        state.fastPausedUntil = 0;
        scheduleFastTick(0);
      }
    } else if (fastSymbols.length > 0 && !state.fastTimer) {
      scheduleFastTick(REFRESH_FAST_MS);
    }

    const newSlowSignature = slowSymbols.slice().sort().join('|');
    const currentSlowSignature = slowQueueRef.current.slice().sort().join('|');
    if (newSlowSignature !== currentSlowSignature) {
      slowQueueRef.current = slowSymbols;
      if (!state.slowTimer) {
        scheduleSlowTick();
      }
    } else if (!state.slowTimer && coins.length > 0) {
      console.log('🔄 No slow timer running, scheduling slow tick');
      scheduleSlowTick();
    } else if (!state.slowTimer && slowSymbols.length > 0) {
      console.log('🔄 No slow timer running but slow symbols exist, scheduling slow tick');
      scheduleSlowTick();
    }
  }, [coinTradeStatus, coinMembershipSignature, scheduleFastTick, scheduleSlowTick]);

  useEffect(() => {
    return () => {
      const state = schedulerRef.current;
      if (state.fastTimer) {
        clearTimeout(state.fastTimer);
        state.fastTimer = null;
      }
      if (state.slowTimer) {
        clearTimeout(state.slowTimer);
        state.slowTimer = null;
      }
    };
  }, []);

  const removeDuplicates = useCallback((coins: TopCoin[]) => {
    const seen = new Set<string>();
    const cleaned = coins.filter(coin => {
      const key = coin.instrument_name.toLowerCase();
      if (seen.has(key)) {
        console.log(`🔄 Removing duplicate: ${coin.instrument_name}`);
        return false;
      }
      seen.add(key);
      return true;
    });
    
    // Also remove coins that are too similar (e.g., BTC_USD and BTC_USDT) for major bases only
    const dedupeByQuoteBases = new Set(['BTC', 'ETH']);
    const finalCoins: TopCoin[] = [];
    for (const coin of cleaned) {
      const [base, quote] = coin.instrument_name.split('_');
      const shouldCheckSimilar = base ? dedupeByQuoteBases.has(base.toUpperCase()) : false;
      const isDuplicate = finalCoins.some(existing => {
        const [existingBase, existingQuote] = existing.instrument_name.split('_');
        if (!shouldCheckSimilar) {
          return false;
        }
        return existingBase === base && 
               (existingQuote === quote || 
                (existingQuote === 'USDT' && quote === 'USD') ||
                (existingQuote === 'USD' && quote === 'USDT'));
      });
      
      if (isDuplicate) {
        console.log(`🔄 Removing similar coin: ${coin.instrument_name} (similar to existing)`);
      } else {
        finalCoins.push(coin);
      }
    }
    
    console.log(`✅ Duplicate removal: ${coins.length} → ${finalCoins.length} coins`);
    return finalCoins;
  }, []);

  // Fetch top coins - now supports filtering by Trade YES/NO
  const fetchTopCoins = useCallback(async (preserveLocalChanges = false, filterTradeYes?: boolean) => {
    if (!preserveLocalChanges) {
      setTopCoinsLoading(true);
    }
    try {
      const filterType = filterTradeYes === true ? 'Trade YES' : filterTradeYes === false ? 'Trade NO' : 'ALL';
      console.log(`🔄 fetchTopCoins called (${filterType}), preserveLocalChanges:`, preserveLocalChanges);
      const data = await getTopCoins();
      console.log('📊 getTopCoins response:', data);
      let fetchedCoins: TopCoin[] = data.coins || [];
      console.log('📊 fetchedCoins length (before filter):', fetchedCoins.length);
      console.log('📊 fetchedCoins symbols (first 10):', fetchedCoins.slice(0, 10).map(c => c.instrument_name));
      
      // Filter coins by Trade YES/NO status if specified
      if (filterTradeYes !== undefined) {
        const filteredCoins = fetchedCoins.filter(coin => {
          const isTradeYes = coinTradeStatus[normalizeSymbolKey(coin.instrument_name)] === true;
          return filterTradeYes ? isTradeYes : !isTradeYes;
        });
        console.log(`📊 Filtered to ${filterType}: ${filteredCoins.length} coins`);
        fetchedCoins = filteredCoins;
      }
      
      // ALWAYS filter out deleted coins (both on first load and auto-refresh)
      // BUT: Never filter out BTC and ETH (common major coins that shouldn't be permanently hidden)
      try {
        const deletedCoins = localStorage.getItem('deleted_coins');
        if (deletedCoins) {
          const deletedList = JSON.parse(deletedCoins) as string[];
          // Protected coins that should never be filtered out
          const protectedCoins = ['BTC_USDT', 'BTC_USD', 'ETH_USDT', 'ETH_USD', 'BTC', 'ETH'];
          
          // Remove protected coins from deleted list (they shouldn't be permanently hidden)
          const filteredDeletedList = deletedList.filter(coin => {
            const coinUpper = coin.toUpperCase();
            // Check if this deleted coin matches any protected coin exactly or contains it
            return !protectedCoins.some(protectedCoin => {
              const protectedUpper = protectedCoin.toUpperCase();
              // Exact match or coin contains protected coin (e.g., ETH_USDT contains ETH)
              return coinUpper === protectedUpper || coinUpper.includes(protectedUpper);
            });
          });
          
          // If we removed any protected coins, update localStorage
          if (filteredDeletedList.length !== deletedList.length) {
            const removedCoins = deletedList.filter(coin => !filteredDeletedList.includes(coin));
            console.log('🛡️ Restored protected coins from deleted list:', removedCoins);
            if (filteredDeletedList.length === 0) {
              localStorage.removeItem('deleted_coins');
            } else {
              localStorage.setItem('deleted_coins', JSON.stringify(filteredDeletedList));
            }
          }
          
          // Filter fetched coins, but ALWAYS include protected coins even if they're in deleted list
          console.log('🗑️ Filtering out deleted coins:', filteredDeletedList);
          const beforeCount = fetchedCoins.length;
          const protectedCoinsSet = new Set(protectedCoins.map(c => c.toUpperCase()));
          const restoredCustomCoins: string[] = [];
          fetchedCoins = fetchedCoins.filter(coin => {
            const coinName = coin.instrument_name.toUpperCase();
            // Never filter out protected coins - check if coin name matches any protected coin
            const isProtected = Array.from(protectedCoinsSet).some(protectedCoin => {
              return coinName === protectedCoin || coinName.includes(protectedCoin) || protectedCoin.includes(coinName.split('_')[0]);
            });
            const isCustom = coin.is_custom === true || ('source' in coin && coin.source === 'custom');
            if (isProtected) {
              console.log(`🛡️ Keeping protected coin: ${coin.instrument_name}`);
              return true; // Always show protected coins
            }
            // Filter out if it's in the deleted list
            const isDeleted = filteredDeletedList.some(deleted => deleted.toUpperCase() === coinName);
            // FIX: Always show coins returned by backend, even if they're in deleted list (they were explicitly returned by backend)
            // Only filter out if coin is in deleted list AND it's not a custom coin (custom coins are always restored)
            if (isDeleted && isCustom) {
              console.log(`🧩 Restoring custom coin previously deleted: ${coin.instrument_name}`);
              restoredCustomCoins.push(coin.instrument_name);
              return true;
            }
            // FIX: Show all coins returned by backend by default - don't filter based on deleted list
            // The deleted list is only used for coins that are NOT returned by backend
            return true;
          });
          console.log(`✅ Filtered fetched coins: ${beforeCount} → ${fetchedCoins.length} (removed ${beforeCount - fetchedCoins.length} deleted coins)`);

          if (restoredCustomCoins.length > 0) {
            const updatedDeletedList = filteredDeletedList.filter(
              coin => !restoredCustomCoins.some(restored => restored.toUpperCase() === coin.toUpperCase())
            );
            if (updatedDeletedList.length === 0) {
              localStorage.removeItem('deleted_coins');
            } else {
              localStorage.setItem('deleted_coins', JSON.stringify(updatedDeletedList));
            }
            console.log(`🧼 Updated deleted coins list after restoring customs:`, restoredCustomCoins);
          }
        }
      } catch (err) {
        console.warn('Failed to check deleted coins:', err);
      }
      
      const cleanedCoins = removeDuplicates(fetchedCoins);
      console.log('🧹 cleanedCoins length:', cleanedCoins.length);
      
      // CRITICAL DEBUG: Check if LDO_USD is in the cleaned coins (silenced - not critical)
      // const ldoInCleaned = cleanedCoins.find(c => c.instrument_name.toUpperCase().includes('LDO'));
      // if (ldoInCleaned) {
      //   console.log(`✅ LDO found in cleanedCoins: ${ldoInCleaned.instrument_name}`);
      // } else {
      //   console.warn(`❌ LDO NOT found in cleanedCoins! Total coins: ${cleanedCoins.length}`);
      //   console.warn(`   First 10 symbols:`, cleanedCoins.slice(0, 10).map(c => c.instrument_name));
      // }
      
      // Debug: Log first few coins' prices
      if (cleanedCoins.length > 0) {
        console.log('💰 First 3 coins prices:', cleanedCoins.slice(0, 3).map(c => ({
          symbol: c.instrument_name,
          price: c.current_price
        })));
      }
      
      // Determine which symbols to update (only filtered ones, or all if no filter)
      const symbolsToUpdate = filterTradeYes !== undefined 
        ? cleanedCoins.map(c => c.instrument_name)
        : undefined;
      
      // CRITICAL DEBUG: Verify LDO_USD before calling updateTopCoins
      const ldoBeforeUpdate = cleanedCoins.find(c => c.instrument_name.toUpperCase().includes('LDO'));
      console.log(`🔍 Before updateTopCoins: LDO_USD ${ldoBeforeUpdate ? 'FOUND' : 'NOT FOUND'} in cleanedCoins`);
      
      updateTopCoins(cleanedCoins, symbolsToUpdate);
      console.log(`✅ updateTopCoins called with ${cleanedCoins.length} coins${symbolsToUpdate ? ` (${symbolsToUpdate.length} filtered)` : ''}`);
      
      // Initialize alert status from backend data to keep frontend and backend in sync
      const buyAlertStatusFromBackend: Record<string, boolean> = {};
      const sellAlertStatusFromBackend: Record<string, boolean> = {};
      cleanedCoins.forEach(coin => {
        if (coin.instrument_name && coin.buy_alert_enabled !== undefined) {
          buyAlertStatusFromBackend[coin.instrument_name] = coin.buy_alert_enabled;
        }
        if (coin.instrument_name && coin.sell_alert_enabled !== undefined) {
          sellAlertStatusFromBackend[coin.instrument_name] = coin.sell_alert_enabled;
        }
      });
      if (Object.keys(buyAlertStatusFromBackend).length > 0) {
        setCoinBuyAlertStatus(prev => ({ ...prev, ...buyAlertStatusFromBackend }));
        console.log('✅ Initialized buy_alert_enabled from backend:', Object.keys(buyAlertStatusFromBackend).length, 'coins');
      }
      if (Object.keys(sellAlertStatusFromBackend).length > 0) {
        setCoinSellAlertStatus(prev => ({ ...prev, ...sellAlertStatusFromBackend }));
        console.log('✅ Initialized sell_alert_enabled from backend:', Object.keys(sellAlertStatusFromBackend).length, 'coins');
      }
      
      // CRITICAL DEBUG: Verify LDO_USD after updateTopCoins
      setTimeout(() => {
        const currentCoins = topCoinsRef.current;
        const ldoAfterUpdate = currentCoins.find(c => c.instrument_name.toUpperCase().includes('LDO'));
        console.log(`🔍 After updateTopCoins: LDO_USD ${ldoAfterUpdate ? 'FOUND' : 'NOT FOUND'} in topCoins (total: ${currentCoins.length})`);
        if (!ldoAfterUpdate && ldoBeforeUpdate) {
          console.error(`❌ LDO_USD DISAPPEARED after updateTopCoins! This is the bug.`);
        }
      }, 100);
      const fetchedAt = new Date();
      try {
        localStorage.setItem(
          'top_coins_cache',
          JSON.stringify({ coins: cleanedCoins, fetchedAt: fetchedAt.toISOString() })
        );
      } catch (cacheErr) {
        console.warn('Failed to persist top coins snapshot:', cacheErr);
      }
      setLastTopCoinsFetchAt(fetchedAt);
      setTopCoinsError(null);

      if (preserveLocalChanges) {
        try {
          const localAmounts = localStorage.getItem('watchlist_amounts');
          const localSLPercent = localStorage.getItem('watchlist_sl_percent');
          const localTPPercent = localStorage.getItem('watchlist_tp_percent');
          
          if (localAmounts) {
            const parsedAmounts = JSON.parse(localAmounts);
            setCoinAmounts(prev => ({ ...prev, ...parsedAmounts }));
          }
          if (localSLPercent) {
            const parsedSL = JSON.parse(localSLPercent);
            setCoinSLPercent(prev => ({ ...prev, ...parsedSL }));
          }
          if (localTPPercent) {
            const parsedTP = JSON.parse(localTPPercent);
            setCoinTPPercent(prev => ({ ...prev, ...parsedTP }));
          }
        } catch (err) {
          console.warn('Failed to preserve watchlist values:', err);
        }
      }
      
      // Only load saved settings if we're not preserving local changes
      if (!preserveLocalChanges) {
        // PRIMARY: Try to load from localStorage (temporary, will be overridden by backend)
        // NOTE: Backend values will take priority when they arrive
        try {
          const localAmounts = localStorage.getItem('watchlist_amounts');
          const localTradeStatus = localStorage.getItem('watchlist_trade_status');
          const localAlertStatus = localStorage.getItem('watchlist_alert_status');
          const localSLPercent = localStorage.getItem('watchlist_sl_percent');
          const localTPPercent = localStorage.getItem('watchlist_tp_percent');
          
          // Load from localStorage as temporary initial state
          // Backend values will override these when they arrive
          // CRITICAL: Clean stale $10 values before loading
          if (localAmounts) {
            const parsedAmounts = JSON.parse(localAmounts) as Record<string, string>;
            // Remove all values that are exactly "10", "10.0", or "10.00" (obsolete defaults)
            const cleanedAmounts: Record<string, string> = {};
            Object.entries(parsedAmounts).forEach(([symbol, value]) => {
              const isStaleValue = value === '10' || value === '10.0' || value === '10.00';
              if (!isStaleValue) {
                cleanedAmounts[symbol] = value;
              }
            });
            
            // Only load cleaned values (non-$10 values)
            if (Object.keys(cleanedAmounts).length > 0) {
              setCoinAmounts(prev => ({
                ...prev,
                ...cleanedAmounts
              }));
            }
          }
          if (localTradeStatus) {
            setCoinTradeStatus(prev => ({
              ...prev,
              ...(JSON.parse(localTradeStatus) as Record<string, boolean>)
            }));
          }
          if (localAlertStatus) {
            setCoinAlertStatus(prev => ({
              ...prev,
              ...(JSON.parse(localAlertStatus) as Record<string, boolean>)
            }));
          }
          if (localSLPercent) {
            setCoinSLPercent(prev => ({
              ...prev,
              ...(JSON.parse(localSLPercent) as Record<string, string>)
            }));
          }
          if (localTPPercent) {
            setCoinTPPercent(prev => ({
              ...prev,
              ...(JSON.parse(localTPPercent) as Record<string, string>)
            }));
          }
          
          console.log('✅ Loaded watchlist settings from localStorage');
        } catch (err) {
          console.warn('Failed to load from localStorage:', err);
        }
        
        // SECONDARY: Always load from backend database and update localStorage
        // SIMPLIFIED APPROACH: Backend updates localStorage, dashboard only reads from localStorage
        try {
          // Always load from backend to get the latest saved values
          const dashboardItems: WatchlistItem[] = await getDashboard();
            // Store watchlist items for TP/SL counting
            setWatchlistItems(dashboardItems);
            
            // Build clean data structures from backend (source of truth)
            const backendAmounts: { [key: string]: string } = {};
            const backendTradeStatus: { [key: string]: boolean } = {};
            const backendMarginStatus: { [key: string]: boolean } = {};
            const backendSlTpStatus: { [key: string]: boolean } = {};
            const backendSLPercent: { [key: string]: string } = {};
            const backendTPPercent: { [key: string]: string } = {};
            const backendSLPrices: { [key: string]: number } = {};
            const backendTPPrices: { [key: string]: number } = {};
            const backendAlertStatus: { [key: string]: boolean } = {};
            const backendBuyAlertStatus: { [key: string]: boolean } = {};
            const backendSellAlertStatus: { [key: string]: boolean } = {};
            
            // Get all backend symbols to know which ones are managed by backend
            const backendSymbols = new Set(
              dashboardItems
                .map(item => item.symbol?.toUpperCase())
                .filter(Boolean) as string[]
            );
            
            dashboardItems.forEach(item => {
              if (item.symbol) {
                const symbolUpper = item.symbol.toUpperCase();
                // Only save non-null values from backend
                if (item.trade_amount_usd !== undefined && item.trade_amount_usd !== null) {
                  backendAmounts[symbolUpper] = item.trade_amount_usd.toString();
                }
                if (item.trade_enabled !== undefined && item.trade_enabled !== null) {
                  backendTradeStatus[symbolUpper] = item.trade_enabled;
                }
                if (item.alert_enabled !== undefined && item.alert_enabled !== null) {
                  backendAlertStatus[symbolUpper] = item.alert_enabled;
                }
                if (item.buy_alert_enabled !== undefined && item.buy_alert_enabled !== null) {
                  backendBuyAlertStatus[symbolUpper] = item.buy_alert_enabled;
                }
                if (item.sell_alert_enabled !== undefined && item.sell_alert_enabled !== null) {
                  backendSellAlertStatus[symbolUpper] = item.sell_alert_enabled;
                }
                if (item.trade_on_margin !== undefined && item.trade_on_margin !== null) {
                  backendMarginStatus[symbolUpper + '_margin'] = item.trade_on_margin;
                }
                if (item.sl_tp_mode === 'aggressive') {
                  backendSlTpStatus[symbolUpper + '_sl_tp'] = true;
                }
                // Only load percentages from backend if they are explicitly set (not null/undefined/0)
                if (item.sl_percentage !== undefined && item.sl_percentage !== null && item.sl_percentage !== 0) {
                  backendSLPercent[symbolUpper] = item.sl_percentage.toString();
                }
                if (item.tp_percentage !== undefined && item.tp_percentage !== null && item.tp_percentage !== 0) {
                  backendTPPercent[symbolUpper] = item.tp_percentage.toString();
                }
                if (item.sl_price !== undefined && item.sl_price !== null) {
                  backendSLPrices[symbolUpper] = item.sl_price;
                }
                if (item.tp_price !== undefined && item.tp_price !== null) {
                  backendTPPrices[symbolUpper] = item.tp_price;
                }
                // min_price_change_pct will be loaded via useEffect after coinPresets is initialized
              }
            });
            
            // CRITICAL: Update localStorage with backend values (backend is source of truth)
            // For symbols NOT in backend, preserve existing localStorage values (user changes not yet saved)
            // Declare cleaned variables in outer scope so they're accessible after the try block
            let cleanedAmounts: Record<string, string> = { ...backendAmounts };
            let cleanedTradeStatus: Record<string, boolean> = {
              ...backendTradeStatus,
              ...backendMarginStatus,
              ...backendSlTpStatus
            };
            let cleanedSLPercent: Record<string, string> = { ...backendSLPercent };
            let cleanedTPPercent: Record<string, string> = { ...backendTPPercent };
            let cleanedAlertStatus: Record<string, boolean> = { ...backendAlertStatus };
            
            try {
              // Amounts: Backend values + preserve non-backend symbols from localStorage
              const existingAmounts = localStorage.getItem('watchlist_amounts');
              const existingAmountsObj = existingAmounts ? JSON.parse(existingAmounts) as Record<string, string> : {};
              cleanedAmounts = { ...backendAmounts };
              Object.entries(existingAmountsObj).forEach(([symbol, value]) => {
                const symbolUpper = symbol.toUpperCase();
                if (!backendSymbols.has(symbolUpper) && !(symbolUpper in cleanedAmounts)) {
                  // Symbol not in backend - preserve localStorage value
                  cleanedAmounts[symbolUpper] = value;
                }
              });
              localStorage.setItem('watchlist_amounts', JSON.stringify(cleanedAmounts));
              
              // Trade Status: Backend values + preserve non-backend symbols
              const existingTradeStatus = localStorage.getItem('watchlist_trade_status');
              const existingTradeStatusObj = existingTradeStatus ? JSON.parse(existingTradeStatus) as Record<string, boolean> : {};
              cleanedTradeStatus = {
                ...backendTradeStatus,
                ...backendMarginStatus,
                ...backendSlTpStatus
              };
              Object.entries(existingTradeStatusObj).forEach(([symbol, value]) => {
                const symbolUpper = symbol.toUpperCase();
                const isBackendSymbol = backendSymbols.has(symbolUpper) || 
                  Array.from(backendSymbols).some(bs => symbolUpper.startsWith(bs));
                if (!isBackendSymbol && !(symbolUpper in cleanedTradeStatus)) {
                  cleanedTradeStatus[symbolUpper] = value;
                }
              });
              localStorage.setItem('watchlist_trade_status', JSON.stringify(cleanedTradeStatus));
              
              // SL/TP Percent: Backend values + preserve non-backend symbols
              const existingSLPercent = localStorage.getItem('watchlist_sl_percent');
              const existingSLPercentObj = existingSLPercent ? JSON.parse(existingSLPercent) as Record<string, string> : {};
              cleanedSLPercent = { ...backendSLPercent };
              Object.entries(existingSLPercentObj).forEach(([symbol, value]) => {
                const symbolUpper = symbol.toUpperCase();
                if (!backendSymbols.has(symbolUpper) && !(symbolUpper in cleanedSLPercent)) {
                  cleanedSLPercent[symbolUpper] = value;
                }
              });
              localStorage.setItem('watchlist_sl_percent', JSON.stringify(cleanedSLPercent));
              
              const existingTPPercent = localStorage.getItem('watchlist_tp_percent');
              const existingTPPercentObj = existingTPPercent ? JSON.parse(existingTPPercent) as Record<string, string> : {};
              cleanedTPPercent = { ...backendTPPercent };
              Object.entries(existingTPPercentObj).forEach(([symbol, value]) => {
                const symbolUpper = symbol.toUpperCase();
                if (!backendSymbols.has(symbolUpper) && !(symbolUpper in cleanedTPPercent)) {
                  cleanedTPPercent[symbolUpper] = value;
                }
              });
              localStorage.setItem('watchlist_tp_percent', JSON.stringify(cleanedTPPercent));
              
              // Alert Status: Backend values + preserve non-backend symbols
              const existingAlertStatus = localStorage.getItem('watchlist_alert_status');
              const existingAlertStatusObj = existingAlertStatus ? JSON.parse(existingAlertStatus) as Record<string, boolean> : {};
              cleanedAlertStatus = { ...backendAlertStatus };
              Object.entries(existingAlertStatusObj).forEach(([symbol, value]) => {
                const symbolUpper = symbol.toUpperCase();
                if (!backendSymbols.has(symbolUpper) && !(symbolUpper in cleanedAlertStatus)) {
                  cleanedAlertStatus[symbolUpper] = value;
                }
              });
              localStorage.setItem('watchlist_alert_status', JSON.stringify(cleanedAlertStatus));
              
              // Buy/Sell Alert Status
              if (Object.keys(backendBuyAlertStatus).length > 0) {
                localStorage.setItem('watchlist_buy_alert_status', JSON.stringify(backendBuyAlertStatus));
              }
              if (Object.keys(backendSellAlertStatus).length > 0) {
                localStorage.setItem('watchlist_sell_alert_status', JSON.stringify(backendSellAlertStatus));
              }
              
              console.log('✅ Updated localStorage from backend:', {
                amounts: Object.keys(cleanedAmounts).length,
                tradeStatus: Object.keys(cleanedTradeStatus).length,
                slPercent: Object.keys(cleanedSLPercent).length,
                tpPercent: Object.keys(cleanedTPPercent).length,
                alertStatus: Object.keys(cleanedAlertStatus).length
              });
            } catch (err) {
              console.warn('Failed to update localStorage from backend:', err);
            }
            
            // Now load from localStorage (which now has backend values) into state
            // This ensures dashboard only reads from localStorage
            setCoinAmounts(cleanedAmounts);
            setCoinTradeStatus(cleanedTradeStatus);
            setCoinSLPercent(cleanedSLPercent);
            setCoinTPPercent(cleanedTPPercent);
            setCoinAlertStatus(cleanedAlertStatus);
            if (Object.keys(backendBuyAlertStatus).length > 0) {
              setCoinBuyAlertStatus(backendBuyAlertStatus);
            }
            if (Object.keys(backendSellAlertStatus).length > 0) {
              setCoinSellAlertStatus(backendSellAlertStatus);
            }
            
            // Load saved SL/TP prices
            if (Object.keys(backendSLPrices).length > 0) {
              setCalculatedSL(backendSLPrices);
              console.log('✅ Loaded saved SL prices from database:', backendSLPrices);
            }
            if (Object.keys(backendTPPrices).length > 0) {
              setCalculatedTP(backendTPPrices);
              console.log('✅ Loaded saved TP prices from database:', backendTPPrices);
            }
            
            console.log('✅ Loaded watchlist settings from backend and updated localStorage:', {
              items: dashboardItems.length,
              amounts: Object.keys(cleanedAmounts).length,
              tradeStatus: Object.keys(cleanedTradeStatus).length,
              slPercent: Object.keys(cleanedSLPercent).length,
              tpPercent: Object.keys(cleanedTPPercent).length,
              alertStatus: Object.keys(cleanedAlertStatus).length
            });
            
            // OLD COMPLEX MERGE CODE REMOVED - Now using simplified approach:
            // Backend updates localStorage, dashboard reads from localStorage
            // All state is now loaded from localStorage above (lines 3748-3756)
        } catch (err) {
          console.warn('Failed to load from backend, using localStorage:', err);
        }
      }
    } catch (err) {
      logHandledError(
        'fetchTopCoins',
        'Failed to fetch top coins; using cached data if available',
        err
      );
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setTopCoinsError(errorMessage);
      
      // Update timestamp even on error to show last attempt time
      const errorTimestamp = new Date();
      setLastTopCoinsFetchAt(errorTimestamp);
      console.warn(`⚠️ fetchTopCoins failed at ${errorTimestamp.toISOString()}: ${errorMessage}`);
      
      // Always try to load cached coins on error, even if we already have some
      // This ensures we show as many coins as possible
      const hadCache = loadCachedTopCoins();
      if (!hadCache && topCoinsRef.current.length === 0) {
        console.warn('⚠️ No cached coins available and fetch failed - watchlist will be empty');
      }
      
      // Don't throw error - let the cached coins display
      // This allows the UI to show cached data even if the fetch fails
      return;
    } finally {
      if (!preserveLocalChanges) {
        setTopCoinsLoading(false);
      }
    }
  }, [updateTopCoins, removeDuplicates, loadCachedTopCoins]);

  // Fetch open orders
  const fetchOpenOrders = useCallback(async (options: { showLoader?: boolean; backgroundRefresh?: boolean } = {}) => {
    const { showLoader = false, backgroundRefresh = false } = options;
    if (showLoader) {
      setOpenOrdersLoading(true);
    }
    setOpenOrdersError(null);
    
    // Helper function to update orders from dashboard state
    const updateOrdersFromState = (dashboardState: DashboardState, source: string): boolean => {
      if (dashboardState.open_orders && dashboardState.open_orders.length > 0) {
        // Map DashboardOrder to OpenOrder format
        const mappedOrders: OpenOrder[] = dashboardState.open_orders.map(order => {
          // DEBUG: Log raw order data from backend
          // Type guard for extended order properties
          type ExtendedOrder = typeof order & {
            create_time?: number;
            create_datetime?: string;
            cumulative_value?: number | string;
            cumulative_quantity?: number | string;
            order_value?: number | string;
            avg_price?: number | string;
          };
          const extendedOrder = order as ExtendedOrder;
          
          if (dashboardState.open_orders.indexOf(order) === 0) {
            console.log(`🔍 ${source} - Raw order from backend:`, {
              exchange_order_id: order.exchange_order_id,
              symbol: order.symbol,
              create_time: extendedOrder.create_time,
              create_datetime: extendedOrder.create_datetime,
              created_at: order.created_at,
              raw_order: order
            });
          }
          
          // Prefer create_time (timestamp) if available, otherwise parse from created_at
          const createTime = extendedOrder.create_time 
            ? extendedOrder.create_time 
            : (order.created_at 
            ? new Date(order.created_at).getTime() 
              : Date.now());
          
          // Prefer create_datetime (human-readable) if available, otherwise use created_at
          const createDatetime = extendedOrder.create_datetime 
            ? extendedOrder.create_datetime 
            : (order.created_at || 'N/A');
          
          const updateTime = order.updated_at 
            ? new Date(order.updated_at).getTime() 
            : Date.now();
          
          const mappedOrder = {
            order_id: order.exchange_order_id,
            instrument_name: order.symbol,
            side: order.side || 'UNKNOWN',
            order_type: order.order_type || 'LIMIT',
            quantity: order.quantity?.toString() || '0',
            price: order.price?.toString() || '0',
            status: order.status || 'UNKNOWN',
            create_time: createTime,
            create_datetime: createDatetime ?? (order.created_at || 'N/A'), // Ensure create_datetime exists
            created_at: order.created_at, // Also include created_at as fallback
            update_time: updateTime,
            cumulative_value: extendedOrder.cumulative_value?.toString() || null,
            cumulative_quantity: extendedOrder.cumulative_quantity?.toString() || null,
            order_value: extendedOrder.order_value?.toString() || null,
            avg_price: extendedOrder.avg_price?.toString() || null
          };
          
          // DEBUG: Log mapped order
          if (dashboardState.open_orders.indexOf(order) === 0) {
            console.log(`🔍 ${source} - Mapped order:`, mappedOrder);
          }
          
          return mappedOrder;
        });
        
        console.log(`📋 ${source} - Loaded ${mappedOrders.length} open orders`);
        setOpenOrders(mappedOrders);
        setOpenOrdersLastUpdate(new Date());
        setOpenOrdersError(null);
        return true; // Successfully updated
      }
      return false; // No orders found
    };
    
    try {
      // STEP 1: Load snapshot FIRST (fast, cached)
      console.log('📸 Loading open orders from snapshot (fast)...');
      let snapshotLoaded = false;
        try {
        const snapshot = await getDashboardSnapshot();
        const dashboardState = snapshot.data;
        
        // Only update orders if snapshot has data and is not empty
        if (!snapshot.empty && dashboardState.open_orders && dashboardState.open_orders.length > 0) {
          console.log(`✅ Snapshot loaded with ${dashboardState.open_orders.length} orders - displaying immediately`);
          snapshotLoaded = updateOrdersFromState(dashboardState, 'fetchOpenOrders:snapshot');
        } else {
          // Snapshot is empty during initial load, will refresh in background
        }
      } catch (snapshotErr) {
        const errorMsg = snapshotErr instanceof Error ? snapshotErr.message : String(snapshotErr);
        // Only log if it's not a network error (those are expected occasionally)
        if (!errorMsg.includes('Failed to fetch') && !errorMsg.includes('NetworkError')) {
          logHandledError(
            'fetchOpenOrders:snapshot',
            'Failed to load snapshot - will try background refresh',
            snapshotErr,
            'warn'
          );
          } else {
          console.debug('Open orders snapshot network error (expected occasionally):', errorMsg);
        }
      }
      
      // STEP 2: Background refresh with full state (only if not already doing background refresh)
      if (!backgroundRefresh) {
        console.log('🔄 Starting background refresh for open orders...');
        // Don't await - let it run in background without blocking UI
        (async () => {
          try {
            const dashboardState = await getDashboardState();
            console.log('✅ Background refresh completed - updating orders with fresh data');
            updateOrdersFromState(dashboardState, 'fetchOpenOrders:background');
          } catch (refreshErr) {
      logHandledError(
              'fetchOpenOrders:background',
              'Background refresh failed - keeping snapshot data visible',
              refreshErr,
              'warn'
            );
            // Don't clear orders on background refresh failure - keep showing snapshot
            // Try legacy fallback only if snapshot also failed
            if (!snapshotLoaded) {
      try {
        const response = await getOpenOrders();
        setOpenOrders(response.orders || []);
        setOpenOrdersLastUpdate(new Date());
        setOpenOrdersError(null);
      } catch (fallbackErr) {
        logHandledError(
          'fetchOpenOrders:fallback',
                  'Legacy open orders fallback also failed',
                  fallbackErr,
                  'warn'
                );
                // Don't clear orders - keep last known state
                setOpenOrdersError('Failed to refresh orders. Showing cached data if available.');
              }
            }
          }
        })();
      }
      
      // If snapshot didn't load any data, we still show empty but don't block
      if (!snapshotLoaded) {
        // Open orders not available yet, will load in background
      }
    } catch (err) {
      logHandledError(
        'fetchOpenOrders',
        'Failed to fetch open orders - keeping last known data visible',
        err,
        'warn'
      );
      // Don't clear orders on error - keep showing last known data
      setOpenOrdersError('Failed to load orders. Retrying in background...');
    } finally {
      setOpenOrdersLoading(false);
    }
  }, []);


  // Fetch open orders summary with snapshot-first pattern
  const fetchOpenOrdersSummary = useCallback(async (options: { showLoader?: boolean; backgroundRefresh?: boolean } = {}) => {
    const { showLoader = false, backgroundRefresh = false } = options;
    
    if (showLoader) {
    setOpenOrdersSummaryLoading(true);
    }
    
    try {
      console.log('📸 Loading open orders summary...');
      const response = await getOpenOrdersSummary();
      const orders = response.orders || [];
      
      // Store raw orders
      setOpenOrdersSummary(orders);
      
      // Transform to positions (pass portfolio assets for accurate entry price)
      const positions = transformOrdersToPositions(orders, portfolio?.assets);
      setOpenOrdersPositions(positions);
      
      setOpenOrdersSummaryLastUpdate(response.last_updated ? new Date(response.last_updated) : new Date());
      console.log(`✅ Open orders summary loaded: ${orders.length} orders, ${positions.length} positions`);
      if (orders.length > 0 && positions.length === 0) {
        console.warn('⚠️ Orders transformed but no positions created. Orders:', orders.slice(0, 3).map(o => ({
          symbol: o.symbol,
          side: o.side,
          client_oid: o.client_oid,
          order_id: o.order_id
        })));
      }
    } catch (err) {
      console.error('Failed to fetch open orders summary:', err);
      // Don't clear existing data on error - keep showing last known data
      // Only show error if we don't have any data yet
      if (openOrdersPositions.length === 0) {
        console.warn('⚠️ No open orders summary data available yet - will retry in background');
      } else {
        console.warn('⚠️ Background refresh failed - keeping existing data visible');
      }
    } finally {
      if (showLoader) {
      setOpenOrdersSummaryLoading(false);
    }
    }
  }, [portfolio?.assets, openOrdersPositions.length]);

  // Fetch expected take profit summary
  const fetchExpectedTakeProfitSummary = useCallback(async () => {
    try {
      setExpectedTPLoading(true);
      const response = await getExpectedTakeProfitSummary();
      setExpectedTPSummary(response.summary || []);
      setExpectedTPLastUpdate(response.last_updated ? new Date(response.last_updated) : new Date());
      console.log(`✅ Expected take profit summary loaded: ${response.total_symbols} symbols`);
    } catch (err) {
      console.error('Failed to fetch expected take profit summary:', err);
      setExpectedTPSummary([]);
    } finally {
      setExpectedTPLoading(false);
    }
  }, []);

  // Fetch expected take profit details for a symbol
  const fetchExpectedTPDetails = useCallback(async (symbol: string) => {
    try {
      setExpectedTPDetailsLoading(true);
      setExpectedTPDetailsSymbol(symbol);
      const details = await getExpectedTakeProfitDetails(symbol);
      setExpectedTPDetails(details);
      setShowExpectedTPDetailsDialog(true);
    } catch (err) {
      console.error(`Failed to fetch expected take profit details for ${symbol}:`, err);
      setExpectedTPDetails(null);
    } finally {
      setExpectedTPDetailsLoading(false);
    }
  }, []);

  // Fetch summary when tab is active
  useEffect(() => {
    if (activeTab === 'expected-take-profit') {
      const hasData = expectedTPSummary.length > 0;
      if (!hasData) {
        fetchExpectedTakeProfitSummary();
      }
    }
  }, [activeTab, fetchExpectedTakeProfitSummary, expectedTPSummary.length]);

  // Background polling for expected take profit summary when tab is active
  useEffect(() => {
    if (activeTab !== 'expected-take-profit') {
      return;
    }

    const initialDelay = expectedTPSummary.length > 0 ? 60000 : 0;
    
    const pollInterval = setInterval(() => {
      console.log('🔄 Background refresh of expected take profit summary...');
      fetchExpectedTakeProfitSummary();
    }, 60000); // Refresh every 60 seconds

    // Note: timeoutId is set but the timeout callback is intentionally empty
    // The pollInterval is already started above, this timeout is just a placeholder
    const timeoutId = setTimeout(() => {
      // Timeout intentionally left empty - pollInterval is already active
    }, initialDelay);

    return () => {
      clearInterval(pollInterval);
      clearTimeout(timeoutId);
    };
  }, [activeTab, fetchExpectedTakeProfitSummary, expectedTPSummary.length]);

  // Background polling for Telegram messages (always active)
  useEffect(() => {
    fetchTelegramMessages();
    const interval = setInterval(() => {
      fetchTelegramMessages({ silent: true });
    }, TELEGRAM_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchTelegramMessages]);

  // Mark Telegram messages as read when Monitoring tab is active
  useEffect(() => {
    if (activeTab === 'monitoring') {
      markAllAsRead(telegramMessages);
    }
  }, [activeTab, markAllAsRead, telegramMessages]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const storedOrder = localStorage.getItem('watchlist_order');
      if (storedOrder) {
        const parsed = JSON.parse(storedOrder) as Record<string, number>;
        setWatchlistOrder(parsed);
      }
    } catch (err) {
      logHandledError(
        'localStorage:watchlist_order:load',
        'Failed to restore watchlist order from localStorage',
        err,
      );
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (Object.keys(watchlistOrder).length === 0) {
        localStorage.removeItem('watchlist_order');
        return;
      }
      localStorage.setItem('watchlist_order', JSON.stringify(watchlistOrder));
    } catch (err) {
      logHandledError(
        'localStorage:watchlist_order:save',
        'Failed to persist watchlist order to localStorage',
        err,
      );
    }
  }, [watchlistOrder]);

  useEffect(() => {
    if (!topCoins.length) return;

    setWatchlistOrder((prev) => {
      const next = { ...prev };
      const symbolsSet = new Set(topCoins.map((coin) => coin.instrument_name));
      let changed = false;

      const existingOrders = Object.values(next).filter((value) => Number.isFinite(value));
      let maxOrder = existingOrders.length ? Math.max(...existingOrders) : 0;

      topCoins.forEach((coin) => {
        if (next[coin.instrument_name] === undefined) {
          maxOrder += 1;
          next[coin.instrument_name] = maxOrder;
          changed = true;
        }
      });

      Object.keys(next).forEach((symbol) => {
        if (!symbolsSet.has(symbol)) {
          delete next[symbol];
          changed = true;
        }
      });

      return changed ? next : prev;
    });
  }, [topCoins]);

  // Fetch executed orders - loads all orders with pagination
  const fetchExecutedOrders = useCallback(async (options: { showLoader?: boolean; limit?: number; offset?: number; loadAll?: boolean } = {}) => {
    // Use smaller limit for initial load to avoid backend overload (500 orders can be heavy)
    // Only use large limit when explicitly refreshing
    const { showLoader = false, limit = showLoader ? 500 : 50, offset = 0, loadAll = showLoader } = options;
    console.log('🔄 fetchExecutedOrders called with options:', { showLoader, limit, offset, loadAll });
    
    // Always set loading to true when function is called (whether initial load or manual refresh)
    // This ensures loading state is shown during fetch
    setExecutedOrdersLoading(true);
    setExecutedOrdersError(null);
    
    // Safety timeout: ensure loading state is cleared after 60 seconds even if request hangs
    const loadingTimeout = setTimeout(() => {
      console.warn('⚠️ fetchExecutedOrders timeout - clearing loading state');
      setExecutedOrdersLoading(false);
    }, 60000);
    try {
      console.log('📡 Starting to fetch executed orders...');
      let allNewOrders: OpenOrder[] = [];
      let currentOffset = offset;
      const pageLimit = limit;
      let hasMore = true;
      let pageCount = 0;
      const maxPages = 20; // Safety limit: max 20 pages = 10,000 orders
      
      // Load all pages if loadAll is true, otherwise just load one page
      while (hasMore && (loadAll || pageCount === 0) && pageCount < maxPages) {
        try {
          // Only sync from exchange on-demand (first page) when user explicitly refreshes (showLoader=true).
          const shouldSync = pageCount === 0 && showLoader;
          console.log(`📥 Fetching page ${pageCount + 1} (offset=${currentOffset}, limit=${pageLimit}, sync=${shouldSync})`);
          const response = await getOrderHistory(pageLimit, currentOffset, shouldSync);
          console.log(`✅ Received response: ${response.orders?.length || 0} orders, has_more=${response.has_more}`);
          const pageOrders = response.orders || [];
          
          if (pageOrders.length === 0) {
            hasMore = false;
            break;
          }
          
          allNewOrders = [...allNewOrders, ...pageOrders];
          pageCount++;
          
          // Check if there are more orders
          if (response.has_more === false || pageOrders.length < pageLimit) {
            hasMore = false;
          } else {
            currentOffset += pageLimit;
          }
          
          // If not loading all, stop after first page
          if (!loadAll) {
            break;
          }
        } catch (pageError) {
          console.error(`Error loading page ${pageCount + 1} of executed orders:`, pageError);
          // If first page fails and we have no orders yet, throw error
          // But if we already have some orders, continue with what we have
          if (pageCount === 0 && allNewOrders.length === 0) {
            throw pageError;
          }
          // If we have some orders already, log warning but continue
          if (allNewOrders.length > 0) {
            console.warn(`⚠️ Page ${pageCount + 1} failed, but continuing with ${allNewOrders.length} orders already loaded`);
          }
          // Stop pagination if a page fails (but keep what we've loaded so far)
          hasMore = false;
          break;
        }
      }
      
      console.log(`📥 Fetched ${allNewOrders.length} executed orders from ${pageCount} page(s)`);
      
      // Merge by order_id (update existing + add new) using functional update
      setExecutedOrders(prevOrders => {
        const merged = new Map(prevOrders.map(o => [o.order_id, o] as const));
        let addedCount = 0;
        let updatedCount = 0;

        for (const order of allNewOrders) {
          if (merged.has(order.order_id)) {
            updatedCount += 1;
          } else {
            addedCount += 1;
          }
          merged.set(order.order_id, order);
        }

        const mergedOrders = Array.from(merged.values());
        // Keep newest first (fall back safely if update_time is missing).
        mergedOrders.sort((a, b) => (Number(b.update_time || 0) - Number(a.update_time || 0)));

        setExecutedOrdersLastUpdate(new Date());
        console.log(`✅ Executed orders merged: +${addedCount} new, ~${updatedCount} updated, total=${mergedOrders.length}`);
        return mergedOrders;
      });
      setExecutedOrdersError(null);
    } catch (err) {
      console.error('❌ Error in fetchExecutedOrders:', err);
      logHandledError(
        'fetchExecutedOrders',
        'Failed to fetch executed orders (request will retry on next tick)',
        err
      );
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      if (errorMsg.includes('timeout') || errorMsg.includes('Timeout')) {
        setExecutedOrdersError('Request timeout - the server may be processing. Please try again.');
      } else if (errorMsg.includes('Failed to fetch') || errorMsg.includes('Network')) {
        setExecutedOrdersError('Network error - please check your connection and try again.');
      } else {
        setExecutedOrdersError(`Error loading orders: ${errorMsg}`);
      }
    } finally {
      // CRITICAL: Always set loading to false, even if there was an error
      // This ensures the button is never permanently disabled
      clearTimeout(loadingTimeout);
      console.log('✅ fetchExecutedOrders completed, setting loading to false');
      setExecutedOrdersLoading(false);
    }
  }, []); // Remove executedOrders from dependencies to avoid infinite loops

  // Fetch data sources status
  const fetchDataSourceStatus = useCallback(async () => {
    try {
      const status = await getDataSourcesStatus();
      setDataSourceStatus(status);
    } catch (err) {
      logHandledError(
        'fetchDataSourceStatus',
        'Failed to fetch data source status; will retry on next refresh',
        err
      );
    }
  }, []);

  // Fetch trading configuration
  const fetchTradingConfig = useCallback(async () => {
    try {
      const config = await getTradingConfig();
      setTradingConfig(config);
      
      // Load coin presets from config
      if (config?.coins) {
        const presets: Record<string, string> = {};
        Object.entries(config.coins).forEach(([symbol, coinConfig]) => {
          if (coinConfig?.preset) {
            presets[symbol] = coinConfig.preset;
          }
        });
        setCoinPresets(prev => ({ ...presets, ...prev }));
      }
      
      // Load preset configuration from backend (if available)
      // Priority: strategy_rules (new format) > presets (legacy format)
      // Backend format: { strategy_rules: { swing: { rules: { Conservative: {...}, Aggressive: {...} } } } }
      // OR legacy: { presets: { swing: { rules: { Conservative: {...}, Aggressive: {...} } } } }
      // CRITICAL FIX: Start with empty object, NOT defaults - backend is source of truth
      const backendPresetsConfig: PresetConfig = {} as PresetConfig;
      
      // First, try to load from strategy_rules (new format, source of truth)
      if (config?.strategy_rules) {
        // [CONFIG] Log raw backend response
        console.log('[CONFIG] Raw backend strategy_rules received:', JSON.stringify(config.strategy_rules, null, 2));
        
        Object.entries(config.strategy_rules).forEach(([presetKey, presetData]) => {
          const presetPayload = presetData as { rules?: Record<string, StrategyRules>; notificationProfile?: string } | undefined;
          // Convert backend key (lowercase) to frontend key (capitalized)
          const presetName = presetKey.charAt(0).toUpperCase() + presetKey.slice(1) as Preset;
          
          if (presetPayload?.rules) {
            // CRITICAL FIX: Use backend values directly, don't merge with defaults
            // Deep copy rules to preserve nested objects like maChecks
            const rulesCopy: Record<RiskMode, StrategyRules> = {} as Record<RiskMode, StrategyRules>;
            
            // Copy each risk mode rule with deep copy of nested objects
            Object.entries(presetPayload.rules).forEach(([riskMode, rule]) => {
              if (riskMode === 'Conservative' || riskMode === 'Aggressive') {
                // [CONFIG] Log each rule being loaded
                console.log('[CONFIG] Loading rule from backend:', {
                  preset: presetName,
                  risk: riskMode,
                  volumeMinRatio: rule.volumeMinRatio,
                  type: typeof rule.volumeMinRatio,
                  fullRule: rule
                });
                
                rulesCopy[riskMode as RiskMode] = {
                  ...rule,
                  // Deep copy maChecks to preserve exact backend values
                  maChecks: rule.maChecks ? { ...rule.maChecks } : { ema10: false, ma50: false, ma200: false },
                  // Deep copy rsi to preserve exact backend values
                  rsi: rule.rsi ? { ...rule.rsi } : { buyBelow: 40, sellAbove: 70 },
                  // Deep copy sl and tp
                  sl: rule.sl ? { ...rule.sl } : {},
                  tp: rule.tp ? { ...rule.tp } : {},
                };
              }
            });
            
            backendPresetsConfig[presetName] = {
              notificationProfile: (presetPayload.notificationProfile as 'swing' | 'intraday' | 'scalp') || 
                (presetName === 'Swing' ? 'swing' : presetName === 'Intraday' ? 'intraday' : 'scalp'),
              rules: rulesCopy
            };
          }
        });
        console.log('✅ Loaded preset configuration from strategy_rules (new format)');
      }
      // Fallback to presets (legacy format) - also check here if strategy_rules is empty
      if (!config?.strategy_rules && config?.presets) {
        console.log('⚠️ No strategy_rules found, loading from presets (legacy format)');
        Object.entries(config.presets).forEach(([presetKey, presetData]) => {
          const presetPayload = presetData as { rules?: Record<string, StrategyRules>; notificationProfile?: string } | undefined;
          // Convert backend key (lowercase) to frontend key (capitalized)
          const presetName = presetKey.charAt(0).toUpperCase() + presetKey.slice(1) as Preset;
          
          if (presetPayload?.rules) {
            // Backend has new format with rules structure
            // CRITICAL: Don't merge with defaults - use backend values directly
            const rulesCopy: Record<RiskMode, StrategyRules> = {} as Record<RiskMode, StrategyRules>;
            
            // Copy rules from backend, ensuring proper typing
            if (presetPayload.rules.Conservative) {
              rulesCopy.Conservative = { ...presetPayload.rules.Conservative };
            }
            if (presetPayload.rules.Aggressive) {
              rulesCopy.Aggressive = { ...presetPayload.rules.Aggressive };
            }
            
            backendPresetsConfig[presetName] = {
              notificationProfile: (presetPayload.notificationProfile as 'swing' | 'intraday' | 'scalp' | undefined) || 
                (presetName === 'Swing' ? 'swing' : presetName === 'Intraday' ? 'intraday' : 'scalp'),
              rules: rulesCopy
            };
            // Debug: log maChecks from presets (legacy)
            Object.entries(presetPayload.rules).forEach(([riskMode, rules]) => {
              console.log(`📥 Presets (legacy) ${presetName}-${riskMode} maChecks:`, JSON.stringify(rules.maChecks, null, 2));
            });
          }
        });
        console.log('✅ Loaded preset configuration from presets (legacy format)');
      }
      
      // Update presetsConfig with backend data - BACKEND IS SOURCE OF TRUTH
      // 
      // CRITICAL: Risk-mode-level merge to prevent overwriting custom values like volumeMinRatio
      // 
      // We must merge at the risk-mode level (not preset level) because:
      // 1. Backend may only have partial data (e.g., only Conservative rules updated)
      // 2. If we replace the entire preset, we lose Aggressive rules that weren't in backend
      // 3. Custom values like volumeMinRatio must be preserved per risk mode
      // 
      // Example: If backend only has swing.Conservative.volumeMinRatio=1.5,
      // we merge it into defaults, keeping swing.Aggressive.volumeMinRatio=0.5 intact.
      setPresetsConfig(() => {
        // Start with deep clone of PRESET_CONFIG to preserve all defaults
        const merged = structuredClone(PRESET_CONFIG);
        
        // Merge preset types with risk-mode-level merge
        for (const presetType of Object.keys(PRESET_CONFIG) as Preset[]) {
          const backendPreset = backendPresetsConfig[presetType];
          if (!backendPreset) continue;
          
          // FIX: Add null check to prevent TypeError if merged[presetType] is undefined
          if (!merged[presetType]) {
            console.warn(`[CONFIG] Missing preset type ${presetType} in merged config, skipping`);
            continue;
          }
          
          // Ensure correct structure
          if (!merged[presetType].rules) merged[presetType].rules = {} as Record<RiskMode, StrategyRules>;
          
          // Merge notification profile
          if (backendPreset.notificationProfile) {
            merged[presetType].notificationProfile = backendPreset.notificationProfile;
          }
          
          // Merge at risk-mode level to prevent overwriting
          // Backend values override defaults, but missing backend values keep defaults
          for (const riskMode of Object.keys(PRESET_CONFIG[presetType]?.rules || {}) as RiskMode[]) {
            const backendRules = backendPreset.rules?.[riskMode];
            const defaultRules = PRESET_CONFIG[presetType]?.rules?.[riskMode];
            
            // FIX: Add null check to prevent TypeError if defaultRules is undefined
            if (!defaultRules) {
              console.warn(`[CONFIG] Missing default rules for ${presetType}.${riskMode}, skipping merge`);
              continue;
            }
            
            // [CONFIG] Log merge operation with detailed info
            const backendVol = backendRules?.volumeMinRatio;
            const defaultVol = defaultRules?.volumeMinRatio ?? 0.5;
            const finalVol = backendVol !== undefined && backendVol !== null ? backendVol : defaultVol;
            
            console.log('[CONFIG] Loading volumeMinRatio on page load:', {
              preset: presetType,
              risk: riskMode,
              defaultVolumeMinRatio: defaultVol,
              backendVolumeMinRatio: backendVol,
              backendVolumeMinRatioType: typeof backendVol,
              backendRulesExists: !!backendRules,
              willUse: finalVol
            });
            
            // CRITICAL: Only merge if backendRules exists and has values
            // If backendRules is undefined, keep defaults (don't merge undefined)
            if (backendRules) {
              merged[presetType].rules[riskMode] = {
                ...defaultRules,
                ...backendRules,
              };
            } else {
              // No backend rules for this risk mode, keep defaults
              merged[presetType].rules[riskMode] = { ...defaultRules };
            }
            
            // [CONFIG] Verify final merged value
            // FIX: Add optional chaining to prevent TypeError if merged structure is incomplete
            const finalMergedVol = merged[presetType]?.rules?.[riskMode]?.volumeMinRatio ?? 0.5;
            console.log('[CONFIG] ✅ Final loaded volumeMinRatio:', {
              preset: presetType,
              risk: riskMode,
              volumeMinRatio: finalMergedVol,
              type: typeof finalMergedVol
            });
          }
        }
        
        return merged;
      });
      
      // Mark initial load as complete after backend data is loaded
      isInitialLoadRef.current = false;
      console.log('✅ Backend config loaded - initial load complete');
    } catch (err) {
      logHandledError(
        'fetchTradingConfig',
        'Failed to fetch trading config; using cached values',
        err
      );
      // Even if backend load fails, mark initial load as complete after a delay
      setTimeout(() => {
        isInitialLoadRef.current = false;
        console.log('✅ Initial load marked complete (backend load failed)');
      }, 3000);
    }
  }, []);

  // Cleanup saved message timers on unmount
  useEffect(() => {
    return () => {
      // Cleanup all timers on unmount
      Object.values(savedMessageTimersRef.current).forEach(timer => {
        if (timer) clearTimeout(timer);
      });
      savedMessageTimersRef.current = {};
    };
  }, []);

  // Load watchlist settings from localStorage on initial mount (before any data fetching)
  useEffect(() => {
    try {
      // CRITICAL FIX: Clean localStorage of stale $10 values BEFORE loading
      // This prevents obsolete values from being loaded into state
      // CRITICAL FIX: Normalize all keys to UPPERCASE to match backend loading (line 3616)
      const localAmounts = localStorage.getItem('watchlist_amounts');
      if (localAmounts) {
        const parsedAmounts = JSON.parse(localAmounts) as Record<string, string>;
        // Remove all values that are exactly "10", "10.0", or "10.00" (obsolete defaults)
        // Normalize all keys to UPPERCASE to match backend loading
        const cleanedAmounts: Record<string, string> = {};
        Object.entries(parsedAmounts).forEach(([symbol, value]) => {
          const isStaleValue = value === '10' || value === '10.0' || value === '10.00';
          if (!isStaleValue) {
            const symbolUpper = symbol.toUpperCase();
            cleanedAmounts[symbolUpper] = value;
          }
        });
        
        // Update localStorage with cleaned values (normalized to uppercase)
        if (Object.keys(cleanedAmounts).length !== Object.keys(parsedAmounts).length || 
            Object.keys(cleanedAmounts).some(k => k !== k.toUpperCase())) {
          localStorage.setItem('watchlist_amounts', JSON.stringify(cleanedAmounts));
          console.log('🧹 Cleaned stale $10 values and normalized keys to uppercase in localStorage on mount');
        }
        
        // Only load cleaned values (non-$10 values, uppercase keys)
        if (Object.keys(cleanedAmounts).length > 0) {
          setCoinAmounts(cleanedAmounts);
          console.log('✅ Loaded watchlist amounts from localStorage on mount (cleaned, uppercase keys):', Object.keys(cleanedAmounts).length, 'coins');
        }
      }
      
      const localTradeStatus = localStorage.getItem('watchlist_trade_status');
      if (localTradeStatus) {
        const parsedTradeStatus = JSON.parse(localTradeStatus) as Record<string, boolean>;
        // Normalize all keys to UPPERCASE to match backend loading
        const normalizedTradeStatus: Record<string, boolean> = {};
        Object.entries(parsedTradeStatus).forEach(([symbol, value]) => {
          normalizedTradeStatus[symbol.toUpperCase()] = value;
        });
        setCoinTradeStatus(normalizedTradeStatus);
        // Update localStorage with normalized keys
        localStorage.setItem('watchlist_trade_status', JSON.stringify(normalizedTradeStatus));
        console.log('✅ Loaded trade status from localStorage on mount (normalized to uppercase):', Object.keys(normalizedTradeStatus).length, 'coins');
      }
      
      const localAlertStatus = localStorage.getItem('watchlist_alert_status');
      if (localAlertStatus) {
        const parsedAlertStatus = JSON.parse(localAlertStatus) as Record<string, boolean>;
        // Normalize all keys to UPPERCASE to match backend loading
        const normalizedAlertStatus: Record<string, boolean> = {};
        Object.entries(parsedAlertStatus).forEach(([symbol, value]) => {
          normalizedAlertStatus[symbol.toUpperCase()] = value;
        });
        setCoinAlertStatus(normalizedAlertStatus);
        // Update localStorage with normalized keys
        localStorage.setItem('watchlist_alert_status', JSON.stringify(normalizedAlertStatus));
        console.log('✅ Loaded alert status from localStorage on mount (normalized to uppercase):', Object.keys(normalizedAlertStatus).length, 'coins');
      }
      
      // Load buy/sell alert status from localStorage
      const localBuyAlertStatus = localStorage.getItem('watchlist_buy_alert_status');
      const localSellAlertStatus = localStorage.getItem('watchlist_sell_alert_status');
      if (localBuyAlertStatus) {
        const parsedBuyAlertStatus = JSON.parse(localBuyAlertStatus) as Record<string, boolean>;
        // Normalize all keys to UPPERCASE to match backend loading
        const normalizedBuyAlertStatus: Record<string, boolean> = {};
        Object.entries(parsedBuyAlertStatus).forEach(([symbol, value]) => {
          normalizedBuyAlertStatus[symbol.toUpperCase()] = value;
        });
        setCoinBuyAlertStatus(normalizedBuyAlertStatus);
        // Update localStorage with normalized keys
        localStorage.setItem('watchlist_buy_alert_status', JSON.stringify(normalizedBuyAlertStatus));
        console.log('✅ Loaded buy alert status from localStorage on mount (normalized to uppercase):', Object.keys(normalizedBuyAlertStatus).length, 'coins');
      }
      if (localSellAlertStatus) {
        const parsedSellAlertStatus = JSON.parse(localSellAlertStatus) as Record<string, boolean>;
        // Normalize all keys to UPPERCASE to match backend loading
        const normalizedSellAlertStatus: Record<string, boolean> = {};
        Object.entries(parsedSellAlertStatus).forEach(([symbol, value]) => {
          normalizedSellAlertStatus[symbol.toUpperCase()] = value;
        });
        setCoinSellAlertStatus(normalizedSellAlertStatus);
        // Update localStorage with normalized keys
        localStorage.setItem('watchlist_sell_alert_status', JSON.stringify(normalizedSellAlertStatus));
        console.log('✅ Loaded sell alert status from localStorage on mount (normalized to uppercase):', Object.keys(normalizedSellAlertStatus).length, 'coins');
      }
      
      const localSLPercent = localStorage.getItem('watchlist_sl_percent');
      if (localSLPercent) {
        const parsedSLPercent = JSON.parse(localSLPercent) as Record<string, string>;
        // Normalize all keys to UPPERCASE to match backend loading
        const normalizedSLPercent: Record<string, string> = {};
        Object.entries(parsedSLPercent).forEach(([symbol, value]) => {
          normalizedSLPercent[symbol.toUpperCase()] = value;
        });
        setCoinSLPercent(normalizedSLPercent);
        // Update localStorage with normalized keys
        localStorage.setItem('watchlist_sl_percent', JSON.stringify(normalizedSLPercent));
        console.log('✅ Loaded SL percent from localStorage on mount (normalized to uppercase):', Object.keys(normalizedSLPercent).length, 'coins');
      }
      
      const localTPPercent = localStorage.getItem('watchlist_tp_percent');
      if (localTPPercent) {
        const parsedTPPercent = JSON.parse(localTPPercent) as Record<string, string>;
        // Normalize all keys to UPPERCASE to match backend loading
        const normalizedTPPercent: Record<string, string> = {};
        Object.entries(parsedTPPercent).forEach(([symbol, value]) => {
          normalizedTPPercent[symbol.toUpperCase()] = value;
        });
        setCoinTPPercent(normalizedTPPercent);
        // Update localStorage with normalized keys
        localStorage.setItem('watchlist_tp_percent', JSON.stringify(normalizedTPPercent));
        console.log('✅ Loaded TP percent from localStorage on mount (normalized to uppercase):', Object.keys(normalizedTPPercent).length, 'coins');
      }
      
      const localCoinPresets = localStorage.getItem('coin_presets');
      if (localCoinPresets) {
        const parsedCoinPresets = JSON.parse(localCoinPresets) as Record<string, string>;
        // Normalize all keys to UPPERCASE to match backend loading
        const normalizedCoinPresets: Record<string, string> = {};
        Object.entries(parsedCoinPresets).forEach(([symbol, value]) => {
          normalizedCoinPresets[symbol.toUpperCase()] = value;
        });
        setCoinPresets(normalizedCoinPresets);
        // Update localStorage with normalized keys
        localStorage.setItem('coin_presets', JSON.stringify(normalizedCoinPresets));
        console.log('✅ Loaded coin presets from localStorage on mount (normalized to uppercase):', Object.keys(normalizedCoinPresets).length, 'coins');
      }
    } catch (err) {
      console.warn('Failed to load watchlist settings from localStorage on mount:', err);
    }
  }, []); // Run only once on mount

  // Persist coin presets whenever they change
  useEffect(() => {
    try {
      localStorage.setItem('coin_presets', JSON.stringify(coinPresets));
    } catch (err) {
      console.warn('Failed to save coin presets to localStorage:', err);
    }
  }, [coinPresets]);

  // Persist strategy preset configuration (custom rules) whenever it changes
  // BUT: Don't save during initial load (when data comes from backend)
  useEffect(() => {
    // Skip saving during initial load - backend data should be loaded first
    if (isInitialLoadRef.current) {
      console.log('⏭️ Skipping localStorage save during initial load');
      // Mark initial load as complete after first render
      setTimeout(() => {
        isInitialLoadRef.current = false;
        console.log('✅ Initial load complete - localStorage saves will now be enabled');
      }, 2000); // Give backend 2 seconds to load
      return;
    }
    
    try {
      localStorage.setItem('strategy_presets_config', JSON.stringify(presetsConfig));
      console.log('💾 Auto-saved presetsConfig to localStorage (user change detected)');
    } catch (err) {
      console.warn('Failed to save strategy presets config to localStorage:', err);
    }
  }, [presetsConfig]);

  // Update refs when functions change - must be after all function definitions
  useEffect(() => {
    fetchTopCoinsRef.current = fetchTopCoins;
    fetchPortfolioRef.current = fetchPortfolio;
    fetchOpenOrdersRef.current = fetchOpenOrders;
    fetchOpenOrdersSummaryRef.current = fetchOpenOrdersSummary;
    fetchExecutedOrdersRef.current = fetchExecutedOrders;
    fetchSignalsRef.current = fetchSignals;
  }, [fetchTopCoins, fetchPortfolio, fetchOpenOrders, fetchOpenOrdersSummary, fetchExecutedOrders, fetchSignals]);

  // Handle preset selection
  const _handlePresetChange = (preset: string) => {
    setSelectedPreset(preset);
    if (tradingConfig?.presets?.[preset]) {
      const presetValues = tradingConfig.presets[preset];
      setSignalConfig({
        rsiPeriod: presetValues.RSI_PERIOD || 14,
        rsiBuyThreshold: presetValues.RSI_BUY || 40,
        rsiSellThreshold: presetValues.RSI_SELL || 70,
        ma50Period: presetValues.MA50 || 50,
        ema10Period: presetValues.EMA10 || 10,
        ma10wPeriod: presetValues.MA10W || 70,
        atrPeriod: presetValues.ATR || 14,
        volumePeriod: presetValues.VOL || 10
      });
    }
  };

  // New handler for coin-specific preset changes with strategy logic
  const handleCoinPresetChangeWithStrategy = async (symbol: string, preset: string) => {
    const messageKey = `${symbol}_preset`;
    
    // CRITICAL: Save the preset to the backend first (source of truth)
    try {
      const result = await updateCoinConfig(symbol, { preset });
      console.log(`✅ Saved preset ${preset} for ${symbol} to backend`);
      
      // Update state with backend response if available
      // Note: updateCoinConfig may not return the preset, so we use the value we sent
      const symbolUpper = symbol.toUpperCase();
      setCoinPresets(prev => ({ ...prev, [symbolUpper]: preset }));
      
      // Update localStorage with backend value
      const existingPresets = localStorage.getItem('coin_presets');
      const existingPresetsObj = existingPresets ? JSON.parse(existingPresets) as Record<string, string> : {};
      const updatedPresets = {
        ...existingPresetsObj,
        [symbolUpper]: preset
      };
      localStorage.setItem('coin_presets', JSON.stringify(updatedPresets));
      
      // Show success message
      setAlertSavedMessages(prev => ({
        ...prev,
        [messageKey]: { type: 'success', timestamp: Date.now() }
      }));
      
      // Clear message after 3 seconds
      if (savedMessageTimersRef.current[messageKey]) {
        clearTimeout(savedMessageTimersRef.current[messageKey]);
      }
      savedMessageTimersRef.current[messageKey] = setTimeout(() => {
        setAlertSavedMessages(prev => {
          const { [messageKey]: _removed, ...rest } = prev;
          return rest;
        });
        delete savedMessageTimersRef.current[messageKey];
      }, 3000);
    } catch (err) {
      logHandledError(
        `updateCoinPreset:${symbol}`,
        `Failed to save preset for ${symbol}`,
        err,
        'error'
      );
      setAlertSavedMessages(prev => ({
        ...prev,
        [messageKey]: { type: 'error', timestamp: Date.now() }
      }));
      // Continue with strategy logic even if save fails
    }
    
    // Convert string preset to Preset type and RiskMode
    let presetType: Preset;
    let riskMode: RiskMode;
    
    if (preset === 'swing' || preset === 'intraday' || preset === 'scalp') {
      presetType = (preset.charAt(0).toUpperCase() + preset.slice(1)) as Preset;
      riskMode = 'Conservative'; // Default to conservative for basic presets
    } else if (preset.includes('-conservative')) {
      const basePreset = preset.replace('-conservative', '');
      presetType = (basePreset.charAt(0).toUpperCase() + basePreset.slice(1)) as Preset;
      riskMode = 'Conservative';
    } else if (preset.includes('-aggressive')) {
      const basePreset = preset.replace('-aggressive', '');
      presetType = (basePreset.charAt(0).toUpperCase() + basePreset.slice(1)) as Preset;
      riskMode = 'Aggressive';
    } else {
      // Fallback for custom or unknown presets
      presetType = 'Swing';
      riskMode = 'Conservative';
    }
    
    // Update SL/TP mode to match the preset
    const isAggressive = riskMode === 'Aggressive';
    setCoinTradeStatus(prev => ({
      ...prev,
      [symbol + '_sl_tp']: isAggressive
    }));
    
    // Get current coin data for calculations
    const coin = topCoins.find(c => c.instrument_name === symbol);
    const signal = signals[symbol];
    // Use presetsConfig (editable) if available, fallback to PRESET_CONFIG (defaults)
    const activePresetConfig = presetsConfig[presetType] || PRESET_CONFIG[presetType];
    if (coin && signal && activePresetConfig) {
      const rules = activePresetConfig.rules[riskMode];
      const { slPrice, tpPrice } = suggestSLTP({ 
        price: coin.current_price, 
        atr: signal.atr, 
        rules 
      });
      
      // Update calculated SL/TP values
      if (slPrice) setCalculatedSL(prev => ({ ...prev, [symbol]: slPrice }));
      if (tpPrice) setCalculatedTP(prev => ({ ...prev, [symbol]: tpPrice }));
      
      // Save the calculated SL/TP values to the database
      try {
        const settingsToSave: Partial<CoinSettings> = {
          sl_tp_mode: isAggressive ? 'aggressive' : 'conservative'
        };
        
        // Save SL value if calculated
        if (slPrice) {
          settingsToSave.sl_price = slPrice;
        }
        
        // Save TP value if calculated
        if (tpPrice) {
          settingsToSave.tp_price = tpPrice;
        }
        
        // Apply min_price_change_pct and alert_cooldown_minutes from the strategy configuration
        const rules = activePresetConfig.rules[riskMode];
        if (rules?.minPriceChangePct !== undefined) {
          settingsToSave.min_price_change_pct = rules.minPriceChangePct;
        }
        if (rules?.alertCooldownMinutes !== undefined) {
          settingsToSave.alert_cooldown_minutes = rules.alertCooldownMinutes;
        }
        
        await saveCoinSettings(symbol, settingsToSave);
        console.log(`✅ Saved strategy settings for ${symbol}:`, settingsToSave);
      } catch (err) {
        console.warn(`⚠️ Failed to save strategy settings for ${symbol}:`, err);
      }
      
      // Emit strategy change for notifications
      console.log('Strategy change:', {
        symbol,
        preset: presetType,
        risk: riskMode,
        notificationProfile: activePresetConfig.notificationProfile,
        slPrice,
        tpPrice
      });
    }
  };

  // Handle coin preset change
  const _handleCoinPresetChange = async (symbol: string, preset: string) => {
    try {
      await updateCoinConfig(symbol, { preset });
      setCoinPresets(prev => ({ ...prev, [symbol]: preset }));
      console.log(`✅ Updated ${symbol} to use ${preset} preset`);
    } catch (err) {
      logHandledError(
        `updateCoinPreset:${symbol}`,
        `Failed to update coin preset for ${symbol}`,
        err,
        'error'
      );
      alert(`Failed to update preset for ${symbol}`);
    }
  };

  // Handle add new symbol
  const handleAddSymbol = async () => {
    const symbolToAdd = newSymbol.trim().toUpperCase();
    
    if (!symbolToAdd) {
      alert('Please enter a symbol');
      return;
    }

    // Check if symbol already exists
    if (topCoinsRef.current.some(coin => coin.instrument_name === symbolToAdd)) {
      alert('This symbol already exists in the watchlist');
      return;
    }

    try {
      setLoading(true);
      
      const parts = symbolToAdd.split('_');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        alert('Symbol must be in the format BASE_QUOTE (e.g., BTC_USDT)');
        setLoading(false);
        return;
      }

      const [baseCurrencyRaw, _quoteCurrencyRaw] = parts;
      const _baseCurrencyLower = baseCurrencyRaw.toLowerCase();
      // quoteCurrencyLower removed - not used

      // Check for exact duplicates only (allow both BTC_USD and BTC_USDT)
      const existingCoins = topCoinsRef.current.map(c => c.instrument_name.toLowerCase());
      const exactDuplicate = existingCoins.find(coin => coin === symbolToAdd.toLowerCase());
      
      if (exactDuplicate) {
        alert(`This coin (${exactDuplicate.toUpperCase()}) already exists. Please choose a different symbol.`);
        setLoading(false);
        return;
      }
      
      const baseCurrency = baseCurrencyRaw.toUpperCase();
      const quoteCurrency = _quoteCurrencyRaw.toUpperCase();

      try {
        await addCustomTopCoin({
          instrument_name: symbolToAdd,
          base_currency: baseCurrency,
          quote_currency: quoteCurrency
        });
      } catch (err) {
        console.error('Failed to add custom top coin:', err);
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        // Check if it's an auth error
        const errStatus = (err as { status?: number })?.status;
        if (errorMessage.includes('401') || errorMessage.includes('403') || errStatus === 401 || errStatus === 403) {
          alert('Authentication failed. Please check if you are logged in.');
        } else if (errorMessage.includes('timeout')) {
          alert(`Request timeout. The server may be processing the request. Please try again.`);
        } else {
          alert(`Failed to add symbol: ${errorMessage}`);
        }
        setLoading(false);
        return;
      }

      const newCoin: TopCoin = {
        rank: topCoinsRef.current.length + 1,
        instrument_name: symbolToAdd,
        base_currency: baseCurrency,
        quote_currency: quoteCurrency,
        current_price: 0,
        volume_24h: 0,
        updated_at: new Date().toISOString(),
        is_custom: true
      };

      updateTopCoins([...topCoinsRef.current, newCoin]);

      // Remove from deleted list if it was previously hidden
      try {
        const deletedCoins = localStorage.getItem('deleted_coins');
        if (deletedCoins) {
          const deletedList: string[] = JSON.parse(deletedCoins);
          if (deletedList.includes(symbolToAdd)) {
            const filtered = deletedList.filter(item => item !== symbolToAdd);
            localStorage.setItem('deleted_coins', JSON.stringify(filtered));
          }
        }
      } catch (err) {
        console.warn('Failed to update deleted coins cache:', err);
      }
      
      // Clear the form
      setNewSymbol('');
      setShowAddForm(false);
      
      console.log(`✅ Added ${symbolToAdd} to watchlist`);
      
      // NO external API calls - price will be available after backend updates topCoins
      // The price will be loaded when fetchTopCoins() completes below
      console.debug(`Price for ${symbolToAdd} will be loaded from backend data`);
      
      // Try to save to backend (optional, will fail silently)
      try {
        await saveCoinSettings(symbolToAdd, {});
      } catch (err) {
        console.warn('Could not save to backend, but symbol added locally:', err);
      }
      
      // Refresh list from backend to pick up canonical data
      await fetchTopCoins(true);
      
    } catch (err) {
      logHandledError(
        'handleAddSymbol',
        'Failed to add symbol',
        err,
        'error'
      );
      alert('Failed to add symbol. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // Handle delete coin
  const handleDeleteCoin = async (symbol: string) => {
    console.log(`handleDeleteCoin called with symbol: ${symbol}`);
    console.log(`deleteConfirm: ${deleteConfirm}`);
    console.log(`deleteConfirm === symbol: ${deleteConfirm === symbol}`);
    
    if (deleteConfirm === symbol) {
      // User clicked Delete again - confirm deletion
      console.log(`Confirming deletion of ${symbol}`);
      const coinToDelete = topCoinsRef.current.find(coin => coin.instrument_name === symbol);
      const remaining = topCoinsRef.current.filter(coin => coin.instrument_name !== symbol);
      updateTopCoins(remaining);
      
      // CRITICAL: Delete from backend database to prevent duplicates
      try {
        await deleteDashboardItemBySymbol(symbol);
        console.log(`✅ Deleted ${symbol} from backend database`);
      } catch (err) {
        console.error(`❌ Failed to delete ${symbol} from backend:`, err);
        // Continue with local deletion even if backend fails
      }
      
      if (coinToDelete?.is_custom) {
        try {
          await removeCustomTopCoin(symbol);
        } catch (err) {
          console.warn(`Failed to remove custom coin ${symbol} from backend:`, err);
        }
      }
      
      // Add to deleted coins list to prevent auto-restore
      if (!coinToDelete?.is_custom) {
        // Handle protected coins (BTC/ETH pairs) by disabling trade instead of aborting
        const protectedCoins = ['BTC_USDT', 'BTC_USD', 'ETH_USDT', 'ETH_USD', 'BTC', 'ETH'];
        const isProtected = protectedCoins.some(protectedCoin => symbol.toUpperCase().includes(protectedCoin));
        
        if (isProtected) {
          try {
            console.log(`ℹ️ ${symbol} is protected. Disabling trade before hiding.`);
            await saveCoinSettings(symbol, {
              trade_enabled: false,
              trade_amount_usd: null,
              alert_enabled: false,
            });
          } catch (err) {
            console.warn(`Failed to disable trade for protected coin ${symbol}:`, err);
          }
        }
        
        try {
          const deletedCoins = localStorage.getItem('deleted_coins');
          const deletedList = deletedCoins ? JSON.parse(deletedCoins) : [];
          if (!deletedList.includes(symbol)) {
            deletedList.push(symbol);
            localStorage.setItem('deleted_coins', JSON.stringify(deletedList));
          }
        } catch (err) {
          console.warn('Failed to save deleted coin:', err);
        }
      }
      
      // Remove from localStorage settings
      const updatedAmounts = { ...coinAmounts };
      const updatedSL = { ...coinSLPercent };
      const updatedTP = { ...coinTPPercent };
      const updatedStatus = { ...coinTradeStatus };
      delete updatedAmounts[symbol];
      delete updatedSL[symbol];
      delete updatedTP[symbol];
      delete updatedStatus[symbol];
      delete updatedStatus[symbol + '_margin'];
      delete updatedStatus[symbol + '_sl_tp'];
      setCoinAmounts(updatedAmounts);
      setCoinSLPercent(updatedSL);
      setCoinTPPercent(updatedTP);
      setCoinTradeStatus(updatedStatus);
      localStorage.setItem('watchlist_amounts', JSON.stringify(updatedAmounts));
      localStorage.setItem('watchlist_sl_percent', JSON.stringify(updatedSL));
      localStorage.setItem('watchlist_tp_percent', JSON.stringify(updatedTP));
      setDeleteConfirm(null);
      console.log(`✅ Deleted ${symbol} from watchlist and added to deleted list`);

      // Always refresh watchlist after deletion to reflect backend changes
        try {
          await fetchTopCoins(true);
        } catch (err) {
        console.warn(`Failed to refresh watchlist after deletion:`, err);
          handleQueueError('slow', err);
      }
    } else {
      // First click - show confirmation
      console.log(`First click - showing confirmation for ${symbol}`);
      setDeleteConfirm(symbol);
    }
  };

  // Use refs to avoid infinite loops in useEffect dependencies
  const loadCachedTopCoinsRef = useRef<(() => boolean) | null>(null);
  
  useEffect(() => {
    // Update refs when functions change
    loadCachedTopCoinsRef.current = loadCachedTopCoins;
  }, [loadCachedTopCoins]);

  // Load bot status on mount
  useEffect(() => {
    const loadBotStatus = async () => {
      try {
        const snapshot = await getDashboardSnapshot();
        if (snapshot.data.bot_status) {
          setBotStatus(snapshot.data.bot_status);
          console.log('✅ Bot status loaded:', snapshot.data.bot_status);
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        // Only log if it's not a network error (those are expected occasionally)
        if (!errorMsg.includes('Failed to fetch') && !errorMsg.includes('NetworkError')) {
        console.error('Failed to load bot status:', err);
        } else {
          console.debug('Bot status load network error (expected occasionally):', errorMsg);
        }
      }
    };
    loadBotStatus();
    
    // Set up background refresh for snapshot every 15 seconds
    const snapshotRefreshInterval = setInterval(async () => {
      try {
        const snapshot = await getDashboardSnapshot();
        // Only update if we got valid data
        if (snapshot && snapshot.data) {
          setSnapshotStale(snapshot.stale);
          setSnapshotStaleSeconds(snapshot.stale_seconds);
          if (snapshot.last_updated_at) {
            setSnapshotLastUpdated(new Date(snapshot.last_updated_at));
          }
          // Update bot status if available
          if (snapshot.data.bot_status) {
            setBotStatus(snapshot.data.bot_status);
          }
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        // Only log if it's not a network error (those are expected occasionally)
        if (!errorMsg.includes('Failed to fetch') && !errorMsg.includes('NetworkError')) {
          console.error('Failed to refresh snapshot:', err);
        } else {
          console.debug('Snapshot refresh network error (expected occasionally):', errorMsg);
        }
        // Don't update state on error - keep showing last good data
      }
    }, 15000); // Refresh every 15 seconds
    
    return () => clearInterval(snapshotRefreshInterval);
  }, []); // Run only once on mount

  useEffect(() => {
    let isMounted = true;
    let hasRun = false; // Guard to prevent multiple runs
    
    console.log('🔄 Starting initial fetch...');

    const loadInitialData = async () => {
      if (hasRun) {
        // Initial data load already executed
        return;
      }
      hasRun = true;

      // Load cached data IMMEDIATELY for instant UI (optimistic display)
      const hadCache = loadCachedTopCoinsRef.current?.() || false;
      if (hadCache) {
        console.log('✅ Using cached top coins snapshot for instant UI while fetching fresh data...');
      }
      
      // Use refs to avoid dependency issues
      const fetchTopCoinsFn = fetchTopCoinsRef.current || (() => Promise.resolve());
      const fetchPortfolioFn = fetchPortfolioRef.current || (() => Promise.resolve());
      const fetchOpenOrdersFn = fetchOpenOrdersRef.current || (() => Promise.resolve());
      const fetchOpenOrdersSummaryFn = fetchOpenOrdersSummaryRef.current || (() => Promise.resolve());
      const fetchExecutedOrdersFn = fetchExecutedOrdersRef.current || (() => Promise.resolve());
      const fetchDataSourceStatusFn = fetchDataSourceStatus;
      const fetchTradingConfigFn = fetchTradingConfig;
      
      // DON'T load from localStorage here - backend is source of truth
      // Backend will load first, and if it has no data, we'll use PRESET_CONFIG defaults
      // localStorage will only be used as a last resort if backend completely fails
      console.log('⏭️ Skipping localStorage load - waiting for backend to load first');
      const fetchSignalsFn = fetchSignalsRef.current || (() => Promise.resolve());
      const handleQueueSuccessFn = handleQueueSuccess;
      const handleQueueErrorFn = handleQueueError;

      // Load data with snapshot-first approach for portfolio and orders
      // Portfolio and orders load snapshot immediately (fast), then refresh in background
      // Other data loads normally
      console.log('🚀 Starting initial data load (snapshot-first for portfolio/orders)...');
      const startTime = Date.now();
      
      // Load portfolio and orders FIRST (non-blocking snapshot)
      // These will show snapshot data immediately, then refresh in background
      fetchPortfolioFn().then(() => console.log('✅ Portfolio snapshot loaded (background refresh started)')).catch((err) => {
        if (isMounted) {
          logHandledError('initialPortfolioFetch', 'Initial portfolio fetch failed', err, 'warn');
        }
      });
      fetchOpenOrdersFn().then(() => console.log('✅ Open orders snapshot loaded (background refresh started)')).catch((err) => {
        if (isMounted) {
          logHandledError('initialOpenOrdersFetch', 'Initial open orders fetch failed', err, 'warn');
        }
      });
      // Load open orders summary automatically (non-blocking, ready when user clicks tab)
      fetchOpenOrdersSummaryFn({ showLoader: false, backgroundRefresh: false }).then(() => {
        console.log('✅ Open orders summary loaded automatically');
      }).catch((err) => {
        if (isMounted) {
          logHandledError('initialOpenOrdersSummaryFetch', 'Initial open orders summary fetch failed', err, 'warn');
        }
      });
      
      // Load other data in parallel (non-blocking for UI)
      const [
        topCoinsResult,
        executedOrdersResult,
        dataSourceStatusResult,
        tradingConfigResult
      ] = await Promise.allSettled([
        // Fetch fresh data from backend (not cache)
        fetchTopCoinsFn(false).then(() => {
          handleQueueSuccessFn('slow');
          console.log('✅ Top coins fetched from backend');
        }).catch((err) => {
          if (isMounted) {
            handleQueueErrorFn('slow', err);
            logHandledError(
              'initialTopCoinsFetch',
              'Initial top coins fetch failed',
              err
            );
          }
          throw err;
        }),
        fetchExecutedOrdersFn({ showLoader: false, limit: 50, loadAll: false }).then(() => console.log('✅ Executed orders fetched from backend')).catch(err => {
          console.warn('⚠️ Initial executed orders fetch failed (will retry):', err);
          // Retry once after a short delay if initial fetch fails
          // Use a separate timeout to avoid blocking the Promise.allSettled
          setTimeout(() => {
            fetchExecutedOrdersFn({ showLoader: false, limit: 50, loadAll: false }).catch(retryErr => {
              console.error('❌ Retry also failed:', retryErr);
              // Ensure loading state is cleared even if retry fails
              // The finally block in fetchExecutedOrders should handle this, but be explicit
            });
          }, 2000);
        }),
        fetchDataSourceStatusFn().then(() => console.log('✅ Data source status fetched from backend')),
        fetchTradingConfigFn().then(() => console.log('✅ Trading config fetched from backend'))
      ]);
      
      const elapsedTime = Date.now() - startTime;
      console.log(`⏱️ Initial data load completed in ${elapsedTime}ms (portfolio/orders loading from snapshot)`);
      
      // Log any failures
      const failures = [topCoinsResult, executedOrdersResult, dataSourceStatusResult, tradingConfigResult]
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failures.length > 0) {
        console.warn(`⚠️ ${failures.length}/4 initial data fetches failed`);
        failures.forEach(f => console.warn('Failed fetch:', f.reason));
      }

      const hydrateInitialSignals = async () => {
        const coins = topCoinsRef.current;
        if (!isMounted || coins.length === 0) {
          console.log('⏭️ Skipping signal hydration - no coins available');
          return;
        }

        const fastSymbols = coins
          .filter((coin) => coin.instrument_name && coinTradeStatus[coin.instrument_name] === true)
          .map((coin) => coin.instrument_name);
        const slowSymbols = coins
          .filter((coin) => coin.instrument_name && coinTradeStatus[normalizeSymbolKey(coin.instrument_name)] !== true)
          .map((coin) => coin.instrument_name);

        console.log(`📊 Hydrating signals: ${fastSymbols.length} fast, ${slowSymbols.length} slow symbols`);

        const hydrate = async (symbols: string[], batchSize: number, queue: 'fast' | 'slow') => {
          // Load signals in parallel batches for faster initial load
          // Only load first batch immediately, rest can be loaded in background
          const immediateBatch = symbols.slice(0, Math.min(batchSize * 3, symbols.length)); // Load first 3 batches immediately
          const remainingSymbols = symbols.slice(immediateBatch.length);
          
          // Load immediate batch in parallel
          if (immediateBatch.length > 0) {
            console.log(`🚀 Loading ${immediateBatch.length} ${queue} signals in parallel...`);
            const results = await Promise.allSettled(immediateBatch.map((symbol) => fetchSignalsFn(symbol)));
            
            const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
            if (failures.length > 0) {
              console.warn(`⚠️ ${failures.length}/${immediateBatch.length} signals failed in immediate batch for ${queue} queue`);
            }
            console.log(`✅ Loaded ${immediateBatch.length - failures.length}/${immediateBatch.length} ${queue} signals`);
          }
          
          // Load remaining symbols in background (non-blocking)
          if (remainingSymbols.length > 0 && isMounted) {
            console.log(`⏳ Loading remaining ${remainingSymbols.length} ${queue} signals in background...`);
            // Don't await - let it run in background
            (async () => {
              for (let i = 0; i < remainingSymbols.length && isMounted; i += batchSize) {
                const batch = remainingSymbols.slice(i, i + batchSize);
                const results = await Promise.allSettled(batch.map((symbol) => fetchSignalsFn(symbol)));
                
                const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
                if (failures.length > 0) {
                  console.warn(`⚠️ ${failures.length}/${batch.length} signals failed in background batch ${i}-${i + batchSize} for ${queue} queue`);
                }
                
                if (i + batchSize < remainingSymbols.length) {
                  await wait(FAST_STAGGER_MS);
                }
              }
            })();
          }
        };

        // Load fast symbols first (they're more important)
        if (fastSymbols.length) {
          await hydrate(fastSymbols, FAST_BATCH_SIZE, 'fast');
        }
        // Load slow symbols in background (non-blocking after first batch)
        if (slowSymbols.length) {
          await hydrate(slowSymbols.slice(0, Math.min(4, slowSymbols.length)), SLOW_BATCH_SIZE, 'slow');
        }
      };

      // Start signal hydration immediately (non-blocking) after data is loaded
      // This ensures signals load in parallel with UI rendering
      hydrateInitialSignals().catch((err) =>
        logHandledError(
          'initialSignalHydration',
          'Initial signal hydration failed',
          err
        )
      );
    };

    loadInitialData();

    return () => {
      isMounted = false;
    };
    // Only run once on mount - use refs for functions to avoid dependency issues
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load watchlist items on mount for TP/SL counting in portfolio
  useEffect(() => {
    const loadWatchlistItems = async () => {
      try {
        const dashboardItems: WatchlistItem[] = await getDashboard();
        setWatchlistItems(dashboardItems);
        console.log(`✅ Loaded ${dashboardItems.length} watchlist items for TP/SL counting`);
      } catch (err) {
        console.warn('Failed to load watchlist items for TP/SL counting:', err);
      }
    };
    loadWatchlistItems();
  }, []);

  // Load min_price_change_pct values from watchlistItems and update presetsConfig
  useEffect(() => {
    if (watchlistItems.length === 0 || Object.keys(coinPresets).length === 0) {
      return; // Wait for both to be loaded
    }

    console.log('🔄 Loading min_price_change_pct values from database...');
    
    // Group min_price_change_pct values by preset/risk combination
    const presetRiskValues: Record<string, number[]> = {};
    
    watchlistItems.forEach(item => {
      if (!item.symbol || item.min_price_change_pct === null || item.min_price_change_pct === undefined) {
        return;
      }
      
      const coinPreset = coinPresets[item.symbol] || 'swing';
      const riskMode = item.sl_tp_mode || 'conservative';
      
      // Map preset to Preset type
      let presetType: Preset = 'Swing';
      if (coinPreset.includes('intraday') || coinPreset === 'intraday') {
        presetType = 'Intraday';
      } else if (coinPreset.includes('scalp') || coinPreset === 'scalp') {
        presetType = 'Scalp';
      }
      
      // Map risk mode to RiskMode type
      const riskType: RiskMode = riskMode === 'aggressive' ? 'Aggressive' : 'Conservative';
      
      const key = `${presetType}-${riskType}`;
      if (!presetRiskValues[key]) {
        presetRiskValues[key] = [];
      }
      presetRiskValues[key].push(item.min_price_change_pct);
    });
    
    // Update presetsConfig with the most common value for each preset/risk combination
    setPresetsConfig(prev => {
      const updated = { ...prev };
      let hasChanges = false;
      
      Object.entries(presetRiskValues).forEach(([key, values]) => {
        if (values.length === 0) return;
        
        // Find the most common value (mode)
        const valueCounts: Record<number, number> = {};
        values.forEach(v => {
          valueCounts[v] = (valueCounts[v] || 0) + 1;
        });
        
        const mostCommonValue = Object.entries(valueCounts).reduce((a, b) => 
          valueCounts[parseFloat(a[0])] > valueCounts[parseFloat(b[0])] ? a : b
        )[0];
        
        const [presetType, riskType] = key.split('-') as [Preset, RiskMode];
        
        if (updated[presetType]?.rules[riskType]) {
          const currentValue = updated[presetType].rules[riskType].minPriceChangePct;
          const newValue = parseFloat(mostCommonValue);
          
          if (currentValue !== newValue) {
            updated[presetType] = {
              ...updated[presetType],
              rules: {
                ...updated[presetType].rules,
                [riskType]: {
                  ...updated[presetType].rules[riskType],
                  minPriceChangePct: newValue
                }
              }
            };
            hasChanges = true;
            console.log(`✅ Updated ${presetType}-${riskType} min_price_change_pct: ${currentValue ?? 'N/A'} → ${newValue} (from ${values.length} coins)`);
          }
        }
      });
      
      // Also ensure all preset/risk combinations have a default value of 1.0 if not set
      const allPresets: Preset[] = ['Swing', 'Intraday', 'Scalp'];
      const allRisks: RiskMode[] = ['Conservative', 'Aggressive'];
      
      allPresets.forEach(preset => {
        allRisks.forEach(risk => {
          if (updated[preset]?.rules[risk]) {
            if (updated[preset].rules[risk].minPriceChangePct === undefined || updated[preset].rules[risk].minPriceChangePct === null) {
              updated[preset] = {
                ...updated[preset],
                rules: {
                  ...updated[preset].rules,
                  [risk]: {
                    ...updated[preset].rules[risk],
                    minPriceChangePct: 1.0
                  }
                }
              };
              hasChanges = true;
            }
          }
        });
      });
      
      if (hasChanges) {
        console.log('✅ Updated presetsConfig with min_price_change_pct values from database');
      }
      
      return updated;
    });
  }, [watchlistItems, coinPresets]);

  // Fetch signals when a coin is activated for trading
  useEffect(() => {
    const activeCoins = Object.entries(coinTradeStatus)
      .filter(([key, isActive]) => isActive && !key.includes('_margin') && !key.includes('_sl_tp'))
      .map(([key]) => key);
    
    if (activeCoins.length > 0) {
      console.log(`🔄 Fetching signals for newly activated coins: ${activeCoins.join(', ')}`);
      activeCoins.forEach(symbol => {
        void fetchSignals(symbol).catch(err => handleQueueError('fast', err));
      });
    }
  }, [coinTradeStatus, fetchSignals, handleQueueError]);

  // Load signals for coins that don't have them yet (including TRADE NO coins) - only once
  useEffect(() => {
    const coinsWithoutSignals = topCoinsRef.current.filter(
      (coin) => coin.instrument_name && !signals[coin.instrument_name]
    );
    
    if (coinsWithoutSignals.length > 0) {
      console.log(`🔄 Loading missing signals for ${coinsWithoutSignals.length} coins`);
      const timer = setTimeout(() => {
        coinsWithoutSignals.forEach((coin) => {
          if (coin.instrument_name) {
            void fetchSignals(coin.instrument_name).catch((err) => handleQueueError('slow', err));
          }
        });
      }, 5000); // Wait 5 seconds before loading missing signals

      return () => clearTimeout(timer);
    }
    return undefined;
  }, [topCoins.length, fetchSignals, handleQueueError, signals]);

  // Update calculated SL/TP values every 3 seconds (only for coins without saved values)
  useEffect(() => {
    // Run immediately on mount
    const calculateValues = () => {
      topCoinsRef.current.forEach(coin => {
        // Only calculate for active trades
        const isActiveTrade = coinTradeStatus[normalizeSymbolKey(coin.instrument_name)] === true;
        if (!isActiveTrade) return;
        
        // Only calculate if we don't have saved values for this coin
        const hasSavedSL = calculatedSL[coin.instrument_name] !== undefined && calculatedSL[coin.instrument_name] !== 0;
        const hasSavedTP = calculatedTP[coin.instrument_name] !== undefined && calculatedTP[coin.instrument_name] !== 0;
        const hasSignal = signals[coin.instrument_name];
        // Calculate even if resistance levels are missing (will use fallback percentages)
        
        // Calculate SL/TP if we don't have saved values AND we have signal data (even without resistance levels)
        if ((!hasSavedSL || !hasSavedTP) && hasSignal) {
          const values = calculateSLTPValues(coin);
          // Accept values even if they're fallback percentages (still > 0)
          if (values.sl > 0 && values.tp > 0) {
            console.log(`🔄 Calculating SL/TP for ${coin.instrument_name}:`, values);
            setCalculatedSL(prev => ({ ...prev, [coin.instrument_name]: values.sl }));
            setCalculatedTP(prev => ({ ...prev, [coin.instrument_name]: values.tp }));
            
            // IMPORTANT: Save calculated SL/TP prices to backend so they can be used for order creation
            // These are the exact values shown in the dashboard - save them directly
            (async () => {
              try {
                const settingsToSave: Partial<CoinSettings> = {
                  sl_price: values.sl,
                  tp_price: values.tp
                };
                await saveCoinSettings(coin.instrument_name, settingsToSave);
                console.log(`✅ Saved calculated SL/TP prices to backend for ${coin.instrument_name}:`, settingsToSave);
              } catch (err) {
                console.warn(`⚠️ Failed to save calculated SL/TP prices for ${coin.instrument_name}:`, err);
              }
            })();
          }
        }
      });
    };
    
    // Run immediately
    calculateValues();
    
    // Then run every 3 seconds
    const interval = setInterval(calculateValues, 3000);

    return () => clearInterval(interval);
  }, [calculateSLTPValues, calculatedSL, calculatedTP, signals]);

  // Recalculate when signals change (only for active trades without saved values)
  useEffect(() => {
    if (Object.keys(signals).length > 0) {
      console.log('📊 Signals updated, recalculating SL/TP values for active trades');
      topCoinsRef.current.forEach(coin => {
        // Only calculate for active trades
        const isActiveTrade = coinTradeStatus[normalizeSymbolKey(coin.instrument_name)] === true;
        if (!isActiveTrade) return;
        
        // Only calculate if we don't have saved values for this coin AND we have signals
        const hasSavedSL = calculatedSL[coin.instrument_name] !== undefined && calculatedSL[coin.instrument_name] !== 0;
        const hasSavedTP = calculatedTP[coin.instrument_name] !== undefined && calculatedTP[coin.instrument_name] !== 0;
        const hasSignal = signals[coin.instrument_name] && signals[coin.instrument_name]?.res_up && signals[coin.instrument_name]?.res_down;
        
        if ((!hasSavedSL || !hasSavedTP) && hasSignal) {
          const values = calculateSLTPValues(coin);
          if (values.sl > 0 && values.tp > 0) {
            console.log(`Setting calculated values for ${coin.instrument_name}:`, values);
            setCalculatedSL(prev => {
              const newState = { ...prev, [coin.instrument_name]: values.sl };
              console.log('New calculatedSL state:', newState);
              return newState;
            });
            setCalculatedTP(prev => {
              const newState = { ...prev, [coin.instrument_name]: values.tp };
              console.log('New calculatedTP state:', newState);
              return newState;
            });
            
            // IMPORTANT: Save calculated SL/TP prices to backend so they can be used for order creation
            // These are the exact values shown in the dashboard - save them directly
            (async () => {
              try {
                const settingsToSave: Partial<CoinSettings> = {
                  sl_price: values.sl,
                  tp_price: values.tp
                };
                await saveCoinSettings(coin.instrument_name, settingsToSave);
                console.log(`✅ Saved calculated SL/TP prices to backend for ${coin.instrument_name}:`, settingsToSave);
              } catch (err) {
                console.warn(`⚠️ Failed to save calculated SL/TP prices for ${coin.instrument_name}:`, err);
              }
            })();
          }
        }
      });
    }
  }, [signals, calculateSLTPValues, calculatedSL, calculatedTP, coinTradeStatus]);

  // Load saved SL/TP values when coins are loaded (only for active trades)
  useEffect(() => {
    if (topCoinsRef.current.length > 0) {
      console.log('🔄 Loading saved SL/TP values for active trades');
      topCoinsRef.current.forEach(coin => {
        // Only process active trades
        const isActiveTrade = coinTradeStatus[normalizeSymbolKey(coin.instrument_name)] === true;
        if (!isActiveTrade) return;
        
        // Check if we have saved values for this coin
        const hasSavedSL = calculatedSL[coin.instrument_name] !== undefined && calculatedSL[coin.instrument_name] !== 0;
        const hasSavedTP = calculatedTP[coin.instrument_name] !== undefined && calculatedTP[coin.instrument_name] !== 0;
        
        // If we don't have saved values, try to calculate them
        if (!hasSavedSL || !hasSavedTP) {
          const signal = signals[coin?.instrument_name];
          if (signal && signal.res_up && signal.res_down) {
            const values = calculateSLTPValues(coin);
            if (values.sl > 0 && values.tp > 0) {
              console.log(`🔄 Loading calculated values for ${coin.instrument_name}:`, values);
              setCalculatedSL(prev => ({ ...prev, [coin.instrument_name]: values.sl }));
              setCalculatedTP(prev => ({ ...prev, [coin.instrument_name]: values.tp }));
            }
          }
        }
      });
    }
  }, [topCoinsRef.current.length, signals, calculateSLTPValues, calculatedSL, calculatedTP, coinTradeStatus]);

  return (
    <div className="container mx-auto p-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold">Trading Dashboard</h1>
      </div>

      {/* Tab Navigation */}
      <div className="flex gap-2 mb-6 border-b">
        <button
          data-testid="tab-portfolio"
          onClick={() => setActiveTab('portfolio')}
          className={`px-4 py-2 font-medium flex items-center gap-2 ${
            activeTab === 'portfolio'
              ? 'border-b-2 border-blue-600 text-blue-600'
              : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          <span>Portfolio</span>
          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">v{getCurrentVersion()}</span>
        </button>
        <button
          data-testid="tab-watchlist"
          onClick={() => setActiveTab('watchlist')}
          className={`px-4 py-2 font-medium flex items-center gap-2 ${
            activeTab === 'watchlist'
              ? 'border-b-2 border-blue-600 text-blue-600'
              : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          <span>Watchlist</span>
          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">v{getCurrentVersion()}</span>
        </button>
        <button
          data-testid="tab-orders"
          onClick={() => setActiveTab('orders')}
          className={`px-4 py-2 font-medium flex items-center gap-2 ${
            activeTab === 'orders'
              ? 'border-b-2 border-blue-600 text-blue-600'
              : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          <span>Open Orders</span>
          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">v{getCurrentVersion()}</span>
        </button>
        <button
          data-testid="tab-expected-take-profit"
          onClick={() => setActiveTab('expected-take-profit')}
          className={`px-4 py-2 font-medium flex items-center gap-2 ${
            activeTab === 'expected-take-profit'
              ? 'border-b-2 border-blue-600 text-blue-600'
              : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          <span>Expected Take Profit</span>
          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">v{getCurrentVersion()}</span>
        </button>
        <button
          data-testid="tab-executed-orders"
          onClick={() => setActiveTab('executed-orders')}
          className={`px-4 py-2 font-medium flex items-center gap-2 ${
            activeTab === 'executed-orders'
              ? 'border-b-2 border-blue-600 text-blue-600'
              : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          <span>Executed Orders</span>
          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">v{getCurrentVersion()}</span>
        </button>
        <button
          data-testid="tab-monitoring"
          onClick={() => {
            setActiveTab('monitoring');
          }}
          className={`px-4 py-2 font-medium flex items-center gap-2 ${
            activeTab === 'monitoring'
              ? 'border-b-2 border-blue-600 text-blue-600'
              : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          <span>Monitoring</span>
          {unreadMonitoringCount > 0 && (
            <span
              className="bg-[#D32F2F] text-white text-xs font-semibold rounded-full px-2 py-0.5 min-w-[20px] text-center"
            >
              {unreadMonitoringCount}
            </span>
          )}
          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">v{getCurrentVersion()}</span>
        </button>
        <button
          data-testid="tab-version-history"
          onClick={() => setActiveTab('version-history')}
          className={`px-4 py-2 font-medium flex items-center gap-2 ${
            activeTab === 'version-history'
              ? 'border-b-2 border-blue-600 text-blue-600'
              : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          <span>Version History</span>
          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">v{getCurrentVersion()}</span>
        </button>
      </div>

      {/* Portfolio Tab */}
      {activeTab === 'portfolio' && (
        <div>
          <div className="mb-4 flex justify-between items-center">
            <div className="flex items-center gap-2">
              {snapshotLastUpdated && (
              <div className="text-sm text-gray-500">
                <span className="mr-2">🕐</span>
                  Última actualización: {formatDateTime(snapshotLastUpdated)}
                  {snapshotStaleSeconds !== null && (
                    <span className="ml-2">({snapshotStaleSeconds}s ago)</span>
                  )}
              </div>
            )}
              {snapshotStale && (
                <span className="text-xs bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded" title="Data may be stale (last update > 90s)">
                  ⚠️ Data may be stale
                </span>
              )}
            </div>
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
                  onClick={async () => {
                    if (togglingLiveTrading) return;
                    setTogglingLiveTrading(true);
                    try {
                      const currentEnabled = botStatus.live_trading_enabled ?? false;
                      const result = await toggleLiveTrading(!currentEnabled);
                      if (result.ok) {
                        // Update bot status
                        setBotStatus({
                          ...botStatus,
                          live_trading_enabled: result.live_trading_enabled,
                          mode: result.mode
                        });
                        // Refresh dashboard snapshot
                        const snapshot = await getDashboardSnapshot();
                        if (snapshot.data.bot_status) {
                          setBotStatus(snapshot.data.bot_status);
                        }
                      }
                    } catch (err: unknown) {
                      const errorObj = err as { detail?: string; message?: string };
                      console.error('Failed to toggle LIVE_TRADING:', err);
                      const errorMessage = errorObj?.detail || errorObj?.message || 'Unknown error occurred';
                      alert(`Failed to toggle LIVE_TRADING: ${errorMessage}\n\nPlease check:\n1. Database connection is working\n2. TradingSettings table exists\n3. Backend logs for details`);
                    } finally {
                      setTogglingLiveTrading(false);
                    }
                  }}
                  disabled={togglingLiveTrading || isUpdating || topCoinsLoading || portfolioLoading}
                  className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
                    botStatus.live_trading_enabled
                      ? 'bg-green-600 text-white hover:bg-green-700'
                      : 'bg-gray-400 text-white hover:bg-gray-500'
                  } ${togglingLiveTrading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                  title={botStatus.live_trading_enabled ? 'Click to disable LIVE trading (switch to DRY RUN)' : 'Click to enable LIVE trading (real orders)'}
                >
                  {togglingLiveTrading ? '⏳' : botStatus.live_trading_enabled ? '🟢 LIVE' : '🔴 DRY RUN'}
                </button>
              </>
            )}
          </div>
          {portfolioLoading ? (
            <div>
              <div className="bg-gradient-to-r from-blue-500 to-purple-600 text-white rounded-lg p-6 mb-6 shadow-lg">
                <SkeletonBlock className="h-5 w-36 mb-4 bg-white/40" />
                <SkeletonBlock className="h-10 w-48 bg-white/60" />
              </div>
              <div className="mb-6">
                <h2 className="text-xl font-semibold mb-4">Holdings</h2>
                <Table>
                  <thead className="sticky top-0 z-10">
                    <tr className="bg-gradient-to-r from-gray-800 to-gray-700 text-white">
                      <th className="px-4 py-3 text-left font-semibold">Coin</th>
                      <th className="px-4 py-3 text-right font-semibold">Balance</th>
                      <th className="px-4 py-3 text-right font-semibold">Reserved</th>
                      <th className="px-4 py-3 text-right font-semibold">USD Value</th>
                      <th className="px-4 py-3 text-right font-semibold">% Portfolio</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: 5 }).map((_, idx) => (
                      <tr key={`portfolio-skeleton-${idx}`} className="border-b">
                        <td className="px-4 py-3"><SkeletonBlock className="h-4 w-24" /></td>
                        <td className="px-4 py-3 text-right"><SkeletonBlock className="h-4 w-20 ml-auto" /></td>
                        <td className="px-4 py-3 text-right"><SkeletonBlock className="h-4 w-20 ml-auto" /></td>
                        <td className="px-4 py-3 text-right"><SkeletonBlock className="h-4 w-24 ml-auto" /></td>
                        <td className="px-4 py-3 text-right"><SkeletonBlock className="h-4 w-16 ml-auto" /></td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            </div>
          ) : ((portfolio && portfolio.assets.length > 0) || realBalances.length > 0) ? (
            <>
              {/* Portfolio Summary Card */}
              <div className="bg-gradient-to-r from-blue-500 to-purple-600 text-white rounded-lg p-6 mb-6 shadow-lg">
                <div className="flex justify-between items-center">
                  <div>
                    <h2 className="text-lg font-semibold mb-2">Portfolio Value</h2>
                    <div className="flex items-baseline gap-2">
                    <p className="text-3xl font-bold">${formatNumber(
                      // Always calculate total as sum of all asset values
                      portfolio?.assets?.reduce((sum, asset) => sum + (asset.value_usd ?? 0), 0) ?? 
                      realBalances.reduce((sum, b) => sum + (b.usd_value ?? b.market_value ?? 0), 0)
                    )}</p>
                      {totalBorrowed > 0 && (
                        <span className="text-sm font-normal text-red-300">
                          (borrowed: ${formatNumber(totalBorrowed)})
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm opacity-90">Crypto.com Exchange</p>
                    <p className="text-sm opacity-75">{realBalances.length > 0 ? realBalances.filter(b => {
                      const total = b.total ?? b.balance ?? ((b.free ?? 0) + (b.locked ?? 0));
                      return total > 0;
                    }).length : (portfolio?.assets.length ?? 0)} assets</p>
                  </div>
                </div>
              </div>
              
              {/* P/L Summary Section */}
              <div className="mb-6 bg-white rounded-lg shadow-md p-6">
                <div className="flex justify-between items-center mb-4">
                  <h2 className="text-xl font-semibold">P/L Summary</h2>
                  <div className="flex gap-2">
                    <select
                      value={plPeriod}
                      onChange={(e) => setPlPeriod(e.target.value as 'daily' | 'weekly' | 'monthly' | 'yearly')}
                      className="px-3 py-1 border rounded-lg text-sm"
                      aria-label="Select P/L period"
                    >
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                      <option value="monthly">Monthly</option>
                      <option value="yearly">Yearly</option>
                    </select>
                    {(plPeriod === 'monthly' || plPeriod === 'yearly') && (
                      <select
                        value={selectedMonth}
                        onChange={(e) => setSelectedMonth(parseInt(e.target.value))}
                        className="px-3 py-1 border rounded-lg text-sm"
                        disabled={plPeriod === 'yearly'}
                        aria-label="Select month"
                      >
                        {Array.from({ length: 12 }, (_, i) => (
                          <option key={i} value={i}>{new Date(2000, i).toLocaleString('en-US', { month: 'long' })}</option>
                        ))}
                      </select>
                    )}
                    {(plPeriod === 'monthly' || plPeriod === 'yearly') && (
                      <select
                        value={selectedYear}
                        onChange={(e) => setSelectedYear(parseInt(e.target.value))}
                        className="px-3 py-1 border rounded-lg text-sm"
                        aria-label="Select year"
                      >
                        {Array.from({ length: 10 }, (_, i) => {
                          const year = new Date().getFullYear() - i;
                          return <option key={year} value={year}>{year}</option>;
                        })}
                      </select>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                    <div className="text-sm text-gray-600 mb-1">Realized P/L</div>
                    <div className={`text-2xl font-bold ${(plSummary?.realizedPL ?? 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {(plSummary?.realizedPL ?? 0) >= 0 ? '+' : ''}${formatPLSummaryNumber(plSummary?.realizedPL ?? 0)}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">Executed orders</div>
                  </div>
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                    <div className="text-sm text-gray-600 mb-1">Potential P/L</div>
                    <div className={`text-2xl font-bold ${(plSummary?.potentialPL ?? 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {(plSummary?.potentialPL ?? 0) >= 0 ? '+' : ''}${formatPLSummaryNumber(plSummary?.potentialPL ?? 0)}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">Unrealized (current price)</div>
                  </div>
                  <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
                    <div className="text-sm text-gray-600 mb-1">Total P/L</div>
                    <div className={`text-2xl font-bold ${(plSummary?.totalPL ?? 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {(plSummary?.totalPL ?? 0) >= 0 ? '+' : ''}${formatPLSummaryNumber(plSummary?.totalPL ?? 0)}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">Realized + Potential</div>
                  </div>
                </div>
              </div>
              
              {/* Warning message if balances exist but no USD values */}
              {(() => {
                const hasRealBalances = realBalances.length > 0;
                const hasPortfolioAssets = portfolio && portfolio.assets.length > 0;
                
                // Check if we have balances but no USD values
                const checkBalances = hasRealBalances ? realBalances : [];
                const checkAssets = hasPortfolioAssets ? portfolio.assets : [];
                
                const hasBalances = (checkBalances.length > 0 && checkBalances.some(b => {
                  const total = b.total ?? b.balance ?? ((b.free ?? 0) + (b.locked ?? 0));
                  return total > 0;
                })) || (checkAssets.length > 0 && checkAssets.some(a => {
                  const balance = a.balance ?? (a.available_qty + a.reserved_qty);
                  return balance > 0;
                }));
                
                const hasNoUsdValues = hasBalances && (
                  (checkBalances.length > 0 && !checkBalances.some(b => {
                    const usdValue = b.usd_value ?? b.market_value ?? 0;
                    return usdValue > 0;
                  })) ||
                  (checkAssets.length > 0 && !checkAssets.some(a => (a.value_usd ?? 0) > 0))
                );
                
                if (hasNoUsdValues) {
                  return (
                    <div className="mb-4 text-sm text-orange-700 bg-orange-50 border border-orange-200 rounded px-3 py-2">
                      ⚠️ Balances found but USD values not calculated yet. Backend will calculate USD values on next sync.
                    </div>
                  );
                }
                return null;
              })()}

              {/* Holdings Table */}
              <div className="mb-6">
                <h2 className="text-xl font-semibold mb-4">Holdings</h2>
                <Table>
                  <thead className="sticky top-0 z-10">
                    <tr className="bg-gradient-to-r from-gray-800 to-gray-700 text-white">
                      <SortableHeader field="coin" sortState={portfolioSort} setSortState={setPortfolioSort} className="px-4 py-3 text-left font-semibold">Coin</SortableHeader>
                      <SortableHeader field="balance" sortState={portfolioSort} setSortState={setPortfolioSort} className="px-4 py-3 text-right font-semibold">Balance</SortableHeader>
                      <SortableHeader field="reserved" sortState={portfolioSort} setSortState={setPortfolioSort} className="px-4 py-3 text-right font-semibold">Reserved</SortableHeader>
                      <SortableHeader field="usd_value" sortState={portfolioSort} setSortState={setPortfolioSort} className="px-4 py-3 text-right font-semibold">USD Value</SortableHeader>
                      <SortableHeader field="percent" sortState={portfolioSort} setSortState={setPortfolioSort} className="px-4 py-3 text-right font-semibold">% Portfolio</SortableHeader>
                      <th className="px-4 py-3 text-center font-semibold">Open Orders</th>
                      <th className="px-4 py-3 text-center font-semibold">TP</th>
                      <th className="px-4 py-3 text-center font-semibold">SL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {realBalances.length > 0 ? (
                      (() => {
                        // Debug: Rendering balances (silenced to reduce console noise)
                        const filtered = realBalances.filter(b => {
                          // Include ALL balances with positive balance amount (even if USD value is 0)
                          const total = b.total ?? b.balance ?? ((b.free ?? 0) + (b.locked ?? 0));
                          const hasBalance = total > 0;
                          // Debug: Filtering balance (silenced to reduce console noise)
                          return hasBalance; // Show ALL balances with positive amount, even if USD value is 0
                        });
                        // Debug: Filtered balances (silenced to reduce console noise)
                        
                        const parseNumericValue = (value: unknown): number => {
                          if (typeof value === 'number' && Number.isFinite(value)) {
                            return value;
                          }
                          const parsed = Number(value);
                          return Number.isFinite(parsed) ? parsed : 0;
                        };

                        // Aggregate balances by normalized base currency so each coin shows exactly once.
                        const aggregateBalancesByCoin = (items: typeof filtered): typeof filtered => {
                          const aggregated = new Map<string, DashboardBalance>();
                          items.forEach(balance => {
                            const rawAsset = (balance.asset || balance.currency || '').toUpperCase();
                            if (!rawAsset) {
                            return;
                          }
                            const baseCurrency = rawAsset.split('_')[0];
                            const assetKey = baseCurrency;
                            const totalQty = parseNumericValue(balance.balance ?? balance.total ?? ((balance.free ?? 0) + (balance.locked ?? 0)));
                            const freeQty = parseNumericValue(balance.free);
                            const lockedQty = parseNumericValue(balance.locked);
                            // Preserve original values to check if they were undefined/null vs 0
                            // This is critical: we need to distinguish between 0 (valid value) and undefined/null (missing value)
                            // Don't use fallback here - we need the actual original values to determine if they were 0 or undefined
                            const originalUsdValue = balance.usd_value;
                            const originalMarketValue = balance.market_value;
                            // For parsing, use fallback to get a numeric value for calculations
                            const usdValue = parseNumericValue(balance.usd_value ?? balance.market_value);
                            const marketValue = parseNumericValue(balance.market_value ?? balance.usd_value);

                            if (!aggregated.has(assetKey)) {
                              aggregated.set(assetKey, {
                                ...balance,
                                asset: assetKey,
                                balance: totalQty,
                                total: totalQty,
                                free: freeQty,
                                locked: lockedQty,
                                // Preserve 0 values: only set to undefined if original was undefined/null
                                // Use != null to check for both null and undefined, but preserve 0, false, empty string, etc.
                                usd_value: originalUsdValue != null ? usdValue : undefined,
                                market_value: originalMarketValue != null ? marketValue : (originalUsdValue != null ? usdValue : undefined),
                              });
                            } else {
                              const existing = aggregated.get(assetKey)!;
                              existing.balance = parseNumericValue(existing.balance) + totalQty;
                              existing.total = parseNumericValue(existing.total) + totalQty;
                              existing.free = parseNumericValue(existing.free) + freeQty;
                              existing.locked = parseNumericValue(existing.locked) + lockedQty;
                              const currentUsd = parseNumericValue(existing.usd_value);
                              const currentMarket = parseNumericValue(existing.market_value);
                              const combinedUsd = currentUsd + usdValue;
                              // Preserve 0 values: use usdValue if it was originally defined (including 0), otherwise use marketValue
                              const valueToAdd = originalUsdValue != null ? usdValue : marketValue;
                              const combinedMarket = currentMarket + valueToAdd;
                              // Preserve 0 values: combined values are always numbers (could be 0), only set undefined for NaN
                              existing.usd_value = Number.isNaN(combinedUsd) ? undefined : combinedUsd;
                              existing.market_value = Number.isNaN(combinedMarket) ? undefined : combinedMarket;
                            }
                          });
                          return Array.from(aggregated.values());
                        };

                        const finalFiltered = aggregateBalancesByCoin(filtered);
                        
                        // Helper function to get TP/SL order values for a coin
                        const getCoinOrderValues = (coinAsset: string | undefined | null, portfolioValueUsd: number): { tpValueUsd: number; slValueUsd: number; tpCovered: boolean; slCovered: boolean } => {
                          if (!coinAsset) {
                            return { tpValueUsd: 0, slValueUsd: 0, tpCovered: false, slCovered: false };
                          }
                          const coinUpper = (coinAsset || '').toUpperCase();
                          const coinBase = coinUpper.split('_')[0];
                          
                          // Get TP/SL order values from open orders
                          const orderValues = tpSlOrderValues[coinBase] || { tp_value_usd: 0, sl_value_usd: 0 };
                          const tpValueUsd = orderValues.tp_value_usd || 0;
                          const slValueUsd = orderValues.sl_value_usd || 0;
                          
                          // Check if orders cover the portfolio value (within 5% tolerance)
                          const tolerance = 0.05; // 5% tolerance
                          const tpCovered = tpValueUsd > 0 && portfolioValueUsd > 0 && Math.abs(tpValueUsd - portfolioValueUsd) / portfolioValueUsd <= tolerance;
                          const slCovered = slValueUsd > 0 && portfolioValueUsd > 0 && Math.abs(slValueUsd - portfolioValueUsd) / portfolioValueUsd <= tolerance;
                          
                          return { tpValueUsd, slValueUsd, tpCovered, slCovered };
                        };
                        
                        // Helper function to count open orders and calculate TP/SL values for a coin.
                        // The "count" now comes from the backend unified open_position_counts when available
                        // so that the dashboard number matches the trading engine and protection logic.
                        // Also builds a human-readable tooltip so the user can verify exactly which
                        // orders are being counted when hovering over the "Open Orders" badge.
                        const getOpenOrdersInfo = (
                          coinAsset: string,
                          _portfolioBalance?: unknown
                        ): { count: number; tpValue: number; slValue: number; details: string } => {
                          const coinUpper = coinAsset.toUpperCase();
                          // Filter orders matching the symbol (for tooltip only)
                          // If coinAsset contains underscore (e.g., DOGE_USDT), match exact or USD/USDT variant
                          // Otherwise, match base currency (e.g., DOGE matches DOGE_USD and DOGE_USDT)
                          const matchingOrders = openOrders.filter(order => {
                            // Use instrument_name (which contains the symbol like BTC_USDT)
                            const orderSymbol = (order.instrument_name || (order as ExtendedOpenOrder).symbol || '').toUpperCase();
                            if (!orderSymbol) return false;
                            
                            // If coinAsset has underscore (e.g., BTC_USDT), match exact or USD/USDT variant
                            if (coinUpper.includes('_')) {
                              // Exact match
                              if (orderSymbol === coinUpper) return true;
                              
                              // USD and USDT are equivalent - check if base currency matches
                              const coinBase = coinUpper.split('_')[0];
                              const orderBase = orderSymbol.split('_')[0];
                              if (coinBase === orderBase) {
                                // Check if both end with USD or USDT (they're equivalent)
                                const coinSuffix = coinUpper.split('_')[1];
                                const orderSuffix = orderSymbol.split('_')[1];
                                if ((coinSuffix === 'USD' || coinSuffix === 'USDT') && 
                                    (orderSuffix === 'USD' || orderSuffix === 'USDT')) {
                                  return true;
                                }
                              }
                              return false;
                            }
                            
                            // Otherwise, match exact symbol or base currency
                            if (orderSymbol === coinUpper) return true;
                            
                            // Match base currency (e.g., DOGE matches DOGE_USD and DOGE_USDT)
                            const baseCurrency = coinUpper.split('_')[0];
                            return orderSymbol.startsWith(baseCurrency + '_');
                          });
                          
                          // Separate BUY and SELL orders
                          const buyOrders = matchingOrders.filter(order => (order.side || '').toUpperCase() === 'BUY');
                          const sellOrders = matchingOrders.filter(order => (order.side || '').toUpperCase() === 'SELL');
                          
                          // Calculate TP and SL values
                          let tpValue = 0;
                          let slValue = 0;
                          
                          // Process explicit TP/SL orders only (don't guess LIMIT orders)
                          // Filter to only active orders (include PENDING as it's an active state for trigger orders)
                          const activeStatuses = new Set(['NEW', 'ACTIVE', 'PARTIALLY_FILLED', 'PENDING']);
                          
                          // Store TP orders for tooltip display - reuse the same detection logic
                          const identifiedTPOrders: typeof matchingOrders = [];
                          
                          matchingOrders.forEach(order => {
                            const orderType = (order.order_type || '').toUpperCase();
                            const orderStatus = (order.status || '').toUpperCase();
                            
                            // Only process active orders
                            if (!activeStatuses.has(orderStatus)) {
                              return;
                            }
                            
                            // Calculate order value: prefer cumulative_value or order_value, fallback to price * quantity
                            let orderValue = 0;
                            const extendedOrder = order as ExtendedOpenOrder;
                            if (extendedOrder.cumulative_value && parseFloat(String(extendedOrder.cumulative_value)) > 0) {
                              orderValue = parseFloat(String(extendedOrder.cumulative_value));
                            } else if (extendedOrder.order_value && parseFloat(String(extendedOrder.order_value)) > 0) {
                              orderValue = parseFloat(String(extendedOrder.order_value));
                            } else {
                              const price = parseFloat(order.price || '0');
                              const quantity = parseFloat(order.quantity || '0');
                              orderValue = price * quantity;
                            }
                            
                            // Identify TP orders (check order_type, trigger_type/order_role, and raw metadata)
                            // Use comprehensive check matching the tooltip logic
                            const triggerType = (((extendedOrder.trigger_type ?? (order as any).trigger_type ?? '') as string).toUpperCase()).trim();
                            const rawOrder = extendedOrder.raw || extendedOrder.metadata || (order as any).raw || (order as any).metadata || {};
                            const rawOrderType = ((rawOrder.order_type || rawOrder.type || '').toUpperCase()).trim();
                            // Check order_role at top level first (from backend), then in raw/metadata
                            const orderRole = ((order.order_role ?? extendedOrder.order_role ?? rawOrder.order_role ?? '') as string).toUpperCase().trim();
                            const rawOrderRole = ((rawOrder.order_role || '').toUpperCase()).trim();
                            const isTrigger = Boolean(extendedOrder.is_trigger ?? (order as any).is_trigger ?? false);
                            
                            const isTP = 
                              orderType.includes('TAKE_PROFIT') || 
                              orderType === 'TAKE_PROFIT_LIMIT' || 
                              triggerType === 'TAKE_PROFIT' ||
                              (isTrigger && triggerType && triggerType.includes('TAKE_PROFIT')) ||
                              rawOrderType.includes('TAKE_PROFIT') ||
                              orderRole === 'TAKE_PROFIT' ||
                              rawOrderRole === 'TAKE_PROFIT';
                            const isSL = 
                              orderType.includes('STOP_LOSS') || 
                              orderType === 'STOP_LOSS_LIMIT' || 
                              triggerType === 'STOP_LOSS' ||
                              (isTrigger && triggerType && triggerType.includes('STOP_LOSS')) ||
                              rawOrderType.includes('STOP_LOSS') ||
                              orderRole === 'STOP_LOSS' ||
                              rawOrderRole === 'STOP_LOSS';
                            
                            if (isTP) {
                              tpValue += orderValue;
                              identifiedTPOrders.push(order); // Store for tooltip display
                            }
                            // Identify SL orders (only explicit STOP_LOSS types)
                            else if (isSL) {
                              slValue += orderValue;
                            }
                            // Note: We no longer try to guess LIMIT orders as TP/SL to avoid double counting
                          });
                          
                          // Use backend values as fallback only if frontend found nothing
                          const coinBase = coinUpper.split('_')[0];
                          const backendOrderValues = tpSlOrderValues[coinBase] || { tp_value_usd: 0, sl_value_usd: 0 };
                          
                          // Use frontend calculation if available, otherwise use backend (don't use MAX to avoid double counting)
                          let finalTpValue = tpValue > 0 ? tpValue : (backendOrderValues.tp_value_usd || 0);
                          let finalSlValue = slValue > 0 ? slValue : (backendOrderValues.sl_value_usd || 0);

                          // Cap TP/SL values to the holding value (you can't have orders worth more than you own)
                          // We'll cap this when we have the holding value, but for now store the raw values

                          // Use unified open position count from backend when available.
                          // open_position_counts is keyed by base currency (e.g., "ADA", "LDO").
                          let unifiedCount = 0;
                          try {
                            const baseForCount = coinBase || coinUpper;
                            // Use latest dashboardState from refs if available
                            const latestDashboardState = (window as Window & { __LAST_DASHBOARD_STATE__?: DashboardState }).__LAST_DASHBOARD_STATE__;
                            unifiedCount = latestDashboardState?.open_position_counts?.[baseForCount] ?? 0;
                          } catch {
                            unifiedCount = 0;
                          }

                          // Build tooltip details listing all matching TP (Take Profit) orders for this asset
                          // Use the TP orders we already identified during value calculation to ensure consistency
                          let details = '';
                          const tpOrders = identifiedTPOrders; // Reuse orders identified during value calculation
                          
                          if (tpOrders.length === 0) {
                            // If no TP orders found but tpValue > 0, there might be TP orders that weren't detected
                            // Show a message indicating this
                            if (finalTpValue > 0) {
                              details = `TP orders detected (value: $${finalTpValue.toFixed(2)}) but details unavailable. Check console for debug info.`;
                              // Debug logging to help identify the issue
                              console.log(`[TP Debug] ${coinUpper}: tpValue=${finalTpValue}, matchingOrders=${matchingOrders.length}`, {
                                matchingOrders: matchingOrders.map(o => ({
                                  id: o.order_id,
                                  symbol: o.instrument_name || (o as ExtendedOpenOrder).symbol,
                                  type: o.order_type,
                                  trigger_type: (o as any).trigger_type,
                                  status: o.status,
                                  raw: (o as any).raw
                                }))
                              });
                            } else {
                              details = 'No active TP (Take Profit) orders';
                            }
                          } else {
                            const lines: string[] = [];
                            lines.push(`Active TP Orders for ${coinUpper}: ${tpOrders.length}`);
                            tpOrders.forEach((order, idx) => {
                              const side = (order.side || '').toUpperCase() || 'N/A';
                              const type = (order.order_type || '').toUpperCase() || 'N/A';
                              const status = (order.status || '').toUpperCase() || 'N/A';
                              const extendedOrder = order as ExtendedOpenOrder;
                              const orderSymbol = (order.instrument_name || extendedOrder.symbol || '').toUpperCase() || coinUpper;
                              const qtyRaw = order.quantity || extendedOrder.cumulative_quantity || extendedOrder.cumulative_quantity || '0';
                              const priceRaw = order.price || extendedOrder.avg_price || extendedOrder.avg_price || '0';
                              const qty = parseFloat(String(qtyRaw) || '0');
                              const price = parseFloat(String(priceRaw) || '0');
                              const id = order.order_id || order.order_id || '';
                              const shortId = id ? String(id).slice(-8) : '';
                              const qtyText = qty > 0 ? qty.toFixed(4) : String(qtyRaw);
                              const priceText = price > 0 ? price.toFixed(6) : String(priceRaw);
                              const idText = shortId ? ` #${shortId}` : '';
                              // Calculate order value: prefer cumulative_value or order_value, fallback to price * quantity
                              let orderValue = 0;
                              if (extendedOrder.cumulative_value && parseFloat(String(extendedOrder.cumulative_value)) > 0) {
                                orderValue = parseFloat(String(extendedOrder.cumulative_value));
                              } else if (extendedOrder.order_value && parseFloat(String(extendedOrder.order_value)) > 0) {
                                orderValue = parseFloat(String(extendedOrder.order_value));
                              } else {
                                orderValue = qty * price;
                              }
                              const valueText = orderValue > 0 ? ` ($${orderValue.toFixed(2)})` : '';
                              // Format for HTML title attribute (use | as separator since newlines don't work well)
                              lines.push(`${idx + 1}. ${side} ${type} [${status}] | ${orderSymbol}${idText} | ${qtyText} @ $${priceText}${valueText}`);
                            });
                            // Join with newlines for better readability (browsers may collapse them but it's still better than nothing)
                            details = lines.join('\n');
                          }
                          
                          return {
                            // Show unified count if available; otherwise fall back to BUY open orders
                            count: unifiedCount > 0 ? unifiedCount : buyOrders.length,
                            tpValue: finalTpValue,
                            slValue: finalSlValue,
                            details
                          };
                        };
                        
                        return finalFiltered.length > 0 ? finalFiltered.map(balance => {
                          const assetUpper = (balance.asset || '').toUpperCase();
                          const displayBalance = balance.balance ?? balance.total ?? ((balance.free ?? 0) + (balance.locked ?? 0));
                          
                          // Use backend-provided USD value when available, otherwise attempt to derive from portfolio snapshot.
                          const portfolioAsset = portfolio?.assets?.find(a => a.coin === balance.asset);
                          const fallbackUsd =
                            (balance.usd_value !== undefined && balance.usd_value !== null && balance.usd_value > 0)
                            ? balance.usd_value
                            : ((balance.market_value !== undefined && balance.market_value !== null && balance.market_value > 0)
                                ? balance.market_value
                                : (portfolioAsset?.value_usd ?? 0));
                          const displayValueUsd = fallbackUsd;
                          
                          const totalPortfolioValue = portfolio?.total_value_usd ?? realBalances.reduce((sum, b) => sum + (b.usd_value ?? b.market_value ?? 0), 0);
                          const percentOfPortfolio = totalPortfolioValue > 0 && displayValueUsd > 0
                            ? formatNumber((displayValueUsd / totalPortfolioValue) * 100)
                            : '0.00';
                          // Debug: Rendering balance (silenced to reduce console noise)
                          
                          // Get TP/SL order values for this coin
                          const orderValues = getCoinOrderValues(balance.asset, displayValueUsd);
                          
                          // Get open orders info (count, TP value, SL value) for this coin
                          const openOrdersInfo = getOpenOrdersInfo(balance.asset, balance);
                          
                          // Cap TP/SL values to the holding value (you can't have orders worth more than you own)
                          const cappedTpValue = Math.min(openOrdersInfo.tpValue, displayValueUsd);
                          const cappedSlValue = Math.min(openOrdersInfo.slValue, displayValueUsd);
                          
                          return { 
                            balance: { ...balance, balance: displayBalance }, 
                            displayValueUsd, 
                            percentOfPortfolio, 
                            orderValues, 
                            openOrdersInfo: {
                              ...openOrdersInfo,
                              tpValue: cappedTpValue,
                              slValue: cappedSlValue
                            }
                          };
                        })
                        .sort((a, b) => {
                          // Apply sorting based on portfolioSort state
                          if (!portfolioSort.field) {
                            // Default sort by USD value descending
                            return b.displayValueUsd - a.displayValueUsd;
                          }
                          
                          const getValue = (item: typeof a, field: string) => {
                            switch (field) {
                              case 'coin':
                                return (item.balance.asset || '').toUpperCase();
                              case 'balance':
                                return item.balance.balance ?? 0;
                              case 'reserved':
                                return item.balance.locked ?? 0;
                              case 'usd_value':
                                return item.displayValueUsd;
                              case 'percent':
                                return parseFloat(item.percentOfPortfolio) || 0;
                              default:
                                return 0;
                            }
                          };
                          
                          const aVal = getValue(a, portfolioSort.field);
                          const bVal = getValue(b, portfolioSort.field);
                          
                          if (aVal == null && bVal == null) return 0;
                          if (aVal == null) return 1;
                          if (bVal == null) return -1;
                          
                          if (typeof aVal === 'number' && typeof bVal === 'number') {
                            return portfolioSort.direction === 'asc' ? aVal - bVal : bVal - aVal;
                          }
                          
                          const aStr = String(aVal).toLowerCase();
                          const bStr = String(bVal).toLowerCase();
                          if (portfolioSort.direction === 'asc') {
                            return aStr < bStr ? -1 : aStr > bStr ? 1 : 0;
                          } else {
                            return aStr > bStr ? -1 : aStr < bStr ? 1 : 0;
                          }
                        })
                        .map(({ balance, displayValueUsd, percentOfPortfolio, orderValues: _orderValues, openOrdersInfo }) => (
                          <tr key={balance.asset} data-testid={`portfolio-row-${balance.asset}`} className="hover:bg-gray-50 border-b">
                            <td className="px-4 py-3 font-medium">{normalizeSymbol(balance.asset || '')}</td>
                            <td className="px-4 py-3 text-right">{formatNumber(balance.balance ?? balance.total ?? ((balance.free ?? 0) + (balance.locked ?? 0)), balance.asset)}</td>
                            <td className="px-4 py-3 text-right">{formatNumber(balance.locked ?? 0, balance.asset)}</td>
                            <td className="px-4 py-3 text-right font-semibold">${formatNumber(displayValueUsd)}</td>
                            <td className="px-4 py-3 text-right">{percentOfPortfolio}%</td>
                            <td className="px-4 py-3 text-center">
                              <span
                                className={`px-2 py-1 rounded text-sm font-medium ${
                                openOrdersInfo.count > 3
                                  ? 'bg-red-100 text-red-800 border border-red-500 font-bold'
                                  : openOrdersInfo.count > 0
                                    ? 'bg-blue-100 text-blue-800 border border-blue-400'
                                    : 'bg-gray-100 text-gray-600 border border-gray-300'
                                }`}
                                title={
                                  openOrdersInfo.count > 0
                                    ? openOrdersInfo.details
                                    : 'No open orders'
                                }
                              >
                                {openOrdersInfo.count}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span className={`px-2 py-1 rounded text-sm font-medium ${
                                openOrdersInfo.tpValue > 0 && Math.abs(openOrdersInfo.tpValue - displayValueUsd) / displayValueUsd <= 0.05
                                  ? 'bg-green-100 text-green-800 border border-green-500' 
                                  : openOrdersInfo.tpValue > 0
                                    ? 'bg-yellow-100 text-yellow-800 border border-yellow-400'
                                    : 'bg-gray-100 text-gray-600 border border-gray-300'
                              }`} title={openOrdersInfo.tpValue > 0 && Math.abs(openOrdersInfo.tpValue - displayValueUsd) / displayValueUsd <= 0.05 ? `TP orders cover portfolio value ($${openOrdersInfo.tpValue.toFixed(2)} ≈ $${formatNumber(displayValueUsd)})` : openOrdersInfo.tpValue > 0 ? `TP orders: $${openOrdersInfo.tpValue.toFixed(2)} (portfolio: $${formatNumber(displayValueUsd)})` : 'No TP orders'}>
                                ${openOrdersInfo.tpValue.toFixed(2)}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span className={`px-2 py-1 rounded text-sm font-medium ${
                                openOrdersInfo.slValue > 0 && Math.abs(openOrdersInfo.slValue - displayValueUsd) / displayValueUsd <= 0.05
                                  ? 'bg-green-100 text-green-800 border border-green-500' 
                                  : openOrdersInfo.slValue > 0
                                    ? 'bg-yellow-100 text-yellow-800 border border-yellow-400'
                                    : 'bg-gray-100 text-gray-600 border border-gray-300'
                              }`} title={openOrdersInfo.slValue > 0 && Math.abs(openOrdersInfo.slValue - displayValueUsd) / displayValueUsd <= 0.05 ? `SL orders cover portfolio value ($${openOrdersInfo.slValue.toFixed(2)} ≈ $${formatNumber(displayValueUsd)})` : openOrdersInfo.slValue > 0 ? `SL orders: $${openOrdersInfo.slValue.toFixed(2)} (portfolio: $${formatNumber(displayValueUsd)})` : 'No SL orders'}>
                                ${openOrdersInfo.slValue.toFixed(2)}
                              </span>
                            </td>
                          </tr>
                        )) : (
                          <tr>
                            <td colSpan={8} className="px-4 py-6 text-center text-gray-500">
                              No balances with positive amounts found in realBalances. Showing portfolio.assets instead.
                            </td>
                          </tr>
                        );
                      })()
                    ) : (portfolio && portfolio.assets.length > 0) ? (
                      (() => {
                        // TypeScript: portfolio is guaranteed to be non-null here due to the condition above
                        const portfolioData = portfolio!;
                        console.log(`🔍 No realBalances, using portfolio.assets (${portfolioData.assets.length} assets)`);
                        
                        // Create a map of watchlist items for quick lookup
                        const watchlistMap = new Map<string, WatchlistItem>();
                        watchlistItems.forEach(item => {
                          const baseCurrency = item.symbol.split('_')[0]?.toUpperCase();
                          if (baseCurrency && !watchlistMap.has(baseCurrency)) {
                            watchlistMap.set(baseCurrency, item);
                          }
                          const fullSymbol = item.symbol.toUpperCase();
                          if (!watchlistMap.has(fullSymbol)) {
                            watchlistMap.set(fullSymbol, item);
                          }
                        });
                        
                        // Helper function to get TP/SL order values for a coin
                        const getCoinOrderValues = (coinAsset: string | undefined | null, portfolioValueUsd: number): { tpValueUsd: number; slValueUsd: number; tpCovered: boolean; slCovered: boolean } => {
                          if (!coinAsset) {
                            return { tpValueUsd: 0, slValueUsd: 0, tpCovered: false, slCovered: false };
                          }
                          const coinUpper = (coinAsset || '').toUpperCase();
                          const coinBase = coinUpper.split('_')[0];
                          
                          // Get TP/SL order values from open orders
                          const orderValues = tpSlOrderValues[coinBase] || { tp_value_usd: 0, sl_value_usd: 0 };
                          const tpValueUsd = orderValues.tp_value_usd || 0;
                          const slValueUsd = orderValues.sl_value_usd || 0;
                          
                          // Check if orders cover the portfolio value (within 5% tolerance)
                          const tolerance = 0.05; // 5% tolerance
                          const tpCovered = tpValueUsd > 0 && portfolioValueUsd > 0 && Math.abs(tpValueUsd - portfolioValueUsd) / portfolioValueUsd <= tolerance;
                          const slCovered = slValueUsd > 0 && portfolioValueUsd > 0 && Math.abs(slValueUsd - portfolioValueUsd) / portfolioValueUsd <= tolerance;
                          
                          return { tpValueUsd, slValueUsd, tpCovered, slCovered };
                        };
                        
                        // Helper function to count open orders and calculate TP/SL values for a coin
                        const getOpenOrdersInfo = (coinAsset: string | undefined | null, _portfolioBalance?: unknown): { count: number; tpValue: number; slValue: number } => {
                          if (!coinAsset) {
                            return { count: 0, tpValue: 0, slValue: 0 };
                          }
                          const coinUpper = (coinAsset || '').toUpperCase();
                          // Filter orders matching the symbol
                          // If coinAsset contains underscore (e.g., BTC_USDT), match exact or USD/USDT variant
                          // Otherwise, match base currency (e.g., DOGE matches DOGE_USD and DOGE_USDT)
                          const matchingOrders = openOrders.filter(order => {
                            // Use instrument_name (which contains the symbol like BTC_USDT)
                            const orderSymbol = (order.instrument_name || (order as ExtendedOpenOrder).symbol || '').toUpperCase();
                            if (!orderSymbol) return false;
                            
                            // If coinAsset has underscore (e.g., BTC_USDT), match exact or USD/USDT variant
                            if (coinUpper.includes('_')) {
                              // Exact match
                              if (orderSymbol === coinUpper) return true;
                              
                              // USD and USDT are equivalent - check if base currency matches
                              const coinBase = coinUpper.split('_')[0];
                              const orderBase = orderSymbol.split('_')[0];
                              if (coinBase === orderBase) {
                                // Check if both end with USD or USDT (they're equivalent)
                                const coinSuffix = coinUpper.split('_')[1];
                                const orderSuffix = orderSymbol.split('_')[1];
                                if ((coinSuffix === 'USD' || coinSuffix === 'USDT') && 
                                    (orderSuffix === 'USD' || orderSuffix === 'USDT')) {
                                  return true;
                                }
                              }
                              return false;
                            }
                            
                            // Otherwise, match exact symbol or base currency
                            if (orderSymbol === coinUpper) return true;
                            
                            // Match base currency (e.g., DOGE matches DOGE_USD and DOGE_USDT)
                            const baseCurrency = coinUpper.split('_')[0];
                            return orderSymbol.startsWith(baseCurrency + '_');
                          });
                          
                          // Separate BUY and SELL orders
                          const buyOrders = matchingOrders.filter(order => (order.side || '').toUpperCase() === 'BUY');
                          const sellOrders = matchingOrders.filter(order => (order.side || '').toUpperCase() === 'SELL');
                          
                          // Calculate TP and SL values
                          let tpValue = 0;
                          let slValue = 0;
                          
                          // Process explicit TP/SL orders only (don't guess LIMIT orders)
                          // Filter to only active orders (include PENDING as it's an active state for trigger orders)
                          const activeStatuses = new Set(['NEW', 'ACTIVE', 'PARTIALLY_FILLED', 'PENDING']);
                          matchingOrders.forEach(order => {
                            const orderType = (order.order_type || '').toUpperCase();
                            const orderStatus = (order.status || '').toUpperCase();
                            
                            // Only process active orders
                            if (!activeStatuses.has(orderStatus)) {
                              return;
                            }
                            
                            // Calculate order value: prefer cumulative_value or order_value, fallback to price * quantity
                            let orderValue = 0;
                            const extendedOrder = order as ExtendedOpenOrder;
                            if (extendedOrder.cumulative_value && parseFloat(String(extendedOrder.cumulative_value)) > 0) {
                              orderValue = parseFloat(String(extendedOrder.cumulative_value));
                            } else if (extendedOrder.order_value && parseFloat(String(extendedOrder.order_value)) > 0) {
                              orderValue = parseFloat(String(extendedOrder.order_value));
                            } else {
                              const price = parseFloat(order.price || '0');
                              const quantity = parseFloat(order.quantity || '0');
                              orderValue = price * quantity;
                            }
                            
                            // Identify TP orders (check order_type, trigger_type/order_role, and raw metadata)
                            // Use comprehensive check matching the tooltip logic
                            const triggerType = (((extendedOrder.trigger_type ?? (order as any).trigger_type ?? '') as string).toUpperCase()).trim();
                            const rawOrder = extendedOrder.raw || extendedOrder.metadata || (order as any).raw || (order as any).metadata || {};
                            const rawOrderType = ((rawOrder.order_type || rawOrder.type || '').toUpperCase()).trim();
                            // Check order_role at top level first (from backend), then in raw/metadata
                            const orderRole = ((order.order_role ?? extendedOrder.order_role ?? rawOrder.order_role ?? '') as string).toUpperCase().trim();
                            const rawOrderRole = ((rawOrder.order_role || '').toUpperCase()).trim();
                            const isTrigger = Boolean(extendedOrder.is_trigger ?? (order as any).is_trigger ?? false);
                            
                            const isTP = 
                              orderType.includes('TAKE_PROFIT') || 
                              orderType === 'TAKE_PROFIT_LIMIT' || 
                              triggerType === 'TAKE_PROFIT' ||
                              (isTrigger && triggerType && triggerType.includes('TAKE_PROFIT')) ||
                              rawOrderType.includes('TAKE_PROFIT') ||
                              orderRole === 'TAKE_PROFIT' ||
                              rawOrderRole === 'TAKE_PROFIT';
                            const isSL = 
                              orderType.includes('STOP_LOSS') || 
                              orderType === 'STOP_LOSS_LIMIT' || 
                              triggerType === 'STOP_LOSS' ||
                              rawOrderType.includes('STOP_LOSS') ||
                              orderRole === 'STOP_LOSS' ||
                              rawOrderRole === 'STOP_LOSS';
                            
                            if (isTP) {
                              tpValue += orderValue;
                            }
                            // Identify SL orders (only explicit STOP_LOSS types)
                            else if (isSL) {
                              slValue += orderValue;
                            }
                            // Note: We no longer try to guess LIMIT orders as TP/SL to avoid double counting
                          });
                          
                          // Use backend values as fallback only if frontend found nothing
                          const coinBase = coinUpper.split('_')[0];
                          const backendOrderValues = tpSlOrderValues[coinBase] || { tp_value_usd: 0, sl_value_usd: 0 };
                          
                          // Use frontend calculation if available, otherwise use backend (don't use MAX to avoid double counting)
                          const finalTpValue = tpValue > 0 ? tpValue : (backendOrderValues.tp_value_usd || 0);
                          const finalSlValue = slValue > 0 ? slValue : (backendOrderValues.sl_value_usd || 0);
                          
                          return {
                            count: buyOrders.length,  // FIX: Only count BUY orders (exclude SL/TP)
                            tpValue: finalTpValue,
                            slValue: finalSlValue
                          };
                        };
                        
                        const filtered = portfolioData.assets.filter(asset => {
                          const available = asset.available_qty ?? 0;
                          const reserved = asset.reserved_qty ?? 0;
                          const balance = asset.balance ?? (available + reserved);
                          const valueUsd = asset.value_usd ?? 0;
                          const hasNonZeroBalance = Number.isFinite(balance) && Math.abs(balance) > 1e-8;
                          const hasNonZeroUsd = Math.abs(valueUsd) > 1e-6;
                          if (!asset?.coin) {
                            // Silently skip assets without coin field (already filtered)
                            return false;
                          }
                          // Only log in debug mode to reduce console noise
                          // console.log(`🔍 Filtering asset ${asset.coin}: balance=${asset.balance}, available_qty=${asset.available_qty}, reserved_qty=${asset.reserved_qty}, hasNonZeroBalance=${hasNonZeroBalance}, value_usd=${asset.value_usd}, hasNonZeroUsd=${hasNonZeroUsd}`);
                          return hasNonZeroBalance || hasNonZeroUsd; // Show assets with any meaningful exposure (long or short)
                        })
                        .filter(asset => asset && asset.coin); // Additional safety filter
                        console.log(`🔍 Filtered to ${filtered.length} assets after filtering (including non-zero and negative positions)`);
                        
                        const _totalPortfolioValue = portfolioData.total_value_usd ?? filtered.reduce((sum, asset) => sum + (asset.value_usd ?? 0), 0);
                        const totalExposureUsd = filtered.reduce((sum, asset) => sum + Math.abs(asset.value_usd ?? 0), 0);
                        
                        return filtered.length > 0 ? filtered
                          .filter(asset => asset && asset.coin) // Ensure coin exists before mapping
                          .sort((a, b) => Math.abs(b.value_usd ?? 0) - Math.abs(a.value_usd ?? 0)) // Sort by absolute USD value descending
                          .map((asset, idx) => {
                            if (!asset || !asset.coin) {
                              return null;
                            }
                            
                            const netValueUsd = asset.value_usd ?? 0;
                            const percentShare = totalExposureUsd > 0 ? (Math.abs(netValueUsd) / totalExposureUsd) * 100 : 0;
                            const percentLabel = `${netValueUsd < 0 ? '-' : ''}${formatNumber(percentShare)}`;
                            // Only log in debug mode to reduce console noise
                            // console.log(`🔍 Rendering asset ${asset.coin}: value_usd=${netValueUsd}, percentShare=${percentLabel}%`);
                            
                            // Get TP/SL order values for this coin
                            const _orderValues = getCoinOrderValues(asset.coin, netValueUsd);
                            
                            // Get open orders info (count, TP value, SL value) for this coin
                            // Find portfolio balance for this asset
                            const assetBalance = portfolioData.assets.find(a => a.coin === asset.coin);
                            const openOrdersInfo = getOpenOrdersInfo(asset.coin, assetBalance);
                            
                            // Cap TP/SL values to the holding value (you can't have orders worth more than you own)
                            const assetValueUsd = Math.abs(netValueUsd);
                            const cappedTpValue = Math.min(openOrdersInfo.tpValue, assetValueUsd);
                            const cappedSlValue = Math.min(openOrdersInfo.slValue, assetValueUsd);
                            const cappedOpenOrdersInfo = {
                              ...openOrdersInfo,
                              tpValue: cappedTpValue,
                              slValue: cappedSlValue
                            };
                            
                            return (
                              <tr key={`${asset.coin}-${idx}`} data-testid={`portfolio-row-${asset.coin}`} className="hover:bg-gray-50 border-b">
                                <td className="px-4 py-3 font-medium">{normalizeSymbol(asset.coin || '')}</td>
                                <td className="px-4 py-3 text-right">{formatNumber(asset.balance ?? (asset.available_qty + asset.reserved_qty), asset.coin)}</td>
                                <td className="px-4 py-3 text-right">{formatNumber(asset.reserved_qty ?? 0, asset.coin)}</td>
                                <td className={`px-4 py-3 text-right font-semibold ${netValueUsd < 0 ? 'text-red-600' : ''}`}>${formatNumber(netValueUsd)}</td>
                                <td className="px-4 py-3 text-right">{percentLabel}%</td>
                                <td className="px-4 py-3 text-center">
                                  <span className={`px-2 py-1 rounded text-sm font-medium ${
                                    openOrdersInfo.count > 3
                                      ? 'bg-red-100 text-red-800 border border-red-500 font-bold'
                                      : openOrdersInfo.count > 0
                                        ? 'bg-blue-100 text-blue-800 border border-blue-400'
                                        : 'bg-gray-100 text-gray-600 border border-gray-300'
                                  }`} title={openOrdersInfo.count > 3 ? `⚠️ WARNING: ${openOrdersInfo.count} open orders (should be ≤ 3)` : openOrdersInfo.count > 0 ? `${openOrdersInfo.count} open order${openOrdersInfo.count > 1 ? 's' : ''}` : 'No open orders'}>
                                    {openOrdersInfo.count}
                                  </span>
                                </td>
                                <td className="px-4 py-3 text-right">
                                  <span className={`px-2 py-1 rounded text-sm font-medium ${
                                    cappedOpenOrdersInfo.tpValue > 0 && asset.value_usd && Math.abs(cappedOpenOrdersInfo.tpValue - asset.value_usd) / asset.value_usd <= 0.05
                                      ? 'bg-green-100 text-green-800 border border-green-500' 
                                      : cappedOpenOrdersInfo.tpValue > 0
                                        ? 'bg-yellow-100 text-yellow-800 border border-yellow-400'
                                        : 'bg-gray-100 text-gray-600 border border-gray-300'
                                  }`} title={cappedOpenOrdersInfo.tpValue > 0 && asset.value_usd && Math.abs(cappedOpenOrdersInfo.tpValue - asset.value_usd) / asset.value_usd <= 0.05 ? `TP orders cover portfolio value ($${cappedOpenOrdersInfo.tpValue.toFixed(2)} ≈ $${formatNumber(asset.value_usd || 0)})` : cappedOpenOrdersInfo.tpValue > 0 ? `TP orders: $${cappedOpenOrdersInfo.tpValue.toFixed(2)} (portfolio: $${formatNumber(asset.value_usd || 0)})` : 'No TP orders'}>
                                    ${cappedOpenOrdersInfo.tpValue.toFixed(2)}
                                  </span>
                                </td>
                                <td className="px-4 py-3 text-right">
                                  <span className={`px-2 py-1 rounded text-sm font-medium ${
                                    cappedOpenOrdersInfo.slValue > 0 && asset.value_usd && Math.abs(cappedOpenOrdersInfo.slValue - asset.value_usd) / asset.value_usd <= 0.05
                                      ? 'bg-green-100 text-green-800 border border-green-500' 
                                      : cappedOpenOrdersInfo.slValue > 0
                                        ? 'bg-yellow-100 text-yellow-800 border border-yellow-400'
                                        : 'bg-gray-100 text-gray-600 border border-gray-300'
                                  }`} title={cappedOpenOrdersInfo.slValue > 0 && asset.value_usd && Math.abs(cappedOpenOrdersInfo.slValue - asset.value_usd) / asset.value_usd <= 0.05 ? `SL orders cover portfolio value ($${cappedOpenOrdersInfo.slValue.toFixed(2)} ≈ $${formatNumber(asset.value_usd || 0)})` : cappedOpenOrdersInfo.slValue > 0 ? `SL orders: $${cappedOpenOrdersInfo.slValue.toFixed(2)} (portfolio: $${formatNumber(asset.value_usd || 0)})` : 'No SL orders'}>
                                    ${cappedOpenOrdersInfo.slValue.toFixed(2)}
                                  </span>
                                </td>
                              </tr>
                            );
                          }) : (
                            <tr>
                              <td colSpan={8} className="px-4 py-6 text-center text-gray-500">
                                No portfolio assets found.
                              </td>
                            </tr>
                          );
                      })()
                    ) : (
                      <tr>
                        <td colSpan={8} className="px-4 py-6 text-center text-gray-500">
                          {portfolioError ?? 'No portfolio data available. Please wait for data to load or check backend connection.'}
                        </td>
                      </tr>
                    )}
                    {/* TP/SL Protection Summary Row */}
                    {(() => {
                      // Calculate counts: coins with TP and SL orders that cover portfolio value
                      // Use realBalances if available, otherwise use portfolio.assets
                      const portfolioCoins = realBalances.length > 0
                        ? realBalances.map(b => ({
                            coin: (b.asset || '').toUpperCase(),
                            valueUsd: b.usd_value ?? b.market_value ?? 0
                          })).filter(b => b.coin) // Filter out empty coins
                        : (portfolio?.assets?.filter(a => a && a.coin).map(a => ({
                            coin: (a.coin || '').toUpperCase(),
                            valueUsd: a.value_usd ?? 0
                          })) || []);
                      const totalPortfolioCoins = portfolioCoins.length;
                      
                      // Debug: TP/SL Summary Row (silenced to reduce console noise)
                      
                      if (totalPortfolioCoins === 0) {
                        // Silently skip summary row if no portfolio coins (normal during initial load)
                        return null; // Don't show if no portfolio coins
                      }
                      
                      // Count coins with TP and SL orders that cover portfolio value
                      let coinsWithTPCovered = 0;
                      let coinsWithSLCovered = 0;
                      const tolerance = 0.05; // 5% tolerance
                      
                      portfolioCoins.forEach(({ coin, valueUsd }) => {
                        const coinBase = coin.split('_')[0];
                        const orderValues = tpSlOrderValues[coinBase] || { tp_value_usd: 0, sl_value_usd: 0 };
                        const tpValueUsd = orderValues.tp_value_usd || 0;
                        const slValueUsd = orderValues.sl_value_usd || 0;
                        
                        // Check if TP orders cover portfolio value
                        if (tpValueUsd > 0 && valueUsd > 0 && Math.abs(tpValueUsd - valueUsd) / valueUsd <= tolerance) {
                          coinsWithTPCovered++;
                        }
                        
                        // Check if SL orders cover portfolio value
                        if (slValueUsd > 0 && valueUsd > 0 && Math.abs(slValueUsd - valueUsd) / valueUsd <= tolerance) {
                          coinsWithSLCovered++;
                        }
                      });
                      
                      const allCoinsHaveTPCovered = coinsWithTPCovered === totalPortfolioCoins;
                      const allCoinsHaveSLCovered = coinsWithSLCovered === totalPortfolioCoins;
                      
                      // Debug: TP/SL Summary calculated (silenced to reduce console noise)
                      
                      return (
                        <tr className="bg-gray-100 dark:bg-gray-800 border-t-2 border-gray-300 font-semibold">
                          <td className="px-4 py-3 text-left">Protection Status</td>
                          <td className="px-4 py-3 text-right" colSpan={2}>
                            <span className={`px-3 py-1 rounded-full text-sm ${
                              allCoinsHaveTPCovered 
                                ? 'bg-green-100 text-green-800 border border-green-300' 
                                : 'bg-yellow-100 text-yellow-800 border border-yellow-300'
                            }`}>
                              TP: {coinsWithTPCovered}/{totalPortfolioCoins}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right" colSpan={2}>
                            <span className={`px-3 py-1 rounded-full text-sm ${
                              allCoinsHaveSLCovered 
                                ? 'bg-green-100 text-green-800 border border-green-300' 
                                : 'bg-yellow-100 text-yellow-800 border border-yellow-300'
                            }`}>
                              SL: {coinsWithSLCovered}/{totalPortfolioCoins}
                            </span>
                          </td>
                        </tr>
                      );
                    })()}
                  </tbody>
                </Table>
              </div>
            </>
          ) : (
            <div className="text-center py-8 text-gray-500">
              <p>{portfolioError ?? 'No portfolio data available.'}</p>
              <p className="text-sm mt-2">Upload a CSV file via the API to import your assets.</p>
            </div>
          )}
        </div>
      )}

      {/* Watchlist Tab */}
      {activeTab === 'watchlist' && (
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
                    onClick={async () => {
                      if (togglingLiveTrading) return;
                      setTogglingLiveTrading(true);
                      try {
                        const currentEnabled = botStatus.live_trading_enabled ?? false;
                        const result = await toggleLiveTrading(!currentEnabled);
                        if (result.ok) {
                          // Update bot status
                          setBotStatus({
                            ...botStatus,
                            live_trading_enabled: result.live_trading_enabled,
                            mode: result.mode
                          });
                          // Refresh dashboard state
                          const dashboardState = await getDashboardState();
                          if (dashboardState.bot_status) {
                            setBotStatus(dashboardState.bot_status);
                          }
                        }
                      } catch (error) {
                        const errorObj = error as { detail?: string; message?: string };
                        console.error('Failed to toggle LIVE_TRADING:', error);
                        const errorMessage = errorObj?.detail || errorObj?.message || 'Unknown error occurred';
                        alert(`Failed to toggle LIVE_TRADING: ${errorMessage}\n\nPlease check:\n1. Database connection is working\n2. TradingSettings table exists\n3. Backend logs for details`);
                      } finally {
                        setTogglingLiveTrading(false);
                      }
                    }}
                    disabled={togglingLiveTrading || isUpdating || topCoinsLoading || portfolioLoading}
                    className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
                      botStatus.live_trading_enabled
                        ? 'bg-green-600 text-white hover:bg-green-700'
                        : 'bg-gray-400 text-white hover:bg-gray-500'
                    } ${togglingLiveTrading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                    title={botStatus.live_trading_enabled ? 'Click to disable LIVE trading (switch to DRY RUN)' : 'Click to enable LIVE trading (real orders)'}
                  >
                    {togglingLiveTrading ? '⏳' : botStatus.live_trading_enabled ? '🟢 LIVE' : '🔴 DRY RUN'}
                  </button>
                </>
              )}
              {isUpdating && (
                <div className="flex items-center gap-2 text-sm text-blue-600">
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
                  <span>Updating...</span>
                </div>
              )}
              {fastQueueRateLimited && (
                <div className="flex items-center gap-1 text-xs text-orange-600">
                  <span className="inline-flex h-2 w-2 rounded-full bg-orange-500 animate-pulse" />
                  <span>Rate limited · slowing cadence</span>
                </div>
              )}
              {dataSourceStatus && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-gray-500">Data:</span>
                  {Object.entries(dataSourceStatus).map(([source, status]) => (
                    <span
                      key={source}
                      className={`px-2 py-1 rounded ${
                        status.available 
                          ? 'bg-green-100 text-green-700' 
                          : 'bg-red-100 text-red-700'
                      }`}
                      title={`${source}: ${status.available ? 'Available' : 'Unavailable'} (${status.response_time?.toFixed(2)}s)`}
                    >
                      {source}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setShowSignalConfig(!showSignalConfig)}
                className="bg-purple-600 text-white px-4 py-2 rounded hover:bg-purple-700"
              >
                {showSignalConfig ? 'Close Config' : '⚙️ Signal Config'}
              </button>
              <button
                onClick={() => setShowAddForm(!showAddForm)}
                className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
              >
                {showAddForm ? 'Cancel' : '+ Add Symbol'}
              </button>
            </div>
          </div>

          {topCoinsError && (
            <div className="mb-4 text-sm text-orange-700 bg-orange-50 border border-orange-200 rounded px-3 py-2">
              {topCoins.length > 0 ? (
                <>
                  Refresh failed ({topCoinsError}). Showing cached data
                  {lastTopCoinsFetchAt ? ` from ${formatDateTime(lastTopCoinsFetchAt)}` : ''}. Retrying automatically.
                </>
              ) : (
                <>Unable to load watchlist data ({topCoinsError}). Retrying automatically…</>
              )}
            </div>
          )}

          {showSignalConfig && (
            <div className="bg-purple-50 border-2 border-purple-300 rounded-lg p-6 mb-6">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-xl font-semibold text-purple-900">📊 Strategy Presets Configuration</h3>
                <button
                  onClick={() => {
                    // Load saved config from localStorage on open
                    const saved = localStorage.getItem('strategy_presets_config');
                    if (saved) {
                      try {
                        const parsed = JSON.parse(saved);
                        // Ensure all minPriceChangePct values default to 1.0 if not set
                        const normalized = { ...PRESET_CONFIG };
                        (Object.keys(parsed) as Preset[]).forEach((preset: Preset) => {
                          if (parsed[preset]?.rules) {
                            (Object.keys(parsed[preset].rules) as RiskMode[]).forEach((risk: RiskMode) => {
                              if (parsed[preset].rules[risk]) {
                                normalized[preset] = {
                                  ...normalized[preset],
                                  rules: {
                                    ...normalized[preset].rules,
                                    [risk]: {
                                      ...parsed[preset].rules[risk],
                                      minPriceChangePct: parsed[preset].rules[risk].minPriceChangePct ?? 1.0
                                    }
                                  }
                                };
                              }
                            });
                          }
                        });
                        setPresetsConfig(normalized);
                      } catch (e) {
                        logHandledError(
                          'loadSavedPresetConfigManual',
                          'Failed to parse saved preset config; changes not applied',
                          e
                        );
                      }
                    }
                  }}
                  className="text-sm bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700"
                >
                  📥 Load Saved
                </button>
              </div>

              {/* Preset Tabs */}
              <div className="mb-4 flex flex-wrap gap-2 border-b-2 border-purple-300 pb-2">
                {(['Swing', 'Intraday', 'Scalp'] as Preset[]).map((preset) => (
                  ['Conservative', 'Aggressive'] as RiskMode[]
                ).map((risk) => {
                  const key = `${preset}-${risk}`;
                  const isActive = selectedConfigPreset === preset && selectedConfigRisk === risk;
                  return (
                    <button
                      key={key}
                      onClick={() => {
                        setSelectedConfigPreset(preset);
                        setSelectedConfigRisk(risk);
                        
                        // Load min_price_change_pct from database for coins using this strategy
                        // Find the first coin using this preset/risk combination and load its saved value
                        const matchingCoin = watchlistItems.find(item => {
                          if (!item.symbol) return false;
                          const coinPreset = coinPresets[item.symbol] || 'swing';
                          let coinPresetType: Preset = 'Swing';
                          let coinRiskMode: RiskMode = 'Conservative';
                          
                          if (coinPreset === 'swing' || coinPreset === 'intraday' || coinPreset === 'scalp') {
                            coinPresetType = (coinPreset.charAt(0).toUpperCase() + coinPreset.slice(1)) as Preset;
                            coinRiskMode = 'Conservative';
                          } else if (coinPreset.includes('-conservative')) {
                            const basePreset = coinPreset.replace('-conservative', '');
                            coinPresetType = (basePreset.charAt(0).toUpperCase() + basePreset.slice(1)) as Preset;
                            coinRiskMode = 'Conservative';
                          } else if (coinPreset.includes('-aggressive')) {
                            const basePreset = coinPreset.replace('-aggressive', '');
                            coinPresetType = (basePreset.charAt(0).toUpperCase() + basePreset.slice(1)) as Preset;
                            coinRiskMode = 'Aggressive';
                          }
                          
                          return coinPresetType === preset && coinRiskMode === risk;
                        });
                        
                        // If we found a matching coin with saved min_price_change_pct, load it
                        if (matchingCoin && matchingCoin.min_price_change_pct !== undefined && matchingCoin.min_price_change_pct !== null) {
                          setPresetsConfig(prev => ({
                            ...prev,
                            [preset]: {
                              ...prev[preset],
                              rules: {
                                ...prev[preset].rules,
                                [risk]: {
                                  ...prev[preset].rules[risk],
                                  minPriceChangePct: matchingCoin.min_price_change_pct
                                }
                              }
                            }
                          }));
                        }
                      }}
                      className={`px-4 py-2 rounded font-medium transition-colors ${
                        isActive
                          ? 'bg-purple-600 text-white'
                          : 'bg-purple-100 text-purple-800 hover:bg-purple-200'
                      }`}
                    >
                      {preset} {risk}
                    </button>
                  );
                }))}
              </div>

              {/* Configuration Form for Selected Preset */}
              {(() => {
                const currentRules = presetsConfig[selectedConfigPreset]?.rules[selectedConfigRisk];
                if (!currentRules) return null;

                return (
                  <div className="bg-white rounded-lg p-4 border border-purple-200">
                    <h4 className="text-lg font-semibold mb-4 text-purple-800">
                      {selectedConfigPreset} - {selectedConfigRisk}
                    </h4>

                    <div className="space-y-6">
                      {/* RSI Configuration */}
                      <div>
                        <h5 className="font-semibold mb-3 text-purple-700">📈 RSI Parameters</h5>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div>
                            <label htmlFor="rsi-buy-below" className="block text-sm font-medium mb-2">RSI Buy Below</label>
                            <input
                              id="rsi-buy-below"
                              type="number"
                              placeholder="40"
                              title="RSI Buy Below threshold"
                              value={currentRules.rsi?.buyBelow ?? 40}
                              onChange={(e) => {
                                const value = parseInt(e.target.value) || 40;
                                setPresetsConfig(prev => ({
                                  ...prev,
                                  [selectedConfigPreset]: {
                                    ...prev[selectedConfigPreset],
                                    rules: {
                                      ...(prev[selectedConfigPreset]?.rules || {}),
                                      [selectedConfigRisk]: {
                                        ...(prev[selectedConfigPreset]?.rules?.[selectedConfigRisk] || {}),
                                        rsi: { ...(currentRules?.rsi || {}), buyBelow: value }
                                      }
                                    }
                                  }
                                }));
                              }}
                              className="w-full border border-purple-300 rounded px-3 py-2"
                              min="0"
                              max="100"
                            />
                          </div>
                          <div>
                            <label htmlFor="rsi-sell-above" className="block text-sm font-medium mb-2">RSI Sell Above</label>
                            <input
                              id="rsi-sell-above"
                              type="number"
                              placeholder="70"
                              title="RSI Sell Above threshold"
                              value={currentRules.rsi?.sellAbove ?? 70}
                              onChange={(e) => {
                                const value = parseInt(e.target.value) || 70;
                                setPresetsConfig(prev => ({
                                  ...prev,
                                  [selectedConfigPreset]: {
                                    ...prev[selectedConfigPreset],
                                    rules: {
                                      ...(prev[selectedConfigPreset]?.rules || {}),
                                      [selectedConfigRisk]: {
                                        ...(prev[selectedConfigPreset]?.rules?.[selectedConfigRisk] || {}),
                                        rsi: { ...(currentRules?.rsi || {}), sellAbove: value }
                                      }
                                    }
                                  }
                                }));
                              }}
                              className="w-full border border-purple-300 rounded px-3 py-2"
                              min="0"
                              max="100"
                            />
                          </div>
                        </div>
                      </div>

                      {/* MA Checks */}
                      <div>
                        <h5 className="font-semibold mb-3 text-purple-700">📊 Moving Averages</h5>
                        <div className="space-y-2">
                          {(['ema10', 'ma50', 'ma200'] as const).map((ma) => (
                            <label key={ma} className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={currentRules.maChecks?.[ma] ?? false}
                              onChange={(e) => {
                                setPresetsConfig(prev => ({
                                  ...prev,
                                  [selectedConfigPreset]: {
                                    ...prev[selectedConfigPreset],
                                    rules: {
                                      ...(prev[selectedConfigPreset]?.rules || {}),
                                      [selectedConfigRisk]: {
                                        ...(prev[selectedConfigPreset]?.rules?.[selectedConfigRisk] || {}),
                                        maChecks: {
                                          ...(currentRules?.maChecks || {}),
                                          [ma]: e.target.checked
                                        }
                                      }
                                    }
                                  }
                                }));
                              }}
                              className="w-4 h-4 text-purple-600"
                              title={`Toggle ${ma.toUpperCase()} check`}
                              aria-label={`${ma.toUpperCase()} check`}
                            />
                              <span className="text-sm font-medium">{ma.toUpperCase()}</span>
                            </label>
                          ))}
                        </div>
                      </div>

                      {/* SL/TP Configuration */}
                      <div>
                        <h5 className="font-semibold mb-3 text-purple-700">🛡️ Stop Loss & Take Profit</h5>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div>
                            <label htmlFor="sl-method" className="block text-sm font-medium mb-2">SL Method</label>
                            <select
                              id="sl-method"
                              title="Stop Loss calculation method"
                              value={currentRules.sl?.atrMult !== undefined ? 'atr' : 'pct'}
                              onChange={(e) => {
                                const method = e.target.value;
                                setPresetsConfig(prev => ({
                                  ...prev,
                                  [selectedConfigPreset]: {
                                    ...prev[selectedConfigPreset],
                                    rules: {
                                      ...prev[selectedConfigPreset].rules,
                                      [selectedConfigRisk]: {
                                        ...prev[selectedConfigPreset].rules[selectedConfigRisk],
                                        sl: method === 'atr' 
                                          ? { atrMult: currentRules.sl?.atrMult ?? 1.5 }
                                          : { pct: currentRules.sl?.pct ?? 0.5 }
                                      }
                                    }
                                  }
                                }));
                              }}
                              className="w-full border border-purple-300 rounded px-3 py-2"
                            >
                              <option value="atr">ATR Multiplier</option>
                              <option value="pct">Percentage</option>
                            </select>
                          </div>
                          <div>
                            <label htmlFor="sl-value" className="block text-sm font-medium mb-2">
                              {currentRules.sl?.atrMult !== undefined ? 'ATR Multiplier' : 'Percentage (%)'}
                            </label>
                            <input
                              id="sl-value"
                              type="number"
                              step="0.1"
                              placeholder={currentRules.sl?.atrMult !== undefined ? "1.5" : "0.5"}
                              title={currentRules.sl?.atrMult !== undefined ? "ATR Multiplier value" : "Stop Loss Percentage"}
                              value={currentRules.sl?.atrMult ?? currentRules.sl?.pct ?? 1.5}
                              onChange={(e) => {
                                const value = parseFloat(e.target.value) || 1.5;
                                setPresetsConfig(prev => ({
                                  ...prev,
                                  [selectedConfigPreset]: {
                                    ...prev[selectedConfigPreset],
                                    rules: {
                                      ...prev[selectedConfigPreset].rules,
                                      [selectedConfigRisk]: {
                                        ...prev[selectedConfigPreset].rules[selectedConfigRisk],
                                        sl: currentRules.sl?.atrMult !== undefined
                                          ? { atrMult: value }
                                          : { pct: value }
                                      }
                                    }
                                  }
                                }));
                              }}
                              className="w-full border border-purple-300 rounded px-3 py-2"
                              min="0"
                            />
                          </div>
                          <div>
                            <label htmlFor="tp-method" className="block text-sm font-medium mb-2">TP Method</label>
                            <select
                              id="tp-method"
                              title="Take Profit calculation method"
                              value={currentRules.tp?.rr !== undefined ? 'rr' : 'pct'}
                              onChange={(e) => {
                                const method = e.target.value;
                                setPresetsConfig(prev => ({
                                  ...prev,
                                  [selectedConfigPreset]: {
                                    ...prev[selectedConfigPreset],
                                    rules: {
                                      ...prev[selectedConfigPreset].rules,
                                      [selectedConfigRisk]: {
                                        ...prev[selectedConfigPreset].rules[selectedConfigRisk],
                                        tp: method === 'rr'
                                          ? { rr: currentRules.tp?.rr ?? 1.5 }
                                          : { pct: currentRules.tp?.pct ?? 0.8 }
                                      }
                                    }
                                  }
                                }));
                              }}
                              className="w-full border border-purple-300 rounded px-3 py-2"
                            >
                              <option value="rr">Risk:Reward Ratio</option>
                              <option value="pct">Percentage</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-sm font-medium mb-2">
                              {currentRules.tp?.rr !== undefined ? 'Risk:Reward Ratio' : 'Percentage (%)'}
                            </label>
                            <input
                              id="tp-value"
                              type="number"
                              step="0.1"
                              placeholder={currentRules.tp?.rr !== undefined ? "1.5" : "1.5"}
                              title={currentRules.tp?.rr !== undefined ? "Risk:Reward Ratio value" : "Take Profit Percentage"}
                              value={currentRules.tp?.rr ?? currentRules.tp?.pct ?? 1.5}
                              onChange={(e) => {
                                const value = parseFloat(e.target.value) || 1.5;
                                setPresetsConfig(prev => ({
                                  ...prev,
                                  [selectedConfigPreset]: {
                                    ...prev[selectedConfigPreset],
                                    rules: {
                                      ...prev[selectedConfigPreset].rules,
                                      [selectedConfigRisk]: {
                                        ...prev[selectedConfigPreset].rules[selectedConfigRisk],
                                        tp: currentRules.tp?.rr !== undefined
                                          ? { rr: value }
                                          : { pct: value }
                                      }
                                    }
                                  }
                                }));
                              }}
                              className="w-full border border-purple-300 rounded px-3 py-2"
                              min="0"
                            />
                          </div>
                        </div>
                      </div>

                      {/* Volume Minimum Ratio */}
                      {/* 
                        Volume Requirement select is now fully driven by volumeMinRatio from preset rules.
                        The user's selection persists after reload because:
                        1. Value is read from presetsConfig[presetType].rules[riskMode].volumeMinRatio
                        2. Changes are saved to backend via saveTradingConfig()
                        3. On reload, backend values are merged into presetsConfig at risk-mode level
                        
                        IMPORTANT: 
                        - We convert the selected string value to a number (parseFloat) before saving
                          to avoid string/number mismatches that would prevent the dropdown from showing the correct value.
                        - volumeMinRatio is a number coming from backend strategy_rules.
                        - We must not use `|| 0.5` here, only `?? 0.5`, because 0 is a valid value.
                        - FIX: Added id and name attributes for proper form field association and browser autofill support.
                      */}
                      <div>
                        <h5 className="font-semibold mb-3 text-purple-700">📊 Volume Requirement</h5>
                        <div>
                          {(() => {
                            // Get current volumeMinRatio with proper fallback to PRESET_CONFIG defaults
                            const currentVolumeRatio = currentRules?.volumeMinRatio ?? 
                              PRESET_CONFIG[selectedConfigPreset]?.rules[selectedConfigRisk]?.volumeMinRatio ?? 0.5;
                            
                            // Convert to string for select component (options use string values)
                            // If value doesn't match any option, use the numeric value as string (for custom values)
                            const selectValue = String(currentVolumeRatio);
                            
                            // Generate unique ID for this field (based on preset and risk mode)
                            const fieldId = `volume-min-ratio-${selectedConfigPreset.toLowerCase()}-${selectedConfigRisk.toLowerCase()}`;
                            const fieldName = `volumeMinRatio-${selectedConfigPreset}-${selectedConfigRisk}`;
                            
                            // Define all available options
                            const volumeOptions = [
                              { value: "0.1", label: "0.1x (Muy agresivo - solo 10% del promedio)" },
                              { value: "0.2", label: "0.2x (Muy agresivo - solo 20% del promedio)" },
                              { value: "0.3", label: "0.3x (Agresivo - solo 30% del promedio)" },
                              { value: "0.5", label: "0.5x (Moderado agresivo - 50% del promedio)" },
                              { value: "0.7", label: "0.7x (Moderado - 70% del promedio)" },
                              { value: "1.0", label: "1.0x (Neutro - permite cualquier volumen)" },
                              { value: "1.5", label: "1.5x (Selectivo - requiere 1.5x promedio)" },
                              { value: "2.0", label: "2.0x (Muy selectivo - requiere 2x promedio, recomendado)" },
                            ];
                            
                            // Check if current value matches an option, if not add it as a custom option
                            const hasMatchingOption = volumeOptions.some(opt => parseFloat(opt.value) === currentVolumeRatio);
                            
                            return (
                              <div className="relative z-50">
                                <label 
                                  htmlFor={fieldId}
                                  className="block text-sm font-medium mb-2"
                                >
                                  Minimum Volume Ratio (x promedio)
                                </label>
                                <select
                                  id={fieldId}
                                  name={fieldName}
                                  title="Select minimum volume ratio"
                                  aria-label="Select minimum volume ratio"
                                  value={selectValue}
                                  onChange={(e) => {
                                    // Convert selected string to number before saving to avoid type mismatches
                                    const newRatio = parseFloat(e.target.value);
                                    if (isNaN(newRatio)) {
                                      console.warn('[CONFIG] Invalid volume ratio value:', e.target.value);
                                      return;
                                    }
                                    
                                    // [CONFIG] Log the change with clear prefix
                                    console.log('[CONFIG] Min volume changed:', {
                                      preset: selectedConfigPreset,
                                      risk: selectedConfigRisk,
                                      oldValue: currentVolumeRatio,
                                      newValue: newRatio,
                                      valueType: typeof newRatio
                                    });
                                    setPresetsConfig(prev => {
                                      // FIX: Add null checks to prevent TypeError if PRESET_CONFIG structure is incomplete
                                      const defaultPreset = PRESET_CONFIG[selectedConfigPreset];
                                      if (!defaultPreset) {
                                        console.error(`[CONFIG] Missing preset ${selectedConfigPreset} in PRESET_CONFIG`);
                                        return prev; // Return unchanged if preset doesn't exist
                                      }
                                      const existingPreset = prev[selectedConfigPreset] ?? defaultPreset;
                                      // FIX: Guard against undefined before spreading to prevent TypeError
                                      const existingRules = existingPreset?.rules ?? defaultPreset?.rules ?? {};
                                      const existingRiskRules = existingRules?.[selectedConfigRisk] ?? defaultPreset?.rules?.[selectedConfigRisk] ?? {};
                                      
                                      const updated = {
                                        ...prev,
                                        [selectedConfigPreset]: {
                                          ...existingPreset,
                                          rules: {
                                            ...existingRules,
                                            [selectedConfigRisk]: {
                                              ...existingRiskRules,
                                              volumeMinRatio: newRatio,
                                            },
                                          },
                                        },
                                      };
                                      
                                      // [CONFIG] Verify the value was set correctly
                                      const verifyVol = updated[selectedConfigPreset].rules[selectedConfigRisk].volumeMinRatio;
                                      console.log('[CONFIG] State updated successfully:', {
                                        preset: selectedConfigPreset,
                                        risk: selectedConfigRisk,
                                        volumeMinRatio: verifyVol,
                                        type: typeof verifyVol
                                      });
                                      
                                      return updated;
                                    });
                                  }}
                                  onFocus={() => {
                                    // [CONFIG] Log when dropdown is opened/focused
                                    console.log('[CONFIG] Volume dropdown focused:', {
                                      preset: selectedConfigPreset,
                                      risk: selectedConfigRisk,
                                      currentValue: currentVolumeRatio,
                                      selectValue: selectValue
                                    });
                                  }}
                                  className="w-full border border-purple-300 rounded px-3 py-2 pr-10 bg-white appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-500 z-50"
                                >
                                  {volumeOptions.map(opt => (
                                    <option key={opt.value} value={opt.value}>
                                      {opt.label}
                                    </option>
                                  ))}
                                  {!hasMatchingOption && (
                                    <option value={selectValue}>
                                      {currentVolumeRatio}x (Valor personalizado)
                                    </option>
                                  )}
                                </select>
                                {/* Dropdown arrow indicator */}
                                <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none z-10">
                                  <svg className="w-5 h-5 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                  </svg>
                                </div>
                              </div>
                            );
                          })()}
                          <p className="text-xs text-gray-600 mt-1">
                            {(() => {
                              const volRatio = currentRules?.volumeMinRatio ?? 
                                PRESET_CONFIG[selectedConfigPreset]?.rules[selectedConfigRisk]?.volumeMinRatio ?? 0.5;
                              if (volRatio === 0.1) return 'Permite señales con solo 10% del volumen promedio (extremadamente agresivo)';
                              if (volRatio === 0.2) return 'Permite señales con solo 20% del volumen promedio (muy agresivo)';
                              if (volRatio === 0.3) return 'Permite señales con solo 30% del volumen promedio (agresivo)';
                              if (volRatio === 0.5) return 'Permite señales incluso si el volumen solo es 50% del promedio (súper agresivo)';
                              if (volRatio === 0.7) return 'Requiere al menos 70% del volumen promedio (moderado)';
                              if (volRatio === 1.0) return 'Permite señales con cualquier volumen (menos selectivo)';
                              if (volRatio === 1.5) return 'Solo señales con volumen ≥1.5x promedio (moderadamente selectivo)';
                              if (volRatio === 2.0) return 'Solo señales con volumen ≥2.0x promedio (muy selectivo, requerido para trading activo)';
                              return `Solo señales con volumen ≥${volRatio}x promedio (valor personalizado)`;
                            })()}
                          </p>
                        </div>
                      </div>

                      {/* Minimum Price Change Percentage */}
                      <div>
                        <h5 className="font-semibold mb-3 text-purple-700">💰 Minimum Price Change for Orders/Alerts</h5>
                        <div>
                          <label className="block text-sm font-medium mb-2">Minimum Price Change (%)</label>
                          <input
                            type="number"
                            step="0.1"
                            min="0"
                            placeholder="1.0"
                            title="Minimum price change percentage required before creating a new order or sending an alert"
                            value={currentRules.minPriceChangePct ?? 1.0}
                            onChange={(e) => {
                              const inputValue = e.target.value;
                              // Allow empty input while typing
                              if (inputValue === '') {
                                setPresetsConfig(prev => ({
                                  ...prev,
                                  [selectedConfigPreset]: {
                                    ...prev[selectedConfigPreset],
                                    rules: {
                                      ...prev[selectedConfigPreset].rules,
                                      [selectedConfigRisk]: {
                                        ...prev[selectedConfigPreset].rules[selectedConfigRisk],
                                        minPriceChangePct: undefined
                                      }
                                    }
                                  }
                                }));
                                return;
                              }
                              const value = parseFloat(inputValue);
                              if (!isNaN(value) && value >= 0) {
                                setPresetsConfig(prev => ({
                                  ...prev,
                                  [selectedConfigPreset]: {
                                    ...prev[selectedConfigPreset],
                                    rules: {
                                      ...prev[selectedConfigPreset].rules,
                                      [selectedConfigRisk]: {
                                        ...prev[selectedConfigPreset].rules[selectedConfigRisk],
                                        minPriceChangePct: value
                                      }
                                    }
                                  }
                                }));
                              }
                            }}
                            onBlur={(e) => {
                              // Ensure a valid value on blur
                              const value = parseFloat(e.target.value);
                              if (isNaN(value) || value < 0) {
                                setPresetsConfig(prev => ({
                                  ...prev,
                                  [selectedConfigPreset]: {
                                    ...prev[selectedConfigPreset],
                                    rules: {
                                      ...prev[selectedConfigPreset].rules,
                                      [selectedConfigRisk]: {
                                        ...prev[selectedConfigPreset].rules[selectedConfigRisk],
                                        minPriceChangePct: 1.0
                                      }
                                    }
                                  }
                                }));
                              }
                            }}
                            className="w-full border border-purple-300 rounded px-3 py-2"
                          />
                          <p className="text-xs text-gray-600 mt-1">
                            Minimum price change required before creating a new order or sending an alert. 
                            Lower values = more orders/alerts (more aggressive). Higher values = fewer orders/alerts (more conservative).
                            Default: 1.0%
                          </p>
                        </div>
                      </div>

                      {/* Alert Cooldown Minutes */}
                      <div>
                        <h5 className="font-semibold mb-3 text-purple-700">⏱️ Alert Cooldown</h5>
                        <div>
                          <label className="block text-sm font-medium mb-2">Cooldown Between Alerts (minutes)</label>
                          <input
                            type="number"
                            step="1"
                            min="1"
                            placeholder="5"
                            title="Minimum minutes between same-side alerts (e.g., 5 minutes between BUY alerts)"
                            value={currentRules.alertCooldownMinutes ?? 5}
                            onChange={(e) => {
                              const inputValue = e.target.value;
                              // Allow empty input while typing
                              if (inputValue === '') {
                                setPresetsConfig(prev => ({
                                  ...prev,
                                  [selectedConfigPreset]: {
                                    ...prev[selectedConfigPreset],
                                    rules: {
                                      ...prev[selectedConfigPreset].rules,
                                      [selectedConfigRisk]: {
                                        ...prev[selectedConfigPreset].rules[selectedConfigRisk],
                                        alertCooldownMinutes: undefined
                                      }
                                    }
                                  }
                                }));
                                return;
                              }
                              const value = parseFloat(inputValue);
                              if (!isNaN(value) && value >= 1) {
                                setPresetsConfig(prev => ({
                                  ...prev,
                                  [selectedConfigPreset]: {
                                    ...prev[selectedConfigPreset],
                                    rules: {
                                      ...prev[selectedConfigPreset].rules,
                                      [selectedConfigRisk]: {
                                        ...prev[selectedConfigPreset].rules[selectedConfigRisk],
                                        alertCooldownMinutes: value
                                      }
                                    }
                                  }
                                }));
                              }
                            }}
                            onBlur={(e) => {
                              // Ensure a valid value on blur
                              const value = parseFloat(e.target.value);
                              if (isNaN(value) || value < 1) {
                                setPresetsConfig(prev => ({
                                  ...prev,
                                  [selectedConfigPreset]: {
                                    ...prev[selectedConfigPreset],
                                    rules: {
                                      ...prev[selectedConfigPreset].rules,
                                      [selectedConfigRisk]: {
                                        ...prev[selectedConfigPreset].rules[selectedConfigRisk],
                                        alertCooldownMinutes: 5
                                      }
                                    }
                                  }
                                }));
                              }
                            }}
                            className="w-full border border-purple-300 rounded px-3 py-2"
                          />
                          <p className="text-xs text-gray-600 mt-1">
                            Minimum time in minutes between same-side alerts. Requires BOTH cooldown AND minimum price change to be met before sending a new alert. 
                            Lower values = more frequent alerts (more aggressive). Higher values = fewer alerts (more conservative).
                            Default: 5 minutes
                          </p>
                        </div>
                      </div>

                      {/* Notes */}
                      <div>
                        <h5 className="font-semibold mb-3 text-purple-700">📝 Notes</h5>
                        <textarea
                          value={currentRules.notes?.join('\n') ?? ''}
                          onChange={(e) => {
                            const notes = e.target.value.split('\n').filter(n => n.trim());
                            setPresetsConfig(prev => ({
                              ...prev,
                              [selectedConfigPreset]: {
                                ...prev[selectedConfigPreset],
                                rules: {
                                  ...prev[selectedConfigPreset].rules,
                                  [selectedConfigRisk]: {
                                    ...prev[selectedConfigPreset].rules[selectedConfigRisk],
                                    notes: notes.length > 0 ? notes : undefined
                                  }
                                }
                              }
                            }));
                          }}
                          className="w-full border border-purple-300 rounded px-3 py-2"
                          rows={3}
                          placeholder="One note per line..."
                        />
                      </div>
                    </div>

                    {/* Preset Explanation */}
                    <div className="mt-6 pt-6 border-t border-purple-200">
                      <h5 className="font-semibold mb-4 text-purple-700">📋 How this preset executes trades</h5>
                      
                      {/* BUY conditions */}
                      <div className="mb-4">
                        <h6 className="font-medium text-green-700 mb-2">🟢 Buy will trigger when (all must be met):</h6>
                        <ul className="list-none space-y-1 text-sm text-gray-700 pl-4">
                          <li>• RSI {'<'} {currentRules.rsi?.buyBelow ?? 40}</li>
                          {currentRules.maChecks?.ma50 && currentRules.maChecks?.ema10 && (
                            <li>• MA50 {'>'} EMA10</li>
                          )}
                          {currentRules.maChecks?.ma50 && !currentRules.maChecks?.ema10 && (
                            <li>• Price is above MA50</li>
                          )}
                          {!currentRules.maChecks?.ma50 && currentRules.maChecks?.ema10 && (
                            <li>• Price is above EMA10</li>
                          )}
                          {currentRules.maChecks?.ma200 && <li>• Price is above MA200</li>}
                          {!currentRules.maChecks?.ema10 && !currentRules.maChecks?.ma50 && !currentRules.maChecks?.ma200 && (
                            <li>• No MA checks required</li>
                          )}
                          <li>• Volume ≥ {currentRules.volumeMinRatio ?? 0.5}x average</li>
                          <li>• Then system places a BUY with SL = {(() => {
                            if (currentRules.sl?.atrMult !== undefined) {
                              return `ATR × ${currentRules.sl.atrMult}`;
                            } else if (currentRules.sl?.pct !== undefined) {
                              return `${currentRules.sl.pct}%`;
                            }
                            return 'Not configured';
                          })()} and TP = {(() => {
                            if (currentRules.tp?.rr !== undefined) {
                              return `Risk:Reward ${currentRules.tp.rr}`;
                            } else if (currentRules.tp?.pct !== undefined) {
                              return `${currentRules.tp.pct}%`;
                            }
                            return 'Not configured';
                          })()}</li>
                        </ul>
                      </div>

                      {/* SELL conditions */}
                      <div>
                        <h6 className="font-medium text-red-700 mb-2">
                          🔴 Sell will trigger when {currentRules.maChecks?.ma50 ? '(all must be met):' : '(both must be met):'}
                        </h6>
                        <ul className="list-none space-y-1 text-sm text-gray-700 pl-4">
                          <li>• There is an open position</li>
                          <li>• RSI {'>'} {currentRules.rsi?.sellAbove ?? 70}</li>
                          {currentRules.maChecks?.ma50 && (
                            <li>• MA50 {'<'} EMA10 (difference ≥0.5%)</li>
                          )}
                          <li>• Volume ≥ {currentRules.volumeMinRatio ?? 0.5}x average</li>
                          <li>• Then system places a SELL and updates the sheet</li>
                        </ul>
                      </div>
                    </div>

                    {/* Save Button */}
                    <div className="mt-6 flex gap-2">
                      <button
                        onClick={async () => {
                          try {
                          // Get the current value from presetsConfig state (most up-to-date)
                          const currentPresetConfig = presetsConfig[selectedConfigPreset];
                          const currentRiskRules = currentPresetConfig?.rules[selectedConfigRisk];
                          const minPriceChangePct = (currentRiskRules?.minPriceChangePct !== undefined && currentRiskRules?.minPriceChangePct !== null) 
                            ? currentRiskRules.minPriceChangePct 
                            : 1.0;
                          
                          console.log(`💾 Saving configuration for ${selectedConfigPreset}-${selectedConfigRisk}:`, currentRiskRules);
                          
                          // Disable initial load flag if still active (user is explicitly saving)
                          if (isInitialLoadRef.current) {
                            isInitialLoadRef.current = false;
                            console.log('✅ User save action - disabling initial load flag');
                          }
                          
                          // Save to backend FIRST (source of truth)
                          try {
                            // Convert frontend PresetConfig format to backend TradingConfig format
                            // Use strategy_rules as the canonical format (not presets)
                            const backendConfig = {
                              strategy_rules: {} as Record<string, unknown>
                            } as TradingConfig & { strategy_rules: Record<string, unknown> };
                            
                            // Convert each preset (Swing, Intraday, Scalp) to backend format
                            (Object.keys(presetsConfig) as Preset[]).forEach((presetName) => {
                              const preset = presetsConfig[presetName];
                              if (!preset || !preset.rules) return;
                              
                              // Convert to backend format: lowercase preset name with rules structure
                              const backendPresetKey = presetName.toLowerCase();
                              
                              // [CONFIG] Log volumeMinRatio values before sending
                              Object.entries(preset.rules).forEach(([riskMode, rules]) => {
                                const volRatio = (rules as StrategyRules).volumeMinRatio;
                                console.log('[CONFIG] Preparing to save:', {
                                  preset: presetName,
                                  risk: riskMode,
                                  volumeMinRatio: volRatio,
                                  type: typeof volRatio,
                                  allRules: rules
                                });
                              });
                              
                              // CRITICAL FIX: Include notificationProfile when saving
                              (backendConfig.strategy_rules as Record<string, unknown>)[backendPresetKey] = {
                                notificationProfile: preset.notificationProfile || 
                                  (presetName === 'Swing' ? 'swing' : presetName === 'Intraday' ? 'intraday' : 'scalp'),
                                rules: preset.rules
                              };
                            });
                            
                            // [CONFIG] Log full payload before sending
                            console.log('[CONFIG] Saving config payload:', JSON.stringify(backendConfig.strategy_rules, null, 2));
                            
                            // Save to backend
                            const saveResult = await saveTradingConfig(backendConfig);
                            console.log('[CONFIG] ✅ Configuration saved to backend successfully');
                            console.log('[CONFIG] ✅ Saved config:', JSON.stringify(backendConfig.strategy_rules, null, 2));
                            
                            // Convert saved config from PUT response to frontend PresetConfig format
                            // FIX: Use saveResult.config directly instead of reloading - avoids stale closure and extra network call
                            let savedPresetsConfig: PresetConfig | null = null;
                            
                            // Use config from PUT response if available (most efficient and avoids stale closure)
                            if (saveResult.config?.strategy_rules) {
                              // Verify volumeMinRatio was saved correctly
                              Object.entries(saveResult.config.strategy_rules).forEach(([presetKey, presetData]: [string, unknown]) => {
                                if (presetData && typeof presetData === 'object' && 'rules' in presetData && presetData.rules) {
                                  Object.entries(presetData.rules as Record<string, unknown>).forEach(([riskMode, rules]: [string, unknown]) => {
                                    const volRatio = (rules as StrategyRules)?.volumeMinRatio;
                                    console.log(`[CONFIG] ✅ Verified saved ${presetKey}-${riskMode} volumeMinRatio:`, volRatio);
                                  });
                                }
                              });
                              
                              // Convert backend config to frontend PresetConfig format
                              savedPresetsConfig = {} as PresetConfig;
                              Object.entries(saveResult.config.strategy_rules).forEach(([presetKey, presetData]: [string, unknown]) => {
                                const presetName = presetKey.charAt(0).toUpperCase() + presetKey.slice(1) as Preset;
                                if (presetData && typeof presetData === 'object' && 'rules' in presetData && presetData.rules) {
                                  const rulesCopy: Record<RiskMode, StrategyRules> = {} as Record<RiskMode, StrategyRules>;
                                  Object.entries(presetData.rules as Record<string, unknown>).forEach(([riskMode, rule]: [string, unknown]) => {
                                    if (riskMode === 'Conservative' || riskMode === 'Aggressive') {
                                      const ruleObj = rule as StrategyRules;
                                      rulesCopy[riskMode as RiskMode] = {
                                        ...ruleObj,
                                        maChecks: ruleObj.maChecks ? { ...ruleObj.maChecks } : { ema10: false, ma50: false, ma200: false },
                                        rsi: ruleObj.rsi ? { ...ruleObj.rsi } : { buyBelow: 40, sellAbove: 70 },
                                        sl: ruleObj.sl ? { ...ruleObj.sl } : {},
                                        tp: ruleObj.tp ? { ...ruleObj.tp } : {},
                                      };
                                    }
                                  });
                                  savedPresetsConfig![presetName] = {
                                    notificationProfile: ((presetData as { notificationProfile?: 'swing' | 'intraday' | 'scalp' }).notificationProfile) || 
                                      (presetName === 'Swing' ? 'swing' : presetName === 'Intraday' ? 'intraday' : 'scalp'),
                                    rules: rulesCopy
                                  };
                                }
                              });
                            }
                            
                            // Fallback: If PUT response doesn't have config, reload from backend
                            // This should rarely happen, but provides a safety net
                            if (!savedPresetsConfig) {
                              try {
                                console.log('[CONFIG] ⚠️ PUT response missing config, reloading from backend...');
                                const reloadedConfig = await getTradingConfig();
                                if (reloadedConfig?.strategy_rules) {
                                  savedPresetsConfig = {} as PresetConfig;
                                  Object.entries(reloadedConfig.strategy_rules).forEach(([presetKey, presetData]: [string, unknown]) => {
                                    const presetName = presetKey.charAt(0).toUpperCase() + presetKey.slice(1) as Preset;
                                    if (presetData && typeof presetData === 'object' && 'rules' in presetData && presetData.rules) {
                                      const rulesCopy: Record<RiskMode, StrategyRules> = {} as Record<RiskMode, StrategyRules>;
                                      Object.entries(presetData.rules as Record<string, unknown>).forEach(([riskMode, rule]: [string, unknown]) => {
                                        if (riskMode === 'Conservative' || riskMode === 'Aggressive') {
                                          const ruleObj = rule as StrategyRules;
                                          rulesCopy[riskMode as RiskMode] = {
                                            ...ruleObj,
                                            maChecks: ruleObj.maChecks ? { ...ruleObj.maChecks } : { ema10: false, ma50: false, ma200: false },
                                            rsi: ruleObj.rsi ? { ...ruleObj.rsi } : { buyBelow: 40, sellAbove: 70 },
                                            sl: ruleObj.sl ? { ...ruleObj.sl } : {},
                                            tp: ruleObj.tp ? { ...ruleObj.tp } : {},
                                          };
                                        }
                                      });
                                      savedPresetsConfig![presetName] = {
                                        notificationProfile: ((presetData as { notificationProfile?: 'swing' | 'intraday' | 'scalp' }).notificationProfile) || 
                                          (presetName === 'Swing' ? 'swing' : presetName === 'Intraday' ? 'intraday' : 'scalp'),
                                        rules: rulesCopy
                                      };
                                    }
                                  });
                                }
                              } catch (reloadErr) {
                                console.warn('[CONFIG] ⚠️ Failed to reload config after save:', reloadErr);
                              }
                            }
                            
                            // Final attempt: If we still don't have savedPresetsConfig, try fetching directly
                            // This avoids using stale closure variable if all previous attempts failed
                            if (!savedPresetsConfig) {
                              try {
                                console.log('[CONFIG] ⚠️ Both PUT response and reload failed, making final attempt to fetch config...');
                                const finalConfig = await getTradingConfig();
                                if (finalConfig?.strategy_rules) {
                                  savedPresetsConfig = {} as PresetConfig;
                                  Object.entries(finalConfig.strategy_rules).forEach(([presetKey, presetData]: [string, unknown]) => {
                                    const presetName = presetKey.charAt(0).toUpperCase() + presetKey.slice(1) as Preset;
                                    if (presetData && typeof presetData === 'object' && 'rules' in presetData && presetData.rules) {
                                      const rulesCopy: Record<RiskMode, StrategyRules> = {} as Record<RiskMode, StrategyRules>;
                                      Object.entries(presetData.rules as Record<string, unknown>).forEach(([riskMode, rule]: [string, unknown]) => {
                                        if (riskMode === 'Conservative' || riskMode === 'Aggressive') {
                                          const ruleObj = rule as StrategyRules;
                                          rulesCopy[riskMode as RiskMode] = {
                                            ...ruleObj,
                                            maChecks: ruleObj.maChecks ? { ...ruleObj.maChecks } : { ema10: false, ma50: false, ma200: false },
                                            rsi: ruleObj.rsi ? { ...ruleObj.rsi } : { buyBelow: 40, sellAbove: 70 },
                                            sl: ruleObj.sl ? { ...ruleObj.sl } : {},
                                            tp: ruleObj.tp ? { ...ruleObj.tp } : {},
                                          };
                                        }
                                      });
                                      savedPresetsConfig![presetName] = {
                                        notificationProfile: ((presetData as { notificationProfile?: 'swing' | 'intraday' | 'scalp' }).notificationProfile) || 
                                          (presetName === 'Swing' ? 'swing' : presetName === 'Intraday' ? 'intraday' : 'scalp'),
                                        rules: rulesCopy
                                      };
                                    }
                                  });
                                  console.log('[CONFIG] ✅ Final fetch attempt succeeded');
                                }
                              } catch (finalErr) {
                                console.warn('[CONFIG] ⚠️ Final fetch attempt also failed:', finalErr);
                              }
                            }
                            
                            // Update presetsConfig with saved values to ensure UI matches backend
                            // Note: fetchTradingConfig() updates React state but doesn't return the config
                            // We've already fetched the config above for localStorage, so this is just for UI update
                            await fetchTradingConfig();
                            
                            // Update localStorage with the saved config (source of truth from backend)
                            // FIX: Use savedPresetsConfig from PUT response/reload/final fetch instead of stale presetsConfig closure variable
                            // Only use stale presetsConfig as absolute last resort if all fetch attempts failed
                            if (savedPresetsConfig) {
                              localStorage.setItem('strategy_presets_config', JSON.stringify(savedPresetsConfig));
                              console.log('[CONFIG] ✅ Updated localStorage with saved values (from backend)');
                            } else {
                              // Last resort: use current presetsConfig (may be stale, but better than nothing)
                              // This should rarely happen - only if all 3 fetch attempts (PUT response, reload, final fetch) failed
                              console.warn('[CONFIG] ⚠️ All config fetch attempts failed, using current state (may be stale)');
                              localStorage.setItem('strategy_presets_config', JSON.stringify(presetsConfig));
                              console.log('[CONFIG] ⚠️ Updated localStorage with current state (fallback - may be stale)');
                            }
                          } catch (backendErr) {
                            console.error('⚠️ Failed to save configuration to backend:', backendErr);
                            // Fallback: save to localStorage even if backend save fails
                            // Note: presetsConfig may be stale due to closure, but it's the best we have if backend save failed
                            localStorage.setItem('strategy_presets_config', JSON.stringify(presetsConfig));
                            console.log('⚠️ Saved to localStorage only (backend save failed) - using current state');
                          }
                            
                            // Apply min_price_change_pct to all coins using this strategy
                            const _presetKey = selectedConfigPreset.toLowerCase();
                            const _riskKey = selectedConfigRisk.toLowerCase();
                            
                            // Find all coins using this preset from watchlistItems (source of truth)
                            const coinsToUpdate: string[] = [];
                            
                            // Check watchlistItems for coins using this strategy
                            watchlistItems.forEach(item => {
                              if (!item.symbol) return;
                              
                              // Get preset from coinPresets or default to 'swing'
                              const coinPreset = coinPresets[item.symbol] || 'swing';
                              
                              // Determine preset type
                              let coinPresetType: Preset = 'Swing';
                              if (coinPreset.includes('swing')) {
                                coinPresetType = 'Swing';
                              } else if (coinPreset.includes('intraday')) {
                                coinPresetType = 'Intraday';
                              } else if (coinPreset.includes('scalp')) {
                                coinPresetType = 'Scalp';
                              } else if (coinPreset === 'swing' || coinPreset === 'intraday' || coinPreset === 'scalp') {
                                coinPresetType = (coinPreset.charAt(0).toUpperCase() + coinPreset.slice(1)) as Preset;
                              }
                              
                              // Determine risk mode from coinPreset or sl_tp_mode
                              let coinRiskMode: RiskMode = 'Conservative';
                              if (coinPreset.includes('-aggressive') || coinPreset.includes('-agresiva')) {
                                coinRiskMode = 'Aggressive';
                              } else if (coinPreset.includes('-conservative') || coinPreset.includes('-conservadora')) {
                                coinRiskMode = 'Conservative';
                              } else {
                                // Use sl_tp_mode from watchlist item
                                coinRiskMode = (item.sl_tp_mode === 'aggressive' || item.sl_tp_mode === 'agresiva') ? 'Aggressive' : 'Conservative';
                              }
                              
                              // Check if this coin matches the selected strategy
                              if (coinPresetType === selectedConfigPreset && coinRiskMode === selectedConfigRisk) {
                                coinsToUpdate.push(item.symbol);
                              }
                            });
                            
                            console.log(`📊 Found ${coinsToUpdate.length} coins using ${selectedConfigPreset}-${selectedConfigRisk}:`, coinsToUpdate);
                            
                            // Update all matching coins
                            if (coinsToUpdate.length > 0) {
                              const updatePromises = coinsToUpdate.map(symbol => 
                                saveCoinSettings(symbol, { min_price_change_pct: minPriceChangePct })
                                  .catch(err => {
                                    console.warn(`Failed to update ${symbol}:`, err);
                                    return null; // Continue with other coins even if one fails
                                  })
                              );
                              const results = await Promise.all(updatePromises);
                              const successCount = results.filter(r => r !== null).length;
                              
                              // Refresh watchlist to show updated values
                              const dashboardItems: WatchlistItem[] = await getDashboard();
                              setWatchlistItems(dashboardItems);
                              
                              alert(`✅ Configuration saved for ${selectedConfigPreset} - ${selectedConfigRisk}\n\nApplied to ${successCount}/${coinsToUpdate.length} coin(s): ${coinsToUpdate.slice(0, 5).join(', ')}${coinsToUpdate.length > 5 ? '...' : ''}`);
                            } else {
                              alert(`✅ Configuration saved for ${selectedConfigPreset} - ${selectedConfigRisk}\n\nNo coins currently using this strategy.`);
                            }
                          } catch (err) {
                            console.error('Error saving strategy configuration:', err);
                            alert(`❌ Error saving configuration: ${err}`);
                          }
                        }}
                        className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700"
                      >
                        💾 Save {selectedConfigPreset} {selectedConfigRisk}
                      </button>
                      <button
                        onClick={() => {
                          // Reset to defaults
                          setPresetsConfig(PRESET_CONFIG);
                          alert('🔄 Reset to defaults');
                        }}
                        className="bg-orange-600 text-white px-4 py-2 rounded hover:bg-orange-700"
                      >
                        🔄 Reset to Defaults
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          {showAddForm && (
            <div className="bg-gray-50 border border-gray-300 rounded p-4 mb-6">
              <h3 className="text-lg font-semibold mb-4">Add New Symbol</h3>
              <div className="flex gap-4 items-end">
                <div className="flex-1">
                  <label className="block text-sm font-medium mb-2">Symbol (Crypto.com)</label>
                  <input
                    type="text"
                    placeholder="e.g., BTC_USDT"
                    value={newSymbol}
                    onChange={(e) => setNewSymbol(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        handleAddSymbol();
                      }
                    }}
                    className="border border-gray-300 rounded px-3 py-2 w-full"
                    title="Symbol"
                  />
                </div>
                <button
                  onClick={handleAddSymbol}
                  disabled={loading}
                  className="bg-green-600 text-white px-6 py-2 rounded hover:bg-green-700 disabled:bg-gray-400 h-fit"
                >
                  Add
                </button>
        </div>
    </div>
          )}

          {/* Filter Input */}
          <div className="mb-4">
            <div className="relative">
              <input
                type="text"
                placeholder="🔍 Filter coins by symbol (e.g., BTC, ETH, TON)..."
                value={watchlistFilter}
                onChange={(e) => setWatchlistFilter(e.target.value)}
                className="w-full border-2 border-gray-300 rounded-lg px-4 py-2 pl-10 pr-4 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                title="Filter coins by symbol name"
              />
              <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none">
                <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              {watchlistFilter && (
                <button
                  onClick={() => setWatchlistFilter('')}
                  className="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-400 hover:text-gray-600"
                  title="Clear filter"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
            {watchlistFilter && (
              <div className="mt-2 text-sm text-gray-600">
                Showing {visibleWatchlistCoins.length} of {orderedWatchlistCoins.length} coin{orderedWatchlistCoins.length !== 1 ? 's' : ''}
              </div>
            )}
          </div>

          <Table>
              <thead className="sticky top-0 z-10">
                <tr className="bg-gradient-to-r from-gray-800 to-gray-700 text-white">
                  <th className="px-1 py-3 text-center font-semibold w-8">#</th>
                  <SortableHeader field="symbol" sortState={watchlistSort} setSortState={setWatchlistSort} className="px-2 py-3 text-left font-semibold w-20">Symbol</SortableHeader>
                  <th className="px-1 py-3 text-center font-semibold w-16">Actions</th>
                  <SortableHeader field="last_price" sortState={watchlistSort} setSortState={setWatchlistSort} className="px-2 py-3 text-right font-semibold w-24">Last Price</SortableHeader>
                  <th className="px-2 py-3 text-right font-semibold w-24">Last Updated</th>
                  <th className="px-1 py-3 text-center font-semibold w-20">Preset</th>
                  <th className="px-1 py-3 text-center font-semibold w-14">Trade</th>
                  <SortableHeader field="amount_usd" sortState={watchlistSort} setSortState={setWatchlistSort} className="px-2 py-3 text-right font-semibold w-32 min-w-[120px]">Amount USD</SortableHeader>
                  <th className="px-1 py-3 text-center font-semibold w-16">Margin</th>
                  <th className="px-1 py-3 text-center font-semibold w-16">RISK</th>
                  <SortableHeader field="sl_price" sortState={watchlistSort} setSortState={setWatchlistSort} className="px-2 py-3 text-right font-semibold w-20">SL Price</SortableHeader>
                  <SortableHeader field="tp_price" sortState={watchlistSort} setSortState={setWatchlistSort} className="px-2 py-3 text-right font-semibold w-20">TP Price</SortableHeader>
                  <SortableHeader field="rsi" sortState={watchlistSort} setSortState={setWatchlistSort} className="px-1 py-3 text-center font-semibold w-16">RSI</SortableHeader>
                  <SortableHeader field="atr" sortState={watchlistSort} setSortState={setWatchlistSort} className="px-1 py-3 text-center font-semibold w-16">ATR</SortableHeader>
                  <th className="px-2 py-3 text-right font-semibold w-24">Res Up</th>
                  <th className="px-2 py-3 text-right font-semibold w-24">Res Down</th>
                  <th className="px-2 py-3 text-right font-semibold w-18">MA50</th>
                  <th className="px-2 py-3 text-right font-semibold w-18">MA200</th>
                  <th className="px-2 py-3 text-right font-semibold w-18">EMA10</th>
                  <th className="px-2 py-3 text-right font-semibold w-18">MA10w</th>
                  <th className="px-2 py-3 text-center font-semibold w-20">Volume</th>
                  <th className="px-2 py-3 text-center font-semibold w-24">Signals</th>
                  <th className="px-2 py-3 text-center font-semibold w-20">Actions</th>
                </tr>
              </thead>
              <tbody>
                {topCoinsLoading && topCoins.length === 0 &&
                  Array.from({ length: 6 }).map((_, idx) => (
                    <tr key={`watchlist-skeleton-${idx}`} className="border-b">
                      <td className="px-1 py-3 text-center"><SkeletonBlock className="h-4 w-6 mx-auto" /></td>
                      <td className="px-2 py-3"><SkeletonBlock className="h-4 w-16" /></td>
                      <td className="px-1 py-3 text-center"><SkeletonBlock className="h-4 w-12 mx-auto" /></td>
                      <td className="px-2 py-3 text-right"><SkeletonBlock className="h-4 w-20 ml-auto" /></td>
                      <td className="px-2 py-3 text-right"><SkeletonBlock className="h-4 w-20 ml-auto" /></td>
                      <td className="px-1 py-3 text-center"><SkeletonBlock className="h-4 w-14 mx-auto" /></td>
                      <td className="px-1 py-3 text-center"><SkeletonBlock className="h-4 w-10 mx-auto" /></td>
                      <td className="px-2 py-3 text-right"><SkeletonBlock className="h-4 w-20 ml-auto" /></td>
                      <td className="px-1 py-3 text-center"><SkeletonBlock className="h-4 w-12 mx-auto" /></td>
                      <td className="px-1 py-3 text-center"><SkeletonBlock className="h-4 w-12 mx-auto" /></td>
                      <td className="px-2 py-3 text-right"><SkeletonBlock className="h-4 w-20 ml-auto" /></td>
                      <td className="px-2 py-3 text-right"><SkeletonBlock className="h-4 w-20 ml-auto" /></td>
                      <td className="px-1 py-3 text-center"><SkeletonBlock className="h-4 w-10 mx-auto" /></td>
                      <td className="px-1 py-3 text-center"><SkeletonBlock className="h-4 w-10 mx-auto" /></td>
                      <td className="px-2 py-3 text-right"><SkeletonBlock className="h-4 w-16 ml-auto" /></td>
                      <td className="px-2 py-3 text-right"><SkeletonBlock className="h-4 w-16 ml-auto" /></td>
                      <td className="px-2 py-3 text-right"><SkeletonBlock className="h-4 w-16 ml-auto" /></td>
                      <td className="px-2 py-3 text-right"><SkeletonBlock className="h-4 w-16 ml-auto" /></td>
                      <td className="px-2 py-3 text-right"><SkeletonBlock className="h-4 w-16 ml-auto" /></td>
                      <td className="px-2 py-3 text-center"><SkeletonBlock className="h-4 w-14 mx-auto" /></td>
                      <td className="px-2 py-3 text-center"><SkeletonBlock className="h-4 w-20 mx-auto" /></td>
                      <td className="px-2 py-3 text-center"><SkeletonBlock className="h-4 w-20 mx-auto" /></td>
                      <td className="px-2 py-3 text-center"><SkeletonBlock className="h-4 w-16 mx-auto" /></td>
                    </tr>
                  ))}
                {sortedWatchlistData.length > 0 && sortedWatchlistData
                  .filter((coin) => {
                    // Defensive: skip malformed coins that would crash rendering
                    if (!coin || !coin.instrument_name) {
                      console.warn('⚠️ Skipping malformed coin in Watchlist:', coin);
                      return false;
                    }
                    return true;
                  })
                  .map((coin, index) => {
                    const globalIndex = watchlistPositionMap[coin.instrument_name] ?? index;
                    const isFirst = globalIndex <= 0;
                    const isLast = globalIndex >= orderedWatchlistCoins.length - 1;
                    // Calculate master alert status (needed for both signal display and button)
                    const watchlistItem = watchlistItems.find(item => item.symbol === coin.instrument_name);
                    const storedMasterAlert = coinAlertStatus[normalizeSymbolKey(coin.instrument_name)];
                    const hasAlertEnabled = coin.alert_enabled === true || watchlistItem?.alert_enabled === true;
                    const masterAlertEnabled = storedMasterAlert !== undefined
                      ? storedMasterAlert
                      : Boolean(
                          hasAlertEnabled ||
                          coinBuyAlertStatus[coin.instrument_name] === true ||
                          coinSellAlertStatus[coin.instrument_name] === true
                        );
                    return (
                      <tr
                        key={coin.instrument_name}
                        data-testid={`watchlist-row-${coin.instrument_name}`}
                        className={`hover:bg-gray-50 border-b ${
                    coinTradeStatus[normalizeSymbolKey(coin.instrument_name)] 
                      ? 'bg-green-50 border-l-4 border-l-green-500' 
                      : ''
                        }`}
                      >
                    <td className="px-1 py-3 font-medium text-center w-8">{globalIndex + 1}</td>
                    <td className="px-2 py-3 font-medium w-20">
                      <div className="flex items-center gap-2">
                        <div className="flex flex-col text-xs leading-none text-gray-400">
                          <button
                            type="button"
                            onClick={() => moveCoin(coin.instrument_name, -1)}
                            className="hover:text-gray-700 disabled:opacity-30 disabled:cursor-not-allowed"
                            disabled={isFirst}
                            aria-label={`Mover ${coin.instrument_name} hacia arriba`}
                            title="Mover arriba"
                          >
                            ▲
                          </button>
                          <button
                            type="button"
                            onClick={() => moveCoin(coin.instrument_name, 1)}
                            className="hover:text-gray-700 disabled:opacity-30 disabled:cursor-not-allowed"
                            disabled={isLast}
                            aria-label={`Mover ${coin.instrument_name} hacia abajo`}
                            title="Mover abajo"
                          >
                            ▼
                          </button>
                        </div>
                      <a 
                        href={`https://crypto.com/exchange/trade/${coin.instrument_name || ''}`}
            target="_blank"
            rel="noopener noreferrer"
                        className="text-blue-600 hover:text-blue-800 underline"
                        title={`Abrir ${coin.instrument_name} en Crypto.com Exchange (nueva ventana)`}
                      >
                        {normalizeSymbol(coin.instrument_name || '')}
                      </a>
                      </div>
                    </td>
                    <td className="px-1 py-3 text-center w-16">
                      <div className="flex gap-1 justify-center items-center">
                        <button
                          onClick={async () => {
                            const amountUSD = parseFloat(coinAmounts[normalizeSymbolKey(coin.instrument_name)] || '0');
                            if (!amountUSD || amountUSD <= 0) {
                              alert(`Por favor configura el Amount USD para ${coin.instrument_name}`);
                              return;
                            }
                            const useMargin = coinTradeStatus[normalizeSymbolKey(coin.instrument_name) + '_margin'] || false;
                            // Use the current price from the dashboard (should be the latest price)
                            const price = coin.current_price;
                            if (price == null || price <= 0) {
                              alert(`No hay precio disponible para ${coin.instrument_name}`);
                              return;
                            }
                            // Log the price being used for debugging
                            console.log(`📊 Creando orden BUY para ${coin.instrument_name} con precio: $${price} (current_price del dashboard)`);
                            
                            // Calculate quantity
                            let qty = amountUSD / price;
                            if (price >= 100) {
                              qty = Math.round(qty * 10000) / 10000;
                            } else if (price >= 1) {
                              qty = Math.round(qty * 1000000) / 1000000;
                            } else {
                              qty = Math.round(qty * 100000000) / 100000000;
                            }
                            
                            // Show confirmation dialog with order details
                            const marginText = useMargin ? `🚀 On Margin (10x)` : '💰 Spot';
                            const confirmMessage = `🟢 CONFIRMAR ORDEN BUY

📊 Symbol: ${coin.instrument_name}
💰 Amount USD: $${amountUSD.toFixed(2)}
${marginText}
💸 Total: $${amountUSD.toFixed(2)}
📋 Type: MARKET
💡 La orden se ejecutará al precio de mercado actual

¿Confirmar esta orden?`;
                            
                            if (!window.confirm(confirmMessage)) {
                              return;
                            }
                            
                            try {
                              const response = await quickOrder({
                                symbol: coin.instrument_name,
                                side: 'BUY',
                                price: price,
                                amount_usd: amountUSD,
                                use_margin: useMargin
                              });
                              alert(`✅ Orden BUY creada exitosamente!\n\nOrder ID: ${response.order_id}${response.dry_run ? '\n🧪 Modo: DRY RUN' : '\n🔴 Modo: LIVE'}`);
                            } catch (buyError: unknown) {
                              const buyErrorObj = buyError as { detail?: string; message?: string };
                              // Get error message with priority: detail > message > fallback
                              const errorMsg = buyErrorObj.detail || buyErrorObj.message || 'Error desconocido';
                              logHandledError(
                                `quickOrder:buy:${coin.instrument_name}`,
                                `❌ Error creating BUY order for ${coin.instrument_name}`,
                                { error: buyError, price },
                                'error'
                              );
                              alert(`❌ Error creando orden BUY:\n\n${errorMsg}\n\nPrecio usado: $${price.toFixed(4)}`);
                            }
                          }}
                          className="px-2 py-1 text-xs font-semibold bg-green-500 hover:bg-green-600 text-white rounded transition-colors"
                          title={`BUY ${coin.instrument_name} @ $${coin.current_price || 0}`}
                        >
                          BUY
                        </button>
                        <button
                          onClick={async () => {
                            const amountUSD = parseFloat(coinAmounts[normalizeSymbolKey(coin.instrument_name)] || '0');
                            if (!amountUSD || amountUSD <= 0) {
                              alert(`Por favor configura el Amount USD para ${coin.instrument_name}`);
                              return;
                            }
                            const useMargin = coinTradeStatus[normalizeSymbolKey(coin.instrument_name) + '_margin'] || false;
                            // Use the current price from the dashboard (should be the latest price)
                            const price = coin.current_price;
                            if (price == null || price <= 0) {
                              alert(`No hay precio disponible para ${coin.instrument_name}`);
                              return;
                            }
                            // Log the price being used for debugging
                            console.log(`📊 Creando orden SELL para ${coin.instrument_name} con precio: $${price} (current_price del dashboard)`);
                            
                            // Calculate quantity
                            let qty = amountUSD / price;
                            if (price >= 100) {
                              qty = Math.round(qty * 10000) / 10000;
                            } else if (price >= 1) {
                              qty = Math.round(qty * 1000000) / 1000000;
                            } else {
                              qty = Math.round(qty * 100000000) / 100000000;
                            }
                            
                            // Show confirmation dialog with order details
                            const marginText = useMargin ? `🚀 On Margin (10x)` : '💰 Spot';
                            const confirmMessage = `🔴 CONFIRMAR ORDEN SELL

📊 Symbol: ${coin.instrument_name}
💰 Amount USD: $${amountUSD.toFixed(2)}
📦 Quantity: ${qty.toFixed(8)}
${marginText}
💸 Total estimado: $${(price * qty).toFixed(2)}
📋 Type: MARKET
💡 La orden se ejecutará al precio de mercado actual

¿Confirmar esta orden?`;
                            
                            if (!window.confirm(confirmMessage)) {
                              return;
                            }
                            
                            try {
                              const response = await quickOrder({
                                symbol: coin.instrument_name,
                                side: 'SELL',
                                price: price,
                                amount_usd: amountUSD,
                                use_margin: useMargin
                              });
                              alert(`✅ Orden SELL creada exitosamente!\n\nOrder ID: ${response.order_id}${response.dry_run ? '\n🧪 Modo: DRY RUN' : '\n🔴 Modo: LIVE'}`);
                            } catch (sellError: unknown) {
                              const sellErrorObj = sellError as { detail?: string; message?: string };
                              // Get error message with priority: detail > message > fallback
                              const errorMsg = sellErrorObj.detail || sellErrorObj.message || 'Error desconocido';
                              logHandledError(
                                `quickOrder:sell:${coin.instrument_name}`,
                                `❌ Error creating SELL order for ${coin.instrument_name}`,
                                { error: sellError, price },
                                'error'
                              );
                              alert(`❌ Error creando orden SELL:\n\n${errorMsg}\n\nPrecio usado: $${price.toFixed(4)}`);
                            }
                          }}
                          className="px-2 py-1 text-xs font-semibold bg-red-500 hover:bg-red-600 text-white rounded transition-colors"
                          title={`SELL ${coin.instrument_name} @ $${coin.current_price || 0}`}
                        >
                          SELL
                        </button>
                      </div>
                    </td>
                    <td className="px-2 py-3 text-right font-semibold w-24" 
                        title={`Price last updated: ${lastUpdateTimes[coin.instrument_name]?.price ? formatTime(lastUpdateTimes[coin.instrument_name].price) : 'Never'}\nPrice value: ${coin.current_price}`}>
                      ${formatNumber(coin.current_price || 0, coin.instrument_name)}
                    </td>
                    <td className="px-2 py-3 text-right w-24"
                        title={buildLastUpdatedTitle(coin.instrument_name)}>
                      {(() => {
                        const timestamps = lastUpdateTimes[coin.instrument_name];
                        if (!timestamps) return '—';
                        const { price, signals: signalTime } = timestamps;
                        const latest = signalTime && price
                          ? (signalTime > price ? signalTime : price)
                          : (signalTime || price);
                        return formatTimeAgo(latest);
                      })()}
                    </td>
                    <td className="px-1 py-3 text-center relative w-18">
                      <select
                        value={coinPresets[normalizeSymbolKey(coin.instrument_name)] || 'swing'}
                        onChange={(e) => handleCoinPresetChangeWithStrategy(coin.instrument_name, e.target.value)}
                        onMouseEnter={() => setShowPresetTooltip(coin.instrument_name)}
                        onMouseLeave={() => setShowPresetTooltip(null)}
                        className="text-xs border border-gray-300 rounded px-2 py-1 bg-white w-20 relative z-10"
                        title={(() => {
                          const preset = coinPresets[normalizeSymbolKey(coin.instrument_name)] || 'swing';
                          let presetType: Preset;
                          let riskMode: RiskMode;
                          
                          if (preset === 'swing' || preset === 'intraday' || preset === 'scalp') {
                            presetType = (preset.charAt(0).toUpperCase() + preset.slice(1)) as Preset;
                            riskMode = 'Conservative';
                          } else if (preset.includes('-conservative')) {
                            const basePreset = preset.replace('-conservative', '');
                            presetType = (basePreset.charAt(0).toUpperCase() + basePreset.slice(1)) as Preset;
                            riskMode = 'Conservative';
                          } else if (preset.includes('-aggressive')) {
                            const basePreset = preset.replace('-aggressive', '');
                            presetType = (basePreset.charAt(0).toUpperCase() + basePreset.slice(1)) as Preset;
                            riskMode = 'Aggressive';
                          } else {
                            presetType = 'Swing';
                            riskMode = 'Conservative';
                          }
                          
                            const signal = signals[coin?.instrument_name];
                            return buildTooltip(presetType, riskMode, {
                              rsi: signal?.rsi,
                              ema10: signal?.ema10,
                              ma50: signal?.ma50,
                              ma200: signal?.ma200,
                              atr: signal?.atr,
                              currentPrice: coin?.current_price
                            });
                        })()}
                      >
                        <option value="swing-conservative">Swing-Conservative</option>
                        <option value="swing-aggressive">Swing-Aggressive</option>
                        <option value="intraday-conservative">Intraday-Conservative</option>
                        <option value="intraday-aggressive">Intraday-Aggressive</option>
                        <option value="scalp-conservative">Scalp-Conservative</option>
                        <option value="scalp-aggressive">Scalp-Aggressive</option>
                        <option value="custom">Custom</option>
                      </select>
                      {alertSavedMessages[`${coin.instrument_name}_preset`] && (
                        <span className="ml-2 text-xs text-green-600 font-medium animate-[fadeIn_0.2s_ease-in-out_forwards] whitespace-nowrap">
                          ✓ New value saved
                        </span>
                      )}
                      {showPresetTooltip === coin.instrument_name && (
                        <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-2 bg-gray-800 text-white text-xs rounded-lg shadow-lg z-50 whitespace-pre-line max-w-xs">
                          {(() => {
                            const preset = coinPresets[normalizeSymbolKey(coin.instrument_name)] || 'swing';
                            let presetType: Preset;
                            let riskMode: RiskMode;
                            
                            if (preset === 'swing' || preset === 'intraday' || preset === 'scalp') {
                              presetType = (preset.charAt(0).toUpperCase() + preset.slice(1)) as Preset;
                              riskMode = 'Conservative';
                            } else if (preset.includes('-conservative')) {
                              const basePreset = preset.replace('-conservative', '');
                              presetType = (basePreset.charAt(0).toUpperCase() + basePreset.slice(1)) as Preset;
                              riskMode = 'Conservative';
                            } else if (preset.includes('-aggressive')) {
                              const basePreset = preset.replace('-aggressive', '');
                              presetType = (basePreset.charAt(0).toUpperCase() + basePreset.slice(1)) as Preset;
                              riskMode = 'Aggressive';
                            } else {
                              presetType = 'Swing';
                              riskMode = 'Conservative';
                            }
                            
                            const signal = signals[coin?.instrument_name];
                            return buildTooltip(presetType, riskMode, {
                              rsi: signal?.rsi,
                              ema10: signal?.ema10,
                              ma50: signal?.ma50,
                              ma200: signal?.ma200,
                              atr: signal?.atr,
                              currentPrice: coin?.current_price
                            });
                          })()}
                          <div className="absolute top-full left-1/2 transform -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-gray-800"></div>
        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center w-14">
                      <div 
                        data-testid={`trading-toggle-${coin.instrument_name}`}
                        className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium cursor-pointer hover:opacity-80 transition-all w-12 justify-center ${
                          coinTradeStatus[normalizeSymbolKey(coin.instrument_name)]
                            ? 'bg-yellow-400 text-yellow-900 border border-yellow-500 font-bold'
                            : 'bg-gray-100 text-gray-500 border border-gray-300'
                        }`}
                        onClick={async () => {
                          const symbolKey = normalizeSymbolKey(coin.instrument_name);
                          const newValue = !coinTradeStatus[symbolKey];
                          console.log(`🔄 Changing Trade status for ${coin.instrument_name}: ${coinTradeStatus[symbolKey]} -> ${newValue}`);
                          setCoinTradeStatus(prev => {
                            const updated = {
                              ...prev,
                              [coin.instrument_name]: newValue
                            };
                            // Save to localStorage
                            localStorage.setItem('watchlist_trade_status', JSON.stringify(updated));
                            return updated;
                          });
                          const symbol = coin.instrument_name;
                          const messageKey = `${symbol}_trade`;
                          
                          // Save to database
                          try {
                            console.log(`💾 Saving trade_enabled=${newValue} for ${symbol} to database...`);
                            // CRITICAL: Use the backend response to update local state (single source of truth)
                            // This ensures UI matches the canonical row that SignalMonitor reads
                            const result = await saveCoinSettings(symbol, { trade_enabled: newValue });
                            
                            // Update local state from backend response to ensure consistency
                            if (result && typeof result === 'object' && 'trade_enabled' in result) {
                              const backendValue = result.trade_enabled;
                              if (typeof backendValue === 'boolean') {
                                console.log(`✅ Backend confirmed trade_enabled=${backendValue} for ${symbol} (id=${result.id})`);
                                const symbolUpper = symbol.toUpperCase();
                                setCoinTradeStatus(prev => {
                                  const updated = {
                                    ...prev,
                                    [symbolUpper]: backendValue
                                  };
                                  localStorage.setItem('watchlist_trade_status', JSON.stringify(updated));
                                  return updated;
                                });
                              } else {
                                // Fallback: if backendValue is not boolean, keep optimistic update
                                console.log(`✅ Successfully saved trade_enabled=${newValue} for ${symbol}`);
                              }
                            } else {
                              // Fallback: if result doesn't have trade_enabled, keep optimistic update
                              console.log(`✅ Successfully saved trade_enabled=${newValue} for ${symbol}`);
                            }
                            
                            // Show success message
                            setAlertSavedMessages(prev => ({
                              ...prev,
                              [messageKey]: { type: 'success', timestamp: Date.now() }
                            }));
                            
                            // Clear message after 3 seconds
                            if (savedMessageTimersRef.current[messageKey]) {
                              clearTimeout(savedMessageTimersRef.current[messageKey]);
                            }
                            savedMessageTimersRef.current[messageKey] = setTimeout(() => {
                              setAlertSavedMessages(prev => {
                                const { [messageKey]: _removed, ...rest } = prev;
                                return rest;
                              });
                              delete savedMessageTimersRef.current[messageKey];
                            }, 3000);
                            
                            // Log backend message if available
                            if (result && typeof result === 'object' && 'message' in result && result.message) {
                              console.log(`✅ Backend: ${result.message}`);
                            }
                            
                            // CRITICAL: After saving, verify the symbol is still visible
                            // Do NOT trigger a full refresh that might filter it out
                            // The symbol should remain visible regardless of Trade status
                            console.log(`🛡️ Symbol ${symbol} should remain visible in watchlist (Trade=${newValue})`);
                          } catch (err) {
                            console.error(`❌ Failed to save trade_enabled for ${coin.instrument_name}:`, err);
                            // Revert the UI change on error
                            setCoinTradeStatus(prev => {
                              const reverted = {
                                ...prev,
                                [coin.instrument_name]: !newValue
                              };
                              localStorage.setItem('watchlist_trade_status', JSON.stringify(reverted));
                              return reverted;
                            });
                            // Show user-friendly error message with automatic retry
                            const errorMessage = err instanceof Error 
                              ? err.message 
                              : (typeof err === 'string' ? err : 'Unknown error occurred');
                            
                            console.error(`❌ Error saving trade_enabled for ${coin.instrument_name}:`, errorMessage);
                            
                            // Check for specific error types and retry automatically
                            const isRetryableError = errorMessage.includes('502') || 
                                                   errorMessage.includes('Bad Gateway') ||
                                                   errorMessage.includes('timeout') || 
                                                   errorMessage.includes('Timeout') ||
                                                   errorMessage.includes('Failed to fetch') || 
                                                   errorMessage.includes('Network') ||
                                                   errorMessage.includes('503') ||
                                                   errorMessage.includes('500');
                            
                            if (isRetryableError) {
                              // Automatic retry after a short delay
                              console.log(`🔄 Retrying save for ${coin.instrument_name} after 1 second...`);
                              setTimeout(async () => {
                                try {
                                  await saveCoinSettings(coin.instrument_name, { trade_enabled: newValue });
                                  console.log(`✅ Successfully saved trade_enabled=${newValue} for ${coin.instrument_name} (automatic retry)`);
                                  // Update UI to reflect success
                                  setCoinTradeStatus(prev => {
                                    const updated = {
                                      ...prev,
                                      [coin.instrument_name]: newValue
                                    };
                                    localStorage.setItem('watchlist_trade_status', JSON.stringify(updated));
                                    return updated;
                                  });
                                } catch (retryErr) {
                                  console.error(`❌ Automatic retry also failed for ${coin.instrument_name}:`, retryErr);
                                  // Don't show alert - just log the error
                                  // The UI will remain in the reverted state
                                }
                              }, 1000);
                            } else {
                              // For non-retryable errors, just log them
                              console.error(`❌ Non-retryable error for ${symbol}:`, errorMessage);
                              setAlertSavedMessages(prev => ({
                                ...prev,
                                [messageKey]: { type: 'error', timestamp: Date.now() }
                              }));
                            }
                          }
                        }}
                      >
                        {coinTradeStatus[normalizeSymbolKey(coin.instrument_name)] ? <span className="font-bold">YES</span> : 'NO'}
                      </div>
                      {alertSavedMessages[`${coin.instrument_name}_trade`] && (
                        <span className="text-xs text-green-600 font-medium animate-[fadeIn_0.2s_ease-in-out_forwards] whitespace-nowrap">
                          ✓ New value saved
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right w-20">
                      <div className="flex items-center justify-end gap-2">
                        <input
                          type="text"
                          step="0.01"
                          placeholder="$0.00"
                          value={coinAmounts[normalizeSymbolKey(coin.instrument_name)] || ''}
                          onChange={(e) => {
                            const value = e.target.value;
                            const symbolKey = normalizeSymbolKey(coin.instrument_name);
                            setCoinAmounts(prev => ({
                              ...prev,
                              [symbolKey]: value
                            }));
                          }}
                          onBlur={async (e) => {
                          const rawValue = e.target.value.trim();
                          console.log(`Saving Amount USD for ${coin.instrument_name}:`, rawValue);
                          const symbol = coin.instrument_name;
                          const messageKey = `${symbol}_amount`;

                          const clearAmount = async () => {
                            try {
                              const result = await saveCoinSettings(symbol, { trade_amount_usd: null });
                              console.log(`✅ Cleared Amount USD for ${symbol} in backend`);
                              
                              // Update state with backend response
                              if (result && result.symbol) {
                                const symbolUpper = result.symbol.toUpperCase();
                                setCoinAmounts(prev => {
                                  const { [symbolUpper]: _removed, ...rest } = prev;
                                  return rest;
                                });
                                
                                // Update localStorage with backend response
                                const existingAmounts = localStorage.getItem('watchlist_amounts');
                                const existingAmountsObj = existingAmounts ? JSON.parse(existingAmounts) as Record<string, string> : {};
                                const { [symbolUpper]: _removed2, ...cleanedAmounts } = existingAmountsObj;
                                localStorage.setItem('watchlist_amounts', JSON.stringify(cleanedAmounts));
                              }
                              
                              // Show success message
                              setAlertSavedMessages(prev => ({
                                ...prev,
                                [messageKey]: { type: 'success', timestamp: Date.now() }
                              }));
                              
                              // Clear message after 3 seconds
                              if (savedMessageTimersRef.current[messageKey]) {
                                clearTimeout(savedMessageTimersRef.current[messageKey]);
                              }
                              savedMessageTimersRef.current[messageKey] = setTimeout(() => {
                                setAlertSavedMessages(prev => {
                                  const { [messageKey]: _removed, ...rest } = prev;
                                  return rest;
                                });
                                delete savedMessageTimersRef.current[messageKey];
                              }, 3000);
                            } catch (err) {
                              console.warn(`⚠️ Failed to clear Amount USD in backend for ${symbol}:`, err);
                              setAlertSavedMessages(prev => ({
                                ...prev,
                                [messageKey]: { type: 'error', timestamp: Date.now() }
                              }));
                            }
                          };

                          if (rawValue === '') {
                            await clearAmount();
                            return;
                          }

                          const numValue = parseFloat(rawValue);
                          if (!isNaN(numValue) && numValue > 0) {
                            try {
                              // Save to backend first (source of truth)
                              const result = await saveCoinSettings(symbol, { trade_amount_usd: numValue });
                              console.log(`✅ Saved Amount USD=${numValue} for ${symbol} in backend`);
                              
                              // Update state with backend response
                              if (result && result.symbol) {
                                const symbolUpper = result.symbol.toUpperCase();
                                const backendValue = result.trade_amount_usd !== null && result.trade_amount_usd !== undefined
                                  ? result.trade_amount_usd.toString()
                                  : '';
                                
                                // Update state with backend value
                                setCoinAmounts(prev => ({
                                  ...prev,
                                  [symbolUpper]: backendValue
                                }));
                                
                                // Update localStorage with backend value
                                const existingAmounts = localStorage.getItem('watchlist_amounts');
                                const existingAmountsObj = existingAmounts ? JSON.parse(existingAmounts) as Record<string, string> : {};
                                const updatedAmounts = {
                                  ...existingAmountsObj,
                                  [symbolUpper]: backendValue
                                };
                                localStorage.setItem('watchlist_amounts', JSON.stringify(updatedAmounts));
                                
                                // Show success message
                                setAlertSavedMessages(prev => ({
                                  ...prev,
                                  [messageKey]: { type: 'success', timestamp: Date.now() }
                                }));
                                
                                // Clear message after 3 seconds
                                if (savedMessageTimersRef.current[messageKey]) {
                                  clearTimeout(savedMessageTimersRef.current[messageKey]);
                                }
                                savedMessageTimersRef.current[messageKey] = setTimeout(() => {
                                  setAlertSavedMessages(prev => {
                                    const { [messageKey]: _removed, ...rest } = prev;
                                    return rest;
                                  });
                                  delete savedMessageTimersRef.current[messageKey];
                                }, 3000);
                                
                                // Log backend message if available
                                if (result.message) {
                                  console.log(`✅ Backend: ${result.message}`);
                                }
                              }
                            } catch (err) {
                              console.warn(`⚠️ Backend save failed for ${symbol}:`, err);
                              setAlertSavedMessages(prev => ({
                                ...prev,
                                [messageKey]: { type: 'error', timestamp: Date.now() }
                              }));
                            }
                            return;
                          }

                          // Invalid value (non-number or <=0) → reset input and clear backend value
                          console.warn(`⚠️ Invalid Amount USD provided for ${symbol}: "${rawValue}". Clearing value.`);
                          e.target.value = '';
                          await clearAmount();
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.currentTarget.blur();
                          }
                        }}
                        className={`w-full border-2 rounded-lg px-3 py-2 shadow-sm focus:outline-none focus:ring-2 text-right font-medium ${
                          coinTradeStatus[normalizeSymbolKey(coin.instrument_name)] && (!coinAmounts[coin.instrument_name] || coinAmounts[coin.instrument_name] === '')
                            ? 'border-red-500 focus:ring-red-500 bg-red-50 text-red-900'
                            : 'border-blue-300 focus:ring-blue-500 bg-white'
                        }`}
                      />
                        {alertSavedMessages[`${coin.instrument_name}_amount`] && (
                          <span className="text-xs text-green-600 font-medium animate-[fadeIn_0.2s_ease-in-out_forwards] whitespace-nowrap">
                            ✓ New value saved
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-center w-14">
                      <div 
                        className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium cursor-pointer hover:opacity-80 transition-all w-12 justify-center ${
                          coinTradeStatus[normalizeSymbolKey(coin.instrument_name) + '_margin']
                            ? 'bg-yellow-400 text-yellow-900 border border-yellow-500 font-bold'
                            : 'bg-gray-100 text-gray-500 border border-gray-300'
                        }`}
                        onClick={async () => {
                          const newValue = !coinTradeStatus[coin.instrument_name + '_margin'];
                          setCoinTradeStatus(prev => {
                            const updated = {
                              ...prev,
                              [coin.instrument_name + '_margin']: newValue
                            };
                            // Save to localStorage
                            localStorage.setItem('watchlist_trade_status', JSON.stringify(updated));
                            return updated;
                          });
                          // Save to database
                          await saveCoinSettings(coin.instrument_name, { trade_on_margin: newValue });
                        }}
                      >
                        {coinTradeStatus[coin.instrument_name + '_margin'] ? 'YES' : 'NO'}
                      </div>
                      {alertSavedMessages[`${coin.instrument_name}_margin`] && (
                        <span className="text-xs text-green-600 font-medium animate-[fadeIn_0.2s_ease-in-out_forwards] whitespace-nowrap">
                          ✓ New value saved
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center w-16">
                      <div 
                        className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium cursor-pointer hover:opacity-80 transition-all w-14 justify-center ${
                          coinTradeStatus[normalizeSymbolKey(coin.instrument_name) + '_sl_tp']
                            ? 'bg-red-100 text-red-700 border border-red-300'
                            : 'bg-green-100 text-green-700 border border-green-300'
                        }`}
                        onClick={async () => {
                          const symbol = coin.instrument_name;
                          const messageKey = `${symbol}_risk`;
                          const newValue = !coinTradeStatus[symbol + '_sl_tp'];
                          
                          try {
                            // Save to backend first (source of truth)
                            const result = await saveCoinSettings(symbol, { 
                              sl_tp_mode: newValue ? 'aggressive' : 'conservative'
                            });
                            console.log(`✅ Saved RISK=${newValue ? 'aggressive' : 'conservative'} for ${symbol} in backend`);
                            
                            // Update state with backend response
                            if (result && result.symbol) {
                              const symbolUpper = result.symbol.toUpperCase();
                              const backendValue = result.sl_tp_mode === 'aggressive';
                              
                              setCoinTradeStatus(prev => {
                                const updated = {
                                  ...prev,
                                  [symbolUpper + '_sl_tp']: backendValue
                                };
                                // Update localStorage with backend value
                                localStorage.setItem('watchlist_trade_status', JSON.stringify(updated));
                                return updated;
                              });
                              
                              // Update preset to reflect the new risk mode
                              const currentPreset = coinPresets[symbol] || 'swing';
                              let newPreset: string;
                              
                              if (currentPreset === 'swing' || currentPreset === 'intraday' || currentPreset === 'scalp') {
                                newPreset = backendValue ? `${currentPreset}-aggressive` : `${currentPreset}-conservative`;
                              } else if (currentPreset.includes('-conservative')) {
                                newPreset = backendValue ? currentPreset.replace('-conservative', '-aggressive') : currentPreset;
                              } else if (currentPreset.includes('-aggressive')) {
                                newPreset = backendValue ? currentPreset : currentPreset.replace('-aggressive', '-conservative');
                              } else {
                                newPreset = backendValue ? 'swing-aggressive' : 'swing-conservative';
                              }
                              
                              setCoinPresets(prev => ({
                                ...prev,
                                [symbol]: newPreset
                              }));
                              
                              // Recalculate SL/TP values immediately
                              const values = calculateSLTPValues(coin);
                              console.log(`🔄 Recalculating SL/TP for ${symbol} after mode change:`, values);
                              setCalculatedSL(prev => ({ ...prev, [symbol]: values.sl }));
                              setCalculatedTP(prev => ({ ...prev, [symbol]: values.tp }));
                              
                              // Save the recalculated values to the database
                              try {
                                const settingsToSave: Partial<CoinSettings> = {
                                  sl_tp_mode: backendValue ? 'aggressive' : 'conservative'
                                };
                                
                                if (values.sl) {
                                  settingsToSave.sl_price = values.sl;
                                }
                                
                                if (values.tp) {
                                  settingsToSave.tp_price = values.tp;
                                }
                                
                                await saveCoinSettings(symbol, settingsToSave);
                                console.log(`✅ Saved recalculated SL/TP for ${symbol}:`, settingsToSave);
                              } catch (err) {
                                console.warn(`⚠️ Failed to save recalculated SL/TP for ${symbol}:`, err);
                              }
                            }
                            
                            // Show success message
                            setAlertSavedMessages(prev => ({
                              ...prev,
                              [messageKey]: { type: 'success', timestamp: Date.now() }
                            }));
                            
                            // Clear message after 3 seconds
                            if (savedMessageTimersRef.current[messageKey]) {
                              clearTimeout(savedMessageTimersRef.current[messageKey]);
                            }
                            savedMessageTimersRef.current[messageKey] = setTimeout(() => {
                              setAlertSavedMessages(prev => {
                                const { [messageKey]: _removed, ...rest } = prev;
                                return rest;
                              });
                              delete savedMessageTimersRef.current[messageKey];
                            }, 3000);
                            
                            // Log backend message if available
                            if (result.message) {
                              console.log(`✅ Backend: ${result.message}`);
                            }
                          } catch (err) {
                            console.warn(`⚠️ Backend save failed for RISK:`, err);
                            setAlertSavedMessages(prev => ({
                              ...prev,
                              [messageKey]: { type: 'error', timestamp: Date.now() }
                            }));
                          }
                        }}
                        title={(() => {
                          const preset = coinPresets[normalizeSymbolKey(coin.instrument_name)] || 'swing';
                          let presetType: Preset;
                          
                          if (preset === 'swing' || preset === 'intraday' || preset === 'scalp') {
                            presetType = (preset.charAt(0).toUpperCase() + preset.slice(1)) as Preset;
                          } else if (preset.includes('-conservative') || preset.includes('-aggressive')) {
                            const basePreset = preset.replace('-conservative', '').replace('-aggressive', '');
                            presetType = (basePreset.charAt(0).toUpperCase() + basePreset.slice(1)) as Preset;
                          } else {
                            presetType = 'Swing';
                          }
                          
                          const riskMode = coinTradeStatus[coin?.instrument_name + '_sl_tp'] ? 'Aggressive' : 'Conservative';
                          const signal = signals[coin?.instrument_name];
                          return buildTooltip(presetType, riskMode, {
                            rsi: signal?.rsi,
                            ema10: signal?.ema10,
                            ma50: signal?.ma50,
                            ma200: signal?.ma200,
                            atr: signal?.atr,
                            currentPrice: coin?.current_price
                          });
                        })()}
                      >
                        {coinTradeStatus[coin.instrument_name + '_sl_tp'] ? 'Aggressive' : 'Conservative'}
                      </div>
                      {alertSavedMessages[`${coin.instrument_name}_risk`] && (
                        <span className="text-xs text-green-600 font-medium animate-[fadeIn_0.2s_ease-in-out_forwards] whitespace-nowrap">
                          ✓ New value saved
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right w-20">
                      <input
                        type="text"
                        step="0.01"
                        placeholder={calculatedSL[coin.instrument_name] ? formatNumber(calculatedSL[coin.instrument_name], coin.instrument_name) : "Calculating..."}
                        value={(() => {
                          const isEditing = editingFields[coin.instrument_name]?.sl;
                          const isHovering = showOverrideValues[coin.instrument_name]?.sl;
                          const hasOverride = coinSLPercent[coin.instrument_name] && coinSLPercent[coin.instrument_name] !== '';
                          const calculatedValue = calculatedSL[coin.instrument_name];
                          
                          console.log(`🔍 SL Debug for ${coin.instrument_name}:`, {
                            isEditing,
                            isHovering,
                            hasOverride,
                            overrideValue: coinSLPercent[coin.instrument_name],
                            calculatedValue
                          });
                          
                          // If editing, show the percentage input value
                          if (isEditing) {
                            return coinSLPercent[coin.instrument_name] || '';
                          }
                          // If hovering and has override, show override percentage
                          else if (isHovering && hasOverride) {
                            return coinSLPercent[coin.instrument_name];
                          }
                          // If has override (purple cell), show percentage
                          else if (hasOverride) {
                            return coinSLPercent[coin.instrument_name];
                          }
                          // Otherwise show calculated price
                          else if (calculatedValue !== undefined && calculatedValue > 0) {
                            return formatNumber(calculatedValue, coin.instrument_name);
                          } else {
                            return '';
                          }
                        })()}
                        onFocus={() => {
                          setEditingFields(prev => ({
                            ...prev,
                            [coin.instrument_name]: { ...prev[coin.instrument_name], sl: true }
                          }));
                        }}
                        onChange={(e) => {
                          const value = e.target.value;
                          const symbolKey = normalizeSymbolKey(coin.instrument_name);
                          setCoinSLPercent(prev => ({
                            ...prev,
                            [symbolKey]: value
                          }));
                        }}
                        onMouseEnter={() => {
                          if (coinSLPercent[normalizeSymbolKey(coin.instrument_name)]) {
                            setShowOverrideValues(prev => ({
                              ...prev,
                              [coin.instrument_name]: { ...prev[coin.instrument_name], sl: true }
                            }));
                          }
                        }}
                        onMouseLeave={() => {
                          setShowOverrideValues(prev => ({
                            ...prev,
                            [coin.instrument_name]: { ...prev[coin.instrument_name], sl: false }
                          }));
                        }}
                        onBlur={async (e) => {
                          // First, update editing state
                          setEditingFields(prev => ({
                            ...prev,
                            [coin.instrument_name]: { ...prev[coin.instrument_name], sl: false }
                          }));
                          
                          const symbol = coin.instrument_name;
                          const messageKey = `${symbol}_sl`;
                          const value = e.target.value;
                          const numValue = parseFloat(value);
                          
                          // Handle both valid values and empty values (deletion)
                          if (value === '' || value === '0') {
                            // Field was cleared - save to backend first
                            try {
                              const result = await saveCoinSettings(symbol, { sl_percentage: null });
                              console.log(`✅ Cleared SL% from backend`);
                              
                              // Update state with backend response
                              if (result && result.symbol) {
                                const symbolUpper = result.symbol.toUpperCase();
                                setCoinSLPercent(prev => {
                                  const { [symbolUpper]: _removed, ...rest } = prev;
                                  return rest;
                                });
                                
                                // Update localStorage with backend response
                                const existingSLPercent = localStorage.getItem('watchlist_sl_percent');
                                const existingSLPercentObj = existingSLPercent ? JSON.parse(existingSLPercent) as Record<string, string> : {};
                                const { [symbolUpper]: _removed2, ...cleanedSLPercent } = existingSLPercentObj;
                                localStorage.setItem('watchlist_sl_percent', JSON.stringify(cleanedSLPercent));
                              }
                              
                              // Show success message
                              setAlertSavedMessages(prev => ({
                                ...prev,
                                [messageKey]: { type: 'success', timestamp: Date.now() }
                              }));
                              
                              // Clear message after 3 seconds
                              if (savedMessageTimersRef.current[messageKey]) {
                                clearTimeout(savedMessageTimersRef.current[messageKey]);
                              }
                              savedMessageTimersRef.current[messageKey] = setTimeout(() => {
                                setAlertSavedMessages(prev => {
                                  const { [messageKey]: _removed, ...rest } = prev;
                                  return rest;
                                });
                                delete savedMessageTimersRef.current[messageKey];
                              }, 3000);
                            } catch (err) {
                              console.warn('⚠️ Backend clear failed for SL%', err);
                              setAlertSavedMessages(prev => ({
                                ...prev,
                                [messageKey]: { type: 'error', timestamp: Date.now() }
                              }));
                            }
                          } else if (!isNaN(numValue) && numValue > 0) {
                            // Valid value - save to backend first (source of truth)
                            try {
                              const result = await saveCoinSettings(symbol, { sl_percentage: numValue });
                              console.log(`✅ Saved SL%=${numValue} for ${symbol} in backend`);
                              
                              // Update state with backend response
                              if (result && result.symbol) {
                                const symbolUpper = result.symbol.toUpperCase();
                                const backendValue = result.sl_percentage !== null && result.sl_percentage !== undefined && result.sl_percentage !== 0
                                  ? result.sl_percentage.toString()
                                  : '';
                                
                                // Update state with backend value
                                if (backendValue) {
                                  setCoinSLPercent(prev => ({
                                    ...prev,
                                    [symbolUpper]: backendValue
                                  }));
                                  
                                  // Update localStorage with backend value
                                  const existingSLPercent = localStorage.getItem('watchlist_sl_percent');
                                  const existingSLPercentObj = existingSLPercent ? JSON.parse(existingSLPercent) as Record<string, string> : {};
                                  const updatedSLPercent = {
                                    ...existingSLPercentObj,
                                    [symbolUpper]: backendValue
                                  };
                                  localStorage.setItem('watchlist_sl_percent', JSON.stringify(updatedSLPercent));
                                } else {
                                  // Backend returned null/0 - clear from state
                                  setCoinSLPercent(prev => {
                                    const { [symbolUpper]: _removed, ...rest } = prev;
                                    return rest;
                                  });
                                  
                                  const existingSLPercent = localStorage.getItem('watchlist_sl_percent');
                                  const existingSLPercentObj = existingSLPercent ? JSON.parse(existingSLPercent) as Record<string, string> : {};
                                  const { [symbolUpper]: _removed2, ...cleanedSLPercent } = existingSLPercentObj;
                                  localStorage.setItem('watchlist_sl_percent', JSON.stringify(cleanedSLPercent));
                                }
                              }
                              
                              // Show success message
                              setAlertSavedMessages(prev => ({
                                ...prev,
                                [messageKey]: { type: 'success', timestamp: Date.now() }
                              }));
                              
                              // Clear message after 3 seconds
                              if (savedMessageTimersRef.current[messageKey]) {
                                clearTimeout(savedMessageTimersRef.current[messageKey]);
                              }
                              savedMessageTimersRef.current[messageKey] = setTimeout(() => {
                                setAlertSavedMessages(prev => {
                                  const { [messageKey]: _removed, ...rest } = prev;
                                  return rest;
                                });
                                delete savedMessageTimersRef.current[messageKey];
                              }, 3000);
                              
                              // Log backend message if available
                              if (result.message) {
                                console.log(`✅ Backend: ${result.message}`);
                              }
                            } catch (err) {
                              console.warn('⚠️ Backend save failed for SL%', err);
                              setAlertSavedMessages(prev => ({
                                ...prev,
                                [messageKey]: { type: 'error', timestamp: Date.now() }
                              }));
                            }
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.blur();
                        }}
                        className={`w-32 border-2 rounded px-2 py-1 shadow-sm focus:outline-none focus:ring-2 text-right font-medium ${
                          coinSLPercent[normalizeSymbolKey(coin.instrument_name)] && coinSLPercent[normalizeSymbolKey(coin.instrument_name)] !== ''
                            ? 'border-purple-400 focus:ring-purple-500 bg-purple-50 text-purple-900'
                            : 'border-blue-300 focus:ring-blue-500 bg-blue-50 text-blue-900'
                        }`}
                        title={coinSLPercent[normalizeSymbolKey(coin.instrument_name)] ?
                          `Override: ${coinSLPercent[normalizeSymbolKey(coin.instrument_name)]}% | Price: $${formatNumber(calculatedSL[coin.instrument_name] || 0, coin.instrument_name)}` :
                          `Price: $${formatNumber(calculatedSL[coin.instrument_name] || 0, coin.instrument_name)} (from resistance levels)`
                        }
                      />
                      {coinSLPercent[normalizeSymbolKey(coin.instrument_name)] && coinSLPercent[normalizeSymbolKey(coin.instrument_name)] !== '' ? (
                        <span className="ml-1 text-sm text-purple-600 font-semibold">%</span>
                      ) : (
                        <span className="ml-1 text-sm text-blue-600 font-semibold">$</span>
                      )}
                      {alertSavedMessages[`${coin.instrument_name}_sl`] && (
                        <span className="ml-2 text-xs text-green-600 font-medium animate-[fadeIn_0.2s_ease-in-out_forwards] whitespace-nowrap">
                          ✓ New value saved
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right w-20">
                      <input
                        type="text"
                        step="0.01"
                        placeholder={calculatedTP[coin.instrument_name] ? formatNumber(calculatedTP[coin.instrument_name], coin.instrument_name) : "Calculating..."}
                        value={(() => {
                          const isEditing = editingFields[coin.instrument_name]?.tp;
                          const isHovering = showOverrideValues[coin.instrument_name]?.tp;
                          const hasOverride = coinTPPercent[coin.instrument_name] && coinTPPercent[coin.instrument_name] !== '';
                          const calculatedValue = calculatedTP[coin.instrument_name];
                          
                          console.log(`🔍 TP Debug for ${coin.instrument_name}:`, {
                            isEditing,
                            isHovering,
                            hasOverride,
                            overrideValue: coinTPPercent[coin.instrument_name],
                            calculatedValue
                          });
                          
                          // If editing, show the percentage input value
                          if (isEditing) {
                            return coinTPPercent[coin.instrument_name] || '';
                          }
                          // If hovering and has override, show override percentage
                          else if (isHovering && hasOverride) {
                            return coinTPPercent[coin.instrument_name];
                          }
                          // If has override (purple cell), show percentage
                          else if (hasOverride) {
                            return coinTPPercent[coin.instrument_name];
                          }
                          // Otherwise show calculated price
                          else if (calculatedValue !== undefined && calculatedValue > 0) {
                            return formatNumber(calculatedValue, coin.instrument_name);
                          } else {
                            return '';
                          }
                        })()}
                        onFocus={() => {
                          setEditingFields(prev => ({
                            ...prev,
                            [coin.instrument_name]: { ...prev[coin.instrument_name], tp: true }
                          }));
                        }}
                        onChange={(e) => {
                          const value = e.target.value;
                          const symbolKey = normalizeSymbolKey(coin.instrument_name);
                          setCoinTPPercent(prev => ({
                            ...prev,
                            [symbolKey]: value
                          }));
                        }}
                        onMouseEnter={() => {
                          if (coinTPPercent[normalizeSymbolKey(coin.instrument_name)]) {
                            setShowOverrideValues(prev => ({
                              ...prev,
                              [coin.instrument_name]: { ...prev[coin.instrument_name], tp: true }
                            }));
                          }
                        }}
                        onMouseLeave={() => {
                          setShowOverrideValues(prev => ({
                            ...prev,
                            [coin.instrument_name]: { ...prev[coin.instrument_name], tp: false }
                          }));
                        }}
                        onBlur={async (e) => {
                          // First, update editing state
                          setEditingFields(prev => ({
                            ...prev,
                            [coin.instrument_name]: { ...prev[coin.instrument_name], tp: false }
                          }));
                          
                          const symbol = coin.instrument_name;
                          const messageKey = `${symbol}_tp`;
                          const value = e.target.value;
                          const numValue = parseFloat(value);
                          
                          // Handle both valid values and empty values (deletion)
                          if (value === '' || value === '0') {
                            // Field was cleared - save to backend first
                            try {
                              const result = await saveCoinSettings(symbol, { tp_percentage: null });
                              console.log(`✅ Cleared TP% from backend`);
                              
                              // Update state with backend response
                              if (result && result.symbol) {
                                const symbolUpper = result.symbol.toUpperCase();
                                setCoinTPPercent(prev => {
                                  const { [symbolUpper]: _removed, ...rest } = prev;
                                  return rest;
                                });
                                
                                // Update localStorage with backend response
                                const existingTPPercent = localStorage.getItem('watchlist_tp_percent');
                                const existingTPPercentObj = existingTPPercent ? JSON.parse(existingTPPercent) as Record<string, string> : {};
                                const { [symbolUpper]: _removed2, ...cleanedTPPercent } = existingTPPercentObj;
                                localStorage.setItem('watchlist_tp_percent', JSON.stringify(cleanedTPPercent));
                              }
                              
                              // Show success message
                              setAlertSavedMessages(prev => ({
                                ...prev,
                                [messageKey]: { type: 'success', timestamp: Date.now() }
                              }));
                              
                              // Clear message after 3 seconds
                              if (savedMessageTimersRef.current[messageKey]) {
                                clearTimeout(savedMessageTimersRef.current[messageKey]);
                              }
                              savedMessageTimersRef.current[messageKey] = setTimeout(() => {
                                setAlertSavedMessages(prev => {
                                  const { [messageKey]: _removed, ...rest } = prev;
                                  return rest;
                                });
                                delete savedMessageTimersRef.current[messageKey];
                              }, 3000);
                            } catch (err) {
                              console.warn('⚠️ Backend clear failed for TP%', err);
                              setAlertSavedMessages(prev => ({
                                ...prev,
                                [messageKey]: { type: 'error', timestamp: Date.now() }
                              }));
                            }
                          } else if (!isNaN(numValue) && numValue > 0) {
                            // Valid value - save to backend first (source of truth)
                            try {
                              const result = await saveCoinSettings(symbol, { tp_percentage: numValue });
                              console.log(`✅ Saved TP%=${numValue} for ${symbol} in backend`);
                              
                              // Update state with backend response
                              if (result && result.symbol) {
                                const symbolUpper = result.symbol.toUpperCase();
                                const backendValue = result.tp_percentage !== null && result.tp_percentage !== undefined && result.tp_percentage !== 0
                                  ? result.tp_percentage.toString()
                                  : '';
                                
                                // Update state with backend value
                                if (backendValue) {
                                  setCoinTPPercent(prev => ({
                                    ...prev,
                                    [symbolUpper]: backendValue
                                  }));
                                  
                                  // Update localStorage with backend value
                                  const existingTPPercent = localStorage.getItem('watchlist_tp_percent');
                                  const existingTPPercentObj = existingTPPercent ? JSON.parse(existingTPPercent) as Record<string, string> : {};
                                  const updatedTPPercent = {
                                    ...existingTPPercentObj,
                                    [symbolUpper]: backendValue
                                  };
                                  localStorage.setItem('watchlist_tp_percent', JSON.stringify(updatedTPPercent));
                                } else {
                                  // Backend returned null/0 - clear from state
                                  setCoinTPPercent(prev => {
                                    const { [symbolUpper]: _removed, ...rest } = prev;
                                    return rest;
                                  });
                                  
                                  const existingTPPercent = localStorage.getItem('watchlist_tp_percent');
                                  const existingTPPercentObj = existingTPPercent ? JSON.parse(existingTPPercent) as Record<string, string> : {};
                                  const { [symbolUpper]: _removed2, ...cleanedTPPercent } = existingTPPercentObj;
                                  localStorage.setItem('watchlist_tp_percent', JSON.stringify(cleanedTPPercent));
                                }
                              }
                              
                              // Show success message
                              setAlertSavedMessages(prev => ({
                                ...prev,
                                [messageKey]: { type: 'success', timestamp: Date.now() }
                              }));
                              
                              // Clear message after 3 seconds
                              if (savedMessageTimersRef.current[messageKey]) {
                                clearTimeout(savedMessageTimersRef.current[messageKey]);
                              }
                              savedMessageTimersRef.current[messageKey] = setTimeout(() => {
                                setAlertSavedMessages(prev => {
                                  const { [messageKey]: _removed, ...rest } = prev;
                                  return rest;
                                });
                                delete savedMessageTimersRef.current[messageKey];
                              }, 3000);
                              
                              // Log backend message if available
                              if (result.message) {
                                console.log(`✅ Backend: ${result.message}`);
                              }
                            } catch (err) {
                              console.warn('⚠️ Backend save failed for TP%', err);
                              setAlertSavedMessages(prev => ({
                                ...prev,
                                [messageKey]: { type: 'error', timestamp: Date.now() }
                              }));
                            }
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.blur();
                        }}
                        className={`w-32 border-2 rounded px-2 py-1 shadow-sm focus:outline-none focus:ring-2 text-right font-medium ${
                          coinTPPercent[normalizeSymbolKey(coin.instrument_name)] && coinTPPercent[normalizeSymbolKey(coin.instrument_name)] !== ''
                            ? 'border-purple-400 focus:ring-purple-500 bg-purple-50 text-purple-900'
                            : 'border-blue-300 focus:ring-blue-500 bg-blue-50 text-blue-900'
                        }`}
                        title={coinTPPercent[normalizeSymbolKey(coin.instrument_name)] ?
                          `Override: ${coinTPPercent[normalizeSymbolKey(coin.instrument_name)]}% | Price: $${formatNumber(calculatedTP[coin.instrument_name] || 0, coin.instrument_name)}` :
                          `Price: $${formatNumber(calculatedTP[coin.instrument_name] || 0, coin.instrument_name)} (from resistance levels)`
                        }
                      />
                      {coinTPPercent[normalizeSymbolKey(coin.instrument_name)] && coinTPPercent[normalizeSymbolKey(coin.instrument_name)] !== '' ? (
                        <span className="ml-1 text-sm text-purple-600 font-semibold">%</span>
                      ) : (
                        <span className="ml-1 text-sm text-blue-600 font-semibold">$</span>
                      )}
                      {alertSavedMessages[`${coin.instrument_name}_tp`] && (
                        <span className="ml-2 text-xs text-green-600 font-medium animate-[fadeIn_0.2s_ease-in-out_forwards] whitespace-nowrap">
                          ✓ New value saved
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center w-14" 
                        title={`RSI last updated: ${lastUpdateTimes[coin.instrument_name]?.signals ? formatTime(lastUpdateTimes[coin.instrument_name].signals) : 'Never'}`}>
                      {signals[coin.instrument_name]?.rsi !== undefined ? (
                        <span 
                          className={`font-semibold ${(() => {
                            const rsi = signals[coin.instrument_name]?.rsi || 0;
                            const preset = coinPresets[normalizeSymbolKey(coin.instrument_name)] || 'swing';
                            
                            // Get strategy rules for this preset
                            let presetType: Preset;
                            let riskMode: RiskMode;
                            
                            if (preset === 'swing' || preset === 'intraday' || preset === 'scalp') {
                              // FIX: Capitalize preset to match Preset type ('Swing', 'Intraday', 'Scalp')
                              presetType = (preset.charAt(0).toUpperCase() + preset.slice(1)) as Preset;
                              riskMode = 'Conservative';
                            } else if (preset.includes('-conservative')) {
                              const basePreset = preset.replace('-conservative', '');
                              presetType = (basePreset.charAt(0).toUpperCase() + basePreset.slice(1)) as Preset;
                              riskMode = 'Conservative';
                            } else if (preset.includes('-aggressive')) {
                              const basePreset = preset.replace('-aggressive', '');
                              presetType = (basePreset.charAt(0).toUpperCase() + basePreset.slice(1)) as Preset;
                              riskMode = 'Aggressive';
                            } else {
                              presetType = 'Swing';
                              riskMode = 'Conservative';
                            }
                            
                            // Use presetsConfig (editable) if available, fallback to PRESET_CONFIG (defaults)
    const rules = presetsConfig[presetType]?.rules[riskMode] || PRESET_CONFIG[presetType]?.rules[riskMode];
                            if (!rules?.rsi) {
                              // Fallback to default colors
                              return rsi < 30 ? 'text-red-600 font-bold' : 
                                     rsi > 70 ? 'text-red-600 font-bold' : 
                                     rsi < 40 ? 'text-orange-500 font-semibold' : 
                                     rsi > 60 ? 'text-orange-500 font-semibold' : 
                                     'text-green-600 font-semibold';
                            }
                            
                            const buyBelow = rules.rsi.buyBelow || 40;
                            const sellAbove = rules.rsi.sellAbove || 70;
                            
                            // Green: Buy signal (RSI below buy threshold)
                            if (rsi < buyBelow) return 'text-green-600 font-bold';
                            // Red: Sell signal (RSI above sell threshold)  
                            if (rsi > sellAbove) return 'text-red-600 font-bold';
                            // Orange: Neutral zone
                            return 'text-orange-500 font-semibold';
                          })()}`}
                        >
                          {(signals[coin.instrument_name]?.rsi || 0).toFixed(2)}
                        </span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center w-14"
                        title={`ATR last updated: ${lastUpdateTimes[coin.instrument_name]?.signals ? formatTime(lastUpdateTimes[coin.instrument_name].signals) : 'Never'}`}>
                      {signals[coin.instrument_name]?.atr !== undefined ? (
                        <span className={`font-semibold ${(() => {
                          const atr = signals[coin.instrument_name]?.atr || 0;
                          const price = coin.current_price || 1;
                          const atrPercent = (atr / price) * 100;
                          // ATR bajo (<1%) = verde, ATR medio (1-3%) = naranja, ATR alto (>3%) = rojo
                          if (atrPercent < 1) return 'text-green-600';
                          if (atrPercent <= 3) return 'text-orange-500';
                          return 'text-red-600 font-bold';
                        })()}`}>
                          {formatNumber(signals[coin.instrument_name]?.atr || 0, coin.instrument_name)}
                        </span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right w-24"
                        title={`Resistance up updated: ${lastUpdateTimes[coin.instrument_name]?.signals ? formatTime(lastUpdateTimes[coin.instrument_name].signals) : 'Never'}`}>
                      {signals[coin.instrument_name]?.res_up !== undefined ? (
                        <span
                          className={coin.current_price < (signals[coin.instrument_name]?.res_up || 0)
                            ? palette.text.profitStrong
                            : palette.text.lossStrong}
                        >
                          ${formatNumber(signals[coin.instrument_name]?.res_up || 0, coin.instrument_name)}
                        </span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right w-24"
                        title={`Support down updated: ${lastUpdateTimes[coin.instrument_name]?.signals ? formatTime(lastUpdateTimes[coin.instrument_name].signals) : 'Never'}`}>
                      {signals[coin.instrument_name]?.res_down !== undefined ? (
                        <span
                          className={coin.current_price > (signals[coin.instrument_name]?.res_down || 0)
                            ? palette.text.profitStrong
                            : palette.text.lossStrong}
                        >
                          ${formatNumber(signals[coin.instrument_name]?.res_down || 0, coin.instrument_name)}
                        </span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right w-18">
                      {(() => {
                        const signal = signals[coin?.instrument_name];
                        const { colorClass, tooltip } = getMAColorAndTooltip(coin, 'MA50', signal, coinPresets);
                        const lastUpdate = lastUpdateTimes[coin?.instrument_name]?.signals ? formatTime(lastUpdateTimes[coin.instrument_name].signals) : 'Never';
                        return (signal?.ma50 !== undefined && signal?.ma50 !== null && signal.ma50 > 0) ? (
                          <span
                            className={`${colorClass} font-bold`}
                            title={`${tooltip}\n\nLast updated: ${lastUpdate}`}
                          >
                            ${formatNumber(signal.ma50, coin.instrument_name)}
                          </span>
                        ) : (
                          <span className="text-gray-400" title="MA50 data not available">-</span>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3 text-right w-18">
                      {(() => {
                        const signal = signals[coin.instrument_name];
                        const { colorClass, tooltip } = getMAColorAndTooltip(coin, 'MA200', signal, coinPresets);
                        const lastUpdate = lastUpdateTimes[coin.instrument_name]?.signals?.toLocaleTimeString() || 'Never';
                        return (signal?.ma200 !== undefined && signal?.ma200 !== null && signal.ma200 > 0) ? (
                          <span
                            className={`${colorClass} font-bold`}
                            title={`${tooltip}\n\nLast updated: ${lastUpdate}`}
                          >
                            ${formatNumber(signal.ma200, coin.instrument_name)}
                          </span>
                        ) : (
                          <span className="text-gray-400" title="MA200 data not available">-</span>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3 text-right w-18">
                      {(() => {
                        const signal = signals[coin.instrument_name];
                        const { colorClass, tooltip } = getMAColorAndTooltip(coin, 'EMA10', signal, coinPresets);
                        const lastUpdate = lastUpdateTimes[coin.instrument_name]?.signals?.toLocaleTimeString() || 'Never';
                        return (signal?.ema10 !== undefined && signal?.ema10 !== null && signal.ema10 > 0) ? (
                          <span
                            className={`${colorClass} font-bold`}
                            title={`${tooltip}\n\nLast updated: ${lastUpdate}`}
                          >
                            ${formatNumber(signal.ema10, coin.instrument_name)}
                          </span>
                        ) : (
                          <span className="text-gray-400" title="EMA10 data not available">-</span>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3 text-right w-18">
                      {(() => {
                        const signal = signals[coin.instrument_name];
                        const { colorClass, tooltip } = getMAColorAndTooltip(coin, 'MA10w', signal, coinPresets);
                        const lastUpdate = lastUpdateTimes[coin.instrument_name]?.signals?.toLocaleTimeString() || 'Never';
                        return signal?.ma10w !== undefined ? (
                          <span
                            className={`${colorClass} font-bold`}
                            title={`${tooltip}\n\nLast updated: ${lastUpdate}`}
                          >
                            ${formatNumber(signal.ma10w || 0, coin.instrument_name)}
                          </span>
                        ) : (
                          <span className="text-gray-400" title="MA10w data not available">-</span>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3 text-center w-20" 
                        title={`Volume last updated: ${lastUpdateTimes[coin.instrument_name]?.signals ? formatTime(lastUpdateTimes[coin.instrument_name].signals) : 'Never'}`}>
                      {(() => {
                        const signal = signals[coin.instrument_name];
                        // CANONICAL: Use strategy volume_ratio from coin object (same calculation used by strategy decision)
                        // This ensures Volume column matches the tooltip and strategy evaluation
                        let ratio: number | undefined;
                        let volume: number | undefined;
                        let avgVolume: number | undefined;
                        
                        // Priority 1: Use strategy volume_ratio from coin object (canonical source)
                        // CRITICAL: When volume_ratio is 0.0, use current_volume (even if 0.0), not volume_24h fallback
                        if (coin?.volume_ratio !== undefined && coin.volume_ratio !== null && coin.volume_ratio >= 0) {
                          ratio = coin.volume_ratio;
                          // Use current_volume if available (even if 0.0), only fallback to volume_24h if current_volume is null/undefined
                          volume = coin.current_volume !== undefined && coin.current_volume !== null ? coin.current_volume : (coin.volume_24h || 0);
                          avgVolume = coin.avg_volume;
                        } 
                        // Priority 2: Use volume_ratio from signals (if available and coin doesn't have it)
                        // CRITICAL: When volume_ratio is 0.0, use current_volume (even if 0.0), not volume_24h fallback
                        else if (signal?.volume_ratio !== undefined && signal.volume_ratio !== null && signal.volume_ratio >= 0) {
                          ratio = signal.volume_ratio;
                          // Use current_volume if available (even if 0.0), only fallback to volume_24h if current_volume is null/undefined
                          volume = signal.current_volume !== undefined && signal.current_volume !== null ? signal.current_volume : (signal.volume_24h || 0);
                          avgVolume = signal.avg_volume;
                        } 
                        // Priority 3: Calculate from signal data (current_volume / avg_volume)
                        else if (signal?.current_volume !== undefined && signal?.avg_volume !== undefined && (signal.avg_volume ?? 0) > 0) {
                          volume = signal.current_volume;
                          avgVolume = signal.avg_volume;
                          ratio = volume / avgVolume;
                        } 
                        // Priority 4: Calculate from coin data (current_volume / avg_volume)
                        else if (coin?.current_volume !== undefined && coin?.avg_volume !== undefined && (coin.avg_volume ?? 0) > 0) {
                          volume = coin.current_volume;
                          avgVolume = coin.avg_volume;
                          ratio = volume / avgVolume;
                        } 
                        // Priority 5: Fallback to volume_24h from signal (should not happen)
                        else if (signal?.volume_24h !== undefined && signal?.avg_volume !== undefined && (signal.avg_volume ?? 0) > 0) {
                          volume = signal.volume_24h;
                          avgVolume = signal.avg_volume;
                          ratio = volume / avgVolume;
                        } 
                        // Priority 6: Final fallback to volume_24h from coin (should not happen)
                        else if (coin?.volume_24h !== undefined && coin?.avg_volume !== undefined && (coin.avg_volume ?? 0) > 0) {
                          volume = coin.volume_24h;
                          avgVolume = coin.avg_volume;
                          ratio = volume / avgVolume;
                        }
                        
                        if (ratio !== undefined && ratio >= 0) {
                          return (() => {
                          
                          // Format ratio with adaptive precision:
                          // For ratios < 1.0, show 2 decimals (e.g., 0.05x, 0.12x) for better precision
                          // For ratios >= 1.0, show 1 decimal (e.g., 1.3x, 2.5x)
                          const formattedRatio = ratio < 1.0 ? ratio.toFixed(2) : ratio.toFixed(1);
                          
                          // Get strategy rules for this coin to use dynamic volumeMinRatio
                          const preset = coinPresets[normalizeSymbolKey(coin.instrument_name)] || 'swing';
                          let presetType: Preset;
                          let riskMode: RiskMode;
                          
                          if (preset === 'swing' || preset === 'intraday' || preset === 'scalp') {
                            presetType = preset.charAt(0).toUpperCase() + preset.slice(1) as Preset;
                            riskMode = 'Aggressive';
                          } else {
                            presetType = 'Swing';
                            riskMode = 'Conservative';
                          }
                          
                          // Get volumeMinRatio from strategy rules (default to 0.5 if not set)
                          // NOTE: Must use ?? (nullish coalescing) not || (falsy check) because 0 is a valid value
                          const rules = presetsConfig[presetType]?.rules[riskMode] ?? PRESET_CONFIG[presetType]?.rules[riskMode];
                          const minVolumeRatio = rules?.volumeMinRatio ?? 0.5;
                          
                          // Color coding based on ratio using dynamic threshold:
                          // Red+Bold: ratio >= minVolumeRatio (meets BUY threshold)
                          // Gray: ratio 0.8 to minVolumeRatio (below threshold but not too low)
                          // Red: ratio < 0.8 (low volume, >20% below average)
                          let colorClass = 'text-gray-600';
                          let fontWeight = 'font-semibold';
                          
                          if (ratio >= minVolumeRatio) {
                            // Meets BUY threshold - red and bold
                            colorClass = 'text-red-600';
                            fontWeight = 'font-bold';
                          } else if (ratio >= 0.8) {
                            colorClass = 'text-gray-600';
                            fontWeight = 'font-normal';
                          } else {
                            colorClass = 'text-red-500';
                            fontWeight = 'font-semibold';
                          }                          return (
                            <span 
                              className={`text-sm ${colorClass} ${fontWeight}`}
                              title={volume !== undefined && avgVolume !== undefined 
                                ? (() => {
                                    const periods = coin.volume_avg_periods ?? signal?.volume_avg_periods;
                                    const periodsText = periods && periods > 0 ? `${periods} períodos` : 'promedio';
                                    return `Volume (último período): ${formatNumber(volume, coin.instrument_name)} | Promedio (${periodsText}): ${formatNumber(avgVolume, coin.instrument_name)} | Ratio: ${formattedRatio}x`;
                                  })()
                                : `Volume ratio: ${formattedRatio}x`}
                            >
                              {formattedRatio}x
                            </span>
                          );
                          })();
                        } else {
                          return <span className="text-gray-400" title="Volume data not available">-</span>;
                        }
                      })()}
                    </td>
                    {(() => {
                      return (
                        <>
                          <td className="px-4 py-3 text-center w-24">
                            {(() => {
                              const signalEntry = signals[coin.instrument_name];
                              // Use strategy_state from coin (backend source of truth) or fallback to signalEntry.strategy
                              // Defensive: use safe validation function to prevent crashes
                              const strategyState: StrategyDecision | undefined = 
                                safeGetStrategyDecision(coin.strategy_state) ||
                                safeGetStrategyDecision(signalEntry?.strategy) ||
                                safeGetStrategyDecision(coin.strategy) ||
                                undefined;
                              
                              // Prefer backend-resolved strategy profile to avoid UI/backend mismatches
                              // (e.g., RSI threshold shown for Conservative while backend is evaluating Aggressive).
                              const backendProfile = (coin as unknown as { strategy_profile?: { preset?: string; approach?: string } }).strategy_profile;
                              const preset =
                                backendProfile?.preset && backendProfile?.approach
                                  ? `${backendProfile.preset}-${backendProfile.approach}`
                                  : (coinPresets[normalizeSymbolKey(coin.instrument_name)] || 'swing');
                              let presetType: Preset;
                              let riskMode: RiskMode;
                              
                              // FIX: Parse preset string correctly to extract preset type and risk mode
                              // Handle formats: 'swing', 'swing-aggressive', 'swing-conservative', etc.
                              const validPresets = ['swing', 'intraday', 'scalp'];
                              
                              if (preset.includes('-conservative')) {
                                // Remove all matches and trim trailing hyphens to prevent malformed presets like "swing-"
                                const basePreset = preset.replace(/-conservative/gi, '').replace(/-+$/, '').toLowerCase();
                                // Validate basePreset is not empty and is a valid preset
                                if (basePreset && validPresets.includes(basePreset)) {
                                  presetType = (basePreset.charAt(0).toUpperCase() + basePreset.slice(1)) as Preset;
                                  riskMode = 'Conservative';
                                } else {
                                  // Malformed preset (e.g., "-conservative" without base) - default to Swing
                                  presetType = 'Swing';
                                  riskMode = 'Conservative';
                                }
                              } else if (preset.includes('-aggressive') || preset.includes('-agresiva')) {
                                // Handle both English and Spanish variants
                                // Use global flag to remove all matches, then trim trailing hyphens
                                const basePreset = preset.replace(/-aggressive|-agresiva/gi, '').replace(/-+$/, '').toLowerCase();
                                // Validate basePreset is not empty and is a valid preset
                                if (basePreset && validPresets.includes(basePreset)) {
                                  presetType = (basePreset.charAt(0).toUpperCase() + basePreset.slice(1)) as Preset;
                                  riskMode = 'Aggressive';
                                } else {
                                  // Malformed preset (e.g., "-aggressive" without base) - default to Swing
                                  presetType = 'Swing';
                                  riskMode = 'Aggressive';
                                }
                              } else if (preset === 'swing' || preset === 'intraday' || preset === 'scalp') {
                                // FIX: Capitalize preset to match Preset type ('Swing', 'Intraday', 'Scalp')
                                presetType = (preset.charAt(0).toUpperCase() + preset.slice(1)) as Preset;
                                riskMode = 'Conservative';
                              } else {
                                // Fallback: try to extract base preset and default to Swing
                                const basePreset = preset.split('-')[0].toLowerCase();
                                if (basePreset && validPresets.includes(basePreset)) {
                                  presetType = (basePreset.charAt(0).toUpperCase() + basePreset.slice(1)) as Preset;
                                  riskMode = 'Conservative';
                                } else {
                                  presetType = 'Swing';
                                  riskMode = 'Conservative';
                                }
                              }
                              
                              // FIX: Add fallback to ensure rules is never undefined
                              const rules = presetsConfig[presetType]?.rules?.[riskMode] ?? PRESET_CONFIG[presetType]?.rules?.[riskMode];
                              const rsi = signalEntry?.rsi ?? coin.rsi;
                              const ma50 = signalEntry?.ma50 ?? coin.ma50;
                              const ema10 = signalEntry?.ema10 ?? coin.ema10;
                              const ma200 = signalEntry?.ma200 ?? coin.ma200;
                              const currentPrice = coin.current_price;
                              
                              const strategyReasons =
                                strategyState?.reasons &&
                                typeof strategyState.reasons === 'object' &&
                                !Array.isArray(strategyState.reasons)
                                  ? strategyState.reasons
                                  : {};
                              
                              // CANONICAL: Trust backend decision completely - backend canonical rule ensures
                              // that if all buy_* flags are True, then decision=BUY. Frontend must not override.
                              const backendDecision = strategyState?.decision;
                              const signal: 'BUY' | 'WAIT' | 'SELL' =
                                backendDecision === 'BUY' || backendDecision === 'SELL' || backendDecision === 'WAIT'
                                  ? backendDecision
                                  : 'WAIT';
                              
                              // REMOVED: hasBlockingStrategyReason override - backend canonical rule is source of truth
                              // The backend already ensures decision=BUY when all buy_* flags are True.
                              // Frontend should trust the backend decision completely.
                              
                              // CANONICAL: Use backend index directly (calculated from buy_* flags in backend)
                              // Do not recompute index on frontend - backend is source of truth
                              const strategyIndex = strategyState?.index;
                              const showIndex = typeof strategyIndex === 'number' && strategyIndex !== null;
                              
                              if (process.env.NODE_ENV !== 'production') {
                                console.debug('[WATCHLIST_STRATEGY]', {
                                  symbol: coin.instrument_name,
                                  backendDecision,
                                  normalizedDecision: signal,
                                  reasons: strategyReasons,
                                  strategyIndex,
                                });
                              }
                              
                              const colorClasses = {
                                'BUY': 'bg-green-500 text-white font-bold px-3 py-1 rounded',
                                'SELL': 'bg-red-500 text-white font-bold px-3 py-1 rounded',
                                'WAIT': 'bg-gray-400 text-white font-semibold px-3 py-1 rounded'
                              };
                              
                              const currentVolume = signalEntry?.current_volume ?? coin.current_volume;
                              const avgVolume = signalEntry?.avg_volume ?? coin.avg_volume;
                              // CANONICAL: Use strategy volume_ratio from coin object (same as Volume column)
                              const strategyVolumeRatio = coin.volume_ratio ?? signalEntry?.volume_ratio;
                              // Get volume_avg_periods from coin object (number of periods used for avg_volume)
                              const volumeAvgPeriods = coin.volume_avg_periods ?? signalEntry?.volume_avg_periods ?? null;
                              // CANONICAL: Get min_volume_ratio from backend (Signal Config source of truth)
                              // Note: min_volume_ratio comes from coin object (backend), not from TradingSignals type
                              // FIX: Add optional chaining to prevent TypeError if rules is undefined
                              const backendMinVolumeRatio = (coin as TopCoin & { min_volume_ratio?: number }).min_volume_ratio ?? rules?.volumeMinRatio ?? 0.5;
                              const signalTooltip = buildSignalCriteriaTooltip(
                                presetType,
                                riskMode,
                                rules,
                                rsi,
                                ma50,
                                ema10,
                                ma200,
                                currentPrice,
                                currentVolume,
                                avgVolume,
                                coin.instrument_name,
                                strategyState as StrategyDecision | undefined,
                                strategyVolumeRatio,  // Pass canonical strategy volume_ratio
                                volumeAvgPeriods,  // Pass volume average periods count
                                backendMinVolumeRatio  // CANONICAL: Pass backend configured threshold
                              );
                        
                              const decisionIndexTitle =
                                showIndex && typeof strategyIndex === 'number'
                                  ? buildDecisionIndexTitle(signal, strategyReasons, strategyIndex)
                                  : 'Decision index unavailable (awaiting backend reasons)';
                              const decisionIndexClass =
                                showIndex && typeof strategyIndex === 'number'
                                  ? resolveDecisionIndexColor(strategyIndex)
                                  : 'text-gray-400';

                              return (
                                <div className="flex flex-col items-center gap-1" data-testid={`signal-${coin.instrument_name}`}>
                                  <span 
                                    className={colorClasses[signal]} 
                                    title={signalTooltip}
                                    data-testid={`signal-chip-${coin.instrument_name}`}
                                  >
                                    {signal}
                                  </span>
                                  {showIndex && typeof strategyIndex === 'number' && (
                                    <span
                                      className={`text-xs font-semibold ${decisionIndexClass}`}
                                      title={decisionIndexTitle}
                                      data-testid={`index-${coin.instrument_name}`}
                                    >
                                      INDEX:{strategyIndex.toFixed(0)}%
                                    </span>
                                  )}
                                </div>
                              );
                      })()}
                    </td>
                    <td className="px-4 py-3 text-center w-20">
                      <div className="flex gap-1 justify-center flex-wrap">
                        {(() => {
                          // Recalculate masterAlertEnabled here to ensure it's in scope
                          const watchlistItem = watchlistItems.find(item => item.symbol === coin.instrument_name);
                          const storedMasterAlert = coinAlertStatus[normalizeSymbolKey(coin.instrument_name)];
                          const hasAlertEnabled = coin.alert_enabled === true || watchlistItem?.alert_enabled === true;
                          const masterAlertEnabled = storedMasterAlert !== undefined
                            ? storedMasterAlert
                            : Boolean(
                                hasAlertEnabled ||
                                coinBuyAlertStatus[coin.instrument_name] === true ||
                                coinSellAlertStatus[coin.instrument_name] === true
                              );
                          
                          return (
                            <button
                              data-testid={`alert-master-${coin.instrument_name}`}
                              onClick={() => handleMasterAlertToggle(coin.instrument_name)}
                              className={`px-2 py-1 rounded text-xs font-semibold ${
                                masterAlertEnabled ? 'bg-blue-600 hover:bg-blue-700 text-white' : 'bg-gray-500 hover:bg-gray-600 text-white'
                              }`}
                              title={`Alerts: ${masterAlertEnabled ? 'ENABLED' : 'DISABLED'} (master toggle)`}
                            >
                              ALERTS {masterAlertEnabled ? '✅' : '❌'}
                            </button>
                          );
                        })()}
                        {alertSavedMessages[`${coin.instrument_name}_alerts`] && (
                          <span className="text-xs text-green-600 font-medium ml-1 animate-[fadeIn_0.2s_ease-in-out_forwards]">
                            Saved
                          </span>
                        )}
                        <button
                          data-testid={`alert-buy-${coin.instrument_name}`}
                          onClick={async () => {
                            const symbol = coin.instrument_name;
                            const currentBuyAlertStatus = coinBuyAlertStatus[symbol] || false;
                            const newBuyAlertStatus = !currentBuyAlertStatus;
                            
                            // Optimistically update UI immediately
                            setCoinBuyAlertStatus(prev => {
                              const updated = { ...prev, [symbol]: newBuyAlertStatus };
                              // Save to localStorage immediately for persistence
                              localStorage.setItem('watchlist_buy_alert_status', JSON.stringify(updated));
                              return updated;
                            });
                            
                            try {
                              console.log(`🔄 Attempting to update buy alert status for ${symbol}: ${currentBuyAlertStatus} -> ${newBuyAlertStatus}`);
                              const result = await updateBuyAlert(symbol, newBuyAlertStatus);
                              console.log(`✅ Buy Alert ${newBuyAlertStatus ? 'enabled' : 'disabled'} for ${symbol}:`, result);
                              
                              // Sync state with backend response to ensure frontend and backend are in sync
                              if (result.ok && result.buy_alert_enabled !== undefined) {
                                setCoinBuyAlertStatus(prev => {
                                  const updated = { ...prev, [symbol]: result.buy_alert_enabled };
                                  localStorage.setItem('watchlist_buy_alert_status', JSON.stringify(updated));
                                  return updated;
                                });
                                console.log(`✅ Synced buy_alert_enabled from backend response for ${symbol}: ${result.buy_alert_enabled}`);
                                // Show "Saved" confirmation message
                                const messageKey = `${symbol}_buy`;
                                setAlertSavedMessages(prev => ({
                                  ...prev,
                                  [messageKey]: { type: 'success' as const, timestamp: Date.now() }
                                }));

                                // Auto-hide after 2.5 seconds
                                if (savedMessageTimersRef.current[messageKey]) {
                                  clearTimeout(savedMessageTimersRef.current[messageKey]);
                                }
                                savedMessageTimersRef.current[messageKey] = setTimeout(() => {
                                  setAlertSavedMessages(prev => {
                                    const updated = { ...prev };
                                    delete updated[messageKey];
                                    return updated;
                                  });
                                  delete savedMessageTimersRef.current[messageKey];
                                }, 2500);
                              }
                            } catch (alertError: unknown) {
                              console.error(`❌ Failed to update buy alert status for ${symbol}:`, alertError);
                              // Revert optimistic update on failure
                              setCoinBuyAlertStatus(prev => {
                                const updated = { ...prev, [symbol]: currentBuyAlertStatus };
                                localStorage.setItem('watchlist_buy_alert_status', JSON.stringify(updated));
                                return updated;
                              });
                              
                              const alertErrorObj = alertError as { detail?: string; message?: string };
                              const errorMsg = alertErrorObj.detail || alertErrorObj.message || 'Error desconocido';
                              alert(`Error updating buy alert status: ${errorMsg}`);
                            }
                          }}
                          className={`px-2 py-1 rounded text-xs font-semibold ${
                            coinBuyAlertStatus[coin.instrument_name]
                              ? 'bg-green-600 hover:bg-green-700 text-white'
                              : 'bg-gray-400 hover:bg-gray-500 text-white'
                          }`}
                          title={`Buy Alert: ${coinBuyAlertStatus[coin.instrument_name] ? 'YES' : 'NO'}`}
                        >
                          BUY {coinBuyAlertStatus[coin.instrument_name] ? '✅' : '❌'}
                        </button>
                        <button
                          data-testid={`alert-sell-${coin.instrument_name}`}
                          onClick={async () => {
                            const symbol = coin.instrument_name;
                            const currentSellAlertStatus = coinSellAlertStatus[symbol] || false;
                            const newSellAlertStatus = !currentSellAlertStatus;
                            
                            // Optimistically update UI immediately
                            setCoinSellAlertStatus(prev => {
                              const updated = { ...prev, [symbol]: newSellAlertStatus };
                              // Save to localStorage immediately for persistence
                              localStorage.setItem('watchlist_sell_alert_status', JSON.stringify(updated));
                              return updated;
                            });
                            
                            try {
                              console.log(`🔄 Attempting to update sell alert status for ${symbol}: ${currentSellAlertStatus} -> ${newSellAlertStatus}`);
                              const result = await updateSellAlert(symbol, newSellAlertStatus);
                              console.log(`✅ Sell Alert ${newSellAlertStatus ? 'enabled' : 'disabled'} for ${symbol}:`, result);
                              
                              // Sync state with backend response to ensure frontend and backend are in sync
                              if (result.ok && result.sell_alert_enabled !== undefined) {
                                setCoinSellAlertStatus(prev => {
                                  const updated = { ...prev, [symbol]: result.sell_alert_enabled };
                                  localStorage.setItem('watchlist_sell_alert_status', JSON.stringify(updated));
                                  return updated;
                                });
                                console.log(`✅ Synced sell_alert_enabled from backend response for ${symbol}: ${result.sell_alert_enabled}`);
                                // Show "Saved" confirmation message
                                const messageKey = `${symbol}_sell`;
                                setAlertSavedMessages(prev => ({
                                  ...prev,
                                  [messageKey]: { type: 'success' as const, timestamp: Date.now() }
                                }));

                                // Auto-hide after 2.5 seconds
                                if (savedMessageTimersRef.current[messageKey]) {
                                  clearTimeout(savedMessageTimersRef.current[messageKey]);
                                }
                                savedMessageTimersRef.current[messageKey] = setTimeout(() => {
                                  setAlertSavedMessages(prev => {
                                    const updated = { ...prev };
                                    delete updated[messageKey];
                                    return updated;
                                  });
                                  delete savedMessageTimersRef.current[messageKey];
                                }, 2500);
                              }
                            } catch (alertError: unknown) {
                              console.error(`❌ Failed to update sell alert status for ${symbol}:`, alertError);
                              // Revert optimistic update on failure
                              setCoinSellAlertStatus(prev => {
                                const updated = { ...prev, [symbol]: currentSellAlertStatus };
                                localStorage.setItem('watchlist_sell_alert_status', JSON.stringify(updated));
                                return updated;
                              });
                              
                              const alertErrorObj = alertError as { detail?: string; message?: string };
                              const errorMsg = alertErrorObj.detail || alertErrorObj.message || 'Error desconocido';
                              alert(`Error updating sell alert status: ${errorMsg}`);
                            }
                          }}
                          className={`px-2 py-1 rounded text-xs font-semibold ${
                            coinSellAlertStatus[coin.instrument_name]
                              ? 'bg-red-600 hover:bg-red-700 text-white'
                              : 'bg-gray-400 hover:bg-gray-500 text-white'
                          }`}
                          title={`Sell Alert: ${coinSellAlertStatus[coin.instrument_name] ? 'YES' : 'NO'}`}
                        >
                          SELL {coinSellAlertStatus[coin.instrument_name] ? '✅' : '❌'}
                        </button>
                        {/* Subtle "Saved" confirmation messages */}
                        {alertSavedMessages[`${coin.instrument_name}_buy`] && (
                          <span className="text-xs text-green-600 font-medium ml-1 animate-[fadeIn_0.2s_ease-in-out_forwards]">
                            Saved
                          </span>
                        )}
                        {alertSavedMessages[`${coin.instrument_name}_sell`] && (
                          <span className="text-xs text-green-600 font-medium ml-1 animate-[fadeIn_0.2s_ease-in-out_forwards]">
                            Saved
                          </span>
                        )}
                        <button
                          onClick={async () => {
                            const symbol = coin.instrument_name;
                            const buyAlertEnabled = coinBuyAlertStatus[symbol] || false;
                            const sellAlertEnabled = coinSellAlertStatus[symbol] || false;
                            
                            // Determine which side to test based on toggle states and current signal
                            const strategyState = coin.strategy_state as StrategyDecision | undefined;
                            const currentSignalSide = strategyState?.decision || null; // 'BUY', 'SELL', 'WAIT', or null
                            
                            let testSide: 'BUY' | 'SELL' | null = null;
                            
                            if (buyAlertEnabled && !sellAlertEnabled) {
                              // Only BUY enabled → test BUY
                              testSide = 'BUY';
                            } else if (!buyAlertEnabled && sellAlertEnabled) {
                              // Only SELL enabled → test SELL
                              testSide = 'SELL';
                            } else if (buyAlertEnabled && sellAlertEnabled) {
                              // Both enabled → use current signal side
                              if (currentSignalSide === 'BUY') {
                                testSide = 'BUY';
                              } else if (currentSignalSide === 'SELL') {
                                testSide = 'SELL';
                              } else {
                                // Fallback: default to BUY if signal is WAIT or unavailable
                                testSide = 'BUY';
                              }
                            } else {
                              // Neither enabled → show message and return
                              alert(`⚠️ Alerts deshabilitados\n\nEl campo 'Alerts' está en OFF para este símbolo.\n\nPor favor activa BUY o SELL para poder ejecutar una prueba.`);
                              return;
                            }
                            
                            // Get trade_amount_usd from dashboard (coinAmounts)
                            const amountUSD = coinAmounts[symbol] ? parseFloat(coinAmounts[symbol]) : undefined;
                            
                            if (!amountUSD || amountUSD <= 0) {
                              alert(`⚠️ CONFIGURACIÓN REQUERIDA\n\nEl campo 'Amount USD' no está configurado para ${symbol}.\n\nPor favor configura el campo 'Amount USD' en la Watchlist del Dashboard antes de crear órdenes.`);
                              return;
                            }
                            
                            // Get trade_enabled from dashboard (coinTradeStatus)
                            const tradeEnabled = coinTradeStatus[symbol] === true;
                            
                            // Confirm test action
                            const sideLabel = testSide === 'BUY' ? 'BUY' : 'SELL';
                            const confirmMessage = `🧪 ¿Simular alerta ${sideLabel} para ${symbol}?\n\n` +
                              `Esto enviará notificaciones de Telegram y creará órdenes automáticamente si Trade=YES.\n\n` +
                              `Lado simulado: ${sideLabel}\n` +
                              `💰 Amount: $${amountUSD.toFixed(2)} USD\n` +
                              `📊 Trade: ${tradeEnabled ? 'YES' : 'NO'}`;
                            if (!window.confirm(confirmMessage)) {
                              return;
                            }
                            
                            try {
                              const results: Array<{ type: string; result: SimulateAlertResponse }> = [];
                              
                              // Simulate the determined side
                              console.log(`[TEST_BUTTON] Calling simulateAlert`, { 
                                symbol, 
                                testSide, 
                                amountUSD,
                                tradeEnabled,
                                endpoint: '/api/test/simulate-alert',
                                method: 'POST',
                                payload: { symbol, signal_type: testSide, force_order: true, trade_amount_usd: amountUSD, trade_enabled: tradeEnabled }
                              });
                              console.log(`🧪 Simulando alerta ${testSide} para ${symbol} con amount=${amountUSD}, trade_enabled=${tradeEnabled}...`);
                              const testResult = await simulateAlert(symbol, testSide, true, amountUSD, tradeEnabled);
                              results.push({ type: testSide, result: testResult });
                              
                              // Build summary message
                              let message = `✅ Simulación completada!\n\n`;
                              results.forEach(({ type, result }) => {
                                message += `\n🔄 ${type} Signal:\n`;
                                message += `   📊 Symbol: ${result.symbol}\n`;
                                message += `   💵 Price: $${result.price.toFixed(4)}\n`;
                                message += `   📢 Alert sent: ${result.alert_sent ? '✅' : '❌'}\n`;
                                
                                // Show order status: created, in progress, or error
                                if (result.order_created) {
                                  message += `   📦 Order created: ✅\n`;
                                } else if ('order_in_progress' in result && (result as { order_in_progress?: boolean }).order_in_progress) {
                                  message += `   📦 Order created: ⏳ (en proceso en background)\n`;
                                  const resultWithNote = result as { note?: string };
                                  if (resultWithNote.note) {
                                    message += `   ℹ️ ${resultWithNote.note}\n`;
                                  }
                                } else if (result.order_error) {
                                  message += `   📦 Order created: ❌\n`;
                                  message += `   ⚠️ Error: ${result.order_error}\n`;
                                } else {
                                  message += `   📦 Order created: ❌\n`;
                                  const resultWithNote = result as { note?: string };
                                  if (resultWithNote.note) {
                                    message += `   ℹ️ ${resultWithNote.note}\n`;
                                  }
                                }
                              });
                              
                              alert(message);
                              console.log(`✅ Simulación completada:`, results);
                            } catch (simError: unknown) {
                              const simErrorObj = simError as { detail?: string; message?: string };
                              logHandledError(
                                `simulateAlert:${symbol}`,
                                `❌ Error simulando alerta para ${symbol}`,
                                simError,
                                'error'
                              );
                              const errorMsg = simErrorObj.detail || simErrorObj.message || 'Error desconocido';
                              alert(`❌ Error simulando alerta:\n\n${errorMsg}`);
                            }
                          }}
                          className="px-2 py-1 rounded text-xs font-semibold bg-purple-600 hover:bg-purple-700 text-white"
                          title="Simular alerta (usa BUY o SELL según la configuración de alerts)"
                        >
                          🧪 TEST
                        </button>
                        <button
                          onClick={() => {
                            console.log(`Delete clicked for ${coin.instrument_name}`);
                            console.log(`Current deleteConfirm: ${deleteConfirm}`);
                            handleDeleteCoin(coin.instrument_name);
                          }}
                          className={`px-3 py-1 rounded text-sm ${
                            deleteConfirm === coin.instrument_name
                              ? 'bg-orange-600 hover:bg-orange-700 text-white'
                              : 'bg-red-600 hover:bg-red-700 text-white'
                          }`}
                        >
                          {deleteConfirm === coin.instrument_name ? 'Confirm?' : 'Delete'}
                        </button>
                      </div>
                    </td>
                        </>
                      );
                    })()}
                  </tr>
                );
              })}
                {!topCoinsLoading && topCoins.length === 0 && (
                  <tr>
                    <td colSpan={22} className="px-4 py-6 text-center text-gray-500">No watchlist data available.</td>
                  </tr>
                )}
              </tbody>
            </Table>
        </div>
      )}

      {/* Open Orders Tab */}
      {activeTab === 'orders' && (
        <div>
          <div className="flex flex-col md:flex-row md:justify-between md:items-center mb-4 gap-4">
            <h2 className="text-xl font-semibold">Open Orders - Crypto.com</h2>
            <div className="flex flex-wrap items-center gap-2 md:gap-4">
              {openOrdersLastUpdate && (
                <div className="text-sm text-gray-500 whitespace-nowrap">
                  <span className="mr-2">🕐</span>
                  Last update: {formatDateTime(openOrdersLastUpdate)}
                </div>
              )}
              {botStatus && (
                <>
                <div className={`px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap ${
                  botStatus.is_running 
                    ? 'bg-green-100 text-green-700' 
                    : 'bg-red-100 text-red-700'
                }`} title={botStatus.reason || undefined}>
                  {botStatus.is_running ? '🟢 Bot Activo' : '🔴 Bot Detenido'}
                </div>
                  <button
                    onClick={async () => {
                      if (togglingLiveTrading) return;
                      setTogglingLiveTrading(true);
                      try {
                        const currentEnabled = botStatus.live_trading_enabled ?? false;
                        const result = await toggleLiveTrading(!currentEnabled);
                        if (result.ok) {
                          setBotStatus({
                            ...botStatus,
                            live_trading_enabled: result.live_trading_enabled,
                            mode: result.mode
                          });
                          const dashboardState = await getDashboardState();
                          if (dashboardState.bot_status) {
                            setBotStatus(dashboardState.bot_status);
                          }
                        }
                      } catch (error) {
                        const errorObj = error as { detail?: string; message?: string };
                        console.error('Failed to toggle LIVE_TRADING:', error);
                        const errorMessage = errorObj?.detail || errorObj?.message || 'Unknown error occurred';
                        alert(`Failed to toggle LIVE_TRADING: ${errorMessage}\n\nPlease check:\n1. Database connection is working\n2. TradingSettings table exists\n3. Backend logs for details`);
                      } finally {
                        setTogglingLiveTrading(false);
                      }
                    }}
                    disabled={togglingLiveTrading || isUpdating || topCoinsLoading || portfolioLoading}
                    className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors whitespace-nowrap ${
                      botStatus.live_trading_enabled
                        ? 'bg-green-600 text-white hover:bg-green-700'
                        : 'bg-gray-400 text-white hover:bg-gray-500'
                    } ${togglingLiveTrading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                    title={botStatus.live_trading_enabled ? 'Click to disable LIVE trading (switch to DRY RUN)' : 'Click to enable LIVE trading (real orders)'}
                  >
                    {togglingLiveTrading ? '⏳' : botStatus.live_trading_enabled ? '🟢 LIVE' : '🔴 DRY RUN'}
                  </button>
                </>
              )}
              <button
                onClick={() => fetchOpenOrders({ showLoader: true })}
                disabled={openOrdersLoading}
                className={`px-3 md:px-4 py-2 rounded-lg font-medium transition-all text-sm md:text-base whitespace-nowrap ${
                  openOrdersLoading
                    ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                    : 'bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800'
                }`}
              >
                {openOrdersLoading ? '🔄 Updating...' : '↻ Refresh'}
              </button>
              <button
                onClick={() => {
                  const newValue = !hideCancelledOpenOrders;
                  setHideCancelledOpenOrders(newValue);
                  if (typeof window !== 'undefined') {
                    window.localStorage.setItem('openOrdersHideCancelled', newValue ? 'true' : 'false');
                  }
                }}
                className={`px-3 md:px-4 py-2 rounded-lg font-medium transition-all text-sm md:text-base whitespace-nowrap ${
                  hideCancelledOpenOrders
                    ? 'bg-green-600 text-white hover:bg-green-700 active:bg-green-800'
                    : 'bg-gray-400 text-white hover:bg-gray-500 active:bg-gray-600'
                }`}
                title={hideCancelledOpenOrders ? 'Ocultando órdenes canceladas - Click para mostrar' : 'Mostrando órdenes canceladas - Click para ocultar'}
              >
                {hideCancelledOpenOrders ? '👁️ Ocultar Canceladas: ON' : '👁️ Ocultar Canceladas: OFF'}
              </button>
            </div>
          </div>
          
          {/* Filters */}
          <div className="mb-6 grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Filter by Symbol</label>
              <input
                type="text"
                placeholder="e.g., BTC_USDT"
                value={orderFilter.symbol}
                onChange={(e) => setOrderFilter({ ...orderFilter, symbol: e.target.value })}
                className="w-full border-2 border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Filter by Status</label>
              <select
                value={orderFilter.status}
                onChange={(e) => setOrderFilter({ ...orderFilter, status: e.target.value })}
                className="w-full border-2 border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                title="Filter by Status"
              >
                <option value="">All Statuses</option>
                <option value="ACTIVE">Active</option>
                <option value="PENDING">Pending</option>
                <option value="FILLED">Filled</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Filter by Side</label>
              <select
                value={orderFilter.side}
                onChange={(e) => setOrderFilter({ ...orderFilter, side: e.target.value })}
                className="w-full border-2 border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                title="Filter by Side"
              >
                <option value="">Both Sides</option>
                <option value="BUY">Buy</option>
                <option value="SELL">Sell</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Start Date</label>
              <input
                type="date"
                value={orderFilter.startDate}
                onChange={(e) => setOrderFilter({ ...orderFilter, startDate: e.target.value })}
                className="w-full border-2 border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                title="Filter orders from this date"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">End Date</label>
              <input
                type="date"
                value={orderFilter.endDate}
                onChange={(e) => setOrderFilter({ ...orderFilter, endDate: e.target.value })}
                className="w-full border-2 border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                title="Filter orders until this date"
              />
            </div>
          </div>

          {openOrdersLoading ? (
            <Table>
              <thead>
                <tr className="bg-gradient-to-r from-gray-800 to-gray-700 text-white">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Created Date</th>
                  <th className="px-4 py-3 text-left font-semibold">Symbol</th>
                  <th className="px-4 py-3 text-left font-semibold">Side</th>
                  <th className="px-4 py-3 text-left font-semibold">Type</th>
                  <th className="px-4 py-3 text-right font-semibold">Quantity</th>
                  <th className="px-4 py-3 text-right font-semibold">Price</th>
                  <th className="px-4 py-3 text-right font-semibold">Wallet Balance</th>
                  <th className="px-4 py-3 text-left font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 5 }).map((_, idx) => (
                  <tr key={`open-order-skeleton-${idx}`} className="border-b">
                    <td className="px-4 py-3"><SkeletonBlock className="h-4 w-28" /></td>
                    <td className="px-4 py-3"><SkeletonBlock className="h-4 w-32" /></td>
                    <td className="px-4 py-3"><SkeletonBlock className="h-4 w-16" /></td>
                    <td className="px-4 py-3"><SkeletonBlock className="h-4 w-20" /></td>
                    <td className="px-4 py-3 text-right"><SkeletonBlock className="h-4 w-20 ml-auto" /></td>
                    <td className="px-4 py-3 text-right"><SkeletonBlock className="h-4 w-20 ml-auto" /></td>
                    <td className="px-4 py-3 text-right"><SkeletonBlock className="h-4 w-20 ml-auto" /></td>
                    <td className="px-4 py-3"><SkeletonBlock className="h-4 w-24" /></td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : sortedOpenOrdersData.length > 0 ? (
            <Table>
              <thead>
                <tr className="bg-gradient-to-r from-gray-800 to-gray-700 text-white">
                  <SortableHeader field="created_date" sortState={openOrdersSort} setSortState={setOpenOrdersSort} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider">Created Date</SortableHeader>
                  <SortableHeader field="symbol" sortState={openOrdersSort} setSortState={setOpenOrdersSort} className="px-4 py-3 text-left font-semibold">Symbol</SortableHeader>
                  <SortableHeader field="side" sortState={openOrdersSort} setSortState={setOpenOrdersSort} className="px-4 py-3 text-left font-semibold">Side</SortableHeader>
                  <SortableHeader field="type" sortState={openOrdersSort} setSortState={setOpenOrdersSort} className="px-4 py-3 text-left font-semibold">Type</SortableHeader>
                  <SortableHeader field="quantity" sortState={openOrdersSort} setSortState={setOpenOrdersSort} className="px-4 py-3 text-right font-semibold">Quantity</SortableHeader>
                  <SortableHeader field="price" sortState={openOrdersSort} setSortState={setOpenOrdersSort} className="px-4 py-3 text-right font-semibold">Price</SortableHeader>
                  <th className="px-4 py-3 text-right font-semibold">Wallet Balance</th>
                  <SortableHeader field="status" sortState={openOrdersSort} setSortState={setOpenOrdersSort} className="px-4 py-3 text-left font-semibold">Status</SortableHeader>
                </tr>
              </thead>
              <tbody>
                {sortedOpenOrdersData.map((order, index) => {
                  // Extract base asset from instrument_name (e.g., "BTC_USDT" -> "BTC")
                  const baseAsset = order.instrument_name.split('_')[0]?.toUpperCase() || '';
                  
                  // Find balance for this asset
                  const balance = realBalances.length > 0
                    ? realBalances.find(b => b.asset && (b.asset || '').toUpperCase() === baseAsset)
                    : portfolio?.assets?.find(a => a && a.coin && (a.coin || '').toUpperCase() === baseAsset);
                  
                  const totalBalance = balance 
                    ? ('free' in balance ? (balance.free || 0) + (balance.locked || 0) : balance.balance || 0)
                    : 0;
                  
                  const hasBalance = totalBalance > 0;
                  
                  // Format creation date - use create_time (timestamp) for accurate timezone conversion
                  const createdDateDisplay = order.create_time 
                    ? formatTimestamp(order.create_time)  // Use timestamp (UTC) for accurate conversion
                    : 'N/A';
                  
                  return (
                    <tr key={order.order_id} className="hover:bg-gray-50 border-b">
                      <td className="px-4 py-3 text-sm font-medium">{createdDateDisplay || 'N/A'}</td>
                      <td className="px-4 py-3 font-medium">{order.instrument_name}</td>
                      <td className="px-4 py-3">
                        <Badge variant={order.side === 'BUY' ? 'success' : 'danger'}>
                          {order.side}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">{order.order_type}</td>
                      <td className="px-4 py-3 text-right">{formatNumber(parseFloat(order.quantity))}</td>
                      <td className="px-4 py-3 text-right">
                        {order.price && parseFloat(order.price) > 0 
                          ? formatNumber(parseFloat(order.price))
                          : order.order_type === 'MARKET' || order.order_type === 'TAKE_PROFIT_LIMIT'
                            ? <span className="text-gray-500 italic">MARKET</span>
                            : <span className="text-gray-400 italic">—</span>
                        }
                      </td>
                      <td className={`px-4 py-3 text-right ${hasBalance ? 'bg-yellow-100' : ''}`}>
                        {hasBalance ? (
                          <span className="font-medium text-yellow-800">
                            {formatNumber(totalBalance)} {baseAsset}
                          </span>
                        ) : (
                          <span className="text-gray-400 italic">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="warning">{order.status}</Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          ) : (
            <div className="text-center py-8">
              {openOrdersError ? (
                <div className="space-y-2">
                  <p className="text-red-600 font-medium">⚠️ Error loading orders</p>
                  <p className="text-sm text-gray-600">{openOrdersError}</p>
                  {openOrdersLastUpdate && (
                    <p className="text-xs text-gray-500 mt-2">
                      Last successful update: {formatDateTime(openOrdersLastUpdate)}
                    </p>
                  )}
                  <button
                    onClick={() => fetchOpenOrders({ showLoader: true })}
                    className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                  >
                    Try Again
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-gray-500">No open orders found.</p>
                  {openOrdersLastUpdate && (
                    <p className="text-xs text-gray-400">
                      Last updated: {formatDateTime(openOrdersLastUpdate)}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Executed Orders Tab */}
      {/* Expected Take Profit Tab */}
      {activeTab === 'expected-take-profit' && (
        <div>
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold">Expected Take Profit</h2>
            <div className="flex items-center gap-4">
              {expectedTPLastUpdate && (
                <div className="text-sm text-gray-500">
                  <span className="mr-2">🕐</span>
                  Last update: {formatDateTime(expectedTPLastUpdate)}
                </div>
              )}
              {expectedTPLoading && expectedTPSummary.length > 0 && (
                <div className="text-sm text-gray-500 flex items-center gap-2">
                  <div className="inline-block animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
                  <span>Refreshing...</span>
                </div>
              )}
              <button
                onClick={() => fetchExpectedTakeProfitSummary()}
                disabled={expectedTPLoading && expectedTPSummary.length === 0}
                className={`px-4 py-2 rounded-lg font-medium transition-all ${
                  expectedTPLoading && expectedTPSummary.length === 0
                    ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                    : 'bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800'
                }`}
              >
                {expectedTPLoading && expectedTPSummary.length === 0 ? '🔄 Loading...' : '↻ Refresh'}
              </button>
            </div>
          </div>

          {expectedTPLoading && expectedTPSummary.length === 0 ? (
            <div className="text-center py-8">
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
              <p className="mt-4 text-gray-500">Loading expected take profit summary...</p>
            </div>
          ) : expectedTPSummary.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <p>No open positions with take profit orders found.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full bg-white border border-gray-200 rounded-lg">
                <thead className="bg-gray-50">
                  <tr>
                    <SortableHeader field="symbol" sortState={expectedTPSort} setSortState={setExpectedTPSort} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Symbol</SortableHeader>
                    <SortableHeader field="net_qty" sortState={expectedTPSort} setSortState={setExpectedTPSort} className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Net Qty</SortableHeader>
                    <SortableHeader field="current_price" sortState={expectedTPSort} setSortState={setExpectedTPSort} className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Current Price</SortableHeader>
                    <SortableHeader field="position_value" sortState={expectedTPSort} setSortState={setExpectedTPSort} className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Position Value</SortableHeader>
                    <SortableHeader field="covered_qty" sortState={expectedTPSort} setSortState={setExpectedTPSort} className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Covered Qty</SortableHeader>
                    <SortableHeader field="uncovered_qty" sortState={expectedTPSort} setSortState={setExpectedTPSort} className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Uncovered Qty</SortableHeader>
                    <SortableHeader field="expected_profit" sortState={expectedTPSort} setSortState={setExpectedTPSort} className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Expected Profit</SortableHeader>
                    <SortableHeader field="coverage" sortState={expectedTPSort} setSortState={setExpectedTPSort} className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Coverage</SortableHeader>
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {sortedExpectedTPData.map((item) => {
                    const coveragePercent = item.net_qty > 0 ? (item.covered_qty / item.net_qty) * 100 : 0;
                    const coverageStatus = coveragePercent >= 100 ? 'full' : coveragePercent > 0 ? 'partial' : 'none';
                    
                    return (
                      <tr key={item.symbol} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium">{normalizeSymbol(item.symbol || '')}</td>
                        <td className="px-4 py-3 text-right font-mono text-sm">
                          {formatNumber(item.net_qty, item.symbol.split('_')[0])}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-sm">${formatNumber(item.current_price)}</td>
                        <td className="px-4 py-3 text-right font-mono text-sm font-semibold">
                          ${formatNumber(item.position_value)}
                          {item.actual_position_value !== undefined && item.actual_position_value > 0 && !isNaN(item.actual_position_value) && (
                            <span className={`ml-2 text-xs font-normal ${
                              item.position_value >= item.actual_position_value ? 'text-green-600' : 'text-red-600'
                            }`}>
                              ({item.position_value >= item.actual_position_value ? '+' : ''}
                              {((item.position_value - item.actual_position_value) / item.actual_position_value * 100).toFixed(2)}%)
                                </span>
                              )}
                          </td>
                        <td className="px-4 py-3 text-right font-mono text-sm text-green-700">
                          {formatNumber(item.covered_qty, item.symbol.split('_')[0])}
                          </td>
                        <td className={`px-4 py-3 text-right font-mono text-sm ${item.uncovered_qty > 0 ? 'text-red-600 font-semibold' : 'text-gray-500'}`}>
                          {formatNumber(item.uncovered_qty, item.symbol.split('_')[0])}
                          </td>
                        <td className={`px-4 py-3 text-right font-mono text-sm font-semibold ${item.total_expected_profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {item.total_expected_profit >= 0 ? '+' : ''}${formatNumber(item.total_expected_profit)}
                          </td>
                          <td className="px-4 py-3 text-center">
                          <span className={`px-2 py-1 rounded text-xs font-semibold ${
                            coverageStatus === 'full'
                              ? 'bg-green-100 text-green-800 border border-green-300'
                              : coverageStatus === 'partial'
                              ? 'bg-yellow-100 text-yellow-800 border border-yellow-300'
                              : 'bg-red-100 text-red-800 border border-red-300'
                          }`}>
                            {coveragePercent.toFixed(1)}%
                              </span>
                          </td>
                          <td className="px-4 py-3 text-center">
                          <button
                            onClick={() => fetchExpectedTPDetails(item.symbol)}
                            disabled={expectedTPDetailsLoading && expectedTPDetailsSymbol === item.symbol}
                            className="px-3 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
                          >
                            {expectedTPDetailsLoading && expectedTPDetailsSymbol === item.symbol ? 'Loading...' : 'View Details'}
                          </button>
                          </td>
                        </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Expected Take Profit Details Dialog */}
      {showExpectedTPDetailsDialog && expectedTPDetails && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-6xl w-full mx-4 max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-gray-200 flex justify-between items-center">
              <h3 className="text-xl font-semibold">Expected Take Profit Details - {expectedTPDetails.symbol}</h3>
              <button
                onClick={() => {
                  setShowExpectedTPDetailsDialog(false);
                  setExpectedTPDetails(null);
                  setExpectedTPDetailsSymbol(null);
                }}
                className="text-gray-400 hover:text-gray-600 text-2xl font-bold"
              >
                ×
              </button>
            </div>
            
            <div className="p-6">
              {/* Summary Header */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6 p-4 bg-gray-50 rounded-lg">
                <div>
                  <div className="text-xs text-gray-500 uppercase">Net Quantity</div>
                  <div className="text-lg font-semibold font-mono">{formatNumber(expectedTPDetails.net_qty, expectedTPDetails.symbol.split('_')[0])}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 uppercase">Current Price</div>
                  <div className="text-lg font-semibold font-mono">${formatNumber(expectedTPDetails.current_price)}</div>
                </div>
                {expectedTPDetails.actual_position_value !== undefined && (
                  <div>
                    <div className="text-xs text-gray-500 uppercase">Purchase Value (Cost Basis)</div>
                    <div className="text-lg font-semibold font-mono">${formatNumber(expectedTPDetails.actual_position_value)}</div>
                  </div>
                )}
                <div>
                  <div className="text-xs text-gray-500 uppercase">Current Market Value</div>
                  <div className="text-lg font-semibold font-mono">${formatNumber(expectedTPDetails.position_value)}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 uppercase">Expected Profit</div>
                  <div className={`text-lg font-semibold font-mono ${expectedTPDetails.total_expected_profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {expectedTPDetails.total_expected_profit >= 0 ? '+' : ''}${formatNumber(expectedTPDetails.total_expected_profit)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 uppercase">Covered Qty</div>
                  <div className="text-lg font-semibold font-mono text-green-700">
                    {formatNumber(expectedTPDetails.covered_qty, expectedTPDetails.symbol.split('_')[0])}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 uppercase">Uncovered Qty</div>
                  <div className={`text-lg font-semibold font-mono ${expectedTPDetails.uncovered_qty > 0 ? 'text-red-600' : 'text-gray-500'}`}>
                    {formatNumber(expectedTPDetails.uncovered_qty, expectedTPDetails.symbol.split('_')[0])}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 uppercase">Coverage</div>
                  <div className="text-lg font-semibold">
                    {expectedTPDetails.net_qty > 0 
                      ? `${((expectedTPDetails.covered_qty / expectedTPDetails.net_qty) * 100).toFixed(1)}%`
                      : '0%'
                    }
                  </div>
                </div>
              </div>

              {/* Matched Lots Table */}
              <div className="mb-6">
                <h4 className="text-lg font-semibold mb-3">Matched Lots</h4>
                {expectedTPDetails.matched_lots.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="min-w-full bg-white border border-gray-200 rounded-lg">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700 uppercase">Buy Order ID</th>
                          <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700 uppercase">Buy Time</th>
                          <th className="px-3 py-2 text-right text-xs font-semibold text-gray-700 uppercase">Buy Price</th>
                          <th className="px-3 py-2 text-right text-xs font-semibold text-gray-700 uppercase">Lot Qty</th>
                          <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700 uppercase">TP Order ID</th>
                          <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700 uppercase">TP Time</th>
                          <th className="px-3 py-2 text-right text-xs font-semibold text-gray-700 uppercase">TP Price</th>
                          <th className="px-3 py-2 text-right text-xs font-semibold text-gray-700 uppercase">TP Qty</th>
                          <th className="px-3 py-2 text-center text-xs font-semibold text-gray-700 uppercase">TP Status</th>
                          <th className="px-3 py-2 text-center text-xs font-semibold text-gray-700 uppercase">Match</th>
                          <th className="px-3 py-2 text-right text-xs font-semibold text-gray-700 uppercase">Expected Profit</th>
                          <th className="px-3 py-2 text-right text-xs font-semibold text-gray-700 uppercase">Expected Profit %</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-gray-200">
                        {expectedTPDetails.matched_lots.map((lot, idx) => (
                          <tr key={`${lot.buy_order_id}-${lot.tp_order_id}-${idx}`} className="hover:bg-gray-50">
                            <td className="px-3 py-2 text-sm font-mono text-gray-700">{lot.buy_order_id.substring(0, 12)}...</td>
                            <td className="px-3 py-2 text-sm text-gray-600 font-mono">
                              {lot.buy_time ? formatTimestamp(lot.buy_time) : 'N/A'}
                                      </td>
                            <td className="px-3 py-2 text-sm font-mono text-right">${formatNumber(lot.buy_price)}</td>
                            <td className="px-3 py-2 text-sm font-mono text-right">{formatNumber(lot.lot_qty, lot.symbol.split('_')[0])}</td>
                            <td className="px-3 py-2 text-sm font-mono text-gray-700">{lot.tp_order_id.substring(0, 12)}...</td>
                            <td className="px-3 py-2 text-sm text-gray-600 font-mono">
                              {lot.tp_time ? formatTimestamp(lot.tp_time) : 'N/A'}
                                      </td>
                            <td className="px-3 py-2 text-sm font-mono text-right text-green-700 font-semibold">${formatNumber(lot.tp_price)}</td>
                            <td className="px-3 py-2 text-sm font-mono text-right">{formatNumber(lot.tp_qty, lot.symbol.split('_')[0])}</td>
                            <td className="px-3 py-2 text-center">
                              <span className={`px-2 py-1 rounded text-xs ${
                                lot.tp_status === 'FILLED' ? 'bg-gray-100 text-gray-600' :
                                lot.tp_status === 'ACTIVE' || lot.tp_status === 'NEW' ? 'bg-green-100 text-green-800' :
                                'bg-yellow-100 text-yellow-800'
                              }`}>
                                {lot.tp_status}
                                          </span>
                                        </td>
                            <td className="px-3 py-2 text-center">
                                          <span className={`px-2 py-1 rounded text-xs font-medium ${
                                lot.match_origin === 'OCO'
                                  ? 'bg-blue-100 text-blue-800 border border-blue-300'
                                  : 'bg-purple-100 text-purple-800 border border-purple-300'
                              }`}>
                                {lot.match_origin}
                                          </span>
                                        </td>
                            <td className={`px-3 py-2 text-sm font-mono text-right font-semibold ${lot.expected_profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                              {lot.expected_profit >= 0 ? '+' : ''}${formatNumber(lot.expected_profit)}
                                        </td>
                            <td className={`px-3 py-2 text-sm font-mono text-right font-semibold ${lot.expected_profit_pct >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                              {lot.expected_profit_pct >= 0 ? '+' : ''}{formatNumber(lot.expected_profit_pct)}%
                            </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                ) : (
                  <p className="text-gray-500 text-center py-4">No matched lots found.</p>
                )}
              </div>

              {/* Uncovered Quantity Section */}
              {expectedTPDetails.uncovered_qty > 0 && expectedTPDetails.uncovered_entry && (
                <div className="mt-6 p-4 bg-red-50 border-2 border-red-300 rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-red-600 font-bold">⚠️</span>
                    <h4 className="text-lg font-semibold text-red-800">Uncovered Quantity</h4>
                  </div>
                  <div className="bg-white border border-red-300 rounded p-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <div className="text-xs text-gray-500 uppercase">Symbol</div>
                        <div className="text-lg font-semibold">{expectedTPDetails.uncovered_entry.symbol}</div>
                      </div>
                      <div>
                        <div className="text-xs text-gray-500 uppercase">Uncovered Quantity</div>
                        <div className="text-lg font-semibold font-mono text-red-600">
                          {formatNumber(expectedTPDetails.uncovered_entry.uncovered_qty, expectedTPDetails.uncovered_entry.symbol.split('_')[0])}
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 pt-3 border-t border-red-200">
                      <p className="text-red-700 font-medium">{expectedTPDetails.uncovered_entry.label}</p>
                    </div>
                  </div>
            </div>
          )}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'executed-orders' && (
        <div>
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold">Executed Orders - Crypto.com</h2>
            <div className="flex items-center gap-4">
              {executedOrdersLastUpdate && (
                <div className="text-sm text-gray-500">
                  <span className="mr-2">🕐</span>
                  Última actualización: {formatDateTime(executedOrdersLastUpdate)}
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
                    onClick={async () => {
                      if (togglingLiveTrading) return;
                      setTogglingLiveTrading(true);
                      try {
                        const currentEnabled = botStatus.live_trading_enabled ?? false;
                        const result = await toggleLiveTrading(!currentEnabled);
                        if (result.ok) {
                          setBotStatus({
                            ...botStatus,
                            live_trading_enabled: result.live_trading_enabled,
                            mode: result.mode
                          });
                          const dashboardState = await getDashboardState();
                          if (dashboardState.bot_status) {
                            setBotStatus(dashboardState.bot_status);
                          }
                        }
                      } catch (error) {
                        const errorObj = error as { detail?: string; message?: string };
                        console.error('Failed to toggle LIVE_TRADING:', error);
                        const errorMessage = errorObj?.detail || errorObj?.message || 'Unknown error occurred';
                        alert(`Failed to toggle LIVE_TRADING: ${errorMessage}\n\nPlease check:\n1. Database connection is working\n2. TradingSettings table exists\n3. Backend logs for details`);
                      } finally {
                        setTogglingLiveTrading(false);
                      }
                    }}
                    disabled={togglingLiveTrading}
                    className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
                      botStatus.live_trading_enabled
                        ? 'bg-green-600 text-white hover:bg-green-700'
                        : 'bg-gray-400 text-white hover:bg-gray-500'
                    } ${togglingLiveTrading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                    title={botStatus.live_trading_enabled ? 'Click to disable LIVE trading (switch to DRY RUN)' : 'Click to enable LIVE trading (real orders)'}
                  >
                    {togglingLiveTrading ? '⏳' : botStatus.live_trading_enabled ? '🟢 LIVE' : '🔴 DRY RUN'}
                  </button>
                </>
              )}
              <button
                onClick={() => fetchExecutedOrders({ showLoader: true })}
                disabled={executedOrdersLoading}
                className={`px-4 py-2 rounded-lg font-medium transition-all ${
                  executedOrdersLoading
                    ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                    : 'bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800'
                }`}
              >
                {executedOrdersLoading ? '🔄 Updating...' : '↻ Refresh'}
              </button>
              <button
                onClick={() => {
                  const newValue = !hideCancelled;
                  setHideCancelled(newValue);
                  if (typeof window !== 'undefined') {
                    window.localStorage.setItem('executedOrdersHideCancelled', newValue ? 'true' : 'false');
                  }
                }}
                className={`px-4 py-2 rounded-lg font-medium transition-all ${
                  hideCancelled
                    ? 'bg-green-600 text-white hover:bg-green-700 active:bg-green-800'
                    : 'bg-gray-400 text-white hover:bg-gray-500 active:bg-gray-600'
                }`}
                title={hideCancelled ? 'Ocultando órdenes canceladas - Click para mostrar' : 'Mostrando órdenes canceladas - Click para ocultar'}
              >
                {hideCancelled ? '👁️ Ocultar Canceladas: ON' : '👁️ Ocultar Canceladas: OFF'}
              </button>
            </div>
          </div>
          
          {/* Filters */}
          <div className="mb-6 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Filtrar por Moneda</label>
                <input
                  type="text"
                  placeholder="e.g., BTC_USDT, LDO_USD"
                  value={orderFilter.symbol}
                  onChange={(e) => setOrderFilter({ ...orderFilter, symbol: e.target.value })}
                  className="w-full border-2 border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  title="Filtrar por símbolo de moneda"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Filtrar por Tipo de Ejecución</label>
                <select
                  value={orderFilter.side}
                  onChange={(e) => setOrderFilter({ ...orderFilter, side: e.target.value })}
                  className="w-full border-2 border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  title="Filtrar por tipo de ejecución"
                >
                  <option value="">Ambos (BUY y SELL)</option>
                  <option value="BUY">Compra (BUY)</option>
                  <option value="SELL">Venta (SELL)</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Filtrar por Estado</label>
                <select
                  value={orderFilter.status}
                  onChange={(e) => setOrderFilter({ ...orderFilter, status: e.target.value })}
                  className="w-full border-2 border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  title="Filtrar por estado"
                >
                  <option value="">Todos los Estados</option>
                  <option value="FILLED">Ejecutadas (FILLED)</option>
                  <option value="CANCELLED">Canceladas (CANCELLED)</option>
                  <option value="ACTIVE">Activas (ACTIVE)</option>
                </select>
              </div>
            </div>
            
            {/* Date Filter Section */}
            <div className="border-t pt-4">
              <label className="block text-sm font-medium text-gray-700 mb-3">Filtrar por Fecha</label>
              <div className="flex flex-wrap items-center gap-3 mb-3">
                {/* Quick filter buttons */}
                <button
                  onClick={() => {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    const todayStr = today.toISOString().split('T')[0];
                    setOrderFilter({ ...orderFilter, startDate: todayStr, endDate: todayStr });
                  }}
                  className={`px-4 py-2 rounded-lg font-medium transition-all ${
                    orderFilter.startDate && orderFilter.endDate && 
                    orderFilter.startDate === orderFilter.endDate &&
                    orderFilter.startDate === new Date().toISOString().split('T')[0]
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                  }`}
                >
                  HOY
                </button>
                <button
                  onClick={() => {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    const weekAgo = new Date(today);
                    weekAgo.setDate(weekAgo.getDate() - 7);
                    setOrderFilter({ 
                      ...orderFilter, 
                      startDate: weekAgo.toISOString().split('T')[0], 
                      endDate: today.toISOString().split('T')[0] 
                    });
                  }}
                  className={`px-4 py-2 rounded-lg font-medium transition-all ${
                    orderFilter.startDate && orderFilter.endDate &&
                    (() => {
                      const start = new Date(orderFilter.startDate);
                      const end = new Date(orderFilter.endDate);
                      const today = new Date();
                      today.setHours(0, 0, 0, 0);
                      const weekAgo = new Date(today);
                      weekAgo.setDate(weekAgo.getDate() - 7);
                      return start.getTime() === weekAgo.getTime() && end.getTime() === today.getTime();
                    })()
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                  }`}
                >
                  SEMANA
                </button>
                <button
                  onClick={() => {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    const monthAgo = new Date(today);
                    monthAgo.setMonth(monthAgo.getMonth() - 1);
                    setOrderFilter({ 
                      ...orderFilter, 
                      startDate: monthAgo.toISOString().split('T')[0], 
                      endDate: today.toISOString().split('T')[0] 
                    });
                  }}
                  className={`px-4 py-2 rounded-lg font-medium transition-all ${
                    orderFilter.startDate && orderFilter.endDate &&
                    (() => {
                      const start = new Date(orderFilter.startDate);
                      const end = new Date(orderFilter.endDate);
                      const today = new Date();
                      today.setHours(0, 0, 0, 0);
                      const monthAgo = new Date(today);
                      monthAgo.setMonth(monthAgo.getMonth() - 1);
                      return start.getTime() === monthAgo.getTime() && end.getTime() === today.getTime();
                    })()
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                  }`}
                >
                  MES
                </button>
                <button
                  onClick={() => {
                    setOrderFilter({ ...orderFilter, startDate: '', endDate: '' });
                  }}
                  className="px-4 py-2 rounded-lg font-medium transition-all bg-gray-200 text-gray-700 hover:bg-gray-300"
                >
                  Limpiar Filtros
                </button>
              </div>
              
              {/* Date inputs */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Fecha Inicio</label>
                  <input
                    type="date"
                    value={orderFilter.startDate}
                    onChange={(e) => setOrderFilter({ ...orderFilter, startDate: e.target.value })}
                    className="w-full border-2 border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    title="Fecha de inicio del filtro"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Fecha Fin</label>
                  <input
                    type="date"
                    value={orderFilter.endDate}
                    onChange={(e) => setOrderFilter({ ...orderFilter, endDate: e.target.value })}
                    className="w-full border-2 border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    title="Fecha de fin del filtro"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Show filter count and total P/L */}
          {(orderFilter.symbol || orderFilter.side || orderFilter.status || orderFilter.startDate || orderFilter.endDate) && (
            <div className="mb-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="text-sm text-gray-600">
                  Mostrando <span className="font-semibold text-gray-800">{filteredExecutedOrders.length}</span> de <span className="font-semibold text-gray-800">{executedOrders.length}</span> órdenes ejecutadas
                </div>
                {filteredTotalPL !== 0 && (
                  <div className={`text-lg font-bold ${filteredTotalPL >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    P&L Total Filtrado: {filteredTotalPL >= 0 ? '+' : ''}${formatNumber(filteredTotalPL)}
                  </div>
                )}
              </div>
            </div>
          )}

          {executedOrdersLoading ? (
            <Table>
              <thead>
                <tr className="bg-gradient-to-r from-gray-800 to-gray-700 text-white">
                  <th className="px-4 py-3 text-left font-semibold">Created</th>
                  <th className="px-4 py-3 text-left font-semibold">Symbol</th>
                  <th className="px-4 py-3 text-left font-semibold">Side</th>
                  <th className="px-4 py-3 text-left font-semibold">Type</th>
                  <th className="px-4 py-3 text-right font-semibold">Quantity</th>
                  <th className="px-4 py-3 text-right font-semibold">Price</th>
                  <th className="px-4 py-3 text-right font-semibold">Total Value</th>
                  <th className="px-4 py-3 text-right font-semibold">P/L</th>
                  <th className="px-4 py-3 text-left font-semibold">Execution Time</th>
                  <th className="px-4 py-3 text-left font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 5 }).map((_, idx) => (
                  <tr key={`executed-order-skeleton-${idx}`} className="border-b">
                    <td className="px-4 py-3"><SkeletonBlock className="h-4 w-32" /></td>
                    <td className="px-4 py-3"><SkeletonBlock className="h-4 w-32" /></td>
                    <td className="px-4 py-3"><SkeletonBlock className="h-4 w-16" /></td>
                    <td className="px-4 py-3"><SkeletonBlock className="h-4 w-20" /></td>
                    <td className="px-4 py-3 text-right"><SkeletonBlock className="h-4 w-20 ml-auto" /></td>
                    <td className="px-4 py-3 text-right"><SkeletonBlock className="h-4 w-20 ml-auto" /></td>
                    <td className="px-4 py-3 text-right"><SkeletonBlock className="h-4 w-24 ml-auto" /></td>
                    <td className="px-4 py-3 text-right"><SkeletonBlock className="h-4 w-24 ml-auto" /></td>
                    <td className="px-4 py-3"><SkeletonBlock className="h-4 w-32" /></td>
                    <td className="px-4 py-3"><SkeletonBlock className="h-4 w-24" /></td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : sortedExecutedOrdersData.length > 0 ? (
            <Table>
              <thead>
                <tr className="bg-gradient-to-r from-gray-800 to-gray-700 text-white">
                  <SortableHeader field="created_date" sortState={executedOrdersSort} setSortState={setExecutedOrdersSort} className="px-4 py-3 text-left font-semibold">Created</SortableHeader>
                  <SortableHeader field="symbol" sortState={executedOrdersSort} setSortState={setExecutedOrdersSort} className="px-4 py-3 text-left font-semibold">Symbol</SortableHeader>
                  <SortableHeader field="side" sortState={executedOrdersSort} setSortState={setExecutedOrdersSort} className="px-4 py-3 text-left font-semibold">Side</SortableHeader>
                  <SortableHeader field="type" sortState={executedOrdersSort} setSortState={setExecutedOrdersSort} className="px-4 py-3 text-left font-semibold">Type</SortableHeader>
                  <SortableHeader field="quantity" sortState={executedOrdersSort} setSortState={setExecutedOrdersSort} className="px-4 py-3 text-right font-semibold">Quantity</SortableHeader>
                  <SortableHeader field="price" sortState={executedOrdersSort} setSortState={setExecutedOrdersSort} className="px-4 py-3 text-right font-semibold">Price</SortableHeader>
                  <SortableHeader field="total_value" sortState={executedOrdersSort} setSortState={setExecutedOrdersSort} className="px-4 py-3 text-right font-semibold">Total Value</SortableHeader>
                  <th className="px-4 py-3 text-right font-semibold">P/L</th>
                  <SortableHeader field="execution_time" sortState={executedOrdersSort} setSortState={setExecutedOrdersSort} className="px-4 py-3 text-left font-semibold">Execution Time</SortableHeader>
                  <SortableHeader field="status" sortState={executedOrdersSort} setSortState={setExecutedOrdersSort} className="px-4 py-3 text-left font-semibold">Status</SortableHeader>
                </tr>
              </thead>
              <tbody>
                {sortedExecutedOrdersData.map((order, index) => {
                  // Format created time
                  const createdTimeStr = order.create_time
                    ? formatTimestamp(order.create_time)
                    : ((order as unknown as { create_datetime?: string }).create_datetime
                      ? formatTimestamp((order as unknown as { create_datetime?: string }).create_datetime)
                      : 'N/A');

                  // Format execution time - prioritize timestamps for accurate timezone conversion
                  let execTimeStr = '—';
                  // Prefer update_time (timestamp) for accurate UTC to local conversion
                  if (order.update_time) {
                    execTimeStr = formatTimestamp(order.update_time);
                  } else if (order.create_time) {
                    execTimeStr = formatTimestamp(order.create_time);
                  } else {
                    execTimeStr = 'N/A';
                  }
                  
                  // Check if order should have yellow background
                  // Yellow if: imported less than 48 hours ago OR is the most recently imported order
                  const importedAt = order.imported_at ? new Date(order.imported_at) : null;
                  const hasYellowBackground = (() => {
                    if (!order.imported_at || !importedAt) return false;
                    
                    const now = new Date();
                    const hoursSinceImport = (now.getTime() - importedAt.getTime()) / (1000 * 60 * 60);
                    
                    // Check if imported within 48 hours
                    if (hoursSinceImport < 48) {
                      return true;
                    }
                    
                    // Check if this is the most recently imported order
                    // Find the most recent imported_at timestamp
                    const allImportedOrders = filteredExecutedOrders.filter(o => o.imported_at);
                    if (allImportedOrders.length > 0) {
                      const mostRecentImport = Math.max(...allImportedOrders.map(o => o.imported_at || 0));
                      if (order.imported_at === mostRecentImport) {
                        return true;
                      }
                    }
                    
                    return false;
                  })();
                  
                  return (
                    <tr 
                      key={order.order_id} 
                      className={`border-b ${hasYellowBackground ? 'bg-yellow-100 hover:bg-yellow-200' : 'hover:bg-gray-50'}`}
                    >
                      <td className="px-4 py-3 text-sm text-gray-600 font-mono">{createdTimeStr}</td>
                      <td className="px-4 py-3 font-medium">{order.instrument_name}</td>
                      <td className="px-4 py-3">
                        <Badge variant={order.side === 'BUY' ? 'success' : 'danger'}>
                          {order.side}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">{order.order_type}</td>
                      <td className="px-4 py-3 text-right">{formatNumber(parseFloat(order.quantity))}</td>
                      <td className="px-4 py-3 text-right">
                        {order.price && parseFloat(order.price) > 0 
                          ? formatNumber(parseFloat(order.price))
                          : order.order_type === 'MARKET' || order.order_type === 'TAKE_PROFIT_LIMIT'
                            ? <span className="text-gray-500 italic">MARKET</span>
                            : <span className="text-gray-400 italic">—</span>
                        }
                      </td>
                      <td className="px-4 py-3 text-right font-medium">
                        {(() => {
                          const qty = parseFloat(order.quantity) || 0;
                          const price = order.price ? parseFloat(order.price) : 0;
                          const totalValue = qty * price;
                          
                          // Use cumulative_value if available (more accurate for executed orders)
                          if (order.cumulative_value && parseFloat(order.cumulative_value) > 0) {
                            return `$${formatNumber(parseFloat(order.cumulative_value))}`;
                          }
                          
                          // Otherwise calculate from quantity × price
                          if (qty > 0 && price > 0) {
                            return `$${formatNumber(totalValue)}`;
                          }
                          
                          // If no price available (e.g., MARKET orders), show dash
                          return <span className="text-gray-400 italic">—</span>;
                        })()}
                      </td>
                      <td className="px-4 py-3 text-right font-medium">
                        {(() => {
                          try {
                            const pnlData = calculateProfitLoss(order, executedOrders);
                            if (pnlData.pnl === 0 && pnlData.pnlPercent === 0 && !pnlData.isRealized) {
                              return <span className="text-gray-400 italic">—</span>;
                            }
                            
                            const orderSide = order.side?.toUpperCase();
                            const isBuyOrder = orderSide === 'BUY';
                            const isPositive = pnlData.pnl > 0;
                            const pnlColor = isPositive ? 'text-green-600' : pnlData.pnl < 0 ? 'text-red-600' : 'text-gray-600';
                            const pnlSign = isPositive ? '+' : '';
                            
                            // BUY orders show theoretical P/L in parentheses, SELL orders show realized P/L
                            if (isBuyOrder) {
                              return (
                                <div className="flex flex-col items-end">
                                  <span className={`text-gray-500 italic`}>
                                    ({pnlSign}${formatNumber(pnlData.pnl)})
                                  </span>
                                  <span className={`text-xs text-gray-500 italic`}>
                                    ({pnlSign}{pnlData.pnlPercent.toFixed(2)}%)
                                  </span>
                                  <span className="text-xs text-gray-400 mt-1">
                                    P&L Teórico
                                  </span>
                                </div>
                              );
                            } else {
                              // SELL orders show realized P/L
                              return (
                                <div className="flex flex-col items-end">
                                  <span className={pnlColor}>
                                    {pnlSign}${formatNumber(pnlData.pnl)}
                                  </span>
                                  <span className={`text-xs ${pnlColor}`}>
                                    {pnlSign}{pnlData.pnlPercent.toFixed(2)}%
                                  </span>
                                </div>
                              );
                            }
                          } catch (err) {
                            console.error('Error calculating P/L for order:', order.order_id, err);
                            return <span className="text-gray-400 italic">—</span>;
                          }
                        })()}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">
                        {execTimeStr}
                        {importedAt && (
                          <span className="ml-2 text-xs text-gray-400">
                            (Import: {formatDateTime(importedAt)})
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={order.status === 'FILLED' ? 'success' : 'neutral'}>
                          {order.status}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          ) : (
            <div className="text-center py-8">
              {executedOrdersError ? (
                <div className="space-y-2">
                  <p className="text-red-600 font-medium">⚠️ Error loading executed orders</p>
                  <p className="text-sm text-gray-600">{executedOrdersError}</p>
                  {executedOrdersLastUpdate && (
                    <p className="text-xs text-gray-500 mt-2">
                      Last successful update: {formatDateTime(executedOrdersLastUpdate)}
                    </p>
                  )}
                  <button
                    onClick={() => fetchExecutedOrders({ showLoader: true })}
                    className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                  >
                    Try Again
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <p className="text-gray-500 font-medium">No executed orders found.</p>
                    <p className="text-sm text-gray-500 mt-2">
                      This could mean:
                    </p>
                    <ul className="text-sm text-gray-500 mt-2 list-disc list-inside text-left max-w-md mx-auto">
                      <li>No orders have been executed yet</li>
                      <li>Orders need to be synced from the exchange</li>
                      <li>Orders exist but are filtered out</li>
                    </ul>
                  </div>
                  {executedOrdersLastUpdate && (
                    <p className="text-xs text-gray-400">
                      Last updated: {formatDateTime(executedOrdersLastUpdate)}
                    </p>
                  )}
                  <button
                    onClick={() => fetchExecutedOrders({ showLoader: true, loadAll: true })}
                    className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
                    disabled={executedOrdersLoading}
                  >
                    {executedOrdersLoading ? '🔄 Syncing from Exchange...' : '🔄 Sync from Exchange'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Monitoring Tab */}
      {activeTab === 'monitoring' && (
        <div>
          <ErrorBoundary>
            <MonitoringPanel 
              refreshInterval={20000}
              telegramMessages={telegramMessages}
              telegramMessagesLoading={telegramMessagesLoading}
              onRequestTelegramRefresh={fetchTelegramMessages}
            />
          </ErrorBoundary>
        </div>
      )}

      {/* Version History Tab */}
      {activeTab === 'version-history' && (
        <VersionHistoryTab />
      )}
    </div>
  );
}

// ExpandableSection component - must be outside VersionHistoryTab
function ExpandableSection({ 
    id, 
    title, 
  children,
  isExpanded,
  onToggle
  }: { 
    id: string; 
    title: string; 
    children: React.ReactNode;
  isExpanded: boolean;
  onToggle: (id: string) => void;
}) {
    return (
      <div className="mb-4 border rounded-lg overflow-hidden">
        <button
        onClick={() => onToggle(id)}
          className="w-full px-6 py-4 text-left bg-gradient-to-r from-gray-50 to-gray-100 hover:from-gray-100 hover:to-gray-200 transition-all flex justify-between items-center"
        >
          <span className="font-semibold text-lg text-gray-800">{title}</span>
          <span className="text-2xl text-gray-600">
            {isExpanded ? '−' : '+'}
          </span>
        </button>
        {isExpanded && (
          <div className="px-6 py-4 bg-white">
            {children}
          </div>
        )}
      </div>
    );
}

// Version History Component with Expandable Sections
function VersionHistoryTab() {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());

  const toggleSection = (sectionId: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(sectionId)) {
        next.delete(sectionId);
      } else {
        next.add(sectionId);
      }
      return next;
    });
  };

  const currentVersion = VERSION_HISTORY[VERSION_HISTORY.length - 1];

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <h2 className="text-3xl font-bold mb-2">Version History</h2>
        <p className="text-gray-600">Complete changelog of all updates and improvements</p>
      </div>

      {/* Current Version Summary */}
      <div className="mb-8 p-6 bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg border-2 border-blue-200">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-2xl font-bold text-gray-900">Current Version: v{currentVersion.version}</h3>
          <span className="px-3 py-1 bg-blue-600 text-white rounded-full text-sm font-semibold">
            Latest
          </span>
        </div>
        <p className="text-gray-700 leading-relaxed mb-2">
          <strong>Latest Change:</strong> {currentVersion.change}
        </p>
        <p className="text-sm text-gray-600">
          <strong>Date:</strong> {currentVersion.date}
        </p>
      </div>

      {/* Version History List */}
      <div className="mb-8">
        <h3 className="text-2xl font-bold mb-4">All Versions</h3>
        <div className="space-y-3">
          {VERSION_HISTORY.slice().reverse().map((entry, index) => (
            <div 
              key={entry.version} 
              className="border rounded-lg p-4 hover:shadow-md transition-shadow bg-white"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <span className="px-3 py-1 bg-blue-100 text-blue-800 rounded-full text-sm font-semibold">
                      v{entry.version}
                    </span>
                    <span className="text-sm text-gray-500">{entry.date}</span>
                    {index === 0 && (
                      <span className="px-2 py-1 bg-green-100 text-green-800 rounded-full text-xs font-semibold">
                        Latest
                      </span>
                    )}
                  </div>
                  <p className="text-gray-800 font-medium mb-1">{entry.change}</p>
                  <p className="text-sm text-gray-600">{entry.details}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Expandable Sections */}
      <ExpandableSection id="summary" title="📋 Technical Summary" isExpanded={expandedSections.has('summary')} onToggle={toggleSection}>
        <div className="space-y-4 text-gray-700">
          <p className="leading-relaxed">
            The latest update addresses critical infrastructure stability issues that were preventing the dashboard 
            from loading and the backend API from responding to requests. The primary focus was on resolving Docker 
            container networking conflicts, optimizing backend startup processes, and ensuring proper service communication.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
            <div className="p-4 bg-green-50 rounded-lg border border-green-200">
              <h4 className="font-semibold text-green-800 mb-2">✅ Resolved</h4>
              <ul className="list-disc list-inside space-y-1 text-green-700 text-sm">
                <li>Port conflict between gluetun and backend</li>
                <li>Backend API timeout issues</li>
                <li>Docker container restart loops</li>
                <li>Network connectivity between services</li>
              </ul>
            </div>
            <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
              <h4 className="font-semibold text-blue-800 mb-2">🔧 Improved</h4>
              <ul className="list-disc list-inside space-y-1 text-blue-700 text-sm">
                <li>Startup event optimization</li>
                <li>Database initialization process</li>
                <li>Health check configuration</li>
                <li>Error handling and logging</li>
              </ul>
            </div>
          </div>
        </div>
      </ExpandableSection>

      <ExpandableSection id="docker-network" title="🐳 Docker Network Configuration" isExpanded={expandedSections.has('docker-network')} onToggle={toggleSection}>
        <div className="space-y-4 text-gray-700">
          <h4 className="font-semibold text-lg text-gray-900">Problem</h4>
          <p className="leading-relaxed">
            The gluetun VPN container was exposing port 8002, which conflicted with the backend service trying to 
            bind to the same port. This caused the backend container to fail to start with &quot;port is already allocated&quot; errors.
          </p>
          
          <h4 className="font-semibold text-lg text-gray-900 mt-4">Solution</h4>
          <p className="leading-relaxed">
            Removed port 8002 from gluetun&apos;s port mappings since the backend now uses the bridge network instead of 
            gluetun&apos;s network mode. This allows:
          </p>
          <ul className="list-disc list-inside space-y-2 ml-4 mt-2">
            <li>Backend to have direct access to port 8002 without conflicts</li>
            <li>Telegram bot API to bypass VPN (using bridge network)</li>
            <li>Crypto.com API calls to still use VPN via proxy configuration</li>
            <li>Frontend to communicate with backend on standard bridge network</li>
          </ul>

          <div className="mt-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
            <h5 className="font-semibold text-sm text-gray-900 mb-2">Technical Details:</h5>
            <pre className="text-xs text-gray-700 overflow-x-auto">
{`docker-compose.yml changes:
- Removed "8002:8002/tcp" from gluetun ports
- Backend now uses bridge network (removed network_mode: "service:gluetun")
- Frontend port changed to 3001:3000 to avoid conflict with gluetun`}
            </pre>
          </div>
        </div>
      </ExpandableSection>

      <ExpandableSection id="backend-startup" title="⚡ Backend Startup Optimization" isExpanded={expandedSections.has('backend-startup')} onToggle={toggleSection}>
        <div className="space-y-4 text-gray-700">
          <h4 className="font-semibold text-lg text-gray-900">Problem</h4>
          <p className="leading-relaxed">
            The backend startup event was blocking the event loop, preventing uvicorn from responding to HTTP requests. 
            Even though the server reported &quot;Application startup complete&quot;, requests were timing out because background 
            services were blocking the async event loop.
          </p>
          
          <h4 className="font-semibold text-lg text-gray-900 mt-4">Solution</h4>
          <p className="leading-relaxed">
            Refactored the startup event to ensure all heavy operations run in background tasks without blocking:
          </p>
          <ul className="list-disc list-inside space-y-2 ml-4 mt-2">
            <li><strong>Database initialization:</strong> Moved to thread pool executor to avoid blocking</li>
            <li><strong>Service startup:</strong> All services (exchange sync, signal monitor) now start in background tasks</li>
            <li><strong>VPN gate check:</strong> Removed blocking wait_until_ok, using non-blocking monitor only</li>
            <li><strong>Health endpoint:</strong> Simplified to return immediately without VPN status checks</li>
          </ul>

          <div className="mt-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
            <h5 className="font-semibold text-sm text-gray-900 mb-2">Code Changes:</h5>
            <pre className="text-xs text-gray-700 overflow-x-auto">
{`# Before: Blocking
await exchange_sync_service.start()

# After: Non-blocking
asyncio.create_task(exchange_sync_service.start())

# Database initialization in thread pool
await loop.run_in_executor(None, lambda: Base.metadata.create_all(bind=engine))`}
            </pre>
          </div>
        </div>
      </ExpandableSection>

      <ExpandableSection id="health-check" title="💚 Health Check Configuration" isExpanded={expandedSections.has('health-check')} onToggle={toggleSection}>
        <div className="space-y-4 text-gray-700">
          <h4 className="font-semibold text-lg text-gray-900">Problem</h4>
          <p className="leading-relaxed">
            The Docker health check was too aggressive (10s interval, 3s timeout) and was causing container restart loops. 
            The backend needed more time to fully initialize, especially with database connections and background services.
          </p>
          
          <h4 className="font-semibold text-lg text-gray-900 mt-4">Solution</h4>
          <p className="leading-relaxed">
            Adjusted health check parameters to be more lenient:
          </p>
          <ul className="list-disc list-inside space-y-2 ml-4 mt-2">
            <li><strong>Interval:</strong> Increased from 10s to 30s (less frequent checks)</li>
            <li><strong>Timeout:</strong> Increased from 3s to 10s (more time for response)</li>
            <li><strong>Start period:</strong> Increased from 20s to 60s (grace period for initialization)</li>
            <li><strong>Retries:</strong> Reduced from 10 to 3 (fail faster if truly broken)</li>
          </ul>

          <div className="mt-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
            <h5 className="font-semibold text-sm text-gray-900 mb-2">Configuration:</h5>
            <pre className="text-xs text-gray-700 overflow-x-auto">
{`healthcheck:
  test: ["CMD", "python", "-c", "import urllib.request;urllib.request.urlopen('http://localhost:8002/health', timeout=5)"]
  interval: 30s      # Increased from 10s
  timeout: 10s       # Increased from 3s
  retries: 3         # Reduced from 10
  start_period: 60s  # Increased from 20s`}
            </pre>
          </div>
        </div>
      </ExpandableSection>

      <ExpandableSection id="frontend-backend" title="🌐 Frontend-Backend Communication" isExpanded={expandedSections.has('frontend-backend')} onToggle={toggleSection}>
        <div className="space-y-4 text-gray-700">
          <h4 className="font-semibold text-lg text-gray-900">Problem</h4>
          <p className="leading-relaxed">
            After moving services to bridge network, the frontend was still configured to use port 8000, but the backend 
            was running on port 8002. This caused API calls to fail.
          </p>
          
          <h4 className="font-semibold text-lg text-gray-900 mt-4">Solution</h4>
          <p className="leading-relaxed">
            Updated all frontend configuration to use the correct backend port:
          </p>
          <ul className="list-disc list-inside space-y-2 ml-4 mt-2">
            <li><strong>environment.ts:</strong> Updated API URL from port 8000 to 8002</li>
            <li><strong>.env.local:</strong> Updated NEXT_PUBLIC_API_URL to use port 8002</li>
            <li><strong>docker-compose.yml:</strong> Frontend port changed to 3001:3000</li>
            <li><strong>Network:</strong> Both frontend and backend on bridge network for direct communication</li>
          </ul>
        </div>
      </ExpandableSection>

      <ExpandableSection id="telegram-integration" title="📱 Telegram Bot Integration" isExpanded={expandedSections.has('telegram-integration')} onToggle={toggleSection}>
        <div className="space-y-4 text-gray-700">
          <h4 className="font-semibold text-lg text-gray-900">Previous Fixes</h4>
          <p className="leading-relaxed">
            Earlier versions resolved Telegram bot connectivity issues:
          </p>
          <ul className="list-disc list-inside space-y-2 ml-4 mt-2">
            <li><strong>Message formatting:</strong> Changed from Markdown to HTML for proper rendering</li>
            <li><strong>Scheduler startup:</strong> Ensured trading scheduler runs as background task</li>
            <li><strong>VPN bypass:</strong> Backend uses bridge network to bypass VPN for Telegram API</li>
            <li><strong>Environment variables:</strong> Proper loading of TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID</li>
            <li><strong>/status command:</strong> Enhanced to show accurate data from database</li>
            <li><strong>/analyze command:</strong> Added coin selection menu functionality</li>
          </ul>
        </div>
      </ExpandableSection>

      <ExpandableSection id="technical-architecture" title="🏗️ Technical Architecture Changes" isExpanded={expandedSections.has('technical-architecture')} onToggle={toggleSection}>
        <div className="space-y-4 text-gray-700">
          <h4 className="font-semibold text-lg text-gray-900">Network Topology</h4>
          <div className="ml-4 space-y-2">
            <div className="p-3 bg-blue-50 rounded border border-blue-200">
              <strong>gluetun:</strong> VPN container on port 8000 (HTTP control), port 3000 (frontend proxy)
            </div>
            <div className="p-3 bg-green-50 rounded border border-green-200">
              <strong>backend:</strong> Bridge network, port 8002, bypasses VPN for Telegram, uses VPN proxy for crypto.com
            </div>
            <div className="p-3 bg-purple-50 rounded border border-purple-200">
              <strong>frontend:</strong> Bridge network, port 3001, directly accesses backend on port 8002
            </div>
          </div>

          <h4 className="font-semibold text-lg text-gray-900 mt-4">Startup Sequence</h4>
          <ol className="list-decimal list-inside space-y-2 ml-4">
            <li>Uvicorn starts and listens on port 8002</li>
            <li>Startup event runs (must complete quickly)</li>
            <li>Background tasks scheduled (non-blocking)</li>
            <li>Database initialization in thread pool</li>
            <li>Services start in background (exchange sync, signal monitor, scheduler)</li>
            <li>Health endpoint becomes available</li>
          </ol>
        </div>
      </ExpandableSection>

      <ExpandableSection id="future-improvements" title="🔮 Future Improvements" isExpanded={expandedSections.has('future-improvements')} onToggle={toggleSection}>
        <div className="space-y-4 text-gray-700">
          <h4 className="font-semibold text-lg text-gray-900">Planned Enhancements</h4>
          <ul className="list-disc list-inside space-y-2 ml-4">
            <li>Implement proper connection pooling for database</li>
            <li>Add request queuing for rate-limited API calls</li>
            <li>Enhanced error recovery and automatic retry logic</li>
            <li>Comprehensive monitoring and alerting system</li>
            <li>Performance optimization for large watchlists</li>
            <li>Real-time WebSocket updates for price changes</li>
          </ul>
        </div>
      </ExpandableSection>

      {/* Version Statistics */}
      <div className="mt-8 p-4 bg-gray-50 rounded-lg border border-gray-200 text-sm text-gray-600">
        <p><strong>Current Version:</strong> v{currentVersion.version}</p>
        <p><strong>Total Versions:</strong> {VERSION_HISTORY.length}</p>
        <p><strong>Last Updated:</strong> {currentVersion.date}</p>
        <p><strong>Status:</strong> Active Development</p>
      </div>
    </div>
  );
}
