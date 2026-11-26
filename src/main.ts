import './styles.css';
import { createApp } from './app';
import { initTooltips } from './ui/tooltip';

initTooltips();
const app = createApp(document.getElementById('app')!);
if (import.meta.env.DEV) (window as any).__pp = app;
