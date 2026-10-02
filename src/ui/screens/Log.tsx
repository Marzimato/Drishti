import { useCallback, useEffect, useId, useState } from 'react';
import { useApp } from '../AppState';
import { REAGENT_PANELS } from '../../core/classify/panels';
import type { StoredRecord } from '../../data/recordLog';
import { downloadText } from '../lib/browser';
import { StatusBadge } from '../components/StatusBadge';

/**
 * Searchable test log.
 *
 * Refused captures are hidden by default but never deleted, and the filter to show
 * them is right there. A log that quietly omitted failed attempts would be a
 * misleading account of what happened.
 */
export function LogScreen() {
  const app = useApp();
  const ids = {
    search: useId(),
    category: useId(),
    panel: useId(),
    from: useId(),
    to: useId(),
    rejected: useId(),
  };
  const [entries, setEntries] = useState<StoredRecord[]>([]);
  const [text, setText] = useState('');
  const [category, setCategory] = useState('');
  const [panelId, setPanelId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [includeRejected, setIncludeRejected] = useState(false);
  const [chainStatus, setChainStatus] = useState<string | null>(null);
  const [total, setTotal] = useState(0);

  const refresh = useCallback(async () => {
    const results = await app.log.search({
      text: text || undefined,
      category: (category || undefined) as 'positive' | 'negative' | 'inconclusive' | undefined,
      panelId: panelId || undefined,
      from: from ? new Date(from).toISOString() : undefined,
      to: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined,
      includeRejected,
    });
    setEntries(results);
    setTotal(await app.log.count());
  }, [app.log, category, from, includeRejected, panelId, text, to]);

  useEffect(() => {
    void refresh();
  }, [refresh, app.logRevision]);

  const verifyChain = useCallback(async () => {
    setChainStatus('Verifying…');
    const result = await app.log.verifyAll();
    setChainStatus(
      result.valid
        ? `Chain intact. All ${total} record${total === 1 ? '' : 's'} verified.`
        : `Chain broken at record index ${result.firstInvalidIndex}.`,
    );
  }, [app.log, total]);

  const exportJson = useCallback(async () => {
    downloadText('drishti-records.json', await app.log.exportJson(), 'application/json');
  }, [app.log]);

  const exportCsv = useCallback(async () => {
    downloadText('drishti-records.csv', await app.log.exportCsv(), 'text/csv');
  }, [app.log]);

  return (
    <div className="screen log">
      <h1>Test log</h1>

      <section className="filters" aria-labelledby="filters-heading">
        <h2 id="filters-heading" className="sr-only">
          Filter records
        </h2>

        <div className="field">
          <label htmlFor={ids.search}>Search</label>
          <input
            id={ids.search}
            type="search"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Case, operator or notes"
          />
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor={ids.category}>Result</label>
            <select
              id={ids.category}
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            >
              <option value="">All results</option>
              <option value="positive">Positive</option>
              <option value="negative">Negative</option>
              <option value="inconclusive">Inconclusive</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor={ids.panel}>Reagent</label>
            <select
              id={ids.panel}
              value={panelId}
              onChange={(event) => setPanelId(event.target.value)}
            >
              <option value="">All reagents</option>
              {REAGENT_PANELS.map((panel) => (
                <option key={panel.id} value={panel.id}>
                  {panel.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor={ids.from}>From date</label>
            <input
              id={ids.from}
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={ids.to}>To date</label>
            <input
              id={ids.to}
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </div>
        </div>

        <div className="checkbox-row">
          <input
            id={ids.rejected}
            type="checkbox"
            checked={includeRejected}
            onChange={(event) => setIncludeRejected(event.target.checked)}
          />
          <label htmlFor={ids.rejected}>Include refused captures</label>
        </div>
      </section>

      <div className="actions">
        <button onClick={verifyChain}>Verify whole log</button>
        <button onClick={exportJson}>Export JSON</button>
        <button onClick={exportCsv}>Export CSV</button>
      </div>

      {/* Verification outcome must be announced, not just rendered. */}
      <div role="status" aria-live="polite">
        {chainStatus && <p className="muted">{chainStatus}</p>}
        <p className="muted">
          Showing {entries.length} of {total} recorded {total === 1 ? 'entry' : 'entries'}.
        </p>
      </div>

      <ul className="record-list">
        {entries.map((entry) => (
          <li key={entry.recordId}>
            <button className="record-row" onClick={() => app.selectRecord(entry.recordId)}>
              <StatusBadge category={entry.category} />
              <span className="record-main">
                <strong>{entry.caseReference ?? 'No case reference'}</strong>
                <span className="muted">
                  {new Date(entry.capturedAt).toLocaleString()} · {entry.record.panelName}
                </span>
              </span>
              <span className="record-meta">
                <span className="muted">#{entry.chainIndex}</span>
                {!entry.captureAccepted && <span className="tag">refused</span>}
                {entry.syncState === 'pending' && <span className="tag">unsynced</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {entries.length === 0 && (
        <p className="muted">
          No records match. {total > 0 && 'Try clearing the filters or including refused captures.'}
        </p>
      )}
    </div>
  );
}
