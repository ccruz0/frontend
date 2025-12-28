/**
 * Watchlist Tab Component
 * Extracted from page.tsx for better organization
 */

import React from 'react';
import { TopCoin, WatchlistItem } from '@/app/api';
import { formatDateTime } from '@/utils/formatting';
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
  // Add other props as needed for watchlist functionality
}

export default function WatchlistTab({
  botStatus,
  togglingLiveTrading,
  isUpdating,
  topCoinsLoading,
  portfolioLoading,
  dataSourceStatus,
  fastQueueRateLimited,
  onToggleLiveTrading,
}: WatchlistTabProps) {
  const {
    topCoins,
    topCoinsLoading: watchlistLoading,
    lastTopCoinsFetchAt,
    coinTradeStatus,
    coinAmounts,
    coinSLPercent,
    coinTPPercent,
    coinBuyAlertStatus,
    coinSellAlertStatus,
    coinAlertStatus,
    fetchTopCoins,
  } = useWatchlist();


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

      {topCoins.length === 0 ? (
        <div className="text-center py-12">
          <div className="text-gray-500 text-lg mb-2">No watchlist data available</div>
          <div className="text-gray-400 text-sm">The watchlist will appear here once data is loaded.</div>
        </div>
      ) : (
        <div>
          <p className="text-gray-500">Watchlist content will be migrated here from page.tsx</p>
          <p className="text-sm text-gray-400 mt-2">Total coins: {topCoins.length}</p>
          <div className="mt-4">
            <p className="text-sm text-gray-600">First few coins:</p>
            <ul className="list-disc list-inside mt-2">
              {topCoins.slice(0, 5).map(coin => (
                <li key={coin.instrument_name} className="text-sm">
                  {coin.instrument_name} - ${coin.current_price?.toFixed(2) || 'N/A'}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}



