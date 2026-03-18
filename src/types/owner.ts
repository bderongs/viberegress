/** Who owns persisted scenarios and auth profiles. */

export type Owner =
  | { type: 'user'; id: string }
  | { type: 'anonymous'; id: string };

export const LEGACY_UNCLAIMED = 'legacy-unclaimed';
