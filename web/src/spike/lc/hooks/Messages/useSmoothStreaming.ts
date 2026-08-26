/* SPIKE SHIM — donor hook reads a user setting from recoil; the spike renders
 * settled content, so smooth streaming is off. */
export default function useSmoothStreaming(): boolean {
  return false;
}
