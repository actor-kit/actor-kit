import { useState } from "react";
import { ActorTable } from "../components/dashboard/actor-table";
import { ManualConnect } from "../components/dashboard/manual-connect";
import { Pager } from "../components/dashboard/pager";
import { TAP } from "../components/phone";
import { type ListState, PAGE_SIZE, useActorList, useActorTypes } from "../hooks/use-actor-list";

export { PAGE_SIZE } from "../hooks/use-actor-list";

const FILTER_CLASS = `bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-sm ${TAP}`;

export function DashboardPage() {
  const types = useActorTypes();
  const [typeFilter, setTypeFilter] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const list = useActorList({ typeFilter, search, offset });

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Actors</h1>

      {/* Filters: any change goes back to the first page. */}
      <div className="flex max-sm:flex-wrap gap-3 mb-4">
        <select
          value={typeFilter}
          onChange={(e) => {
            setTypeFilter(e.target.value);
            setOffset(0);
          }}
          className={FILTER_CLASS}
          data-testid="type-filter"
        >
          <option value="">All types</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Search actor ID..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOffset(0);
          }}
          className={`${FILTER_CLASS} flex-1 max-sm:basis-40 max-sm:min-w-0`}
          data-testid="search-input"
        />
      </div>

      <ListProblem list={list} />

      {/* Manual connect — always available: the registry is debounced and may
          not list an actor yet, or may be unavailable entirely. */}
      <ManualConnect />

      {list.kind === "loaded" && (
        <LoadedList
          list={list}
          offset={offset}
          onPrevious={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
          onNext={() => setOffset((o) => o + PAGE_SIZE)}
        />
      )}
    </div>
  );
}

/** Loading text, or the error with a sign-in link when access was refused. */
function ListProblem({ list }: { list: ListState }) {
  if (list.kind === "loading") return <p className="text-zinc-500">Loading...</p>;
  if (list.kind !== "failed") return null;
  return (
    <div className="mb-4">
      <p role="alert" className="text-red-400">
        {list.message}
      </p>
      {list.unauthorized && <SignInAgain />}
    </div>
  );
}

interface LoadedListProps {
  list: Extract<ListState, { kind: "loaded" }>;
  offset: number;
  onPrevious: () => void;
  onNext: () => void;
}

/** The table (or the empty state), with paging once there is more than one page. */
function LoadedList({ list, offset, onPrevious, onNext }: LoadedListProps) {
  return (
    <>
      {list.actors.length === 0 ? (
        <div className="text-zinc-500 border border-zinc-800 rounded p-6 text-center mb-6">
          <p>No actors found.</p>
        </div>
      ) : (
        <ActorTable actors={list.actors} />
      )}
      {(offset > 0 || list.hasMore) && (
        <Pager
          offset={offset}
          shown={list.actors.length}
          hasMore={list.hasMore}
          onPrevious={onPrevious}
          onNext={onNext}
        />
      )}
    </>
  );
}

/** ADR-014: production Studio sits behind Cloudflare Access; a full page load goes through its login. */
function SignInAgain() {
  return (
    <a
      href="/__studio/"
      className="mt-2 inline-block bg-zinc-700 hover:bg-zinc-600 px-3 py-1 rounded text-sm"
      data-testid="studio-sign-in"
    >
      Sign in through Cloudflare Access
    </a>
  );
}
