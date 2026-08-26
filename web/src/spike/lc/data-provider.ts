/* SPIKE SHIM — donor `~/data-provider` is the react-query layer. */
export function useFileDownload(_userId: string, _fileId: string, _opts?: unknown) {
  return { refetch: async () => ({ data: '' }) };
}
