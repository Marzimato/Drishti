import { useMemo } from 'react';
import { useApp } from '../AppState';
import { renderCardSvg } from '../../core/card/printable';
import { CARD_HEIGHT_MM, CARD_SPEC_VERSION, CARD_WIDTH_MM } from '../../core/card/spec';
import { downloadText } from '../lib/browser';

/**
 * In-app reference card, generated from the same spec the detector uses.
 *
 * Having the app produce the card removes the main way a system like this drifts
 * out of calibration: a printed card and software that disagree about where the
 * patches are. There is no separate artwork file to keep in sync.
 */
export function CardPrintScreen() {
  const app = useApp();
  const serial = app.calibration.cardSerial;

  const svg = useMemo(
    () => renderCardSvg({ serial, bleedMm: 3 }).replace(/^<\?xml[^>]*\?>\s*/, ''),
    [serial],
  );

  return (
    <div className="screen card-print">
      <h2>Reference card</h2>

      <section className="panel warn no-print">
        <h3>Print at 100% scale</h3>
        <p>
          Turn off "fit to page" and "shrink to printable area". After printing, measure the trim
          marks with a ruler: the card must be {CARD_WIDTH_MM} mm × {CARD_HEIGHT_MM} mm.
        </p>
        <p className="muted">
          Use matte white stock, such as PVC card blanks or heavy matte paper. Glossy stock
          produces specular glare, which the app will reject as uneven illumination.
        </p>
      </section>

      {/*
        This check is not housekeeping. Card revision 2 specified the lightest neutral
        as a 6% tint, which a dye-sublimation card printer did not transfer at all, and
        with no outline around the patch the missing one was indistinguishable from bare
        stock — so the card looked fine and could not be calibrated. Revision 3 raised
        the tint and outlined every patch; this panel tells the operator what to look at.
      */}
      <section className="panel warn no-print" aria-labelledby="patch-check-heading">
        <h3 id="patch-check-heading">Then check all twelve patches</h3>
        <p>
          Every patch is printed with a grey outline. Each of the twelve boxes must contain a
          visible tint, including the lightest grey, which is faint by design.
        </p>
        <p>
          <strong>An outlined box that looks empty means the printer did not lay that tint
          down.</strong> Reject the card and reprint it. Do not calibrate against a card with a
          missing patch: the correction is fitted on the six grey patches, so losing one
          weakens every reading that card produces.
        </p>
      </section>

      <div className="card-preview" dangerouslySetInnerHTML={{ __html: svg }} />

      <div className="actions no-print">
        <button className="primary" onClick={() => window.print()}>
          Print
        </button>
        <button
          onClick={() =>
            downloadText(`reference-card-${CARD_SPEC_VERSION}.svg`, renderCardSvg({ serial }), 'image/svg+xml')
          }
        >
          Download SVG
        </button>
        <button onClick={() => app.navigate('settings')}>Back to settings</button>
      </div>

      <section className="panel no-print">
        <h3>After printing</h3>
        <ol>
          <li>Trim on the crop marks.</li>
          <li>Optionally laminate with a matte laminate.</li>
          <li>Record the card serial in Settings so records identify which card was used.</li>
          <li>
            For absolute colour accuracy, measure each printed patch and load the measured values.
            Until then the app correctly reports its calibration as nominal.
          </li>
        </ol>
        <p className="muted">
          Card specification <code>{CARD_SPEC_VERSION}</code>. Records store this version, so a
          record captured against an older card stays interpretable.
        </p>
      </section>
    </div>
  );
}
