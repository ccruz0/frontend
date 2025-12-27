/**
 * Orders Tab Component
 * Extracted from page.tsx for better organization
 */

import React from 'react';
import { OpenOrder } from '@/app/api';
import { formatDateTime } from '@/utils/formatting';
import { useOrders } from '@/hooks/useOrders';

interface OrdersTabProps {
  botStatus: { is_running: boolean; status: 'running' | 'stopped'; reason: string | null; live_trading_enabled?: boolean; mode?: 'LIVE' | 'DRY_RUN' } | null;
  togglingLiveTrading: boolean;
  isUpdating: boolean;
  topCoinsLoading: boolean;
  portfolioLoading: boolean;
  hideCancelledOpenOrders: boolean;
  onToggleLiveTrading: () => Promise<void>;
  onToggleHideCancelled: (value: boolean) => void;
  // Add other props as needed
}

export default function OrdersTab({
  botStatus,
  togglingLiveTrading,
  isUpdating,
  topCoinsLoading,
  portfolioLoading,
  hideCancelledOpenOrders,
  onToggleLiveTrading,
  onToggleHideCancelled,
}: OrdersTabProps) {
  const {
    openOrders,
    openOrdersLoading,
    openOrdersError,
    openOrdersLastUpdate,
    fetchOpenOrders,
  } = useOrders();

  return (
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
                onClick={onToggleLiveTrading}
                disabled={togglingLiveTrading || isUpdating || topCoinsLoading || portfolioLoading}
                className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors whitespace-nowrap ${
                  botStatus.live_trading_enabled
                    ? 'bg-green-600 text-white hover:bg-green-700'
                    : 'bg-gray-400 text-white hover:bg-gray-500'
                }`}
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
            onClick={() => onToggleHideCancelled(!hideCancelledOpenOrders)}
            className={`px-3 md:px-4 py-2 rounded-lg font-medium transition-all text-sm md:text-base whitespace-nowrap ${
              hideCancelledOpenOrders
                ? 'bg-blue-600 text-white hover:bg-blue-700'
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            }`}
          >
            {hideCancelledOpenOrders ? '👁️ Show Cancelled' : '🙈 Hide Cancelled'}
          </button>
        </div>
      </div>

      {openOrdersError && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
          {openOrdersError}
        </div>
      )}

      {openOrdersLoading ? (
        <div className="text-center py-8 text-gray-500">Loading orders...</div>
      ) : openOrders.length === 0 ? (
        <div className="text-center py-8 text-gray-500">No open orders</div>
      ) : (
        <div>
          <p className="text-gray-500">Orders table will be migrated here from page.tsx</p>
          <p className="text-sm text-gray-400 mt-2">Total orders: {openOrders.length}</p>
        </div>
      )}
    </div>
  );
}



