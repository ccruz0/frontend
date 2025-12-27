/**
 * Expected Take Profit Tab Component
 * Extracted from page.tsx for better organization
 */

import React from 'react';
import { ExpectedTPSummaryItem, ExpectedTPDetails } from '@/app/api';
import { formatDateTime } from '@/utils/formatting';

interface ExpectedTakeProfitTabProps {
  expectedTPSummary: ExpectedTPSummaryItem[];
  expectedTPLoading: boolean;
  expectedTPLastUpdate: Date | null;
  expectedTPDetails: ExpectedTPDetails | null;
  expectedTPDetailsLoading: boolean;
  expectedTPDetailsSymbol: string | null;
  showExpectedTPDetailsDialog: boolean;
  onFetchExpectedTakeProfitSummary: () => Promise<void>;
  onFetchExpectedTakeProfitDetails: (symbol: string) => Promise<void>;
  onCloseDetailsDialog: () => void;
  // Add other props as needed
}

export default function ExpectedTakeProfitTab({
  expectedTPSummary,
  expectedTPLoading,
  expectedTPLastUpdate,
  expectedTPDetails,
  expectedTPDetailsLoading,
  expectedTPDetailsSymbol,
  showExpectedTPDetailsDialog,
  onFetchExpectedTakeProfitSummary,
  onFetchExpectedTakeProfitDetails,
  onCloseDetailsDialog,
}: ExpectedTakeProfitTabProps) {
  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-semibold">Expected Take Profit</h2>
        {expectedTPLastUpdate && (
          <div className="text-sm text-gray-500">
            Last update: {formatDateTime(expectedTPLastUpdate)}
          </div>
        )}
        <button
          onClick={onFetchExpectedTakeProfitSummary}
          disabled={expectedTPLoading}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400"
        >
          {expectedTPLoading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {expectedTPLoading ? (
        <div className="text-center py-8 text-gray-500">Loading expected take profit data...</div>
      ) : expectedTPSummary.length === 0 ? (
        <div className="text-center py-8 text-gray-500">No expected take profit data available</div>
      ) : (
        <div>
          <p className="text-gray-500">Expected take profit table will be migrated here from page.tsx</p>
          <p className="text-sm text-gray-400 mt-2">Total symbols: {expectedTPSummary.length}</p>
        </div>
      )}

      {/* Details Dialog */}
      {showExpectedTPDetailsDialog && expectedTPDetails && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-4xl w-full max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-xl font-semibold">Expected TP Details: {expectedTPDetailsSymbol}</h3>
              <button
                onClick={onCloseDetailsDialog}
                className="text-gray-500 hover:text-gray-700"
              >
                ✕
              </button>
            </div>
            {expectedTPDetailsLoading ? (
              <div>Loading details...</div>
            ) : (
              <div>
                <p className="text-gray-500">Details content will be migrated here from page.tsx</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}



