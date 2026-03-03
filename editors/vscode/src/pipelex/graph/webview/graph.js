// VS Code webview API
const vscode = acquireVsCodeApi();

// Pre-React message queue: captures messages arriving before React mounts
const _preReactQueue = [];
let _reactReady = false;
const _globalListener = function(event) {
    if (!_reactReady) {
        _preReactQueue.push(event.data);
    }
};
window.addEventListener('message', _globalListener);

// State
let currentDirection = 'TB';
let viewspec = null;
let graphspec = null;
let config = {};

// Direction icon update
function applyDirectionIcon(direction) {
    document.querySelectorAll('.direction-icon').forEach(icon => icon.classList.remove('active'));
    const targetIcon = document.querySelector(direction === 'LR' ? '.tb-icon' : '.lr-icon');
    if (targetIcon) targetIcon.classList.add('active');
}

// Direction toggle button
document.getElementById('direction-toggle').addEventListener('click', () => {
    currentDirection = currentDirection === 'LR' ? 'TB' : 'LR';
    applyDirectionIcon(currentDirection);
    if (window.setLayoutDirection) window.setLayoutDirection(currentDirection);
});

// ReactFlow setup
const { React, ReactDOM } = window;
const ReactFlowLib = window.ReactFlowRenderer || window.ReactFlow || {};
const { ReactFlow, useNodesState, useEdgesState, Background, Controls, MarkerType } = ReactFlowLib;

// Edge type is set dynamically from config; default to 'bezier' (matching pipelex defaults)
let edgeType = 'bezier';

// ====================================================================
// DAGRE LAYOUT
// ====================================================================
function getLayoutedElements(nodes, edges, direction) {
    direction = direction || 'TB';
    const nodesep = (config && config.nodesep) || 50;
    const ranksep = (config && config.ranksep) || 30;

    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({
        rankdir: direction,
        nodesep: nodesep,
        ranksep: ranksep,
        edgesep: 20,
        marginx: 40,
        marginy: 40,
    });

    const nodeWidths = {};
    nodes.forEach((node) => {
        const nodeData = node.data || {};
        const isStuff = nodeData.isStuff;
        const labelText = nodeData.labelText || '';
        const estimatedWidth = Math.max(180, Math.min(400, labelText.length * 8 + 60));
        const width = isStuff ? Math.max(180, estimatedWidth) : Math.max(200, estimatedWidth);
        const height = isStuff ? 60 : 70;
        nodeWidths[node.id] = width;
        g.setNode(node.id, { width, height });
    });

    edges.forEach((edge) => {
        g.setEdge(edge.source, edge.target);
    });

    dagre.layout(g);

    const isHorizontal = direction === 'LR' || direction === 'RL';
    const sourcePosition = isHorizontal ? 'right' : 'bottom';
    const targetPosition = isHorizontal ? 'left' : 'top';

    const layoutedNodes = nodes.map((node) => {
        const nodeWithPosition = g.node(node.id);
        const width = nodeWidths[node.id] || 200;
        return {
            ...node,
            position: {
                x: nodeWithPosition.x - width / 2,
                y: nodeWithPosition.y - 30,
            },
            sourcePosition,
            targetPosition,
        };
    });

    return { nodes: layoutedNodes, edges };
}

// ====================================================================
// DATAFLOW ANALYSIS: Extract stuff nodes and build producer/consumer maps
// Mirrors the Python GraphAnalysis logic and the Jinja2 template's
// buildDataflowAnalysis() function
// ====================================================================
function buildDataflowAnalysis(graphspec) {
    if (!graphspec) return null;

    const stuffRegistry = {};      // digest -> { name, concept, contentType, data }
    const stuffProducers = {};     // digest -> producer_node_id
    const stuffConsumers = {};     // digest -> [consumer_node_ids]
    const containmentTree = {};    // parent_id -> [child_ids]
    const childNodeIds = new Set();

    // Build containment tree from edges
    for (const edge of graphspec.edges) {
        if (edge.kind === 'contains') {
            if (!containmentTree[edge.source]) containmentTree[edge.source] = [];
            containmentTree[edge.source].push(edge.target);
            childNodeIds.add(edge.target);
        }
    }

    // Controller IDs are nodes that have children
    const controllerNodeIds = new Set(Object.keys(containmentTree));

    // Register stuffs from all nodes; track producers/consumers from operators only
    for (const node of graphspec.nodes) {
        const nodeIo = node.io || {};
        const isController = controllerNodeIds.has(node.id);

        // Register outputs
        for (const output of (nodeIo.outputs || [])) {
            if (output.digest && !stuffRegistry[output.digest]) {
                stuffRegistry[output.digest] = {
                    name: output.name,
                    concept: output.concept,
                    contentType: output.content_type,
                };
            }
            if (output.digest && !isController) {
                stuffProducers[output.digest] = node.id;
            }
        }

        // Register inputs
        for (const input of (nodeIo.inputs || [])) {
            if (input.digest && !stuffRegistry[input.digest]) {
                stuffRegistry[input.digest] = {
                    name: input.name,
                    concept: input.concept,
                    contentType: input.content_type,
                };
            }
            if (input.digest && !isController) {
                if (!stuffConsumers[input.digest]) stuffConsumers[input.digest] = [];
                stuffConsumers[input.digest].push(node.id);
            }
        }
    }

    return {
        stuffRegistry,
        stuffProducers,
        stuffConsumers,
        controllerNodeIds,
        childNodeIds,
    };
}

// ====================================================================
// BUILD DATAFLOW GRAPH (preferred when GraphSpec is available)
// Creates pipe nodes + stuff (data) nodes + producer/consumer edges
// ====================================================================
function buildDataflowGraph(graphspec, analysis) {
    const nodes = [];
    const edges = [];

    // Find participating pipes (those that produce or consume data)
    const participatingPipes = new Set();
    for (const producer of Object.values(analysis.stuffProducers)) {
        participatingPipes.add(producer);
    }
    for (const consumers of Object.values(analysis.stuffConsumers)) {
        for (const consumer of consumers) {
            participatingPipes.add(consumer);
        }
    }

    // Create pipe nodes (only those that participate in data flow)
    for (const node of graphspec.nodes) {
        if (!participatingPipes.has(node.id)) continue;

        const isFailed = node.status === 'failed';
        const label = node.pipe_code || node.id.split(':').pop();
        const nodeWidth = Math.max(160, label.length * 8 + 28);

        nodes.push({
            id: node.id,
            type: 'default',
            data: {
                label: React.createElement('div', {
                    style: {
                        padding: '10px 14px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '2px',
                        textAlign: 'center',
                    }
                },
                    React.createElement('span', {
                        style: {
                            fontFamily: "var(--font-mono)",
                            fontSize: '13px',
                            fontWeight: 600,
                            color: 'var(--color-pipe-text)',
                        }
                    }, label)
                ),
                nodeData: node,
                isPipe: true,
                isStuff: false,
                labelText: label,
                pipeCode: node.pipe_code || label,
            },
            position: { x: 0, y: 0 },
            style: {
                background: isFailed ? 'var(--color-pipe-failed-bg)' : 'var(--color-pipe-bg)',
                border: isFailed ? '2px solid var(--color-pipe-failed)' : '2px solid var(--color-pipe)',
                borderRadius: '8px',
                padding: '0',
                width: nodeWidth + 'px',
                boxShadow: 'var(--shadow-md)',
                cursor: 'pointer',
            },
        });
    }

    // Create stuff (data) nodes
    for (const [digest, stuffInfo] of Object.entries(analysis.stuffRegistry)) {
        const stuffId = 'stuff_' + digest;
        const label = stuffInfo.name || 'data';
        const concept = stuffInfo.concept || '';
        const textWidth = Math.max(label.length, concept.length) * 7 + 48;
        const stuffWidth = Math.max(140, textWidth);

        nodes.push({
            id: stuffId,
            type: 'default',
            data: {
                label: React.createElement('div', {
                    style: {
                        padding: '8px 24px',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: '2px',
                        textAlign: 'center',
                    }
                },
                    React.createElement('span', {
                        style: {
                            fontFamily: "var(--font-mono)",
                            fontSize: '12px',
                            fontWeight: 600,
                            color: 'var(--color-stuff-text)',
                        }
                    }, label),
                    concept && React.createElement('span', {
                        style: {
                            fontSize: '14px',
                            color: 'var(--color-stuff-text-dim)',
                        }
                    }, concept)
                ),
                isStuff: true,
                isPipe: false,
                labelText: label,
            },
            position: { x: 0, y: 0 },
            style: {
                background: 'var(--color-stuff-bg)',
                border: '2px solid var(--color-stuff-border)',
                borderRadius: '999px',
                padding: '0',
                width: stuffWidth + 'px',
                boxShadow: 'var(--shadow-md)',
            },
        });
    }

    // Create edges: producer -> stuff
    let edgeId = 0;
    for (const [digest, producerNodeId] of Object.entries(analysis.stuffProducers)) {
        const stuffId = 'stuff_' + digest;
        edges.push({
            id: 'edge_' + (edgeId++),
            source: producerNodeId,
            target: stuffId,
            type: edgeType,
            animated: false,
            style: { stroke: 'var(--color-edge)', strokeWidth: 2 },
            markerEnd: {
                type: MarkerType?.ArrowClosed || 'arrowclosed',
                color: 'var(--color-edge)',
            },
        });
    }

    // Create edges: stuff -> consumer
    for (const [digest, consumers] of Object.entries(analysis.stuffConsumers)) {
        const stuffId = 'stuff_' + digest;
        for (const consumerNodeId of consumers) {
            edges.push({
                id: 'edge_' + (edgeId++),
                source: stuffId,
                target: consumerNodeId,
                type: edgeType,
                animated: false,
                style: { stroke: 'var(--color-edge)', strokeWidth: 2 },
                markerEnd: {
                    type: MarkerType?.ArrowClosed || 'arrowclosed',
                    color: 'var(--color-edge)',
                },
            });
        }
    }

    // Create PARALLEL_COMBINE edges from GraphSpec
    for (const edge of graphspec.edges) {
        if (edge.kind !== 'parallel_combine') continue;
        if (!edge.source_stuff_digest || !edge.target_stuff_digest) continue;
        const sourceId = 'stuff_' + edge.source_stuff_digest;
        const targetId = 'stuff_' + edge.target_stuff_digest;

        edges.push({
            id: edge.id || ('edge_' + (edgeId++)),
            source: sourceId,
            target: targetId,
            type: edgeType,
            animated: false,
            style: {
                stroke: 'var(--color-parallel-combine)',
                strokeWidth: 2,
                strokeDasharray: '5,5',
            },
            markerEnd: {
                type: MarkerType?.ArrowClosed || 'arrowclosed',
                color: 'var(--color-parallel-combine)',
            },
        });
    }

    // Create BATCH_ITEM and BATCH_AGGREGATE edges (data-centric mode: stuff -> stuff)
    for (const edge of graphspec.edges) {
        if (edge.kind !== 'batch_item' && edge.kind !== 'batch_aggregate') continue;

        if (!edge.source_stuff_digest || !edge.target_stuff_digest) continue;
        const sourceId = 'stuff_' + edge.source_stuff_digest;
        const targetId = 'stuff_' + edge.target_stuff_digest;
        const isBatchItem = edge.kind === 'batch_item';

        edges.push({
            id: edge.id || ('edge_' + (edgeId++)),
            source: sourceId,
            target: targetId,
            type: edgeType,
            animated: false,
            label: edge.label || '',
            labelStyle: {
                fontSize: '10px',
                fontFamily: "var(--font-mono)",
                fill: isBatchItem ? 'var(--color-batch-item)' : 'var(--color-batch-aggregate)',
            },
            labelBgStyle: { fill: 'var(--color-bg)', fillOpacity: 0.9 },
            style: {
                stroke: isBatchItem ? 'var(--color-batch-item)' : 'var(--color-batch-aggregate)',
                strokeWidth: 2,
                strokeDasharray: '5,5',
            },
            markerEnd: {
                type: MarkerType?.ArrowClosed || 'arrowclosed',
                color: isBatchItem ? 'var(--color-batch-item)' : 'var(--color-batch-aggregate)',
            },
        });
    }

    return { nodes, edges };
}

// ====================================================================
// FALLBACK: Build orchestration graph from ViewSpec (no dataflow)
// ====================================================================
function buildOrchestrationGraph(viewspec) {
    const nodes = viewspec.nodes.map(node => {
        const isFailed = node.status === 'failed';
        const isSucceeded = node.status === 'succeeded';
        const isController = node.kind === 'controller';
        const badge = node.ui?.badges?.[0] || '';
        const label = node.label || node.id;
        const nodeWidth = Math.max(160, (label.length || 10) * 8 + 50);

        return {
            id: node.id,
            type: 'default',
            data: {
                label: React.createElement('div', {
                    style: {
                        padding: '10px 14px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '4px',
                    }
                },
                    React.createElement('div', {
                        style: {
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '8px',
                        }
                    },
                        React.createElement('span', {
                            style: {
                                fontFamily: "var(--font-mono)",
                                fontSize: '13px',
                                fontWeight: 600,
                                color: 'var(--color-pipe-text)',
                            }
                        }, label),
                        isSucceeded && React.createElement('span', {
                            style: {
                                width: '8px',
                                height: '8px',
                                borderRadius: '50%',
                                background: 'var(--color-success)',
                                flexShrink: 0,
                            }
                        }),
                        isFailed && React.createElement('span', {
                            style: {
                                width: '8px',
                                height: '8px',
                                borderRadius: '50%',
                                background: 'var(--color-error)',
                                flexShrink: 0,
                            }
                        })
                    ),
                    React.createElement('div', {
                        style: {
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '8px',
                        }
                    },
                        React.createElement('span', {
                            style: {
                                fontSize: '11px',
                                color: 'var(--color-text-dim)',
                            }
                        }, isController ? 'Controller' : node.inspector?.pipe_type || 'Operator'),
                        badge && React.createElement('span', {
                            style: {
                                fontSize: '10px',
                                color: 'var(--color-text-muted)',
                                background: 'var(--color-surface-hover)',
                                padding: '2px 6px',
                                borderRadius: '4px',
                                fontFamily: "var(--font-mono)",
                            }
                        }, badge)
                    )
                ),
                nodeData: node,
                isPipe: true,
                isStuff: false,
                labelText: label,
                pipeCode: node.inspector?.pipe_code || label,
            },
            position: node.position || { x: 0, y: 0 },
            style: {
                background: isFailed ? 'var(--color-pipe-failed-bg)' : 'var(--color-pipe-bg)',
                border: isFailed ? '2px solid var(--color-pipe-failed)' : '2px solid var(--color-pipe)',
                borderRadius: '8px',
                padding: '0',
                width: nodeWidth + 'px',
                boxShadow: 'var(--shadow-md)',
                cursor: 'pointer',
            },
        };
    });

    const edges = viewspec.edges.map(edge => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: edgeType,
        animated: edge.animated || false,
        label: edge.label,
        labelStyle: {
            fontSize: 11,
            fontWeight: 500,
            fill: 'var(--color-text-muted)',
            fontFamily: "var(--font-mono)",
        },
        labelBgStyle: { fill: 'var(--color-bg)', fillOpacity: 0.9 },
        labelBgPadding: [6, 4],
        labelBgBorderRadius: 4,
        style: {
            stroke: edge.kind === 'data' ? 'var(--color-edge)' : 'var(--color-text-dim)',
            strokeWidth: edge.kind === 'data' ? 2 : 1,
        },
        markerEnd: {
            type: MarkerType?.ArrowClosed || 'arrowclosed',
            color: edge.kind === 'data' ? 'var(--color-edge)' : 'var(--color-text-dim)',
        },
    }));

    return { nodes, edges };
}

// ====================================================================
// GRAPH BUILDING: choose dataflow or orchestration
// ====================================================================
function buildGraph(viewspec, graphspec) {
    if (graphspec) {
        const analysis = buildDataflowAnalysis(graphspec);
        if (analysis && Object.keys(analysis.stuffRegistry).length > 0) {
            return { graphData: buildDataflowGraph(graphspec, analysis), analysis: analysis };
        }
    }
    return { graphData: buildOrchestrationGraph(viewspec), analysis: null };
}

// Update footer stats
function updateFooterStats(viewspec, graphspec, analysis) {
    const statsEl = document.getElementById('footer-stats');
    if (!statsEl) return;

    const pipeCount = analysis
        ? graphspec.nodes.filter(n => !analysis.controllerNodeIds.has(n.id)).length
        : viewspec.nodes.length;
    const stuffCount = analysis ? Object.keys(analysis.stuffRegistry).length : 0;
    const succeededCount = viewspec.nodes.filter(n => n.status === 'succeeded').length;
    const failedCount = viewspec.nodes.filter(n => n.status === 'failed').length;

    let html = '<div class="stat-item">' +
        '<svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
            '<rect x="3" y="3" width="18" height="18" rx="2"/>' +
        '</svg>' +
        '<span class="stat-value">' + pipeCount + '</span> pipes' +
    '</div>';

    if (stuffCount > 0) {
        html += '<div class="stat-item" style="color: var(--color-stuff)">' +
            '<svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
                '<ellipse cx="12" cy="12" rx="10" ry="6"/>' +
            '</svg>' +
            '<span class="stat-value">' + stuffCount + '</span> data' +
        '</div>';
    }

    if (succeededCount > 0) {
        html += '<div class="stat-item" style="color: var(--color-success)">' +
            '<svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
                '<polyline points="20 6 9 17 4 12"/>' +
            '</svg>' +
            '<span class="stat-value">' + succeededCount + '</span>' +
        '</div>';
    }

    if (failedCount > 0) {
        html += '<div class="stat-item" style="color: var(--color-error)">' +
            '<svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
                '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>' +
            '</svg>' +
            '<span class="stat-value">' + failedCount + '</span>' +
        '</div>';
    }

    statsEl.innerHTML = html;
}

// ====================================================================
// MAIN REACT COMPONENT
// ====================================================================
function GraphViewer() {
    const [nodes, setNodes, onNodesChange] = useNodesState([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState([]);
    const [direction, setDirection] = React.useState(currentDirection);
    const reactFlowRef = React.useRef(null);
    const prevDirectionRef = React.useRef(currentDirection);
    const initialDataRef = React.useRef(null);

    // Expose setLayoutDirection for direction toggle button
    React.useEffect(() => {
        window.setLayoutDirection = setDirection;
        return () => { window.setLayoutDirection = null; };
    }, [setDirection]);

    // Re-layout when direction changes
    React.useEffect(() => {
        if (prevDirectionRef.current === direction) return;
        prevDirectionRef.current = direction;
        currentDirection = direction;
        if (!initialDataRef.current) return;

        const relayouted = getLayoutedElements(initialDataRef.current.nodes, initialDataRef.current.edges, direction);
        setNodes(relayouted.nodes);
        setEdges(relayouted.edges);
        setTimeout(() => {
            if (reactFlowRef.current) {
                reactFlowRef.current.fitView({ padding: 0.1 });
            }
        }, 50);
    }, [direction]);

    // Listen for data from the extension
    React.useEffect(() => {
        function handleMessage(event) {
            const message = event.data;
            if (message.type === 'setData') {
                viewspec = message.viewspec;
                graphspec = message.graphspec || null;
                config = message.config || {};
                currentDirection = config.direction || 'TB';
                edgeType = config.edgeType || 'bezier';
                setDirection(currentDirection);
                prevDirectionRef.current = currentDirection;
                applyDirectionIcon(currentDirection);

                // Apply palette colors as CSS custom properties on <body>
                // (must target body, not documentElement, because body.vscode-dark
                // redefines these variables and would shadow html-level overrides)
                if (config.paletteColors) {
                    for (var cssVar in config.paletteColors) {
                        document.body.style.setProperty(cssVar, config.paletteColors[cssVar]);
                    }
                }

                const { graphData, analysis } = buildGraph(viewspec, graphspec);
                initialDataRef.current = graphData;

                const needsLayout = graphData.nodes.some(n => !n.position || (n.position.x === 0 && n.position.y === 0));
                const layouted = needsLayout
                    ? getLayoutedElements(graphData.nodes, graphData.edges, currentDirection)
                    : graphData;

                setNodes(layouted.nodes);
                setEdges(layouted.edges);

                updateFooterStats(viewspec, graphspec, analysis);

                // Fit view after render, then apply zoom/pan overrides
                setTimeout(() => {
                    if (reactFlowRef.current) {
                        reactFlowRef.current.fitView({ padding: 0.1 });
                        if (config.initialZoom !== undefined && config.initialZoom !== null) {
                            reactFlowRef.current.zoomTo(config.initialZoom);
                        }
                        if (config.panToTop) {
                            var vp = reactFlowRef.current.getViewport();
                            reactFlowRef.current.setViewport({ x: vp.x, y: 20, zoom: vp.zoom });
                        }
                    }
                }, 100);
            }
        }

        window.addEventListener('message', handleMessage);

        // Signal that React is ready and drain any messages that arrived early
        _reactReady = true;
        window.removeEventListener('message', _globalListener);
        vscode.postMessage({ type: 'webviewReady' });
        for (const queued of _preReactQueue) {
            handleMessage({ data: queued });
        }
        _preReactQueue.length = 0;

        return () => window.removeEventListener('message', handleMessage);
    }, [setNodes, setEdges]);

    // Handle node click — send navigateToPipe message to extension
    const onNodeClick = React.useCallback((event, node) => {
        const nodeData = node.data || {};
        if (nodeData.isPipe && nodeData.pipeCode) {
            vscode.postMessage({
                type: 'navigateToPipe',
                pipeCode: nodeData.pipeCode,
            });
        }

        // Highlight selected node
        setNodes((nds) =>
            nds.map((n) => ({
                ...n,
                selected: n.id === node.id,
            }))
        );
    }, [setNodes]);

    const onInit = (reactFlowInstance) => {
        reactFlowRef.current = reactFlowInstance;
    };

    return React.createElement('div', { className: 'react-flow-container' },
        React.createElement(ReactFlow, {
            nodes: nodes,
            edges: edges,
            onNodesChange: onNodesChange,
            onEdgesChange: onEdgesChange,
            onNodeClick: onNodeClick,
            onInit: onInit,
            fitView: true,
            fitViewOptions: { padding: 0.1 },
            defaultEdgeOptions: { type: edgeType },
            proOptions: { hideAttribution: true },
        },
            Background ? React.createElement(Background, {
                variant: 'dots',
                gap: 20,
                size: 1,
                color: 'var(--color-bg-dots)',
            }) : null,
            Controls ? React.createElement(Controls, { showInteractive: false }) : null
        )
    );
}

// Guard component: prevents hooks from running when ReactFlow is unavailable
function App() {
    if (!ReactFlow) {
        return React.createElement('div', { style: { padding: '20px', color: 'var(--color-text)' } },
            React.createElement('p', null, 'Loading ReactFlow...')
        );
    }
    return React.createElement(GraphViewer, null);
}

// Render the app
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(React.createElement(App));

// Apply initial direction icon
applyDirectionIcon(currentDirection);
