/* SPIKE SHIM — module alias for the donor's `librechat-data-provider`
 * workspace package (schemas + enums + api base). */
export const PermissionTypes = { RUN_CODE: 'RUN_CODE' } as const;
export const Permissions = { USE: 'USE' } as const;
export const apiBaseUrl = () => '';

/** Structural stand-in for the donor's zod-derived `TModelSpec`. */
export type TModelSpec = {
  name: string;
  label: string;
  description?: string;
  showIconInMenu?: boolean;
  group?: string;
  preset?: { endpoint?: string; model?: string };
};
export type TEndpointsConfig = Record<string, unknown>;
