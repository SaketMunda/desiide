import { render } from 'preact';
import { ViewId } from '../shared/messages.ts';
import { post } from './bridge.ts';
import './ui/kit.css';
import './prompt/prompt.css';
import './transcript/transcript.css';
import { App } from './views/App.tsx';

const root = document.getElementById('root');
const view = ViewId.safeParse(root?.dataset['view']);
if (root && view.success) {
  render(<App view={view.data} />, root);
} else {
  post({
    type: 'log',
    level: 'error',
    message: 'Webview root or view id missing; nothing rendered',
  });
}
