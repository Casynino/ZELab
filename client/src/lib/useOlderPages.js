import { useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import api, { unwrap } from '@/lib/api';

// A rep's history lists (Requests, Settle, Returns) load their newest page with the page itself; the rows
// older than that used to be out of reach, and the counts only counted what was loaded (audit ui-r05).
// This fetches the older pages only when "Show older" is pressed — same address, same filters, page 2, 3 …
// `key` starts with the list's own query key, so every write that refreshes the list refreshes these too.
export function useOlderPages({ key, url, params, total, firstCount }) {
  const [extra, setExtra] = useState(0);
  const limit = Number(params?.limit) || 100;
  const results = useQueries({
    queries: Array.from({ length: extra }, (_, i) => i + 2).map((page) => ({
      queryKey: [...key, 'older', page],
      queryFn: async () => unwrap(await api.get(url, { params: { ...params, page } })),
    })),
  });
  const rows = results.flatMap((r) => r.data?.data || []);
  const loaded = (firstCount || 0) + rows.length;
  return {
    rows,
    hasMore: Number(total) > loaded && loaded >= limit * (1 + extra),
    loading: results.some((r) => r.isLoading),
    more: () => setExtra((n) => n + 1),
  };
}

// Rows of the first page followed by the older ones, each once (a row can slip from one page to the next
// when a new one arrives in between).
export function withOlder(first, older) {
  const seen = new Set();
  return [...(first || []), ...(older || [])].filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
}

export default useOlderPages;
