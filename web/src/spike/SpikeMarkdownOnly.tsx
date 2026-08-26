/* SPIKE: bundle-attribution entry — the donor markdown pipeline alone. */
import Markdown from '~/components/Chat/Messages/Content/Markdown';
import { MessageProvider } from '~/Providers';

export default function SpikeMarkdownOnly() {
  return (
    <MessageProvider isSubmitting={false}>
      <Markdown content={'# hi\n\nsome **text**'} isLatestMessage={false} />
    </MessageProvider>
  );
}
