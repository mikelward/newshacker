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
  return <Thread id={parsed} />;
}
