/* SPIKE: bundle-attribution entry — the donor markdown pipeline with the KaTeX
 * plugin (and `katex/contrib/mhchem`) removed, to separate KaTeX's weight from
 * the react-markdown + remark/rehype + micromark/mdast weight. Everything else
 * matches `markdownConfig.ts`. */
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import supersub from 'remark-supersub';
import remarkDirective from 'remark-directive';
import type { PluggableList } from 'unified';
import MarkdownBlocks from '~/components/Chat/Messages/Content/MarkdownBlocks';
import { code, a, p, img, table } from '~/components/Chat/Messages/Content/MarkdownComponents';
import { langSubset, remarkApproxTilde, remarkSingleDollarMath } from '~/utils';

const remarkPlugins: PluggableList = [
  remarkApproxTilde,
  supersub,
  remarkGfm,
  remarkDirective,
  [remarkMath, { singleDollarTextMath: false }],
  remarkSingleDollarMath,
];
const rehypePlugins: PluggableList = [
  [rehypeHighlight, { detect: true, ignoreMissing: true, subset: langSubset }],
];

export default function SpikeMarkdownNoKatex() {
  return (
    <MarkdownBlocks
      content={'# hi\n\nsome **text**'}
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={{ code, a, p, img, table }}
    />
  );
}
