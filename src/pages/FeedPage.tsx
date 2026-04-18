import { useParams, Navigate } from 'react-router-dom';
import { isFeed } from '../lib/feeds';
import { StoryList } from '../components/StoryList';

export function FeedPage() {
  const { feed } = useParams();
  if (!feed || !isFeed(feed)) {
    return <Navigate to="/top" replace />;
  }
  return <StoryList feed={feed} />;
}
