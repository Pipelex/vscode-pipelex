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
let showControllers = false;

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

// Zoom toolbar buttons
document.getElementById('zoom-in').addEventListener('click', () => {
    if (window._reactFlowInstance) window._reactFlowInstance.zoomIn();
});
document.getElementById('zoom-out').addEventListener('click', () => {
    if (window._reactFlowInstance) window._reactFlowInstance.zoomOut();
});
document.getElementById('zoom-fit').addEventListener('click', () => {
    if (window._reactFlowInstance) window._reactFlowInstance.fitView({ padding: 0.1 });
});

// Controllers toggle switch
const controllersToggle = document.getElementById('controllers-toggle');
controllersToggle.addEventListener('change', () => {
    showControllers = controllersToggle.checked;
    vscode.postMessage({ type: 'updateShowControllers', value: showControllers });
    if (window.rebuildAndLayout) window.rebuildAndLayout();
});

// Controller group padding constants (shared between spacing correction and group rendering)
const CONTROLLER_PADDING_X = 40;
const CONTROLLER_PADDING_TOP = 48; // room for label
const CONTROLLER_PADDING_BOTTOM = 20;

// ReactFlow setup
const { React, ReactDOM } = window;
const ReactFlowLib = window.ReactFlowRenderer || window.ReactFlow || {};
const { ReactFlow, useNodesState, useEdgesState, Background, MarkerType } = ReactFlowLib;

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
        // Cross-group edges get low weight so dagre's crossing-minimization
        // doesn't pull nodes from different controller groups together.
        // Batch edges (batch_item / batch_aggregate) get extra rank spacing
        // so the dashed edges have breathing room around the controller.
        const edgeLabel = {};
        if (edge._crossGroup) edgeLabel.weight = 0;
        if (edge._batchEdge) edgeLabel.minlen = 3;
        g.setEdge(edge.source, edge.target, edgeLabel);
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
        containmentTree,
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
            _batchEdge: true,
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

    // Sort nodes by controller group so dagre's initial ordering clusters
    // same-group nodes. This influences dagre's crossing-minimization to
    // keep sibling groups separate rather than interleaving them.
    if (analysis) {
        const childToCtrl = buildChildToControllerMap(graphspec, analysis);

        // For unassigned stuff (method inputs with no producer), assign to
        // the controller of their first consumer so inputs cluster near their group
        for (const [digest, consumers] of Object.entries(analysis.stuffConsumers)) {
            const stuffId = 'stuff_' + digest;
            if (childToCtrl[stuffId]) continue;
            for (const consumerId of consumers) {
                if (childToCtrl[consumerId]) {
                    childToCtrl[stuffId] = childToCtrl[consumerId];
                    break;
                }
            }
        }

        // Depth-first order index for controllers
        const groupOrder = {};
        let orderIdx = 0;
        function assignOrder(ctrlId) {
            groupOrder[ctrlId] = orderIdx++;
            for (const childId of (analysis.containmentTree[ctrlId] || [])) {
                if (analysis.controllerNodeIds.has(childId)) {
                    assignOrder(childId);
                }
            }
        }
        for (const ctrlId of analysis.controllerNodeIds) {
            if (!childToCtrl[ctrlId]) assignOrder(ctrlId);
        }

        // Build sort key from containment path
        function sortKey(nodeId) {
            const path = [];
            let cur = childToCtrl[nodeId];
            while (cur) {
                path.unshift(groupOrder[cur] !== undefined ? groupOrder[cur] : 9999);
                cur = childToCtrl[cur];
            }
            while (path.length < 10) path.push(0);
            return path;
        }

        nodes.sort((a, b) => {
            const ka = sortKey(a.id);
            const kb = sortKey(b.id);
            for (let i = 0; i < ka.length; i++) {
                if (ka[i] !== kb[i]) return ka[i] - kb[i];
            }
            return 0;
        });

        // Mark edges that cross between different sibling controller groups.
        // These get low weight in dagre so they don't pull nodes from different
        // groups toward each other during crossing-minimization.
        for (const edge of edges) {
            const srcCtrl = childToCtrl[edge.source] || null;
            const tgtCtrl = childToCtrl[edge.target] || null;
            if (srcCtrl && tgtCtrl && srcCtrl !== tgtCtrl) {
                edge._crossGroup = true;
            }
        }
    }

    return { nodes, edges };
}

// ====================================================================
// CONTROLLER HELPERS
// ====================================================================

/**
 * Build a map from node id -> controller id for all nodes that belong to a controller.
 * Includes both direct children (operators) and stuff nodes assigned to controllers.
 */
function buildChildToControllerMap(graphspec, analysis) {
    const childToController = {};

    // Direct children from containment tree
    for (const [ctrlId, children] of Object.entries(analysis.containmentTree)) {
        for (const childId of children) {
            childToController[childId] = ctrlId;
        }
    }

    // Stuff nodes produced by operators inside controllers
    for (const [digest, producerId] of Object.entries(analysis.stuffProducers)) {
        const stuffId = 'stuff_' + digest;
        const ctrlId = childToController[producerId];
        if (ctrlId) {
            childToController[stuffId] = ctrlId;
        }
    }

    // Stuff produced by controllers themselves → assign to parent controller
    for (const node of graphspec.nodes) {
        if (!analysis.controllerNodeIds.has(node.id)) continue;
        const parentCtrlId = childToController[node.id];
        if (!parentCtrlId) continue;
        for (const output of (node.io?.outputs || [])) {
            if (!output.digest) continue;
            const stuffId = 'stuff_' + output.digest;
            if (!childToController[stuffId]) {
                childToController[stuffId] = parentCtrlId;
            }
        }
    }

    return childToController;
}

/**
 * Post-layout pass that resolves overlaps and improves alignment. Direction-aware (TB/LR).
 *
 * Phase 1 — Sibling controller groups: detect overlapping padded bounding boxes of
 *           sibling controllers and push them apart.
 * Phase 2 — Loose nodes vs controller boxes: detect non-grouped nodes (method inputs,
 *           downstream operators) that overlap with a child controller's padded box
 *           and push them outward along the rank axis.
 * Phase 3 — Input alignment: center loose stuff inputs above (TB) or beside (LR)
 *           their downstream controller group.
 * Phase 4 — Column alignment: align nodes within each leaf controller to a single
 *           column on the order axis (X for TB, Y for LR).
 */
function ensureControllerSpacing(nodes, graphspec, analysis, direction) {
    if (!analysis || !graphspec) return nodes;
    const isHorizontal = direction === 'LR' || direction === 'RL';

    const childToCtrl = buildChildToControllerMap(graphspec, analysis);
    const MIN_GAP = 20;

    // Check if a node is a descendant of a controller (traverses parent chain)
    function isDescendantOf(nodeId, ctrlId) {
        let c = childToCtrl[nodeId];
        while (c) {
            if (c === ctrlId) return true;
            c = childToCtrl[c];
        }
        return false;
    }

    function nodeHeight(n) {
        return n.data?.isStuff ? 60 : 70;
    }

    // Work on a mutable copy of positions
    const result = nodes.map(n => ({ ...n, position: { ...n.position } }));

    // Build global controller -> node indices map
    const ctrlIndices = {};
    for (const ctrlId of analysis.controllerNodeIds) {
        const indices = [];
        for (let i = 0; i < result.length; i++) {
            if (isDescendantOf(result[i].id, ctrlId)) indices.push(i);
        }
        if (indices.length > 0) ctrlIndices[ctrlId] = indices;
    }

    // Compute padded bounding box for a controller's current node positions
    function computeBox(ctrlId) {
        const indices = ctrlIndices[ctrlId];
        if (!indices) return null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const idx of indices) {
            const n = result[idx];
            const w = parseFloat(n.style?.width) || 200;
            const h = nodeHeight(n);
            minX = Math.min(minX, n.position.x);
            minY = Math.min(minY, n.position.y);
            maxX = Math.max(maxX, n.position.x + w);
            maxY = Math.max(maxY, n.position.y + h);
        }
        return {
            padLeft: minX - CONTROLLER_PADDING_X,
            padTop: minY - CONTROLLER_PADDING_TOP,
            padRight: maxX + CONTROLLER_PADDING_X,
            padBottom: maxY + CONTROLLER_PADDING_BOTTOM,
        };
    }

    // ------------------------------------------------------------------
    // Phase 1: resolve overlaps between sibling controller groups
    // ------------------------------------------------------------------
    for (const [_parentId, childIds] of Object.entries(analysis.containmentTree)) {
        const childCtrls = childIds.filter(id => analysis.controllerNodeIds.has(id) && ctrlIndices[id]);
        if (childCtrls.length < 2) continue;

        for (let pass = 0; pass < 3; pass++) {
            let anyShifted = false;

            for (let i = 0; i < childCtrls.length; i++) {
                for (let j = i + 1; j < childCtrls.length; j++) {
                    const boxA = computeBox(childCtrls[i]);
                    const boxB = computeBox(childCtrls[j]);
                    if (!boxA || !boxB) continue;

                    const hOverlap = Math.min(boxA.padRight, boxB.padRight) - Math.max(boxA.padLeft, boxB.padLeft);
                    const vOverlap = Math.min(boxA.padBottom, boxB.padBottom) - Math.max(boxA.padTop, boxB.padTop);
                    if (hOverlap <= 0 || vOverlap <= 0) continue;

                    if (hOverlap <= vOverlap) {
                        const rightCtrl = boxA.padLeft <= boxB.padLeft ? childCtrls[j] : childCtrls[i];
                        for (const idx of ctrlIndices[rightCtrl]) {
                            result[idx].position.x += hOverlap + MIN_GAP;
                        }
                    } else {
                        const bottomCtrl = boxA.padTop <= boxB.padTop ? childCtrls[j] : childCtrls[i];
                        for (const idx of ctrlIndices[bottomCtrl]) {
                            result[idx].position.y += vOverlap + MIN_GAP;
                        }
                    }
                    anyShifted = true;
                }
            }
            if (!anyShifted) break;
        }
    }

    // ------------------------------------------------------------------
    // Phase 2: push loose nodes away from child controller padded boxes
    // ------------------------------------------------------------------
    for (const [_parentId, childIds] of Object.entries(analysis.containmentTree)) {
        const childCtrls = childIds.filter(id => analysis.controllerNodeIds.has(id) && ctrlIndices[id]);
        if (childCtrls.length === 0) continue;

        // Collect indices of nodes that belong to ANY child controller
        const inAnyChildCtrl = new Set();
        for (const ctrlId of childCtrls) {
            for (const idx of ctrlIndices[ctrlId]) inAnyChildCtrl.add(idx);
        }

        // Precompute controller boxes and combined spans (positions are stable during detection)
        const boxes = {};
        let ctrlsMinY = Infinity, ctrlsMaxY = -Infinity;
        let ctrlsMinX = Infinity, ctrlsMaxX = -Infinity;
        for (const ctrlId of childCtrls) {
            const box = computeBox(ctrlId);
            if (!box) continue;
            boxes[ctrlId] = box;
            ctrlsMinY = Math.min(ctrlsMinY, box.padTop);
            ctrlsMaxY = Math.max(ctrlsMaxY, box.padBottom);
            ctrlsMinX = Math.min(ctrlsMinX, box.padLeft);
            ctrlsMaxX = Math.max(ctrlsMaxX, box.padRight);
        }
        if (ctrlsMinY === Infinity) continue;

        // For TB layout, push loose nodes along Y (above/below controllers).
        // For LR layout, push along X (left/right of controllers).
        // The "cross axis" is the perpendicular one used to check overlap extent.
        const ctrlsCenter = isHorizontal
            ? (ctrlsMinX + ctrlsMaxX) / 2
            : (ctrlsMinY + ctrlsMaxY) / 2;

        // Find the maximum push needed before/after child controllers on the rank axis
        let maxPushBefore = 0, maxPushAfter = 0;

        for (let i = 0; i < result.length; i++) {
            if (inAnyChildCtrl.has(i)) continue;
            const n = result[i];
            const w = parseFloat(n.style?.width) || 200;
            const h = nodeHeight(n);

            for (const ctrlId of childCtrls) {
                const box = boxes[ctrlId];
                if (!box) continue;

                const hOvlp = Math.min(box.padRight, n.position.x + w) - Math.max(box.padLeft, n.position.x);
                const vOvlp = Math.min(box.padBottom, n.position.y + h) - Math.max(box.padTop, n.position.y);
                if (hOvlp <= 0 || vOvlp <= 0) continue;

                if (isHorizontal) {
                    const nodeCenterX = n.position.x + w / 2;
                    const boxCenterX = (box.padLeft + box.padRight) / 2;
                    if (nodeCenterX < boxCenterX) {
                        const needed = (n.position.x + w) - box.padLeft + MIN_GAP;
                        maxPushBefore = Math.max(maxPushBefore, needed);
                    } else {
                        const needed = box.padRight - n.position.x + MIN_GAP;
                        maxPushAfter = Math.max(maxPushAfter, needed);
                    }
                } else {
                    const nodeCenterY = n.position.y + h / 2;
                    const boxCenterY = (box.padTop + box.padBottom) / 2;
                    if (nodeCenterY < boxCenterY) {
                        const needed = (n.position.y + h) - box.padTop + MIN_GAP;
                        maxPushBefore = Math.max(maxPushBefore, needed);
                    } else {
                        const needed = box.padBottom - n.position.y + MIN_GAP;
                        maxPushAfter = Math.max(maxPushAfter, needed);
                    }
                }
            }
        }

        // Apply uniform shift to loose nodes within the cross-axis span of the
        // controller zone. Nodes before → push back, nodes after → push forward.
        if (maxPushBefore > 0 || maxPushAfter > 0) {
            for (let i = 0; i < result.length; i++) {
                if (inAnyChildCtrl.has(i)) continue;
                const n = result[i];
                const w = parseFloat(n.style?.width) || 200;
                const h = nodeHeight(n);

                if (isHorizontal) {
                    // Only shift nodes whose vertical extent overlaps the controller zone
                    const nodeBottom = n.position.y + h;
                    if (nodeBottom <= ctrlsMinY || n.position.y >= ctrlsMaxY) continue;
                    const nodeCenterX = n.position.x + w / 2;
                    if (maxPushBefore > 0 && nodeCenterX < ctrlsCenter) {
                        result[i].position.x -= maxPushBefore;
                    }
                    if (maxPushAfter > 0 && nodeCenterX >= ctrlsCenter) {
                        result[i].position.x += maxPushAfter;
                    }
                } else {
                    // Only shift nodes whose horizontal extent overlaps the controller zone
                    const nodeRight = n.position.x + w;
                    if (nodeRight <= ctrlsMinX || n.position.x >= ctrlsMaxX) continue;
                    const nodeCenterY = n.position.y + h / 2;
                    if (maxPushBefore > 0 && nodeCenterY < ctrlsCenter) {
                        result[i].position.y -= maxPushBefore;
                    }
                    if (maxPushAfter > 0 && nodeCenterY >= ctrlsCenter) {
                        result[i].position.y += maxPushAfter;
                    }
                }
            }
        }
    }

    // Build controller info lookup (used by Phase 3 and Phase 4)
    const controllerInfoMap = {};
    for (const node of graphspec.nodes) {
        if (analysis.controllerNodeIds.has(node.id)) {
            controllerInfoMap[node.id] = node;
        }
    }

    // ------------------------------------------------------------------
    // Phase 3: align loose input nodes above their downstream controller
    // ------------------------------------------------------------------
    // For each node not in any controller, find its outgoing edges and check
    // if all targets belong to the same controller group. If so, center the
    // node horizontally above that group's bounding box.
    // Use stuffConsumers to find which controller each input feeds
    for (let i = 0; i < result.length; i++) {
        const n = result[i];
        if (childToCtrl[n.id]) continue; // skip nodes already in a controller
        if (!n.id.startsWith('stuff_')) continue; // only align stuff inputs

        const digest = n.id.replace('stuff_', '');
        const consumers = analysis.stuffConsumers[digest];
        if (!consumers || consumers.length === 0) continue;

        // Find which leaf controller(s) the consumers belong to
        const targetCtrls = new Set();
        for (const consumerId of consumers) {
            const ctrl = childToCtrl[consumerId];
            if (ctrl) targetCtrls.add(ctrl);
        }
        if (targetCtrls.size !== 1) continue; // ambiguous or no controller

        const targetCtrl = targetCtrls.values().next().value;

        // Skip PipeBatch/PipeParallel — inputs should stay spread across branches
        const targetCtrlNode = controllerInfoMap[targetCtrl];
        if (targetCtrlNode && (targetCtrlNode.pipe_type === 'PipeParallel' || targetCtrlNode.pipe_type === 'PipeBatch')) continue;

        const box = computeBox(targetCtrl);
        if (!box) continue;

        // Center the node above (TB) or to the left of (LR) the controller group
        if (isHorizontal) {
            const groupCenterY = (box.padTop + CONTROLLER_PADDING_TOP + box.padBottom - CONTROLLER_PADDING_BOTTOM) / 2;
            const h = nodeHeight(n);
            result[i].position.y = groupCenterY - h / 2;
        } else {
            const groupCenterX = (box.padLeft + CONTROLLER_PADDING_X + box.padRight - CONTROLLER_PADDING_X) / 2;
            const w = parseFloat(n.style?.width) || 200;
            result[i].position.x = groupCenterX - w / 2;
        }
    }

    // ------------------------------------------------------------------
    // Phase 4: align nodes within each leaf controller into a single column
    // ------------------------------------------------------------------
    // For each controller that has no child controllers (leaf groups),
    // align all member nodes to the group's median center on the order axis.
    // Skip PipeParallel/PipeBatch controllers — their branches should stay side-by-side.
    const orderAxis = isHorizontal ? 'y' : 'x';
    for (const ctrlId of analysis.controllerNodeIds) {
        // Skip non-leaf controllers (those that have child controllers)
        const children = analysis.containmentTree[ctrlId] || [];
        const hasChildCtrl = children.some(id => analysis.controllerNodeIds.has(id));
        if (hasChildCtrl) continue;

        // Skip PipeParallel controllers — branches are intentionally side-by-side
        const ctrlNode = controllerInfoMap[ctrlId];
        if (ctrlNode && (ctrlNode.pipe_type === 'PipeParallel' || ctrlNode.pipe_type === 'PipeBatch')) continue;

        const indices = ctrlIndices[ctrlId];
        if (!indices || indices.length < 2) continue;

        // Compute the median center position on the order axis
        const centers = indices.map(idx => {
            const n = result[idx];
            const w = parseFloat(n.style?.width) || 200;
            return n.position[orderAxis] + (orderAxis === 'x' ? w / 2 : nodeHeight(n) / 2);
        });
        centers.sort((a, b) => a - b);
        const median = centers[Math.floor(centers.length / 2)];

        // Shift each node so its center aligns with the median
        for (const idx of indices) {
            const n = result[idx];
            const w = parseFloat(n.style?.width) || 200;
            const halfSize = orderAxis === 'x' ? w / 2 : nodeHeight(n) / 2;
            result[idx].position[orderAxis] = median - halfSize;
        }
    }

    return result;
}

// ====================================================================
// CONTROLLER CONTAINERS: Build group nodes wrapping child operators
// ====================================================================
function buildControllerNodes(graphspec, analysis, layoutedNodes) {
    const PADDING_X = CONTROLLER_PADDING_X;
    const PADDING_TOP = CONTROLLER_PADDING_TOP;
    const PADDING_BOTTOM = CONTROLLER_PADDING_BOTTOM;

    // Build lookup of layouted nodes by id
    const nodeById = {};
    for (const n of layoutedNodes) {
        nodeById[n.id] = n;
    }

    // Build controller info from graphspec nodes
    const controllerInfo = {};
    for (const node of graphspec.nodes) {
        if (analysis.controllerNodeIds.has(node.id)) {
            controllerInfo[node.id] = node;
        }
    }

    // Compute nesting depth (leaf controllers = 0, parents = 1+max child depth)
    const depthCache = {};
    function getDepth(controllerId) {
        if (depthCache[controllerId] !== undefined) return depthCache[controllerId];
        const children = analysis.containmentTree[controllerId] || [];
        let maxChildDepth = -1;
        for (const childId of children) {
            if (analysis.controllerNodeIds.has(childId)) {
                maxChildDepth = Math.max(maxChildDepth, getDepth(childId));
            }
        }
        depthCache[controllerId] = maxChildDepth + 1;
        return depthCache[controllerId];
    }

    // Reuse the shared helper for child-to-controller mapping, then filter to rendered
    // nodes and build the reverse index (controller -> stuff node ids)
    const childToController = buildChildToControllerMap(graphspec, analysis);
    const controllerStuffChildren = {};
    for (const [nodeId, ctrlId] of Object.entries(childToController)) {
        if (!nodeId.startsWith('stuff_')) continue;
        if (!nodeById[nodeId]) continue; // only include rendered stuff nodes
        if (!controllerStuffChildren[ctrlId]) controllerStuffChildren[ctrlId] = [];
        controllerStuffChildren[ctrlId].push(nodeId);
    }

    // Sort controllers by depth ascending (process leaves first)
    const controllerIds = Array.from(analysis.controllerNodeIds);
    for (const id of controllerIds) getDepth(id);
    controllerIds.sort((a, b) => depthCache[a] - depthCache[b]);

    const controllerNodes = [];
    const childToParent = {}; // childId -> parentControllerId

    for (const controllerId of controllerIds) {
        // Skip the root controller (main pipe) — it wraps everything and adds no value
        if (!childToController[controllerId]) continue;

        const directChildren = analysis.containmentTree[controllerId] || [];
        // Only include children that are actually rendered
        const renderedChildren = directChildren.filter(cid => nodeById[cid]);
        const stuffChildren = controllerStuffChildren[controllerId] || [];
        const allChildren = [...renderedChildren, ...stuffChildren];

        if (allChildren.length === 0) continue;

        // Compute bounding box from children
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const childId of allChildren) {
            const child = nodeById[childId];
            const pos = child.position;
            const w = parseFloat(child.style?.width) || 200;
            const h = parseFloat(child.style?.height) || (child.data?.isStuff ? 60 : 70);
            minX = Math.min(minX, pos.x);
            minY = Math.min(minY, pos.y);
            maxX = Math.max(maxX, pos.x + w);
            maxY = Math.max(maxY, pos.y + h);
        }

        const groupX = minX - PADDING_X;
        const groupY = minY - PADDING_TOP;
        const groupW = (maxX - minX) + 2 * PADDING_X;
        const groupH = (maxY - minY) + PADDING_TOP + PADDING_BOTTOM;

        const info = controllerInfo[controllerId] || {};
        const pipeCode = info.pipe_code || controllerId.split(':').pop();
        const pipeType = info.pipe_type || '';
        const groupNode = {
            id: controllerId,
            type: 'controllerGroup',
            data: {
                label: pipeCode,
                pipeType: pipeType,
                isController: true,
                isPipe: false,
                isStuff: false,
            },
            position: { x: groupX, y: groupY },
            style: {
                width: groupW + 'px',
                height: groupH + 'px',
                background: 'var(--color-controller-bg)',
                border: '2px dashed var(--color-controller-border)',
                borderRadius: '12px',
                padding: '0',
            },
        };

        controllerNodes.push(groupNode);
        nodeById[controllerId] = groupNode;

        // Record child-parent relationships (operators + stuff nodes)
        for (const childId of allChildren) {
            childToParent[childId] = controllerId;
        }
    }

    // Convert child positions to parent-relative and set parentNode
    for (const [childId, parentId] of Object.entries(childToParent)) {
        const child = nodeById[childId];
        const parent = nodeById[parentId];
        if (!child || !parent) continue;
        child.position = {
            x: child.position.x - parent.position.x,
            y: child.position.y - parent.position.y,
        };
        child.parentNode = parentId;
        child.extent = 'parent';
    }

    return controllerNodes;
}

function applyControllers(layoutedNodes, layoutedEdges, graphspec, analysis) {
    if (!showControllers || !analysis || !graphspec) {
        return { nodes: layoutedNodes, edges: layoutedEdges };
    }

    const controllerNodes = buildControllerNodes(graphspec, analysis, layoutedNodes);
    if (controllerNodes.length === 0) {
        return { nodes: layoutedNodes, edges: layoutedEdges };
    }

    // Merge controller + operator/stuff nodes
    const allNodes = [...controllerNodes, ...layoutedNodes];

    // Sort: ReactFlow v11 requires parent group nodes before their children.
    // Precompute containment depth: 0 = no parent, 1 = direct child, etc.
    const nodeMap = {};
    for (const n of allNodes) nodeMap[n.id] = n;
    const depthOf = {};
    function getContainmentDepth(id) {
        if (depthOf[id] !== undefined) return depthOf[id];
        const n = nodeMap[id];
        depthOf[id] = n && n.parentNode ? 1 + getContainmentDepth(n.parentNode) : 0;
        return depthOf[id];
    }
    for (const n of allNodes) getContainmentDepth(n.id);
    allNodes.sort((a, b) => depthOf[a.id] - depthOf[b.id]);

    return { nodes: allNodes, edges: layoutedEdges };
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

// ====================================================================
// CUSTOM NODE TYPES
// ====================================================================
function ControllerGroupNode({ data }) {
    return React.createElement('div', {
        className: 'controller-group-node',
    },
        React.createElement('div', {
            className: 'controller-group-label',
        }, data.label),
        data.pipeType ? React.createElement('div', {
            className: 'controller-group-type',
        }, data.pipeType) : null
    );
}

// Must be defined at module scope for stable reference (avoids ReactFlow re-mount warnings)
const controllerNodeTypes = { controllerGroup: ControllerGroupNode };

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
        const spaced = initialDataRef.current._analysis
            ? ensureControllerSpacing(relayouted.nodes, initialDataRef.current._graphspec, initialDataRef.current._analysis, direction)
            : relayouted.nodes;
        const withControllers = applyControllers(
            spaced, relayouted.edges,
            initialDataRef.current._graphspec, initialDataRef.current._analysis
        );
        setNodes(withControllers.nodes);
        setEdges(withControllers.edges);
        setTimeout(() => {
            if (reactFlowRef.current) {
                reactFlowRef.current.fitView({ padding: 0.1 });
            }
        }, 50);
    }, [direction]);

    // Expose rebuildAndLayout for controllers toggle
    React.useEffect(() => {
        window.rebuildAndLayout = () => {
            if (!viewspec) return;
            const { graphData, analysis } = buildGraph(viewspec, graphspec);
            initialDataRef.current = graphData;
            initialDataRef.current._analysis = analysis;
            initialDataRef.current._graphspec = graphspec;
            const layouted = getLayoutedElements(graphData.nodes, graphData.edges, currentDirection);
            const spaced = analysis
                ? ensureControllerSpacing(layouted.nodes, graphspec, analysis, currentDirection)
                : layouted.nodes;
            const withControllers = applyControllers(spaced, layouted.edges, graphspec, analysis);
            setNodes(withControllers.nodes);
            setEdges(withControllers.edges);
            setTimeout(() => {
                if (reactFlowRef.current) reactFlowRef.current.fitView({ padding: 0.1 });
            }, 50);
        };
        return () => { window.rebuildAndLayout = null; };
    }, [setNodes, setEdges]);

    // Listen for data from the extension
    React.useEffect(() => {
        function handleMessage(event) {
            const message = event.data;
            if (message.type === 'setData') {
                // Persist the source file URI so VS Code can restore after reload
                if (message.uri) {
                    vscode.setState({ uri: message.uri });
                }
                viewspec = message.viewspec;
                graphspec = message.graphspec || null;
                config = message.config || {};
                currentDirection = config.direction || 'TB';
                edgeType = config.edgeType || 'bezier';
                showControllers = config.showControllers || false;
                controllersToggle.checked = showControllers;
                setDirection(currentDirection);
                prevDirectionRef.current = currentDirection;
                applyDirectionIcon(currentDirection);

                // Apply palette colors as CSS custom properties on <body>
                // (must target body, not documentElement, because body.vscode-dark
                // redefines these variables and would shadow html-level overrides)
                if (config.paletteColors) {
                    for (const [cssVar, value] of Object.entries(config.paletteColors)) {
                        document.body.style.setProperty(cssVar, value);
                    }
                }

                const { graphData, analysis } = buildGraph(viewspec, graphspec);
                initialDataRef.current = graphData;
                initialDataRef.current._analysis = analysis;
                initialDataRef.current._graphspec = graphspec;

                const needsLayout = graphData.nodes.some(n => !n.position || (n.position.x === 0 && n.position.y === 0));
                const layouted = needsLayout
                    ? getLayoutedElements(graphData.nodes, graphData.edges, currentDirection)
                    : graphData;
                const spaced = analysis
                    ? ensureControllerSpacing(layouted.nodes, graphspec, analysis, currentDirection)
                    : layouted.nodes;
                const withControllers = applyControllers(spaced, layouted.edges, graphspec, analysis);

                setNodes(withControllers.nodes);
                setEdges(withControllers.edges);

                // Fit view after render, then apply zoom/pan overrides
                setTimeout(() => {
                    if (reactFlowRef.current) {
                        reactFlowRef.current.fitView({ padding: 0.1 });
                        if (config.initialZoom !== undefined && config.initialZoom !== null) {
                            reactFlowRef.current.zoomTo(config.initialZoom);
                        }
                        if (config.panToTop) {
                            const vp = reactFlowRef.current.getViewport();
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
        if (nodeData.isController) return;
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

    const onInit = React.useCallback((reactFlowInstance) => {
        reactFlowRef.current = reactFlowInstance;
        window._reactFlowInstance = reactFlowInstance;
    }, []);

    return React.createElement('div', { className: 'react-flow-container' },
        React.createElement(ReactFlow, {
            nodes: nodes,
            edges: edges,
            nodeTypes: controllerNodeTypes,
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
            }) : null
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
