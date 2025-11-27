'use client';

import { useState } from 'react';

interface SignalsData {
  rsi: number;
  atr: number;
  ma50: number;
  ma200: number;
  ema10: number;
  res_up: number;
  res_down: number;
  method: string;
}

export default function SignalsPage() {
  const [exchange, setExchange] = useState<'BINANCE' | 'CRYPTO_COM'>('BINANCE');
  const [symbol, setSymbol] = useState('BTC_USDT');
  const [signals, setSignals] = useState<SignalsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const evaluateSignals = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await fetch(
        `http://localhost:8000/api/signals?exchange=${exchange}&symbol=${symbol}`,
        {
          headers: {
            'X-API-Key': 'demo-key'
          }
        }
      );

      if (!response.ok) {
        throw new Error('Failed to fetch signals');
      }

      const data = await response.json();
      setSignals(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container mx-auto p-8">
      <h1 className="text-3xl font-bold mb-6">Technical Signals</h1>
      
      <div className="mb-6 space-y-4">
        <div className="flex gap-4 items-end">
          <div>
            <label className="block text-sm font-medium mb-2">Exchange</label>
            <select
              value={exchange}
              onChange={(e) => setExchange(e.target.value as 'BINANCE' | 'CRYPTO_COM')}
              className="border border-gray-300 rounded px-4 py-2"
              title="Select exchange"
            >
              <option value="BINANCE">BINANCE</option>
              <option value="CRYPTO_COM">CRYPTO_COM</option>
            </select>
          </div>
          
          <div>
            <label className="block text-sm font-medium mb-2">Symbol</label>
            <input
              type="text"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              placeholder="BTC_USDT"
              className="border border-gray-300 rounded px-4 py-2"
            />
          </div>
          
          <button
            onClick={evaluateSignals}
            disabled={loading}
            className="bg-green-600 text-white px-6 py-2 rounded hover:bg-green-700 disabled:bg-gray-400"
          >
            {loading ? 'Loading...' : 'Evaluate Signals'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          {error}
        </div>
      )}

      {signals && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-white border border-gray-300 rounded p-6">
            <h2 className="text-xl font-semibold mb-4">Indicators</h2>
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="font-medium">RSI:</span>
                <span className={signals.rsi < 40 ? 'text-green-600' : signals.rsi > 70 ? 'text-red-600' : 'text-gray-600'}>
                  {signals.rsi}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="font-medium">ATR:</span>
                <span>{signals.atr}</span>
              </div>
              <div className="flex justify-between">
                <span className="font-medium">MA50:</span>
                <span>{signals.ma50}</span>
              </div>
              <div className="flex justify-between">
                <span className="font-medium">MA200:</span>
                <span>{signals.ma200}</span>
              </div>
              <div className="flex justify-between">
                <span className="font-medium">EMA10:</span>
                <span>{signals.ema10}</span>
              </div>
            </div>
          </div>

          <div className="bg-white border border-gray-300 rounded p-6">
            <h2 className="text-xl font-semibold mb-4">Support & Resistance</h2>
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="font-medium">Resistance Up:</span>
                <span className="text-red-600">{signals.res_up}</span>
              </div>
              <div className="flex justify-between">
                <span className="font-medium">Resistance Down:</span>
                <span className="text-green-600">{signals.res_down}</span>
              </div>
              <div className="flex justify-between">
                <span className="font-medium">Method:</span>
                <span className="text-sm text-gray-600">{signals.method}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}