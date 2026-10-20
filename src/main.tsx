import { createRoot } from 'react-dom/client';
import './styles/theme.css';
import { App } from './ui/app/App';
import { FxGallery } from './ui/plugins/FxGallery';

const q = new URLSearchParams(location.search);
const gallery = q.get('fxgallery');
const root = createRoot(document.getElementById('root')!);
if (gallery) {
  document.body.style.margin = '0';
  document.body.style.background = '#2b2f32';
  let params: Record<string, unknown> | undefined;
  try { params = q.get('p') ? JSON.parse(q.get('p')!) : undefined; } catch { params = undefined; }
  root.render(<FxGallery id={gallery} scale={Number(q.get('scale') ?? 1.5) || 1.5} params={params} />);
} else {
  root.render(<App />);
}
