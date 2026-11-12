import { LIMITS } from '../../config/limits.js';

export interface ContextBudgetViolation {
  reason: 'depth' | 'keys';
  depth: number;
  keys: number;
}

/**
 * Zod validates shape; this validates cost. A hostile 5 MB object nested 500
 * levels deep would otherwise reach the JSON walker and the prompt builder.
 */
export function checkContextBudget(value: unknown): ContextBudgetViolation | null {
  let keys = 0;
  let maxDepth = 0;

  const walk = (node: unknown, depth: number): void => {
    if (depth > maxDepth) maxDepth = depth;
    if (depth > LIMITS.maxContextDepth) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [, child] of Object.entries(node as Record<string, unknown>)) {
        keys += 1;
        if (keys > LIMITS.maxContextKeys) return;
        walk(child, depth + 1);
      }
    }
  };

  walk(value, 0);

  if (maxDepth > LIMITS.maxContextDepth) return { reason: 'depth', depth: maxDepth, keys };
  if (keys > LIMITS.maxContextKeys) return { reason: 'keys', depth: maxDepth, keys };
  return null;
}
