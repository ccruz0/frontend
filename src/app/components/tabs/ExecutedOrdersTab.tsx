/**
 * Executed Orders Tab Component
 * Extracted from page.tsx for better organization
 */

import React from 'react';
import { OpenOrder } from '@/app/api';
import { formatDateTime } from '@/utils/formatting';
import { useOrders } from '@/hooks/useOrders';

interface ExecutedOrdersTabProps {
  orderFilter: { symbol: string; status: string; side: string; startDate: string; endDate: string };
  hideCancelled: boolean;
  onFilterChange: (filter: { symbol: string; status: string; side: string; startDate: string; endDate: string }) => void;
  onToggleHideCancelled: (value: boolean) => void;
  // Add other props as needed
}

export default function ExecutedOrdersTab({
  orderFilter,
  hideCancelled,
  onFilterChange,
  onToggleHideCancelled,
}: ExecutedOrdersTabProps) {
  const {
    executedOrders,
    executedOrdersLoading,
    executedOrdersError,
    executedOrdersLastUpdate,
    fetchExecutedOrders,
  } = useOrders();

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-semibold">Executed Orders</h2>
        <div className="flex items-center gap-4">
          {executedOrdersLastUpdate && (
            <div className="text-sm text-gray-500">
              Last update: {formatDateTime(executedOrdersLastUpdate)}
            </div>
          )}
          <button
            onClick={() => fetchExecutedOrders({ showLoader: true })}
            disabled={executedOrdersLoading}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400"
          >
            {executedOrdersLoading ? 'Refreshing...' : 'Refresh'}
          </button>
          <button
            onClick={() => onToggleHideCancelled(!hideCancelled)}
            className={`px-4 py-2 rounded ${
              hideCancelled
                ? 'bg-blue-600 text-white hover:bg-blue-700'
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            }`}
          >
            {hideCancelled ? '👁️ Show Cancelled' : '🙈 Hide Cancelled'}
          </button>
        </div>
      </div>

      {/* Filter Section */}
      <div className="mb-4 p-4 bg-gray-50 rounded-lg">
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <input
            type="text"
            placeholder="Symbol"
            value={orderFilter.symbol}
            onChange={(e) => onFilterChange({ ...orderFilter, symbol: e.target.value })}
            className="px-3 py-2 border rounded"
          />
          <select
            value={orderFilter.status}
            onChange={(e) => onFilterChange({ ...orderFilter, status: e.target.value })}
            className="px-3 py-2 border rounded"
          >
            <option value="">All Status</option>
            <option value="FILLED">Filled</option>
            <option value="CANCELLED">Cancelled</option>
            <option value="REJECTED">Rejected</option>
          </select>
          <select
            value={orderFilter.side}
            onChange={(e) => onFilterChange({ ...orderFilter, side: e.target.value })}
            className="px-3 py-2 border rounded"
          >
            <option value="">All Sides</option>
            <option value="BUY">BUY</option>
            <option value="SELL">SELL</option>
          </select>
          <input
            type="date"
            value={orderFilter.startDate}
            onChange={(e) => onFilterChange({ ...orderFilter, startDate: e.target.value })}
            className="px-3 py-2 border rounded"
          />
          <input
            type="date"
            value={orderFilter.endDate}
            onChange={(e) => onFilterChange({ ...orderFilter, endDate: e.target.value })}
            className="px-3 py-2 border rounded"
          />
        </div>
      </div>

      {executedOrdersError && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
          {executedOrdersError}
        </div>
      )}

      {executedOrdersLoading ? (
        <div className="text-center py-8 text-gray-500">Loading executed orders...</div>
      ) : executedOrders.length === 0 ? (
        <div className="text-center py-8 text-gray-500">No executed orders</div>
      ) : (
        <div>
          <p className="text-gray-500">Executed orders table will be migrated here from page.tsx</p>
          <p className="text-sm text-gray-400 mt-2">Total orders: {executedOrders.length}</p>
        </div>
      )}
    </div>
  );
}



