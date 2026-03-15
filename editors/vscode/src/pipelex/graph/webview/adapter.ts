/// <reference path="./globals.d.ts" />

import type { ViewSpec, GraphSpec, GraphConfig } from './types';
import { GraphViewer } from './GraphViewer';

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

// State managed by the adapter, passed as props to GraphViewer
let currentDirection = 'TB';
let currentViewspec: ViewSpec | null = null;
let currentGraphspec: GraphSpec | null = null;
let currentConfig: GraphConfig = {};
let currentShowControllers = false;
let renderApp: (() => void) | null = null;

// Expose ReactFlow instance for zoom toolbar buttons
let reactFlowInstance: any = null;

// Direction icon update
function applyDirectionIcon(direction: string) {
    document.querySelectorAll('.direction-icon').forEach(icon => icon.classList.remove('active'));
    const targetIcon = document.querySelector(direction === 'LR' ? '.tb-icon' : '.lr-icon');
    if (targetIcon) targetIcon.classList.add('active');
}

// Direction toggle button
document.getElementById('direction-toggle')!.addEventListener('click', () => {
    currentDirection = currentDirection === 'LR' ? 'TB' : 'LR';
    applyDirectionIcon(currentDirection);
    if (renderApp) renderApp();
});

// Zoom toolbar buttons
document.getElementById('zoom-in')!.addEventListener('click', () => {
    if (reactFlowInstance) reactFlowInstance.zoomIn();
});
document.getElementById('zoom-out')!.addEventListener('click', () => {
    if (reactFlowInstance) reactFlowInstance.zoomOut();
});
document.getElementById('zoom-fit')!.addEventListener('click', () => {
    if (reactFlowInstance) reactFlowInstance.fitView({ padding: 0.1 });
});

// Controllers toggle switch
const controllersToggle = document.getElementById('controllers-toggle') as HTMLInputElement;
controllersToggle.addEventListener('change', () => {
    currentShowControllers = controllersToggle.checked;
    vscode.postMessage({ type: 'updateShowControllers', value: currentShowControllers });
    if (renderApp) renderApp();
});

// --- Callbacks passed to GraphViewer ---

function onNavigateToPipe(pipeCode: string) {
    vscode.postMessage({ type: 'navigateToPipe', pipeCode });
}

function onDirectionChange(dir: string) {
    currentDirection = dir;
    applyDirectionIcon(dir);
    if (renderApp) renderApp();
}

function onShowControllersChange(show: boolean) {
    currentShowControllers = show;
    controllersToggle.checked = show;
    vscode.postMessage({ type: 'updateShowControllers', value: show });
    if (renderApp) renderApp();
}

function onReactFlowInit(instance: any) {
    reactFlowInstance = instance;
    (window as any)._reactFlowInstance = instance;
}

// --- Message handling ---

function handleMessage(event: { data: any }) {
    const message = event.data;
    if (message.type === 'setData') {
        // Persist the source file URI so VS Code can restore after reload
        if (message.uri) {
            vscode.setState({ uri: message.uri });
        }
        currentViewspec = message.viewspec;
        currentGraphspec = message.graphspec || null;
        currentConfig = message.config || {};
        currentDirection = currentConfig.direction || 'TB';
        currentShowControllers = currentConfig.showControllers || false;
        controllersToggle.checked = currentShowControllers;
        applyDirectionIcon(currentDirection);

        // Apply palette colors as CSS custom properties on <body>
        if (currentConfig.paletteColors) {
            for (const [cssVar, value] of Object.entries(currentConfig.paletteColors)) {
                document.body.style.setProperty(cssVar, value);
            }
        }

        if (renderApp) renderApp();
    }
}

// --- React mount ---

// Guard component: prevents hooks from running when ReactFlow is unavailable
function App() {
    const ReactFlowLib = (typeof ReactFlowRenderer !== 'undefined' && ReactFlowRenderer)
        || (window as any).ReactFlow
        || {};
    if (!ReactFlowLib.ReactFlow) {
        return React.createElement('div', { style: { padding: '20px', color: 'var(--color-text)' } },
            React.createElement('p', null, 'Loading ReactFlow...'),
        );
    }
    return React.createElement(GraphViewer, {
        viewspec: currentViewspec,
        graphspec: currentGraphspec,
        config: currentConfig,
        direction: currentDirection,
        showControllers: currentShowControllers,
        onNavigateToPipe,
        onDirectionChange,
        onShowControllersChange,
        onReactFlowInit,
    });
}

// Mount React
const root = ReactDOM.createRoot(document.getElementById('root')!);

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

// Apply initial direction icon
applyDirectionIcon(currentDirection);
