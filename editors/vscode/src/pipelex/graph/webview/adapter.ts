import React from 'react';
import { createRoot } from 'react-dom/client';
import type { GraphSpec, GraphConfig } from '@pipelex/mthds-ui';
import { GraphViewer } from '@pipelex/mthds-ui/graph/react';

// VS Code webview API
const vscode = acquireVsCodeApi();

// Pre-React message queue: captures messages arriving before React mounts
const _preReactQueue: any[] = [];
let _reactReady = false;
const _globalListener = function(event: MessageEvent) {
    if (!_reactReady) {
        _preReactQueue.push(event.data);
    }
};
window.addEventListener('message', _globalListener);

// State managed by the adapter, passed as props to GraphViewer.
// Direction and showControllers seeds live in `currentConfig` — GraphViewer
// reads `config.direction` / `config.showControllers` as initial values and
// owns those toggles internally afterward (mthds-ui v0.4+).
let currentGraphspec: GraphSpec | null = null;
let currentConfig: GraphConfig = {};
let currentUri: string | null = null;
let renderApp: (() => void) | null = null;

// Held so we can preserve the viewport across same-file refreshes.
let reactFlowInstance: any = null;

// --- Callbacks passed to GraphViewer ---

function onNavigateToPipe(pipeCode: string) {
    vscode.postMessage({ type: 'navigateToPipe', pipeCode });
}

function onReactFlowInit(instance: any) {
    reactFlowInstance = instance;
}

// --- Message handling ---

function handleMessage(event: { data: any }) {
    const message = event.data;
    if (message.type === 'setData') {
        // Persist the source file URI so VS Code can restore after reload
        if (message.uri) {
            vscode.setState({ uri: message.uri, sourceKind: message.sourceKind });
        }

        // Only preserve viewport for same-file refreshes (e.g., on save).
        // When switching to a different file, let fitView run fresh so the
        // new graph is properly sized instead of inheriting the old zoom.
        const isSameFile = currentUri !== null && message.uri === currentUri;
        const savedViewport = isSameFile && currentGraphspec && reactFlowInstance
            ? reactFlowInstance.getViewport()
            : null;

        // Hide graph during layout to prevent flash (nodes appear at natural
        // zoom before fitView kicks in). Revealed after layout + fitView settle.
        const rootEl = document.getElementById('root');
        if (!savedViewport && rootEl) {
            rootEl.style.visibility = 'hidden';
        }

        currentUri = message.uri || null;

        currentGraphspec = message.graphspec || null;
        currentConfig = message.config || {};

        // Apply palette colors as CSS custom properties on <body>
        if (currentConfig.paletteColors) {
            for (const [cssVar, value] of Object.entries(currentConfig.paletteColors)) {
                document.body.style.setProperty(cssVar, value);
            }
        }

        if (renderApp) renderApp();

        // Restore viewport or reveal after GraphViewer's layout timeout (100ms)
        // plus its fitView. 200ms gives enough time for both to settle.
        if (savedViewport) {
            setTimeout(() => {
                if (reactFlowInstance) {
                    reactFlowInstance.setViewport(savedViewport);
                }
            }, 200);
        } else if (rootEl) {
            setTimeout(() => {
                rootEl.style.visibility = 'visible';
            }, 200);
        }
    }
}

// --- React mount ---

function App() {
    return React.createElement(GraphViewer, {
        graphspec: currentGraphspec,
        config: currentConfig,
        onNavigateToPipe,
        onReactFlowInit,
    });
}

// Mount React
const root = createRoot(document.getElementById('root')!);

renderApp = () => {
    root.render(React.createElement(App));
};
renderApp();

// Signal that React is ready and drain pre-mount queue
_reactReady = true;
window.removeEventListener('message', _globalListener);
window.addEventListener('message', handleMessage);
vscode.postMessage({ type: 'webviewReady' });
for (const queued of _preReactQueue) {
    handleMessage({ data: queued });
}
_preReactQueue.length = 0;
