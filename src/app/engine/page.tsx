'use client';

import { useState, useEffect } from 'react';

interface Instrument {
  id: number;
  symbol: string;
  venue: string;
  tick_size: number | null;
  lot_size: number | null;
  created_at: string;
}

interface RiskLimit {
  id: number;
  instrument_id: number;
  max_open_orders: number;
  max_buy_usd: number;
  allow_margin: boolean;
  max_leverage: number;
  preferred_exchange: string;
  updated_at: string;
}

interface EngineResult {
  placed: any[];
  filled: any[];
  rejected: any[];
}

export default function EnginePage() {
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [selectedInstrument, setSelectedInstrument] = useState<number | null>(null);
  const [riskLimit, setRiskLimit] = useState<RiskLimit | null>(null);
  const [engineResult, setEngineResult] = useState<EngineResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchInstruments();
  }, []);

  useEffect(() => {
    if (selectedInstrument) {
      fetchRiskLimit(selectedInstrument);
    }
  }, [selectedInstrument]);

  const fetchInstruments = async () => {
    try {
      const response = await fetch('http://localhost:8000/api/instruments', {
        headers: {
          'X-API-Key': 'demo-key'
        }
      });

      if (!response.ok) {
        throw new Error('Failed to fetch instruments');
      }

      const data = await response.json();
      setInstruments(data);
      if (data.length > 0) {
        setSelectedInstrument(data[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const fetchRiskLimit = async (instrumentId: number) => {
    try {
      const response = await fetch(
        `http://localhost:8000/api/risk-limits?instrument_id=${instrumentId}`,
        {
          headers: {
            'X-API-Key': 'demo-key'
          }
        }
      );

      if (!response.ok) {
        throw new Error('Failed to fetch risk limit');
      }

      const data = await response.json();
      setRiskLimit(data);
    } catch (err) {
      setRiskLimit(null);
    }
  };

  const runEngine = async () => {
    setLoading(true);
    setError(null);
    setEngineResult(null);
    
    try {
      const response = await fetch('http://localhost:8000/api/engine/run-once', {
        method: 'POST',
        headers: {
          'X-API-Key': 'demo-key'
        }
      });

      if (!response.ok) {
        throw new Error('Failed to run engine');
      }

      const data = await response.json();
      setEngineResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container mx-auto p-8">
      <h1 className="text-3xl font-bold mb-6">Trading Engine</h1>
      
      <div className="mb-6 space-y-4">
        <div className="flex gap-4 items-end">
          <div className="flex-1">
            <label className="block text-sm font-medium mb-2">Instrument</label>
            <select
              value={selectedInstrument || ''}
              onChange={(e) => setSelectedInstrument(Number(e.target.value))}
              className="border border-gray-300 rounded px-4 py-2 w-full"
              title="Select instrument"
            >
              {instruments.map((inst) => (
                <option key={inst.id} value={inst.id}>
                  {inst.symbol} ({inst.venue})
                </option>
              ))}
            </select>
          </div>
          
          <button
            onClick={runEngine}
            disabled={loading}
            className="bg-purple-600 text-white px-6 py-2 rounded hover:bg-purple-700 disabled:bg-gray-400"
          >
            {loading ? 'Running...' : 'Run Now'}
          </button>
        </div>
      </div>

      {riskLimit && (
        <div className="mb-6 bg-gray-50 border border-gray-300 rounded p-4">
          <h2 className="text-lg font-semibold mb-3">Current Risk Limits</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <div>
              <span className="text-sm text-gray-600">Max Open Orders:</span>
              <span className="ml-2 font-medium">{riskLimit.max_open_orders}</span>
            </div>
            <div>
              <span className="text-sm text-gray-600">Max Buy USD:</span>
              <span className="ml-2 font-medium">${riskLimit.max_buy_usd}</span>
            </div>
            <div>
              <span className="text-sm text-gray-600">Allow Margin:</span>
              <span className="ml-2 font-medium">{riskLimit.allow_margin ? 'Yes' : 'No'}</span>
            </div>
            <div>
              <span className="text-sm text-gray-600">Max Leverage:</span>
              <span className="ml-2 font-medium">{riskLimit.max_leverage}x</span>
            </div>
            <div>
              <span className="text-sm text-gray-600">Preferred Exchange:</span>
              <span className="ml-2 font-medium">{riskLimit.preferred_exchange}</span>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          {error}
        </div>
      )}

      {engineResult && (
        <div className="space-y-4">
          {engineResult.filled.length > 0 && (
            <div className="bg-green-50 border border-green-300 rounded p-4">
              <h2 className="text-lg font-semibold mb-2 text-green-800">Filled Orders</h2>
              <div className="space-y-2">
                {engineResult.filled.map((order, index) => (
                  <div key={index} className="bg-white rounded p-3">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
                      <div>
                        <span className="text-gray-600">Side:</span>
                        <span className="ml-2 font-medium">{order.side}</span>
                      </div>
                      <div>
                        <span className="text-gray-600">Symbol:</span>
                        <span className="ml-2 font-medium">{order.symbol}</span>
                      </div>
                      <div>
                        <span className="text-gray-600">Qty:</span>
                        <span className="ml-2 font-medium">{order.qty}</span>
                      </div>
                      <div>
                        <span className="text-gray-600">Price:</span>
                        <span className="ml-2 font-medium">${order.price}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {engineResult.rejected.length > 0 && (
            <div className="bg-red-50 border border-red-300 rounded p-4">
              <h2 className="text-lg font-semibold mb-2 text-red-800">Rejected Orders</h2>
              <div className="space-y-2">
                {engineResult.rejected.map((order, index) => (
                  <div key={index} className="bg-white rounded p-3">
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <span className="text-gray-600">Symbol:</span>
                        <span className="ml-2 font-medium">{order.symbol}</span>
                      </div>
                      <div>
                        <span className="text-gray-600">Reason:</span>
                        <span className="ml-2 font-medium text-red-600">{order.reason}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {engineResult.filled.length === 0 && engineResult.rejected.length === 0 && (
            <div className="bg-gray-50 border border-gray-300 rounded p-4 text-center text-gray-600">
              No orders were placed
            </div>
          )}
        </div>
      )}
    </div>
  );
}
