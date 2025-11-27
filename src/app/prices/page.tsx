'use client';

import { useState } from 'react';

interface OHLCVData {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export default function PricesPage() {
  const [exchange, setExchange] = useState<'BINANCE' | 'CRYPTO_COM'>('BINANCE');
  const [symbol, setSymbol] = useState('BTC_USDT');
  const [ohlcvData, setOhlcvData] = useState<OHLCVData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPrice = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await fetch(
        `http://localhost:8000/api/ohlcv?exchange=${exchange}&symbol=${symbol}&interval=1h&limit=100`,
        {
          headers: {
            'X-API-Key': 'demo-key'
          }
        }
      );

      if (!response.ok) {
        throw new Error('Failed to fetch OHLCV data');
      }

      const data = await response.json();
      setOhlcvData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container mx-auto p-8">
      <h1 className="text-3xl font-bold mb-6">Price Data</h1>
      
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
            onClick={fetchPrice}
            disabled={loading}
            className="bg-blue-600 text-white px-6 py-2 rounded hover:bg-blue-700 disabled:bg-gray-400"
          >
            {loading ? 'Loading...' : 'Fetch OHLCV'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          {error}
        </div>
      )}

      {ohlcvData.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full bg-white border border-gray-300">
            <thead>
              <tr className="bg-gray-100">
                <th className="border px-4 py-2">Time</th>
                <th className="border px-4 py-2">Open</th>
                <th className="border px-4 py-2">High</th>
                <th className="border px-4 py-2">Low</th>
                <th className="border px-4 py-2">Close</th>
                <th className="border px-4 py-2">Volume</th>
              </tr>
            </thead>
            <tbody>
              {ohlcvData.map((candle, index) => (
                <tr key={index} className="hover:bg-gray-50">
                  <td className="border px-4 py-2">{new Date(candle.t).toLocaleString()}</td>
                  <td className="border px-4 py-2">{candle.o.toFixed(2)}</td>
                  <td className="border px-4 py-2">{candle.h.toFixed(2)}</td>
                  <td className="border px-4 py-2">{candle.l.toFixed(2)}</td>
                  <td className="border px-4 py-2">{candle.c.toFixed(2)}</td>
                  <td className="border px-4 py-2">{candle.v.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}