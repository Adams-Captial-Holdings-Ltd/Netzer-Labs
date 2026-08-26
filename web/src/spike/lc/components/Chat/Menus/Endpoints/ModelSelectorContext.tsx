/* SPIKE SHIM — donor ModelSelectorContext (400+ lines) wires react-query
 * (`useGetEndpointsQuery`, `useListAgentsQuery`), recoil, the agents/assistants
 * map providers, a live announcer and `useSelectMention`. The spike supplies
 * the same shape from static fixtures. */
import { createContext, useContext } from 'react';

export type SpikeSpec = {
  name: string;
  label: string;
  description?: string;
  showIconInMenu?: boolean;
  group?: string;
};

type Ctx = {
  handleSelectSpec: (spec: SpikeSpec) => void;
  endpointsConfig: Record<string, unknown>;
  agentsMap: Record<string, unknown> | undefined;
};

export const ModelSelectorContext = createContext<Ctx>({
  handleSelectSpec: () => undefined,
  endpointsConfig: {},
  agentsMap: undefined,
});

export const useModelSelectorContext = () => useContext(ModelSelectorContext);
