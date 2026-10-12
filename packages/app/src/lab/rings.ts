import type { Box, BoxId } from '@reflow/engine';

// Steps from the changed box, up or down the tree, so the lab can show the ripple spreading.
export function rings(root: Box, target: BoxId, dirty: ReadonlySet<BoxId>): Map<BoxId, number> {
  const parents = new Map<BoxId, BoxId>();
  const children = new Map<BoxId, BoxId[]>();

  const walk = (box: Box) => {
    if (box.kind === 'text') return;
    children.set(
      box.id,
      box.children.map((child) => child.id),
    );
    for (const child of box.children) {
      parents.set(child.id, box.id);
      walk(child);
    }
  };

  walk(root);

  const distance = new Map<BoxId, number>();
  if (!dirty.has(target)) return distance;

  distance.set(target, 0);
  const queue: BoxId[] = [target];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;

    const step = (distance.get(current) ?? 0) + 1;
    const neighbours = [...(children.get(current) ?? [])];
    const parent = parents.get(current);
    if (parent !== undefined) neighbours.push(parent);

    for (const next of neighbours) {
      if (!dirty.has(next) || distance.has(next)) continue;
      distance.set(next, step);
      queue.push(next);
    }
  }

  return distance;
}
