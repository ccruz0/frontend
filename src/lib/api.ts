const API_BASE_URL = 'http://localhost:8000/api';
const API_KEY = 'demo-key';

export interface WatchlistItem {
  id: number;
  symbol: string;
  exchange: string;
  buy_target: number | null;
  take_profit: number | null;
  stop_loss: number | null;
  order_status: string;
  order_date: string | null;
  purchase_price: number | null;
  quantity: number | null;
  sold: boolean;
  sell_price: number | null;
  notes: string | null;
  created_at: string;
  price: number | null;
  rsi: number | null;
  atr: number | null;
  ma50: number | null;
  ma200: number | null;
  ema10: number | null;
  res_up: number | null;
  res_down: number | null;
  signals: {
    buy: boolean;
    sell: boolean;
  } | null;
}

export interface WatchlistInput {
  symbol: string;
  exchange: string;
  buy_target?: number;
  take_profit?: number;
  stop_loss?: number;
}

export async function getDashboard(): Promise<WatchlistItem[]> {
  const response = await fetch(`${API_BASE_URL}/dashboard`, {
    headers: {
      'X-API-Key': API_KEY
    }
  });
  
  if (!response.ok) {
    throw new Error('Failed to fetch dashboard');
  }
  
  return response.json();
}

export async function addToDashboard(data: WatchlistInput): Promise<WatchlistItem> {
  const response = await fetch(`${API_BASE_URL}/dashboard`, {
    method: 'POST',
    headers: {
      'X-API-Key': API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(data)
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to add symbol');
  }
  
  return response.json();
}

export async function updateDashboardItem(id: number, data: WatchlistInput): Promise<WatchlistItem> {
  const response = await fetch(`${API_BASE_URL}/dashboard/${id}`, {
    method: 'PUT',
    headers: {
      'X-API-Key': API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(data)
  });
  
  if (!response.ok) {
    throw new Error('Failed to update dashboard item');
  }
  
  return response.json();
}

export async function deleteDashboardItem(id: number): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/dashboard/${id}`, {
    method: 'DELETE',
    headers: {
      'X-API-Key': API_KEY
    }
  });
  
  if (!response.ok) {
    throw new Error('Failed to delete dashboard item');
  }
}

export async function runEngine(): Promise<any> {
  const response = await fetch(`${API_BASE_URL}/engine/run-once`, {
    method: 'POST',
    headers: {
      'X-API-Key': API_KEY
    }
  });
  
  if (!response.ok) {
    throw new Error('Failed to run engine');
  }
  
  return response.json();
}
