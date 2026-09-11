/**
 * Adjoining margins do not add up, they collapse: the largest positive and the most negative
 * are kept and the two are summed. Everything about margin collapsing reduces to holding
 * that pair and merging pairs together.
 */
export type CollapsedMargin = { positive: number; negative: number };

export const NO_MARGIN: CollapsedMargin = { positive: 0, negative: 0 };

export function withMargin(collapsed: CollapsedMargin, margin: number): CollapsedMargin {
  return margin >= 0
    ? { positive: Math.max(collapsed.positive, margin), negative: collapsed.negative }
    : { positive: collapsed.positive, negative: Math.min(collapsed.negative, margin) };
}

export function mergeMargins(a: CollapsedMargin, b: CollapsedMargin): CollapsedMargin {
  return {
    positive: Math.max(a.positive, b.positive),
    negative: Math.min(a.negative, b.negative),
  };
}

export function resolveMargin(collapsed: CollapsedMargin): number {
  return collapsed.positive + collapsed.negative;
}

export function marginIsEmpty(collapsed: CollapsedMargin): boolean {
  return collapsed.positive === 0 && collapsed.negative === 0;
}
