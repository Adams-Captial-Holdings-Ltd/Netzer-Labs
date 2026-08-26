/* SPIKE: bundle-attribution entry — the Ariakit menu surface alone. */
import { useState } from 'react';
import { CustomMenu as Menu } from '~/components/Chat/Menus/Endpoints/CustomMenu';
import { renderModelSpecs } from '~/components/Chat/Menus/Endpoints/components/ModelSpecItem';
import type { TModelSpec } from 'librechat-data-provider';

const SPECS: TModelSpec[] = [{ name: 'a', label: 'A' }];

export default function SpikeMenuOnly() {
  const [values, setValues] = useState<Record<string, unknown>>({});
  return (
    <Menu values={values} onValuesChange={setValues} onSearch={() => undefined} trigger={<button />}>
      {renderModelSpecs(SPECS, 'a')}
    </Menu>
  );
}
