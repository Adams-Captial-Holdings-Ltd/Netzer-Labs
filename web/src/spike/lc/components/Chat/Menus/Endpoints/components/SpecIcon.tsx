/* SPIKE SHIM — donor SpecIcon resolves a provider glyph through
 * `@librechat/client`'s ProviderIcon, URLIcon, EntityEndpointMark and the
 * `useProviderIcon` hook: four more donor files plus an icon registry. */
export default function SpecIcon({ currentSpec }: { currentSpec: { name: string }; endpointsConfig?: unknown; agentAvatarURL?: string }) {
  return (
    <div className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-tertiary text-[10px] font-semibold text-text-secondary">
      {currentSpec.name.slice(0, 1).toUpperCase()}
    </div>
  );
}
