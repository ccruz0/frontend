'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { TelegramMessage } from '@/lib/api';

interface MonitoringNotificationsContextValue {
  unreadCount: number;
  lastSeenTimestamp: number | null;
  latestMessageTimestamp: number | null;
  handleNewMessages: (messages: TelegramMessage[]) => void;
  markAllAsRead: (messages?: TelegramMessage[]) => void;
}

const MonitoringNotificationsContext = createContext<MonitoringNotificationsContextValue | null>(null);

const STORAGE_KEY = 'monitoring:lastSeenTimestamp';

const getTimestamp = (value: string): number | null => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const getLatestTimestamp = (messages: TelegramMessage[]): number | null => {
  const timestamps = messages
    .map((msg) => getTimestamp(msg.timestamp))
    .filter((ts): ts is number => ts !== null);
  if (timestamps.length === 0) {
    return null;
  }
  return Math.max(...timestamps);
};

export function MonitoringNotificationsProvider({ children }: { children: React.ReactNode }) {
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [hydrated, setHydrated] = useState(false);
  const [lastSeenTimestamp, setLastSeenTimestamp] = useState<number | null>(() => {
    if (typeof window === 'undefined') return null;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored ? Number(stored) : null;
  });
  const [latestMessageTimestamp, setLatestMessageTimestamp] = useState<number | null>(null);
  const lastSeenRef = useRef<number | null>(lastSeenTimestamp);
  const baselineRef = useRef<number | null>(null);
  const prevUnreadRef = useRef(0);
  const currentMessagesRef = useRef<TelegramMessage[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioPrimedRef = useRef(false);
  const pendingSoundRef = useRef(false);
  const lastLoggedTimestampRef = useRef<number | null>(null);

  useEffect(() => {
    lastSeenRef.current = lastSeenTimestamp;
    if (typeof window !== 'undefined') {
      if (lastSeenTimestamp === null) {
        window.localStorage.removeItem(STORAGE_KEY);
      } else {
        window.localStorage.setItem(STORAGE_KEY, String(lastSeenTimestamp));
      }
    }
  }, [lastSeenTimestamp]);

  const playNotificationSound = useCallback(() => {
    if (!audioPrimedRef.current || !audioRef.current) {
      pendingSoundRef.current = true;
      console.info('[Monitoring] Notification sound queued until audio is ready');
      return;
    }
    try {
      audioRef.current.currentTime = 0;
      const playPromise = audioRef.current.play();
      if (playPromise && typeof playPromise.then === 'function') {
        playPromise
          .then(() => {
            pendingSoundRef.current = false;
          })
          .catch((err) => {
            pendingSoundRef.current = true;
            console.warn('[Monitoring] Notification sound blocked by browser, will retry after next interaction', err);
          });
      } else {
        pendingSoundRef.current = false;
      }
    } catch (err) {
      pendingSoundRef.current = true;
      console.warn('Failed to play monitoring notification sound:', err);
    }
  }, []);

  const primeAudio = useCallback(() => {
    if (audioPrimedRef.current) return;
    audioPrimedRef.current = true;
    if (!audioRef.current) {
      audioRef.current = new Audio('/sounds/monitoring-alert.wav');
      audioRef.current.preload = 'auto';
      audioRef.current.volume = 0.6;
    }
    audioRef.current.load();
    if (pendingSoundRef.current) {
      playNotificationSound();
    }
  }, [playNotificationSound]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const activateAudio = () => {
      primeAudio();
    };
    window.addEventListener('pointerdown', activateAudio, { once: true });
    window.addEventListener('keydown', activateAudio, { once: true });
    return () => {
      window.removeEventListener('pointerdown', activateAudio);
      window.removeEventListener('keydown', activateAudio);
    };
  }, [primeAudio]);

  const markAllAsRead = useCallback((messages?: TelegramMessage[]) => {
    const sourceMessages = messages ?? currentMessagesRef.current;
    const latestTimestamp = getLatestTimestamp(sourceMessages);
    if (latestTimestamp !== null) {
      baselineRef.current = latestTimestamp;
      setLastSeenTimestamp(latestTimestamp);
    }
    prevUnreadRef.current = 0;
    setUnreadCount(0);
    console.info('[Monitoring] Unread monitoring alerts reset');
  }, []);

  const handleNewMessages = useCallback(
    (messages: TelegramMessage[]) => {
      currentMessagesRef.current = messages;
      const latestTimestamp = getLatestTimestamp(messages);
      setLatestMessageTimestamp(latestTimestamp);

      // Diagnostics: log every new alert payload
      if (messages.length > 0) {
        const threshold = lastLoggedTimestampRef.current;
        const newAlerts = messages.filter((msg) => {
          const ts = getTimestamp(msg.timestamp);
          if (ts === null) return false;
          if (threshold === null) return true;
          return ts > threshold;
        });
        if (newAlerts.length > 0) {
          console.info(
            `[Monitoring] ${newAlerts.length} Telegram alert(s) received`,
            newAlerts.map((msg) => ({
              symbol: msg.symbol ?? 'N/A',
              blocked: msg.blocked,
              timestamp: msg.timestamp,
              preview: msg.message?.slice(0, 120),
            }))
          );
        }
      }
      if (latestTimestamp !== null) {
        lastLoggedTimestampRef.current = latestTimestamp;
      }

      if (!hydrated) {
        setHydrated(true);
        if (baselineRef.current === null && latestTimestamp !== null) {
          baselineRef.current = latestTimestamp;
        }
        prevUnreadRef.current = 0;
        setUnreadCount(0);
        return;
      }

      const baseline = lastSeenRef.current ?? baselineRef.current;
      if (baseline === null) {
        prevUnreadRef.current = 0;
        setUnreadCount(0);
        return;
      }

      const newUnread = messages.reduce((count, msg) => {
        const ts = getTimestamp(msg.timestamp);
        if (ts === null) return count;
        return ts > baseline ? count + 1 : count;
      }, 0);

      const previousUnread = prevUnreadRef.current;
      if (newUnread !== previousUnread) {
        setUnreadCount(newUnread);
      }

      if (newUnread > previousUnread) {
        console.info(`[Monitoring] Unread alerts increased from ${previousUnread} to ${newUnread}`);
        playNotificationSound();
      }

      prevUnreadRef.current = newUnread;
    },
    [hydrated, playNotificationSound]
  );

  useEffect(() => {
    return () => {
      prevUnreadRef.current = 0;
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const globalScope = window as typeof window & {
      simulateMonitoringAlert?: (override?: Partial<TelegramMessage>) => void;
    };
    globalScope.simulateMonitoringAlert = (override?: Partial<TelegramMessage>) => {
      const now = new Date();
      const fakeMessage: TelegramMessage = {
        message: override?.message ?? `🧪 TEST ALERT - ${now.toLocaleTimeString()}`,
        symbol: override?.symbol ?? 'TEST_USD',
        blocked: override?.blocked ?? false,
        timestamp: override?.timestamp ?? now.toISOString(),
        throttle_status: override?.throttle_status ?? 'SENT',
        throttle_reason: override?.throttle_reason ?? null,
      };
      const nextMessages = [...currentMessagesRef.current, fakeMessage];
      handleNewMessages(nextMessages);
    };
    return () => {
      delete globalScope.simulateMonitoringAlert;
    };
  }, [handleNewMessages]);

  const value = useMemo(
    () => ({
      unreadCount,
      lastSeenTimestamp,
      latestMessageTimestamp,
      handleNewMessages,
      markAllAsRead,
    }),
    [handleNewMessages, lastSeenTimestamp, latestMessageTimestamp, markAllAsRead, unreadCount]
  );

  return (
    <MonitoringNotificationsContext.Provider value={value}>
      {children}
    </MonitoringNotificationsContext.Provider>
  );
}

export function useMonitoringNotifications(): MonitoringNotificationsContextValue {
  const context = useContext(MonitoringNotificationsContext);
  if (!context) {
    throw new Error('useMonitoringNotifications must be used within a MonitoringNotificationsProvider');
  }
  return context;
}

