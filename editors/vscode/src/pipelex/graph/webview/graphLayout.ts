import type {
    GraphNode,
    GraphEdge,
    GraphSpec,
    DataflowAnalysis,
    LayoutConfig,
} from './types';
import {
    CONTROLLER_PADDING_X,
    CONTROLLER_PADDING_TOP,
    CONTROLLER_PADDING_BOTTOM,
} from './types';
import { buildChildToControllerMap } from './graphAnalysis';

export function getLayoutedElements(
    nodes: GraphNode[],
    edges: GraphEdge[],
    direction: string,
    layoutConfig?: LayoutConfig,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
    direction = direction || 'TB';
    const nodesep = layoutConfig?.nodesep ?? 50;
    const ranksep = layoutConfig?.ranksep ?? 30;

    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({
        rankdir: direction,
        nodesep,
        ranksep,
        edgesep: 20,
        marginx: 40,
        marginy: 40,
    });

    const nodeWidths: Record<string, number> = {};
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
        const opts: Record<string, unknown> = {};
        if (edge._crossGroup) opts.weight = 0;
        if (edge._batchEdge) opts.weight = 0;
        g.setEdge(edge.source, edge.target, opts);
    });

    dagre.layout(g);

    const result = nodes.map((node) => {
        const nodeWithPosition = g.node(node.id);
        const width = nodeWidths[node.id];
        return {
            ...node,
            position: {
                x: nodeWithPosition.x - width / 2,
                y: nodeWithPosition.y - (node.data?.isStuff ? 30 : 35),
            },
        };
    });

    return { nodes: result, edges };
}

/**
 * Post-layout pass that resolves overlaps and improves alignment. Direction-aware (TB/LR).
 *
 * Phase 1 - Sibling controller groups: detect overlapping padded bounding boxes of
 *           sibling controllers and push them apart.
 * Phase 2 - Loose nodes vs controller boxes: detect non-grouped nodes (method inputs,
 *           downstream operators) that overlap with a child controller's padded box
 *           and push them outward along the rank axis.
 * Phase 3 - Input alignment: center loose stuff inputs above (TB) or beside (LR)
 *           their downstream controller group.
 * Phase 4 - Column alignment: align nodes within each leaf controller to a single
 *           column on the order axis (X for TB, Y for LR).
 */
export function ensureControllerSpacing(
    nodes: GraphNode[],
    graphspec: GraphSpec,
    analysis: DataflowAnalysis,
    direction: string,
): GraphNode[] {
    if (!analysis || !graphspec) return nodes;
    const isHorizontal = direction === 'LR' || direction === 'RL';

    const childToCtrl = buildChildToControllerMap(graphspec, analysis);
    const MIN_GAP = 20;

    // Check if a node is a descendant of a controller (traverses parent chain)
    function isDescendantOf(nodeId: string, ctrlId: string): boolean {
        let c = childToCtrl[nodeId];
        while (c) {
            if (c === ctrlId) return true;
            c = childToCtrl[c];
        }
        return false;
    }

    function nodeHeight(n: GraphNode): number {
        return n.data?.isStuff ? 60 : 70;
    }

    // Work on a mutable copy of positions
    const result = nodes.map(n => ({ ...n, position: { ...n.position } }));

    // Build global controller -> node indices map
    const ctrlIndices: Record<string, number[]> = {};
    for (const ctrlId of analysis.controllerNodeIds) {
        const indices: number[] = [];
        for (let i = 0; i < result.length; i++) {
            if (isDescendantOf(result[i].id, ctrlId)) indices.push(i);
        }
        if (indices.length > 0) ctrlIndices[ctrlId] = indices;
    }

    // Compute padded bounding box for a controller's current node positions
    function computeBox(ctrlId: string) {
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
        const inAnyChildCtrl = new Set<number>();
        for (const ctrlId of childCtrls) {
            for (const idx of ctrlIndices[ctrlId]) inAnyChildCtrl.add(idx);
        }

        // Precompute controller boxes and combined spans
        const boxes: Record<string, ReturnType<typeof computeBox>> = {};
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

        // Apply uniform shift to loose nodes
        if (maxPushBefore > 0 || maxPushAfter > 0) {
            for (let i = 0; i < result.length; i++) {
                if (inAnyChildCtrl.has(i)) continue;
                const n = result[i];
                const w = parseFloat(n.style?.width) || 200;
                const h = nodeHeight(n);

                if (isHorizontal) {
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
    const controllerInfoMap: Record<string, GraphSpec['nodes'][number]> = {};
    for (const node of graphspec.nodes) {
        if (analysis.controllerNodeIds.has(node.id)) {
            controllerInfoMap[node.id] = node;
        }
    }

    // ------------------------------------------------------------------
    // Phase 3: align loose input nodes above their downstream controller
    // ------------------------------------------------------------------
    for (let i = 0; i < result.length; i++) {
        const n = result[i];
        if (childToCtrl[n.id]) continue;
        if (!n.id.startsWith('stuff_')) continue;

        const digest = n.id.replace('stuff_', '');
        const consumers = analysis.stuffConsumers[digest];
        if (!consumers || consumers.length === 0) continue;

        const targetCtrls = new Set<string>();
        for (const consumerId of consumers) {
            const ctrl = childToCtrl[consumerId];
            if (ctrl) targetCtrls.add(ctrl);
        }
        if (targetCtrls.size !== 1) continue;

        const targetCtrl = targetCtrls.values().next().value;

        const targetCtrlNode = controllerInfoMap[targetCtrl];
        if (targetCtrlNode && (targetCtrlNode.pipe_type === 'PipeParallel' || targetCtrlNode.pipe_type === 'PipeBatch' || targetCtrlNode.pipe_type === 'PipeCondition')) continue;

        const box = computeBox(targetCtrl);
        if (!box) continue;

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
    const orderAxis = isHorizontal ? 'y' : 'x';
    for (const ctrlId of analysis.controllerNodeIds) {
        const children = analysis.containmentTree[ctrlId] || [];
        const hasChildCtrl = children.some(id => analysis.controllerNodeIds.has(id));
        if (hasChildCtrl) continue;

        const ctrlNode = controllerInfoMap[ctrlId];
        if (ctrlNode && (ctrlNode.pipe_type === 'PipeParallel' || ctrlNode.pipe_type === 'PipeBatch' || ctrlNode.pipe_type === 'PipeCondition')) continue;

        const indices = ctrlIndices[ctrlId];
        if (!indices || indices.length < 2) continue;

        const centers = indices.map(idx => {
            const n = result[idx];
            const w = parseFloat(n.style?.width) || 200;
            return n.position[orderAxis] + (orderAxis === 'x' ? w / 2 : nodeHeight(n) / 2);
        });
        centers.sort((a, b) => a - b);
        const median = centers[Math.floor(centers.length / 2)];

        for (const idx of indices) {
            const n = result[idx];
            const w = parseFloat(n.style?.width) || 200;
            const halfSize = orderAxis === 'x' ? w / 2 : nodeHeight(n) / 2;
            result[idx].position[orderAxis] = median - halfSize;
        }
    }

    return result;
}
