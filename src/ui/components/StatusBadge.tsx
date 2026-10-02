/**
 * Result category badge.
 *
 * WCAG 1.4.1 forbids colour being the only carrier of meaning. Red/amber/green
 * badges alone are unreadable for the roughly 1 in 12 men with a colour vision
 * deficiency — a particularly poor failure in an application whose whole purpose is
 * to take subjective colour judgement out of the process.
 *
 * Each category is therefore signalled three ways: a distinct glyph, the category
 * word in text, and the colour. The glyph is aria-hidden because the adjacent word
 * already names the category and a screen reader should not say it twice.
 *
 * Shared rather than duplicated per screen so the three surfaces that show a
 * verdict cannot drift apart.
 */

export type ResultCategory = 'positive' | 'negative' | 'inconclusive';

const CATEGORY_GLYPH: Record<string, string> = {
  positive: '▲',
  negative: '●',
  inconclusive: '◆',
};

export function StatusBadge({
  category,
  uppercase = true,
}: {
  category: string;
  uppercase?: boolean;
}) {
  return (
    <span className={`badge ${category}`}>
      <span className="badge-glyph" aria-hidden="true">
        {CATEGORY_GLYPH[category] ?? '■'}
      </span>
      {uppercase ? category.toUpperCase() : category}
    </span>
  );
}
