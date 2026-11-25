export const EFFECT_LIBRARY_VERSION = 4;
export const legacyKind = (kind: string): string => kind.startsWith('compat.') ? kind.slice(7) : kind;
