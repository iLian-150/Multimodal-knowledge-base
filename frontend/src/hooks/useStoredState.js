import { useEffect, useState } from "react";

export default function useStoredState(key, initialValue, serialize = JSON.stringify) {
  const [value, setValue] = useState(initialValue);
  useEffect(() => {
    try { localStorage.setItem(key, serialize(value)); } catch { /* Preferences are optional when browser storage is full or unavailable. */ }
  }, [key, value, serialize]);
  return [value, setValue];
}
