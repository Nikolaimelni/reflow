export const PALETTE = {
  content: '#6e9cd4',
  padding: '#8fb068',
  border: '#c9a947',
  margin: '#c74e23',
  highlight: '#121620',
  divergence: '#e02020',
  dirty: '#e8a33d',
  selected: '#121620',
  label: '#121620',
  labelBackground: '#ffffff',
  grid: '#dde3ec',
  page: '#ffffff',
} as const;

export const BOX_MODEL_LEGEND = [
  { name: 'content', colour: PALETTE.content },
  { name: 'padding', colour: PALETTE.padding },
  { name: 'border', colour: PALETTE.border },
  { name: 'margin', colour: PALETTE.margin },
] as const;
