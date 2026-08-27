/*
 * VERBATIM COPY from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e -- donor path
 * `client/src/components/Chat/Messages/SubRow.tsx`.
 *
 * Copied byte-for-byte below this header: 19 lines.
 *
 * `empty:hidden` is why this file is worth taking. The footer slot must occupy
 * no height when a turn has no footer, and this does it in CSS on the element
 * itself rather than with a `{footer && ...}` guard the caller has to remember.
 */
import { cn } from '~/utils';

type TSubRowProps = {
  children: React.ReactNode;
  classes?: string;
  subclasses?: string;
  onClick?: () => void;
};

export default function SubRow({ children, classes = '', onClick }: TSubRowProps) {
  return (
    <div
      className={cn('mt-1 flex justify-start gap-3 empty:hidden lg:flex', classes)}
      onClick={onClick}
    >
      {children}
    </div>
  );
}
