/**
 * IndexedDB persistence via Dexie.
 *
 * A thin adapter over the storage seam defined in recordLog.ts. All the logic
 * worth testing lives there; this file only maps it onto IndexedDB.
 *
 * Note on key storage: non-extractable `CryptoKey` objects are structured-
 * cloneable, so they can be persisted in IndexedDB and reloaded across sessions
 * while the private key material itself remains unreadable by JavaScript. That is
 * what lets the device keep a stable signing identity without ever exposing the
 * private key, even to this application's own code.
 */

import Dexie, { type Table } from 'dexie';
import type { RecordPersistence, StoredRecord, SyncState } from './recordLog';

export interface SettingsRow {
  key: string;
  value: unknown;
}

export interface DeviceKeyRow {
  id: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  createdAt: string;
}

/**
 * The IndexedDB database name is 'chromalog' and must stay that way.
 *
 * The application was renamed to DRISHTI, but the database name is not a label —
 * it is the address of the stored data. Changing it does not migrate anything: the
 * browser opens a different, empty database, and every signed record, the
 * operator enrolment, and the non-extractable device signing key are all still on
 * disk but unreachable. For a tamper-evident log that would be the worst possible
 * outcome of a cosmetic change, so the old name stays. Rename it only alongside a
 * real Dexie migration that copies the stores across.
 */
const DATABASE_NAME = 'chromalog';

class DrishtiDatabase extends Dexie {
  records!: Table<StoredRecord, string>;
  settings!: Table<SettingsRow, string>;
  deviceKeys!: Table<DeviceKeyRow, string>;

  constructor() {
    super(DATABASE_NAME);
    this.version(1).stores({
      // Indexed on the fields the log screen filters by.
      records:
        '&recordId, chainIndex, capturedAt, operatorId, category, panelId, caseReference, syncState',
      settings: '&key',
      deviceKeys: '&id',
    });
  }
}

let database: DrishtiDatabase | null = null;

export function db(): DrishtiDatabase {
  if (!database) database = new DrishtiDatabase();
  return database;
}

export class DexiePersistence implements RecordPersistence {
  async put(entry: StoredRecord): Promise<void> {
    await db().records.put(entry);
  }

  async get(recordId: string): Promise<StoredRecord | undefined> {
    return db().records.get(recordId);
  }

  async all(): Promise<StoredRecord[]> {
    return db().records.orderBy('chainIndex').toArray();
  }

  async latest(): Promise<StoredRecord | undefined> {
    return db().records.orderBy('chainIndex').last();
  }

  async count(): Promise<number> {
    return db().records.count();
  }

  async updateSyncState(recordId: string, state: SyncState): Promise<void> {
    const updated = await db().records.update(recordId, { syncState: state });
    if (updated === 0) throw new Error(`No record ${recordId}`);
  }
}

/* ------------------------------------------------------------------ settings */

export async function readSetting<T>(key: string): Promise<T | undefined> {
  const row = await db().settings.get(key);
  return row?.value as T | undefined;
}

export async function writeSetting(key: string, value: unknown): Promise<void> {
  await db().settings.put({ key, value });
}

/* --------------------------------------------------------------- device keys */

const DEVICE_KEY_ID = 'device-signing-key';

/**
 * Loads the device signing key pair, creating it on first run.
 *
 * The key is generated non-extractable, so copying the IndexedDB files off the
 * device does not yield a usable signing key.
 */
export async function loadOrCreateDeviceKeys(
  generate: () => Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }>,
): Promise<DeviceKeyRow> {
  const existing = await db().deviceKeys.get(DEVICE_KEY_ID);
  if (existing) return existing;

  const pair = await generate();
  const row: DeviceKeyRow = {
    id: DEVICE_KEY_ID,
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    createdAt: new Date().toISOString(),
  };
  await db().deviceKeys.put(row);
  return row;
}

/** True when IndexedDB is usable. Private browsing modes sometimes deny it. */
export async function storageAvailable(): Promise<boolean> {
  try {
    await db().settings.get('probe');
    return true;
  } catch {
    return false;
  }
}
