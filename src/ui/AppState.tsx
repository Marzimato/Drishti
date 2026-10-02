/**
 * Application state: operator session, device identity, and the record log.
 *
 * ON THE PIN: this is prototype-level authentication and is labelled as such in the
 * UI. It gates access to the app and binds an operator identifier to each record,
 * which is what the problem statement asks for. It is deliberately *not* presented
 * as strong authentication: the PIN is stored as a salted SHA-256 hash, but a PIN
 * has little entropy and the device signing key is not derived from it, so an
 * attacker with the unlocked device is not stopped by it. A deployment would bind
 * operator identity to the department's existing directory and, ideally, gate
 * signing behind a platform biometric prompt.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  DexiePersistence,
  loadOrCreateDeviceKeys,
  readSetting,
  storageAvailable,
  writeSetting,
} from '../data/db';
import { InMemoryPersistence, RecordLog, type RecordPersistence } from '../data/recordLog';
import {
  generateDeviceKeyPair,
  publicKeyFingerprint,
  sha256HexOfText,
  toHex,
} from '../core/record/crypto';
import type { OperatorIdentity } from '../core/record/record';
import { NOMINAL_CALIBRATION, type CardCalibration } from '../core/card/spec';
import { isSecureContextOk } from './lib/browser';

export type Screen = 'capture' | 'result' | 'log' | 'detail' | 'settings' | 'card';

export type ThemePreference = 'light' | 'dark';

/**
 * Text size steps for the A- / A / A+ control.
 *
 * Indian government sites carry this control as standard and GIGW expects it. It is
 * not redundant with browser zoom: on a shared or kiosk device the operator often
 * cannot change browser settings, and on a phone held at arm's length in daylight a
 * larger base size is the difference between readable and not.
 *
 * Implemented as a root font-size multiplier, so every rem-based token scales with
 * it rather than only body copy.
 */
export type TextScale = 'normal' | 'large' | 'larger';

export const TEXT_SCALE_FACTOR: Record<TextScale, number> = {
  normal: 1,
  large: 1.125,
  larger: 1.3,
};

export interface AppSession {
  ready: boolean;
  unlocked: boolean;
  /** True until a PIN has been chosen for the first time. */
  needsEnrolment: boolean;
  operator: OperatorIdentity | null;
  deviceId: string;
  deviceKeys: { privateKey: CryptoKey; publicKey: CryptoKey } | null;
  fingerprint: string;
  calibration: CardCalibration;
  log: RecordLog;
  usingPersistentStorage: boolean;
  initError: string | null;
}

export interface AppContextValue extends AppSession {
  screen: Screen;
  navigate: (screen: Screen) => void;
  selectedRecordId: string | null;
  selectRecord: (recordId: string | null) => void;
  enrol: (pin: string, operator: OperatorIdentity) => Promise<void>;
  unlock: (pin: string) => Promise<boolean>;
  lock: () => void;
  saveOperator: (operator: OperatorIdentity) => Promise<void>;
  saveCalibration: (calibration: CardCalibration) => Promise<void>;
  theme: ThemePreference;
  toggleTheme: () => void;
  textScale: TextScale;
  setTextScale: (scale: TextScale) => void;
  highContrast: boolean;
  toggleHighContrast: () => void;
  /** True when the page is on a secure origin and the signing key is loaded. */
  secure: boolean;
  /** Bumped whenever the log changes, so screens can refetch. */
  logRevision: number;
  noteLogChanged: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

const SETTING_PIN = 'operator-pin';
const SETTING_OPERATOR = 'operator-identity';
const SETTING_DEVICE_ID = 'device-id';
const SETTING_CALIBRATION = 'card-calibration';
const SETTING_THEME = 'theme-preference';
const SETTING_TEXT_SCALE = 'text-scale';
const SETTING_HIGH_CONTRAST = 'high-contrast';

interface StoredPin {
  saltHex: string;
  hashHex: string;
}

function randomSaltHex(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/**
 * The 'chromalog-pin' domain separator predates the rename to DRISHTI and must not
 * change. It is an input to the stored PIN hash, so renaming it would make every
 * already-enrolled operator's correct PIN compare as wrong, with no way to recover
 * the account short of clearing storage — which would also orphan the signed log.
 * A cosmetic rename is not worth locking a user out of their own records.
 */
async function hashPin(pin: string, saltHex: string): Promise<string> {
  return sha256HexOfText(`chromalog-pin:${saltHex}:${pin}`);
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [screen, setScreen] = useState<Screen>('capture');
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const [logRevision, setLogRevision] = useState(0);

  const [ready, setReady] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [needsEnrolment, setNeedsEnrolment] = useState(false);
  const [operator, setOperator] = useState<OperatorIdentity | null>(null);
  const [deviceId, setDeviceId] = useState('');
  const [deviceKeys, setDeviceKeys] = useState<AppSession['deviceKeys']>(null);
  const [fingerprint, setFingerprint] = useState('');
  const [calibration, setCalibration] = useState<CardCalibration>(NOMINAL_CALIBRATION);
  const [persistence, setPersistence] = useState<RecordPersistence | null>(null);
  const [usingPersistentStorage, setUsingPersistentStorage] = useState(true);
  const [initError, setInitError] = useState<string | null>(null);

  /**
   * Light is the default because that is the convention for Indian government
   * services. Dark is retained for night field use: a full-brightness white screen
   * destroys an officer's dark adaptation and is conspicuous at a roadside stop.
   */
  const [theme, setTheme] = useState<ThemePreference>('light');
  const [textScale, setTextScaleState] = useState<TextScale>('normal');
  const [highContrast, setHighContrast] = useState(false);

  // Reflect presentation preferences on the root element so the CSS token
  // overrides apply, and so the text scale multiplies every rem-based token.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.contrast = highContrast ? 'high' : 'normal';
    root.style.fontSize = `${16 * TEXT_SCALE_FACTOR[textScale]}px`;
  }, [theme, textScale, highContrast]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const persistent = await storageAvailable();
        if (cancelled) return;

        // Falling back to memory keeps the app usable in private browsing, but the
        // operator must be told their log will not survive a reload.
        const store: RecordPersistence = persistent
          ? new DexiePersistence()
          : new InMemoryPersistence();
        setUsingPersistentStorage(persistent);
        setPersistence(store);

        const keyRow = await loadOrCreateDeviceKeys(generateDeviceKeyPair);
        if (cancelled) return;
        setDeviceKeys({ privateKey: keyRow.privateKey, publicKey: keyRow.publicKey });
        setFingerprint(await publicKeyFingerprint(keyRow.publicKey));

        let id = await readSetting<string>(SETTING_DEVICE_ID);
        if (!id) {
          id = `device-${randomSaltHex().slice(0, 12)}`;
          await writeSetting(SETTING_DEVICE_ID, id);
        }
        if (cancelled) return;
        setDeviceId(id);

        const storedOperator = await readSetting<OperatorIdentity>(SETTING_OPERATOR);
        if (storedOperator) setOperator(storedOperator);

        const storedCalibration = await readSetting<CardCalibration>(SETTING_CALIBRATION);
        if (storedCalibration) setCalibration(storedCalibration);

        const storedScale = await readSetting<TextScale>(SETTING_TEXT_SCALE);
        if (storedScale) setTextScaleState(storedScale);

        const storedContrast = await readSetting<boolean>(SETTING_HIGH_CONTRAST);
        if (typeof storedContrast === 'boolean') setHighContrast(storedContrast);

        const storedTheme = await readSetting<ThemePreference>(SETTING_THEME);
        if (storedTheme) {
          setTheme(storedTheme);
        } else if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
          // No stored choice yet, so follow the operating system on first run.
          setTheme('dark');
        }

        const storedPin = await readSetting<StoredPin>(SETTING_PIN);
        setNeedsEnrolment(!storedPin);

        setReady(true);
      } catch (error) {
        if (cancelled) return;
        setInitError(
          error instanceof Error
            ? error.message
            : 'Could not start up. Check that the page is served over HTTPS.',
        );
        setReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const log = useMemo(
    () => new RecordLog(persistence ?? new InMemoryPersistence()),
    [persistence],
  );

  const noteLogChanged = useCallback(() => setLogRevision((value) => value + 1), []);

  const enrol = useCallback(async (pin: string, nextOperator: OperatorIdentity) => {
    const saltHex = randomSaltHex();
    const hashHex = await hashPin(pin, saltHex);
    await writeSetting(SETTING_PIN, { saltHex, hashHex } satisfies StoredPin);
    await writeSetting(SETTING_OPERATOR, nextOperator);
    setOperator(nextOperator);
    setNeedsEnrolment(false);
    setUnlocked(true);
  }, []);

  const unlock = useCallback(async (pin: string) => {
    const stored = await readSetting<StoredPin>(SETTING_PIN);
    if (!stored) return false;
    const candidate = await hashPin(pin, stored.saltHex);
    const ok = candidate === stored.hashHex;
    if (ok) setUnlocked(true);
    return ok;
  }, []);

  const lock = useCallback(() => {
    setUnlocked(false);
    setScreen('capture');
  }, []);

  const saveOperator = useCallback(async (nextOperator: OperatorIdentity) => {
    await writeSetting(SETTING_OPERATOR, nextOperator);
    setOperator(nextOperator);
  }, []);

  const saveCalibration = useCallback(async (next: CardCalibration) => {
    await writeSetting(SETTING_CALIBRATION, next);
    setCalibration(next);
  }, []);

  const setTextScale = useCallback((scale: TextScale) => {
    setTextScaleState(scale);
    void writeSetting(SETTING_TEXT_SCALE, scale).catch(() => undefined);
  }, []);

  const toggleHighContrast = useCallback(() => {
    setHighContrast((current) => {
      const next = !current;
      void writeSetting(SETTING_HIGH_CONTRAST, next).catch(() => undefined);
      return next;
    });
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next: ThemePreference = current === 'light' ? 'dark' : 'light';
      // Persisting is a convenience, not a correctness requirement, so a storage
      // failure must not prevent the theme from changing.
      void writeSetting(SETTING_THEME, next).catch(() => undefined);
      return next;
    });
  }, []);

  const navigate = useCallback((next: Screen) => setScreen(next), []);
  const selectRecord = useCallback((recordId: string | null) => {
    setSelectedRecordId(recordId);
    if (recordId) setScreen('detail');
  }, []);

  const value: AppContextValue = {
    ready,
    unlocked,
    needsEnrolment,
    operator,
    deviceId,
    deviceKeys,
    fingerprint,
    calibration,
    log,
    usingPersistentStorage,
    initError,
    screen,
    navigate,
    selectedRecordId,
    selectRecord,
    enrol,
    unlock,
    lock,
    saveOperator,
    saveCalibration,
    theme,
    toggleTheme,
    textScale,
    setTextScale,
    highContrast,
    toggleHighContrast,
    /*
     * The SECURE indicator reflects real state rather than decoration: a secure
     * origin (without which WebCrypto is unavailable) and a loaded signing key.
     * Showing a reassuring badge that did not depend on anything would be worse
     * than showing none.
     */
    secure: isSecureContextOk() && deviceKeys !== null,
    logRevision,
    noteLogChanged,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside AppProvider');
  return value;
}
