'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  getMonitoringSummary,
  getSignalThrottleState,
  getWorkflows,
  MonitoringSummary,
  SignalThrottleEntry,
  TelegramMessage,
  Workflow,
} from '@/lib/api';
import { getApiUrl } from '@/lib/environment';

interface MonitoringPanelProps {
  refreshInterval?: number;
  telegramMessages: TelegramMessage[];
  telegramMessagesLoading: boolean;
  onRequestTelegramRefresh?: (options?: { silent?: boolean }) => void | Promise<void>;
}

// Simple workflow row component
function WorkflowRow({ 
  workflow, 
  isRunning, 
  message, 
  onRun 
}: { 
  workflow: Workflow; 
  isRunning: boolean;
  message: string | undefined;
  onRun: (id: string) => Promise<void>;
}) {
  // Check if workflow can be run manually (must have a non-empty run_endpoint)
  // Explicitly check for null/undefined before calling .trim() to avoid TypeError
  const canRun = workflow.run_endpoint != null && workflow.run_endpoint.trim().length > 0;
  
  const handleRun = async () => {
    if (isRunning || !canRun) return;
    try {
      await onRun(workflow.id);
    } catch (err) {
      // Error already handled in parent
    }
  };
  const statusColor = workflow.last_status === 'success' ? 'text-green-600' : 
                     workflow.last_status === 'error' ? 'text-red-600' : 
                     workflow.last_status === 'running' ? 'text-blue-600' : 'text-gray-600';

  return (
    <tr className="hover:bg-gray-50">
      <td className="px-4 py-3 text-sm font-medium text-gray-900">{workflow.name}</td>
      <td className="px-4 py-3 text-sm text-gray-600">{workflow.description}</td>
      <td className="px-4 py-3 text-sm text-gray-500">{workflow.schedule}</td>
      <td className="px-4 py-3">
        <span className={`text-xs ${statusColor}`}>
          {workflow.last_status || 'unknown'}
        </span>
      </td>
      <td className="px-4 py-3">
        {canRun ? (
          <button
            onClick={handleRun}
            disabled={isRunning}
            className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isRunning ? 'Running...' : 'Run now'}
          </button>
        ) : (
          <span className="text-xs text-gray-400">Automated only</span>
        )}
      </td>
      <td className="px-4 py-3">
        {message && (
          <span className={`text-xs ${message.startsWith('Error') ? 'text-red-600' : 'text-green-600'}`}>
            {message}
          </span>
        )}
        {workflow.last_error && (
          <span className="text-xs text-red-600 block mt-1">{workflow.last_error}</span>
        )}
      </td>
    </tr>
  );
}

export default function MonitoringPanel({
  refreshInterval = 20000,
  telegramMessages,
  telegramMessagesLoading,
  onRequestTelegramRefresh,
}: MonitoringPanelProps) {
  const [data, setData] = useState<MonitoringSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [showTelegramMessages, setShowTelegramMessages] = useState(false);
  const [throttleEntries, setThrottleEntries] = useState<SignalThrottleEntry[]>([]);
  const [throttleLoading, setThrottleLoading] = useState(true);
  const [throttleError, setThrottleError] = useState<string | null>(null);
  const [workflowRunning, setWorkflowRunning] = useState<Record<string, boolean>>({});
  const [workflowMessages, setWorkflowMessages] = useState<Record<string, string>>({});
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [workflowsLoading, setWorkflowsLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const summary = await getMonitoringSummary();
      setData(summary);
      setLastUpdate(new Date());
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      setError(errorMsg);
      console.error('Failed to fetch monitoring data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchThrottle = useCallback(async () => {
    try {
      setThrottleError(null);
      setThrottleLoading(true);
      const entries = await getSignalThrottleState();
      setThrottleEntries(entries);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      setThrottleError(errorMsg);
      console.error('Failed to fetch signal throttle data:', err);
    } finally {
      setThrottleLoading(false);
    }
  }, []);

  const fetchWorkflows = useCallback(async () => {
    try {
      setWorkflowsLoading(true);
      const response = await getWorkflows();
      setWorkflows(response.workflows || []);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      console.error('Failed to fetch workflows:', err);
      // On error, use empty array (workflows will be empty)
      setWorkflows([]);
    } finally {
      setWorkflowsLoading(false);
    }
  }, []);

  const handleRunWorkflow = useCallback(async (workflowId: string) => {
    // Note: workflows must be in dependency array, but we check it inside the function
    try {
      setWorkflowRunning(prev => ({ ...prev, [workflowId]: true }));
      setWorkflowMessages(prev => ({ ...prev, [workflowId]: '' }));
      
      const workflow = workflows.find(w => w.id === workflowId);
      if (!workflow) {
        throw new Error('Workflow not found');
      }
      
      if (!workflow.run_endpoint) {
        throw new Error('Workflow cannot be run manually');
      }
      
      // Use getApiUrl() to construct full API URL instead of relative path
      // This ensures the request goes to the correct backend URL (e.g., localhost:8002/api)
      // instead of the frontend URL (e.g., localhost:3000/api)
      const apiUrl = getApiUrl();
      const fullUrl = `${apiUrl}${workflow.run_endpoint}`;
      
      const response = await fetch(fullUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || `HTTP ${response.status}`);
      }
      
      setWorkflowMessages(prev => ({ ...prev, [workflowId]: 'Started successfully' }));
      setTimeout(() => {
        setWorkflowMessages(prev => {
          const updated = { ...prev };
          delete updated[workflowId];
          return updated;
        });
      }, 3000);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to start workflow';
      setWorkflowMessages(prev => ({ ...prev, [workflowId]: `Error: ${errorMsg}` }));
      setTimeout(() => {
        setWorkflowMessages(prev => {
          const updated = { ...prev };
          delete updated[workflowId];
          return updated;
        });
      }, 5000);
      throw err;
    } finally {
      setWorkflowRunning(prev => ({ ...prev, [workflowId]: false }));
    }
  }, [workflows]);

  useEffect(() => {
    fetchData();
    fetchThrottle();
    fetchWorkflows(); // Fetch workflows from API instead of using static config

    const interval = setInterval(() => {
      fetchData();
      fetchThrottle();
      fetchWorkflows(); // Refresh workflows periodically
    }, refreshInterval);

    return () => clearInterval(interval);
  }, [fetchData, fetchThrottle, fetchWorkflows, refreshInterval]);

  const formatTimestamp = (ts: string): string => {
    try {
      const date = new Date(ts);
      if (isNaN(date.getTime())) return ts;
      return date.toLocaleString(undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        timeZoneName: 'short'
      });
    } catch {
      return ts;
    }
  };

  const formatDuration = (seconds: number | null): string => {
    if (seconds === null) return 'N/A';
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  };

  const formatRelativeTime = (seconds?: number | null): string => {
    if (seconds === null || seconds === undefined) return 'N/A';
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) {
      const mins = Math.floor(seconds / 60);
      return `${mins}m ago`;
    }
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${mins}m ago`;
  };

  const getHealthColor = (health: string): string => {
    switch (health) {
      case 'healthy':
        return 'bg-green-100 text-green-800 border-green-300';
      case 'degraded':
        return 'bg-yellow-100 text-yellow-800 border-yellow-300';
      case 'unhealthy':
      case 'error':
        return 'bg-red-100 text-red-800 border-red-300';
      default:
        return 'bg-gray-100 text-gray-800 border-gray-300';
    }
  };

  const getThrottleStatusStyles = (status: string): string => {
    switch (status.toUpperCase()) {
      case 'BLOCKED':
        return 'bg-red-100 text-red-800 border-red-200';
      case 'SENT':
        return 'bg-green-100 text-green-800 border-green-200';
      default:
        return 'bg-gray-100 text-gray-700 border-gray-200';
    }
  };

  const renderSideBadge = (side: string) => {
    const isBuy = side?.toUpperCase() === 'BUY';
    const classes = isBuy
      ? 'bg-green-100 text-green-800 border-green-200'
      : 'bg-red-100 text-red-800 border-red-200';
    return (
      <span className={`px-2 py-0.5 text-xs font-semibold rounded-full border ${classes}`}>
        {side?.toUpperCase()}
      </span>
    );
  };

  const formatStrategyKey = (key: string): string => {
    if (!key) return 'N/A';
    const [strategy, approach] = key.split(':');
    const formatPart = (part?: string) =>
      part ? part.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase()) : '';
    const parts = [formatPart(strategy), formatPart(approach)];
    const validParts: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]) validParts.push(parts[i]);
    }
    return validParts.join(' / ') || key;
  };

  const getSeverityColor = (severity: string): string => {
    switch (severity.toUpperCase()) {
      case 'ERROR':
        return 'bg-red-100 text-red-800 border-red-300';
      case 'WARNING':
        return 'bg-yellow-100 text-yellow-800 border-yellow-300';
      case 'INFO':
        return 'bg-blue-100 text-blue-800 border-blue-300';
      default:
        return 'bg-gray-100 text-gray-800 border-gray-300';
    }
  };

  if (loading && !data) {
    return (
      <div className="py-8 text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
        <p className="text-gray-500">Loading monitoring data...</p>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="text-center py-8 text-red-500">
        <p>Error loading monitoring data: {error}</p>
        <button
          onClick={fetchData}
          className="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          Retry
        </button>
      </div>
    );
  }

  // Ensure all arrays are initialized to prevent initialization errors
  const monitoringData = data ? {
    ...data,
    errors: Array.isArray(data.errors) ? data.errors : [],
    alerts: Array.isArray(data.alerts) ? data.alerts : [],
  } : {
    active_alerts: 0,
    backend_health: 'error',
    last_sync_seconds: null,
    portfolio_state_duration: 0,
    open_orders: 0,
    balances: 0,
    scheduler_ticks: 0,
    errors: [],
    last_backend_restart: null,
    alerts: []
  };

  // Build error items array
  const errorItems: React.ReactNode[] = [];
  if (Array.isArray(monitoringData.errors) && monitoringData.errors.length > 0) {
    for (let idx = 0; idx < monitoringData.errors.length; idx++) {
      errorItems.push(<li key={idx} className="text-sm text-red-700">{monitoringData.errors[idx]}</li>);
    }
  }

  // Build alert rows array
  const alertRows: React.ReactNode[] = [];
  if (Array.isArray(monitoringData.alerts) && monitoringData.alerts.length > 0) {
    for (let idx = 0; idx < monitoringData.alerts.length; idx++) {
      const alert = monitoringData.alerts[idx];
      alertRows.push(
        <tr key={idx} className="hover:bg-gray-50">
          <td className="px-4 py-3 text-sm text-gray-900">{alert.type}</td>
          <td className="px-4 py-3 text-sm font-medium text-gray-900">{alert.symbol}</td>
          <td className="px-4 py-3 text-sm text-gray-700">{alert.message}</td>
          <td className="px-4 py-3">
            <span className={`px-2 py-1 text-xs font-semibold rounded border ${getSeverityColor(alert.severity)}`}>
              {alert.severity}
            </span>
          </td>
          <td className="px-4 py-3 text-sm text-gray-500">{formatTimestamp(alert.timestamp)}</td>
        </tr>
      );
    }
  }

  // Build throttle rows array
  const throttleRows: React.ReactNode[] = [];
  if (Array.isArray(throttleEntries) && throttleEntries.length > 0) {
    for (let idx = 0; idx < throttleEntries.length; idx++) {
      const entry = throttleEntries[idx];
      throttleRows.push(
        <tr key={`${entry.symbol}-${entry.strategy_key}-${entry.side}-${idx}`} className="hover:bg-gray-50">
          <td className="px-4 py-3 text-sm font-semibold text-gray-900">{entry.symbol}</td>
          <td className="px-4 py-3 text-sm text-gray-700">
            {formatStrategyKey(entry.strategy_key)}
          </td>
          <td className="px-4 py-3 text-sm">{renderSideBadge(entry.side)}</td>
          <td className="px-4 py-3 text-sm text-gray-700">
            {entry.last_price != null ? `$${entry.last_price.toFixed(4)}` : '—'}
          </td>
          <td className="px-4 py-3 text-sm text-gray-600">
            {entry.last_time ? formatTimestamp(entry.last_time) : 'N/A'}
          </td>
          <td className="px-4 py-3 text-sm text-gray-600">
            {formatRelativeTime(entry.seconds_since_last)}
          </td>
        </tr>
      );
    }
  }

  // Build workflow rows array from API-fetched workflows
  const workflowRows: React.ReactNode[] = [];
  for (let idx = 0; idx < workflows.length; idx++) {
    const workflow = workflows[idx];
    if (!workflow || !workflow.id) continue;
    workflowRows.push(
      <WorkflowRow
        key={workflow.id}
        workflow={workflow}
        isRunning={workflowRunning[workflow.id] || false}
        message={workflowMessages[workflow.id]}
        onRun={handleRunWorkflow}
      />
    );
  }

  // Build telegram message items array
  const telegramItems: React.ReactNode[] = [];
  if (Array.isArray(telegramMessages) && telegramMessages.length > 0) {
    for (let idx = 0; idx < telegramMessages.length; idx++) {
      const msg = telegramMessages[idx];
      const statusLabel = (msg.throttle_status || (msg.blocked ? 'BLOCKED' : 'SENT')).toUpperCase();
      telegramItems.push(
        <div
          key={idx}
          className={`p-4 ${msg.blocked ? 'bg-gray-50' : 'bg-blue-50'}`}
        >
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <p
                className={`text-sm ${
                  msg.blocked
                    ? 'text-gray-600 italic'
                    : 'text-blue-700 font-medium'
                }`}
              >
                {msg.message}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span
                  className={`px-2 py-0.5 text-xs font-semibold rounded-full border ${getThrottleStatusStyles(
                    statusLabel
                  )}`}
                >
                  {statusLabel}
                </span>
                {msg.symbol && (
                  <span className="text-xs text-gray-600 font-medium">{msg.symbol}</span>
                )}
              </div>
              {msg.throttle_reason && (
                <p
                  className="text-xs text-gray-500 mt-1 line-clamp-2"
                  title={msg.throttle_reason}
                >
                  {msg.throttle_reason}
                </p>
              )}
              {msg.symbol && (
                <p className="text-xs text-gray-500 mt-1">
                  Symbol: {msg.symbol}
                </p>
              )}
            </div>
            <div className="ml-4 text-xs text-gray-400">
              {formatTimestamp(msg.timestamp)}
            </div>
          </div>
        </div>
      );
    }
  }

  return (
    <div>
      <div className="mb-4 flex justify-between items-center">
        {lastUpdate && (
          <div className="text-sm text-gray-500">
            <span className="mr-2">🕐</span>
            Last updated: {lastUpdate.toLocaleString(undefined, {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: true,
              timeZoneName: 'short'
            })}
          </div>
        )}
        <button
          onClick={fetchData}
          className="px-3 py-1 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
          disabled={loading}
        >
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {/* Health Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className="bg-white rounded-lg shadow p-4 border border-gray-200">
          <div className="text-sm text-gray-500 mb-1">Backend Health</div>
          <div className={`text-lg font-semibold px-3 py-1 rounded border inline-block ${getHealthColor(monitoringData.backend_health)}`}>
            {monitoringData.backend_health.toUpperCase()}
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-4 border border-gray-200">
          <div className="text-sm text-gray-500 mb-1">Portfolio State Duration</div>
          <div className="text-2xl font-bold text-gray-800">
            {monitoringData.portfolio_state_duration.toFixed(2)}s
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-4 border border-gray-200">
          <div className="text-sm text-gray-500 mb-1">Last Sync</div>
          <div className="text-sm font-semibold text-gray-800">
            {formatDuration(monitoringData.last_sync_seconds)}
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-4 border border-gray-200">
          <div className="text-sm text-gray-500 mb-1">Active Alerts</div>
          <div className="text-2xl font-bold text-gray-800">
            {monitoringData.active_alerts}
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-4 border border-gray-200">
          <div className="text-sm text-gray-500 mb-1">Open Orders</div>
          <div className="text-2xl font-bold text-gray-800">
            {monitoringData.open_orders}
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-4 border border-gray-200">
          <div className="text-sm text-gray-500 mb-1">Balances</div>
          <div className="text-2xl font-bold text-gray-800">
            {monitoringData.balances}
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-4 border border-gray-200">
          <div className="text-sm text-gray-500 mb-1">Scheduler Cycles</div>
          <div className="text-2xl font-bold text-gray-800">
            {monitoringData.scheduler_ticks.toLocaleString()}
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-4 border border-gray-200">
          <div className="text-sm text-gray-500 mb-1">Backend Restart</div>
          <div className="text-sm font-semibold text-gray-800">
            {monitoringData.last_backend_restart
              ? formatDuration(Math.floor((Date.now() / 1000) - monitoringData.last_backend_restart))
              : 'N/A'}
          </div>
        </div>
      </div>

      {/* Errors Section */}
      {errorItems.length > 0 && (
        <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4">
          <h3 className="text-lg font-semibold text-red-800 mb-2">Errors</h3>
          <ul className="list-disc list-inside space-y-1">
            {errorItems}
          </ul>
        </div>
      )}

      {/* Alerts Table */}
      <div className="bg-white rounded-lg shadow border border-gray-200 mb-6">
        <div className="p-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold">Active Alerts</h3>
        </div>
        {alertRows.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            No active alerts
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Symbol</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Message</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Severity</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Timestamp</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {alertRows}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Signal Throttle Panel */}
      <div className="bg-white rounded-lg shadow border border-gray-200 mb-6">
        <div className="p-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">Signal Throttle</h3>
            <p className="text-xs text-gray-500">Latest throttle decisions per symbol/strategy</p>
          </div>
          <button
            onClick={fetchThrottle}
            className="px-3 py-1 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
            disabled={throttleLoading}
          >
            {throttleLoading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
        {throttleError && (
          <div className="px-4 py-2 text-sm text-red-600 bg-red-50 border-b border-red-100">
            {throttleError}
          </div>
        )}
        {throttleLoading && throttleEntries.length === 0 ? (
          <div className="p-6 text-center text-gray-500">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600 mx-auto mb-2"></div>
            Loading throttle data...
          </div>
        ) : throttleRows.length === 0 ? (
          <div className="p-6 text-center text-gray-500">
            No throttle activity recorded yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Symbol</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Strategy</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Side</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Last Price</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Last Event</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Ago</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {throttleRows}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Monitoring Workflows Box */}
      <div className="bg-white rounded-lg shadow border border-gray-200 mb-6">
        <div className="p-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold">Monitoring Workflows</h3>
          <p className="text-xs text-gray-500">Automated monitoring workflows with manual triggers</p>
        </div>
        {workflowsLoading ? (
          <div className="p-6 text-center text-gray-500">
            Loading workflows...
          </div>
        ) : workflowRows.length === 0 ? (
          <div className="p-6 text-center text-gray-500">
            No workflows found
          </div>
        ) : (
          <div className="overflow-x-auto max-h-96 overflow-y-auto">
            <table className="w-full">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Description</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Schedule</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Messages</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {workflowRows}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Telegram Messages Dropdown */}
      <div className="bg-white rounded-lg shadow border border-gray-200">
        <div className="p-4 border-b border-gray-200">
          <button
            onClick={() => {
              const nextState = !showTelegramMessages;
              setShowTelegramMessages(nextState);
              if (nextState && telegramMessages.length === 0) {
                onRequestTelegramRefresh?.();
              }
            }}
            className="flex items-center justify-between w-full text-left"
          >
            <h3 className="text-lg font-semibold">
              Telegram Messages ({telegramMessages.length})
            </h3>
            <span className={`transform transition-transform ${showTelegramMessages ? 'rotate-180' : ''}`}>
              ▼
            </span>
          </button>
        </div>
        {showTelegramMessages && (
          <div className="max-h-96 overflow-y-auto">
            {telegramMessagesLoading ? (
              <div className="p-8 text-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4"></div>
                <p className="text-gray-500">Loading Telegram messages...</p>
              </div>
            ) : telegramItems.length === 0 ? (
              <div className="p-8 text-center text-gray-500">
                No Telegram messages yet
              </div>
            ) : (
              <div className="divide-y divide-gray-200">
                {telegramItems}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
