import type { GraphSpec, DataflowAnalysis, GraphNode, GraphEdge } from './types';
import {
    CONTROLLER_PADDING_X,
    CONTROLLER_PADDING_TOP,
    CONTROLLER_PADDING_BOTTOM,
} from './types';
import { buildChildToControllerMap } from './graphAnalysis';

/**
 * Build controller group nodes that wrap child operators/stuff nodes.
 */
export function buildControllerNodes(
    graphspec: GraphSpec,
    analysis: DataflowAnalysis,
    layoutedNodes: GraphNode[],
): GraphNode[] {
    // Build lookup of layouted nodes by id
    const nodeById: Record<string, GraphNode> = {};
    for (const n of layoutedNodes) {
        nodeById[n.id] = n;
    }

    // Build controller info from graphspec nodes
    const controllerInfo: Record<string, GraphSpec['nodes'][number]> = {};
    for (const node of graphspec.nodes) {
        if (analysis.controllerNodeIds.has(node.id)) {
            controllerInfo[node.id] = node;
        }
    }

    // Compute nesting depth (leaf controllers = 0, parents = 1+max child depth)
    const depthCache: Record<string, number> = {};
    function getDepth(controllerId: string): number {
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

    // Build child-to-controller mapping, then filter to rendered stuff nodes
    const childToController = buildChildToControllerMap(graphspec, analysis);
    const controllerStuffChildren: Record<string, string[]> = {};
    for (const [nodeId, ctrlId] of Object.entries(childToController)) {
        if (!nodeId.startsWith('stuff_')) continue;
        if (!nodeById[nodeId]) continue;
        if (!controllerStuffChildren[ctrlId]) controllerStuffChildren[ctrlId] = [];
        controllerStuffChildren[ctrlId].push(nodeId);
    }

    // Sort controllers by depth ascending (process leaves first)
    const controllerIds = Array.from(analysis.controllerNodeIds);
    for (const id of controllerIds) getDepth(id);
    controllerIds.sort((a, b) => depthCache[a] - depthCache[b]);

    const controllerNodes: GraphNode[] = [];
    const childToParent: Record<string, string> = {};

    for (const controllerId of controllerIds) {
        // Skip the root controller (main pipe) — it wraps everything and adds no value
        if (!childToController[controllerId]) continue;

        const directChildren = analysis.containmentTree[controllerId] || [];
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

        const groupX = minX - CONTROLLER_PADDING_X;
        const groupY = minY - CONTROLLER_PADDING_TOP;
        const groupW = (maxX - minX) + 2 * CONTROLLER_PADDING_X;
        const groupH = (maxY - minY) + CONTROLLER_PADDING_TOP + CONTROLLER_PADDING_BOTTOM;

        const info = controllerInfo[controllerId] || {};
        const pipeCode = info.pipe_code || controllerId.split(':').pop()!;
        const pipeType = info.pipe_type || '';
        const isImplicitBatch = pipeType === 'PipeBatch' && pipeCode.endsWith('_batch');
        const groupNode: GraphNode = {
            id: controllerId,
            type: 'controllerGroup',
            data: {
                label: isImplicitBatch ? null : pipeCode,
                pipeType: isImplicitBatch ? 'implicit PipeBatch' : pipeType,
                isController: true,
                isPipe: false,
                isStuff: false,
                pipeCode: isImplicitBatch ? pipeCode.slice(0, -6) : pipeCode,
                labelText: pipeCode,
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

/**
 * Apply controller containers to layouted nodes if showControllers is enabled.
 */
export function applyControllers(
    layoutedNodes: GraphNode[],
    layoutedEdges: GraphEdge[],
    graphspec: GraphSpec | null,
    analysis: DataflowAnalysis | null,
    showControllers: boolean,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
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
    const nodeMap: Record<string, GraphNode> = {};
    for (const n of allNodes) nodeMap[n.id] = n;
    const depthOf: Record<string, number> = {};
    function getContainmentDepth(id: string): number {
        if (depthOf[id] !== undefined) return depthOf[id];
        const n = nodeMap[id];
        depthOf[id] = n && n.parentNode ? 1 + getContainmentDepth(n.parentNode) : 0;
        return depthOf[id];
    }
    for (const n of allNodes) getContainmentDepth(n.id);
    allNodes.sort((a, b) => depthOf[a.id] - depthOf[b.id]);

    return { nodes: allNodes, edges: layoutedEdges };
}
