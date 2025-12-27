/**
 * Portfolio Tab Component
 * Extracted from page.tsx for better organization
 */

import React from 'react';
import { PortfolioAsset } from '@/app/api';
import { formatNumber, formatDateTime } from '@/utils/formatting';
import { logger } from '@/utils/logger';

interface PortfolioTabProps {
  portfolio: { assets: PortfolioAsset[]; total_value_usd: number } | null;
  portfolioLoading: boolean;
  portfolioError: string | null;
  totalBorrowed: number;
  snapshotLastUpdated: Date | null;
  snapshotStale: boolean;
  snapshotStaleSeconds: number | null;
  botStatus: { is_running: boolean; status: 'running' | 'stopped'; reason: string | null; live_trading_enabled?: boolean; mode?: 'LIVE' | 'DRY_RUN' } | null;
  togglingLiveTrading: boolean;
  isUpdating: boolean;
  topCoinsLoading: boolean;
  onToggleLiveTrading: () => Promise<void>;
  onRefreshPortfolio: () => Promise<void>;
}

export default function PortfolioTab({
  portfolio,
  portfolioLoading,
  portfolioError,
  totalBorrowed,
  snapshotLastUpdated,
  snapshotStale,
  snapshotStaleSeconds,
  botStatus,
  togglingLiveTrading,
  isUpdating,
  topCoinsLoading,
  onToggleLiveTrading,
  onRefreshPortfolio,
}: PortfolioTabProps) {
  // This is a placeholder - the actual implementation will be migrated from page.tsx
  // For now, this demonstrates the component structure
  
  if (portfolioLoading) {
    return <div>Loading portfolio...</div>;
  }

  if (portfolioError) {
    return <div className="text-red-500">{portfolioError}</div>;
  }

  if (!portfolio) {
    return <div>No portfolio data available</div>;
  }

  return (
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
              onClick={onToggleLiveTrading}
              disabled={togglingLiveTrading || isUpdating || topCoinsLoading || portfolioLoading}
              className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
                botStatus.live_trading_enabled
                  ? 'bg-green-600 text-white hover:bg-green-700'
                  : 'bg-gray-400 text-white hover:bg-gray-500'
              }`}
            >
              {togglingLiveTrading ? '...' : botStatus.live_trading_enabled ? 'LIVE' : 'DRY RUN'}
            </button>
          </>
        )}
        <button
          onClick={onRefreshPortfolio}
          disabled={portfolioLoading}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400"
        >
          {portfolioLoading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      <div className="mb-4">
        <h2 className="text-xl font-semibold mb-2">Portfolio Summary</h2>
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-white dark:bg-gray-800 p-4 rounded shadow">
            <div className="text-sm text-gray-500">Total Value</div>
            <div className="text-2xl font-bold">{formatNumber(portfolio.total_value_usd)}</div>
          </div>
          {totalBorrowed > 0 && (
            <div className="bg-white dark:bg-gray-800 p-4 rounded shadow">
              <div className="text-sm text-gray-500">Borrowed</div>
              <div className="text-2xl font-bold text-red-600">{formatNumber(totalBorrowed)}</div>
            </div>
          )}
        </div>
      </div>

      <div>
        <h2 className="text-xl font-semibold mb-2">Assets</h2>
        <div className="overflow-x-auto">
          <table className="min-w-full">
            <thead>
              <tr>
                <th>Coin</th>
                <th>Balance</th>
                <th>Value (USD)</th>
              </tr>
            </thead>
            <tbody>
              {portfolio.assets.map((asset) => (
                <tr key={asset.coin}>
                  <td>{asset.coin}</td>
                  <td>{formatNumber(asset.balance)}</td>
                  <td>{formatNumber(asset.value_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}



