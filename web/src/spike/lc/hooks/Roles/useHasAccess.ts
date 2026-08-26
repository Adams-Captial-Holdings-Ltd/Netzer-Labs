/* SPIKE SHIM — donor hook resolves RBAC from react-query + recoil. */
export default function useHasAccess(_args: { permissionType: string; permission: string }): boolean {
  return false;
}
