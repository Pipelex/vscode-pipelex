import React from 'react';
import { createRoot } from 'react-dom/client';
import type { GraphSpec, GraphConfig, GraphDirection } from '@pipelex/mthds-ui';
import { GraphViewer, StuffViewer } from '@pipelex/mthds-ui/graph/react';
import type { StuffViewerData } from '@pipelex/mthds-ui/graph/react';

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
let currentDirection: GraphDirection = 'TB';
let currentGraphspec: GraphSpec | null = null;
let currentConfig: GraphConfig = {};
let currentShowControllers = false;
let currentUri: string | null = null;
let renderApp: (() => void) | null = null;

// Stuff inspector state
let currentStuffData: StuffViewerData | null = null;
let stuffRoot: ReturnType<typeof createRoot> | null = null;

// Expose ReactFlow instance for zoom toolbar buttons
let reactFlowInstance: any = null;

// Direction icon update
function applyDirectionIcon(direction: string) {
    document.querySelectorAll('.direction-icon').forEach(icon => icon.classList.remove('active'));
    const targetIcon = document.querySelector(direction === 'LR' ? '.tb-icon' : '.lr-icon');
    if (targetIcon) targetIcon.classList.add('active');
}

// Show/hide the stuff inspector panel
function showInspector(visible: boolean) {
    const el = document.getElementById('stuff-inspector');
    if (el) el.style.display = visible ? 'flex' : 'none';
}

// Direction toggle button
document.getElementById('direction-toggle')!.addEventListener('click', () => {
    currentDirection = currentDirection === 'LR' ? 'TB' : 'LR';
    applyDirectionIcon(currentDirection);
    vscode.postMessage({ type: 'updateDirection', value: currentDirection });
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

// Stuff inspector close button
document.getElementById('stuff-inspector-close')!.addEventListener('click', () => {
    currentStuffData = null;
    showInspector(false);
    if (renderApp) renderApp();
});

// --- Callbacks passed to GraphViewer ---

function onNavigateToPipe(pipeCode: string) {
    vscode.postMessage({ type: 'navigateToPipe', pipeCode });
}

function onReactFlowInit(instance: any) {
    reactFlowInstance = instance;
    (window as any)._reactFlowInstance = instance;
}

function onStuffNodeClick(stuffData: StuffViewerData) {
    currentStuffData = stuffData;
    showInspector(true);
    if (renderApp) renderApp();
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
        currentDirection = (currentConfig.direction || 'TB') as GraphDirection;
        currentShowControllers = currentConfig.showControllers || false;
        controllersToggle.checked = currentShowControllers;
        applyDirectionIcon(currentDirection);

        // Clear stuff inspector on new graph data
        currentStuffData = null;
        showInspector(false);

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
        direction: currentDirection,
        showControllers: currentShowControllers,
        onNavigateToPipe,
        onStuffNodeClick,
        onReactFlowInit,
    });
}

// Mount React
const root = createRoot(document.getElementById('root')!);

renderApp = () => {
    root.render(React.createElement(App));

    // Render StuffViewer in inspector panel
    if (currentStuffData) {
        if (!stuffRoot) {
            stuffRoot = createRoot(document.getElementById('stuff-viewer-root')!);
        }
        stuffRoot.render(React.createElement(StuffViewer, { stuff: currentStuffData }));
    } else if (stuffRoot) {
        stuffRoot.render(null);
    }
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
