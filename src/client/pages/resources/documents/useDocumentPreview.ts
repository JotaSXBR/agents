import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { mediaFetch } from "@/client/lib/media";

// Debounced PDF preview of a template draft, as a blob URL.
//
// Deliberately NOT useMediaObjectUrl. That hook retries a 404 with backoff, which is right for a
// WhatsApp voice note that lands a moment after its message and wrong here: a preview failure is a
// validation error the operator has to READ, and retrying it four times over seven seconds only
// delays the message that says which block is broken. What is reused is the discipline that hook
// exists for — revoke the previous URL, revoke on unmount — because a blob URL that is never revoked
// pins its bytes for the life of the tab, and this one is re-minted on every keystroke.

export interface DocumentPreviewState {
  url: string | null;
  loading: boolean;
  error: string | null;
}

const DEBOUNCE_MS = 600;

export function useDocumentPreview(
  draft: Record<string, unknown> | null,
  // Identifies WHICH template is being previewed. When it changes the previous PDF is dropped
  // synchronously: the request is debounced by 600 ms, so without this the modal shows template A's
  // document under template B's form for at least that long — the operator reading a preview of
  // something they are not editing.
  session?: string | number,
): DocumentPreviewState {
  const [state, setState] = useState<DocumentPreviewState>({
    url: null,
    loading: false,
    error: null,
  });
  const urlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const swap = useCallback((next: string | null) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = next;
  }, []);

  // useLayoutEffect, not useEffect: the reset has to land before the paint that would otherwise show
  // the previous session's document (docs/modals.md).
  useLayoutEffect(() => {
    // `session` is read here so the effect is keyed on it: the reset belongs to the template
    // CHANGING, and the linter counts a dependency it cannot see used as unnecessary.
    void session;
    swap(null);
    abortRef.current?.abort();
    setState({ url: null, loading: false, error: null });
  }, [session, swap]);

  const body = draft ? JSON.stringify(draft) : null;

  useEffect(() => {
    if (!body) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const res = await mediaFetch("/api/v1/document-templates/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: controller.signal,
        });
        if (cancelled) return;
        if (!res.ok) {
          // The service's refusal names the block and the rule; showing it verbatim is the whole
          // point of the round trip.
          const payload = (await res.json().catch(() => null)) as {
            message?: string;
            error?: string;
          } | null;
          setState({
            url: null,
            loading: false,
            error: payload?.message ?? payload?.error ?? `HTTP ${res.status}`,
          });
          return;
        }
        const blob = await res.blob();
        if (cancelled) return;
        const next = URL.createObjectURL(blob);
        swap(next);
        setState({ url: next, loading: false, error: null });
      } catch (e) {
        if (cancelled || (e as Error)?.name === "AbortError") return;
        setState({ url: null, loading: false, error: (e as Error).message });
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [body, swap]);

  useEffect(() => () => swap(null), [swap]);

  return state;
}
