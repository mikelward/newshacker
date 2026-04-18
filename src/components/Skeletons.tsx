import './Skeletons.css';

export function StoryRowSkeleton() {
  return (
    <div className="skeleton-row" role="presentation" aria-hidden="true">
      <div className="skeleton-row__title" />
      <div className="skeleton-row__title skeleton-row__title--short" />
      <div className="skeleton-row__meta">
        <div className="skeleton-row__domain" />
        <div className="skeleton-row__btn" />
      </div>
    </div>
  );
}

export function ThreadSkeleton() {
  return (
    <div className="skeleton-thread" role="presentation" aria-hidden="true">
      <div className="skeleton-thread__title" />
      <div className="skeleton-thread__article" />
      <div className="skeleton-thread__meta" />
      <div className="skeleton-thread__comment" />
      <div className="skeleton-thread__comment" />
      <div className="skeleton-thread__comment" />
    </div>
  );
}

export function UserSkeleton() {
  return (
    <div className="skeleton-user" role="presentation" aria-hidden="true">
      <div className="skeleton-user__id" />
      <div className="skeleton-user__stats" />
      <div className="skeleton-user__about" />
    </div>
  );
}
