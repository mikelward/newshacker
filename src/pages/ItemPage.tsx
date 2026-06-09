import { useParams } from 'react-router-dom';
import { Thread } from '../components/Thread';

export function ItemPage() {
  const { id } = useParams();
  const parsed = id ? Number(id) : NaN;
  if (!id || !Number.isFinite(parsed)) {
    return (
      <div className="page-message" role="alert">
        Invalid item id.
      </div>
    );
  }
  // Keyed so thread→thread navigation (HN links inside comments, the
  // root-story link on a focused-comment view) remounts Thread instead
  // of carrying state over: a carried-over visibleCount renders up to
  // N comments immediately — each firing its own item fetch — skipping
  // the paging contract and the batched comment warm.
  return <Thread key={parsed} id={parsed} />;
}
