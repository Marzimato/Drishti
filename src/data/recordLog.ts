/**
 * The test log: append-only, hash-chained, searchable.
 *
 * The chain logic lives here rather than in the database adapter so it can be
 * tested exhaustively against an in-memory store, without needing IndexedDB or a
 * browser. `RecordPersistence` is the seam; Dexie is one implementation of it.
 *
 * The critical invariant this module owns: **appends are serialised**. Two captures
 * completing at nearly the same moment must not both read the same "latest record"
 * and then both claim the same chain index with the same previous-hash. That would
 * fork the chain and make the log unverifiable. Since IndexedDB transactions cannot
 * span the `await` of a signing operation, the mutual exclusion is enforced here
 * with an explicit append queue.
 */

import {
  GENESIS_HASH,
  recordHash,
  verifyChain,
  verifyRecord,
  type ChainVerificationResult,
  type SignedTestRecord,
  type TestRecordCore,
  type VerificationResult,
} from '../core/record/record';

export type SyncState = 'pending' | 'synced' | 'failed';

export interface StoredRecord {
  recordId: string;
  chainIndex: number;
  capturedAt: string;
  operatorId: string;
  category: string;
  panelId: string;
  caseReference?: string;
  captureAccepted: boolean;
  syncState: SyncState;
  /** The signed record exactly as it was signed. Never mutate this. */
  record: SignedTestRecord;
  /** Captured frame, kept locally so the image hash can be re-verified offline. */
  image?: Blob;
  rectified?: Blob;
}

export interface RecordPersistence {
  put(entry: StoredRecord): Promise<void>;
  get(recordId: string): Promise<StoredRecord | undefined>;
  /** Every entry, ascending by chain index. */
  all(): Promise<StoredRecord[]>;
  latest(): Promise<StoredRecord | undefined>;
  count(): Promise<number>;
  updateSyncState(recordId: string, state: SyncState): Promise<void>;
}

/** In-memory persistence, used by tests and as a fallback when storage is denied. */
export class InMemoryPersistence implements RecordPersistence {
  private readonly entries = new Map<string, StoredRecord>();

  async put(entry: StoredRecord): Promise<void> {
    this.entries.set(entry.recordId, entry);
  }

  async get(recordId: string): Promise<StoredRecord | undefined> {
    return this.entries.get(recordId);
  }

  async all(): Promise<StoredRecord[]> {
    return [...this.entries.values()].sort((a, b) => a.chainIndex - b.chainIndex);
  }

  async latest(): Promise<StoredRecord | undefined> {
    const all = await this.all();
    return all[all.length - 1];
  }

  async count(): Promise<number> {
    return this.entries.size;
  }

  async updateSyncState(recordId: string, state: SyncState): Promise<void> {
    const entry = this.entries.get(recordId);
    if (!entry) throw new Error(`No record ${recordId}`);
    this.entries.set(recordId, { ...entry, syncState: state });
  }
}

/** What the next record must commit to in order to extend the chain. */
export interface ChainPosition {
  index: number;
  previousRecordHash: string;
}

export interface RecordSearchFilters {
  /** Case-insensitive match against case reference, operator, label and notes. */
  text?: string;
  category?: 'positive' | 'negative' | 'inconclusive';
  panelId?: string;
  operatorId?: string;
  /** Inclusive ISO bounds on capturedAt. */
  from?: string;
  to?: string;
  syncState?: SyncState;
  /** When false, only accepted captures are returned. */
  includeRejected?: boolean;
}

export type SignCallback = (position: ChainPosition) => Promise<{
  core: TestRecordCore;
  signed: SignedTestRecord;
  image?: Blob;
  rectified?: Blob;
}>;

export class RecordLog {
  /**
   * Serialises appends. Each append chains onto this promise, so the read of the
   * current chain head and the write of the new record cannot interleave.
   */
  private appendQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly persistence: RecordPersistence) {}

  /** Chain position the next appended record must use. */
  async nextChainPosition(): Promise<ChainPosition> {
    const latest = await this.persistence.latest();
    if (!latest) return { index: 0, previousRecordHash: GENESIS_HASH };
    return {
      index: latest.chainIndex + 1,
      previousRecordHash: await recordHash(latest.record),
    };
  }

  /**
   * Appends a record.
   *
   * The caller supplies a callback that receives the chain position and returns a
   * signed record built with it. Structuring it this way means the signing step
   * happens *inside* the serialised section, so a concurrent capture cannot sign
   * against a stale chain head.
   */
  async append(sign: SignCallback): Promise<StoredRecord> {
    const run = async (): Promise<StoredRecord> => {
      const position = await this.nextChainPosition();
      const { signed, image, rectified } = await sign(position);

      if (signed.chain.index !== position.index) {
        throw new Error(
          `Signed record claims chain index ${signed.chain.index} but ${position.index} was assigned`,
        );
      }
      if (signed.chain.previousRecordHash !== position.previousRecordHash) {
        throw new Error('Signed record does not commit to the current chain head');
      }

      const entry: StoredRecord = {
        recordId: signed.recordId,
        chainIndex: signed.chain.index,
        capturedAt: signed.capturedAt,
        operatorId: signed.operator.id,
        category: signed.result.category,
        panelId: signed.panelId,
        caseReference: signed.caseReference,
        captureAccepted: signed.captureAccepted,
        syncState: 'pending',
        record: signed,
        image,
        rectified,
      };

      await this.persistence.put(entry);
      return entry;
    };

    // Chain onto the queue, and keep the queue alive even if this append fails.
    const result = this.appendQueue.then(run, run);
    this.appendQueue = result.catch(() => undefined);
    return result;
  }

  async get(recordId: string): Promise<StoredRecord | undefined> {
    return this.persistence.get(recordId);
  }

  async count(): Promise<number> {
    return this.persistence.count();
  }

  async all(): Promise<StoredRecord[]> {
    return this.persistence.all();
  }

  /** Most recent first, which is the order the log screen wants. */
  async search(filters: RecordSearchFilters = {}): Promise<StoredRecord[]> {
    const all = await this.persistence.all();
    const needle = filters.text?.trim().toLowerCase();

    const matches = all.filter((entry) => {
      if (filters.category && entry.category !== filters.category) return false;
      if (filters.panelId && entry.panelId !== filters.panelId) return false;
      if (filters.operatorId && entry.operatorId !== filters.operatorId) return false;
      if (filters.syncState && entry.syncState !== filters.syncState) return false;
      if (!filters.includeRejected && !entry.captureAccepted) return false;
      if (filters.from && entry.capturedAt < filters.from) return false;
      if (filters.to && entry.capturedAt > filters.to) return false;

      if (needle) {
        const haystack = [
          entry.caseReference,
          entry.operatorId,
          entry.record.operator.displayName,
          entry.record.result.label,
          entry.record.operatorNotes,
          entry.record.panelName,
          entry.record.kitLotNumber,
        ]
          .filter((value): value is string => typeof value === 'string')
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(needle)) return false;
      }

      return true;
    });

    return matches.sort((a, b) => b.chainIndex - a.chainIndex);
  }

  async verifyOne(recordId: string): Promise<VerificationResult | undefined> {
    const entry = await this.persistence.get(recordId);
    if (!entry) return undefined;

    const all = await this.persistence.all();
    const position = all.findIndex((candidate) => candidate.recordId === recordId);
    const previous = position > 0 ? all[position - 1].record : null;

    const imageBytes = entry.image ? new Uint8Array(await entry.image.arrayBuffer()) : undefined;

    return verifyRecord(entry.record, {
      previousRecord: previous,
      ...(imageBytes ? { imageBytes } : {}),
    });
  }

  /** Verifies the whole log, including linkage. */
  async verifyAll(): Promise<ChainVerificationResult> {
    const all = await this.persistence.all();
    return verifyChain(all.map((entry) => entry.record));
  }

  async markSynced(recordId: string): Promise<void> {
    await this.persistence.updateSyncState(recordId, 'synced');
  }

  async markSyncFailed(recordId: string): Promise<void> {
    await this.persistence.updateSyncState(recordId, 'failed');
  }

  async pendingSync(): Promise<StoredRecord[]> {
    const all = await this.persistence.all();
    return all.filter((entry) => entry.syncState === 'pending');
  }

  /** JSON export of the signed records, suitable for evidential handoff. */
  async exportJson(): Promise<string> {
    const all = await this.persistence.all();
    return JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        recordCount: all.length,
        note:
          'Each record is individually signed and hash-chained to its predecessor. ' +
          'Verify with the DRISHTI verifier or any ECDSA P-256 implementation. ' +
          'Results are presumptive field screens and do not replace laboratory confirmation.',
        records: all.map((entry) => entry.record),
      },
      null,
      2,
    );
  }

  /** CSV summary for spreadsheet review. Not the evidential artefact. */
  async exportCsv(): Promise<string> {
    const all = await this.persistence.all();
    const columns = [
      'chain_index',
      'record_id',
      'captured_at_utc',
      'operator_id',
      'case_reference',
      'panel',
      'capture_accepted',
      'category',
      'outcome',
      'confidence',
      'match_delta_e',
      'latitude',
      'longitude',
      'accuracy_m',
      'reference_provenance',
      'requires_lab_confirmation',
      'sync_state',
    ];

    const escape = (value: unknown): string => {
      if (value === null || value === undefined) return '';
      const text = String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const rows = all.map((entry) => {
      const r = entry.record;
      return [
        r.chain.index,
        r.recordId,
        r.capturedAt,
        r.operator.id,
        r.caseReference,
        r.panelName,
        r.captureAccepted,
        r.result.category,
        r.result.outcomeId,
        r.result.confidence,
        r.result.matchDeltaE?.toFixed(2),
        r.location?.latitude,
        r.location?.longitude,
        r.location?.accuracyMetres,
        r.result.referenceProvenance,
        'yes',
        entry.syncState,
      ]
        .map(escape)
        .join(',');
    });

    return `${[columns.join(','), ...rows].join('\n')}\n`;
  }
}
