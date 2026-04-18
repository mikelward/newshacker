import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div className="page-message">
      <p>Page not found.</p>
      <p>
        <Link to="/top">Go to Top</Link>
      </p>
    </div>
  );
}
