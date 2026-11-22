import './styles.css';
import { createApp } from './app';

const app = createApp(document.getElementById('app')!);
if (import.meta.env.DEV) (window as any).__pp = app;
