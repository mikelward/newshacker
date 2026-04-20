import { useEffect, useState } from 'react';

// Temporary instrumentation for tuning AI summary skeleton line counts.
// Flow: tap the ruler toggle in the app header to start recording; visit
// stories to collect layout samples silently from each summary card; tap
// again to stop and receive the aggregated report via clipboard. Remove
// this hook and its call sites once the skeleton sizes are dialed in.
const RECORDING_KEY = 'newshacker:debug-layout';
const DATA_KEY = 'newshacker:debug-layout-data';
const CHANGE_EVENT = 'newshacker:debug-layout-change';

export interface ArticleSample {
  kind: 'article';
  url: string;
  chars: number;
  cardWidthPx: number;
  estimatedLines: number;
  actualLines: number;
  timestamp: number;
}

export interface CommentsSample {
  kind: 'comments';
  storyId: number;
  charsPerInsight: number[];
  insightCount: number;
  cardWidthPx: number;
  estimatedLinesPerInsight: number;
  actualLinesPerInsight: number[];
  timestamp: number;
}

export type LayoutSample = ArticleSample | CommentsSample;

function safeGet(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // ignore (quota, private mode, etc.)
  }
}

export function isRecording(): boolean {
  return safeGet(RECORDING_KEY) === '1';
}

function readSamples(): LayoutSample[] {
  const raw = safeGet(DATA_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LayoutSample[]) : [];
  } catch {
    return [];
  }
}

function writeSamples(samples: LayoutSample[]): void {
  safeSet(DATA_KEY, JSON.stringify(samples));
}

function notify(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function recordSample(sample: LayoutSample): void {
  if (!isRecording()) return;
  const samples = readSamples();
  samples.push(sample);
  writeSamples(samples);
  notify();
}

export interface StartResult {
  kind: 'started';
}

export interface StopResult {
  kind: 'stopped';
  samples: LayoutSample[];
}

export function toggleRecording(): StartResult | StopResult {
  if (isRecording()) {
    const samples = readSamples();
    safeSet(RECORDING_KEY, null);
    safeSet(DATA_KEY, null);
    notify();
    return { kind: 'stopped', samples };
  }
  safeSet(DATA_KEY, null);
  safeSet(RECORDING_KEY, '1');
  notify();
  return { kind: 'started' };
}

export interface LayoutDebugState {
  recording: boolean;
  count: number;
}

export function useLayoutDebug(): LayoutDebugState {
  const [state, setState] = useState<LayoutDebugState>(() => ({
    recording: isRecording(),
    count: readSamples().length,
  }));
  useEffect(() => {
    const sync = () =>
      setState({
        recording: isRecording(),
        count: readSamples().length,
      });
    window.addEventListener('storage', sync);
    window.addEventListener(CHANGE_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(CHANGE_EVENT, sync);
    };
  }, []);
  return state;
}
