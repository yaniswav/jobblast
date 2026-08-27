import { Check, ExternalLink, MapPin, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  getGetDashboardQueryKey,
  getListJobsQueryKey,
  getSearchExploreQueryKey,
  useAddExplorePosting,
  useSearchExplore,
  type ExplorePosting,
} from '@workspace/api-client-react';
import { EmptyState } from '@/components/app-shell';
import { useLocale, useT } from '@/i18n';
import { relativeTime } from '@/lib/relative-time';
import { filterSuggestions, ROLE_SUGGESTIONS, SKILL_SUGGESTIONS } from '@/lib/suggestions';

/** Same as lib/explore-search.ts's MIN_QUERY_LENGTH on the server - kept in
 * sync manually since the two packages don't share a constants module. */
const MIN_QUERY_LENGTH = 2;
/** Matches lib/explore-search.ts's DEFAULT_LIMIT, so "Load more" pages line up 1:1 with what the server hands back. */
const PAGE_SIZE = 20;

/** Skills + target roles, deduplicated: one flat vocabulary for the search bar's autocomplete. */
const SEARCH_SUGGESTIONS: string[] = Array.from(new Set([...SKILL_SUGGESTIONS, ...ROLE_SUGGESTIONS]));

type ActiveParams = { q: string; location: string; source: string };

function SearchBar({
  qDraft,
  setQDraft,
  locationDraft,
  setLocationDraft,
  onSubmit,
}: {
  qDraft: string;
  setQDraft: (value: string) => void;
  locationDraft: string;
  setLocationDraft: (value: string) => void;
  onSubmit: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const suggestions = useMemo(() => filterSuggestions(SEARCH_SUGGESTIONS, qDraft, [], 6), [qDraft]);

  const pick = (value: string) => {
    setQDraft(value);
    setOpen(false);
    onSubmit();
  };

  return (
    <form
      className="surface p-3 flex flex-wrap items-center gap-2"
      onSubmit={(event) => { event.preventDefault(); setOpen(false); onSubmit(); }}
    >
      <div className="relative flex-1 min-w-[220px]">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))]" />
        <input
          className="input pl-9"
          type="search"
          value={qDraft}
          autoComplete="off"
          onChange={(event) => { setQDraft(event.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          placeholder={t('explore.searchPlaceholder')}
          data-testid="input-explore-query"
        />
        {open && suggestions.length > 0 && (
          <ul
            className="absolute left-0 right-0 top-full mt-1 z-10 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-lg overflow-hidden"
            data-testid="list-explore-suggestions"
          >
            {suggestions.map((suggestion) => (
              <li key={suggestion}>
                <button
                  type="button"
                  className="w-full text-left px-3 py-2 text-sm hover:bg-[hsl(var(--muted))]"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(suggestion)}
                  data-testid={`option-explore-suggestion-${suggestion}`}
                >
                  {suggestion}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <input
        className="input flex-1 min-w-[160px]"
        type="text"
        value={locationDraft}
        onChange={(event) => setLocationDraft(event.target.value)}
        placeholder={t('explore.locationPlaceholder')}
        data-testid="input-explore-location"
      />
      <button className="btn btn-primary" type="submit" disabled={qDraft.trim().length < MIN_QUERY_LENGTH} data-testid="button-explore-search">
        <Search size={15} /> {t('explore.searchButton')}
      </button>
    </form>
  );
}

function ExploreCard({ posting, onAdded }: { posting: ExplorePosting; onAdded: (id: number) => void }) {
  const t = useT();
  const [locale] = useLocale();
  const add = useAddExplorePosting();

  const handleAdd = () => {
    add.mutate({ postingId: posting.id }, {
      onSuccess: () => { onAdded(posting.id); toast(t('explore.toastAdded')); },
      onError: (err) => {
        const status = err && typeof err === 'object' && 'status' in err ? (err as { status?: number }).status : undefined;
        if (status === 409) { onAdded(posting.id); toast(t('explore.toastAlreadyQueued')); return; }
        toast(t('explore.toastAddFailed'));
      },
    });
  };

  return (
    <article className="surface p-5 list-enter" data-testid={`card-explore-${posting.id}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs text-[hsl(var(--muted-foreground))] mb-2">
            <span className="badge badge-muted">{posting.source}</span>
            <span>{relativeTime(new Date(posting.postedDate), locale)}</span>
          </div>
          <h3 className="font-bold text-lg tracking-[-.02em]">{posting.title}</h3>
          <div className="flex flex-wrap items-center gap-2 text-xs text-[hsl(var(--muted-foreground))] mt-1.5">
            <span className="font-bold text-[hsl(var(--foreground))]">{posting.company}</span>
            <span>·</span>
            <span className="flex items-center gap-1"><MapPin size={12} />{posting.location}</span>
            <span>·</span>
            <span>{posting.workMode}</span>
          </div>
        </div>
        {posting.inMyQueue ? (
          <span className="btn btn-ghost shrink-0" data-testid={`status-explore-in-queue-${posting.id}`} aria-disabled="true">
            <Check size={15} /> {t('explore.inQueue')}
          </span>
        ) : (
          <button
            className="btn btn-primary shrink-0"
            onClick={handleAdd}
            disabled={add.isPending}
            data-testid={`button-explore-add-${posting.id}`}
          >
            <Check size={15} /> {t('explore.addToQueue')}
          </button>
        )}
      </div>
      <p className="mt-4 text-sm leading-6 text-[hsl(var(--muted-foreground))]">{posting.descriptionExcerpt}</p>
      <a
        className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-[hsl(var(--primary))] hover:underline"
        href={posting.url}
        target="_blank"
        rel="noopener noreferrer"
        data-testid={`link-explore-view-${posting.id}`}
      >
        {t('explore.viewPosting')} <ExternalLink size={13} />
      </a>
    </article>
  );
}

export default function Explore() {
  const t = useT();
  const queryClient = useQueryClient();
  const [qDraft, setQDraft] = useState('');
  const [locationDraft, setLocationDraft] = useState('');
  const [source, setSource] = useState('');
  const [active, setActive] = useState<ActiveParams | null>(null);
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<ExplorePosting[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const appliedKey = useRef<string | null>(null);

  const runSearch = (overrides: Partial<ActiveParams> = {}) => {
    const q = qDraft.trim();
    if (q.length < MIN_QUERY_LENGTH) return;
    setOffset(0);
    setItems([]);
    setHasMore(false);
    appliedKey.current = null;
    setActive({ q, location: locationDraft.trim(), source, ...overrides });
  };

  const params = active
    ? {
        q: active.q,
        location: active.location || undefined,
        source: active.source || undefined,
        limit: PAGE_SIZE,
        offset,
      }
    : undefined;

  const search = useSearchExplore(params ?? { q: '' }, {
    query: {
      queryKey: params ? getSearchExploreQueryKey(params) : ['explore-inactive'],
      enabled: !!params,
    },
  });

  useEffect(() => {
    if (!params || !search.data) return;
    const key = JSON.stringify(params);
    if (appliedKey.current === key) return;
    appliedKey.current = key;
    setItems((prev) => (params.offset === 0 ? search.data : [...prev, ...search.data]));
    setHasMore(search.data.length === PAGE_SIZE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.data]);

  // The dropdown only ever offers sources actually present in the current
  // results (task brief's simpler alternative to a hardcoded SourceId list,
  // which does not line up with what postings.source actually stores).
  const sourceOptions = useMemo(() => Array.from(new Set(items.map((item) => item.source))).sort(), [items]);

  const handleSourceChange = (value: string) => {
    setSource(value);
    if (active) runSearch({ source: value });
  };

  const handleAdded = (id: number) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, inMyQueue: true } : item)));
    queryClient.invalidateQueries({ queryKey: getListJobsQueryKey({ status: 'queued' }) });
    queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
  };

  const searching = search.isFetching && offset === 0;
  const loadingMore = search.isFetching && offset > 0;

  return (
    <div className="content-wrap">
      <section className="mb-6">
        <div className="eyebrow">{t('explore.eyebrow')}</div>
        <h1 className="page-title mt-3">{t('explore.title')}</h1>
        <p className="page-subtitle">{t('explore.subtitle')}</p>
      </section>

      <SearchBar qDraft={qDraft} setQDraft={setQDraft} locationDraft={locationDraft} setLocationDraft={setLocationDraft} onSubmit={runSearch} />

      {active && (
        <div className="flex items-center gap-3 mt-4">
          <select
            className="select w-auto min-w-[160px]"
            value={source}
            onChange={(event) => handleSourceChange(event.target.value)}
            data-testid="select-explore-source"
          >
            <option value="">{t('explore.allSources')}</option>
            {sourceOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
          {searching && <span className="text-xs text-[hsl(var(--muted-foreground))]" data-testid="status-explore-searching">{t('explore.searching')}</span>}
        </div>
      )}

      <div className="grid gap-4 mt-6">
        {!active && (
          <section className="surface">
            <EmptyState title={t('explore.promptTitle')} body={t('explore.promptBody')} />
          </section>
        )}

        {active && !searching && items.length === 0 && (
          <section className="surface">
            <EmptyState title={t('explore.noResultsTitle')} body={t('explore.noResultsBody')} />
          </section>
        )}

        {items.map((posting) => <ExploreCard key={posting.id} posting={posting} onAdded={handleAdded} />)}

        {items.length > 0 && hasMore && (
          <button
            className="btn btn-ghost justify-self-center"
            onClick={() => setOffset((value) => value + PAGE_SIZE)}
            disabled={loadingMore}
            data-testid="button-explore-load-more"
          >
            {loadingMore ? t('explore.loadingMore') : t('explore.loadMore')}
          </button>
        )}
      </div>
    </div>
  );
}
