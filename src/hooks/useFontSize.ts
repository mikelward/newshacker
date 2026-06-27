import { useCallback } from 'react';
import { type FontSize, fontSizeStore } from '../lib/fontSize';
import { usePersistentValue } from './usePersistentValue';

export function useFontSize() {
  const fontSize = usePersistentValue(fontSizeStore);
  const setFontSize = useCallback((f: FontSize) => fontSizeStore.set(f), []);
  return { fontSize, setFontSize };
}
