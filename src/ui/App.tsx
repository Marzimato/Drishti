import { useCallback, useId, useState } from 'react';
import { AppProvider, useApp, type Screen } from './AppState';
import { CaptureScreen, type CaptureCompletion } from './screens/Capture';
import { ResultScreen } from './screens/Result';
import { LogScreen } from './screens/Log';
import { DetailScreen } from './screens/Detail';
import { SettingsScreen } from './screens/Settings';
import { CardPrintScreen } from './screens/CardPrint';

export function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}

/**
 * First-run enrolment and PIN unlock.
 *
 * Every control has an explicitly associated label (GIGW requires the `for`/`id`
 * pairing rather than relying on wrapping), errors are announced via role="alert",
 * and invalid fields are marked with aria-invalid so assistive technology reports
 * the state rather than only the colour.
 */
function Gate() {
  const app = useApp();
  const ids = {
    operator: useId(),
    name: useId(),
    pin: useId(),
    confirm: useId(),
    error: useId(),
    pinHint: useId(),
  };

  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [operatorId, setOperatorId] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [invalidField, setInvalidField] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    setError(null);
    setInvalidField(null);
    setBusy(true);
    try {
      if (app.needsEnrolment) {
        if (!operatorId.trim()) {
          setError('Enter your service identifier.');
          setInvalidField('operator');
          return;
        }
        if (pin.length < 4) {
          setError('Choose a PIN of at least 4 digits.');
          setInvalidField('pin');
          return;
        }
        if (pin !== confirmPin) {
          setError('The two PINs do not match.');
          setInvalidField('confirm');
          return;
        }
        await app.enrol(pin, {
          id: operatorId.trim(),
          displayName: name.trim() || undefined,
        });
      } else {
        const ok = await app.unlock(pin);
        if (!ok) {
          setError('Incorrect PIN.');
          setInvalidField('pin');
        }
      }
    } finally {
      setBusy(false);
    }
  }, [app, confirmPin, name, operatorId, pin]);

  return (
    <main className="screen gate" id="main-content">
      <div className="gate-brand">
        <img
          className="gate-logo"
          src="./logo.svg"
          alt=""
          aria-hidden="true"
          width={72}
          height={72}
        />
        <h1>DRISHTI</h1>
      </div>
      <p className="muted">
        Drug Sample Imaging, Standardization &amp; Testing Information System.
      </p>
      <p className="muted small">
        Colour-calibrated field test capture with tamper-evident records.
      </p>

      {app.needsEnrolment ? (
        <section className="panel" aria-labelledby="enrol-heading">
          <h2 id="enrol-heading">Set up this device</h2>

          <div className="field">
            <label htmlFor={ids.operator}>Service identifier</label>
            <input
              id={ids.operator}
              value={operatorId}
              onChange={(event) => setOperatorId(event.target.value)}
              placeholder="OFFICER-0000"
              autoComplete="username"
              aria-invalid={invalidField === 'operator'}
              aria-describedby={error && invalidField === 'operator' ? ids.error : undefined}
            />
          </div>

          <div className="field">
            <label htmlFor={ids.name}>Name (optional)</label>
            <input
              id={ids.name}
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="name"
            />
          </div>

          <div className="field">
            <label htmlFor={ids.pin}>Choose a PIN</label>
            <span className="field-hint" id={ids.pinHint}>
              At least 4 digits. You will need this each time the app is locked.
            </span>
            <input
              id={ids.pin}
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(event) => setPin(event.target.value)}
              autoComplete="new-password"
              aria-describedby={ids.pinHint}
              aria-invalid={invalidField === 'pin'}
            />
          </div>

          <div className="field">
            <label htmlFor={ids.confirm}>Confirm PIN</label>
            <input
              id={ids.confirm}
              type="password"
              inputMode="numeric"
              value={confirmPin}
              onChange={(event) => setConfirmPin(event.target.value)}
              autoComplete="new-password"
              aria-invalid={invalidField === 'confirm'}
            />
          </div>
        </section>
      ) : (
        <section className="panel" aria-labelledby="unlock-heading">
          <h2 id="unlock-heading">Unlock</h2>
          <div className="field">
            <label htmlFor={ids.pin}>PIN</label>
            <input
              id={ids.pin}
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(event) => setPin(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit();
              }}
              autoComplete="current-password"
              aria-invalid={invalidField === 'pin'}
              aria-describedby={error ? ids.error : undefined}
              autoFocus
            />
          </div>
        </section>
      )}

      {/* role="alert" so the message is announced the moment it appears. */}
      <div id={ids.error} role="alert" aria-live="assertive">
        {error && <p className="field-error">{error}</p>}
      </div>

      <button className="primary" onClick={submit} disabled={busy}>
        {busy ? 'Working…' : app.needsEnrolment ? 'Create operator profile' : 'Unlock'}
      </button>

      <p className="disclaimer">
        Prototype-level access control. It binds an operator identifier to each record;
        it is not strong authentication and does not protect the device signing key.
      </p>
    </main>
  );
}

/**
 * Accessibility utility bar.
 *
 * Text-size and high-contrast controls in this position are a standing convention
 * on Indian government sites and are expected by GIGW. They are not redundant with
 * browser zoom: on a shared or departmental device the operator often cannot change
 * browser settings, and outdoors at arm's length a larger base size is the
 * difference between legible and not.
 *
 * Note what is deliberately absent: a language switch. GIGW expects bilingual
 * delivery, and this prototype is English-only. A toggle that did nothing would be
 * worse than its absence, so the gap is recorded in the README instead of being
 * papered over with a dead control.
 */
function UtilityBar() {
  const app = useApp();

  return (
    <div className="utility-bar">
      <div className="utility-inner">
        <div className="text-size-group" role="group" aria-label="Text size">
          <span className="utility-label" aria-hidden="true">
            Text
          </span>
          <button
            className="utility-btn"
            onClick={() => app.setTextScale('normal')}
            aria-pressed={app.textScale === 'normal'}
            aria-label="Normal text size"
          >
            A
          </button>
          <button
            className="utility-btn larger-a"
            onClick={() => app.setTextScale('large')}
            aria-pressed={app.textScale === 'large'}
            aria-label="Large text size"
          >
            A
          </button>
          <button
            className="utility-btn largest-a"
            onClick={() => app.setTextScale('larger')}
            aria-pressed={app.textScale === 'larger'}
            aria-label="Largest text size"
          >
            A
          </button>
        </div>

        <div className="utility-actions">
          <button
            className="utility-btn wide"
            onClick={app.toggleHighContrast}
            aria-pressed={app.highContrast}
          >
            High contrast
          </button>
          {/*
            The label names the setting, not the next action. With aria-pressed
            present, a label of "Light" while dark mode is active announces as
            "Light, pressed" — which states the opposite of the truth. A toggle
            button's accessible name has to stay constant and let aria-pressed
            carry the state.
          */}
          <button
            className="utility-btn wide"
            onClick={app.toggleTheme}
            aria-pressed={app.theme === 'dark'}
          >
            Dark mode
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Security posture indicator.
 *
 * Reflects two real conditions: a secure origin, without which WebCrypto is
 * unavailable, and a loaded device signing key. It reports state rather than
 * reassuring — if either is missing it says so, because a badge that always read
 * "SECURE" would be decoration pretending to be information.
 */
function SecureIndicator({ secure }: { secure: boolean }) {
  return (
    <span className={`secure-chip ${secure ? 'is-secure' : 'not-secure'}`}>
      <span className="secure-dot" aria-hidden="true" />
      {secure ? 'SECURE' : 'UNSIGNED'}
      <span className="sr-only">
        {secure
          ? '. Secure connection and device signing key are available.'
          : '. Records cannot be signed: the connection is not secure or the signing key is unavailable.'}
      </span>
    </span>
  );
}

interface NavItem {
  screen: Screen;
  label: string;
  glyph: string;
  matches: Screen[];
}

const NAV_ITEMS: NavItem[] = [
  { screen: 'capture', label: 'Capture', glyph: '◉', matches: ['capture', 'result'] },
  { screen: 'log', label: 'Test log', glyph: '≡', matches: ['log', 'detail'] },
  { screen: 'card', label: 'Card', glyph: '▦', matches: ['card'] },
  { screen: 'settings', label: 'Settings', glyph: '⚙', matches: ['settings'] },
];

function Shell() {
  const app = useApp();
  const [completion, setCompletion] = useState<CaptureCompletion | null>(null);

  const onCaptureComplete = useCallback(
    (result: CaptureCompletion) => {
      setCompletion(result);
      app.navigate('result');
    },
    [app],
  );

  const newCapture = useCallback(() => {
    setCompletion(null);
    app.navigate('capture');
  }, [app]);

  if (!app.ready) {
    return (
      <main className="screen center" id="main-content">
        {/* Announced politely so a screen reader reports the wait. */}
        <p className="muted" role="status">
          Starting up…
        </p>
      </main>
    );
  }

  if (app.initError) {
    return (
      <main className="screen center" id="main-content">
        <h1>Cannot start</h1>
        <div role="alert">
          <p className="field-error">{app.initError}</p>
        </div>
        <p className="muted">
          Signing requires a secure connection. Serve the app over HTTPS, or use
          localhost.
        </p>
      </main>
    );
  }

  if (!app.unlocked) return <Gate />;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      <UtilityBar />

      {/* Decorative tricolour rule — carries no information. */}
      <div className="tricolour-rule" aria-hidden="true" />

      <header className="app-header">
        <div className="header-row">
          {/*
            The DRISHTI mark. This is the application's own identity, not the
            deploying authority's — deliberately NOT the State Emblem or any
            government insignia, since reproducing those in an unaffiliated prototype
            would be improper. A real deployment adds its own department identity
            alongside this.

            The PNG is decorative here: the service name sits next to it in text, so
            the mark carries no information a screen reader needs, hence aria-hidden
            and an empty alt.
          */}
          <img
            className="authority-mark"
            src="./logo.svg"
            alt=""
            aria-hidden="true"
            width={40}
            height={40}
          />
          <div className="header-titles">
            <p className="service-name">DRISHTI</p>
            {/*
              The expansion is given in full on the enrolment screen and in Settings.
              Here it would wrap to three lines on a phone and push the viewport
              below the fold, so the masthead carries the short form.
            */}
            <span className="authority-name">
              Drug Sample Imaging &amp; Testing · Prototype
            </span>
          </div>
          <SecureIndicator secure={app.secure} />
        </div>

        <div className="officer-row">
          <span className="officer-id">
            <span className="muted small">Officer</span>{' '}
            <strong>{app.operator?.id ?? '-'}</strong>
          </span>
          <button className="subtle small" onClick={() => app.navigate('settings')}>
            Profile
          </button>
          <button className="subtle small" onClick={app.lock}>
            Lock
          </button>
        </div>
      </header>

      <main className="app-main" id="main-content">
        {app.screen === 'capture' && <CaptureScreen onComplete={onCaptureComplete} />}
        {app.screen === 'result' &&
          (completion ? (
            <ResultScreen
              analysis={completion.analysis}
              recordId={completion.recordId}
              onNewCapture={newCapture}
            />
          ) : (
            <div className="screen">
              <p className="muted">No capture in this session yet.</p>
              <button className="primary" onClick={newCapture}>
                Capture
              </button>
            </div>
          ))}
        {app.screen === 'log' && <LogScreen />}
        {app.screen === 'detail' && <DetailScreen />}
        {app.screen === 'settings' && <SettingsScreen />}
        {app.screen === 'card' && <CardPrintScreen />}
      </main>

      <nav className="app-nav" aria-label="Main">
        {NAV_ITEMS.map((item) => {
          const active = item.matches.includes(app.screen);
          return (
            <button
              key={item.screen}
              onClick={() => app.navigate(item.screen)}
              /* aria-current tells assistive tech which section we are in;
                 the coloured bar alone would not. */
              aria-current={active ? 'page' : undefined}
            >
              <span className="nav-icon" aria-hidden="true">
                {item.glyph}
              </span>
              {item.label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
