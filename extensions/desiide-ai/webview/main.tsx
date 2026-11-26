import { render } from 'preact';
import { PageId } from '../shared/messages.ts';
import { post } from './bridge.ts';
import './ui/kit.css';
import './prompt/prompt.css';
import './transcript/transcript.css';
import './settings/settings.css';
import { App } from './views/App.tsx';

const root = document.getElementById('root');
const view = PageId.safeParse(root?.dataset['view']);
if (root && view.success) {
  render(<App view={view.data} />, root);
} else {
  post({
    type: 'log',
    level: 'error',
    message: 'Webview root or view id missing; nothing rendered',
  });
}
