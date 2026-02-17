import { useEffect } from 'react';
import { useNavigate } from 'react-router';

export default function ArenaRedirect() {
  const navigate = useNavigate();
  useEffect(() => { navigate('/', { replace: true }); }, [navigate]);
  return null;
}
